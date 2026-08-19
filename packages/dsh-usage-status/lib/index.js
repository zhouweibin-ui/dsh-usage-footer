/**
 * dsh-usage-status — host plugin for the DSH web surface.
 *
 * Registers one loopback-only HTTP route on the shared webserver:
 *
 *   GET /usage-status
 *
 * The handler resolves credentials through the harness credential provider
 * (never reading the secret file directly) and answers:
 *
 *   {
 *     month, year,                       // server-local "current month" facts
 *     balance: {                         // from https://api.deepseek.com/user/balance
 *       isAvailable, currency,
 *       totalBalance, grantedBalance, toppedUpBalance
 *     } | null,
 *     todaySpend: {                      // balance-snapshot delta (official
 *       amount, currency, day,           // billing口径): day-start snapshot −
 *       baselineAt                       // current balance, with recharge/grant
 *     } | null,                          // corrections; snapshot persisted in
 *                                        // $DSH_HOME/<baseline file>
 *     usageAmount: <raw data> | null,    // platform endpoint, only when
 *     usageCost:   <raw data> | null,    // DEEPSEEK_PLATFORM_TOKEN is set
 *     pricing: {                        // per-model peak/off-peak tables (CNY
 *       "<model>": { offPeak: { hit,     // per 1M tokens), parsed from the
 *         miss, output }, peak: { hit,   // official pricing page; null = the
 *         miss, output } }               // client uses its built-in table
 *     } | null,
 *     pricingSource: "docs" | "builtin",  // where the served table came from
 *     pricingTable: "flat" | "peak" |     // the ACTIVE rate card (flat until
 *       null,                             // the parsed switch date, peak after)
 *     pricingEffective: string | null,    // peak/off-peak switch instant (ISO)
 *     pricingFetchedAt: string | null,    // last successful docs sync (ISO)
 *     kimi: {                             // Kimi Code (Coding Plan) quota from
 *       configured,                       // api.kimi.com/coding/v1/usages;
 *       weekly, fiveHour,                 // used/limit/remaining are percent
 *       booster, error?,                  // points; booster = 加油包 cents
 *       monthlyConfigured,                // user pasted a kimi.com cookie
 *       monthly: { usedPct, resetDate } | null,  // SSR subscription-page
 *       monthlyError?                     // scrape (membership monthly quota)
 *     } | null,
 *     errors: string[]
 *   }
 *
 * MOONSHOTAI_CN_API_KEY (or KIMI_API_KEY) → Kimi Code usages API (needs an
 * sk-kimi-* key from the Kimi Code console, not the open platform).
 * usage-footer.kimiCookie (Settings → General 输入框) → kimi.com
 * subscription page scrape for the monthly membership quota; stored in
 * $DSH_HOME/usage-footer-kimi-cookie.txt (0600) via POST
 * /usage-status/kimi-cookie; both routes stay loopback-only.
 *
 * DEEPSEEK_API_KEY      → official balance API (api.deepseek.com/user/balance).
 * DEEPSEEK_PLATFORM_TOKEN → private platform endpoints (platform.deepseek.com
 *                         /api/v0/usage/{amount,cost}), browser-session token
 *                         required; an API key is rejected there (code 40003).
 *
 * Responses are cached for 30s so the browser footer polling stays cheap, and
 * the route refuses any non-loopback peer (the deployment binds 127.0.0.1).
 */

import z from "@deepseek-ai/schemastery";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const ROUTE_PATH = "/usage-status";
const CACHE_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 8_000;
const PRICING_DOC_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const PRICING_CACHE_TTL_MS = 12 * 3600e3;

const API_KEY_REF = "DEEPSEEK_API_KEY";
const PLATFORM_TOKEN_REF = "DEEPSEEK_PLATFORM_TOKEN";
const KIMI_API_KEY_REFS = ["MOONSHOTAI_CN_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY"];
const KIMI_USAGES_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_USER_AGENT = "KimiCLI/1.6";
const KIMI_SUBSCRIPTION_RPC_URL = "https://www.kimi.com/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription";
const KIMI_REFRESH_URL = "https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken";
/** Refresh the access token proactively once its remaining lifetime drops below this. */
const KIMI_REFRESH_MIN_REMAINING_MS = 24 * 3600e3;
const KIMI_MONTHLY_CACHE_TTL_MS = 10 * 60e3;

/** opencode Go subscription quota (5h rolling / weekly / monthly percents). */
const OPENCODE_GO_KEY_REF = "OPENCODE_GO_API_KEY";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/** User setting: the self-service on/off switch rendered in Settings → General. */
const USAGE_SETTINGS_NS = "usage-footer";
const USAGE_SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true)
});

/** kimi.com cookie storage: dedicated file, loopback POST route (the settings
 *  namespace keeps only the first schema registration, so secrets go here). */
const KIMI_COOKIE_FILENAME = "usage-footer-kimi-cookie.txt";
const KIMI_COOKIE_ROUTE = "/usage-status/kimi-cookie";
const KIMI_COOKIE_MAX_BYTES = 16 * 1024;

/** Baseline snapshot file name under $DSH_HOME (day-start balance). */
const BASELINE_FILENAME = "usage-footer-balance-baseline.json";

/** Beijing date key (UTC+8, no DST) for the daily baseline rollover. */
function beijingDateKey(ts = Date.now()) {
  return new Date(ts + 8 * 3600e3).toISOString().slice(0, 10);
}

function loadBaseline(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function saveBaseline(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2));
  } catch {
    /* best-effort persistence; the in-memory baseline still works */
  }
}

function parseMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Today's billed spend from a day-start balance snapshot.
 *
 * net = snapshot.total − current.total
 *     + (current.toppedUp − snapshot.toppedUp)
 *     + (current.granted − snapshot.granted)
 *
 * The two correction terms cancel out recharges and grant changes, so the
 * result is the money actually consumed since the snapshot. On the first
 * query of a new Beijing day the snapshot is (re)written and the amount is 0;
 * a vanished or stale snapshot is re-anchored the same way.
 */
function computeTodaySpend(baselinePath, info, now) {
  const day = beijingDateKey(now);
  const current = {
    total: parseMoney(info.total_balance),
    toppedUp: parseMoney(info.topped_up_balance),
    granted: parseMoney(info.granted_balance)
  };
  const baseline = loadBaseline(baselinePath);
  if (baseline === null || baseline.date !== day) {
    const next = {
      date: day,
      at: new Date(now).toISOString(),
      total: current.total,
      toppedUp: current.toppedUp,
      granted: current.granted
    };
    saveBaseline(baselinePath, next);
    return { amount: 0, currency: typeof info.currency === "string" ? info.currency : null, day, baselineAt: next.at };
  }
  const net = baseline.total - current.total
    + (current.toppedUp - baseline.toppedUp)
    + (current.granted - baseline.granted);
  const amount = Math.max(0, Math.round(net * 100) / 100);
  return { amount, currency: typeof info.currency === "string" ? info.currency : null, day, baselineAt: baseline.at };
}

/** Accept only loopback peers: this route answers account data, never LAN peers. */
function isLoopback(address) {
  if (address === undefined) return false;
  if (address === "127.0.0.1" || address === "::1") return true;
  return /^::ffff:127\.0\.0\.1$/.test(address);
}

/** Bounded fetch returning parsed JSON, or a diagnostic object on failure. */
async function fetchJson(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      return { failed: true, status: response.status };
    }
    return await response.json();
  } catch (error) {
    return { failed: true, status: 0, reason: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * Parse the peak/off-peak price table out of the official pricing page
 * (api-docs.deepseek.com, server-rendered HTML). Unknown structure yields
 * null so callers fall back to the built-in table.
 * @param html - the pricing page HTML.
 * @returns per-model price tables, or null when the table is unrecognizable.
 */
function parsePricing(html) {
    const text = html
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ");
    // Flat rate card (in effect until the peak/off-peak switch).
    const flat = {};
    const flatMatch = /百万tokens输入（缓存命中）\s*([\d.]+)元\s*([\d.]+)元\s*百万tokens输入（缓存未命中）\s*([\d.]+)元\s*([\d.]+)元\s*百万tokens输出\s*([\d.]+)元\s*([\d.]+)元/.exec(text);
    if (flatMatch) {
      flat["deepseek-v4-flash"] = { hit: Number(flatMatch[1]), miss: Number(flatMatch[3]), output: Number(flatMatch[5]) };
      flat["deepseek-v4-pro"] = { hit: Number(flatMatch[2]), miss: Number(flatMatch[4]), output: Number(flatMatch[6]) };
    }
    // Peak/off-peak rate card (effective from the parsed switch date).
    const peak = {};
    const peakPattern = /deepseek-v4-(flash|pro)\s*空闲时段\s*([\d.]+)元\s*([\d.]+)元\s*([\d.]+)元\s*高峰时段\s*([\d.]+)元\s*([\d.]+)元\s*([\d.]+)元/g;
    for (const match of text.matchAll(peakPattern)) {
      peak[`deepseek-v4-${match[1]}`] = {
        offPeak: { hit: Number(match[2]), miss: Number(match[3]), output: Number(match[4]) },
        peak: { hit: Number(match[5]), miss: Number(match[6]), output: Number(match[7]) }
      };
    }
    // Peak/off-peak switch instant (Beijing time, epoch ms).
    const dateMatch = /北京时间\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):?(\d{2})?\s*开始生效/.exec(text);
    const effective = dateMatch
      ? Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), Number(dateMatch[4]) - 8, Number(dateMatch[5] ?? 0))
      : null;
    if (Object.keys(flat).length === 0 && Object.keys(peak).length === 0) return null;
    return { flat, peak, effective };
    }

/** Module-level pricing cache: at=0 means never fetched. */
const pricingCache = { at: 0, value: null, source: "builtin", table: null, effective: null };

/**
 * Refresh the official pricing table at most every PRICING_CACHE_TTL_MS.
 * A failed or unrecognizable fetch keeps the previous value (or the
 * built-in fallback) and never throws.
 * @returns the pricing cache entry.
 */
async function fetchPricing() {
    const now = Date.now();
    if (pricingCache.at !== 0 && now - pricingCache.at < PRICING_CACHE_TTL_MS) return pricingCache;
    pricingCache.at = now;
    try {
      const response = await fetch(PRICING_DOC_URL, {
        headers: { accept: "text/html" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (response.ok) {
        const parsed = parsePricing(await response.text());
        if (parsed !== null) {
          const active = parsed.effective === null || Date.now() < parsed.effective
            ? (Object.keys(parsed.flat).length > 0 ? { kind: "flat", table: parsed.flat } : { kind: "peak", table: parsed.peak })
            : { kind: "peak", table: parsed.peak };
          pricingCache.value = {};
          for (const [model, price] of Object.entries(active.table)) {
            pricingCache.value[model] = active.kind === "flat"
              ? { offPeak: price, peak: price }
              : price;
          }
          pricingCache.table = active.kind;
          pricingCache.effective = parsed.effective === null ? null : new Date(parsed.effective).toISOString();
          pricingCache.source = "docs";
        }
      }
    } catch {
      /* docs unreachable: keep the previous table (or the built-in fallback) */
    }
    return pricingCache;
    }

/** Coerce the API's stringly numbers ("78") to finite numbers, else 0. */
function parseQuotaNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Normalize one quota window (usage summary or a limits[] detail). */
function normalizeKimiWindow(detail, durationMinutes) {
  if (detail === null || typeof detail !== "object") return null;
  const limit = parseQuotaNumber(detail.limit ?? detail.limit_amount);
  let used = detail.used ?? detail.used_amount;
  if (used === undefined && detail.remaining !== undefined && limit > 0) {
    used = limit - parseQuotaNumber(detail.remaining);
  }
  const entry = {
    used: parseQuotaNumber(used),
    limit,
    remaining: parseQuotaNumber(detail.remaining ?? (limit > 0 ? limit - parseQuotaNumber(used) : 0)),
    resetTime: typeof (detail.resetTime ?? detail.reset_at) === "string" ? (detail.resetTime ?? detail.reset_at) : null
  };
  if (durationMinutes !== undefined) entry.durationMinutes = durationMinutes;
  return entry;
}

const TIME_UNIT_TO_MINUTES = { TIME_UNIT_MINUTE: 1, TIME_UNIT_HOUR: 60, TIME_UNIT_DAY: 1440 };

/**
 * Query Kimi Code (Coding Plan) quota via the official usages endpoint.
 * Returns { configured, weekly, fiveHour, booster } — `configured` is false
 * when no Kimi credential exists (the client then hides the section).
 */
async function queryKimiQuota(credentials) {
  let apiKey;
  for (const ref of KIMI_API_KEY_REFS) {
    apiKey = await credentials.resolve(ref).catch(() => undefined);
    if (apiKey?.value) break;
  }
  if (!apiKey?.value) return { configured: false, weekly: null, fiveHour: null, booster: null };
  const payload = await fetchJson(KIMI_USAGES_URL, {
    authorization: `Bearer ${apiKey.value}`,
    "user-agent": KIMI_USER_AGENT,
    accept: "application/json"
  }, FETCH_TIMEOUT_MS);
  const result = { configured: true, weekly: null, fiveHour: null, booster: null };
  if (payload === null || payload.failed === true) {
    result.error = payload?.status ?? "unreachable";
    return result;
  }
  result.weekly = normalizeKimiWindow(payload.usage);
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  const windows = [];
  for (const item of limits) {
    const window = item?.window ?? {};
    const duration = parseQuotaNumber(window.duration);
    const minutes = duration * (TIME_UNIT_TO_MINUTES[window.timeUnit] ?? 0);
    const detail = item?.detail ?? item;
    const row = normalizeKimiWindow(detail, minutes > 0 ? minutes : undefined);
    if (row !== null) windows.push(row);
  }
  result.fiveHour = windows.find((row) => row.durationMinutes === 300) ?? windows[0] ?? null;
  const wallet = payload.boosterWallet;
  if (wallet && typeof wallet === "object" && wallet.monthlyChargeLimit !== undefined) {
    result.booster = {
      currency: wallet.monthlyChargeLimit?.currency ?? null,
      limitCents: parseQuotaNumber(wallet.monthlyChargeLimit?.priceInCents),
      usedCents: parseQuotaNumber(wallet.monthlyUsed?.priceInCents)
    };
  }
  return result;
}

/** Decode a JWT payload (no verification; we only read exp/typ). */
function decodeKimiJwt(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** Milliseconds timestamp of the JWT exp claim, or NaN when absent. */
function kimiTokenExpMs(token) {
  const payload = decodeKimiJwt(token);
  const exp = Number(payload?.exp);
  return Number.isFinite(exp) ? exp * 1000 : NaN;
}

/**
 * The settings input accepts any of:
 * - a bare JWT (the payload typ claim — "access" / "refresh" — decides the role),
 * - "kimi-auth=<jwt>" / "refresh_token=<jwt>" pairs, ";" or whitespace separated,
 * - a JSON object {"accessToken"/"access_token", "refreshToken"/"refresh_token"}.
 * Pasting only the refresh_token (kimi.com → localStorage) is enough: the
 * access token is then obtained — and kept fresh — via the RefreshToken RPC.
 * Returns { accessToken, refreshToken } (either may be null), or null.
 */
function parseKimiTokenStore(pasted) {
  const raw = String(pasted ?? "").trim();
  if (raw === "") return null;
  if (raw.startsWith("{")) {
    try {
      const data = JSON.parse(raw);
      const store = {
        accessToken: String(data.accessToken ?? data.access_token ?? "").trim() || null,
        refreshToken: String(data.refreshToken ?? data.refresh_token ?? "").trim() || null
      };
      return store.accessToken !== null || store.refreshToken !== null ? store : null;
    } catch {
      return null;
    }
  }
  const store = { accessToken: null, refreshToken: null };
  for (const part of raw.split(/[;\s]+/)) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const key = eq > 0 ? part.slice(0, eq).trim().toLowerCase() : "";
    const value = eq > 0 ? part.slice(eq + 1).trim() : part;
    if (value === "") continue;
    if (key === "refresh_token" || key === "refreshtoken") store.refreshToken = value;
    else if (key !== "") store.accessToken = value; // kimi-auth=..., access_token=...
    else if (decodeKimiJwt(value)?.typ === "refresh") store.refreshToken = value;
    else store.accessToken = value;
  }
  return store.accessToken !== null || store.refreshToken !== null ? store : null;
}

/** Serialize the token store for the owner-only settings file. */
function formatKimiTokenStore(store) {
  return JSON.stringify({
    accessToken: store.accessToken,
    refreshToken: store.refreshToken,
    updatedAt: new Date().toISOString()
  });
}

/**
 * Aggregate the monthly membership quota from the GetSubscription RPC
 * response: sum the counted (non-free) feature quotas into one used
 * percentage, and take the current cycle end as the reset date (Beijing).
 * Returns { usedPct, resetDate } or null when there is no active subscription.
 */
function parseKimiMonthlySubscription(data) {
  const subscription = data?.subscription ?? null;
  if (subscription?.active !== true) return null;
  const endMs = typeof subscription.currentEndTime === "string"
    ? Date.parse(subscription.currentEndTime) : NaN;
  const resetDate = Number.isFinite(endMs) ? beijingDateKey(endMs) : null;
  let total = 0;
  let left = 0;
  for (const m of Array.isArray(data?.memberships) ? data.memberships : []) {
    if (m?.level === "LEVEL_FREE") continue;
    const t = Number(m?.totalCount);
    if (!Number.isFinite(t) || t <= 0) continue;
    const l = Number(m?.leftCount);
    total += t;
    left += Number.isFinite(l) ? Math.min(Math.max(l, 0), t) : 0;
  }
  // 无计数型配额（如纯 CODING 档位）时按 0% 展示。
  const usedPct = total === 0 ? 0 : Math.round((1 - left / total) * 1000) / 10;
  return { usedPct, resetDate };
}

/** Module-level monthly cache, keyed by the cookie value. */
const kimiMonthlyCache = { cookie: null, at: 0, value: null, error: null };

/** One GetSubscription RPC attempt; resolves { value, error }, never throws. */
async function queryKimiMonthlyWithToken(accessToken) {
  try {
    const response = await fetch(KIMI_SUBSCRIPTION_RPC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        accept: "application/json",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
      },
      body: "{}",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) return { value: null, error: `http-${response.status}` };
    const parsed = parseKimiMonthlySubscription(await response.json());
    return parsed !== null ? { value: parsed, error: null } : { value: null, error: "parse-failed" };
  } catch (error) {
    return { value: null, error: String(error?.message ?? error) };
  }
}

/** Module-level refresh in-flight de-dup (the footer polls every 30s). */
let kimiRefreshPromise = null;

/**
 * Exchange the refresh token for a fresh access+refresh pair via the kimi.com
 * AuthService RPC. Refresh tokens rotate, so the new pair is persisted back
 * to the settings file. Resolves the new store, or null on failure.
 */
function refreshKimiTokens(refreshToken, cookiePath) {
  if (kimiRefreshPromise !== null) return kimiRefreshPromise;
  kimiRefreshPromise = (async () => {
    try {
      const response = await fetch(KIMI_REFRESH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          accept: "application/json"
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!response.ok) return null;
      const data = await response.json();
      const accessToken = String(data.access_token ?? data.accessToken ?? "").trim();
      const nextRefresh = String(data.refresh_token ?? data.refreshToken ?? "").trim();
      if (accessToken === "") return null;
      const store = { accessToken, refreshToken: nextRefresh !== "" ? nextRefresh : refreshToken };
      if (cookiePath !== undefined) {
        try {
          mkdirSync(dirname(cookiePath), { recursive: true });
          writeFileSync(cookiePath, formatKimiTokenStore(store), { mode: 0o600 });
        } catch {
          /* best-effort: the fresh pair still serves this run */
        }
      }
      return store;
    } catch {
      return null;
    } finally {
      kimiRefreshPromise = null;
    }
  })();
  return kimiRefreshPromise;
}

/**
 * Read the monthly membership quota via the kimi.com SubscriptionService RPC
 * (the subscription page is a client-rendered SPA; its data comes from this
 * endpoint). The pasted value is the kimi-auth JWT and/or the refresh_token,
 * sent as a Bearer token — kimi.com APIs do not accept them as cookies. When
 * a refresh token is present, the access token is renewed automatically
 * (proactively below KIMI_REFRESH_MIN_REMAINING_MS, and once on an http-401).
 * Cached for KIMI_MONTHLY_CACHE_TTL_MS per stored value; never throws.
 */
async function queryKimiMonthly(cookie, cookiePath) {
  const now = Date.now();
  if (kimiMonthlyCache.at !== 0 && kimiMonthlyCache.cookie === cookie
    && now - kimiMonthlyCache.at < KIMI_MONTHLY_CACHE_TTL_MS) {
    return kimiMonthlyCache;
  }
  const next = { cookie, at: now, value: null, error: null };
  try {
    const store = parseKimiTokenStore(cookie);
    if (store === null) {
      next.error = "token-missing";
      Object.assign(kimiMonthlyCache, next);
      return kimiMonthlyCache;
    }
    let accessToken = store.accessToken;
    const expMs = accessToken !== null ? kimiTokenExpMs(accessToken) : NaN;
    const expired = Number.isFinite(expMs) && expMs <= now;
    const freshEnough = Number.isFinite(expMs) && expMs - now > KIMI_REFRESH_MIN_REMAINING_MS;
    if (!freshEnough && store.refreshToken !== null) {
      const refreshed = await refreshKimiTokens(store.refreshToken, cookiePath);
      if (refreshed !== null) {
        accessToken = refreshed.accessToken;
        next.cookie = formatKimiTokenStore(refreshed);
      } else if (accessToken === null || expired) {
        next.error = "refresh-failed";
      }
    }
    if (next.error === null && accessToken !== null) {
      let result = await queryKimiMonthlyWithToken(accessToken);
      if (result.error === "http-401" && store.refreshToken !== null) {
        const refreshed = await refreshKimiTokens(store.refreshToken, cookiePath);
        if (refreshed !== null) {
          accessToken = refreshed.accessToken;
          next.cookie = formatKimiTokenStore(refreshed);
          result = await queryKimiMonthlyWithToken(accessToken);
        }
      }
      next.value = result.value;
      next.error = result.error;
    } else if (next.error === null) {
      next.error = "token-missing";
    }
  } catch (error) {
    next.error = String(error?.message ?? error);
  }
  Object.assign(kimiMonthlyCache, next);
  return kimiMonthlyCache;
}

/** Read the stored kimi.com cookie (trimmed), or null when absent. */
function loadKimiCookie(cookiePath) {
  if (cookiePath === undefined) return null;
  try {
    const value = readFileSync(cookiePath, "utf8").trim();
    return value !== "" ? value : null;
  } catch {
    return null;
  }
}

/** Persist the kimi.com cookie (owner-only file); empty value clears it. */
function saveKimiCookie(cookiePath, value) {
  if (cookiePath === undefined) return;
  try {
    mkdirSync(dirname(cookiePath), { recursive: true });
    writeFileSync(cookiePath, value, { mode: 0o600 });
  } catch {
    /* best-effort; the monthly section just stays unconfigured */
  }
}

/** Read a bounded JSON/text request body. */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body-too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Query opencode Go subscription usage: rolling 5h / weekly / monthly percent windows. */
async function queryOpenCodeGo(credentials) {
  const key = await credentials.resolve(OPENCODE_GO_KEY_REF).catch(() => undefined);
  if (!key?.value) return { configured: false, fiveHour: null, weekly: null, monthly: null };
  const raw = await fetchJson(OPENCODE_GO_USAGE_URL, {
    authorization: `Bearer ${key.value}`,
    accept: "application/json"
  }, FETCH_TIMEOUT_MS);
  const usage = raw && typeof raw === "object" ? raw.usage : null;
  if (!usage || typeof usage !== "object") {
    return { configured: true, fiveHour: null, weekly: null, monthly: null, error: "query-failed" };
  }
  // Row shape matches the kimi quota rows consumed by the client: `used`
  // carries percent points (no `limit`, so quotaPercent treats it as %),
  // `resetTime` is the ISO reset instant.
  const row = (r) => r && Number.isFinite(Number(r.percent))
    ? { used: Number(r.percent), resetTime: typeof r.resetsAt === "string" ? r.resetsAt : null }
    : null;
  return {
    configured: true,
    fiveHour: row(usage.rolling),
    weekly: row(usage.weekly),
    monthly: row(usage.monthly)
  };
}

/** Query DeepSeek for the account figures this route publishes. */
async function queryUsageStatus(credentials, baselinePath, kimiCookie, kimiCookiePath) {
  const now = new Date();
  const result = {
    month: now.getMonth() + 1,
    year: now.getFullYear(),
    balance: null,
    todaySpend: null,
    usageAmount: null,
    usageCost: null,
    pricing: null,
    pricingSource: "builtin",
    pricingTable: null,
    pricingEffective: null,
    pricingFetchedAt: null,
    kimi: null,
    opencodeGo: null,
    errors: []
  };

  const apiKey = await credentials.resolve(API_KEY_REF).catch(() => undefined);
  if (apiKey?.value) {
    const balance = await fetchJson("https://api.deepseek.com/user/balance", {
      authorization: `Bearer ${apiKey.value}`,
      accept: "application/json"
    }, FETCH_TIMEOUT_MS);
    const info = balance?.balance_infos?.[0];
    if (info !== undefined) {
      result.balance = {
        isAvailable: balance.is_available === true,
        currency: typeof info.currency === "string" ? info.currency : null,
        totalBalance: String(info.total_balance ?? ""),
        grantedBalance: String(info.granted_balance ?? ""),
        toppedUpBalance: String(info.topped_up_balance ?? "")
      };
      if (baselinePath !== undefined) {
        result.todaySpend = computeTodaySpend(baselinePath, info, now.getTime());
      }
    } else {
      result.errors.push("balance-unavailable");
    }
  }

  const platformToken = await credentials.resolve(PLATFORM_TOKEN_REF).catch(() => undefined);
  if (platformToken?.value) {
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const headers = {
      authorization: `Bearer ${platformToken.value}`,
      accept: "application/json"
    };
    const [amount, cost] = await Promise.all([
      fetchJson(`https://platform.deepseek.com/api/v0/usage/amount?month=${month}&year=${year}`, headers, FETCH_TIMEOUT_MS),
      fetchJson(`https://platform.deepseek.com/api/v0/usage/cost?month=${month}&year=${year}`, headers, FETCH_TIMEOUT_MS)
    ]);
    if (amount && !amount.failed && amount.code === 0) result.usageAmount = amount.data ?? amount;
    else result.errors.push("usage-amount-unavailable");
    if (cost && !cost.failed && cost.code === 0) result.usageCost = cost.data ?? cost;
    else result.errors.push("usage-cost-unavailable");
  }

  const kimi = await queryKimiQuota(credentials).catch(() => ({ configured: true, error: "query-failed" }));
  result.kimi = kimi;
  if (kimi.configured === true && (kimi.error !== undefined || kimi.weekly === null)) {
    result.errors.push("kimi-quota-unavailable");
  }
  // Monthly membership quota via the kimi.com SubscriptionService RPC with
  // the user-pasted token(s) (Settings → General); auto-refreshed when a
  // refresh token is available. Best-effort.
  const cookie = typeof kimiCookie === "string" && kimiCookie.trim() !== "" ? kimiCookie.trim() : null;
  kimi.monthlyConfigured = cookie !== null;
  kimi.monthly = null;
  if (cookie !== null) {
    const monthly = await queryKimiMonthly(cookie, kimiCookiePath);
    if (monthly.value !== null && monthly.value !== undefined) {
      kimi.monthly = monthly.value;
    } else {
      kimi.monthlyError = monthly.error ?? "parse-failed";
      result.errors.push("kimi-monthly-unavailable");
    }
  }

  const go = await queryOpenCodeGo(credentials).catch(() => ({ configured: true, error: "query-failed" }));
  result.opencodeGo = go;
  if (go.configured === true && go.error !== undefined) {
    result.errors.push("opencode-go-unavailable");
  }

  const pricing = await fetchPricing();
  result.pricing = pricing.value;
  result.pricingSource = pricing.source;
  result.pricingFetchedAt = pricing.at === 0 ? null : new Date(pricing.at).toISOString();
  result.pricingTable = pricing.table ?? null;
  result.pricingEffective = pricing.effective ?? null;
  return result;
}

export const inject = ["credentials", "webServer"];

export { computeTodaySpend };

export function apply(ctx) {
  const cache = new Map(); // key -> { at, value }
  // Settings registration rides the optional-settings seam: absent settings
  // service, the feature simply stays always-on with no toggle surface.
  let usageScope;
  ctx.inject(["settings"], (settingsCtx) => {
    usageScope = settingsCtx.settings.register(USAGE_SETTINGS_NS, USAGE_SETTINGS_SCHEMA);
  });
  // Day-start balance snapshot path: $DSH_HOME/… when the home-path service
  // exists, else ~/.dsh/… as a fallback.
  let baselinePath = join(homedir(), ".dsh", BASELINE_FILENAME);
  let kimiCookiePath = join(homedir(), ".dsh", KIMI_COOKIE_FILENAME);
  ctx.inject(["dshHomePath"], (homeCtx) => {
    baselinePath = homeCtx.dshHomePath(BASELINE_FILENAME);
    kimiCookiePath = homeCtx.dshHomePath(KIMI_COOKIE_FILENAME);
  });
  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      handler: async (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405);
          res.end();
          return;
        }
        const remote = req.socket?.remoteAddress ?? "";
        if (!isLoopback(remote)) {
          res.writeHead(403);
          res.end();
          return;
        }
        if (usageScope !== undefined && usageScope.get().enabled === false) {
          sendJson(res, 200, { disabled: true });
          return;
        }
        const cached = cache.get("status");
        if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
          sendJson(res, 200, cached.value);
          return;
        }
        const kimiCookie = loadKimiCookie(kimiCookiePath);
        const value = await queryUsageStatus(ctx.credentials, baselinePath, kimiCookie, kimiCookiePath);
        cache.set("status", { at: Date.now(), value });
        sendJson(res, 200, value);
      }
    });
    // kimi.com cookie intake: GET answers { configured } only (never the
    // cookie itself); POST accepts a raw cookie string or {"cookie": "…"},
    // strips CR/LF, stores it owner-only, and invalidates both caches so the
    // next poll refetches immediately.
    const disposeCookieRoute = ctx.webServer.register({
      kind: "exact",
      path: KIMI_COOKIE_ROUTE,
      handler: async (req, res) => {
        const remote = req.socket?.remoteAddress ?? "";
        if (!isLoopback(remote)) {
          res.writeHead(403);
          res.end();
          return;
        }
        if (req.method === "GET") {
          sendJson(res, 200, { configured: loadKimiCookie(kimiCookiePath) !== null });
          return;
        }
        if (req.method === "POST") {
          try {
            const raw = await readBody(req, KIMI_COOKIE_MAX_BYTES);
            let cookie = raw.trim();
            if (cookie.startsWith("{")) {
              try {
                cookie = String(JSON.parse(cookie).cookie ?? "").trim();
              } catch {
                cookie = "";
              }
            }
            cookie = cookie.replace(/[\r\n]+/g, " ").trim();
            saveKimiCookie(kimiCookiePath, cookie);
            kimiMonthlyCache.cookie = null;
            kimiMonthlyCache.at = 0;
            kimiMonthlyCache.value = null;
            kimiMonthlyCache.error = null;
            cache.delete("status");
            sendJson(res, 200, { ok: true, configured: cookie !== "" });
          } catch {
            sendJson(res, 400, { ok: false });
          }
          return;
        }
        res.writeHead(405);
        res.end();
      }
    });
    return () => {
      disposeRoute();
      disposeCookieRoute();
      cache.clear();
    };
  }, "usage-status: /usage-status route");
}

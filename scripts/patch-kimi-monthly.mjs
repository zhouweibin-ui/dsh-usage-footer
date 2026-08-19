// One-shot patch #2: monthly membership quota (cookie-based SSR scrape).
// Adds: settings input row styles+component+registration, panel monthly rows,
// footer month segment, zh/en strings. Idempotent.
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../packages/dsh-client-ui-usage-footer/lib/client.js", import.meta.url).pathname;
let src = readFileSync(path, "utf8");
if (src.includes('"panel.kimiMonthly"')) {
  console.log("already patched");
  process.exit(0);
}

const EOL = "\r\n";
const block = (lines) => lines.join(EOL) + EOL;

function insertBefore(anchor, text) {
  const at = src.indexOf(anchor);
  if (at === -1) throw new Error("anchor not found: " + JSON.stringify(anchor.slice(0, 60)));
  src = src.slice(0, at) + text + src.slice(at);
}
function insertAfter(anchor, text) {
  const at = src.indexOf(anchor);
  if (at === -1) throw new Error("anchor not found: " + JSON.stringify(anchor.slice(0, 60)));
  src = src.slice(0, at + anchor.length) + text + src.slice(at + anchor.length);
}
function replaceOnce(anchor, text) {
  const at = src.indexOf(anchor);
  if (at === -1) throw new Error("anchor not found: " + JSON.stringify(anchor.slice(0, 60)));
  src = src.slice(0, at) + text + src.slice(at + anchor.length);
}

// 1. CSS: input row styles.
insertAfter(
  `.uT_chevron{flex:none}`,
  `.uT_input{flex:1;min-width:0;height:32px;padding:0 12px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none}` +
  `.uT_input:focus{border-color:var(--dsw-alias-state-business-primary)}` +
  `.uT_btn{flex:none;height:32px;padding:0 14px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);border:none;border-radius:8px;cursor:pointer}` +
  `.uT_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}` +
  `.uT_state{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}`
);

// 2. Derived values for the monthly quota.
insertAfter(
  `\t\t\tconst kimiBooster = kimi?.booster ?? null;`,
  block([
    ``,
    `\t\t\tconst kimiMonthly = kimi?.monthly ?? null;`,
    `\t\t\tconst kimiMonthlyConfigured = kimi?.monthlyConfigured === true;`,
    `\t\t\tconst kimiMonthPct = kimiMonthly !== null && Number.isFinite(Number(kimiMonthly.usedPct)) ? Math.round(Number(kimiMonthly.usedPct)) : null;`,
  ]).replace(/^\r\n/, "")
);

// 3. Panel monthly rows: inside the kimiConfigured fragment, after the
//    booster row, before the fragment close that precedes the panel footer.
replaceOnce(
  `\t\t\t\t\t] }),` + EOL + `\t\t\t\t\tjsxs("div", { className: "uW_footer", children: [`,
  block([
    `\t\t\t\t\t\tkimiMonthlyConfigured && kimiMonthPct !== null && jsxs("div", { className: "uW_bucket", children: [`,
    `\t\t\t\t\t\t\tjsxs("div", { className: "uW_bucketHead", children: [`,
    `\t\t\t\t\t\t\t\tjsx("span", { className: "uW_bucketLabel", children: t("panel.kimiMonthly") }),`,
    `\t\t\t\t\t\t\t\tjsx("span", { className: "uW_bucketValue", children: t("panel.kimiUsed", { pct: kimiMonthPct }) })`,
    `\t\t\t\t\t\t\t] }),`,
    `\t\t\t\t\t\t\tjsx("div", { className: "uW_bucketBar", children: jsx("div", {`,
    `\t\t\t\t\t\t\t\tclassName: "uW_bucketFill uW_tintKimi",`,
    `\t\t\t\t\t\t\t\tstyle: { width: Math.max(2, Math.min(100, kimiMonthPct)) + "%" }`,
    `\t\t\t\t\t\t\t}) }),`,
    `\t\t\t\t\t\t\ttypeof kimiMonthly?.resetDate === "string" && jsx("div", { className: "uW_sub", children: t("panel.kimiMonthlyReset", { date: kimiMonthly.resetDate }) })`,
    `\t\t\t\t\t\t] }),`,
    `\t\t\t\t\t\tkimiMonthlyConfigured && kimiMonthPct === null && jsx("div", { className: "uW_sub", children: t("panel.kimiMonthlyFailed") }),`,
    `\t\t\t\t\t\t!kimiMonthlyConfigured && jsx("div", { className: "uW_sub", children: t("panel.kimiMonthlyNeedCookie") }),`,
    `\t\t\t\t\t] }),`,
    `\t\t\t\t\tjsxs("div", { className: "uW_footer", children: [`,
  ]).replace(/\r\n$/, "")
);

// 4. Footer line: include the month segment when available.
replaceOnce(
  block([
    `\t\t\tif (kimiConfigured && (kimi5hPct !== null || kimiWeeklyPct !== null)) {`,
    `\t\t\t\tlineGroups.push(jsx("span", { children: t("line.kimi", {`,
    `\t\t\t\t\th5: kimi5hPct !== null ? kimi5hPct + "%" : "–",`,
    `\t\t\t\t\tweek: kimiWeeklyPct !== null ? kimiWeeklyPct + "%" : "–"`,
    `\t\t\t\t}) }, "kimi"));`,
    `\t\t\t}`,
  ]).replace(/\r\n$/, ""),
  block([
    `\t\t\tif (kimiConfigured && (kimi5hPct !== null || kimiWeeklyPct !== null || kimiMonthPct !== null)) {`,
    `\t\t\t\tlineGroups.push(jsx("span", { children: t(kimiMonthPct !== null ? "line.kimiFull" : "line.kimi", {`,
    `\t\t\t\t\th5: kimi5hPct !== null ? kimi5hPct + "%" : "–",`,
    `\t\t\t\t\tweek: kimiWeeklyPct !== null ? kimiWeeklyPct + "%" : "–",`,
    `\t\t\t\t\tmonth: kimiMonthPct !== null ? kimiMonthPct + "%" : "–"`,
    `\t\t\t\t}) }, "kimi"));`,
    `\t\t\t}`,
  ]).replace(/\r\n$/, "")
);

// 5. KimiCookieRow component (Settings → General), before the dictionaries.
insertBefore(
  `\t\t/** Usage-footer dictionaries (zh-CN / en). */`,
  block([
    `\t\t/** General Settings row: kimi.com cookie input for the monthly quota. */`,
    `\t\tfunction KimiCookieRow(props) {`,
    `\t\t\tconst { scope, t } = props;`,
    `\t\t\tconst readConfigured = () => {`,
    `\t\t\t\tconst snapshot = scope.getSnapshot();`,
    `\t\t\t\treturn snapshot.user !== undefined && typeof snapshot.user.kimiCookie === "string" && snapshot.user.kimiCookie.trim() !== "";`,
    `\t\t\t};`,
    `\t\t\tconst [value, setValue] = react.useState("");`,
    `\t\t\tconst [configured, setConfigured] = react.useState(readConfigured);`,
    `\t\t\treact.useEffect(() => {`,
    `\t\t\t\tconst dispose = scope.subscribe(() => setConfigured(readConfigured()));`,
    `\t\t\t\treturn () => {`,
    `\t\t\t\t\tif (typeof dispose === "function") dispose();`,
    `\t\t\t\t};`,
    `\t\t\t}, [scope]);`,
    `\t\t\tconst save = () => {`,
    `\t\t\t\tconst next = value.trim();`,
    `\t\t\t\tif (next === "") return;`,
    `\t\t\t\tscope.set("kimiCookie", next);`,
    `\t\t\t\tsetValue("");`,
    `\t\t\t};`,
    `\t\t\tconst clear = () => {`,
    `\t\t\t\tscope.set("kimiCookie", "");`,
    `\t\t\t\tsetValue("");`,
    `\t\t\t};`,
    `\t\t\treturn jsxs("div", {`,
    `\t\t\t\tclassName: "uT_row",`,
    `\t\t\t\tchildren: [`,
    `\t\t\t\t\tjsxs("div", {`,
    `\t\t\t\t\t\tclassName: "uT_rowText",`,
    `\t\t\t\t\t\tchildren: [`,
    `\t\t\t\t\t\t\tjsx("div", { className: "uT_title", children: t("settings.kimiCookie.title") }),`,
    `\t\t\t\t\t\t\tjsx("div", { className: "uT_desc", children: t("settings.kimiCookie.description") }),`,
    `\t\t\t\t\t\t\tjsx("div", { className: "uT_state", children: t(configured ? "settings.kimiCookie.configured" : "settings.kimiCookie.empty") })`,
    `\t\t\t\t\t\t]`,
    `\t\t\t\t\t}),`,
    `\t\t\t\t\tjsx("input", {`,
    `\t\t\t\t\t\tclassName: "uT_input",`,
    `\t\t\t\t\t\ttype: "password",`,
    `\t\t\t\t\t\tplaceholder: t("settings.kimiCookie.placeholder"),`,
    `\t\t\t\t\t\tvalue,`,
    `\t\t\t\t\t\tspellCheck: false,`,
    `\t\t\t\t\t\tautoComplete: "off",`,
    `\t\t\t\t\t\tonChange: (event) => setValue(event.target.value),`,
    `\t\t\t\t\t\tonKeyDown: (event) => {`,
    `\t\t\t\t\t\t\tif (event.key === "Enter") save();`,
    `\t\t\t\t\t\t}`,
    `\t\t\t\t\t}),`,
    `\t\t\t\t\tjsx("button", { type: "button", className: "uT_btn", onClick: save, children: t("settings.kimiCookie.save") }),`,
    `\t\t\t\t\tconfigured && jsx("button", { type: "button", className: "uT_btn", onClick: clear, children: t("settings.kimiCookie.clear") })`,
    `\t\t\t\t]`,
    `\t\t\t});`,
    `\t\t}`,
    ``,
  ])
);

// 6. Register the settings row, after the toggle registration.
insertAfter(
  `\t\t\t}, UsageToggleRow));`,
  block([
    `\t\t\tctx.slots.inject("settings.general.item", () => ctx.slots.register({`,
    `\t\t\t\tname: "settings.general.item",`,
    `\t\t\t\tid: "kimi-cookie-input",`,
    `\t\t\t\torder: 41,`,
    `\t\t\t\tlocale: NS,`,
    `\t\t\t\tinject: () => ({ scope })`,
    `\t\t\t}, KimiCookieRow));`,
  ]).replace(/^\r\n/, "\r\n")
);

// 7. zh dictionary.
insertBefore(
  `\t\t\t"line.balance": "余额 {amount}",`,
  block([
    `\t\t\t"panel.kimiMonthly": "月度额度",`,
    `\t\t\t"panel.kimiMonthlyReset": "{date} 后重置",`,
    `\t\t\t"panel.kimiMonthlyFailed": "月额度查询失败（Cookie 可能已失效）",`,
    `\t\t\t"panel.kimiMonthlyNeedCookie": "在 设置 → 通用 粘贴 Kimi 网页 Cookie 后显示月度额度",`,
    `\t\t\t"line.kimiFull": "Kimi 5h {h5} · 周 {week} · 月 {month}",`,
    `\t\t\t"settings.kimiCookie.title": "Kimi 网页 Cookie（月度额度）",`,
    `\t\t\t"settings.kimiCookie.description": "粘贴 kimi.com 的 Cookie 请求头，用于读取月度会员额度；仅保存在本机设置文件中",`,
    `\t\t\t"settings.kimiCookie.placeholder": "kimi.com 已登录 → DevTools → Network → 请求头 Cookie",`,
    `\t\t\t"settings.kimiCookie.save": "保存",`,
    `\t\t\t"settings.kimiCookie.clear": "清除",`,
    `\t\t\t"settings.kimiCookie.configured": "已配置（内容不显示）",`,
    `\t\t\t"settings.kimiCookie.empty": "未配置",`,
  ])
);

// 8. en dictionary.
insertBefore(
  `\t\t\t"line.balance": "Balance {amount}",`,
  block([
    `\t\t\t"panel.kimiMonthly": "Monthly quota",`,
    `\t\t\t"panel.kimiMonthlyReset": "Resets {date}",`,
    `\t\t\t"panel.kimiMonthlyFailed": "Monthly quota fetch failed (cookie may have expired)",`,
    `\t\t\t"panel.kimiMonthlyNeedCookie": "Paste your kimi.com cookie in Settings → General to see the monthly quota",`,
    `\t\t\t"line.kimiFull": "Kimi 5h {h5} · wk {week} · mo {month}",`,
    `\t\t\t"settings.kimiCookie.title": "Kimi web cookie (monthly quota)",`,
    `\t\t\t"settings.kimiCookie.description": "Paste the Cookie request header from a logged-in kimi.com session to read the monthly membership quota; stored only in the local settings file",`,
    `\t\t\t"settings.kimiCookie.placeholder": "kimi.com logged in → DevTools → Network → Cookie header",`,
    `\t\t\t"settings.kimiCookie.save": "Save",`,
    `\t\t\t"settings.kimiCookie.clear": "Clear",`,
    `\t\t\t"settings.kimiCookie.configured": "Configured (value hidden)",`,
    `\t\t\t"settings.kimiCookie.empty": "Not configured",`,
  ])
);

writeFileSync(path, src);
console.log("patched OK");

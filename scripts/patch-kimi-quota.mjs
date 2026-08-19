// One-shot patch: add Kimi quota section/line/i18n to the built client bundle.
// Idempotent: skips when "uW_tintKimi" panel marker already present.
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../packages/dsh-client-ui-usage-footer/lib/client.js", import.meta.url).pathname;
let src = readFileSync(path, "utf8");
if (src.includes('"panel.kimi"')) {
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

// 1. Panel section: before the panel footer row.
insertBefore(
  `\t\t\t\t\tjsxs("div", { className: "uW_footer", children: [`,
  block([
    `\t\t\t\t\tkimiConfigured && jsxs(Fragment, { children: [`,
    `\t\t\t\t\t\tjsx("div", { className: "uW_sectionLabel", children: t("panel.kimi") }),`,
    `\t\t\t\t\t\tkimi5h === null && kimiWeekly === null && jsx("div", { className: "uW_sub", children: t("panel.kimiUnavailable") }),`,
    `\t\t\t\t\t\tkimi5h !== null && jsxs("div", { className: "uW_bucket", children: [`,
    `\t\t\t\t\t\t\tjsxs("div", { className: "uW_bucketHead", children: [`,
    `\t\t\t\t\t\t\t\tjsx("span", { className: "uW_bucketLabel", children: t("panel.kimi5h") }),`,
    `\t\t\t\t\t\t\t\tjsx("span", { className: "uW_bucketValue", children: kimi5hPct !== null ? t("panel.kimiUsed", { pct: kimi5hPct }) : "—" })`,
    `\t\t\t\t\t\t\t] }),`,
    `\t\t\t\t\t\t\tjsx("div", { className: "uW_bucketBar", children: jsx("div", {`,
    `\t\t\t\t\t\t\t\tclassName: "uW_bucketFill uW_tintKimi",`,
    `\t\t\t\t\t\t\t\tstyle: { width: Math.max(2, Math.min(100, kimi5hPct ?? 0)) + "%" }`,
    `\t\t\t\t\t\t\t}) }),`,
    `\t\t\t\t\t\t\tkimi5hReset !== null && jsx("div", { className: "uW_sub", children: t("panel.kimiReset", { time: kimi5hReset.time, left: kimi5hReset.left }) })`,
    `\t\t\t\t\t\t] }),`,
    `\t\t\t\t\t\tkimiWeekly !== null && jsxs("div", { className: "uW_bucket", children: [`,
    `\t\t\t\t\t\t\tjsxs("div", { className: "uW_bucketHead", children: [`,
    `\t\t\t\t\t\t\t\tjsx("span", { className: "uW_bucketLabel", children: t("panel.kimiWeekly") }),`,
    `\t\t\t\t\t\t\t\tjsx("span", { className: "uW_bucketValue", children: kimiWeeklyPct !== null ? t("panel.kimiUsed", { pct: kimiWeeklyPct }) : "—" })`,
    `\t\t\t\t\t\t\t] }),`,
    `\t\t\t\t\t\t\tjsx("div", { className: "uW_bucketBar", children: jsx("div", {`,
    `\t\t\t\t\t\t\t\tclassName: "uW_bucketFill uW_tintKimi",`,
    `\t\t\t\t\t\t\t\tstyle: { width: Math.max(2, Math.min(100, kimiWeeklyPct ?? 0)) + "%" }`,
    `\t\t\t\t\t\t\t}) }),`,
    `\t\t\t\t\t\t\tkimiWeeklyReset !== null && jsx("div", { className: "uW_sub", children: t("panel.kimiReset", { time: kimiWeeklyReset.time, left: kimiWeeklyReset.left }) })`,
    `\t\t\t\t\t\t] }),`,
    `\t\t\t\t\t\tkimiBooster !== null && jsxs("div", { className: "uW_totalRow", children: [`,
    `\t\t\t\t\t\t\tjsx("span", { className: "uW_bucketLabel", children: t("panel.kimiBooster") }),`,
    `\t\t\t\t\t\t\tjsx("span", { className: "uW_totalHint", children: t("panel.kimiBoosterValue", {`,
    `\t\t\t\t\t\t\t\tused: moneyText(formatMoney(kimiBooster.usedCents / 100), kimiBooster.currency),`,
    `\t\t\t\t\t\t\t\tlimit: moneyText(formatMoney(kimiBooster.limitCents / 100), kimiBooster.currency)`,
    `\t\t\t\t\t\t\t}) })`,
    `\t\t\t\t\t\t] })`,
    `\t\t\t\t\t] }),`,
  ])
);

// 2. Footer line segment: before the peak/off-peak segment push.
insertBefore(
  `\t\t\tlineGroups.push(jsx("span", { children: facts.isPeak`,
  block([
    `\t\t\tif (kimiConfigured && (kimi5hPct !== null || kimiWeeklyPct !== null)) {`,
    `\t\t\t\tlineGroups.push(jsx("span", { children: t("line.kimi", {`,
    `\t\t\t\t\th5: kimi5hPct !== null ? kimi5hPct + "%" : "–",`,
    `\t\t\t\t\tweek: kimiWeeklyPct !== null ? kimiWeeklyPct + "%" : "–"`,
    `\t\t\t\t}) }, "kimi"));`,
    `\t\t\t}`,
  ])
);

// 3. zh dictionary: before "line.balance".
insertBefore(
  `\t\t\t"line.balance": "余额 {amount}",`,
  block([
    `\t\t\t"panel.kimi": "Kimi Code 额度",`,
    `\t\t\t"panel.kimi5h": "5 小时额度",`,
    `\t\t\t"panel.kimiWeekly": "每周额度",`,
    `\t\t\t"panel.kimiBooster": "本月加油包",`,
    `\t\t\t"panel.kimiBoosterValue": "已用 {used} / 上限 {limit}",`,
    `\t\t\t"panel.kimiUsed": "已用 {pct}%",`,
    `\t\t\t"panel.kimiReset": "重置 {time}（{left}后）",`,
    `\t\t\t"panel.kimiUnavailable": "Kimi 额度查询失败",`,
    `\t\t\t"panel.kimiNow": "即将重置",`,
    `\t\t\t"unit.d": "天",`,
    `\t\t\t"unit.h": "小时",`,
    `\t\t\t"unit.m": "分钟",`,
    `\t\t\t"line.kimi": "Kimi 5h {h5} · 周 {week}",`,
  ])
);

// 4. en dictionary: before "line.balance".
insertBefore(
  `\t\t\t"line.balance": "Balance {amount}",`,
  block([
    `\t\t\t"panel.kimi": "Kimi Code quota",`,
    `\t\t\t"panel.kimi5h": "5-hour quota",`,
    `\t\t\t"panel.kimiWeekly": "Weekly quota",`,
    `\t\t\t"panel.kimiBooster": "Monthly booster",`,
    `\t\t\t"panel.kimiBoosterValue": "{used} used / {limit} cap",`,
    `\t\t\t"panel.kimiUsed": "{pct}% used",`,
    `\t\t\t"panel.kimiReset": "Resets {time} (in {left})",`,
    `\t\t\t"panel.kimiUnavailable": "Kimi quota unavailable",`,
    `\t\t\t"panel.kimiNow": "resetting soon",`,
    `\t\t\t"unit.d": "d",`,
    `\t\t\t"unit.h": "h",`,
    `\t\t\t"unit.m": "m",`,
    `\t\t\t"line.kimi": "Kimi 5h {h5} · wk {week}",`,
  ])
);

writeFileSync(path, src);
console.log("patched OK");

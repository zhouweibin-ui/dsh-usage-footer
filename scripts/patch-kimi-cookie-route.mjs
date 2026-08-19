// One-shot patch #3: KimiCookieRow switches from settings-scope writes (which
// the host silently drops — only the first schema registration sticks) to the
// dedicated loopback route GET/POST /usage-status/kimi-cookie.
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../packages/dsh-client-ui-usage-footer/lib/client.js", import.meta.url).pathname;
let src = readFileSync(path, "utf8");
if (src.includes('fetch("/usage-status/kimi-cookie"')) {
  console.log("already patched");
  process.exit(0);
}

const EOL = "\r\n";

// 1. Replace the whole KimiCookieRow component (from its doc comment up to
//    the dictionaries comment).
const compStart = `\t\t/** General Settings row: kimi.com cookie input for the monthly quota. */`;
const dictAnchor = `\t\t/** Usage-footer dictionaries (zh-CN / en). */`;
const i0 = src.indexOf(compStart);
const i1 = src.indexOf(dictAnchor);
if (i0 === -1 || i1 === -1 || i0 >= i1) throw new Error("component anchors not found");

const component = [
  `\t\t/** General Settings row: kimi.com cookie input for the monthly quota. */`,
  `\t\tfunction KimiCookieRow(props) {`,
  `\t\t\tconst { t } = props;`,
  `\t\t\tconst [value, setValue] = react.useState("");`,
  `\t\t\tconst [configured, setConfigured] = react.useState(false);`,
  `\t\t\tconst [busy, setBusy] = react.useState(false);`,
  `\t\t\treact.useEffect(() => {`,
  `\t\t\t\tlet alive = true;`,
  `\t\t\t\tfetch("/usage-status/kimi-cookie", { headers: { accept: "application/json" } })`,
  `\t\t\t\t\t.then((response) => (response.ok ? response.json() : null))`,
  `\t\t\t\t\t.then((data) => {`,
  `\t\t\t\t\t\tif (alive && data !== null) setConfigured(data.configured === true);`,
  `\t\t\t\t\t})`,
  `\t\t\t\t\t.catch(() => {});`,
  `\t\t\t\treturn () => {`,
  `\t\t\t\t\talive = false;`,
  `\t\t\t\t};`,
  `\t\t\t}, []);`,
  `\t\t\tconst post = (cookie) => {`,
  `\t\t\t\tsetBusy(true);`,
  `\t\t\t\tfetch("/usage-status/kimi-cookie", {`,
  `\t\t\t\t\tmethod: "POST",`,
  `\t\t\t\t\theaders: { "content-type": "application/json" },`,
  `\t\t\t\t\tbody: JSON.stringify({ cookie })`,
  `\t\t\t\t})`,
  `\t\t\t\t\t.then((response) => (response.ok ? response.json() : null))`,
  `\t\t\t\t\t.then((data) => {`,
  `\t\t\t\t\t\tif (data !== null && data.ok === true) {`,
  `\t\t\t\t\t\t\tsetConfigured(data.configured === true);`,
  `\t\t\t\t\t\t\tsetValue("");`,
  `\t\t\t\t\t\t}`,
  `\t\t\t\t\t})`,
  `\t\t\t\t\t.catch(() => {})`,
  `\t\t\t\t\t.finally(() => setBusy(false));`,
  `\t\t\t};`,
  `\t\t\tconst save = () => {`,
  `\t\t\t\tconst next = value.trim();`,
  `\t\t\t\tif (next === "" || busy) return;`,
  `\t\t\t\tpost(next);`,
  `\t\t\t};`,
  `\t\t\tconst clear = () => {`,
  `\t\t\t\tif (!busy) post("");`,
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
  `\t\t\t\t\tjsx("button", { type: "button", className: "uT_btn", disabled: busy, onClick: save, children: t("settings.kimiCookie.save") }),`,
  `\t\t\t\t\tconfigured && jsx("button", { type: "button", className: "uT_btn", disabled: busy, onClick: clear, children: t("settings.kimiCookie.clear") })`,
  `\t\t\t\t]`,
  `\t\t\t});`,
  `\t\t}`,
  ``,
].join(EOL);

src = src.slice(0, i0) + component + src.slice(i1);

// 2. Registration no longer injects the settings scope.
const injectOld = `\t\t\t\tinject: () => ({ scope })`;
const injectNew = `\t\t\t\tinject: () => ({})`;
const at = src.indexOf(injectOld);
if (at === -1) throw new Error("inject anchor not found");
src = src.slice(0, at) + injectNew + src.slice(at + injectOld.length);

writeFileSync(path, src);
console.log("patched OK");

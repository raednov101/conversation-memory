// Developer tool for the interface's languages. Strings are written in Arabic in the code, wrapped in T() / T`…`;
// the English catalog (core/i18n-en.js) maps each to its translation, by the Arabic text itself (gettext style).
//   node scripts/i18n.js wrap <files…>   wrap the Arabic string literals of these files in T (never protocol strings,
//                                         comparisons, matching arguments, object keys, or lines marked «i18n-skip»)
//   node scripts/i18n.js keys             list every key used in the code that the English catalog lacks (and the unused ones)
"use strict";
const fs = require("fs"),
  path = require("path"),
  acorn = require("acorn"),
  walk = require("acorn-walk");
const ROOT = path.join(__dirname, "..");
const AR = /[؀-ۿ]/;
const SKIP_NAMES = new Set([
  "GENERAL_NAMES",
  "REVIEW_KIND",
  "SOURCE_LABEL",
  "PLATFORMS",
  "STOP",
  "NEG",
  "MA_NEG",
  "AGREE_IDIOM",
  "CHANGE",
  "MONTHS",
  "SCALE",
  "DIGITS",
  "START",
  "END",
  "HK",
  "HK_EN",
  "PLACEHOLDER",
  "W",
  "CMD",
  "ASSIGN_RE",
]);
const MATCH_METHODS = new Set([
  "startsWith",
  "endsWith",
  "includes",
  "indexOf",
  "lastIndexOf",
  "split",
  "test",
  "match",
  "matchAll",
  "search",
  "has",
  "get",
  "delete",
]);
const parse = (src) =>
  acorn.parse(src, { ecmaVersion: 2023, sourceType: "script", locations: true, allowReturnOutsideFunction: true, allowHashBang: true });
const SOURCES = ["core/memory-core.js", "extension/src", "plugin/scripts", "plugin/hooks"];
function files() {
  const out = [];
  const add = (p) => {
    const s = fs.statSync(p);
    if (s.isDirectory()) for (const f of fs.readdirSync(p)) add(path.join(p, f));
    else if (/\.js$/.test(p) && !/memory-core\.js$|i18n-en\.js$/.test(p.replace(/\\/g, "/").replace(ROOT + "/core/", "x/"))) out.push(p);
  };
  for (const s of SOURCES) add(path.join(ROOT, s));
  return out
    .filter((f) => !/extension[\\/]src[\\/]memory-core\.js$|plugin[\\/]core[\\/]/.test(f))
    .concat([path.join(ROOT, "core/memory-core.js")]);
}
function wrap(file) {
  let src = fs.readFileSync(file, "utf8");
  const isTs = file.endsWith(".ts");
  if (isTs) return console.log("skip (TypeScript): " + file);
  const ast = parse(src),
    lines = src.split("\n"),
    edits = [];
  walk.fullAncestor(ast, (node, ancestors) => {
    const parent = ancestors[ancestors.length - 2],
      gp = ancestors[ancestors.length - 3];
    const isStr = node.type === "Literal" && typeof node.value === "string" && AR.test(node.value);
    const isTpl =
      node.type === "TemplateLiteral" &&
      node.quasis.some((q) => AR.test(q.value.cooked)) &&
      !(parent && parent.type === "TaggedTemplateExpression");
    if (!isStr && !isTpl) return;
    if (/i18n-skip/.test(lines[node.loc.start.line - 1])) return;
    if (parent && parent.type === "Property" && parent.key === node) return;
    if (parent && parent.type === "BinaryExpression" && /^[!=]==?$/.test(parent.operator)) return;
    if (parent && parent.type === "CallExpression" && parent.callee.type === "Identifier" && /^(T|require)$/.test(parent.callee.name))
      return;
    if (
      parent &&
      parent.type === "CallExpression" &&
      parent.callee.type === "MemberExpression" &&
      MATCH_METHODS.has(parent.callee.property.name) &&
      parent.arguments.includes(node)
    )
      return;
    if (parent && parent.type === "SwitchCase") return;
    for (const a of ancestors) if (a.type === "VariableDeclarator" && a.id.type === "Identifier" && SKIP_NAMES.has(a.id.name)) return;
    for (const a of ancestors) if (a.type === "Property" && a.key && (a.key.name === "W" || a.key.value === "W")) return;
    edits.push(isStr ? [node.start, node.end, "T(" + src.slice(node.start, node.end) + ")"] : [node.start, node.start, "T"]);
  });
  // innermost first is not needed: string edits never overlap except a T tag before a template that holds wrapped strings
  edits.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  for (const [s, e, t] of edits) src = src.slice(0, s) + t + src.slice(e);
  fs.writeFileSync(file, src);
  console.log(`${path.relative(ROOT, file)}: ${edits.length} wrapped`);
}
function keysIn(src) {
  const ast = parse(src),
    out = [];
  walk.full(ast, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "T" &&
      node.arguments[0] &&
      node.arguments[0].type === "Literal"
    )
      out.push(node.arguments[0].value);
    if (node.type === "TaggedTemplateExpression" && node.tag.type === "Identifier" && node.tag.name === "T")
      out.push(node.quasi.quasis.map((q, i) => q.value.cooked + (i < node.quasi.expressions.length ? `{${i}}` : "")).join(""));
    // tables translated where they are shown (T(TABLE[x])): their Arabic values are keys too
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && TABLES.has(node.id.name) && node.init && node.init.type === "ObjectExpression")
      for (const pr of node.init.properties)
        if (pr.value && pr.value.type === "Literal" && typeof pr.value.value === "string" && AR.test(pr.value.value)) out.push(pr.value.value);
  });
  return out;
}
const TABLES = new Set(["SOURCE_LABEL", "PLATFORMS", "GENERAL_NAMES", "REVIEW_KIND"]);
function keys() {
  const used = new Set();
  for (const f of files()) for (const k of keysIn(fs.readFileSync(f, "utf8"))) used.add(k);
  const html = fs.readFileSync(path.join(ROOT, "extension/src/options.html"), "utf8");
  for (const k of htmlKeys(html)) used.add(k);
  const en = require(path.join(ROOT, "core/i18n-en.js"));
  const missing = [...used].filter((k) => !(k in en)),
    unused = Object.keys(en).filter((k) => !used.has(k));
  return { used: [...used], missing, unused };
}
// the options page: every text node and title/placeholder/aria-label with Arabic (the page translates itself at load)
function htmlKeys(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, "");
  const out = [];
  for (const m of body.matchAll(/>([^<]+)</g)) {
    const t = m[1].replace(/\s+/g, " ").trim();
    if (AR.test(t)) out.push(t);
  }
  for (const m of body.matchAll(/\s(?:title|placeholder|aria-label)="([^"]*)"/g))
    if (AR.test(m[1])) out.push(m[1].replace(/\s+/g, " ").trim());
  return out;
}
const [cmd, ...args] = process.argv.slice(2);
if (cmd === "wrap") for (const f of args) wrap(path.resolve(f));
else if (cmd === "prune") {
  // drop catalog entries no code uses any more (the file is rewritten whole, keys in their order)
  const k = keys(),
    f = path.join(ROOT, "core/i18n-en.js"),
    src = fs.readFileSync(f, "utf8"),
    en = require(f),
    drop = new Set(k.unused);
  const body = Object.entries(en)
    .filter(([key]) => !drop.has(key))
    .map(([key, v]) => `    ${JSON.stringify(key)}: ${JSON.stringify(v)},`)
    .join("\n");
  const start = src.indexOf("{", src.indexOf("const EN")),
    end = src.indexOf("\n  };", start);
  fs.writeFileSync(f, src.slice(0, start + 1) + "\n" + body + src.slice(end));
  console.log(`removed ${drop.size}`);
} else if (cmd === "keys") {
  const k = keys();
  console.log(`used ${k.used.length} · missing ${k.missing.length} · unused ${k.unused.length}`);
  if (args[0] === "--missing") console.log(JSON.stringify(k.missing, null, 1));
  if (args[0] === "--unused") console.log(JSON.stringify(k.unused, null, 1));
  if (args[0] === "--check" && k.missing.length) process.exit(1);
} else console.log("usage: node scripts/i18n.js wrap <files…> | keys [--missing|--unused|--check]");
module.exports = { keysIn, htmlKeys, keys };

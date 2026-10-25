// Builds the release files into dist/: the browser extension as a zip (what the Chrome and Edge stores take),
// and the plugin as a .plugin archive (for installing from a file; the usual route is the GitHub marketplace).
// The versions must agree everywhere, or nothing is built.
"use strict";
const fs = require("fs"),
  path = require("path"),
  { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, ".."),
  DIST = path.join(ROOT, "dist");
const v1 = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin/.claude-plugin/plugin.json"))).version;
const v2 = JSON.parse(fs.readFileSync(path.join(ROOT, "extension/manifest.json"))).version;
if (v1 !== v2) {
  console.error(`version mismatch: plugin ${v1}, extension ${v2}`);
  process.exit(1);
}
execFileSync(process.execPath, [path.join(__dirname, "check-core.js")], { stdio: "inherit" });
fs.mkdirSync(DIST, { recursive: true });
const zip = (cwd, out, ...args) => {
  fs.rmSync(out, { force: true });
  execFileSync("zip", ["-qr", out, ".", "-x", "tests/*", ...args], { cwd });
};
const ext = path.join(DIST, `conversation-memory-extension-${v1}.zip`),
  plug = path.join(DIST, `conversation-memory-${v1}.plugin`);
zip(path.join(ROOT, "extension"), ext);
zip(path.join(ROOT, "plugin"), plug);
for (const f of [ext, plug]) console.log(`${path.basename(f)}  ${(fs.statSync(f).size / 1024).toFixed(1)} KB`);

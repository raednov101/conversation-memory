#!/usr/bin/env node
// The shared core lives in one place (core/memory-core.js) and is copied byte for byte into both packages,
// so each package stays self-contained with no build step. This checks the copies (exit 1 if any differs);
// with --write it refreshes them from the source.
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const source = path.join(root, "core", "memory-core.js");
const copies = [path.join(root, "plugin", "core", "memory-core.js"), path.join(root, "extension", "src", "memory-core.js")];
const want = fs.readFileSync(source);
let bad = 0;
for (const f of copies) {
  const same = fs.existsSync(f) && Buffer.compare(fs.readFileSync(f), want) === 0;
  if (!same && process.argv.includes("--write")) {
    fs.writeFileSync(f, want);
    console.log("updated", path.relative(root, f));
  } else if (!same) {
    bad++;
    console.error("DIFFERS", path.relative(root, f));
  } else console.log("same   ", path.relative(root, f));
}
process.exit(bad ? 1 : 0);

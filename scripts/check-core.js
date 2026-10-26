#!/usr/bin/env node
// The shared core lives in one place (core/: the memory logic and its English catalog) and is copied byte for byte into
// both packages, so each package stays self-contained with no build step. This checks the copies (exit 1 if any
// differs); with --write it refreshes them from the source.
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
let bad = 0;
for (const name of ["memory-core.js", "i18n-en.js"]) {
  const want = fs.readFileSync(path.join(root, "core", name));
  for (const f of [path.join(root, "plugin", "core", name), path.join(root, "extension", "src", name)]) {
    const same = fs.existsSync(f) && Buffer.compare(fs.readFileSync(f), want) === 0;
    if (!same && process.argv.includes("--write")) {
      fs.writeFileSync(f, want);
      console.log("updated", path.relative(root, f));
    } else if (!same) {
      bad++;
      console.error("DIFFERS", path.relative(root, f));
    } else console.log("same   ", path.relative(root, f));
  }
}
process.exit(bad ? 1 : 0);

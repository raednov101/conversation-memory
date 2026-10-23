// Simulates another writer claiming the next pin version between our listing and our write.
// usage: node pin-race.js <projectDir> <pinName>   (stdin: {} ; prints savePin's result as JSON)
"use strict";
const fs = require("fs"), path = require("path");
const [P, name] = process.argv.slice(2);
process.env.CLAUDE_PROJECT_DIR = P;
const d = path.join(P, "CONVERSATION_PINS", name), real = fs.readdirSync;
let once = true;
fs.readdirSync = function (p, ...a) { const r = real.call(fs, p, ...a); if (once && String(p) === d) { once = false; fs.writeFileSync(path.join(d, "v2.md"), "نص كاتب آخر"); } return r; };
const { savePin } = require("../../scripts/lib/store");
process.stdout.write(JSON.stringify(savePin(name, "نصي أنا")));

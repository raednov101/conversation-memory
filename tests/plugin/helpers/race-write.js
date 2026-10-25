// Runs the Stop hook, with a competing writer (playing the browser extension) that replaces the memory file at the
// worst moment: after the hook has read it and built its change, before it writes. usage: node race-write.js <projectDir>
"use strict";
const fs = require("fs"),
  path = require("path");
const P = process.argv[2];
const C = require("../../../plugin/core/memory-core.js");
const real = C.applyDraft;
let once = true;
C.applyDraft = function (m, ...rest) {
  const out = real.call(this, m, ...rest);
  if (once) {
    once = false;
    const cur = C.parseMemory(fs.readFileSync(path.join(P, "CONVERSATION_MEMORY.json"), "utf8")).memory;
    cur.log.push({
      id: "competitor",
      platform: "chatgpt",
      chat: "من الإضافة",
      range: "1–5",
      date: "2026-10-24 10:00",
      raised: ["نقاش من كاتب آخر في اللحظة نفسها"],
      decided: [],
      changed: [],
    });
    cur.summary.goal = "خلاصة الكاتب الآخر";
    const m2 = C.normalizeMemory(cur),
      md = C.render(m2);
    m2.mdHash = C.hash(md);
    fs.writeFileSync(path.join(P, "CONVERSATION_MEMORY.json"), C.serialize(m2));
    fs.writeFileSync(path.join(P, "CONVERSATION_MEMORY.md"), md);
  }
  return out;
};
process.argv = [process.argv[0], path.join(__dirname, "..", "..", "..", "plugin", "scripts", "hook.js"), "stop"];
require("../../../plugin/scripts/hook.js");

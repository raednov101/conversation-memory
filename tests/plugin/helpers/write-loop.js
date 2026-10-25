// Test helper: writes the memory over and over through the real store (lib/store.js) until it is killed.
// Used by the "killed mid-write" test; never shipped to users' projects.
"use strict";
const C = require("../../../plugin/core/memory-core.js");
const { writeMemory } = require("../../../plugin/scripts/lib/store");
const big = "ن".repeat(3000);
for (let i = 0; ; i++) {
  writeMemory((m) => {
    const out = JSON.parse(JSON.stringify(m));
    out.log.push({
      id: `loop-${process.pid}-${i}`,
      platform: "claude-code",
      chat: "",
      range: String(i),
      date: "",
      raised: [big],
      decided: [],
      changed: [],
    });
    out.log = out.log.slice(-40);
    return C.normalizeMemory(out);
  });
}

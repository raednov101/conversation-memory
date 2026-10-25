// Test helper: holds the shared write lock through the real store for argv[2] ms, refreshing it as a slow writer does,
// then releases it. Used by the "slow live holder" test; never shipped to users' projects.
"use strict";
const s = require("../../../plugin/scripts/lib/store");
const until = Date.now() + Number(process.argv[2] || 17000);
if (!s.holdWriteLock(3000)) process.exit(2);
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
while (Date.now() < until) { nap(2000); s.touchWriteLock(); }
s.releaseWriteLock();

// node --test tests/   — what the indicator shows for a given state (pure; no browser)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
globalThis.self = globalThis; globalThis.MemoryCore = require("../src/memory-core.js");
require("../src/page/ui.js");
const { describe } = self.CM.ui;

const T = (h, m) => new Date(2026, 9, 19, h, m).getTime();
const fsSt = { ok: true, folder: "proj", permission: "granted" };
const view = (st, o = {}) => ({ phase: "chat", fsSt, fsOk: true, userCount: 7, st: { summarizedUpTo: 5, status: "ok", attempts: 0, note: "", ...st }, ...o });
const auto = { every: 5, mode: "auto", paused: false }, manual = { every: 5, mode: "manual", paused: false };
const d = (st, set = auto, o) => describe(view(st, o), set, (e) => e, 3);

test("summary updated (✓) shows the time and the estimated cost", () => {
  const r = d({ lastSave: T(14, 5), rawAt: T(14, 4), lastCost: { req: 1200, rep: 600 } });
  assert.equal(r.text, "🧠 2/5 · ✓ 14:05 · ≈600 توكن"); assert.equal(r.cls, "ok");
  assert.match(r.info, /الطلب 1,200 حرفاً والرد 600 ≈ 600 توكن/);
});
test("text saved after the last summary (📝) is a different state with its own colour", () => {
  const r = d({ lastSave: T(14, 5), rawAt: T(14, 9), lastCost: { req: 1200, rep: 600 } });
  assert.equal(r.text, "🧠 2/5 · 📝 14:09"); assert.equal(r.cls, "txt");
  assert.match(r.info, /النص الكامل محفوظ 14:09/); assert.match(r.info, /آخر تحديث للملخص 14:05/);
});
test("failure (⚠️) wins over both, with the reason", () => {
  const r = d({ lastSave: T(14, 5), rawAt: T(14, 9), status: "error", error: "لم يصل الرد", attempts: 1 });
  assert.equal(r.text, "🧠 ⚠️ 2/5 · تعثّر الحفظ"); assert.equal(r.cls, "err"); assert.match(r.info, /لم يصل الرد/);
});
test("manual mode: count of waiting messages, no automatic promise, the button stays", () => {
  const r = d({ lastSave: T(14, 5) }, manual);
  assert.equal(r.text, "🧠 2 · يدوي · ✓ 14:05");
  assert.match(r.info, /الوضع اليدوي/); assert.ok(r.btns.some(([, a]) => a === "summarize")); assert.ok(!r.btns.some(([, a]) => a === "pause"));
});
test("the share button is offered wherever the folder is ready, never without one", () => {
  assert.ok(d({}).btns.some(([, a]) => a === "share"));
  assert.ok(describe({ phase: "new", fsSt, fsOk: true }, auto, (e) => e, 3).btns.some(([, a]) => a === "share"));
  assert.ok(!describe({ phase: "nofolder", fsSt: { ok: true, folder: null }, fsOk: false }, auto, (e) => e, 3).btns.some(([, a]) => a === "share"));
});
test("after the extension is updated, an open page asks to be refreshed instead of asking for a folder", () => {
  const r = describe({ phase: "new", fsSt: { ok: false, error: "inactive" }, fsOk: false }, auto, (e) => (e === "inactive" ? "حدّث الصفحة" : e), 3);
  assert.equal(r.text, "🧠 🔄 حدّث الصفحة"); assert.ok(!r.btns.length, "no folder button");
});

// The history: every change recorded with what made it and why, and one change undone without touching the others.
"use strict";
process.env.CONV_MEMORY_LANG = process.env.CONV_MEMORY_LANG || "ar";
const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv2020 = require("ajv/dist/2020");
const C = require("../core/memory-core.js");
const valid = new Ajv2020({ strict: false }).compile(require("../docs/schema/conversation-memory-1.schema.json"));

// a writer's cycle in miniature: mutate, then record what changed (as both writers do in writeMemory)
const write = (m, mutate, meta) => C.withHistory(m, mutate(JSON.parse(JSON.stringify(m))), { at: "2026-10-26 10:00", ...meta });
const ev = (m) => m.history[m.history.length - 1];
function story() {
  let m = C.emptyMemory("مقهى");
  const turns = [
    { role: "user", text: "نعتمد اللون الأزرق الداكن للهوية، والميزانية 40 ألف ريال" },
    { role: "assistant", text: "تمام. أقترح خط الكوفي للشعار." },
  ];
  const evidence = { user: turns[0].text, all: turns.map((t) => t.text).join("\n"), turns };
  const draft = C.validateDraft({
    batch: "ext-a-1-2-aaaa",
    summary: { goal: "هوية مقهى", status: "اعتُمد اللون" },
    decisions: {
      add: [
        { text: "اللون الأزرق الداكن للهوية", source: "user", quote: "نعتمد اللون الأزرق الداكن للهوية" },
        { text: "خط الكوفي للشعار", source: "user", quote: "خط الكوفي للشعار" }, // the model's idea, claimed as the user's
      ],
      revoke: [],
    },
    constraints: { add: [{ text: "الميزانية 40 ألف ريال", quote: "والميزانية 40 ألف ريال" }], remove: [] },
    entry: { raised: ["نقاش الهوية البصرية للمقهى: اللون والخط والميزانية"] },
  }).draft;
  m = write(m, (x) => C.applyDraft(x, draft, { date: "2026-10-26", evidence, allowSummary: true }).memory, {
    by: "summary",
    ref: draft.batch,
    why: "ملخص الرسائل 1–2",
  });
  return m;
}

test("history: a summary records each decision, constraint and the summary itself, with what made it", () => {
  const m = story();
  assert.deepEqual(
    m.history.map((e) => [e.kind, e.target]),
    [
      ["decision.add", "d1"],
      ["decision.add", "d2"],
      ["constraint.add", "الميزانية 40 ألف ريال"],
      ["summary", "summary"],
    ],
  );
  assert.ok(m.history.every((e) => e.by === "summary" && e.ref === "ext-a-1-2-aaaa" && e.why === "ملخص الرسائل 1–2"));
  assert.equal(m.history[1].after.unverified, true, "the event keeps how it was saved: d2 as a suggestion waiting for review");
  assert.ok(valid(JSON.parse(C.serialize(m))), "the file with its history matches the schema");
});

test("history: the review and a correction are recorded; one change is undone and the others stay", () => {
  let m = story();
  const fix = (f, meta) => (m = write(m, (x) => C.applyFix(x, C.validateFix(f).fix, "2026-10-26").memory, meta));
  fix({ pending: { approve: ["d2"] } }, { by: "review", ref: "d2", why: "وافقتَ عليه في المراجعة" });
  assert.deepEqual(
    m.history.slice(-2).map((e) => e.kind),
    ["decision.verify", "decision.confirm"],
    "approving makes it yours and marks it confirmed",
  );
  fix({ decisions: { edit: [{ id: "d1", text: "اللون الكحلي للهوية" }] } }, { by: "fix" });
  assert.equal(ev(m).kind, "decision.edit");
  assert.equal(ev(m).before, "اللون الأزرق الداكن للهوية");
  const editId = ev(m).id,
    verifyId = m.history.find((e) => e.kind === "decision.verify").id;
  // undo the approval of d2 only: d1's correction stays
  const u = C.undoEvent(m, verifyId, "2026-10-26");
  assert.ok(u.ok, u.error);
  m = C.withHistory(m, u.memory, { by: "undo", ref: verifyId, undoes: verifyId });
  const d = (id) => m.decisions.find((x) => x.id === id);
  assert.equal(d("d2").unverified, true, "d2 is a suggestion again");
  assert.equal(d("d2").claimed, "user", "…still claiming what it claimed, for a later review");
  assert.equal(d("d1").text, "اللون الكحلي للهوية", "the other change stays");
  assert.ok(
    C.reviewItems(m).some((x) => x.key === "d2"),
    "and it is back in «Review decisions»",
  );
  assert.equal(ev(m).undoes, verifyId);
  // undo the correction: the old text, and its confirmation is not carried over
  m = C.withHistory(m, C.undoEvent(m, editId, "2026-10-26").memory, { by: "undo", ref: editId, undoes: editId });
  assert.equal(d("d1").text, "اللون الأزرق الداكن للهوية");
  assert.ok(valid(JSON.parse(C.serialize(m))));
});

test("history: an undo is refused when the same thing changed again since, and an undo can itself be undone", () => {
  let m = story();
  m = write(m, (x) => ((x.decisions[0].status = "revoked"), x), { by: "summary", ref: "b2" });
  const revokeId = ev(m).id;
  const addId = m.history.find((e) => e.kind === "decision.add" && e.target === "d1").id;
  const r = C.undoEvent(m, addId, "2026-10-26");
  assert.ok(!r.ok && r.error.includes(revokeId), "adding d1 can't be undone while its later cancellation stands");
  m = C.withHistory(m, C.undoEvent(m, revokeId).memory, { by: "undo", ref: revokeId, undoes: revokeId });
  assert.equal(m.decisions[0].status, "active", "the cancellation undone: d1 is back");
  const undoId = ev(m).id;
  m = C.withHistory(m, C.undoEvent(m, undoId, "2026-10-26").memory, { by: "undo", ref: undoId, undoes: undoId });
  assert.equal(m.decisions[0].status, "revoked", "…and undoing the undo cancels it again");
  assert.ok(!C.undoEvent(m, "e999").ok, "an unknown number is refused");
});

test("history: a restore keeps the story and records what it changed; constraints and summary undo cleanly", () => {
  const before = story();
  let m = write(before, (x) => ((x.constraints = []), (x.summary.goal = "هوية وقائمة طعام"), x), { by: "summary", ref: "b2" });
  // restoring the older file: its history is older, but the current one continues
  m = C.withHistory(m, before, { by: "restore", ref: "20261026-100000-000.json" });
  assert.ok(m.history.length > before.history.length + 2, "nothing of the story is lost by going back");
  assert.deepEqual(
    m.history.slice(-2).map((e) => [e.by, e.kind]),
    [
      ["restore", "constraint.add"],
      ["restore", "summary"],
    ],
  );
  const s = m.history.slice(-1)[0];
  m = C.withHistory(m, C.undoEvent(m, s.id).memory, { by: "undo", ref: s.id, undoes: s.id });
  assert.equal(m.summary.goal, "هوية وقائمة طعام", "undoing the restore of the summary brings back the newer one");
});

test("history: bounded, and garbage in a hand-edited file is dropped, not trusted", () => {
  let m = C.emptyMemory();
  for (let i = 0; i < 450; i++) m = write(m, (x) => ((x.constraints = [`قيد ${i}`]), x), { by: "fix" });
  assert.equal(m.history.length, 400, "the newest 400 are kept");
  assert.equal(ev(m).id, "e899", "ids keep counting after the oldest are dropped (1 + 449 × 2 events)");
  const n = C.normalizeMemory({
    history: [
      { id: "e1", kind: "decision.add", target: "d1", before: null, after: { text: "x", evil: { nested: 1 } } },
      { id: "x2", kind: "decision.add" },
      { id: "e3", kind: "rm -rf" },
      { id: "e4", kind: "summary", by: "hacker", before: [1, 2], after: "y" },
    ],
  });
  assert.deepEqual(
    n.history.map((e) => e.id),
    ["e1", "e4"],
  );
  assert.equal(n.history[0].after.evil, "[object Object]", "nested values are flattened to text");
  assert.equal(n.history[1].by, "write");
  assert.equal(n.history[1].before, null);
  assert.ok(valid(JSON.parse(C.serialize(n))));
});

test("history: described in words, in the interface's language", () => {
  const m = story();
  const d = C.describeEvent(m.history[0]);
  assert.match(d.what, /أُضيف قرار: «اللون الأزرق الداكن للهوية»/);
  C.setLang("en");
  try {
    assert.match(C.describeEvent(m.history[0]).what, /^Decision added: “/);
  } finally {
    C.setLang("ar");
  }
});

test("history: a file near the size limit moves the oldest events to the archive instead of refusing to save", () => {
  let m = C.normalizeMemory({ summary: { goal: "ن".repeat(1900), status: "س".repeat(1900) } });
  for (let i = 0; i < 300; i++) m = write(m, (x) => ((x.summary.goal = `${i} ` + "ن".repeat(1900)), x), { by: "summary" });
  const t = C.trimForSize(m, 1536 * 1024);
  assert.ok(t.fits, "it fits");
  assert.ok(
    t.archived.some((x) => x.id === "history" && x.events.length),
    "old events archived",
  );
  assert.equal(t.memory.archived, 0, "the count of archived summaries is not inflated by them");
});

test("relevance: a task picks the decisions, pins and log entries about it; summary and constraints always come", () => {
  const m = C.normalizeMemory({
    summary: { goal: "افتتاح مقهى" },
    constraints: ["الميزانية 40 ألف"],
    decisions: [
      { id: "d1", text: "موعد الافتتاح 15 نوفمبر", quote: "الافتتاح 15 نوفمبر" },
      { id: "d2", text: "مكان الافتتاح حديقة المبنى", quote: "في الحديقة" },
      { id: "d3", text: "خط الكوفي للشعار", quote: "الكوفي للشعار" },
      { id: "d4", text: "دعوة الافتتاح باللونين الأزرق والذهبي", quote: "الدعوة أزرق وذهبي", status: "revoked" },
    ],
    pins: [{ name: "نص دعوة الافتتاح", version: 1 }],
    log: [
      { id: "b1", raised: ["نقاش الشعار والخطوط"] },
      { id: "b2", raised: ["تجهيز دعوة الافتتاح وقائمة الضيوف"] },
    ],
  });
  const s = C.relevant(m, "أكتب دعوة الافتتاح");
  assert.equal(s.summary, true);
  assert.equal(s.constraints, true);
  assert.deepEqual(s.decisions.sort(), ["d1", "d2"], "the opening's date and place; not the logo font, not a revoked decision");
  assert.deepEqual(s.pins, ["نص دعوة الافتتاح"]);
  assert.deepEqual(s.log, ["b2"]);
  assert.deepEqual(C.relevant(m, "").decisions, [], "nothing typed: nothing picked beyond the summary");
});

test("split: the shared memory of earlier versions, chat by chat — by batch, or by a quote found in that chat's text", () => {
  const m = C.normalizeMemory({
    constraints: ["قيد عام"],
    decisions: [
      { id: "d1", text: "قرار بدفعته", quote: "قرار بدفعته", batch: "ext-chatgpt-aaaaaaaa-bbbb-cccc-1-5-x1" },
      { id: "d2", text: "قرار قديم بلا دفعة", quote: "نعتمد الخط الكوفي" }, // saved before decisions recorded their batch
      { id: "d3", text: "قرار من محادثة أخرى", quote: "شيء آخر تماماً", batch: "api-chatgpt-zzzz-1-5-x2" },
    ],
    log: [
      { id: "ext-chatgpt-aaaaaaaa-bbbb-cccc-1-5-x1", chat: "الهوية", raised: ["الهوية"] },
      { id: "api-chatgpt-zzzz-1-5-x2", chat: "الرحلة", raised: ["الرحلة"] },
    ],
  });
  const key = "chatgpt-aaaaaaaa-bbbb-cccc-dddd-eeee"; // longer than the 24 characters a batch keeps
  const tx = { [key]: "### رسالتك\nنعتمد الخط الكوفي للشعار" };
  const plan = C.splitShared(m, undefined, tx).groups;
  assert.deepEqual(
    plan.map((g) => [g.key, g.label, g.entries, g.decisions]).sort(),
    [
      [key, "الهوية", 1, 2],
      ["chatgpt-zzzz", "الرحلة", 1, 1],
    ].sort(),
    "the whole key comes from the saved text's name",
  );
  const r = C.splitShared(m, key, tx);
  assert.deepEqual(
    r.moved.decisions.map((d) => d.id),
    ["d1", "d2"],
  );
  assert.deepEqual(r.moved.constraints, ["قيد عام"]);
  assert.deepEqual(
    r.kept.decisions.map((d) => d.id),
    ["d3"],
  );
  assert.deepEqual(
    r.kept.log.map((e) => e.chat),
    ["الرحلة"],
  );
});

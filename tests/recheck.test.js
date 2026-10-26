// Editing a message: the decisions a chat gave from that message on are checked again against the edited conversation.
"use strict";
process.env.CONV_MEMORY_LANG = process.env.CONV_MEMORY_LANG || "ar";
const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv2020 = require("ajv/dist/2020");
const C = require("../core/memory-core.js");
const valid = new Ajv2020({ strict: false }).compile(require("../docs/schema/conversation-memory-1.schema.json"));

const conv = (texts) => {
  const turns = texts.flatMap((t, i) => [
    { role: "user", text: t, n: i + 1 },
    { role: "assistant", text: `تمام، ${i + 1}` },
  ]);
  return { user: texts.join("\n"), all: turns.map((x) => x.text).join("\n"), turns };
};
function memory() {
  const before = conv(["نبدأ هوية المقهى", "نعتمد الخط الكوفي للشعار", "والميزانية 40 ألف ريال للهوية كاملة", "نكمل غداً"]);
  const draft = C.validateDraft({
    batch: "ext-c-abc-1-4-aaaa",
    decisions: {
      add: [
        { text: "الخط الكوفي للشعار", source: "user", quote: "نعتمد الخط الكوفي للشعار" },
        { text: "ميزانية الهوية 40 ألف ريال", source: "user", quote: "والميزانية 40 ألف ريال للهوية كاملة" },
      ],
      revoke: [],
    },
    entry: { raised: ["نقاش هوية المقهى: الخط والميزانية في هذه الرسائل"] },
  }).draft;
  let m = C.applyDraft(C.emptyMemory(), draft, { date: "2026-10-26", evidence: before }).memory;
  // a decision from another chat with the same words must not be touched
  m.decisions.push({
    id: "d9",
    text: "قرار من محادثة أخرى",
    source: "user",
    quote: "قرار من محادثة أخرى",
    status: "active",
    batch: "ext-c-other-1-5-bbbb",
    msg: 3,
  });
  return C.normalizeMemory(m);
}

test("recheck: decisions remember the batch (and so the chat) that added them", () => {
  const m = memory();
  assert.deepEqual(
    m.decisions.map((d) => [d.id, d.batch, d.msg, d.unverified]),
    [
      ["d1", "ext-c-abc-1-4-aaaa", 2, false],
      ["d2", "ext-c-abc-1-4-aaaa", 3, false],
      ["d9", "ext-c-other-1-5-bbbb", 3, false],
    ],
  );
});

test("recheck: after an edit, only this chat's decisions from that message on whose words are gone are marked", () => {
  const edited = conv(["نبدأ هوية المقهى", "نعتمد الخط الكوفي للشعار", "نفكر في الميزانية لاحقاً", "نكمل غداً"]);
  const r = C.recheckDecisions(memory(), { chatKey: "c-abc", from: 3, evidence: edited, date: "2026-10-26 12:00" });
  assert.deepEqual(r.flagged, ["d2"], "message 3 no longer says the budget; message 2 is before the edit");
  const d = (id) => r.memory.decisions.find((x) => x.id === id);
  assert.equal(d("d2").status, "active", "still in force until you decide");
  assert.match(d("d2").recheck.reason, /عدّلتَ رسالتك رقم 3/);
  assert.ok(!d("d1").recheck && !d("d9").recheck);
  assert.ok(C.reviewItems(r.memory).some((x) => x.key === "r-d2" && x.kind === "recheck"));
  assert.ok(valid(JSON.parse(C.serialize(r.memory))));
});

test("recheck: a decision still backed elsewhere keeps going, with its new message number", () => {
  // the budget sentence moved from message 3 to message 4 in the edit
  const edited = conv(["نبدأ هوية المقهى", "نعتمد الخط الكوفي للشعار", "سؤال جانبي", "والميزانية 40 ألف ريال للهوية كاملة"]);
  const r = C.recheckDecisions(memory(), { chatKey: "c-abc", from: 3, evidence: edited, date: "2026-10-26" });
  assert.deepEqual(r.flagged, []);
  assert.equal(r.memory.decisions.find((x) => x.id === "d2").msg, 4);
});

test("recheck: «still holds» clears the mark, «cancel it» revokes; both are recorded in the history", () => {
  const edited = conv(["نبدأ هوية المقهى", "نفكر في خط آخر", "نفكر في الميزانية لاحقاً", "نكمل غداً"]);
  let m = C.recheckDecisions(memory(), { chatKey: "c-abc", from: 2, evidence: edited, date: "2026-10-26" }).memory;
  assert.deepEqual(
    C.reviewItems(m).map((x) => x.key),
    ["r-d1", "r-d2"],
  );
  const fix = C.validateFix({ pending: { approve: ["r-d1"], reject: ["r-d2"] } });
  assert.ok(fix.ok);
  const after = C.withHistory(m, C.applyFix(m, fix.fix, "2026-10-26").memory, { by: "review" });
  const d = (id) => after.decisions.find((x) => x.id === id);
  assert.equal(d("d1").status, "active");
  assert.ok(!d("d1").recheck);
  assert.equal(d("d2").status, "revoked");
  assert.deepEqual(
    after.history.map((e) => [e.kind, e.target]),
    [["decision.revoke", "d2"]],
  );
});

test("recheck: nothing to check without the conversation or the chat, and a decision without a batch is left alone", () => {
  const m = memory();
  assert.deepEqual(C.recheckDecisions(m, { chatKey: "", from: 1, evidence: conv(["x"]) }).flagged, []);
  assert.deepEqual(C.recheckDecisions(m, { chatKey: "c-abc", from: 1, evidence: null }).flagged, []);
  const old = C.normalizeMemory({ decisions: [{ id: "d1", text: "قرار قديم", quote: "قرار قديم", msg: 2 }] });
  assert.deepEqual(C.recheckDecisions(old, { chatKey: "c-abc", from: 1, evidence: conv(["شيء آخر"]) }).flagged, []);
});

// Regressions from the independent review of 2.0: each case once let something wrong through.
"use strict";
process.env.CONV_MEMORY_LANG = process.env.CONV_MEMORY_LANG || "ar";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../core/memory-core.js");

const ev = (pairs) => {
  const turns = pairs.map(([role, text]) => ({ role, text }));
  return {
    user: turns
      .filter((t) => t.role === "user")
      .map((t) => t.text)
      .join("\n"),
    all: turns.map((t) => t.text).join("\n"),
    turns,
  };
};
const decide = (e, add, mem) =>
  C.applyDraft(
    mem || C.emptyMemory(),
    C.validateDraft({
      batch: "b-" + Math.random().toString(36).slice(2),
      decisions: { add, revoke: [] },
      entry: { raised: ["نقاش اختبار لمراجعة الإصدار الثاني من الذاكرة"] },
    }).draft,
    {
      date: "2026-10-26",
      evidence: e,
    },
  );
const held = (r) => r.memory.decisions[r.memory.decisions.length - 1].unverified === true;

test("review: «only X» does not back «Y only, not X»; «don't use red» does not back «blue instead of red»", () => {
  assert.ok(
    held(
      decide(ev([["user", "Publish it in the newsletter only"]]), [
        { text: "Post the article on the blog only, not the newsletter", source: "user", quote: "in the newsletter only" },
      ]),
    ),
  );
  assert.ok(
    held(
      decide(ev([["user", "النشر في النشرة البريدية فقط"]]), [
        { text: "النشر في المدونة فقط دون النشرة البريدية", source: "user", quote: "النشر في النشرة البريدية فقط" },
      ]),
    ),
  );
  assert.ok(
    held(
      decide(ev([["user", "Don't use the red theme."]]), [
        { text: "Use the blue theme instead of the red one", source: "user", quote: "Don't use the red theme." },
      ]),
    ),
  );
  assert.ok(
    held(
      decide(ev([["user", "لا تستخدم اللون الأحمر"]]), [
        { text: "نستخدم اللون الأزرق بدل الأحمر", source: "user", quote: "لا تستخدم اللون الأحمر" },
      ]),
    ),
  );
  // …while the real same choices still pass
  assert.ok(
    !held(
      decide(ev([["user", "خلي العزومة بالبيت مو بالمطعم"]]), [
        { text: "إقامة العزومة في البيت بدل المطعم", source: "user", quote: "خلي العزومة بالبيت مو بالمطعم" },
      ]),
    ),
  );
  assert.ok(
    !held(
      decide(ev([["user", "Scrap income, keep age and gender."]]), [
        { text: "Demographics section asks only age and gender, no income", source: "user", quote: "Scrap income, keep age and gender." },
      ]),
    ),
  );
});

test("review: a one-word approval must be a whole word («ok» is not in «look», «اي» is not in «النهائي»)", () => {
  const e = ev([
    ["user", "Which database?"],
    ["assistant", "I suggest PostgreSQL for the data."],
    ["user", "Hmm, let me look into the pricing first."],
  ]);
  assert.ok(held(decide(e, [{ text: "Use PostgreSQL for the data", source: "assistant-approved", quote: "ok" }])));
  const a = ev([
    ["user", "وين نستضيف؟"],
    ["assistant", "أقترح الاستضافة على Hetzner"],
    ["user", "كم السعر النهائي للاستضافة"],
  ]);
  assert.ok(held(decide(a, [{ text: "الاستضافة على Hetzner", source: "assistant-approved", quote: "اي" }])));
});

test("review: month names and days inside other words are not dates («decide» ≠ December, «أحد» ≠ Sunday)", () => {
  assert.ok(
    held(
      decide(ev([["user", "The team will have engineers we decide on later."]]), [
        { text: "The team will have 12 engineers", source: "user", quote: "The team will have engineers" },
      ]),
    ),
  );
  assert.ok(
    held(
      decide(ev([["user", "خل أحد من الفريق يحجز القاعة يوم الاثنين"]]), [
        { text: "حجز القاعة يوم الأحد", source: "user", quote: "خل أحد من الفريق يحجز القاعة يوم الاثنين" },
      ]),
    ),
  );
});

test("review: undo never acts on another decision that got the same id; a removal is recorded and can be undone", () => {
  let m = C.normalizeMemory({ decisions: [{ id: "d1", text: "Host on Vercel", quote: "x" }] });
  const add = C.withHistory(C.emptyMemory(), m, { by: "summary" });
  const e1 = add.history[0].id;
  // a writer without history removes d1 and reuses the id
  const reused = C.normalizeMemory({ ...add, decisions: [{ id: "d1", text: "Budget is 500 USD", quote: "y" }] });
  assert.ok(!C.undoEvent(reused, e1).ok, "the undo of «add Host on Vercel» does not revoke the budget");
  // removed through a writer that records it
  const removed = C.withHistory(add, { ...add, decisions: [] }, { by: "fix" });
  const rm = removed.history[removed.history.length - 1];
  assert.equal(rm.kind, "decision.remove");
  const back = C.undoEvent(removed, rm.id, "2026-10-26");
  assert.ok(back.ok && back.memory.decisions[0].text === "Host on Vercel");
});

test("review: splitting by quote uses only the chat's own messages, three words or more, found in one chat only", () => {
  const m = C.normalizeMemory({
    decisions: [
      { id: "d1", text: "Use PostgreSQL", quote: "yes ok" },
      { id: "d2", text: "Fly to Rome on Friday", quote: "we fly to Rome on Friday" },
    ],
    log: [
      { id: "ext-chatgpt-trip0000000000000000-1-5-a1", chat: "Trip" },
      { id: "ext-chatgpt-code0000000000000000-1-5-a2", chat: "Code" },
    ],
  });
  const tx = {
    "chatgpt-trip00000000000000000000000000": "yes ok\nwe fly to Rome on Friday",
    "chatgpt-code00000000000000000000000000": "yes ok",
  };
  const r = C.splitShared(m, "chatgpt-trip00000000000000000000000000", tx);
  assert.deepEqual(
    r.moved.decisions.map((d) => d.id),
    ["d2"],
    "«yes ok» (two words, in both chats) stays where it is",
  );
});

test("review: after a 1.4 write the batch and the recheck mark come back too", () => {
  const v1 = C.normalizeMemory({
    decisions: [{ id: "d1", text: "x", quote: "x", batch: "ext-a-1-5-b", recheck: { date: "d", from: 2, reason: "r" } }],
  });
  const v2 = C.normalizeMemory({ decisions: [{ id: "d1", text: "x", quote: "x" }] });
  const m = C.recoverDropped(v2, v1).memory;
  assert.equal(m.decisions[0].batch, "ext-a-1-5-b");
  assert.equal(m.decisions[0].recheck.from, 2);
});

test("review: a huge pasted message does not stall the checks", () => {
  const big = "عمود1,عمود2,عمود3\n".repeat(60000) + "نعتمد الخط الكوفي للشعار يوم الأحد";
  const e = ev([["user", big]]);
  const add = Array.from({ length: 20 }, (_, i) => ({
    text: `الخط الكوفي للشعار ${i % 2 ? "" : ""}يوم الأحد`,
    source: "user",
    quote: "نعتمد الخط الكوفي للشعار",
  }));
  const t = Date.now();
  decide(e, add);
  assert.ok(Date.now() - t < 8000, `took ${Date.now() - t} ms`);
});

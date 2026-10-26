// Version 1.4.0 of the extension may stay installed for a while after 2.0 ships (store updates take hours to reach
// everyone, and someone can share a folder between an old extension and a new plugin). This runs the real 1.4 core
// (tests/fixtures/memory-core-1.4.js) over files written by 2.0 and proves:
//   1. what 1.4 drops is never a decision or a constraint, and nothing becomes «yours» that wasn't;
//   2. the next 2.0 write brings back what it dropped, from the version 2.0 saved before it (the backups).
"use strict";
process.env.CONV_MEMORY_LANG = process.env.CONV_MEMORY_LANG || "ar";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../core/memory-core.js");
const OLD = require("./fixtures/memory-core-1.4.js");

const rich = () =>
  C.normalizeMemory({
    title: "Coffee shop",
    lang: "en",
    summary: { goal: "Brand identity", status: "colour chosen" },
    decisions: [
      { id: "d1", text: "Dark blue is the brand colour", source: "user", quote: "let's go with dark blue", msg: 3, confirmed: true },
      {
        id: "d2",
        text: "Launch in March",
        source: "user",
        quote: "we launch in March",
        msg: 5,
        pendingRevoke: { date: "2026-10-26", reason: "suggested without your words", quote: "" },
      },
      {
        id: "d3",
        text: "Use the Kufi font",
        source: "assistant",
        quote: "Kufi?",
        unverified: true,
        claimed: "user",
        pendingReplaces: "d1",
      },
      { id: "d4", text: "Old slogan", source: "user", status: "revoked", revokedOn: "2026-10-20", quote: "use the old slogan" },
    ],
    constraints: ["Budget 40,000", "No red"],
    pending: {
      constraints: {
        add: [{ text: "Arabic first", reason: "no words", date: "2026-10-26", quote: "" }],
        remove: [{ text: "No red", reason: "no words", date: "2026-10-26", quote: "" }],
      },
    },
    log: [{ id: "ext-a-1-5-aaaa", platform: "chatgpt", range: "1–5", raised: ["Brand colours and fonts were discussed today"] }],
    reviewedBy: { someone: "a field a later version added" },
  });

// one summary saved by 1.4 into the file 2.0 wrote
function writeWith14(fileText) {
  const p = OLD.parseMemory(fileText);
  assert.ok(p.ok, "1.4 reads a 2.0 file");
  const v = OLD.validateDraft(
    {
      batch: "ext-b-6-10-bbbb",
      summary: { goal: "Brand identity", status: "menu next" },
      decisions: { add: [{ text: "Menu has 12 items", source: "user", quote: "the menu has 12 items" }], revoke: [] },
      entry: { raised: ["The menu size was discussed in these messages"] },
    },
    "ext-b-6-10-bbbb",
  );
  assert.ok(v.ok, v.error);
  const ev = { user: "the menu has 12 items", all: "the menu has 12 items" };
  const r = OLD.applyDraft(p.memory, v.draft, {
    platform: "chatgpt",
    chat: "x",
    range: "6–10",
    date: "2026-10-26 11:00",
    allowSummary: true,
    evidence: ev,
  });
  assert.ok(r.applied);
  return OLD.serialize(r.memory);
}

test("1.4 over a 2.0 file: no decision or constraint lost, nothing revoked comes back, no suggestion becomes yours", () => {
  const v1 = rich(),
    v2text = writeWith14(C.serialize(v1)),
    v2 = C.parseMemory(v2text).memory;
  for (const d of v1.decisions) {
    const e = v2.decisions.find((x) => x.id === d.id);
    assert.ok(e, `${d.id} kept`);
    assert.equal(e.text, d.text);
    assert.equal(e.status, d.status, `${d.id} keeps its status`);
    assert.equal(e.unverified, d.unverified, `${d.id} keeps its review mark`);
    assert.equal(e.source, d.source);
  }
  assert.deepEqual(v2.constraints, v1.constraints, "the constraints are the same (a removal waiting for you is not applied)");
  assert.ok(
    v2.decisions.some((d) => d.text === "Menu has 12 items" && !d.unverified),
    "1.4's own summary is saved",
  );
  // what it does drop — all marks, never content
  assert.ok(C.droppedByOlder(v2text), "the file shows an older writer rewrote it");
  assert.equal(v2.lang, "ar", "read without its language field, the file falls back to Arabic");
  assert.ok(
    !v2.decisions.find((d) => d.id === "d2").pendingRevoke,
    "1.4 drops a cancellation waiting for you (the decision stays in force: the safe side)",
  );
  assert.equal(v2.pending.constraints.add.length + v2.pending.constraints.remove.length, 0, "…and waiting constraint changes");
});

test("the next 2.0 write brings back what 1.4 dropped, from the version 2.0 saved", () => {
  const v1 = rich(),
    v2 = C.parseMemory(writeWith14(C.serialize(v1))).memory;
  const r = C.recoverDropped(v2, v1);
  const m = r.memory;
  assert.ok(r.restored >= 7, `restored ${r.restored}`);
  assert.equal(m.lang, "en");
  assert.deepEqual(m.reviewedBy, v1.reviewedBy, "a field a later version added comes back");
  const d = (id) => m.decisions.find((x) => x.id === id);
  assert.equal(d("d1").confirmed, true, "your approval mark");
  assert.equal(d("d1").msg, 3, "the message number");
  assert.equal(d("d2").pendingRevoke.reason, "suggested without your words", "the cancellation waiting for you");
  assert.deepEqual(
    m.pending.constraints.add.map((x) => x.text).concat(m.pending.constraints.remove.map((x) => x.text)),
    ["Arabic first", "No red"],
    "the constraint changes waiting for you",
  );
  assert.ok(
    m.decisions.some((x) => x.text === "Menu has 12 items"),
    "what 1.4 saved meanwhile stays",
  );
  assert.ok(
    C.reviewItems(m).some((x) => x.key === "x-d2"),
    "and they are back in «Review decisions»",
  );
});

test("recovery never overrides what happened after: a decision revoked or edited since keeps its new state", () => {
  const v1 = rich(),
    v2 = C.parseMemory(writeWith14(C.serialize(v1))).memory;
  const d2 = v2.decisions.find((x) => x.id === "d2");
  d2.status = "revoked"; // you cancelled it meanwhile (in 1.4)
  v2.decisions.find((x) => x.id === "d1").text = "Navy blue is the brand colour"; // and corrected d1's text
  v2.constraints = v2.constraints.filter((c) => c !== "No red"); // and removed the constraint yourself
  const m = C.recoverDropped(v2, v1).memory;
  assert.ok(!m.decisions.find((x) => x.id === "d2").pendingRevoke, "no waiting cancellation on a revoked decision");
  assert.ok(!m.decisions.find((x) => x.id === "d1").confirmed, "an approval of the old text does not carry to the corrected one");
  assert.ok(!m.pending.constraints.remove.some((x) => x.text === "No red"), "no waiting removal of a constraint already gone");
});

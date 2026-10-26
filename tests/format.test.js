// The published file format (docs/FORMAT.md, docs/schema/conversation-memory-1.schema.json) against what the shared core
// really writes: every memory produced on the way through 100 conversations — summaries applied, reviews approved and
// rejected, pins, corrections, trimming — must match the schema, and the schema must refuse what the core never writes.
"use strict";
process.env.CONV_MEMORY_LANG = process.env.CONV_MEMORY_LANG || "ar";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Ajv2020 = require("ajv/dist/2020");
const C = require("../core/memory-core.js");
const schema = require("../docs/schema/conversation-memory-1.schema.json");
const cases = require("./eval/dev.json");

const ajv = new Ajv2020({ allErrors: true, strict: false });
const valid = ajv.compile(schema);
// what a writer puts on disk: serialize → parse back (the file, not the object in memory)
const onDisk = (m) => JSON.parse(C.serialize(m));
const check = (m, where) => {
  const f = onDisk(m);
  assert.ok(valid(f), `${where}: ${ajv.errorsText(valid.errors, { separator: "\n  " })}`);
  return f;
};

test("format: an empty memory and anything normalized (hand-edited, partial, garbage) match the schema", () => {
  check(C.emptyMemory(), "empty");
  for (const input of [
    {},
    null,
    { decisions: [{ text: "x", id: "d9" }, { text: "y", id: "d9" }, { text: "" }, "z"], constraints: ["a", "a", 3] },
    {
      summary: { goal: 5, next: "x" },
      log: [{ id: "b-1", platform: "elsewhere", raised: [1, "ok"] }],
      pins: [{ name: "../x", version: 2 }],
    },
    {
      pins: [{ name: "خطة", version: "3", sha: "nothex" }],
      imported: { text: "قديم" },
      archived: -4,
      lang: "fr",
      format: "conversation-memory/1",
    },
    { decisions: [{ text: "x", unverified: true, confirmed: true, claimed: "user", pendingReplaces: "d1" }] },
    { decisions: [{ text: "x", status: "revoked", pendingRevoke: { reason: "r" } }], futureField: { anything: [1, 2] } },
  ])
    check(C.normalizeMemory(input), JSON.stringify(input).slice(0, 60));
});

test("format: every memory written through 100 conversations matches the schema", () => {
  let n = 0;
  for (const k of cases) {
    const ev = {
      user: k.turns
        .filter((t) => t.role === "user")
        .map((t) => t.text)
        .join("\n"),
      all: k.turns.map((t) => t.text).join("\n"),
      turns: k.turns.map((t) => ({ role: t.role, text: t.text })),
    };
    let m = C.normalizeMemory({
      decisions: k.memory.decisions.map((d) => ({ ...d, status: "active" })),
      constraints: k.memory.constraints,
    });
    const draft = C.validateDraft({
      batch: `fmt-${k.id}-1-2-abcd`,
      entry: { raised: ["فحص الصيغة على محادثة من مجموعة التطوير"] },
      ...k.draft,
    }).draft;
    m = C.applyDraft(m, draft, { date: "2026-10-26 10:00", evidence: ev, platform: "chatgpt", chat: "Test" }).memory;
    check(m, `${k.id} after the summary`);
    // the user answers the review: half approved, half rejected
    const keys = C.reviewItems(m).map((x) => x.key);
    if (keys.length) {
      const fix = C.validateFix({ pending: { approve: keys.filter((_, i) => i % 2 === 0), reject: keys.filter((_, i) => i % 2) } });
      assert.ok(fix.ok, `${k.id}: review answer is valid`);
      m = C.applyFix(m, fix.fix, "2026-10-26 10:05").memory;
      check(m, `${k.id} after the review`);
    }
    n++;
  }
  assert.equal(n, cases.length);
});

test("format: pins, imported text and trimming keep the file valid", () => {
  let m = C.upsertPin(C.emptyMemory(), {
    name: "رسالة الترحيب",
    version: 2,
    path: C.pinPath("رسالة الترحيب", 2),
    sha: "a".repeat(64),
    date: "2026-10-26 10:00",
  });
  m = C.importLegacy(m, "# ذاكرة قديمة\n- قرار قديم", "2026-10-26 10:00");
  check(m, "pin + imported");
  const big = C.normalizeMemory({
    log: Array.from({ length: 1500 }, (_, i) => ({ id: `b-${i}`, platform: "claude-code", range: "1–5", raised: ["ن".repeat(1500)] })),
  });
  const t = C.trimForSize(big, 1024 * 1024);
  assert.ok(t.archived.length > 0, "old entries moved out");
  const f = check(t.memory, "trimmed");
  assert.equal(f.archived, t.archived.length);
});

test("format: the schema refuses what the core never writes", () => {
  const good = onDisk(C.normalizeMemory({ decisions: [{ text: "قرار", quote: "قلتها" }] }));
  const bad = [
    (f) => delete f.decisions,
    (f) => (f.lang = "fr"),
    (f) => (f.decisions[0].source = "model"),
    (f) => (f.decisions[0].id = "x1"),
    (f) => (f.decisions[0].confirmed = true) && (f.decisions[0].unverified = true),
    (f) => (f.pins = [{ name: "a", version: 1, path: "../../etc/passwd", sha: "", date: "" }]),
    (f) => (f.log = [{ id: "b", platform: "copilot", chat: "", range: "", date: "", raised: [], decided: [], changed: [] }]),
  ];
  for (const [i, spoil] of bad.entries()) {
    const f = JSON.parse(JSON.stringify(good));
    spoil(f);
    assert.ok(!valid(f), `case ${i} should be refused`);
  }
  // …and keeps what a later version may add
  assert.ok(valid({ ...good, someNewField: { x: 1 } }), "unknown top-level fields are allowed (kept by every writer)");
  assert.ok(path.basename(schema.$id).startsWith("conversation-memory-1"));
});

// node --test tests/        (Node 18+)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../core/memory-core.js");

const ENTRY = { raised: ["نقاش حول الهوية البصرية للمقهى"], decided: ["اعتماد اللون الزيتوني"], changed: [] };
const D = (o) => ({ batch: "b-1", entry: ENTRY, ...o });

test("normalize never throws and repairs hand-edited files", () => {
  for (const bad of [null, 1, "x", [], { decisions: "x", log: [1, null, {}], pins: [{ name: "../x", path: "a" }, { name: ["a"] }] }]) {
    const m = C.normalizeMemory(bad);
    assert.equal(m.format, C.FORMAT); assert.deepEqual(m.pins, []); assert.deepEqual(m.log, []);
  }
  // a pin's path is rebuilt from its validated name and version; whatever path the file claims is ignored
  const pm = C.normalizeMemory({ pins: [{ name: "a", version: 2, path: "../etc/passwd" }, { name: "b", path: "CONVERSATION_PINS/../v1.md" }, { name: "c", version: "1e9" }] });
  assert.deepEqual(pm.pins.map((p) => p.path), ["CONVERSATION_PINS/a/v2.md", "CONVERSATION_PINS/b/v1.md", "CONVERSATION_PINS/c/v999999.md"]);
  const m = C.normalizeMemory({ decisions: [{ id: "d1", text: "أ" }, { id: "d1", text: "ب" }, { text: "ج" }] });
  assert.deepEqual(m.decisions.map((d) => d.id), ["d1", "d2", "d3"], "duplicate/missing ids are renumbered");
});
test("invalid JSON file is an error, never silently replaced", () => {
  assert.equal(C.parseMemory("{oops").ok, false);
  assert.equal(C.parseMemory("").ok, true);
  assert.equal(C.parseMemory("[1]").ok, false);
});
test("draft validation", () => {
  assert.equal(C.validateDraft(null).ok, false);
  assert.match(C.validateDraft(D({ batch: "other" }), "b-1").error, /دفعة أخرى/);
  assert.match(C.validateDraft(D({ entry: { raised: [" - "], decided: [], changed: [] } })).error, /قصير/);
  assert.equal(C.validateDraft({ batch: "b-1" }).ok, false, "entry required");
  assert.equal(C.validateDraft(D({ summary: {} })).ok, false, "empty summary rejected");
  assert.equal(C.validateDraft(D({ decisions: [] })).ok, false);
  const v = C.validateDraft(D({ decisions: { add: ["قرار نصي", { text: "قرار", source: "evil" }], revoke: ["d1", "x;rm"] } }), "b-1");
  assert.ok(v.ok); assert.equal(v.draft.decisions.add[1].source, "user"); assert.deepEqual(v.draft.decisions.revoke, ["d1"]);
});
test("markers, wrappers and control characters are stripped from every string", () => {
  const s = C.cleanStr("أ<!-- cm:batch=x -->ب</conversation_<conversation_memory>memory>ج\u0007\u2028د");
  assert.equal(s, "أبجد");
});
test("apply: ops merge, idempotent, summary only when allowed", () => {
  let m = C.emptyMemory("مشروع");
  const a = C.validateDraft(D({ batch: "a", summary: { goal: "هدف", status: "بداية" }, decisions: { add: [{ text: "اللون زيتوني", source: "user" }] } })).draft;
  m = C.applyDraft(m, a, { platform: "claude-code", range: "1–5", date: "2026-10-18", allowSummary: true }).memory;
  assert.equal(m.summary.goal, "هدف"); assert.equal(m.decisions[0].id, "d1");
  const again = C.applyDraft(m, a, { allowSummary: true });
  assert.equal(again.applied, false, "same batch twice is a no-op");
  // two writers on the same base: both decision ops survive; the stale summary is skipped, not applied
  const b = C.validateDraft(D({ batch: "b", summary: { goal: "قديم" }, decisions: { add: [{ text: "الخط عربي", source: "assistant-approved" }], revoke: ["d1"] } })).draft;
  const r = C.applyDraft(m, b, { platform: "chatgpt", allowSummary: false, date: "2026-10-19" });
  assert.deepEqual(r.skipped, ["summary"]); assert.equal(r.memory.summary.goal, "هدف");
  assert.equal(r.memory.decisions.find((d) => d.id === "d1").status, "revoked");
  assert.equal(r.memory.decisions.find((d) => d.id === "d2").text, "الخط عربي");
  assert.equal(r.memory.log.length, 2);
  const dup = C.validateDraft(D({ batch: "c", decisions: { add: ["الخط عربي"] } })).draft;
  assert.equal(C.applyDraft(r.memory, dup, {}).memory.decisions.filter((d) => d.text === "الخط عربي").length, 1, "no duplicate active decision");
  const rep = C.validateDraft(D({ batch: "e", decisions: { add: [{ text: "الخط لاتيني", replaces: "d2" }] } })).draft;
  const r2 = C.applyDraft(r.memory, rep, {}).memory;
  assert.equal(r2.decisions.find((d) => d.id === "d2").status, "revoked"); assert.equal(r2.decisions.at(-1).replaces, "d2");
});
test("secrets are redacted on apply, placeholder is not a secret, scan is linear", () => {
  const d = C.validateDraft(D({ entry: { raised: ["المفتاح sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX و password: hunter2secret"], decided: ["x"], changed: [] } })).draft;
  const r = C.applyDraft(C.emptyMemory(), d, {});
  assert.ok(r.redacted); assert.doesNotMatch(JSON.stringify(r.memory), /sk-ant|hunter2/);
  assert.equal(C.hasSecret("- password: (محذوف لأنه حساس)"), false);
  const t0 = Date.now(); C.hasSecret("eyJ-".repeat(200000) + "a".repeat(300000)); assert.ok(Date.now() - t0 < 5000, "a crafted 1.1 MB token stays fast");
});
test("render and compact view", () => {
  let m = C.emptyMemory("مشروع");
  for (let i = 1; i <= 200; i++) m = C.applyDraft(m, C.validateDraft(D({ batch: "b" + i, entry: { raised: ["نقاش طويل رقم " + i + " ".repeat(1) + "ن".repeat(80)], decided: [], changed: [] } })).draft, { range: `${i}` }).memory;
  m = C.applyDraft(m, C.validateDraft(D({ batch: "z", summary: { goal: "الهدف_المهم" }, decisions: { add: ["القرار_المهم"] } })).draft, { allowSummary: true }).memory;
  m = C.upsertPin(m, { name: "الشعار", version: 2, path: "CONVERSATION_PINS/الشعار/v2.md", sha: "abcdef0123456789", date: "2026-10-18" });
  const full = C.render(m);
  for (const h of ["## الخلاصة الحالية", "## القرارات السارية", "## القيود والمتطلبات", "## النصوص المعتمدة", "## السجل"]) assert.ok(full.includes(h));
  const c = C.renderCompact(m, 5000);
  assert.ok(c.length <= 5400, `compact size ${c.length}`);
  assert.ok(c.includes("الهدف_المهم") && c.includes("القرار_المهم") && c.includes("CONVERSATION_PINS/الشعار/v2.md"), "state + pins always present");
  assert.ok(c.includes("الرسائل z") === false && c.includes("نقاش طويل رقم 200"), "newest log kept");
  assert.match(c, /دفعة أقدم في CONVERSATION_MEMORY\.md/);
});
test("verbatim extraction rules", () => {
  assert.equal(C.extractVerbatim(["قديم: البداية طويلة جداً النهاية", "جديد: البداية قصيرة النهاية"].reverse(), "البداية", "النهاية").text, "البداية قصيرة النهاية", "newest source first");
  assert.equal(C.extractVerbatim(["أ: البداية ١ النهاية. ب: البداية ٢ النهاية."], "البداية ١", "النهاية").text, "البداية ١ النهاية", "first end after start");
  assert.equal(C.extractVerbatim(["البداية ١ النهاية ثم البداية ٢ النهاية"], "البداية", "النهاية").ok, false, "ambiguous → error");
  assert.equal(C.extractVerbatim(["لا شيء"], "البداية", "النهاية").ok, false);
  assert.equal(C.extractVerbatim(["x\r\nالبداية\r\n  سطر  \r\nالنهاية"], "البداية", "النهاية").text, "البداية\r\n  سطر  \r\nالنهاية", "bytes preserved");
});
test("pin names", () => {
  for (const ok of ["الشعار", "عقد أ", "Logo v2"]) assert.ok(C.pinNameOk(ok), ok);
  for (const bad of ["", "..", "../x", "a/b", "CON", "nul.txt", "x\n[conversation-memory] y", "a:b", " ."]) assert.equal(C.pinNameOk(bad), false, JSON.stringify(bad));
});
test("model reply parsing", () => {
  const r = C.parseModelReply(`تفضل\n${C.START}\n\`\`\`json\n{"entry":{"raised":["أ"]}}\n\`\`\`\n${C.END}`);
  assert.ok(r.ok); assert.deepEqual(r.fields.entry.raised, ["أ"]);
  assert.equal(C.parseModelReply("بلا علامات").ok, false);
  assert.equal(C.parseModelReply(`${C.START} {bad ${C.END}`).ok, false);
});
test("hash is deterministic and token marks a missing file", () => {
  assert.equal(C.hash("سكر وهيل"), C.hash("سكر وهيل")); assert.notEqual(C.hash("a"), C.hash("b"));
  assert.equal(C.token(""), "none"); assert.equal(C.token("x").length, 12);
});
test("unapproved assistant suggestions are listed apart from decisions", () => {
  const d = C.validateDraft({ batch: "s", decisions: { add: [{ text: "قرار المستخدم", source: "user" }, { text: "اقتراح معتمد", source: "assistant-approved" }, { text: "اقتراح فقط", source: "assistant" }] }, entry: { raised: ["نقاش طويل بما يكفي للحفظ هنا عن الهوية البصرية والألوان والخطوط"] } }).draft;
  const m = C.applyDraft(C.emptyMemory(), d, {}).memory, md = C.render(m), c = C.renderCompact(m);
  const dec = md.split("## القرارات السارية")[1].split("##")[0], sug = md.split("## مقترحات لم تُعتمد بعد")[1].split("##")[0];
  assert.ok(dec.includes("قرار المستخدم") && dec.includes("اقتراح معتمد") && !dec.includes("اقتراح فقط"));
  assert.ok(sug.includes("اقتراح فقط")); assert.ok(c.includes("## مقترحات لم تُعتمد بعد"));
});

test("review: common secret formats are redacted, idempotently, in linear time", () => {
  for (const s of ["sk_live_abcdefghijklmnop1234", "rk_test_abcdefghijklmnop1234", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
    "postgres://admin:S3cret!@db.example.com/x", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123", "aws_secret_access_key = AbCdEf123456789",
    'PASSWORD: "(hunter22)"', "DB_PASSWORD=hunter22x", "كلمة المرور: سرّي12345", "-----BEGIN RSA PRIVATE KEY-----"]) {
    const r = C.redact("قبل " + s + " بعد"); assert.ok(r.changed, s); assert.match(r.text, /محذوف لأنه حساس/);
    assert.ok(!/hunter22|S3cret|abcdefghijklmnop1234|AbCdEf123/.test(r.text), r.text);
    assert.equal(C.redact(r.text).text, r.text, "idempotent: " + s);
  }
  for (const ok of ["ميزانية token واحدة 40", "password reset flow", "استخدم https://example.com/path"]) assert.equal(C.redact(ok).changed, false, ok);
  // linear, not quadratic: doubling the input roughly doubles the time (a quadratic pattern would quadruple it)
  const time = (n) => { const t0 = process.hrtime.bigint(); C.redact("password".repeat(n)); C.redact("a_".repeat(5 * n)); return Number(process.hrtime.bigint() - t0) / 1e6; };
  time(2000); const t1 = Math.max(time(20000), 1), t2 = time(40000);
  assert.ok(t2 / t1 < 3.2 && t2 < 5000, `20k: ${t1.toFixed(0)} ms, 40k: ${t2.toFixed(0)} ms`);
});
test("review: ids must be strings — arrays can't slip through revoke/replaces", () => {
  let m = C.applyDraft(C.emptyMemory(), C.validateDraft(D({ decisions: { add: ["أ"] } }), "b-1").draft, { date: "x" }).memory;
  const v = C.validateDraft({ batch: "b-2", decisions: { add: [{ text: "ب", replaces: ["d1"] }], revoke: [["d1"]] }, entry: D({}).entry }, "b-2");
  assert.deepEqual(v.draft.decisions.revoke, []); assert.equal(v.draft.decisions.add[0].replaces, "");
  m = C.applyDraft(m, v.draft, { date: "y" }).memory; assert.equal(m.decisions[0].status, "active");
  assert.equal(C.normalizeMemory({ decisions: [{ id: ["d7"], text: "x", replaces: ["d1"] }] }).decisions[0].replaces, "");
});

// ---------------- phase 3: corrections, sharing, version comparison ----------------
const withTwo = () => C.applyDraft(C.emptyMemory(), C.validateDraft(D({ summary: { goal: "هدف" }, decisions: { add: [{ text: "قرار المستخدم", source: "user" }, { text: "اقتراح النموذج", source: "assistant" }] }, constraints: { add: ["قيد أ", "قيد ب"] } }), "b-1").draft, { date: "2026-10-19", allowSummary: true }).memory;
test("fix: edit, approve a suggestion, revoke, remove, constraints, summary, log — and say what changed", () => {
  const m = withTwo();
  const v = C.validateFix({ decisions: { edit: [{ id: "d1", text: "قرار معدّل" }], approve: ["d2"], remove: ["d77"] }, constraints: { remove: ["قيد أ"], add: ["قيد ج"] }, summary: { goal: "هدف جديد" }, log: { remove: ["b-1"] } });
  assert.ok(v.ok);
  const r = C.applyFix(m, v.fix, "2026-10-20");
  assert.equal(r.memory.decisions[0].text, "قرار معدّل"); assert.equal(r.memory.decisions[1].source, "assistant-approved");
  assert.deepEqual(r.memory.constraints, ["قيد ب", "قيد ج"]); assert.equal(r.memory.summary.goal, "هدف جديد"); assert.equal(r.memory.log.length, 0);
  assert.deepEqual(r.missing, ["d77"], "unknown ids are reported, not ignored silently");
  assert.ok(r.changes.length >= 5); assert.equal(m.decisions[0].text, "قرار المستخدم", "input not mutated");
  const rv = C.applyFix(m, C.validateFix({ decisions: { revoke: ["d1"] } }).fix, "x"); assert.equal(rv.memory.decisions[0].status, "revoked");
});
test("fix: rejects empty or malformed fixes; secrets in corrections are redacted", () => {
  assert.equal(C.validateFix({}).ok, false); assert.equal(C.validateFix(null).ok, false); assert.equal(C.validateFix({ decisions: [] }).ok, false);
  assert.equal(C.validateFix({ summary: {} }).ok, false);
  const r = C.applyFix(withTwo(), C.validateFix({ decisions: { edit: [{ id: "d1", text: "password=hunter2secret" }] } }).fix, "x");
  assert.ok(r.redacted); assert.doesNotMatch(JSON.stringify(r.memory), /hunter2/);
});
test("share: only the chosen parts, active decisions only, within the budget", () => {
  const m = withTwo();
  const t = C.renderSelection(m, { summary: true, decisions: ["d1"], constraints: true, log: ["b-1"] });
  assert.match(t, /الخلاصة الحالية/); assert.match(t, /قرار المستخدم/); assert.doesNotMatch(t, /اقتراح النموذج/); assert.match(t, /قيد أ/); assert.match(t, /من سجل النقاش/);
  assert.equal(C.renderSelection(m, { decisions: ["d2"] }).includes("اقتراح النموذج"), true, "a suggestion can be shared when chosen, labelled as such");
  assert.ok(C.renderSelection(m, { summary: true, constraints: true, log: ["b-1"] }, 40).length < 80);
  assert.equal(C.renderSelection(m, {}), "");
});
test("diff: changed, removed and added lines; huge inputs stay fast", () => {
  assert.deepEqual(C.diffLines("أ\nب\nج", "أ\nب2\nج\nد").map((x) => x.op + x.line), [" أ", "-ب", "+ب2", " ج", "+د"]);
  assert.deepEqual(C.diffLines("x", "x").map((x) => x.op), [" "]);
  const big = Array.from({ length: 3000 }, (_, i) => "سطر " + i).join("\n");
  const t0 = Date.now(); const d = C.diffLines(big, big + "\nجديد"); assert.ok(Date.now() - t0 < 5000); assert.equal(d.filter((x) => x.op === "+").length, 1);
});

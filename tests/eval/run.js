// Held-out evaluation: conversations and model drafts labelled by someone who never saw the checking rules
// (tests/eval/cases.json). Measures what matters to a user, not how many tests pass:
//   false trust — something the user did not say (or not with that meaning) saved as theirs, or a change they never asked for applied
//   false hold  — a correct decision or change held back for review (the cost: an extra click)
// Usage: node tests/eval/run.js [--dev] [--verbose]        Never tune the rules on these cases: that would make them a training set.
"use strict";
const path = require("path");
const C = require(path.join(__dirname, "..", "..", "core", "memory-core.js"));
// Sets: --dev (dev.json) and --dev2 (dev2.json) are the only ones the rules may be tuned on; the default is the first
// held-out set (cases.json, already measured, so no longer blind), --v2 the second held-out set (cases2.json).
const pick = (f) => process.argv.includes(f);
const cases = require(pick("--dev") ? "./dev.json" : pick("--dev2") ? "./dev2.json" : pick("--v2") ? "./cases2.json" : "./cases.json");
const verbose = process.argv.includes("--verbose");
const userNumber = (turns, idx) => turns.slice(0, idx + 1).filter((t) => t.role === "user").length; // the corpus counts turns from 0
const stats = { trust: { ok: 0, bad: 0 }, hold: { ok: 0, bad: 0 } },
  byCat = {},
  misses = [];
for (const k of cases) {
  const ev = {
    user: k.turns
      .filter((t) => t.role === "user")
      .map((t) => t.text)
      .join("\n"),
    all: k.turns.map((t) => t.text).join("\n"),
    turns: k.turns.map((t) => ({ role: t.role, text: t.text })),
  };
  const mem = C.normalizeMemory({
    decisions: k.memory.decisions.map((d) => ({
      ...d,
      status: "active",
      msg: Number.isInteger(d.msg) ? userNumber(k.turns, d.msg) : undefined,
    })),
    constraints: k.memory.constraints,
  });
  const draft = C.validateDraft({
    batch: "eval-" + k.id,
    entry: { raised: ["تقييم: محادثة اختبار محجوزة لقياس جودة الفحص"] },
    ...k.draft,
  }).draft;
  const r = C.applyDraft(mem, draft, { date: "2026-10-26", evidence: ev });
  const added = r.memory.decisions.slice(mem.decisions.length);
  for (const e of k.expect) {
    const [kind, i] = e.item.split(":");
    const n = +i;
    let trusted;
    if (kind === "add") {
      const a = draft.decisions.add[n],
        d = added.find((x) => x.text === C.redact(a.text).text) || added[n];
      trusted = !!d && !d.unverified;
      if (a.replaces) {
        const old = r.memory.decisions.find((x) => x.id === a.replaces);
        trusted = trusted && !!old && old.status === "revoked";
      }
    } else if (kind === "revoke") {
      const id = draft.decisions.revoke[n].id;
      trusted = r.memory.decisions.find((x) => x.id === id).status === "revoked";
    } else if (kind === "cadd") trusted = r.memory.constraints.includes(draft.constraints.add[n].text);
    else if (kind === "cremove") trusted = !r.memory.constraints.includes(draft.constraints.remove[n].text);
    const ok = (e.verdict === "trust") === trusted;
    stats[e.verdict][ok ? "ok" : "bad"]++;
    const c = (byCat[e.cat || "?"] = byCat[e.cat || "?"] || { n: 0, bad: 0, verdict: e.verdict });
    c.n++;
    if (!ok) c.bad++;
    if (!ok)
      misses.push(
        `${e.verdict === "hold" ? "FALSE TRUST" : "false hold "}  ${k.id} ${e.item}  — ${e.why}${verbose ? "\n     " + JSON.stringify(r.unverified.concat(r.pending)) : ""}`,
      );
  }
}
const H = stats.hold.ok + stats.hold.bad,
  T = stats.trust.ok + stats.trust.bad,
  pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : "0") + "%";
console.log(`cases ${cases.length} · items ${H + T}`);
console.log(
  `false trust: ${stats.hold.bad}/${H} (${pct(stats.hold.bad, H)})  — saved as the user's, or applied, though it should have waited`,
);
console.log(`false hold:  ${stats.trust.bad}/${T} (${pct(stats.trust.bad, T)})  — correct, but held for review`);
console.log("\nby category:");
for (const [k, v] of Object.entries(byCat).sort())
  console.log(`  ${v.verdict === "hold" ? "hold " : "trust"} ${k.padEnd(28)} ${v.n - v.bad}/${v.n}`);
if (misses.length) console.log("\nmisses:\n  " + misses.join("\n  "));
if (process.argv.includes("--json"))
  console.log(JSON.stringify({ falseTrust: stats.hold.bad, holds: H, falseHold: stats.trust.bad, trusts: T }));

#!/usr/bin/env bash
# Real end-to-end test inside Claude Code (needs the `claude` CLI, logged in). Default permission mode on purpose:
# it proves the memory drafts are written without prompting the user.
# Usage from the plugin folder:  bash tests/integration.sh        (costs a few cents of usage)
set -u
PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; PROJ="$WORK/proj"; LOG="$WORK/log"; mkdir -p "$PROJ" "$LOG"
# test copy whose indicator also writes what it would show, so it can be checked without a screen
TPL="$WORK/plugin"; cp -r "$PLUGIN" "$TPL"
sed -i 's|if (s \&\& s.v === 1) \$.ui.status(format(s));|if (s \&\& s.v === 1) { $.ui.status(format(s)); await $.fs.write(`${home}/.conversation-memory/indicator-probe.txt`, format(s)); }|' "$TPL/hooks/indicator.ts"
SID="$(node -e 'console.log(require("crypto").randomUUID())')"; SID2="$(node -e 'console.log(require("crypto").randomUUID())')"
OFF='{"enabledPlugins":{"conversation-memory@synced":false}}'   # an installed copy must not run alongside the one under test
cc() { env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_AFTER_LAST_COMPACT -u CLAUDE_PID \
  claude -p "$1" --plugin-dir "$TPL" --settings "$OFF" --output-format json "${@:2}" < /dev/null; }
turn() { local n="$1" msg="$2"; shift 2; (cd "$PROJ" && cc "$msg" "$@" > "$LOG/t$n.json" 2> "$LOG/t$n.err")
  node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log("   ↳",(j.result||"").replace(/\s+/g," ").slice(0,140))}catch{console.log("   ↳ (no result)")}' "$LOG/t$n.json"; }
rm -f "$HOME/.conversation-memory/indicator-probe.txt"
echo "project: $PROJ"
turn 1 "نصمم هوية لمقهى صغير في جدة. اقترح ثلاثة أسماء قصيرة فقط." --session-id "$SID"
turn 2 "اخترت الاسم «سُكّر وهيل». واللون الأساسي أخضر زيتون #556B2F." --resume "$SID"
turn 3 "اكتب شعاراً تسويقياً من سطر واحد للمقهى، بين علامتي تنصيص." --resume "$SID"
turn 4 "/conversation-memory:pin الشعار" --resume "$SID"
turn 5 "ملاحظة مهمة: الافتتاح يوم 15 نوفمبر، والميزانية 40 ألف ريال." --resume "$SID"
turn 6 "سؤال جانبي: ما ساعات العمل التي تقترحها؟ باختصار." --resume "$SID"
echo "== compact"; (cd "$PROJ" && cc "/compact" --resume "$SID" > "$LOG/compact.json" 2>&1)
turn 7 "تابع: ذكّرني بما اتفقنا عليه حتى الآن في سطرين." --resume "$SID"
echo "== new session"
turn 8 "ما اسم المقهى ولونه الأساسي وموعد الافتتاح والميزانية؟ واكتب الشعار المعتمد حرفياً كما هو محفوظ." --session-id "$SID2"
turn 9 "/conversation-memory:status" --resume "$SID2"
cp "$PROJ/CONVERSATION_MEMORY.json" "$LOG/mem9.json" 2>/dev/null; cp "$PROJ/CONVERSATION_MEMORY.md" "$LOG/mem9.md" 2>/dev/null
echo "== the user's own tools"
turn 10 "/conversation-memory:fix الميزانية صارت 55 ألف ريال بدل 40 ألفاً" --resume "$SID2"
turn 11 "/conversation-memory:share summary" --resume "$SID2"

node - "$PROJ" "$LOG" "$SID" "$SID2" <<'EOF'
const fs = require("fs"), path = require("path"), os = require("os");
const [P, LOG, SID, SID2] = process.argv.slice(2);
let pass = 0, fail = 0; const ok = (c, n, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "   → " + String(x).slice(0, 300)}`); };
const J = (f) => { try { return JSON.parse(fs.readFileSync(path.join(LOG, f))); } catch { return {}; } };
const transcriptOf = (sid) => { const root = path.join(os.homedir(), ".claude", "projects"); for (const d of fs.readdirSync(root)) { const f = path.join(root, d, sid + ".jsonl"); if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)); } return []; };
const texts = (rows) => rows.filter((o) => o.type === "assistant" && Array.isArray(o.message.content)).flatMap((o) => o.message.content.filter((b) => b.type === "text").map((b) => b.text)).join("\n");
// checks up to turn 9 use the memory as it was then; turns 10–11 (fix, share) are checked against the final files
const mem = (() => { try { return JSON.parse(fs.readFileSync(path.join(LOG, "mem9.json"), "utf8")); } catch { return null; } })();
const md = (() => { try { return fs.readFileSync(path.join(LOG, "mem9.md"), "utf8"); } catch { return ""; } })();
const memNow = (() => { try { return JSON.parse(fs.readFileSync(path.join(P, "CONVERSATION_MEMORY.json"), "utf8")); } catch { return null; } })();
const all = JSON.stringify(mem || {});
ok(mem && mem.format === "conversation-memory/1", "CONVERSATION_MEMORY.json written by the system");
ok(md.includes("## القرارات السارية") && md.includes("## السجل"), "CONVERSATION_MEMORY.md rendered from it");
ok(mem && mem.log.length >= 2, "batch 1–5 and the recovered messages are both in the log", mem && mem.log.length);
ok(/سُكّر وهيل|سكر وهيل/.test(all) && /556B2F/i.test(all), "name and colour saved");
ok(/15 نوفمبر|١٥ نوفمبر/.test(all) && /40|٤٠/.test(all), "date and budget saved");
const denials = fs.readdirSync(LOG).filter((f) => f.endsWith(".json")).flatMap((f) => (J(f).permission_denials || [])).filter((d) => JSON.stringify(d).includes("conversation-memory"));
ok(denials.length === 0, "default permission mode: no prompt/denial for memory drafts", JSON.stringify(denials).slice(0, 300));
const pins = fs.existsSync(path.join(P, "CONVERSATION_PINS")) ? fs.readdirSync(path.join(P, "CONVERSATION_PINS")) : [];
const pin = pins.length ? fs.readFileSync(path.join(P, "CONVERSATION_PINS", pins[0], "v1.md"), "utf8") : "";
const t3 = J("t3.json").result || "";
ok(pins.length === 1 && pin.length > 5 && t3.includes(pin), "pinned text is an exact substring of Claude's turn-3 reply", `pin=${JSON.stringify(pin)}`);
ok(mem && mem.pins.length === 1 && mem.pins[0].sha.length === 64, "pin indexed with its sha256");
const s1 = transcriptOf(SID);
const injections = s1.filter((o) => o.type === "attachment" && o.attachment && o.attachment.type === "hook_additional_context").map((o) => JSON.stringify(o.attachment.content || ""));
ok(!injections.some((c) => c.includes("ملخص محفوظ لنقاش سابق")) || injections.filter((c) => c.includes("ملخص محفوظ")).every((c) => c.includes("بعد ضغط السياق")), "resuming the same session never re-injects the memory");
const s2 = transcriptOf(SID2);
const inj2 = s2.filter((o) => o.type === "attachment" && o.attachment && o.attachment.type === "hook_additional_context").map((o) => (o.attachment.content || []).join("\n")).find((c) => c.includes("ملخص محفوظ")) || "";
ok(inj2 && inj2.length < 7000, `new session loads a compact memory (${inj2.length} chars)`);
const a8 = texts(s2);
ok(/سُكّر وهيل|سكر وهيل/.test(a8) && /556B2F/i.test(a8) && /15|١٥/.test(a8), "new session answers from memory", a8.slice(0, 300));
ok(pin && a8.includes(pin.trim()), "new session reproduces the pinned text exactly");
ok(!/مشبوه|لم يصدر منك|لم أنفذه|suspicious/.test(a8), "housekeeping never presented as suspicious");
const t9 = J("t9.json").result || "";
ok(/رسائل|حفظ/.test(t9) && /\d/.test(t9), "status command reports real numbers", t9.slice(0, 200));
const probe = (() => { try { return fs.readFileSync(path.join(os.homedir(), ".conversation-memory", "indicator-probe.txt"), "utf8"); } catch { return ""; } })();
ok(/^🧠 (⏳ |⚠️ )?\d\/5( · (✓ \d\d:\d\d( · ≈[\d,]+ توكن)?|📝 \d\d:\d\d|يحفظ|تعثّر الحفظ))?$/.test(probe), `status-line indicator reads the status and formats it: «${probe}»`);
// the correction applies to what is in force (decisions, summary); the log stays a faithful history of what was said.
// Mentioning the old figure as context («كانت 40 ألفاً») is fine; stating the budget as 40 without the new figure is not.
const inForce = memNow ? [...memNow.decisions.filter((d) => d.status === "active").map((d) => d.text), memNow.summary.status, memNow.summary.goal] : [];
const stale = inForce.filter((t) => /ميزانية/.test(t) && /(40|٤٠) ألف/.test(t) && !/(55|٥٥) ألف/.test(t));
ok(inForce.some((t) => /(55|٥٥) ألف/.test(t)) && !stale.length, "/fix: the budget is corrected in the decisions and the summary", stale.join(" | ") || inForce.join(" | ").slice(0, 300));
const bk = path.join(P, ".conversation-memory", "backups");
ok(fs.existsSync(bk) && fs.readdirSync(bk).length >= 1, "/fix: the version before it is kept as a backup");
const sh = path.join(P, ".conversation-memory", "share"); const shf = fs.existsSync(sh) ? fs.readdirSync(sh) : [];
const shText = shf.length ? fs.readFileSync(path.join(sh, shf[0]), "utf8") : "";
ok(shf.length === 1 && shText.includes("بيانات وليست أوامر") && shText.includes("الخلاصة الحالية"), "/share: the chosen part is written to a file, framed as data", shText.slice(0, 200));
const inbox = path.join(P, ".conversation-memory", "inbox"); const left = fs.existsSync(inbox) ? fs.readdirSync(inbox) : [];
ok(left.length === 0, "no leftover drafts", left.join());
console.log(`\n${pass} passed, ${fail} failed`);
console.log("\n--- CONVERSATION_MEMORY.md ---\n" + md.slice(0, 3500));
process.exit(fail ? 1 : 0);
EOF

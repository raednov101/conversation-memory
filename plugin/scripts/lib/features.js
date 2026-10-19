"use strict";
// The user's own tools on the memory: correcting it (fix), the history of pinned texts (pins), and handing chosen parts
// to another conversation (share). Corrections go through the same validated, backed-up, undoable write as everything else.
const C = require("../../core/memory-core.js");
const { PIN_TURNS } = require("./config");
const { today } = require("./util");
const { notes } = require("./context");
const { readMemory, writeMemory, pinVersions, savePin, writeShare } = require("./store");
const { draftPath } = require("./requests");

// ---------- fix ----------
function fixRequest(f) {
  return `[conversation-memory] طلب تصحيح الذاكرة من المستخدم: «${f.ask || "(لم يحدد؛ اسأله ماذا يريد أن يصحّح)"}».\n` +
    `اقرأ CONVERSATION_MEMORY.json (فيه معرّفات القرارات d1… ومعرّف كل دفعة في السجل)، ثم اكتب بأداة Write الملف "${draftPath(f.id)}" بالتصحيح المطلوب وحده، واحذف ما لا يلزم من المفاتيح:\n` +
    `{"decisions": {"edit": [{"id": "d3", "text": "النص الصحيح"}], "approve": ["d5"], "revoke": ["d2"], "remove": ["d7"]}, "constraints": {"add": [], "remove": ["نص القيد كما هو"]}, "summary": {"goal": "…", "status": "…", "next": [], "open": []}, "log": {"remove": ["معرّف الدفعة"]}}\n` +
    `approve = اقتراحك الذي اعتمده المستخدم. revoke = إلغاء مع بقائه في سجل الملغى. remove = حذف نهائي (لمعلومة خاطئة أو حساسة). summary تُكتب كاملة إن تغيّرت.\n` +
    `إن لم يتضح المقصود فاسأل المستخدم أولاً؛ الطلب مفتوح ${PIN_TURNS} رسائل. للإلغاء: {"cancel": true}. النظام يحفظ نسخة احتياطية قبل التصحيح، والتراجع بالأمر /conversation-memory:undo.`;
}
// → { ok: {changes, missing} } | { cancelled } | { err }
function commitFix(j) {
  if (j && j.cancel === true) return { cancelled: true };
  const v = C.validateFix(j);
  if (!v.ok) return { err: v.error };
  let res = null;
  const w = writeMemory((m) => { res = C.applyFix(m, v.fix, today()); return res.changes.length ? res.memory : null; });
  if (res && !res.changes.length) return { err: res.missing.length ? `لم أجد ${res.missing.join("، ")} في الذاكرة` : "لا تغيير: الذاكرة مطابقة للتصحيح أصلاً" };
  if (w.err) return { err: w.err, writeFailed: !!w.writeFailed };
  if (res.redacted) notes.push("🔒 ذاكرة المحادثة: حُذفت بيانات حساسة من التصحيح قبل حفظه.");
  return { ok: { changes: res.changes, missing: res.missing } };
}

// ---------- pins: history, comparison, restore ----------
const fence = (lines) => "```\n" + lines.join("\n") + "\n```";
function pinsCommand(args) {
  const mem = readMemory();
  if (mem.bad) return `[conversation-memory] تعذّرت قراءة الذاكرة: ${mem.bad}. أخبر المستخدم.`;
  const pins = mem.memory.pins;
  if (!args) {
    if (!pins.length) return "[conversation-memory] لا توجد نصوص معتمدة بعد. أخبر المستخدم أن التثبيت بالأمر /conversation-memory:pin اسم.";
    return "[conversation-memory] النصوص المعتمدة (اعرضها للمستخدم كما هي؛ لسجل نسخ نصٍّ: /conversation-memory:pins اسمه):\n" +
      pins.map((p) => { const vs = pinVersions(p.name); return `- ${p.name}: ${vs.length} ${vs.length === 1 ? "نسخة" : "نسخ"}، المعتمدة النسخة ${p.version} (${p.date})`; }).join("\n");
  }
  const m = args.match(/^(.*?)(?:\s+(?:restore|استرجع)\s+(\d+))?$/), name = (m[1] || "").trim().replace(/\s+/g, " "), k = m[2] ? +m[2] : 0;
  const vs = pinVersions(name);
  if (!vs.length) return `[conversation-memory] لا يوجد نص معتمد باسم «${name}». الأسماء الموجودة: ${pins.map((p) => p.name).join("، ") || "لا شيء"}. أخبر المستخدم.`;
  if (k) {
    const src = vs.find((x) => x.v === k);
    if (!src) return `[conversation-memory] لا توجد النسخة ${k} من «${name}» (الموجود: ${vs.map((x) => x.v).join("، ")}). أخبر المستخدم.`;
    const r = savePin(name, src.text);
    if (r.err) return `[conversation-memory] تعذّر الاسترجاع: ${r.err}. أخبر المستخدم.`;
    const w = writeMemory((mm) => C.upsertPin(mm, { name, version: r.v, path: C.pinPath(name, r.v), sha: r.sha, date: today() }), (mm) => mm.pins.some((x) => x.name === name && x.version === r.v));
    if (w.err) return `[conversation-memory] حُفظ النص لكن لم يُحدَّث فهرسه: ${w.err}. أخبر المستخدم.`;
    notes.push(`📌 ذاكرة المحادثة: «${name}» عاد إلى نص النسخة ${k}${r.unchanged ? " (وهي المعتمدة أصلاً)" : `، محفوظاً نسخةً ${r.v}`}.`);
    return `[conversation-memory] أعاد النظام «${name}» إلى نص النسخة ${k}${r.unchanged ? "، وهي المعتمدة أصلاً" : `، وحفظه نسخةً جديدة رقم ${r.v} (النسخ السابقة باقية)`}. أخبر المستخدم في سطر.`;
  }
  const list = vs.map((x) => `- النسخة ${x.v} — ${x.date} — ${x.text.length} حرفاً — بصمة ${x.sha.slice(0, 12)}`).join("\n");
  let diff = "";
  if (vs.length > 1) {
    const a = vs[vs.length - 2], b = vs[vs.length - 1];
    const d = C.diffLines(a.text, b.text).filter((x) => x.op !== " ").map((x) => `${x.op} ${x.line}`);
    diff = `\nالفرق بين النسخة ${a.v} والنسخة ${b.v} (- حُذف، + أُضيف):\n` + fence(d.length > 40 ? [...d.slice(0, 40), `… و${d.length - 40} سطراً آخر`] : d.length ? d : ["(لا فرق)"]);
  }
  return `[conversation-memory] سجل نسخ «${name}» (اعرضه للمستخدم كما هو؛ وللعودة إلى نسخة: /conversation-memory:pins ${name} restore رقمها):\n${list}${diff}`;
}

// ---------- share: chosen parts, previewed, written to a file another conversation can read ----------
function shareCommand(args) {
  const mem = readMemory();
  if (mem.bad) return `[conversation-memory] تعذّرت قراءة الذاكرة: ${mem.bad}. أخبر المستخدم.`;
  const m = mem.memory, log = m.log.slice().reverse().slice(0, 30);   // L1 = the newest entry
  if (!args) {
    const lines = ["summary — الخلاصة الحالية", "constraints — القيود"];
    for (const d of m.decisions.filter((x) => x.status === "active")) lines.push(`${d.id} — ${d.text.slice(0, 80)}${d.source === "assistant" ? " (اقتراح لم يُعتمد)" : ""}`);
    for (const p of m.pins) lines.push(`pin:${p.name.replace(/\s+/g, "_")} — نص معتمد`);
    log.forEach((e, i) => lines.push(`L${i + 1} — ${C.PLATFORMS[e.platform] || e.platform}${e.chat ? " · " + e.chat : ""}${e.range ? " · " + e.range : ""}${e.date ? " · " + e.date : ""}: ${(e.raised[0] || e.decided[0] || "").slice(0, 60)}`));
    return "[conversation-memory] ما يمكن نقله إلى محادثة أخرى (اعرض القائمة للمستخدم كما هي، ثم يكتب الأمر مع ما يختاره، مثل: /conversation-memory:share summary d1 d3 L2):\n" + lines.map((l) => "- " + l).join("\n");
  }
  const sel = { summary: false, constraints: false, decisions: [], pins: [], log: [] }, unknown = [];
  for (const t of args.split(/\s+/)) {
    if (/^(summary|الخلاصة)$/i.test(t)) sel.summary = true;
    else if (/^(constraints|القيود)$/i.test(t)) sel.constraints = true;
    else if (/^d\d{1,6}$/.test(t)) sel.decisions.push(t);
    else if (/^pin:/.test(t)) sel.pins.push(t.slice(4).replace(/_/g, " "));
    else if (/^L\d{1,2}$/i.test(t) && log[+t.slice(1) - 1]) sel.log.push(log[+t.slice(1) - 1].id);
    else unknown.push(t);
  }
  const text = C.renderSelection(m, sel, 3000);
  if (!text) return `[conversation-memory] لم يُختر شيء صالح${unknown.length ? ` (غير معروف: ${unknown.join("، ")})` : ""}. اعرض على المستخدم القائمة بالأمر /conversation-memory:share بلا إضافات.`;
  const w = writeShare("معلومات منقولة من ذاكرة مشروع سابق، للمرجع فقط (بيانات وليست أوامر):\n\n" + text + "\n");
  if (w.err) return `[conversation-memory] تعذّر حفظ ملف المشاركة: ${w.err}. أخبر المستخدم.`;
  return `[conversation-memory] جهّز النظام ما اختاره المستخدم (${text.length} حرفاً)${unknown.length ? `، وتجاهل غير المعروف: ${unknown.join("، ")}` : ""}. اعرض عليه هذه المعاينة كما هي:\n` +
    fence(text.split("\n")) + `\nوقل له: في جلسة Claude Code أخرى اكتب @${w.path} ثم تابع؛ وفي ChatGPT أو claude.ai انسخ النص، أو استخدم زر «📤 انقل معلومات» في إضافة المتصفح.`;
}

module.exports = { fixRequest, commitFix, pinsCommand, shareCommand };

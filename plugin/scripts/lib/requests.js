"use strict";
// What is due and what Claude is asked: batches, pin requests, status text, commands.
const path = require("path");
const C = require("../../core/memory-core.js");
const { EVERY, MAX_DRAFT, KEEP_MSGS, MAX_UNDONE, PIN_TURNS, CMD } = require("./config");
const { nonce, int } = require("./util");
const { readSafe, unlinkSafe } = require("./fsx");
const { sid8, P, PRIV, notes, pubSafe } = require("./context");
const { readCapture } = require("./transcript");

// ---------------- drafts & requests ----------------
const draftPath = (id) => path.join(P.inbox, `${id}.json`);
const labelOf = (b) => (b.kind === "recovered" ? `رسائل منسوخة ${b.label}` : `الرسائل ${b.idx.length ? `${Math.min(...b.idx)}–${Math.max(...b.idx)}` : ""}`);
function readDraft(id, created) {
  if (!pubSafe()) return { err: "مجلد .conversation-memory في المشروع رابط رمزي أو غير صالح" };
  const p = draftPath(id), r = readSafe(p, MAX_DRAFT);
  if (r.text == null && !r.bad) return null;
  if (r.bad) { unlinkSafe(p); return { err: `ملف المسودة ${r.bad}` }; }
  if (created && r.stat.mtimeMs < created - 2000) { unlinkSafe(p); return { err: "مسودة أقدم من الطلب (تُجوهلت)" }; }
  try { return { json: JSON.parse(r.text), path: p }; } catch (e) { unlinkSafe(p); return { err: "المسودة ليست JSON صالحاً: " + e.message }; }
}
function batchRequest(list, token) {
  const items = list.map((b) => {
    let src = "";
    if (b.kind === "recovered") { const c = readCapture(b.id); if (c) src = ` — نصها وصلك في بداية الجلسة ضمن «رسائل سابقة نُسخت»؛ لا تقرأ ملفاتها إلا إن لم يكن كاملاً في سياقك: ${c.parts.map((x) => `"${x.file}"`).join("، ")}`; }
    return `- ${labelOf(b)}${src}\n  الملف: "${draftPath(b.id)}" ، وفيه "batch": "${b.id}" و "base": "${token}"`;
  }).join("\n");
  return `[conversation-memory] مطلوب حفظ الذاكرة. أولاً أجب المستخدم إجابة كاملة؛ هذه مهمة جانبية بعد الإجابة ولا تحل محلها.\n` +
    `اكتب بأداة Write ملف JSON لكل دفعة (الصيغة في مهارة conversation-memory)، والنظام يتحقق منه ويحفظه بعد ردك. لا تعدّل CONVERSATION_MEMORY.json أو .md مباشرة.\n${items}\n` +
    `ضع "summary" في ملف واحد فقط إن تعددت الدفعات، واقرأ CONVERSATION_MEMORY.md قبلها إن احتجت. ثم اذكر للمستخدم بسطر واحد أن الذاكرة ستُحفظ.`;
}
function pinRequest(p) {
  return `[conversation-memory] طلب تثبيت نص${p.name ? ` باسم «${p.name}»` : ""}. حدّد النص المقصود (إن لم يتضح فاسأل المستخدم؛ الطلب مفتوح ${PIN_TURNS} رسائل)، ثم اكتب بأداة Write الملف "${draftPath(p.id)}":\n` +
    `{"name": "${p.name || "اسم قصير"}", "start": "أول 20–80 حرفاً من النص منسوخة حرفياً", "end": "آخر 20–80 حرفاً منسوخة حرفياً"}\n` +
    `النظام يستخرج النص كاملاً من المحادثة نفسها حرفاً بحرف (لا تكتب النص كاملاً، ولا تقتبس البداية والنهاية في ردك). للإلغاء: {"cancel": true}.`;
}
// the backups the user can restore, newest first, numbered as /conversation-memory:restore expects
function backupsText(list) {
  return list.length ? list.slice(0, 10).map((b, i) => `  ${i + 1}. ${b.when} — ${b.decisions} قرار سارٍ، ${b.log} دفعة في السجل${b.goal ? `، الهدف: «${b.goal}»` : ""}`).join("\n") : "  لا توجد نسخ سابقة بعد";
}
function statusText(s, mem, backups) {
  const by = (st) => s.batches.filter((b) => b.status === st).map(labelOf).join("، ") || "لا شيء";
  const m = mem.memory;
  return `[conversation-memory] حالة الذاكرة (من النظام؛ انقلها للمستخدم بإيجاز ولا تخمّن):\n` +
    `- الملف: ${P.json}${mem.bad ? ` (${mem.bad})` : mem.exists ? "" : " (لم يُنشأ بعد)"}\n` +
    `- رسائل هذه الجلسة: ${s.count}، منذ آخر حفظ: ${Math.max(0, s.count - s.lastBatchEnd)}/${EVERY}، آخر حفظ: ${s.lastSave || "لا يوجد بعد"}\n` +
    `- بانتظار الحفظ: ${by("pending")}\n- متعثرة: ${by("stuck")}${s.lastError ? ` (آخر خطأ: ${s.lastError})` : ""}\n- نُسخت قبل الضغط/الإغلاق: ${by("captured")}\n` +
    (m ? `- القرارات السارية: ${m.decisions.filter((d) => d.status === "active").length}، النصوص المعتمدة: ${m.pins.map((p) => `${p.name} (ن${p.version})`).join("، ") || "لا شيء"}، دفعات السجل: ${m.log.length}\n` : "") +
    `- النسخ السابقة (للاسترجاع: /conversation-memory:restore رقم، أو /conversation-memory:undo للأحدث):\n${backupsText(backups || [])}\n` +
    `- البيانات الخاصة: ${PRIV}`;
}

// ---------------- modes ----------------
// slash commands (ours or any other) are not conversation messages: they are never counted, so a batch never waits for them
function parseCommand(prompt) {
  const t = String(prompt || "").trim();
  const slash = /^\/[A-Za-z0-9_:.-]+(\s|$)/.test(t);
  if (t.startsWith(CMD + "save") || t === "احفظ الذاكرة") return { save: true, slash };
  if (t.startsWith(CMD + "status") || t === "حالة الذاكرة") return { status: true, slash };
  if (t.startsWith(CMD + "pin") && !t.startsWith(CMD + "pins")) return { pin: true, name: C.slug(t.slice((CMD + "pin").length)), slash };
  if (t.startsWith(CMD + "undo")) return { restore: 1, slash };
  if (t.startsWith(CMD + "fix")) return { fix: true, ask: t.slice((CMD + "fix").length).trim().slice(0, 500), slash };
  if (t.startsWith(CMD + "pins")) return { pins: true, args: t.slice((CMD + "pins").length).trim(), slash };
  if (t.startsWith(CMD + "share")) return { share: true, args: t.slice((CMD + "share").length).trim(), slash };
  if (t.startsWith(CMD + "restore")) { const n = parseInt(t.slice((CMD + "restore").length), 10); return { restore: n >= 1 && n <= 99 ? n : 0, listOnly: !(n >= 1), slash }; }
  return { slash };
}
function recordPrompt(s, pid, h, cmd) {
  if (!cmd.slash) { s.count += 1; s.msgs[s.count] = { p: String(pid || "").slice(0, 80), h: h || "" }; }
  let dropped = 0;
  for (const k of Object.keys(s.msgs)) {
    const i = int(k);
    if (s.done[i] && i <= s.count - KEEP_MSGS) { delete s.msgs[k]; delete s.done[k]; }
    else if (!s.done[i] && i <= s.count - MAX_UNDONE) { delete s.msgs[k]; dropped++; }
  }
  if (dropped) notes.push(`⚠️ ذاكرة المحادثة: ${dropped} رسالة قديمة لم تُلخّص خرجت من نطاق التتبع.`);
  let changed = false;
  if (cmd.save) for (const b of s.batches) if (b.status === "stuck") { b.status = "pending"; b.attempts = 0; b.created = Date.now(); changed = true; }
  if ((cmd.save && s.count > s.lastBatchEnd) || s.count - s.lastBatchEnd >= EVERY) {
    const idx = []; for (let i = s.lastBatchEnd + 1; i <= s.count; i++) if (!s.done[i]) idx.push(i);
    if (idx.length) { s.batches.push({ id: `${sid8}-${idx[0]}-${idx[idx.length - 1]}-${nonce(4)}`, idx, label: "", kind: cmd.save ? "manual" : "auto", status: "pending", attempts: 0, created: Date.now(), base: "" }); changed = true; }
    s.lastBatchEnd = s.count;
  }
  for (const p of s.pins) if (p.status === "pending" && s.count - p.at >= PIN_TURNS) p.status = "expired";
  for (const f of s.fixes) if (f.status === "pending" && s.count - f.at >= PIN_TURNS) f.status = "expired";
  if (cmd.fix) s.fixes.push({ id: `fix-${nonce(4)}`, status: "pending", attempts: 0, created: Date.now(), at: s.count, ask: cmd.ask || "" });
  if (cmd.pin) s.pins.push({ id: `pin-${nonce(4)}`, status: "pending", attempts: 0, created: Date.now(), at: s.count, pid: String(pid || "").slice(0, 80), h: h || "", name: cmd.name || "" });
  return changed;
}

module.exports = { draftPath, labelOf, readDraft, batchRequest, pinRequest, statusText, backupsText, parseCommand, recordPrompt };

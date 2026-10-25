"use strict";
// What is due and what Claude is asked: batches, pin requests, status text, commands.
const path = require("path");
const C = require("../../core/memory-core.js");
const { MAX_DRAFT, KEEP_MSGS, MAX_UNDONE, PIN_TURNS, CMD, TESTED_CC } = require("./config");
const { nonce, int } = require("./util");
const { readSafe, unlinkSafe } = require("./fsx");
const { sid8, P, PRIV, notes, pubSafe } = require("./context");
const { readCapture, claudeCodeVersion, newerThan } = require("./transcript");

// ---------------- drafts & requests ----------------
const draftPath = (id) => path.join(P.inbox, `${id}.json`);
const labelOf = (b) => (b.kind === "recovered" ? `رسائل منسوخة ${b.label}` : `الرسائل ${b.idx.length ? `${Math.min(...b.idx)}–${Math.max(...b.idx)}` : ""}`);
function readDraft(id, created) {
  if (!pubSafe()) return { err: "مجلد .conversation-memory في المشروع رابط رمزي أو غير صالح" };
  const p = draftPath(id), r = readSafe(p, MAX_DRAFT);
  if (r.text == null && !r.bad) return null;
  if (r.bad) { unlinkSafe(p); return { err: `ملف المسودة ${r.bad}` }; }
  // ids carry a random part, so only a leftover far older than the request is suspect; the margin covers clock skew
  // between this process and a network or synced drive
  if (created && r.stat.mtimeMs < created - 10 * 60000) { unlinkSafe(p); return { err: "مسودة أقدم من الطلب (تُجوهلت)" }; }
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
  return list.length ? list.slice(0, 10).map((b, i) => `  ${i + 1}. ${b.when} — القرارات السارية: ${C.count(b.decisions, C.W.decision)}، والسجل: ${C.count(b.log, C.W.batch)}${b.goal ? `، الهدف: «${b.goal}»` : ""}`).join("\n") : "  لا توجد نسخ سابقة بعد";
}
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
// what summarizing costs, measured from the text actually sent and written (an estimate in tokens, said to be one)
function costText(s) {
  const L = [];
  if (s.lastCost.chars) L.push(`آخر تلخيص ${fmt(s.lastCost.chars)} حرفاً (الطلب والمسودة) ≈ ${fmt(C.estTokens(s.lastCost.chars))} توكن`);
  if (s.costTotal.n) L.push(`في هذه الجلسة ${C.count(s.costTotal.n, C.W.summary)} ≈ ${fmt(C.estTokens(s.costTotal.chars))} توكن`);
  if (s.injected) L.push(`الذاكرة المحمّلة عند بداية الجلسة ${fmt(s.injected)} حرفاً ≈ ${fmt(C.estTokens(s.injected))} توكن`);
  return L.length ? L.join("؛ ") + " (تقدير من عدد الحروف؛ لا يشمل ما قد يقرؤه Claude من ملف الذاكرة)" : "لم يُلخَّص شيء في هذه الجلسة بعد";
}
// which Claude Code runs here, against the newest one the plugin was tried on live
function ccLine(s) {
  let v = ""; try { v = claudeCodeVersion(s.tp); } catch {}
  if (!v) return "";
  return `\n- Claude Code: ${v}` + (newerThan(v, TESTED_CC) ? ` — أحدث من آخر نسخة جُرّب عليها البلقن حياً (${TESTED_CC}). يعمل عادة كما هو؛ وإن لاحظت خللاً بعد التحديث فأبلغ في github.com/raednov101/conversation-memory/issues` : ` (جُرّب عليها البلقن حياً حتى ${TESTED_CC})`);
}
const REVIEW_KIND = { decision: "قرار", revoke: "إلغاء قرار", "constraint-add": "إضافة قيد", "constraint-remove": "حذف قيد" };
const reviewLine = (x) => `${x.key} ${REVIEW_KIND[x.kind]} «${x.text.slice(0, 60)}»${x.reason ? ` (${x.reason})` : ""}`;
function statusText(s, mem, backups, cfg) {
  const by = (st) => s.batches.filter((b) => b.status === st).map(labelOf).join("، ") || "لا شيء";
  const m = mem.memory;
  return `[conversation-memory] حالة الذاكرة (من النظام؛ انقلها للمستخدم بإيجاز ولا تخمّن):\n` +
    `- الملف: ${P.json}${mem.bad ? ` (${mem.bad})` : mem.exists ? "" : " (لم يُنشأ بعد)"}\n` +
    `- طريقة التلخيص: ${modeText(cfg)} — للتغيير: /conversation-memory:settings\n` +
    `- رسائل هذه الجلسة: ${s.count}، منذ آخر حفظ: ${Math.max(0, s.count - s.lastBatchEnd)}${cfg.mode === "auto" ? "/" + cfg.every : ""}، آخر تحديث للملخص: ${s.lastSave || "لا يوجد بعد"}${s.lastCapture ? `، آخر نسخ للنص: ${s.lastCapture}` : ""}\n` +
    `- الكلفة: ${costText(s)}\n` +
    `- بانتظار الحفظ: ${by("pending")}\n- متعثرة: ${by("stuck")}${s.lastError ? ` (آخر خطأ: ${s.lastError})` : ""}\n- نُسخت قبل الضغط/الإغلاق: ${by("captured")}\n` +
    (m && C.reviewItems(m).length ? `- ⚠️ تنتظر مراجعتك (لم تثبت من كلامك في المحادثة، فلم تُعتمد ولم تُطبَّق): ${C.reviewItems(m).map(reviewLine).join("، ")} — اعتمد أو ارفض بـ /conversation-memory:fix\n` : "") +
    (m ? `- القرارات السارية: ${m.decisions.filter((d) => d.status === "active").length}، النصوص المعتمدة: ${m.pins.map((p) => `${p.name} (ن${p.version})`).join("، ") || "لا شيء"}، دفعات السجل: ${m.log.length}\n` : "") +
    `- النسخ السابقة (للاسترجاع: /conversation-memory:restore رقم، أو /conversation-memory:undo للأحدث):\n${backupsText(backups || [])}\n` +
    `- البيانات الخاصة: ${PRIV}` + ccLine(s);
}

// ---------------- modes ----------------
// slash commands (ours or any other) are not conversation messages: they are never counted, so a batch never waits for them
function parseCommand(prompt) {
  const t = String(prompt || "").trim();
  const slash = /^\/[A-Za-z0-9_:.-]+(\s|$)/.test(t);
  // two exact Arabic phrases work like the commands (the whole message, nothing else), and are not counted either
  if (t.startsWith(CMD + "save") || t === "احفظ الذاكرة") return { save: true, slash: true };
  if (t.startsWith(CMD + "status") || t === "حالة الذاكرة") return { status: true, slash: true };
  if (t.startsWith(CMD + "pin") && !t.startsWith(CMD + "pins")) return { pin: true, name: C.slug(t.slice((CMD + "pin").length)), slash };
  if (t.startsWith(CMD + "undo")) return { restore: 1, slash };
  if (t.startsWith(CMD + "fix")) return { fix: true, ask: t.slice((CMD + "fix").length).trim().slice(0, 500), slash };
  if (t.startsWith(CMD + "pins")) return { pins: true, args: t.slice((CMD + "pins").length).trim(), slash };
  if (t.startsWith(CMD + "share")) return { share: true, args: t.slice((CMD + "share").length).trim(), slash };
  if (t.startsWith(CMD + "trust")) return { trust: true, slash };
  if (t.startsWith(CMD + "settings")) return { settings: true, args: t.slice((CMD + "settings").length).trim(), slash };
  if (t.startsWith(CMD + "restore")) { const n = parseInt(t.slice((CMD + "restore").length), 10); return { restore: n >= 1 && n <= 99 ? n : 0, listOnly: !(n >= 1), slash }; }
  return { slash };
}
function recordPrompt(s, pid, h, cmd, cfg) {
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
  if ((cmd.save && s.count > s.lastBatchEnd) || (cfg.mode === "auto" && s.count - s.lastBatchEnd >= cfg.every)) {
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

// the project's setting in words (status, settings, notes)
const modeText = (cfg) => cfg.mode === "manual" ? "يدوي: بالأمر /conversation-memory:save فقط"
  : cfg.mode === "auto" ? `تلقائي كل ${cfg.every} رسائل`
  : "عند حدود الجلسة: قبل ضغط السياق وعند الإغلاق، دون كلفة أثناء العمل";
// /conversation-memory:settings [session | every N | auto | manual] → { cfg, changed } | { err }
function parseSettings(args, cfg) {
  const a = String(args || "").trim();
  if (!a) return { cfg, changed: false };
  const n = a.match(/^(?:every|كل)\s*(\d{1,3})(?:\s*رسائل|\s*رسالة)?$/i) || a.match(/^(\d{1,3})$/);
  if (n) { const every = +n[1]; if (every < 1 || every > C.LIMITS.every) return { err: `العدد بين 1 و${C.LIMITS.every}` }; return { cfg: { every, mode: "auto" }, changed: true }; }
  if (/^(manual|يدوي)$/i.test(a)) return { cfg: { ...cfg, mode: "manual" }, changed: true };
  if (/^(auto|تلقائي)$/i.test(a)) return { cfg: { ...cfg, mode: "auto" }, changed: true };
  if (/^(session|الجلسة|نهاية الجلسة)$/i.test(a)) return { cfg: { ...cfg, mode: "session" }, changed: true };
  return { err: `لم أفهم «${a.slice(0, 40)}». الصيغ: session (نهاية الجلسة، الافتراضي)، every 10 (أو كل 10)، manual (يدوي)، auto (تلقائي)` };
}

module.exports = { modeText, draftPath, labelOf, readDraft, batchRequest, pinRequest, statusText, costText, backupsText, parseCommand, recordPrompt, parseSettings };

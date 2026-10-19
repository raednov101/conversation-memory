"use strict";
// The memory files: the only writer. Shared write lock with the browser extension, compare-and-swap,
// backups, archive, and verified writes. Also the verbatim pin files.
const fs = require("fs");
const path = require("path");
const C = require("../../core/memory-core.js");
const { MAX_JSON, MAX_BACKUPS, TRIM_AT, WLOCK_STALE } = require("./config");
const { sleep, lst, sha256, nonce, int, today, stamp } = require("./util");
const { safeFile, readSafe, writeAtomic, writeVerified, unlinkSafe, safeDir } = require("./fsx");
const { projectDir, P, PRIV, notes, pubSafe } = require("./context");

// ---------------- the memory files (the only writer) ----------------
function readMemory() {
  const j = readSafe(P.json, MAX_JSON);
  if (j.bad) return { bad: `CONVERSATION_MEMORY.json ${j.bad}` };
  const md = readSafe(P.md, MAX_JSON);
  if (md.bad) return { bad: `CONVERSATION_MEMORY.md ${md.bad}` };
  const parsed = C.parseMemory(j.text);
  if (!parsed.ok) return { bad: parsed.error };
  return { memory: parsed.memory, jsonText: j.text, mdText: md.text, token: C.token(j.text || ""), exists: j.text != null };
}
function backupJson(text) {
  if (!text) return;
  try {
    const dir = path.join(PRIV, "backups");
    const ours = () => fs.readdirSync(dir).filter((f) => /^\d{8}-\d{6}-\d{3}\.json$/.test(f)).sort();
    let list = ours();
    if (list.length && fs.readFileSync(path.join(dir, list[list.length - 1]), "utf8") === text) return;
    writeAtomic(path.join(dir, `${stamp()}.json`), text);
    list = ours(); for (const f of list.slice(0, Math.max(0, list.length - MAX_BACKUPS))) unlinkSafe(path.join(dir, f));
  } catch {}
}
// mutate(memory) → memory'. Handles legacy migration, protects hand edits of the .md, writes both files, verifies.
// Shared with the browser extension (same protocol in offscreen.js): an advisory lock file in the project's data folder,
// "<owner> <epoch-ms>", stale after 15 s; taken by writing it and confirming it still holds our owner after a moment.
// Writers also re-read the JSON right before replacing it (compare-and-swap) and confirm the result afterwards.
const WLOCK = path.join(P.pub, "write.lock");
let heldLock = null;   // taken once per Stop, before any draft is consumed
function takeWriteLock(wait = 3000) {
  if (!pubSafe() || !safeDir(P.pub, 0o755)) return null;
  const me = nonce(8), until = Date.now() + wait;
  while (Date.now() < until) {
    const f = safeFile(WLOCK, 256);
    if (f.bad) return null;
    if (f.stat) {
      let at = 0; try { at = int(fs.readFileSync(WLOCK, "utf8").trim().split(" ")[1]); } catch {}
      if (Date.now() - (at || f.stat.mtimeMs) < WLOCK_STALE) { sleep(50); continue; }
      unlinkSafe(WLOCK);
    }
    try { const fd = fs.openSync(WLOCK, "wx", 0o644); fs.writeSync(fd, `${me} ${Date.now()}`); fs.closeSync(fd); } catch { sleep(20); continue; }
    sleep(40);
    try { if (fs.readFileSync(WLOCK, "utf8").startsWith(me + " ")) return me; } catch {}
  }
  return null;
}
// one Stop takes the lock once, before any draft is consumed, and releases it at the end
function holdWriteLock(wait) { heldLock = takeWriteLock(wait); return !!heldLock; }
function releaseWriteLock() { dropWriteLock(heldLock); heldLock = null; }
function dropWriteLock(me) { if (!me) return; try { if (fs.readFileSync(WLOCK, "utf8").startsWith(me + " ")) unlinkSafe(WLOCK); } catch {} }
function archive(entries) {
  if (!entries.length) return true;
  try { const d = path.join(P.pub, "archive"); if (!pubSafe() || !safeDir(P.pub, 0o755) || !safeDir(d, 0o755)) return false; writeVerified(path.join(d, `${stamp()}-${nonce(2)}.json`), JSON.stringify(entries, null, 1)); return true; } catch { return false; }
}
// mutate(memory) → memory'. Handles legacy migration, protects hand edits of the .md, trims for size, writes both files, verifies.
// mutate may run more than once (when another writer changed the file meanwhile), so it must be a pure function of its input.
// Without the lock nothing is written: another writer holds it (or the data folder is unusable).
function writeMemory(mutate, confirm) {
  const me = heldLock ? null : takeWriteLock();
  if (!heldLock && !me) return { err: "كاتب آخر يكتب في الذاكرة الآن", busy: true };
  try {
    let keptEdit = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = readMemory();
      if (cur.bad) return { err: cur.bad };
      let m = cur.memory;
      if (!cur.exists && cur.mdText) { m = C.importLegacy(m, cur.mdText, today()); if (!attempt) notes.push("ℹ️ ذاكرة المحادثة: نُقل محتوى CONVERSATION_MEMORY.md القديم إلى الصيغة الجديدة كما هو، تحت «من الإصدار السابق»."); }
      else if (!keptEdit && cur.exists && cur.mdText != null && m.mdHash && C.hash(cur.mdText) !== m.mdHash) {
        const keep = path.join(projectDir, `CONVERSATION_MEMORY.edited-${stamp()}.md`);
        try { writeAtomic(keep, cur.mdText); keptEdit = true; notes.push(`ℹ️ ذاكرة المحادثة: عُدّل CONVERSATION_MEMORY.md يدوياً، فحُفظت نسختك في ${path.basename(keep)} قبل إعادة توليده.`); }
        catch { return { err: "تعذّر حفظ نسختك المعدّلة يدوياً من CONVERSATION_MEMORY.md، فلم أكتب فوقها" }; }
      }
      let next = mutate(m, cur.token);
      if (!next) return { err: "لا تغيير" };
      const t = C.trimForSize(next, TRIM_AT);
      if (t.archived.length) { if (!archive(t.archived)) return { err: "الملف كبير وتعذّر نقل أقدم السجل إلى الأرشيف" }; notes.push(`ℹ️ ذاكرة المحادثة: نُقلت ${t.archived.length} دفعة قديمة إلى الأرشيف (.conversation-memory/archive/) للحفاظ على حجم الملف.`); }
      next = t.memory;
      const md = C.render(next);
      next.mdHash = C.hash(md);
      const json = C.serialize(next);
      if (Buffer.byteLength(json) > MAX_JSON) return { err: "ملف الذاكرة تجاوز 4 ميجا" };
      const again = readSafe(P.json, MAX_JSON);
      if (again.bad || again.text !== cur.jsonText) continue;   // changed meanwhile (the extension, say): redo on the new version
      try {
        backupJson(cur.jsonText);
        writeVerified(P.json, json);
        writeVerified(P.md, md);
      } catch (e) { return { err: "تعذّرت الكتابة: " + (e.code || e.message) }; }
      // confirm from the file itself, not from our copy
      const after = C.parseMemory(readSafe(P.json, MAX_JSON).text);
      if (!after.ok || (confirm && !confirm(after.memory))) continue;
      return { memory: after.memory, token: C.token(json) };
    }
    return { err: "ملف الذاكرة يتغيّر باستمرار من برنامج آخر؛ سأعيد المحاولة لاحقاً" };
  } finally { dropWriteLock(me); }
}

const pinsDirOk = () => { const s = lst(P.pins); return !s || (!s.isSymbolicLink() && s.isDirectory()); };
function savePin(name, text) {
  if (!C.pinNameOk(name)) return { err: "اسم النص غير صالح (بلا / أو : أو أسماء محجوزة)" };
  if (!pinsDirOk()) return { err: "CONVERSATION_PINS رابط رمزي أو غير صالح" };
  const d = path.join(P.pins, name);
  if (path.dirname(d) !== P.pins) return { err: "اسم النص غير صالح" };
  if (!safeDir(P.pins, 0o755) || !safeDir(d, 0o755)) return { err: "مجلد النص غير صالح" };
  const vs = fs.readdirSync(d).map((f) => (f.match(/^v(\d+)\.md$/) || [])[1]).filter(Boolean).map(Number);
  const last = vs.length ? Math.max(...vs) : 0;
  if (last) { const r = readSafe(path.join(d, `v${last}.md`), MAX_JSON); if (r.text === text) return { name, v: last, unchanged: true, sha: sha256(text) }; }
  const f = path.join(d, `v${last + 1}.md`);
  if (lst(f)) return { err: "تعارض في رقم النسخة" };
  writeAtomic(f, text);
  if (sha256(fs.readFileSync(f, "utf8")) !== sha256(text)) { unlinkSafe(f); return { err: "فشل التحقق من البصمة بعد الحفظ" }; }
  return { name, v: last + 1, sha: sha256(text) };
}

module.exports = { readMemory, writeMemory, holdWriteLock, releaseWriteLock, pinsDirOk, savePin };

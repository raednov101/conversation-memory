"use strict";
// The memory files: the only writer. Shared write lock with the browser extension, compare-and-swap,
// backups, archive, and verified writes. Also the verbatim pin files.
const fs = require("fs");
const os = require("os");
const path = require("path");
const C = require("../../core/memory-core.js");
const { MAX_JSON, MAX_BACKUPS, TRIM_AT, WLOCK_STALE } = require("./config");
const { sleep, lst, sha256, nonce, int, today, stamp } = require("./util");
const { safeFile, readSafe, writeAtomic, writeVerified, unlinkSafe, safeDir, breakStale } = require("./fsx");
const { projectDir, P, notes, pubSafe } = require("./context");

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
// Backups live in the project's data folder (.conversation-memory/backups/, git-ignored), shared with the browser
// extension, so "undo" reverts the last change whoever made it. A version is never replaced without its backup:
// if the backup can't be written, nothing is written.
const BACKUP_RE = /^\d{8}-\d{6}-\d{3}(-[a-z0-9]{1,8})?\.json$/;
const backupDir = () => path.join(P.pub, "backups");
function listBackups() {
  try { return fs.readdirSync(backupDir()).filter((f) => BACKUP_RE.test(f)).sort().reverse(); } catch { return []; }
}
function backupJson(text) {
  if (!text) return true;
  try {
    if (!pubSafe() || !safeDir(P.pub, 0o755) || !safeDir(backupDir(), 0o755)) return false;
    let list = listBackups();
    if (list.length && readSafe(path.join(backupDir(), list[0]), MAX_JSON).text === text) return true;
    let name = `${stamp()}.json`;
    while (list.includes(name)) name = `${stamp()}-${nonce(2)}.json`;
    writeVerified(path.join(backupDir(), name), text);
    list = listBackups(); for (const f of list.slice(MAX_BACKUPS)) unlinkSafe(path.join(backupDir(), f));
    return true;
  } catch { return false; }
}
// a backup as the user sees it: when, and what it held
function describeBackup(name) {
  const r = readSafe(path.join(backupDir(), name), MAX_JSON), p = r.text ? C.parseMemory(r.text) : { ok: false };
  const when = `${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)} ${name.slice(9, 11)}:${name.slice(11, 13)}`;
  if (!p.ok) return { name, when, ok: false };
  const m = p.memory;
  return { name, when, ok: true, text: r.text, memory: m, log: m.log.length, decisions: m.decisions.filter((d) => d.status === "active").length, goal: m.summary.goal.slice(0, 60) };
}
// The .md is a view of the current memory or of an earlier version (writes cut off between the two files can leave
// it several versions behind): then it is not a hand edit and is simply regenerated. Only real edits are kept aside.
function isSomeGeneratedView(mdText, current) {
  if (C.isGeneratedView(mdText, current, null)) return true;
  const h = C.hash(String(mdText));
  return listBackups().some((n) => { const d = describeBackup(n); return d.ok && (d.memory.mdHash === h || C.isGeneratedView(mdText, d.memory, null)); });
}
// Restore a backup (n = 1 is the newest one that differs from the current file). The current version is backed up
// first, so a restore can itself be undone. Called with the write lock held.
function restoreBackup(n = 1) {
  const cur = readMemory();
  if (cur.bad) return { err: cur.bad };
  const usable = listBackups().map(describeBackup).filter((b) => b.ok && b.text !== cur.jsonText);
  const b = usable[n - 1];
  if (!b) return { err: usable.length ? `لا توجد نسخة رقم ${n} (المتاح: 1 إلى ${usable.length})` : "لا توجد نسخة سابقة للاسترجاع بعد" };
  if (!backupJson(cur.jsonText)) return { err: "تعذّر حفظ النسخة الحالية احتياطياً، فلم أسترجع شيئاً" };
  const m = b.memory, md = C.render(m);
  m.mdHash = C.hash(md);
  const json = C.serialize(m);
  try { writeVerified(P.json, json); writeVerified(P.md, md); } catch (e) { return { err: "تعذّرت الكتابة: " + (e.code || e.message) }; }
  return { ok: true, when: b.when, log: b.log, decisions: b.decisions };
}
// temp files left by a write that was killed half-way (the original is intact); swept when older than a minute
function sweepTemps(dir) {
  try { for (const f of fs.readdirSync(dir)) if (/\.\d+\.[a-f0-9]{6}\.tmp$/.test(f)) { const p = path.join(dir, f), st = lst(p); if (st && st.isFile() && Date.now() - st.mtimeMs > 60000) unlinkSafe(p); } } catch {}
}
// mutate(memory) → memory'. Handles legacy migration, protects hand edits of the .md, writes both files, verifies.
// Shared with the browser extension (same protocol in offscreen.js): an advisory lock file in the project's data folder,
// "<owner> <epoch-ms>", stale after 15 s; taken by writing it and confirming it still holds our owner after a moment.
// Writers also re-read the JSON right before replacing it (compare-and-swap) and confirm the result afterwards.
const WLOCK = path.join(P.pub, "write.lock");
let heldLock = null;   // taken once per Stop, before any draft is consumed
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
function takeWriteLock(wait = 3000) {
  if (!pubSafe() || !safeDir(P.pub, 0o755)) return null;
  const me = nonce(8), until = Date.now() + wait;
  while (Date.now() < until) {
    const f = safeFile(WLOCK, 256);
    if (f.bad) return null;
    if (f.stat) {
      // "<owner> <ms> [<pid> <host>]": a holder on this machine whose process is gone (killed, crashed) is stale at once;
      // otherwise (the browser extension writes no pid) after 15 s
      let a = [], seen = null; try { seen = fs.readFileSync(WLOCK, "utf8"); a = seen.trim().split(" "); } catch {}
      const at = int(a[1]), pid = int(a[2]), gone = pid && a[3] === os.hostname() && !alive(pid);
      if (!gone && Date.now() - (at || f.stat.mtimeMs) < WLOCK_STALE) { sleep(50); continue; }
      if (seen === null) { sleep(20); continue; }
      breakStale(WLOCK, seen);
    }
    try { const fd = fs.openSync(WLOCK, "wx", 0o644); fs.writeSync(fd, `${me} ${Date.now()} ${process.pid} ${os.hostname()}`); fs.closeSync(fd); } catch { sleep(20); continue; }
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
  sweepTemps(projectDir);
  const me = heldLock ? null : takeWriteLock();
  if (!heldLock && !me) return { err: "كاتب آخر يكتب في الذاكرة الآن", busy: true };
  try {
    let keptEdit = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = readMemory();
      if (cur.bad) return { err: cur.bad };
      let m = cur.memory;
      if (!cur.exists && cur.mdText) { m = C.importLegacy(m, cur.mdText, today()); if (!attempt) notes.push("ℹ️ ذاكرة المحادثة: نُقل محتوى CONVERSATION_MEMORY.md القديم إلى الصيغة الجديدة كما هو، تحت «من الإصدار السابق»."); }
      else if (!keptEdit && cur.exists && cur.mdText != null && m.mdHash && !isSomeGeneratedView(cur.mdText, m)) {
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
      if (!backupJson(cur.jsonText)) return { err: "تعذّر حفظ نسخة احتياطية من الذاكرة الحالية، فلم أكتب فوقها", writeFailed: true };
      try {
        writeVerified(P.json, json);
        writeVerified(P.md, md);
      } catch (e) { return { err: "تعذّرت الكتابة: " + (e.code || e.message), writeFailed: true }; }
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

// every version of one pinned text, oldest first: { v, text, sha, date }
function pinVersions(name) {
  if (!C.pinNameOk(name) || !pinsDirOk()) return [];
  const d = path.join(P.pins, name), sd = lst(d);
  if (!sd || sd.isSymbolicLink() || !sd.isDirectory()) return [];
  const out = [];
  for (const f of fs.readdirSync(d)) {
    const m = f.match(/^v(\d+)\.md$/); if (!m) continue;
    const r = readSafe(path.join(d, f), MAX_JSON); if (r.text == null) continue;
    out.push({ v: +m[1], text: r.text, sha: sha256(r.text), date: new Date(r.stat.mtimeMs).toLocaleString("sv-SE").slice(0, 16) });
  }
  return out.sort((x, y) => x.v - y.v);
}
// a chosen part of the memory written for another conversation (.conversation-memory/share/, git-ignored)
function writeShare(text) {
  if (!pubSafe() || !safeDir(P.pub, 0o755)) return { err: "مجلد .conversation-memory غير صالح" };
  const d = path.join(P.pub, "share");
  if (!safeDir(d, 0o755)) return { err: "مجلد المشاركة غير صالح" };
  const f = path.join(d, `${stamp()}.md`);
  try { writeVerified(f, text); return { path: f }; } catch (e) { return { err: "تعذّرت الكتابة: " + (e.code || e.message) }; }
}

module.exports = { pinVersions, writeShare, listBackups, describeBackup, restoreBackup, sweepTemps, readMemory, writeMemory, holdWriteLock, releaseWriteLock, pinsDirOk, savePin };

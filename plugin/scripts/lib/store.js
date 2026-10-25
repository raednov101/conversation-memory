"use strict";
// The memory files: the only writer. Shared write lock with the browser extension, compare-and-swap,
// backups, archive, and verified writes. Also the verbatim pin files.
const fs = require("fs");
const os = require("os");
const path = require("path");
const C = require("../../core/memory-core.js");
const { MAX_JSON, MAX_BACKUPS, TRIM_AT, WLOCK_STALE } = require("./config");
const LIVE_HOLD = 60000;   // a hook lives 30 s at most (Claude Code kills it): a process number "alive" for longer is reused
const { sleep, lst, sha256, nonce, int, today, stamp } = require("./util");
const { safeFile, readSafe, writeAtomic, writeVerified, unlinkSafe, safeDir, breakStale } = require("./fsx");
const { projectDir, P, PRIV, notes, pubSafe } = require("./context");

// ---------------- the memory files (the only writer) ----------------
function readMemory() {
  const j = readSafe(P.json, MAX_JSON);
  if (j.bad) return { bad: `CONVERSATION_MEMORY.json ${j.bad}` };
  const md = readSafe(P.md, MAX_JSON);
  if (md.bad) return { bad: `CONVERSATION_MEMORY.md ${md.bad}` };
  const parsed = C.parseMemory(j.text);
  if (!parsed.ok) return { bad: parsed.error, brokenText: j.text };
  return { memory: parsed.memory, jsonText: j.text, mdText: md.text, token: C.token(j.text || ""), exists: j.text != null, newer: !!parsed.newer };
}
// ---------- trust: memory is loaded into a session only if it came through this plugin or the user approved it ----------
// The memory file sits in the project and may come from anywhere (a cloned repo, git pull, the browser extension writing to a
// linked folder). Loading it automatically would let whoever wrote it speak to the model at every session start. So the
// private folder keeps the fingerprints of the versions written here, and of those the user approved with /conversation-memory:trust.
const TRUST = () => path.join(PRIV, "trust.json");
function readTrust() {
  const r = readSafe(TRUST(), 2 * 1024 * 1024);
  try { const t = JSON.parse(r.text || "null"); if (t && Array.isArray(t.hashes)) return { hashes: t.hashes.filter((h) => /^[0-9a-f]{14}$/.test(h)).slice(-40), snap: t.snap || null }; } catch {}
  // a project where an earlier version of this plugin already ran: its current file was written here — trust it once
  return { hashes: [], snap: null, migrate: fs.existsSync(path.join(PRIV, "state.json")) };
}
const isTrusted = (jsonText) => { if (jsonText == null) return true; const t = readTrust(); return t.hashes.includes(C.hash(jsonText)); };
function trust(jsonText, memory) {
  const t = readTrust();
  const h = C.hash(jsonText);
  const snap = memory ? { d: memory.decisions.map((x) => x.id + "\u0001" + x.text), l: memory.log.map((e) => e.id), g: memory.summary.goal, s: memory.summary.status } : t.snap;
  try { writeAtomic(TRUST(), JSON.stringify({ hashes: [...t.hashes.filter((x) => x !== h), h].slice(-40), snap })); return true; } catch { return false; }
}
// what an untrusted file brings compared with the last trusted version — shown to the user before they approve it
function untrustedChanges(memory) {
  const t = readTrust(), snap = t.snap || { d: [], l: [], g: "", s: "" };
  const known = new Set(snap.d), logs = new Set(snap.l);
  const newDecisions = memory.decisions.filter((x) => !known.has(x.id + "\u0001" + x.text));
  const newLog = memory.log.filter((e) => !logs.has(e.id));
  return { newDecisions, newLog, summaryChanged: memory.summary.goal !== snap.g || memory.summary.status !== snap.s, first: !t.snap };
}
// Trusted once, on the first run of a version that keeps fingerprints — but only if the file's newest entry is one this
// plugin saved here (the private state lists those batches): a file changed since by anyone else still waits for the user.
function savedHere() {
  const r = readSafe(path.join(PRIV, "state.json"), MAX_JSON), ids = new Set();
  try { for (const s of Object.values(JSON.parse(r.text || "{}").sessions || {})) for (const b of (s && Array.isArray(s.batches) ? s.batches : [])) if (b && b.status === "saved" && typeof b.id === "string") ids.add(b.id); } catch {}
  return ids;
}
function migrateTrust(mem) {
  const t = readTrust();
  if (!t.migrate || !mem.exists || mem.bad || !mem.memory.log.length || !savedHere().has(mem.memory.log[mem.memory.log.length - 1].id)) return false;
  trust(mem.jsonText, mem.memory); return true;
}

// Backups live in the project's data folder (.conversation-memory/backups/, git-ignored), shared with the browser
// extension, so "undo" reverts the last change whoever made it. A version is never replaced without its backup:
// if the backup can't be written, nothing is written.
const BACKUP_RE = C.PROTOCOL.backupRe;
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
  // the name carries UTC (shared with the extension); shown in the person's own time
  const when = new Date(Date.UTC(+name.slice(0, 4), +name.slice(4, 6) - 1, +name.slice(6, 8), +name.slice(9, 11), +name.slice(11, 13), +name.slice(13, 15))).toLocaleString("sv-SE").slice(0, 16);
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
  // a broken memory file is exactly when a restore is needed: the broken file is kept aside, never thrown away
  // (a link or an oversized file is not "broken": that is refused as before)
  if (cur.bad && typeof cur.brokenText !== "string") return { err: cur.bad };
  const usable = listBackups().map(describeBackup).filter((b) => b.ok && b.text !== cur.jsonText);
  const b = usable[n - 1];
  if (!b) return { err: cur.bad ? cur.bad : usable.length ? `لا توجد نسخة رقم ${n} (المتاح: 1 إلى ${usable.length})` : "لا توجد نسخة سابقة للاسترجاع بعد" };
  if (cur.bad) {
    const keep = path.join(projectDir, `CONVERSATION_MEMORY.broken-${stamp()}.json`);
    try { writeAtomic(keep, cur.brokenText); notes.push(`ℹ️ ذاكرة المحادثة: كان ملف الذاكرة تالفاً، فحُفظ كما هو في ${path.basename(keep)} قبل الاسترجاع.`); }
    catch { return { err: "تعذّر حفظ الملف التالف جانباً، فلم أسترجع شيئاً" }; }
  } else if (!backupJson(cur.jsonText)) return { err: "تعذّر حفظ النسخة الحالية احتياطياً، فلم أسترجع شيئاً" };
  // a hand-edited .md is kept aside first, as every other write does
  if (!cur.bad && cur.exists && cur.mdText != null && cur.memory.mdHash && !isSomeGeneratedView(cur.mdText, cur.memory)) {
    const keep = path.join(projectDir, `CONVERSATION_MEMORY.edited-${stamp()}.md`);
    try { writeAtomic(keep, cur.mdText); notes.push(`ℹ️ ذاكرة المحادثة: عُدّل CONVERSATION_MEMORY.md يدوياً، فحُفظت نسختك في ${path.basename(keep)} قبل الاسترجاع.`); }
    catch { return { err: "تعذّر حفظ نسختك المعدّلة يدوياً من CONVERSATION_MEMORY.md، فلم أسترجع شيئاً" }; }
  }
  const m = b.memory, md = C.render(m);
  m.mdHash = C.hash(md);
  const json = C.serialize(m);
  try { writeVerified(P.json, json); writeVerified(P.md, md); } catch (e) { return { err: "تعذّرت الكتابة: " + (e.code || e.message) }; }
  trust(json, m);   // the user chose this version
  return { ok: true, when: b.when, log: b.log, decisions: b.decisions };
}
// temp files left by a write that was killed half-way (the original is intact); swept when older than a minute
function sweepTemps(dir) {
  try { for (const f of fs.readdirSync(dir)) if (/^CONVERSATION_MEMORY[\w.-]{0,60}\.(json|md)\.\d+\.[a-f0-9]{6}\.tmp$/.test(f)) {   // only our own files
    const p = path.join(dir, f), st = lst(p); if (st && st.isFile() && Date.now() - st.mtimeMs > 60000) unlinkSafe(p); } } catch {}
}
// mutate(memory) → memory'. Handles legacy migration, protects hand edits of the .md, writes both files, verifies.
// Shared with the browser extension (same protocol in offscreen.js): an advisory lock file in the project's data folder,
// "<owner> <epoch-ms>", stale after 15 s; taken by writing it and confirming it still holds our owner after a moment.
// Writers also re-read the JSON right before replacing it (compare-and-swap) and confirm the result afterwards.
const WLOCK = path.join(P.pub, C.PROTOCOL.writeLock);
let heldLock = null;   // taken once per Stop, before any draft is consumed
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
function takeWriteLock(wait = 3000) {
  if (!pubSafe() || !safeDir(P.pub, 0o755)) return null;
  const me = nonce(8), until = Date.now() + wait;
  while (Date.now() < until) {
    const f = safeFile(WLOCK, 256);
    // a second link exists only for the instant another process restores a live lock it set aside (breakStale): wait
    if (f.bad) { if (f.stat0 && f.stat0.nlink > 1 && f.stat0.isFile()) { sleep(20); continue; } return null; }
    if (f.stat) {
      // "<owner> <ms> [<pid> <host>]": a holder on this machine whose process is gone (killed, crashed) is stale at once;
      // otherwise (the browser extension writes no pid) after 15 s
      let a = [], seen = null; try { seen = fs.readFileSync(WLOCK, "utf8"); a = seen.trim().split(" "); } catch {}
      const at = int(a[1]), pid = int(a[2]);
      // a time in the future (clock skew, or a lock file that came with the project) can't hold the lock forever
      const t = at || f.stat.mtimeMs, future = t > Date.now() + C.PROTOCOL.futureSkew;
      // a holder on this machine that is still running is never pushed out while it can still be running (a minute);
      // every holder refreshes the time while it works, so a slow write is never taken for an abandoned one
      const here = pid && a[3] === os.hostname(), gone = here && !alive(pid);
      const fresh = here && !gone ? Date.now() - t < LIVE_HOLD : Date.now() - t < WLOCK_STALE;
      if (!gone && !future && fresh) { sleep(50); continue; }
      if (seen === null) { sleep(20); continue; }
      breakStale(WLOCK, seen);
    }
    try { const fd = fs.openSync(WLOCK, "wx", 0o644); fs.writeSync(fd, `${me} ${Date.now()} ${process.pid} ${os.hostname()}`); fs.closeSync(fd); } catch { sleep(20); continue; }
    sleep(40);
    try { if (fs.readFileSync(WLOCK, "utf8").startsWith(me + " ")) return me; } catch {}
  }
  return null;
}
// while holding: the time in the lock is refreshed, so a writer that can't see our process (the extension) never takes it as stale
function touchWriteLock(me) {
  me = me || heldLock; if (!me) return;
  try { if (fs.readFileSync(WLOCK, "utf8").startsWith(me + " ")) writeAtomic(WLOCK, `${me} ${Date.now()} ${process.pid} ${os.hostname()}`); } catch {}
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
      touchWriteLock(me);
      const cur = readMemory();
      if (cur.bad) return { err: cur.bad };
      if (cur.newer) return { err: "ملف الذاكرة كتبه إصدار أحدث من هذا البلقن؛ لم أكتب فوقه حتى لا يضيع ما أضافه. حدّث البلقن", writeFailed: true };
      let m = cur.memory;
      const baseTrusted = cur.exists ? isTrusted(cur.jsonText) : !cur.mdText;
      if (!cur.exists && cur.mdText) { m = C.importLegacy(m, cur.mdText, today()); if (!attempt) notes.push("ℹ️ ذاكرة المحادثة: نُقل محتوى CONVERSATION_MEMORY.md القديم إلى الصيغة الجديدة كما هو، تحت «من الإصدار السابق»."); }
      else if (!keptEdit && cur.exists && cur.mdText != null && m.mdHash && !isSomeGeneratedView(cur.mdText, m)) {
        const keep = path.join(projectDir, `CONVERSATION_MEMORY.edited-${stamp()}.md`);
        try { writeAtomic(keep, cur.mdText); keptEdit = true; notes.push(`ℹ️ ذاكرة المحادثة: عُدّل CONVERSATION_MEMORY.md يدوياً، فحُفظت نسختك في ${path.basename(keep)} قبل إعادة توليده.`); }
        catch { return { err: "تعذّر حفظ نسختك المعدّلة يدوياً من CONVERSATION_MEMORY.md، فلم أكتب فوقها" }; }
      }
      let next = mutate(m, cur.token);
      if (!next) return { err: "لا تغيير" };
      const t = C.trimForSize(next, TRIM_AT);
      next = t.memory;
      const md = C.render(next);
      next.mdHash = C.hash(md);
      const json = C.serialize(next);
      if (Buffer.byteLength(json) > MAX_JSON) return { err: "ملف الذاكرة تجاوز 4 ميجا" };
      if (!backupJson(cur.jsonText)) return { err: "تعذّر حفظ نسخة احتياطية من الذاكرة الحالية، فلم أكتب فوقها", writeFailed: true };
      touchWriteLock(me);
      // checked as late as possible: changed meanwhile (the extension, say) → redo on the new version, nothing archived twice
      const again = readSafe(P.json, MAX_JSON);
      if (again.bad || again.text !== cur.jsonText) continue;
      if (t.archived.length) { if (!archive(t.archived)) return { err: "الملف كبير وتعذّر نقل أقدم السجل إلى الأرشيف" }; notes.push(`ℹ️ ذاكرة المحادثة: نُقلت ${t.archived.length} دفعة قديمة إلى الأرشيف (.conversation-memory/archive/) للحفاظ على حجم الملف.`); }
      try {
        writeVerified(P.json, json);
        writeVerified(P.md, md);
      } catch (e) { return { err: "تعذّرت الكتابة: " + (e.code || e.message), writeFailed: true }; }
      // confirm from the file itself, not from our copy
      const after = C.parseMemory(readSafe(P.json, MAX_JSON).text);
      if (!after.ok || (confirm && !confirm(after.memory))) continue;
      if (baseTrusted) trust(json, after.memory);   // built on a trusted version → still trusted; else it stays for the user to approve
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
  // the next version number is claimed with an exclusive create, so two writers (two sessions, or the extension on a
  // linked folder) can never both take it; the loser simply takes the following number
  for (let tries = 0; tries < 5; tries++) {
    const vs = fs.readdirSync(d).map((f) => (f.match(/^v(\d+)\.md$/) || [])[1]).filter(Boolean).map(Number);
    const last = vs.length ? Math.max(...vs) : 0;
    if (last) { const r = readSafe(path.join(d, `v${last}.md`), MAX_JSON); if (r.text === text) return { name, v: last, unchanged: true, sha: sha256(text) }; }
    const f = path.join(d, `v${last + 1}.md`);
    try { fs.closeSync(fs.openSync(f, "wx", 0o644)); } catch (e) { if (e.code === "EEXIST") continue; throw e; }
    writeAtomic(f, text);
    if (sha256(fs.readFileSync(f, "utf8")) !== sha256(text)) { unlinkSafe(f); return { err: "فشل التحقق من البصمة بعد الحفظ" }; }
    return { name, v: last + 1, sha: sha256(text) };
  }
  return { err: "تعارض في رقم النسخة؛ أعد المحاولة" };
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

module.exports = { isTrusted, trust, untrustedChanges, migrateTrust, pinVersions, writeShare, listBackups, describeBackup, restoreBackup, sweepTemps, readMemory, writeMemory, holdWriteLock, releaseWriteLock, touchWriteLock, pinsDirOk, savePin };

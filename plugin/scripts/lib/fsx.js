"use strict";
// Safe file operations: no links, no hard links, atomic replace, read-back verification.
const fs = require("fs");
const path = require("path");
const { lst, nonce, sleep, uid } = require("./util");

// a regular file we may read or replace: not a link, single hard link, within size
function safeFile(p, max) {
  const s = lst(p);
  if (!s) return { missing: true };
  if (s.isSymbolicLink()) return { bad: "رابط رمزي (symlink)" };
  if (!s.isFile()) return { bad: "ليس ملفاً عادياً" };
  if (s.nlink > 1) return { bad: "مرتبط بملف آخر (hard link)" };
  if (max && s.size > max) return { bad: `أكبر من الحد (${Math.round(max / 1024)} ك.ب)` };
  return { stat: s };
}
function readSafe(p, max) { const f = safeFile(p, max); if (f.missing) return { text: null }; if (f.bad) return { bad: f.bad }; return { text: fs.readFileSync(p, "utf8"), stat: f.stat }; }
function writeAtomic(file, data) {
  const s = lst(file);
  if (s && (s.isSymbolicLink() || !s.isFile() || s.nlink > 1)) throw new Error("unsafe target " + path.basename(file));
  const tmp = `${file}.${process.pid}.${nonce(3)}.tmp`;
  fs.writeFileSync(tmp, data, { flag: "wx", mode: 0o600 });
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (i < 5 && ["EPERM", "EBUSY", "EACCES"].includes(e.code)) { sleep(25); continue; } // Windows: file briefly open elsewhere
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  }
}
function writeVerified(file, data) { writeAtomic(file, data); if (fs.readFileSync(file, "utf8") !== data) throw new Error("read-back mismatch " + path.basename(file)); }
const unlinkSafe = (p) => { const s = lst(p); if (s && s.isFile() && !s.isSymbolicLink()) { try { fs.unlinkSync(p); } catch {} } };
// a directory we own: not a link, (optionally) owned by us; created if missing
function safeDir(d, mode = 0o700, owner = false) {
  const s0 = lst(d);
  if (s0 && (s0.isSymbolicLink() || !s0.isDirectory())) return false;
  if (!s0) fs.mkdirSync(d, { recursive: true, mode });
  const s = lst(d);
  return !!s && s.isDirectory() && !s.isSymbolicLink() && (!owner || uid === null || s.uid === uid);
}

module.exports = { safeFile, readSafe, writeAtomic, writeVerified, unlinkSafe, safeDir };

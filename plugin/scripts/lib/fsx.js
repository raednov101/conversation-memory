"use strict";
// Safe file operations: no links, no hard links, atomic replace, read-back verification.
const fs = require("fs");
const path = require("path");
const { lst, nonce, sleep, uid } = require("./util");
const { T } = require("../../core/memory-core.js");

// a regular file we may read or replace: not a link, single hard link, within size
function safeFile(p, max) {
  const s = lst(p);
  if (!s) return { missing: true };
  if (s.isSymbolicLink()) return { bad: T("رابط رمزي (symlink)") };
  if (!s.isFile()) return { bad: T("ليس ملفاً عادياً") };
  if (s.nlink > 1) return { bad: T("مرتبط بملف آخر (hard link)"), stat0: s };
  if (max && s.size > max) return { bad: T`أكبر من الحد (${Math.round(max / 1024)} ك.ب)` };
  return { stat: s };
}
function readSafe(p, max) {
  const f = safeFile(p, max);
  if (f.missing) return { text: null };
  if (f.bad) return { bad: f.bad };
  return { text: fs.readFileSync(p, "utf8"), stat: f.stat };
}
function writeAtomic(file, data) {
  const s = lst(file);
  if (s && (s.isSymbolicLink() || !s.isFile() || s.nlink > 1)) throw new Error("unsafe target " + path.basename(file));
  const tmp = `${file}.${process.pid}.${nonce(3)}.tmp`;
  fs.writeFileSync(tmp, data, { flag: "wx", mode: 0o600 });
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i < 5 && ["EPERM", "EBUSY", "EACCES"].includes(e.code)) {
        sleep(25);
        continue;
      } // Windows: file briefly open elsewhere
      try {
        fs.unlinkSync(tmp);
      } catch {}
      throw e;
    }
  }
}
// Remove a lock judged stale — but only if it is still the very lock that was judged. Between reading it and removing it,
// its holder may have released it and another process taken a new one; deleting that one would let two writers in.
// So: move it aside atomically, check it is the one we read, and put it back if it is not.
// Remove a stale lock file, but only if it still holds exactly what the caller judged stale.
// Breakers take a tiny exclusive "<file>.break" lock first, so the re-check and the removal are one step for every
// breaker: a fresh lock created by someone else in between can never be removed (the old rename-aside-and-restore
// had a window where a third process could slip in, leaving two holders).
function breakStale(file, seen) {
  const m = file + ".break";
  try {
    fs.closeSync(fs.openSync(m, "wx", 0o600));
  } catch (e) {
    if (e.code === "EEXIST") {
      const s = lst(m);
      if (s && s.isFile() && Date.now() - s.mtimeMs > 2000) {
        try {
          fs.unlinkSync(m);
        } catch {}
      }
    }
    return;
  } // a breaker killed mid-way
  try {
    let now = null;
    try {
      now = fs.readFileSync(file, "utf8");
    } catch {}
    if (now === seen) fs.unlinkSync(file);
  } catch {
  } finally {
    try {
      fs.unlinkSync(m);
    } catch {}
  }
}
function writeVerified(file, data) {
  writeAtomic(file, data);
  if (fs.readFileSync(file, "utf8") !== data) throw new Error("read-back mismatch " + path.basename(file));
}
const unlinkSafe = (p) => {
  const s = lst(p);
  if (s && s.isFile() && !s.isSymbolicLink()) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
};
// a directory we own: not a link, (optionally) owned by us; created if missing
function safeDir(d, mode = 0o700, owner = false) {
  const s0 = lst(d);
  if (s0 && (s0.isSymbolicLink() || !s0.isDirectory())) return false;
  if (!s0) fs.mkdirSync(d, { recursive: true, mode });
  const s = lst(d);
  return !!s && s.isDirectory() && !s.isSymbolicLink() && (!owner || uid === null || s.uid === uid);
}

module.exports = { breakStale, safeFile, readSafe, writeAtomic, writeVerified, unlinkSafe, safeDir };

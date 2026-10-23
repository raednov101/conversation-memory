"use strict";
// The hook invocation: its input, the project it runs for, and where every file lives.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { readStdin, sid8of, lst } = require("./util");
const { safeDir } = require("./fsx");
const { PROTOCOL } = require("../../core/memory-core.js");

// ---------------- context ----------------
const mode = process.argv[2];
const input = readStdin();
const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
const sid = String(input.session_id || "default");
const sid8 = sid8of(sid);
const P = {
  json: path.join(projectDir, PROTOCOL.json),
  md: path.join(projectDir, PROTOCOL.md),
  pins: path.join(projectDir, PROTOCOL.pins),
  pub: path.join(projectDir, PROTOCOL.data),
  inbox: path.join(projectDir, PROTOCOL.data, "inbox"),
};
const HOME = path.join(os.homedir(), ".conversation-memory");
// one private state per project, however its path is spelled: the real path (links resolved, true letter case on
// macOS and Windows), and on Windows case-folded too (C:\\Proj and c:\\proj are the same folder)
const idPath = (() => { let p = projectDir; try { p = fs.realpathSync.native(projectDir); } catch {} return process.platform === "win32" ? p.toLowerCase() : p; })();
const PRIV = path.join(HOME, "projects", crypto.createHash("sha1").update(idPath).digest("hex").slice(0, 16));
const notes = [];

function privateDirOk() {
  try {
    if (!safeDir(HOME, 0o700, true)) return false;
    for (const d of ["projects", "status"]) if (!safeDir(path.join(HOME, d), 0o700, true)) return false;
    if (!safeDir(PRIV, 0o700, true)) return false;
    for (const d of ["captures", "events"]) if (!safeDir(path.join(PRIV, d), 0o700, true)) return false;
    return true;
  } catch { return false; }
}
// the project's data folder and its inbox are real folders, not links (checked without creating anything)
const pubSafe = () => [P.pub, P.inbox].every((d) => { const s = lst(d); return !s || (!s.isSymbolicLink() && s.isDirectory()); });
function inboxOk() {
  try {
    if (!safeDir(P.pub, 0o755) || !safeDir(P.inbox, 0o755)) return false;
    const gi = path.join(P.pub, ".gitignore");
    if (!lst(gi)) fs.writeFileSync(gi, "*\n", { flag: "wx" });
    return true;
  } catch { return false; }
}

module.exports = { mode, input, projectDir, sid, sid8, P, HOME, PRIV, notes, privateDirOk, pubSafe, inboxOk };

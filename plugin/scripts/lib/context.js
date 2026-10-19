"use strict";
// The hook invocation: its input, the project it runs for, and where every file lives.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { readStdin, sid8of, lst } = require("./util");
const { safeDir } = require("./fsx");

// ---------------- context ----------------
const mode = process.argv[2];
const input = readStdin();
const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
const sid = String(input.session_id || "default");
const sid8 = sid8of(sid);
const P = {
  json: path.join(projectDir, "CONVERSATION_MEMORY.json"),
  md: path.join(projectDir, "CONVERSATION_MEMORY.md"),
  pins: path.join(projectDir, "CONVERSATION_PINS"),
  pub: path.join(projectDir, ".conversation-memory"),
  inbox: path.join(projectDir, ".conversation-memory", "inbox"),
};
const HOME = path.join(os.homedir(), ".conversation-memory");
const PRIV = path.join(HOME, "projects", crypto.createHash("sha1").update(projectDir).digest("hex").slice(0, 16));
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

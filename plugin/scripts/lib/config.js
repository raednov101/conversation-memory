"use strict";
// Settings. One place for every limit the hooks use.

// ---------------- settings ----------------
const { LIMITS, PROTOCOL } = require("../../core/memory-core.js");
const EVERY = Math.min(LIMITS.every, Math.max(1, Math.floor(Number(process.env.CONV_MEMORY_EVERY)) || 5));
// when summaries are made, unless the project's /conversation-memory:settings says otherwise:
//   session — at the session's edges only: before compaction and at exit the unsummarized messages are copied, and are
//             summarized once, after the next answer (Claude Code keeps the full transcript, so nothing is at risk meanwhile)
//   auto    — every EVERY messages;  manual — only with /conversation-memory:save
const MODES = ["session", "auto", "manual"];
const MODE = MODES.includes(process.env.CONV_MEMORY_MODE) ? process.env.CONV_MEMORY_MODE : "session";
const INJECT_BUDGET = 5000,
  CAPTURE_BUDGET = 12000,
  PART_CHARS = 40000,
  MAX_DRAFT = 300 * 1024,
  MAX_JSON = PROTOCOL.maxJson;
const MAX_TRANSCRIPT = 50 * 1024 * 1024,
  MAX_SESSIONS = 50,
  KEEP_MSGS = 500,
  MAX_UNDONE = 2000,
  MAX_ATTEMPTS = 3,
  MAX_BACKUPS = PROTOCOL.maxBackups;
const TRIM_AT = PROTOCOL.trimAt,
  WLOCK_STALE = PROTOCOL.writeLockStale; // shared with the extension (core PROTOCOL)
const LOCK_WAIT = 5000,
  LOCK_STALE = 60000,
  PIN_TURNS = 3,
  ANCHOR_MIN = 15,
  ANCHOR_MAX = 300;
const CMD = "/conversation-memory:";

// the newest Claude Code this plugin was run against, live (npm run integration; weekly in CI). A newer one is reported by
// /conversation-memory:status so a user knows where to look if something misbehaves after an update.
const TESTED_CC = "2.1.310";
module.exports = {
  TESTED_CC,
  EVERY,
  MODE,
  MODES,
  INJECT_BUDGET,
  CAPTURE_BUDGET,
  PART_CHARS,
  MAX_DRAFT,
  MAX_JSON,
  MAX_TRANSCRIPT,
  MAX_SESSIONS,
  KEEP_MSGS,
  MAX_UNDONE,
  MAX_ATTEMPTS,
  MAX_BACKUPS,
  TRIM_AT,
  WLOCK_STALE,
  LOCK_WAIT,
  LOCK_STALE,
  PIN_TURNS,
  ANCHOR_MIN,
  ANCHOR_MAX,
  CMD,
};

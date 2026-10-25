"use strict";
// Private per-project state (counts, batches, pins) under a process lock, and the status file the indicator reads.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EVERY, MODE, MODES, MAX_JSON, MAX_SESSIONS, LOCK_WAIT, LOCK_STALE } = require("./config");
const { sleep, lst, nonce, int } = require("./util");
const { readSafe, writeAtomic, unlinkSafe, breakStale } = require("./fsx");
const { input, sid, HOME, PRIV, notes } = require("./context");
const { capture } = require("./transcript");
const C = require("../../core/memory-core.js");

// ---------------- lock (every state change happens under it) ----------------
let lockFile = null, lockToken = "";
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
function lock() {
  const f = path.join(PRIV, "lock"), until = Date.now() + LOCK_WAIT;
  while (Date.now() < until) {
    const token = `${process.pid} ${os.hostname()} ${Date.now()} ${nonce(4)}`;
    try { const fd = fs.openSync(f, "wx", 0o600); fs.writeSync(fd, token); fs.closeSync(fd); lockFile = f; lockToken = token; return true; }
    catch (e) {
      if (e.code !== "EEXIST") { if (process.env.CM_DEBUG) process.stderr.write(`lock: ${e.code}\n`); return false; }
      const s = lst(f); if (!s) continue;
      if (s.isSymbolicLink() || !s.isFile()) return false;
      let pid = 0, host = "", ts = 0, seen = null;
      try { seen = fs.readFileSync(f, "utf8"); const a = seen.trim().split(" "); pid = int(a[0]); host = a[1] || ""; ts = int(a[2]); } catch {}
      const age = Date.now() - (ts && ts <= Date.now() ? ts : s.mtimeMs);
      // stale: holder provably gone on this machine, or older than any hook can live (they are killed after 30 s)
      const dead = pid ? (host === os.hostname() && !alive(pid)) || age > LOCK_STALE : Date.now() - s.mtimeMs > 5000;
      if (dead && seen !== null) { breakStale(f, seen); continue; }
      sleep(10 + Math.floor(Math.random() * 15));
    }
  }
  return false;
}
// release only our own lock: if it was (wrongly) broken and someone else holds the file now, theirs stays
const unlock = () => { if (lockFile) { try { if (fs.readFileSync(lockFile, "utf8") === lockToken) unlinkSafe(lockFile); } catch {} } lockFile = null; lockToken = ""; };

// ---------------- private state ----------------
const STATUSES = ["pending", "saved", "stuck", "captured", "invalid"];
function normSession(v) {
  const o = v && typeof v === "object" ? v : {};
  const count = int(o.count), msgs = {}, done = {};
  for (const [i, m] of Object.entries(o.msgs || {})) { const k = int(i); if (k >= 1 && k <= count && m && typeof m === "object") msgs[k] = { p: String(m.p || "").slice(0, 80), h: /^[a-f0-9]{24}$/.test(m.h) ? m.h : "" }; }
  for (const i of Object.keys(o.done || {})) { const k = int(i); if (k >= 1 && k <= count) done[k] = 1; }
  const batches = (Array.isArray(o.batches) ? o.batches : []).filter((b) => b && typeof b.id === "string" && /^[a-z0-9-]{1,80}$/.test(b.id)).map((b) => ({
    id: b.id, idx: (Array.isArray(b.idx) ? b.idx : []).map(int).filter((x) => x >= 1 && x <= count).slice(0, 1000), label: String(b.label || "").slice(0, 40),
    kind: ["auto", "manual", "recovered"].includes(b.kind) ? b.kind : "auto", status: STATUSES.includes(b.status) ? b.status : "pending",
    attempts: int(b.attempts), created: int(b.created), base: String(b.base || "").slice(0, 20), req: int(b.req),
  })).slice(-200);
  const pins = (Array.isArray(o.pins) ? o.pins : []).filter((p) => p && /^pin-[a-f0-9]{8}$/.test(p.id)).map((p) => ({
    id: p.id, status: ["pending", "saved", "stuck", "expired"].includes(p.status) ? p.status : "pending", attempts: int(p.attempts), created: int(p.created),
    at: int(p.at), pid: String(p.pid || "").slice(0, 80), h: String(p.h || "").slice(0, 24), name: String(p.name || "").slice(0, 60),
  })).slice(-50);
  const fixes = (Array.isArray(o.fixes) ? o.fixes : []).filter((f) => f && /^fix-[a-f0-9]{8}$/.test(f.id)).map((f) => ({
    id: f.id, status: ["pending", "saved", "stuck", "expired"].includes(f.status) ? f.status : "pending", attempts: int(f.attempts), created: int(f.created),
    at: int(f.at), ask: String(f.ask || "").slice(0, 500),
  })).slice(-20);
  const cost = (c) => ({ n: int(c && c.n), chars: int(c && c.chars) });
  return { count, t: int(o.t), msgs, done, lastBatchEnd: Math.min(int(o.lastBatchEnd), count), batches, pins, fixes, tp: String(o.tp || "").slice(0, 4096), lastSave: String(o.lastSave || "").slice(0, 40), lastError: String(o.lastError || "").slice(0, 300),
    lastCapture: String(o.lastCapture || "").slice(0, 40), lastCost: cost(o.lastCost), costTotal: cost(o.costTotal), injected: int(o.injected) };
}
function loadState() {
  for (const f of ["state.json", "state.json.bak"]) {
    const r = readSafe(path.join(PRIV, f), MAX_JSON);
    if (r.text == null || r.bad) continue;
    try { const j = JSON.parse(r.text); if (j && j.v === 1 && j.sessions && typeof j.sessions === "object") { const out = { v: 1, sessions: {} }; for (const [k, s] of Object.entries(j.sessions)) out.sessions[String(k).slice(0, 100)] = normSession(s); return out; } } catch {}
  }
  if (lst(path.join(PRIV, "state.json"))) notes.push("ℹ️ ذاكرة المحادثة: ملف الحالة الخاص كان تالفاً، فبدأ عدّاد جديد. ملف الذاكرة نفسه سليم.");
  return { v: 1, sessions: {} };
}
const undone = (x) => Object.keys(x.msgs).some((i) => !x.done[i]);
const busy = (x) => x.batches.some((b) => b.status === "pending" || b.status === "stuck") || undone(x) || x.pins.some((p) => p.status === "pending") || x.fixes.some((f) => f.status === "pending");
function saveState(state) {
  if (!lockFile) return false;
  const sorted = Object.entries(state.sessions).sort((a, b) => (busy(b[1]) - busy(a[1])) || (b[1].t - a[1].t));
  for (const [id, x] of sorted.slice(MAX_SESSIONS)) {
    if (undone(x)) { try { capture(x, "evicted", x.tp, id); } catch {} if (undone(x)) notes.push("⚠️ ذاكرة المحادثة: جلسة قديمة أُزيلت من التتبع وفيها رسائل لم تُلخّص ولم يمكن نسخها."); }
  }
  state.sessions = Object.fromEntries(sorted.slice(0, MAX_SESSIONS));
  const json = JSON.stringify(state);
  try { writeAtomic(path.join(PRIV, "state.json"), json); writeAtomic(path.join(PRIV, "state.json.bak"), json); return true; }
  catch (e) {
    if (process.env.CM_DEBUG) process.stderr.write(`saveState: ${e.code || e.message}\n`);
    notes.push(`⚠️ ذاكرة المحادثة: تعذّر حفظ حالة العدّ (${e.code || "خطأ"})؛ قد يُعاد طلب تلخيص سبق.`);
    return false;
  }
}
function session(state, id = sid) {
  const s = state.sessions[id] || (state.sessions[id] = normSession(null));
  s.t = Date.now();
  if (id === sid && typeof input.transcript_path === "string" && input.transcript_path) s.tp = input.transcript_path.slice(0, 4096);
  return s;
}
// the user's choice for this project: summarize every N messages, or only on /conversation-memory:save (manual)
function loadCfg() {
  const r = readSafe(path.join(PRIV, "settings.json"), 4096);
  let o = {}; try { o = JSON.parse(r.text || "{}") || {}; } catch {}
  const every = Math.min(100, Math.max(1, Math.floor(Number(o.every)) || EVERY));
  return { every, mode: MODES.includes(o.mode) ? o.mode : MODE };
}
function saveCfg(c) { writeAtomic(path.join(PRIV, "settings.json"), JSON.stringify({ every: c.every, mode: c.mode })); }
// what the status-line indicator reads
function writeStatus(s) {
  try {
    const pend = s.batches.filter((b) => b.status === "pending").length, stuck = s.batches.filter((b) => b.status === "stuck").length, cfg = loadCfg();
    const since = Math.max(0, s.count - s.lastBatchEnd);
    const st = { v: 1, every: cfg.every, mode: cfg.mode, since: cfg.mode === "auto" ? Math.min(since, cfg.every) : since, pending: pend, stuck, lastSave: s.lastSave, lastCapture: s.lastCapture,
      cost: s.lastCost.chars ? C.estTokens(s.lastCost.chars) : 0, error: s.lastError, updated: Date.now() };
    writeAtomic(path.join(HOME, "status", `${sid.replace(/[^A-Za-z0-9-]/g, "").slice(0, 80) || "default"}.json`), JSON.stringify(st));
  } catch {}
}

// ---------------- events (queued when the lock can't be taken; replayed later) ----------------
function queueEvent(ev) { try { writeAtomic(path.join(PRIV, "events", `${Date.now()}-${nonce(4)}.json`), JSON.stringify(ev)); return true; } catch (e) { if (process.env.CM_DEBUG) process.stderr.write(`queueEvent: ${e.code || e.message}\n`); return false; } }

module.exports = { lock, unlock, normSession, loadState, saveState, session, writeStatus, queueEvent, loadCfg, saveCfg };

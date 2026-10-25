"use strict";
// Reading Claude Code's transcript, and copying unsummarized messages (complete) before they can be lost.
const fs = require("fs");
const path = require("path");
const C = require("../../core/memory-core.js");
const { PART_CHARS, MAX_TRANSCRIPT } = require("./config");
const { lst, nonce, int, sid8of, today, normText, fullHash } = require("./util");
const { readSafe, writeAtomic, unlinkSafe } = require("./fsx");
const { sid, PRIV, notes } = require("./context");

// ---------------- transcript ----------------
const NOT_A_PROMPT_RE = /^\s*(\[Request interrupted|<command-name>|<command-message>|<command-args>|<local-command-stdout>|<local-command-stderr>|<local-command-caveat>|<bash-input>|<bash-stdout>|<bash-stderr>)/;
function readTranscript(tp) {
  const s = tp && lst(tp);
  if (!s || !s.isFile() || s.isSymbolicLink()) return null;
  let raw;
  if (s.size > MAX_TRANSCRIPT) {
    const fd = fs.openSync(tp, "r"), buf = Buffer.alloc(MAX_TRANSCRIPT);
    fs.readSync(fd, buf, 0, MAX_TRANSCRIPT, s.size - MAX_TRANSCRIPT); fs.closeSync(fd);
    raw = buf.toString("utf8"); raw = raw.slice(raw.indexOf("\n") + 1);
  } else raw = fs.readFileSync(tp, "utf8");
  const turns = [];
  turns.truncated = s.size > MAX_TRANSCRIPT;   // only the newest part was read: the messages' numbers are unknown
  for (const line of raw.split("\n")) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== "object" || o.isSidechain || o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly || !o.message) continue;
    const c = o.message.content;
    if (o.type === "user") {
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) { if (c.some((b) => b && b.type === "tool_result")) continue; text = c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n"); }
      const clean = normText(text);
      if (clean && !NOT_A_PROMPT_RE.test(clean)) turns.push({ pid: typeof o.promptId === "string" ? o.promptId : "", user: clean, raw: text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ""), h: fullHash(text), assistant: [] });
    } else if (o.type === "assistant" && turns.length) {
      const t = (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n") : "").trim();
      if (t) turns[turns.length - 1].assistant.push(t);
    }
  }
  return turns;
}

// the Claude Code version that wrote the transcript (each line carries it): read from the file's end only
function claudeCodeVersion(tp) {
  const s = tp && lst(tp);
  if (!s || !s.isFile() || s.isSymbolicLink()) return "";
  const n = Math.min(s.size, 262144), buf = Buffer.alloc(n), fd = fs.openSync(tp, "r");
  try { fs.readSync(fd, buf, 0, n, s.size - n); } finally { fs.closeSync(fd); }
  const all = [...buf.toString("utf8").matchAll(/"version"\s*:\s*"(\d+\.\d+\.\d+)"/g)];
  return all.length ? all[all.length - 1][1] : "";
}
const newerThan = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };

// ---------------- capture: every unsummarized message, complete, before it can be lost ----------------
const PART_RE = /^(c-[a-z0-9]+-[a-f0-9]{8})\.p(\d{1,4})\.json$/;
function capture(s, reason, tp, forSid = sid) {
  const want = Object.keys(s.msgs).map(int).filter((i) => !s.done[i]).sort((a, b) => a - b);
  if (!want.length) return;
  const turns = readTranscript(tp);
  if (!turns) { notes.push(`⚠️ ذاكرة المحادثة: تعذّرت قراءة سجل المحادثة؛ الرسائل ${want.join("، ")} لم تُنسخ وستُعاد المحاولة.`); return; }
  const byPid = new Map(), byHash = new Map();
  turns.forEach((t, k) => { if (t.pid) byPid.set(t.pid, k); (byHash.get(t.h) || byHash.set(t.h, []).get(t.h)).push(k); });
  const used = new Set(), matched = [], missing = [];
  for (const i of [...want].reverse()) { // newest first; match by prompt id, else by full-text hash; never guess
    const m = s.msgs[i];
    let k = m.p && byPid.has(m.p) ? byPid.get(m.p) : undefined;
    if (k === undefined && m.h && byHash.has(m.h)) { const l = byHash.get(m.h).filter((x) => !used.has(x)); k = l[l.length - 1]; }
    if (k === undefined || used.has(k)) { missing.push(i); continue; }
    used.add(k); matched.push({ i, t: turns[k] });
  }
  matched.sort((a, b) => a.i - b.i);
  if (missing.length) notes.push(`⚠️ ذاكرة المحادثة: لم يُعثر في سجل المحادثة على الرسائل ${missing.sort((a, b) => a - b).join("، ")}؛ بقيت معلّقة وستُعاد محاولة نسخها.`);
  if (!matched.length) return;
  const chunks = []; let cur = "";
  for (const { i, t } of matched) {
    let block = C.redact(`### رسالة المستخدم (${i})\n${t.user}\n\n### رد Claude\n${t.assistant.join("\n\n") || "(لا يوجد نص)"}\n\n`).text;
    if (cur && cur.length + block.length > PART_CHARS) { chunks.push(cur); cur = ""; }
    while (block.length > PART_CHARS) { let cut = PART_CHARS - cur.length; const c = block.charCodeAt(cut - 1); if (c >= 0xd800 && c <= 0xdbff) cut--; chunks.push(cur + block.slice(0, cut)); block = block.slice(cut); cur = ""; }
    cur += block;
  }
  if (cur) chunks.push(cur);
  const id = `c-${sid8of(forSid)}-${nonce(4)}`, written = [];
  try {
    chunks.forEach((body, k) => { const f = path.join(PRIV, "captures", `${id}.p${k + 1}.json`); writeAtomic(f, JSON.stringify({ id, part: k + 1, of: chunks.length, idx: matched.map((m) => m.i), session: sid8of(forSid), reason, date: today(), body })); written.push(f); });
  } catch { written.forEach(unlinkSafe); notes.push("⚠️ ذاكرة المحادثة: فشل حفظ الرسائل غير الملخّصة؛ ستُعاد المحاولة."); return; }
  for (const { i } of matched) s.done[i] = 1;
  s.lastCapture = today();   // the indicator shows 📝: the text is safe, its summary comes later
  for (const b of s.batches) if ((b.status === "pending" || b.status === "stuck") && b.kind !== "recovered" && b.idx.length && b.idx.every((i) => s.done[i])) b.status = "captured";
}
// all parts 1..n present, consistent, file names matching their content — else null (never half a capture)
function readCapture(id) {
  if (!/^c-[a-z0-9]+-[a-f0-9]{8}$/.test(id)) return null;
  let files; try { files = fs.readdirSync(path.join(PRIV, "captures")).filter((f) => f.startsWith(id + ".p")); } catch { return null; }
  if (!files.length) return null;
  const parts = []; let n = 0, head = null;
  for (const f of files) {
    const m = f.match(PART_RE); if (!m || m[1] !== id) return null;
    const r = readSafe(path.join(PRIV, "captures", f), PART_CHARS * 4 + 4096); if (!r.text) return null;
    let j; try { j = JSON.parse(r.text); } catch { return null; }
    const k = int(j.part), of = int(j.of);
    if (j.id !== id || typeof j.body !== "string" || !of || k < 1 || k > of || int(m[2]) !== k || (n && of !== n) || parts[k - 1]) return null;
    n = of; head = j; parts[k - 1] = { body: j.body, file: path.join(PRIV, "captures", f) };
  }
  if (files.length !== n) return null;
  for (let k = 0; k < n; k++) if (!parts[k]) return null;
  const idx = (Array.isArray(head.idx) ? head.idx : []).map(int);
  return { id, n, parts, idx, session: String(head.session || ""), reason: String(head.reason || ""), label: idx.length ? `${Math.min(...idx)}–${Math.max(...idx)}` : "" };
}
const captureIds = () => { try { return [...new Set(fs.readdirSync(path.join(PRIV, "captures")).map((f) => (f.match(PART_RE) || [])[1]).filter(Boolean))].sort(); } catch { return []; } };
const deleteCapture = (id) => { try { for (const f of fs.readdirSync(path.join(PRIV, "captures"))) if ((f.match(PART_RE) || [])[1] === id) unlinkSafe(path.join(PRIV, "captures", f)); } catch {} };

module.exports = { claudeCodeVersion, newerThan, readTranscript, PART_RE, capture, readCapture, captureIds, deleteCapture };

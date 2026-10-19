#!/usr/bin/env node
/* conversation-memory 1.0 — command hooks for Claude Code.
 *
 * Who does what
 *   Claude  writes JSON drafts (operations) into <project>/.conversation-memory/inbox/
 *   this    decides what is due, validates every draft with the shared core, writes the memory under a lock,
 *           reads it back, and only then records success. Failures are reported, never hidden.
 *
 * Where things live
 *   <project>/CONVERSATION_MEMORY.json   source of truth (shareable)
 *   <project>/CONVERSATION_MEMORY.md     generated view
 *   <project>/CONVERSATION_PINS/<name>/vN.md   verbatim approved texts
 *   <project>/.conversation-memory/inbox/      drafts from Claude (git-ignored, untrusted until validated)
 *   ~/.conversation-memory/projects/<id>/      private state: counts, captured messages, backups, lock
 *   ~/.conversation-memory/status/<session>.json   what the status-line indicator shows
 *
 * Modes: prompt | stop | precompact | end | start | pretool.  Any internal error exits 0 (the chat is never blocked by a bug). */
"use strict";
// Entry point: decides the mode, takes the process lock, dispatches to lib/handlers.js.
// lib/: config (limits) · util · fsx (safe files) · context (input, paths) · state (private state, lock)
//       transcript (read + capture) · requests (what is due) · store (memory files) · handlers (one per event)
const { mode, input, sid, HOME, notes, privateDirOk } = require("./lib/context");
const { fullHash } = require("./lib/util");
const { lock, unlock, loadState, saveState, session, writeStatus, queueEvent } = require("./lib/state");
const { capture } = require("./lib/transcript");
const { parseCommand } = require("./lib/requests");
const { onPrompt, onStop, onStart, onPreTool, replayEvents } = require("./lib/handlers");

// ---------------- main ----------------
function main() {
  const out = {};
  try {
    if (!privateDirOk()) {
      if (mode === "start") notes.push(`⚠️ ذاكرة المحادثة: تعذّر إنشاء المجلد الخاص ${HOME}؛ الحفظ التلقائي متوقف.`);
    } else if (mode === "pretool") onPreTool(out);
    else {
      const locked = lock();
      try {
        if (!locked) {
          if (mode === "prompt") { const pr = String(input.prompt || ""); notes.push(queueEvent({ type: "prompt", sid, pid: input.prompt_id || "", h: fullHash(pr), cmd: parseCommand(pr) }) ? "⚠️ ذاكرة المحادثة: النظام مشغول؛ سُجّلت الرسالة وستُحتسب لاحقاً." : "⚠️ ذاكرة المحادثة: تعذّر تسجيل هذه الرسالة."); }
          else if (mode === "precompact" || mode === "end") notes.push(queueEvent({ type: "capture", sid, tp: String(input.transcript_path || ""), reason: mode === "end" ? "end" : "compact" }) ? "⚠️ ذاكرة المحادثة: النظام مشغول؛ سيُنسخ ما لم يُلخّص في أقرب فرصة." : "⚠️ ذاكرة المحادثة: تعذّر نسخ الرسائل غير الملخّصة الآن.");
          else if (mode === "start") onStart(null, out, false);
          else if (mode === "stop") notes.push("⚠️ ذاكرة المحادثة: النظام مشغول؛ يُتحقق من الحفظ في الرد القادم.");
        } else {
          const state = loadState();
          try {
            try { replayEvents(state); } catch {}
            if (mode === "prompt") onPrompt(state, out);
            else if (mode === "stop") onStop(state, out);
            else if (mode === "precompact" || mode === "end") { const s = session(state); capture(s, mode === "end" ? "end" : "compact", input.transcript_path); writeStatus(s); }
            else if (mode === "start") onStart(state, out, true);
          } catch (e) { notes.push(`⚠️ ذاكرة المحادثة: خطأ داخلي (${e.code || e.name || "?"}). المحادثة لم تتأثر، وما حُفظ قبله محفوظ.`); }
          finally { saveState(state); }
        }
      } finally { unlock(); }
    }
  } catch { /* never break the conversation */ }
  if (notes.length) out.systemMessage = notes.join("\n");
  if (Object.keys(out).length) process.stdout.write(JSON.stringify(out));
}
main();

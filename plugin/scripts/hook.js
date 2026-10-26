#!/usr/bin/env node
/* conversation-memory — command hooks for Claude Code.
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
// Fast exit first: most PreToolUse calls (Claude reading any file) have nothing to do with the memory, so they are
// answered before any module loads. The input is kept for lib/context.js.
{
  let raw = "";
  try {
    raw = require("fs").readFileSync(0, "utf8");
  } catch {}
  global.__cmRaw = raw;
  if (process.argv[2] === "pretool") {
    let fp = "";
    try {
      const j = JSON.parse(raw);
      fp = String((j.tool_input && j.tool_input.file_path) || "");
    } catch {}
    if (!/\.conversation-memory[\\/]/.test(fp)) process.exit(0); // only its own drafts and copies concern the plugin
  }
}
// Entry point: decides the mode, takes the process lock, dispatches to lib/handlers.js.
// lib/: config (limits) · util · fsx (safe files) · context (input, paths) · state (private state, lock)
//       transcript (read + capture) · requests (what is due) · store (memory files) · handlers (one per event)
const { mode, input, sid, HOME, notes, privateDirOk } = require("./lib/context");
const { T } = require("../core/memory-core.js");
const { fullHash } = require("./lib/util");
const { unlinkSafe } = require("./lib/fsx");
const { lock, unlock, loadState, saveState, session, writeStatus, queueEvent, loadCfg, applyLang } = require("./lib/state");
const { capture } = require("./lib/transcript");
const { parseCommand } = require("./lib/requests");
const { onPrompt, onStop, onStart, onPreTool, replayEvents } = require("./lib/handlers");

// ---------------- main ----------------
function main() {
  const out = {};
  try {
    applyLang(loadCfg(), mode === "prompt" ? input.prompt : ""); // every word below is written in this project's language
    if (!privateDirOk()) {
      if (mode === "start") notes.push(T`⚠️ ذاكرة المحادثة: تعذّر إنشاء المجلد الخاص ${HOME}؛ الحفظ التلقائي متوقف.`);
    } else if (mode === "pretool") onPreTool(out);
    else {
      const locked = lock();
      try {
        if (!locked) {
          if (mode === "prompt") {
            const pr = String(input.prompt || ""),
              cmd = parseCommand(pr),
              isCmd = !!(cmd.status || cmd.pins || cmd.share || cmd.trust || cmd.settings || cmd.restore !== undefined); // save, pin and fix still take effect when replayed
            const ok = queueEvent({ type: "prompt", sid, pid: input.prompt_id || "", h: fullHash(pr), cmd });
            // a command can't run later on its own (its answer belongs to this turn): say so instead of pretending
            notes.push(
              isCmd
                ? T("⚠️ ذاكرة المحادثة: النظام مشغول بجلسة أخرى فلم يُنفَّذ الأمر؛ أعده بعد لحظات.")
                : ok
                  ? T("⚠️ ذاكرة المحادثة: النظام مشغول؛ سُجّلت الرسالة وستُحتسب لاحقاً.")
                  : T("⚠️ ذاكرة المحادثة: تعذّر تسجيل هذه الرسالة."),
            );
            if (isCmd)
              out.hookSpecificOutput = {
                hookEventName: "UserPromptSubmit",
                additionalContext: T(
                  "[conversation-memory] النظام مشغول بجلسة أخرى فلم يُنفَّذ أمر الذاكرة هذا. أخبر المستخدم في سطر أن يعيده بعد لحظات، ولا تدّعِ أنه نُفّذ.",
                ),
              };
          } else if (mode === "precompact" || mode === "end")
            notes.push(
              queueEvent({ type: "capture", sid, tp: String(input.transcript_path || ""), reason: mode === "end" ? "end" : "compact" })
                ? T("⚠️ ذاكرة المحادثة: النظام مشغول؛ سيُنسخ ما لم يُلخّص في أقرب فرصة.")
                : T("⚠️ ذاكرة المحادثة: تعذّر نسخ الرسائل غير الملخّصة الآن."),
            );
          else if (mode === "start") onStart(null, out, false);
          else if (mode === "stop") notes.push(T("⚠️ ذاكرة المحادثة: النظام مشغول؛ يُتحقق من الحفظ في الرد القادم."));
        } else {
          const state = loadState();
          let used = [];
          try {
            try {
              used = replayEvents(state);
            } catch {}
            if (mode === "prompt") onPrompt(state, out);
            else if (mode === "stop") onStop(state, out);
            else if (mode === "precompact" || mode === "end") {
              const s = session(state);
              capture(s, mode === "end" ? "end" : "compact", input.transcript_path);
              writeStatus(s);
            } else if (mode === "start") onStart(state, out, true);
          } catch (e) {
            if (process.env.CM_DEBUG) process.stderr.write(String(e && e.stack) + "\n");
            notes.push(T`⚠️ ذاكرة المحادثة: خطأ داخلي (${e.code || e.name || "?"}). المحادثة لم تتأثر، وما حُفظ قبله محفوظ.`);
          } finally {
            if (saveState(state)) for (const p of used) unlinkSafe(p);
          }
        }
      } finally {
        unlock();
      }
    }
  } catch {
    /* never break the conversation */
  }
  if (notes.length) out.systemMessage = notes.join("\n");
  if (Object.keys(out).length) process.stdout.write(JSON.stringify(out));
}
main();

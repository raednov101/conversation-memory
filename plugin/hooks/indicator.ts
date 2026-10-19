// Status-line indicator for Claude's own interface: «🧠 3/5 · ✓ 11:20».
// It only reads the small status file the command hooks write; it never writes anything.
import type { EngineInterface, Register } from "claude-code";

type Status = { v: number; every: number; since: number; pending: number; stuck: number; lastSave: string; error: string; updated: number };

function format(s: Status): string {
  const prog = `${Math.min(s.since, s.every)}/${s.every}`;
  if (s.stuck > 0) return `🧠 ⚠️ ${prog} · تعثّر الحفظ`;
  if (s.pending > 0) return `🧠 ⏳ ${prog} · يحفظ`;
  const t = s.lastSave ? s.lastSave.slice(11, 16) : "";
  return `🧠 ${prog}` + (t ? ` · ✓ ${t}` : "");
}

async function show($: EngineInterface): Promise<void> {
  try {
    const home = (await $.env.get("HOME")) || (await $.env.get("USERPROFILE"));
    if (!home) return;
    const id = String(await $.session.id()).replace(/[^A-Za-z0-9-]/g, "").slice(0, 80) || "default";
    const text = await $.fs.read(`${home}/.conversation-memory/status/${id}.json`);
    const s = JSON.parse(String(text)) as Status;
    if (s && s.v === 1) $.ui.status(format(s));
  } catch {
    // no status yet (first message) or unreadable: show nothing rather than something wrong
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const r = await next(e);
    await show($).catch(() => {});
    return r;
  });
  on("prompt.submit", async ($, e, next) => {
    const r = await next(e);
    await show($).catch(() => {});
    return r;
  });
  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    await show($).catch(() => {});
    return r;
  });
};

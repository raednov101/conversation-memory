// Status-line indicator for Claude's own interface. Three distinct outcomes, never confused:
//   «🧠 3/5 · ✓ 11:20 · ≈600 توكن»  the summary was updated (and what it cost, estimated)
//   «🧠 3/5 · 📝 11:24»             the full text was copied (before compaction or at exit); its summary comes later
//   «🧠 ⚠️ 3/5 · تعثّر الحفظ»       saving failed — /conversation-memory:status says why
// It only reads the small status file the command hooks write; it never writes anything.
import type { EngineInterface, Register } from "claude-code";

type Status = {
  v: number;
  every: number;
  mode?: string;
  since: number;
  pending: number;
  stuck: number;
  lastSave: string;
  lastCapture?: string;
  cost?: number;
  error: string;
  lang?: string;
  updated: number;
};

// the indicator's few words, in the plugin's language (the status file says which; files from before 2.0 are Arabic)
const WORDS = {
  ar: { manual: "يدوي", session: "نهاية الجلسة", stuck: "تعثّر الحفظ", saving: "يحفظ", tokens: "توكن" },
  en: { manual: "manual", session: "session end", stuck: "save failed", saving: "saving", tokens: "tokens" },
};

export function format(s: Status): string {
  // auto: «3/5»; manual: «3 · يدوي»; session (the default): «3 · نهاية الجلسة» (summarized before compaction and at exit)
  const w = s.lang === "en" ? WORDS.en : WORDS.ar;
  const prog =
    s.mode === "auto" ? `${Math.min(s.since, s.every)}/${s.every}` : `${s.since} · ${s.mode === "manual" ? w.manual : w.session}`;
  if (s.stuck > 0) return `🧠 ⚠️ ${prog} · ${w.stuck}`;
  if (s.pending > 0) return `🧠 ⏳ ${prog} · ${w.saving}`;
  const cap = s.lastCapture || "";
  if (cap && cap > (s.lastSave || "")) return `🧠 ${prog} · 📝 ${cap.slice(11, 16)}`;
  const t = s.lastSave ? s.lastSave.slice(11, 16) : "";
  return `🧠 ${prog}` + (t ? ` · ✓ ${t}` : "") + (t && s.cost ? ` · ≈${s.cost.toLocaleString("en-US")} ${w.tokens}` : "");
}

async function show($: EngineInterface): Promise<void> {
  try {
    const home = (await $.env.get("HOME")) || (await $.env.get("USERPROFILE"));
    if (!home) return;
    const id =
      String(await $.session.id())
        .replace(/[^A-Za-z0-9-]/g, "")
        .slice(0, 80) || "default";
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

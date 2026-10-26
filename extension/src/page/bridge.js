// Talking to the rest of the extension: the writer (through the background worker) and the extension's storage.
// After an extension reload the page script is orphaned; every call then fails softly and reports "inactive".
(function (root) {
  "use strict";
  const T = root.MemoryCore.T;
  const b = { dead: false };
  b.call = async (msg) => {
    if (b.dead) return { ok: false, error: "inactive" };
    try {
      return (await chrome.runtime.sendMessage(msg)) || { ok: false, error: "no reply" };
    } catch (e) {
      if (/context invalidated/i.test(String(e))) {
        b.dead = true;
        return { ok: false, error: "inactive" };
      }
      return { ok: false, error: String((e && e.message) || e) };
    }
  };
  b.scope = "general";
  b.scopeName = ""; // the site project this page belongs to (set by the controller)
  b.fs = (op, args) =>
    b.call({ cmd: "fs", op, args: { scope: b.scope, scopeName: b.scopeName, lang: root.MemoryCore.lang(), ...(args || {}) } });
  b.get = async (k, d) => {
    try {
      return (await chrome.storage.local.get(k))[k] ?? d;
    } catch {
      b.dead = true;
      return d;
    }
  };
  b.set = async (k, v) => {
    try {
      await chrome.storage.local.set({ [k]: v });
    } catch {
      b.dead = true;
    }
  };
  // a short technical diary for bug reports: what happened, never what was said (no message text, no memory content).
  // Kept in the extension's storage (last 60 events); exported from the settings page, or attached to «أبلغ».
  // only the kind of error: the text before its first colon (a parser's message after it may quote the reply), no quotes
  const scrub = (t) =>
    String(t || "")
      .split(/[:：—]/)[0]
      .replace(/"[^"]*"|«[^»]*»|'[^']*'/g, "…")
      .replace(/["'«»]/g, "")
      .slice(0, 80);
  b.diag = async (kind, detail) => {
    try {
      const l = (await chrome.storage.local.get("diag")).diag || [],
        last = l[l.length - 1];
      if (
        last &&
        last.kind === String(kind).slice(0, 30) &&
        last.detail === scrub(detail) &&
        Date.now() - Date.parse(last.t + "Z") < 600000
      )
        return; // the same thing again: once per 10 minutes
      l.push({ t: new Date().toISOString().slice(0, 19), kind: String(kind).slice(0, 30), site: location.hostname, detail: scrub(detail) });
      await chrome.storage.local.set({ diag: l.slice(-60) });
    } catch {}
  };
  const ERR0 = () => ({
    needPermission: T("يلزم منح إذن الكتابة للمجلد"),
    inactive: T("حُدّثت الإضافة؛ حدّث هذه الصفحة (F5) لتعمل النسخة الجديدة"),
  });
  // errors raised by the browser itself arrive in English: say what they mean instead
  const RAW0 = () => [
    [/context invalidated|receiving end does not exist|could not establish connection|no reply|message port closed/i, ERR0().inactive],
    [/quota|no space|disk is full/i, T("لا توجد مساحة كافية لحفظ الذاكرة في المتصفح أو على القرص")],
    [/notallowed|permission|denied/i, T("لا يوجد إذن بالكتابة؛ افتح الإعدادات وامنحه")],
    [/notfound|could not be found|not found/i, T("الملف أو المجلد لم يعد موجوداً؛ افتح الإعدادات واختر المجلد من جديد")],
    [/nomodificationallowed|invalidstate|locked|busy/i, T("الملف مشغول الآن؛ أعد المحاولة بعد لحظات")],
    [/typeerror|referenceerror|syntaxerror|is not a function|undefined|null/i, T("خطأ داخلي في الإضافة؛ حدّث الصفحة، وإن تكرر فأبلغنا")],
  ];
  // a message the writer already wrote in English (from the catalog, maybe with values filled in) is shown as it is
  let OURS = null;
  const ours = (t) => {
    if (root.MemoryCore.lang() !== "en") return false;
    if (!OURS) {
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      OURS = Object.values(root.CM_I18N_EN || {}).map((v) => new RegExp("^" + esc(v).replace(/\\\{\d+\\\}/g, "[\\s\\S]*") + "$"));
    }
    return OURS.some((re) => re.test(t));
  };
  b.why = (e) => {
    const ERR = ERR0();
    if (ERR[e]) return ERR[e];
    const t = String(e || "");
    if (!t) return T("خطأ غير معروف");
    if (/[\u0600-\u06FF]/.test(t) || ours(t)) return t;
    const r = RAW0().find(([re]) => re.test(t));
    return r ? r[1] : T("خطأ غير متوقع: ") + t.slice(0, 80);
  };
  (root.CM = root.CM || {}).bridge = b;
})(self);

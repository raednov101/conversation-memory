// Talking to the rest of the extension: the writer (through the background worker) and the extension's storage.
// After an extension reload the page script is orphaned; every call then fails softly and reports "inactive".
(function (root) {
  "use strict";
  const b = { dead: false };
  b.call = async (msg) => {
    if (b.dead) return { ok: false, error: "inactive" };
    try { return (await chrome.runtime.sendMessage(msg)) || { ok: false, error: "no reply" }; }
    catch (e) { if (/context invalidated/i.test(String(e))) { b.dead = true; return { ok: false, error: "inactive" }; } return { ok: false, error: String((e && e.message) || e) }; }
  };
  b.scope = "general"; b.scopeName = "";   // the site project this page belongs to (set by the controller)
  b.fs = (op, args) => b.call({ cmd: "fs", op, args: { scope: b.scope, scopeName: b.scopeName, ...(args || {}) } });
  b.get = async (k, d) => { try { return (await chrome.storage.local.get(k))[k] ?? d; } catch { b.dead = true; return d; } };
  b.set = async (k, v) => { try { await chrome.storage.local.set({ [k]: v }); } catch { b.dead = true; } };
  const ERR = { noFolder: "اختر مجلد المشروع أولاً", needPermission: "يلزم منح إذن الكتابة للمجلد", inactive: "حُدّثت الإضافة؛ حدّث هذه الصفحة (F5) لتعمل النسخة الجديدة" };
  b.why = (e) => ERR[e] || e || "خطأ غير معروف";
  (root.CM = root.CM || {}).bridge = b;
})(self);

"use strict";
/* global MemoryCore, URL */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("cm", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kv(k, v) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("kv", v === undefined ? "readonly" : "readwrite");
    const q = v === undefined ? tx.objectStore("kv").get(k) : tx.objectStore("kv").put(v, k);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
}
const $ = (id) => document.getElementById(id);
// opened as the toolbar popup: the folder picker and the permission prompt would close the popup mid-way, so do them in a tab
const inPopup = new URLSearchParams(location.search).has("popup");
const openTab = () => { chrome.runtime.openOptionsPage(); window.close(); };

if (inPopup) document.body.classList.add("popup");
// which project's memory the tools below show (inside the browser each site project has its own; a linked folder is one)
const scopeSel = () => $("scopeSel").value || "general";   // a single project leaves the (hidden) selector holding it
const fsOp = (op, args) => chrome.runtime.sendMessage({ cmd: "fs", op, args: { scope: scopeSel(), ...(args || {}) } }).catch((err) => ({ ok: false, error: String(err) }));
function showMemorySections(ready) {
  $("tools").hidden = !ready || inPopup;
  const c = $("folderChip"); c.textContent = ready ? "✓ تعمل" : "يلزم إذن"; c.className = "chip " + (ready ? "ok" : "warn");
}
document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]"); if (!b) return;
  for (const x of document.querySelectorAll(".tabs button")) x.classList.toggle("on", x === b);
  for (const p of document.querySelectorAll(".pane")) p.classList.toggle("on", p.id === b.dataset.tab);
});
async function refresh() {
  const h = await kv("root");
  const s = $("folderState");
  $("unlink").hidden = !h;
  $("keepRow").hidden = $("keepNote").hidden = !!h || inPopup;   // a full copy is about what lives inside the browser
  if (!h) {   // the default: inside the browser, nothing to choose
    s.textContent = "تلقائياً داخل المتصفح، ولكل مشروع في Claude أو ChatGPT ذاكرته."; s.className = "state ok";
    $("grant").hidden = true; $("pick").textContent = "📁 ربط بمجلد على الجهاز (اختياري)";
    showMemorySections(true); await loadScopes();
    if (!inPopup) { loadMemory(); loadBackups(); }
    return;
  }
  $("scopes").hidden = true; $("scopeField").hidden = true; $("pick").textContent = "📁 تغيير المجلد";
  const p = await h.queryPermission({ mode: "readwrite" });
  showMemorySections(p === "granted");
  if (p === "granted" && !inPopup) { loadMemory(); loadBackups(); }
  s.textContent = p === "granted" ? `في مجلد «${h.name}» على جهازك.` : `مجلد «${h.name}» — يلزم منح الإذن.`;
  s.className = "state " + (p === "granted" ? "ok" : "warn");
  $("grant").hidden = p === "granted";
}
// the projects saved inside the browser: each can be downloaded as a readable file
async function loadScopes() {
  const r = await fsOp("listScopes", { scope: "general" });
  const ul = $("scopes"), sel = $("scopeSel"), keep = sel.value;
  ul.textContent = ""; sel.textContent = "";
  const list = (r && r.ok && r.list) || [];
  ul.hidden = !list.length; $("scopeField").hidden = list.length < 2;
  for (const x of list) {
    const dl = document.createElement("button"); dl.type = "button"; dl.className = "small"; dl.textContent = "⬇️ تنزيل";
    dl.onclick = async () => {
      const e = await fsOp("exportMd", { scope: x.scope });
      if (!e.ok) { dl.textContent = "تعذّر"; return; }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([e.text], { type: "text/markdown" }));
      a.download = `ذاكرة - ${String(e.name).replace(/[\\/:*?"<>|]/g, " ").slice(0, 60)}.md`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    const li = document.createElement("li"), t = document.createElement("div");
    t.className = "txt"; t.innerHTML = "<b></b> <span class=muted></span>";
    t.firstChild.textContent = x.name; t.lastChild.textContent = `— ${self.MemoryCore.count(x.decisions, self.MemoryCore.W.decision)}، ${self.MemoryCore.count(x.log, self.MemoryCore.W.batch)}`;
    li.append(t, dl); ul.append(li);
    const o = document.createElement("option"); o.value = x.scope; o.textContent = x.name; sel.append(o);
  }
  if (keep && list.some((x) => x.scope === keep)) sel.value = keep;
}
$("pick").addEventListener("click", async () => {
  if (inPopup) return openTab();
  try {
    const h = await window.showDirectoryPicker({ id: "cm-project", mode: "readwrite" });
    await h.requestPermission({ mode: "readwrite" });
    await kv("root", h);
    await chrome.storage.local.set({ folderAt: Date.now() });   // open chats re-read the folder (and its project id) at once
  } catch (e) {
    if (e.name !== "AbortError") {
      const st = $("folderState"); st.className = "state err";
      st.textContent = e.name === "SecurityError" || e.name === "NotAllowedError" ? "لم يُسمح بهذا المجلد؛ اختر مجلداً داخل مجلد المستخدم (مثل المستندات)، لا مجلد النظام." : "تعذّر اختيار المجلد؛ أعد المحاولة.";
      return;
    }
  }
  refresh();
});
$("grant").addEventListener("click", async () => {
  if (inPopup) return openTab();
  const h = await kv("root"); if (h) await h.requestPermission({ mode: "readwrite" }).catch(() => {});
  refresh();
});
$("scopeSel").addEventListener("change", () => { mem = null; openPin = null; loadMemory(); loadBackups(); });
$("unlink").addEventListener("click", async () => {
  const db = await idb(); await new Promise((res) => { const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").delete("root"); tx.oncomplete = res; tx.onerror = res; });
  await chrome.storage.local.set({ folderAt: Date.now() });
  refresh();
});
async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  $("every").value = settings.every || 10;
  $("mode").value = settings.mode || "auto";
  $("autoLink").checked = settings.autoLink !== false;
}
async function saveSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const every = Math.min(self.MemoryCore.LIMITS.every, Math.max(1, parseInt($("every").value, 10) || 10));
  await chrome.storage.local.set({ settings: { ...settings, every, mode: $("mode").value, autoLink: $("autoLink").checked } });
  $("saved").textContent = "حُفظت الإعدادات ✓";
  setTimeout(() => ($("saved").textContent = ""), 2000);
}
$("every").addEventListener("change", saveSettings);
$("mode").addEventListener("change", saveSettings);
$("autoLink").addEventListener("change", saveSettings);
loadSettings(); refresh();

// earlier versions of the memory, newest first; restoring one keeps the current version as a backup
async function loadBackups() {
  const ol = $("backups");
  const r = await fsOp("listBackups");
  ol.textContent = "";
  $("restoreMsg").textContent = r && r.broken ? `⚠️ ملف الذاكرة الحالي تالف (${r.broken}). استرجع نسخة سابقة؛ يُحفظ الملف التالف جانباً.` : "";
  if (!r || !r.ok || !r.list.length) { const li = document.createElement("li"); li.className = "muted"; li.textContent = r && !r.ok ? (r.error === "needPermission" ? "امنح إذن الكتابة للمجلد أولاً." : `تعذّرت قراءة النسخ: ${r.error}`) : "لا توجد نسخ سابقة بعد."; ol.append(li); return; }
  r.list.slice(0, 10).forEach((b, i) => {
    const li = document.createElement("li"), span = document.createElement("span"), btn = document.createElement("button");
    span.textContent = `${b.when} — ${self.MemoryCore.count(b.decisions, self.MemoryCore.W.decision)}، ${self.MemoryCore.count(b.log, self.MemoryCore.W.batch)}${b.goal ? ` — «${b.goal}»` : ""}`;
    btn.type = "button"; btn.textContent = "استرجاع"; btn.dataset.n = String(i + 1);
    li.append(span, btn); ol.append(li);
  });
}
$("backups").addEventListener("click", async (e) => {
  const n = e.target && e.target.dataset && e.target.dataset.n; if (!n) return;
  const r = await fsOp("restore", { n: +n });
  $("restoreMsg").textContent = r.ok ? `استُرجعت نسخة ${r.when}. ويمكن التراجع عن ذلك من القائمة نفسها.${r.kept ? ` وحُفظت نسختك المعدّلة يدوياً في ${r.kept}.` : ""}` : `لم يُسترجع شيء: ${r.error}`;
  loadBackups();
});

// ---------- the memory as read from the folder (for the pinned texts) ----------
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); for (const k of kids) e.append(k); return e; };
const btn = (text, onclick, title) => el("button", { type: "button", textContent: text, onclick, title: title || "" });
let mem = null;
function say(where, text) { $(where).textContent = text; }
async function loadMemory() {
  const r = await fsOp("readFull");
  if (!r || !r.ok) {
    $("pins").replaceChildren(el("li", { className: "muted", textContent: r && r.error === "needPermission" ? "امنح إذن الكتابة للمجلد أولاً." : `تعذّرت قراءة الذاكرة${r && r.error ? ": " + r.error : ""}.` }));
    return;
  }
  mem = r.memory; renderPins();
}

// ---------- pinned texts: versions, comparison, restore ----------
let openPin = null;
function renderPins() {
  const ul = $("pins"); ul.textContent = "";
  if (!mem.pins.length) ul.append(el("li", { className: "muted", textContent: "لا توجد نصوص معتمدة بعد. حدّد نصاً في المحادثة ثم «📌 ثبّت النص المحدد» من قائمة الزر الأيمن." }));
  for (const p of mem.pins) ul.append(el("li", {}, el("div", { className: "txt" }, el("b", { textContent: p.name }), ` — النسخة المعتمدة ${p.version} (${p.date})`),
    el("div", { className: "acts" }, btn("🕘 السجل والمقارنة", () => showPin(p.name)))));
  if (openPin && mem.pins.some((p) => p.name === openPin)) showPin(openPin, true); else $("pinHist").hidden = true;
}
function showDiff(vs, a, b) {
  const A = vs.find((x) => x.v === a), B = vs.find((x) => x.v === b), box = $("diff");
  box.textContent = "";
  if (!A || !B) { $("diffLabel").textContent = ""; return; }
  $("diffLabel").textContent = a === b ? `نص النسخة ${a}:` : `الفرق بين النسخة ${a} والنسخة ${b} (الأحمر حُذف، والأخضر أُضيف):`;
  const lines = a === b ? A.text.split("\n").map((line) => ({ op: " ", line })) : MemoryCore.diffLines(A.text, B.text);
  for (const d of lines) box.append(el("div", { className: d.op === "-" ? "del" : d.op === "+" ? "add" : "", textContent: (d.op === " " ? "  " : d.op + " ") + d.line }));
}
async function showPin(name, keep) {
  const r = await fsOp("pinVersions", { name });
  if (!r.ok) { say("pinMsg", `تعذّرت قراءة النسخ: ${r.error}`); return; }
  openPin = name; $("pinHist").hidden = false; $("pinTitle").textContent = `سجل «${name}» — ${self.MemoryCore.count(r.versions.length, self.MemoryCore.W.version)}`;
  const ul = $("pinVers"); ul.textContent = "";
  const vs = r.versions, cur = (mem.pins.find((p) => p.name === name) || {}).version;
  for (const x of vs.slice().reverse()) {
    const acts = el("div", { className: "acts" }, btn("عرض", () => showDiff(vs, x.v, x.v)));
    if (x.v > 1) acts.append(btn("قارن بالسابقة", () => showDiff(vs, vs[vs.indexOf(x) - 1].v, x.v)));
    if (x.v !== cur) acts.append(btn("↩️ استرجاع", async () => {
      const w = await fsOp("pinRestore", { name, v: x.v });
      say("pinMsg", w.ok ? (w.unchanged ? `«${name}» مطابق للنسخة ${x.v} أصلاً.` : `أُعيد «${name}» إلى نص النسخة ${x.v}، وحُفظ نسخةً جديدة رقم ${w.v}. النسخ السابقة باقية.`) : `لم يُسترجع: ${w.error}`);
      await loadMemory();
    }));
    ul.append(el("li", {}, el("div", { className: "txt" }, el("b", { textContent: `النسخة ${x.v}` }), `${x.v === cur ? " (المعتمدة)" : ""} — ${x.date} — ${x.text.length} حرفاً`, el("br"), el("span", { className: "muted", textContent: "بصمة " + x.sha.slice(0, 12) })), acts));
  }
  if (!keep) { if (vs.length > 1) showDiff(vs, vs[vs.length - 2].v, vs[vs.length - 1].v); else if (vs.length) showDiff(vs, vs[0].v, vs[0].v); }
}

chrome.storage.onChanged.addListener((ch) => { if (ch.folderAt && !inPopup) { loadMemory(); loadBackups(); } });

// ---------- the diagnostic diary (technical events only; see page/bridge.js) ----------
$("diagExport").addEventListener("click", async () => {
  const { diag = [] } = await chrome.storage.local.get("diag");
  const data = { extension: chrome.runtime.getManifest().version, browser: (navigator.userAgent.match(/Chrome\/[\d.]+/) || ["?"])[0], exported: new Date().toISOString(), events: diag };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  a.download = `ذاكرة المحادثة - سجل التشخيص ${new Date().toLocaleDateString("sv-SE")}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  say("diagMsg", diag.length ? `✓ نُزّل السجل (عدد الأحداث: ${diag.length})، بلا أي نص من محادثاتك.` : "✓ السجل فارغ: لم يحدث شيء يُذكر.");
});

// ---------- optional: summaries in the background with your own API key ----------
const MODEL = { anthropic: "claude-haiku-5-5", openai: "gpt-5-mini" };
const ORIGIN = { anthropic: "https://api.anthropic.com/*", openai: "https://api.openai.com/*" };
async function loadKey() {
  const { byokKey: k } = await chrome.storage.local.get("byokKey"), { settings: s = {} } = await chrome.storage.local.get("settings");
  $("provider").value = (k && k.provider) || "anthropic";
  $("model").value = (k && k.model) || MODEL[$("provider").value];
  $("apiKey").value = ""; $("apiKey").placeholder = k && k.key ? "محفوظ ••••" + k.key.slice(-4) : "sk-…";
  say("keyMsg", s.byok && k && k.key ? `✓ مفعّل: يُلخَّص في الخلفية بـ ${k.model || MODEL[k.provider]}.` : "غير مفعّل: يُلخَّص داخل المحادثة.");
}
$("provider").addEventListener("change", () => { if (Object.values(MODEL).includes($("model").value) || !$("model").value) $("model").value = MODEL[$("provider").value]; });
$("keySave").addEventListener("click", async () => {
  const provider = $("provider").value, model = $("model").value.trim() || MODEL[provider];
  const { byokKey: old } = await chrome.storage.local.get("byokKey");
  const key = $("apiKey").value.trim() || (old && old.provider === provider ? old.key : "");
  if (!/^[\x21-\x7e]{20,300}$/.test(key)) { say("keyMsg", "اكتب المفتاح أولاً."); return; }
  let granted = false; try { granted = await chrome.permissions.request({ origins: [ORIGIN[provider]] }); } catch {}
  if (!granted) { say("keyMsg", "لم يُمنح إذن الاتصال بموقع المزوّد، فلم يُفعَّل."); return; }
  await chrome.storage.local.set({ byokKey: { provider, model, key } });
  const { settings: s = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...s, byok: true } });
  loadKey();
});
$("keyTest").addEventListener("click", async () => {
  say("keyMsg", "يختبر…");
  const r = await chrome.runtime.sendMessage({ cmd: "byok", text: "Reply with the single word OK.", test: true }).catch((e) => ({ ok: false, error: String(e) }));
  say("keyMsg", r && r.ok ? `✓ المفتاح يعمل (${r.model}).` : `لم ينجح: ${(r && r.error) || "خطأ غير معروف"}`);
});
$("keyOff").addEventListener("click", async () => {
  const { byokKey: k } = await chrome.storage.local.get("byokKey");
  await chrome.storage.local.remove("byokKey");
  const { settings: s = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...s, byok: false } });
  if (k && ORIGIN[k.provider]) chrome.permissions.remove({ origins: [ORIGIN[k.provider]] }).catch(() => {});
  loadKey();
});
loadKey();

// ---------- a full copy of what is kept inside the browser (removing the extension deletes it) ----------
$("exportAll").addEventListener("click", async () => {
  const r = await fsOp("exportAll"), msg = $("keepMsg");
  if (!r || !r.ok) { msg.textContent = "تعذّر حفظ النسخة."; return; }
  if (!r.count) { msg.textContent = "لا توجد ذاكرة محفوظة بعد."; return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 1)], { type: "application/json" }));
  a.download = `ذاكرة المحادثة - نسخة كاملة ${new Date().toLocaleDateString("sv-SE")}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  msg.textContent = `✓ حُفظت نسخة فيها ${self.MemoryCore.count(r.count, self.MemoryCore.W.project)}.`;
});
$("importAll").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0], msg = $("keepMsg"); e.target.value = "";
  if (!f) return;
  if (f.size > 64 * 1024 * 1024) { msg.textContent = "الملف أكبر من المتوقع لنسخة ذاكرة."; return; }
  let data; try { data = JSON.parse(await f.text()); } catch { msg.textContent = "الملف ليس نسخة من ذاكرة المحادثة."; return; }
  const r = await fsOp("importAll", { data });
  if (!r || !r.ok) { msg.textContent = (r && r.error) || "تعذّرت الاستعادة."; return; }
  msg.textContent = `✓ استُعيد ${r.added} من المشاريع.` + (r.skipped.length ? ` لم يُستبدل ما هو موجود أصلاً: ${r.skipped.join("، ")}.` : "");
  refresh();
});

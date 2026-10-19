"use strict";
/* global MemoryCore */
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

// the memory's own sections mean nothing until a folder is chosen and writable: hide them until then
if (inPopup) document.body.classList.add("popup");
// the memory tools mean nothing until a folder is chosen and writable; the toolbar popup shows only folder and settings
function showMemorySections(ready) {
  $("tools").hidden = !ready || inPopup;
  const c = $("folderChip"); c.textContent = ready ? "✓ جاهز" : "يلزم مجلد"; c.className = "chip " + (ready ? "ok" : "warn");
}
document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]"); if (!b) return;
  for (const x of document.querySelectorAll(".tabs button")) x.classList.toggle("on", x === b);
  for (const p of document.querySelectorAll(".pane")) p.classList.toggle("on", p.id === b.dataset.tab);
});
async function refresh() {
  const h = await kv("root");
  const s = $("folderState");
  if (!h) { s.textContent = "لم يُختر بعد"; s.className = "state warn"; $("grant").hidden = true; showMemorySections(false); return; }
  const p = await h.queryPermission({ mode: "readwrite" });
  showMemorySections(p === "granted");
  if (p === "granted" && !inPopup && !mem) { loadMemory(); loadBackups(); }
  s.textContent = p === "granted" ? `«${h.name}»` : `«${h.name}» — يلزم منح الإذن`;
  s.className = "state " + (p === "granted" ? "ok" : "warn");
  $("grant").hidden = p === "granted";
}
$("pick").addEventListener("click", async () => {
  if (inPopup) return openTab();
  try {
    const h = await window.showDirectoryPicker({ id: "cm-project", mode: "readwrite" });
    await kv("root", h);
    await chrome.storage.local.set({ folderAt: Date.now() });   // open chats re-read the folder (and its project id) at once
    await h.requestPermission({ mode: "readwrite" });
  } catch (e) {
    if (e.name !== "AbortError") { const st = $("folderState"); st.textContent = "تعذّر اختيار المجلد: " + e.message; st.className = "state err"; return; }
  }
  refresh();
});
$("grant").addEventListener("click", async () => {
  if (inPopup) return openTab();
  const h = await kv("root"); if (h) await h.requestPermission({ mode: "readwrite" }).catch(() => {});
  refresh();
});

async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  $("every").value = settings.every || 5;
  $("mode").value = settings.mode || "auto";
  $("autoLink").checked = settings.autoLink !== false;
}
async function saveSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const every = Math.min(50, Math.max(1, parseInt($("every").value, 10) || 5));
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
  const r = await chrome.runtime.sendMessage({ cmd: "fs", op: "listBackups" }).catch(() => null);
  ol.textContent = "";
  if (!r || !r.ok || !r.list.length) { const li = document.createElement("li"); li.className = "muted"; li.textContent = r && !r.ok ? "اختر مجلد المشروع وامنح الإذن أولاً." : "لا توجد نسخ سابقة بعد."; ol.append(li); return; }
  r.list.slice(0, 10).forEach((b, i) => {
    const li = document.createElement("li"), span = document.createElement("span"), btn = document.createElement("button");
    span.textContent = `${b.when} — ${b.decisions} قرار، ${b.log} دفعة${b.goal ? ` — «${b.goal}»` : ""}`;
    btn.type = "button"; btn.textContent = "استرجاع"; btn.dataset.n = String(i + 1);
    li.append(span, btn); ol.append(li);
  });
}
$("backups").addEventListener("click", async (e) => {
  const n = e.target && e.target.dataset && e.target.dataset.n; if (!n) return;
  const r = await chrome.runtime.sendMessage({ cmd: "fs", op: "restore", args: { n: +n } }).catch((err) => ({ ok: false, error: String(err) }));
  $("restoreMsg").textContent = r.ok ? `استُرجعت نسخة ${r.when}. ويمكن التراجع عن ذلك من القائمة نفسها.` : `لم يُسترجع شيء: ${r.error}`;
  loadBackups();
});
if (!inPopup) loadBackups();

// ---------- correcting the memory ----------
// Every change is one "fix" (the same shape as the plugin's /conversation-memory:fix): validated, backed up, undoable.
const fsOp = (op, args) => chrome.runtime.sendMessage({ cmd: "fs", op, args }).catch((err) => ({ ok: false, error: String(err) }));
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); for (const k of kids) e.append(k); return e; };
const btn = (text, onclick, title) => el("button", { type: "button", textContent: text, onclick, title: title || "" });
const SRC = { user: "قرارك", "assistant-approved": "اقتراح اعتمدته", assistant: "اقتراح لم يُعتمد" };
let mem = null;

function say(where, text, withUndo) {
  const p = $(where); p.textContent = text;
  if (withUndo) p.append(btn("↩️ تراجع", async () => { const r = await fsOp("restore", { n: 1 }); say(where, r.ok ? `تراجعت: عادت نسخة ${r.when}.` : `لم يُسترجع شيء: ${r.error}`); loadMemory(); loadBackups(); }));
}
async function applyFix(fix) {
  const r = await fsOp("fix", { fix });
  if (r.ok) say("fixMsg", `✓ ${r.changes.join("، ")}${r.redacted ? " (وحُذفت بيانات حساسة)" : ""}.`, true);
  else say("fixMsg", `لم يتغيّر شيء: ${r.error}`);
  await loadMemory(); loadBackups();
  return r.ok;
}
function editRow(li, current, onSave) {
  const ta = el("textarea", { value: current, rows: 2 });
  li.replaceChildren(el("div", { className: "txt" }, ta), el("div", { className: "acts" }, btn("حفظ", () => { const t = ta.value.trim(); if (t && t !== current) onSave(t); else loadMemory(); }), btn("إلغاء", () => loadMemory())));
  ta.focus();
}
function renderMemory() {
  const m = mem;
  $("sGoal").value = m.summary.goal || ""; $("sStatus").value = m.summary.status || "";
  const ds = $("decisions"); ds.textContent = "";
  const act = m.decisions.filter((d) => d.status === "active");
  if (!act.length) ds.append(el("li", { className: "muted", textContent: "لا توجد قرارات محفوظة." }));
  for (const d of act) {
    const li = el("li");
    const txt = el("div", { className: "txt" }, el("b", { textContent: d.id + " " }), d.text, el("span", { className: "tag" + (d.source === "assistant" ? " sug" : ""), textContent: SRC[d.source] || d.source }));
    const acts = el("div", { className: "acts" });
    if (d.source === "assistant") acts.append(btn("✅ اعتماد", () => applyFix({ decisions: { approve: [d.id] } }), "وافقت عليه: يصير قراراً معتمداً"));
    acts.append(btn("✏️ تعديل", () => editRow(li, d.text, (t) => applyFix({ decisions: { edit: [{ id: d.id, text: t }] } })), "صحّح نصه"),
      btn("🚫 إلغاء", () => applyFix({ decisions: { revoke: [d.id] } }), "لم يعد سارياً؛ يبقى في سجل الملغى"),
      btn("🗑️ حذف", () => applyFix({ decisions: { remove: [d.id] } }), "حذف نهائي لمعلومة خاطئة أو حساسة"));
    li.append(txt, acts); ds.append(li);
  }
  const cs = $("constraints"); cs.textContent = "";
  if (!m.constraints.length) cs.append(el("li", { className: "muted", textContent: "لا توجد قيود محفوظة." }));
  for (const c of m.constraints) {
    const li = el("li");
    li.append(el("div", { className: "txt", textContent: c }), el("div", { className: "acts" },
      btn("✏️ تعديل", () => editRow(li, c, (t) => applyFix({ constraints: { remove: [c], add: [t] } }))),
      btn("🗑️ حذف", () => applyFix({ constraints: { remove: [c] } }))));
    cs.append(li);
  }
  const lg = $("log"); lg.textContent = "";
  const entries = m.log.slice(-15).reverse();
  if (!entries.length) lg.append(el("li", { className: "muted", textContent: "السجل فارغ." }));
  for (const e of entries) {
    // no "·" next to a number (it reads as a zero in Arabic text): parts are separated by a long dash, the date kept left-to-right
    const range = (e.range || "").split(/[–-]/), where = [e.chat, range.length === 2 ? `الرسائل من ${range[0]} إلى ${range[1]}` : e.range].filter(Boolean).join(" — ");
    const first = e.raised[0] || e.decided[0] || e.changed[0] || "";
    const meta = el("span", { className: "muted" }, where + (e.date ? " — " : ""), e.date ? el("bdi", { dir: "ltr", textContent: e.date }) : "");
    lg.append(el("li", {}, el("div", { className: "txt" }, el("b", { textContent: MemoryCore.PLATFORMS[e.platform] || e.platform }), " ", meta, el("br"), el("span", { textContent: first })),
      el("div", { className: "acts" }, btn("🗑️ حذف الدفعة", () => applyFix({ log: { remove: [e.id] } })))));
  }
  renderPins();
}
$("sSave").addEventListener("click", () => {
  const goal = $("sGoal").value.trim(), status = $("sStatus").value.trim();
  if (!goal && !status) { say("fixMsg", "اكتب الهدف أو الوضع على الأقل."); return; }
  applyFix({ summary: { goal, status, next: mem.summary.next, open: mem.summary.open } });
});
async function loadMemory() {
  const r = await fsOp("readFull");
  if (!r || !r.ok) {
    for (const id of ["decisions", "constraints", "log", "pins"]) $(id).replaceChildren(el("li", { className: "muted", textContent: r && r.error === "noFolder" ? "اختر مجلد المشروع أولاً." : r && r.error === "needPermission" ? "امنح إذن الكتابة للمجلد أولاً." : `تعذّرت قراءة الذاكرة${r && r.error ? ": " + r.error : ""}.` }));
    return;
  }
  mem = r.memory; renderMemory();
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
  openPin = name; $("pinHist").hidden = false; $("pinTitle").textContent = `سجل «${name}» — ${r.versions.length} ${r.versions.length === 1 ? "نسخة" : "نسخ"}`;
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

if (!inPopup) loadMemory();
chrome.storage.onChanged.addListener((ch) => { if (ch.folderAt && !inPopup) { loadMemory(); loadBackups(); } });

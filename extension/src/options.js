"use strict";
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

async function refresh() {
  const h = await kv("root");
  const s = $("folderState");
  if (!h) { s.textContent = "لم يُختر بعد"; s.className = "state warn"; $("grant").hidden = true; return; }
  const p = await h.queryPermission({ mode: "readwrite" });
  s.textContent = p === "granted" ? `«${h.name}» — جاهز ✓` : `«${h.name}» — يلزم منح الإذن`;
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

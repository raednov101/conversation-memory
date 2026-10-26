"use strict";
/* global MemoryCore, URL */
const T = self.MemoryCore.T;
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("cm", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kv(k, v) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("kv", v === undefined ? "readonly" : "readwrite");
    const q = v === undefined ? tx.objectStore("kv").get(k) : tx.objectStore("kv").put(v, k);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
const $ = (id) => document.getElementById(id);
// opened as the toolbar popup: the folder picker and the permission prompt would close the popup mid-way, so do them in a tab
const inPopup = new URLSearchParams(location.search).has("popup");
const openTab = () => {
  chrome.runtime.openOptionsPage();
  window.close();
};

if (inPopup) document.body.classList.add("popup");
// which project's memory the tools below show (inside the browser each site project has its own; a linked folder is one)
const scopeSel = () => $("scopeSel").value || "general"; // a single project leaves the (hidden) selector holding it
const fsOp = (op, args) =>
  chrome.runtime
    .sendMessage({ cmd: "fs", op, args: { scope: scopeSel(), lang: self.MemoryCore.lang(), ...(args || {}) } })
    .catch((err) => ({ ok: false, error: String(err) }));
function showMemorySections(ready) {
  $("tools").hidden = !ready || inPopup;
  const c = $("folderChip");
  c.textContent = ready ? T("✓ تعمل") : T("يلزم إذن");
  c.className = "chip " + (ready ? "ok" : "warn");
}
document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  for (const x of document.querySelectorAll(".tabs button")) x.classList.toggle("on", x === b);
  for (const p of document.querySelectorAll(".pane")) p.classList.toggle("on", p.id === b.dataset.tab);
});
async function refresh() {
  const h = await kv("root");
  const s = $("folderState");
  $("unlink").hidden = !h;
  $("keepRow").hidden = $("keepNote").hidden = !!h || inPopup; // a full copy is about what lives inside the browser
  if (!h) {
    // the default: inside the browser, nothing to choose
    s.textContent = T("تلقائياً داخل المتصفح، ولكل مشروع في Claude أو ChatGPT ذاكرته.");
    s.className = "state ok";
    $("grant").hidden = true;
    $("pick").textContent = T("📁 ربط بمجلد على الجهاز (اختياري)");
    showMemorySections(true);
    await loadScopes();
    if (!inPopup) {
      loadMemory();
      loadBackups();
      loadHistory();
    }
    return;
  }
  $("scopes").hidden = true;
  $("scopeField").hidden = true;
  $("pick").textContent = T("📁 تغيير المجلد");
  const p = await h.queryPermission({ mode: "readwrite" });
  showMemorySections(p === "granted");
  if (p === "granted" && !inPopup) {
    loadMemory();
    loadBackups();
    loadHistory();
  }
  s.textContent = p === "granted" ? T`في مجلد «${h.name}» على جهازك.` : T`مجلد «${h.name}» — يلزم منح الإذن.`;
  s.className = "state " + (p === "granted" ? "ok" : "warn");
  $("grant").hidden = p === "granted";
}
// the projects saved inside the browser: each can be downloaded as a readable file
async function loadScopes() {
  const r = await fsOp("listScopes", { scope: "general" });
  const ul = $("scopes"),
    sel = $("scopeSel"),
    keep = sel.value;
  ul.textContent = "";
  sel.textContent = "";
  const list = (r && r.ok && r.list) || [];
  ul.hidden = !list.length;
  $("scopeField").hidden = list.length < 2;
  for (const x of list) {
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "small";
    dl.textContent = T("⬇️ تنزيل");
    dl.onclick = async () => {
      const e = await fsOp("exportMd", { scope: x.scope });
      if (!e.ok) {
        dl.textContent = T("تعذّر");
        return;
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([e.text], { type: "text/markdown" }));
      a.download = T`ذاكرة - ${String(e.name)
        .replace(/[\\/:*?"<>|]/g, " ")
        .slice(0, 60)}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    const li = document.createElement("li"),
      t = document.createElement("div");
    t.className = "txt";
    t.innerHTML = "<b></b> <span class=muted></span>";
    t.firstChild.textContent = x.name;
    t.lastChild.textContent = T`— ${self.MemoryCore.count(x.decisions, self.MemoryCore.W.decision)}، ${self.MemoryCore.count(x.log, self.MemoryCore.W.summary)}`;
    li.append(t, dl);
    // the shared memory of an earlier version: split it, chat by chat, after a preview
    if (/general$/.test(x.scope)) {
      const sp = document.createElement("button");
      sp.type = "button";
      sp.className = "small";
      sp.dataset.split = x.scope;
      sp.textContent = T("✂️ افصلها حسب المحادثة");
      sp.onclick = () => showSplit(x.scope, li);
      li.append(sp);
    }
    ul.append(li);
    const o = document.createElement("option");
    o.value = x.scope;
    o.textContent = x.name;
    sel.append(o);
  }
  if (keep && list.some((x) => x.scope === keep)) sel.value = keep;
  const want = decodeURIComponent((location.hash.match(/^#history=([a-z0-9-]{1,80})$/) || [])[1] || "");
  if (want && list.some((x) => x.scope === want) && sel.value !== want) {
    sel.value = want;
    sel.dispatchEvent(new Event("change"));
  }
}
// what each chat holds in the shared memory, and moving one chat's part to its own memory
async function showSplit(from, li) {
  li.querySelector(".split")?.remove();
  const box = document.createElement("div");
  box.className = "split";
  li.append(box);
  const r = await fsOp("splitPlan", { scope: from, from });
  if (!r.ok || !r.groups.length) {
    box.textContent = r.ok ? T("لا توجد محادثات يمكن فصلها في هذه الذاكرة.") : T`تعذّر: ${r.error}`;
    return;
  }
  const head = document.createElement("p");
  head.className = "muted";
  head.textContent = T("كل محادثة تُنقل بسجلها وقراراتها إلى ذاكرتها الخاصة، وتبقى القيود في الاثنتين. ويمكن التراجع من «النسخ السابقة».");
  box.append(head);
  const all = await chrome.storage.local.get(null);
  for (const g of r.groups) {
    // the chat's whole key: from its saved text, or from the chats this browser linked to the shared memory
    const full =
      g.key.length > 24
        ? g.key
        : Object.keys(all)
            .find((k) => k.startsWith("scope:") && k.slice(6).slice(0, 24) === g.prefix && all[k].key === from)
            ?.slice(6) || g.key;
    const row = document.createElement("div"),
      label = document.createElement("span"),
      go = document.createElement("button");
    row.className = "row";
    label.textContent = T`${g.label || full} — ${self.MemoryCore.count(g.entries, self.MemoryCore.W.summary)}، ${self.MemoryCore.count(g.decisions, self.MemoryCore.W.decision)}`;
    go.type = "button";
    go.className = "small";
    go.textContent = T("انقلها إلى ذاكرتها");
    go.onclick = async () => {
      go.disabled = true;
      const m = await fsOp("splitMove", { scope: from, from, key: full });
      if (!m.ok) {
        go.disabled = false;
        label.textContent += " — " + T`تعذّر: ${m.error}`;
        return;
      }
      // the chat now belongs to its own memory: its link and progress go with it
      const st = await chrome.storage.local.get([`chat:${m.fromProject}:${full}`]);
      const upd = { [`scope:${full}`]: { key: m.to, name: g.label || "" } };
      if (st[`chat:${m.fromProject}:${full}`]) upd[`chat:${m.toProject}:${full}`] = st[`chat:${m.fromProject}:${full}`];
      await chrome.storage.local.set(upd);
      await chrome.storage.local.remove(`chat:${m.fromProject}:${full}`);
      label.textContent = T`✓ نُقلت: ${self.MemoryCore.count(m.moved.log, self.MemoryCore.W.summary)}، ${self.MemoryCore.count(m.moved.decisions, self.MemoryCore.W.decision)}`;
      setTimeout(loadScopes, 1500);
    };
    row.append(label, go);
    box.append(row);
  }
}
$("pick").addEventListener("click", async () => {
  if (inPopup) return openTab();
  try {
    const h = await window.showDirectoryPicker({ id: "cm-project", mode: "readwrite" });
    await h.requestPermission({ mode: "readwrite" });
    await kv("root", h);
    await chrome.storage.local.set({ folderAt: Date.now() }); // open chats re-read the folder (and its project id) at once
  } catch (e) {
    if (e.name !== "AbortError") {
      const st = $("folderState");
      st.className = "state err";
      st.textContent =
        e.name === "SecurityError" || e.name === "NotAllowedError"
          ? T("لم يُسمح بهذا المجلد؛ اختر مجلداً داخل مجلد المستخدم (مثل المستندات)، لا مجلد النظام.")
          : T("تعذّر اختيار المجلد؛ أعد المحاولة.");
      return;
    }
  }
  refresh();
});
$("grant").addEventListener("click", async () => {
  if (inPopup) return openTab();
  const h = await kv("root");
  if (h) await h.requestPermission({ mode: "readwrite" }).catch(() => {});
  refresh();
});
$("scopeSel").addEventListener("change", () => {
  mem = null;
  openPin = null;
  loadMemory();
  loadBackups();
  loadHistory();
});
$("unlink").addEventListener("click", async () => {
  const db = await idb();
  await new Promise((res) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").delete("root");
    tx.oncomplete = res;
    tx.onerror = res;
  });
  await chrome.storage.local.set({ folderAt: Date.now() });
  refresh();
});
// the page is written in Arabic and translates itself: every text, title, placeholder and label found in the catalog
function translatePage() {
  const en = self.MemoryCore.lang() === "en";
  document.documentElement.lang = en ? "en" : "ar";
  document.documentElement.dir = en ? "ltr" : "rtl";
  if (!en) return;
  const tr = (s) => {
    const k = s.replace(/\s+/g, " ").trim();
    const v = k && T(k);
    return v && v !== k ? s.replace(/\S[\s\S]*\S|\S/, v) : s;
  };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (/[\u0600-\u06FF]/.test(n.nodeValue)) n.nodeValue = tr(n.nodeValue);
  for (const a of ["title", "placeholder", "aria-label"])
    for (const el of document.querySelectorAll(`[${a}]`)) el.setAttribute(a, tr(el.getAttribute(a)));
  document.title = tr(document.title);
}
async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  $("lang").value = settings.lang || "auto";
  $("every").value = settings.every || 10;
  $("mode").value = settings.mode || "auto";
  $("autoLink").checked = settings.autoLink !== false;
}
async function saveSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const every = Math.min(self.MemoryCore.LIMITS.every, Math.max(1, parseInt($("every").value, 10) || 10));
  await chrome.storage.local.set({ settings: { ...settings, every, mode: $("mode").value, autoLink: $("autoLink").checked } });
  $("saved").textContent = T("حُفظت الإعدادات ✓");
  setTimeout(() => ($("saved").textContent = ""), 2000);
}
$("every").addEventListener("change", saveSettings);
$("mode").addEventListener("change", saveSettings);
$("autoLink").addEventListener("change", saveSettings);
// Gemini is optional: the browser asks for the site once; turning it off gives the site back
const GEMINI = "https://gemini.google.com/*";
chrome.permissions.contains({ origins: [GEMINI] }).then(
  (on) => ($("gemini").checked = on),
  () => {},
);
$("gemini").addEventListener("change", async (e) => {
  const want = e.target.checked;
  let ok = false;
  try {
    ok = want ? await chrome.permissions.request({ origins: [GEMINI] }) : await chrome.permissions.remove({ origins: [GEMINI] });
  } catch {}
  if (!ok) e.target.checked = !want;
  $("geminiMsg").textContent = ok
    ? want
      ? T("شُغّلت في Gemini؛ افتح محادثة هناك (أو حدّث صفحتها). هذه نسخة تجريبية: إن لاحظت خللاً فأبلغنا.")
      : T("أُوقفت في Gemini.")
    : T("لم يُمنح الإذن؛ بقي الوضع كما كان.");
});
$("lang").addEventListener("change", async () => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, lang: $("lang").value } });
  location.reload(); // every text on the page is drawn again in the new language
});
// ---------- the welcome tour: four short steps on first open, again from the footer ----------
let tourAt = 1;
function showTour(on) {
  $("welcome").hidden = !on;
  if (!on) return;
  const steps = [...document.querySelectorAll("#welcome .step")];
  steps.forEach((x) => (x.hidden = +x.dataset.step !== tourAt));
  $("tourBack").hidden = tourAt === 1;
  $("tourNext").textContent = tourAt === steps.length ? T("ابدأ") : T("التالي");
  $("tourDots").textContent = `${tourAt} / ${steps.length}`;
}
async function endTour() {
  showTour(false);
  try {
    await chrome.storage.local.set({ welcomeSeen: true });
  } catch {}
}
$("tourNext").addEventListener("click", () => {
  if (tourAt >= document.querySelectorAll("#welcome .step").length) return endTour();
  tourAt++;
  showTour(true);
});
$("tourBack").addEventListener("click", () => {
  tourAt = Math.max(1, tourAt - 1);
  showTour(true);
});
$("tourSkip").addEventListener("click", endTour);
$("tourAgain").addEventListener("click", () => {
  tourAt = 1;
  showTour(true);
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// the language first, so everything drawn after it (and every request to the writer) speaks it
chrome.storage.local.get("settings").then(({ settings = {} }) => {
  self.MemoryCore.setLang(settings.lang || "auto");
  translatePage();
  chrome.storage.local.get("welcomeSeen").then(
    ({ welcomeSeen }) => !welcomeSeen && !inPopup && showTour(true),
    () => {},
  );
  loadSettings();
  refresh();
});

// earlier versions of the memory, newest first; restoring one keeps the current version as a backup
async function loadBackups() {
  const ol = $("backups");
  const r = await fsOp("listBackups");
  ol.textContent = "";
  $("restoreMsg").textContent =
    r && r.broken ? T`⚠️ ملف الذاكرة الحالي تالف (${r.broken}). استرجع نسخة سابقة؛ يُحفظ الملف التالف جانباً.` : "";
  if (!r || !r.ok || !r.list.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent =
      r && !r.ok
        ? r.error === "needPermission"
          ? T("امنح إذن الكتابة للمجلد أولاً.")
          : T`تعذّرت قراءة النسخ: ${r.error}`
        : T("لا توجد نسخ سابقة بعد.");
    ol.append(li);
    return;
  }
  r.list.slice(0, 10).forEach((b, i) => {
    const li = document.createElement("li"),
      span = document.createElement("span"),
      btn = document.createElement("button");
    span.textContent = T`${b.when} — ${self.MemoryCore.count(b.decisions, self.MemoryCore.W.decision)}، ${self.MemoryCore.count(b.log, self.MemoryCore.W.summary)}${b.goal ? ` — «${b.goal}»` : ""}`;
    btn.type = "button";
    btn.textContent = T("استرجاع");
    btn.dataset.n = String(i + 1);
    li.append(span, btn);
    ol.append(li);
  });
}
$("backups").addEventListener("click", async (e) => {
  const n = e.target && e.target.dataset && e.target.dataset.n;
  if (!n) return;
  const r = await fsOp("restore", { n: +n });
  $("restoreMsg").textContent = r.ok
    ? T`استُرجعت نسخة ${r.when}. ويمكن التراجع عن ذلك من القائمة نفسها.${r.kept ? T` وحُفظت نسختك المعدّلة يدوياً في ${r.kept}.` : ""}`
    : T`لم يُسترجع شيء: ${r.error}`;
  loadBackups();
});

// ---------- the history: every change, why, and undoing one ----------
async function loadHistory() {
  const ol = $("history");
  const r = await fsOp("history");
  ol.textContent = "";
  if (!r || !r.ok || !r.list.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = r && !r.ok ? T`تعذّرت قراءة السجل: ${r.error}` : T("لا تغييرات مسجّلة بعد.");
    ol.append(li);
    return;
  }
  const BY = {
    summary: T("ملخص"),
    review: T("مراجعتك"),
    fix: T("تصحيح"),
    restore: T("استرجاع"),
    undo: T("تراجع"),
    pin: T("تثبيت"),
    import: T("استيراد"),
    write: T("كتابة"),
  };
  for (const e of r.list) {
    const li = document.createElement("li"),
      span = document.createElement("span"),
      b = document.createElement("button");
    span.textContent = `${e.at} · ${e.what}`;
    span.title = e.id;
    const why = document.createElement("small");
    why.className = "muted";
    why.textContent = ` — ${e.why || BY[e.by] || e.by}`; // the reason when there is one («summary of messages 1–5»), else what made it
    span.append(why);
    b.type = "button";
    b.textContent = T("↩️ تراجع");
    b.style.whiteSpace = "nowrap";
    b.dataset.ev = e.id;
    li.append(span, b);
    ol.append(li);
  }
}
$("history").addEventListener("click", async (e) => {
  const id = e.target && e.target.dataset && e.target.dataset.ev;
  if (!id) return;
  const r = await fsOp("undoEvent", { id });
  say("histMsg", r.ok ? T`تُرجع عن هذا التغيير وحده: ${r.what}. والتراجع نفسه في السجل.` : T`لم يُتراجع: ${r.error}`);
  loadHistory();
  loadBackups();
});

// ---------- the memory as read from the folder (for the pinned texts) ----------
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const k of kids) e.append(k);
  return e;
};
const btn = (text, onclick, title) => el("button", { type: "button", textContent: text, onclick, title: title || "" });
let mem = null;
function say(where, text) {
  $(where).textContent = text;
}
async function loadMemory() {
  const r = await fsOp("readFull");
  if (!r || !r.ok) {
    $("pins").replaceChildren(
      el("li", {
        className: "muted",
        textContent:
          r && r.error === "needPermission"
            ? T("امنح إذن الكتابة للمجلد أولاً.")
            : T`تعذّرت قراءة الذاكرة${r && r.error ? ": " + r.error : ""}.`,
      }),
    );
    return;
  }
  mem = r.memory;
  renderPins();
}

// ---------- pinned texts: versions, comparison, restore ----------
let openPin = null;
function renderPins() {
  const ul = $("pins");
  ul.textContent = "";
  if (!mem.pins.length)
    ul.append(
      el("li", {
        className: "muted",
        textContent: T("لا توجد نصوص معتمدة بعد. حدّد نصاً في المحادثة ثم «📌 ثبّت النص المحدد» من قائمة الزر الأيمن."),
      }),
    );
  for (const p of mem.pins)
    ul.append(
      el(
        "li",
        {},
        el("div", { className: "txt" }, el("b", { textContent: p.name }), T` — النسخة المعتمدة ${p.version} (${p.date})`),
        el(
          "div",
          { className: "acts" },
          btn(T("🕘 السجل والمقارنة"), () => showPin(p.name)),
        ),
      ),
    );
  if (openPin && mem.pins.some((p) => p.name === openPin)) showPin(openPin, true);
  else $("pinHist").hidden = true;
}
function showDiff(vs, a, b) {
  const A = vs.find((x) => x.v === a),
    B = vs.find((x) => x.v === b),
    box = $("diff");
  box.textContent = "";
  if (!A || !B) {
    $("diffLabel").textContent = "";
    return;
  }
  $("diffLabel").textContent = a === b ? T`نص النسخة ${a}:` : T`الفرق بين النسخة ${a} والنسخة ${b} (الأحمر حُذف، والأخضر أُضيف):`;
  const lines = a === b ? A.text.split("\n").map((line) => ({ op: " ", line })) : MemoryCore.diffLines(A.text, B.text);
  for (const d of lines)
    box.append(
      el("div", { className: d.op === "-" ? "del" : d.op === "+" ? "add" : "", textContent: (d.op === " " ? "  " : d.op + " ") + d.line }),
    );
}
async function showPin(name, keep) {
  const r = await fsOp("pinVersions", { name });
  if (!r.ok) {
    say("pinMsg", T`تعذّرت قراءة النسخ: ${r.error}`);
    return;
  }
  openPin = name;
  $("pinHist").hidden = false;
  $("pinTitle").textContent = T`سجل «${name}» — ${self.MemoryCore.count(r.versions.length, self.MemoryCore.W.version)}`;
  const ul = $("pinVers");
  ul.textContent = "";
  const vs = r.versions,
    cur = (mem.pins.find((p) => p.name === name) || {}).version;
  for (const x of vs.slice().reverse()) {
    const acts = el(
      "div",
      { className: "acts" },
      btn(T("عرض"), () => showDiff(vs, x.v, x.v)),
    );
    if (x.v > 1) acts.append(btn(T("قارن بالسابقة"), () => showDiff(vs, vs[vs.indexOf(x) - 1].v, x.v)));
    if (x.v !== cur)
      acts.append(
        btn(T("↩️ استرجاع"), async () => {
          const w = await fsOp("pinRestore", { name, v: x.v });
          say(
            "pinMsg",
            w.ok
              ? w.unchanged
                ? T`«${name}» مطابق للنسخة ${x.v} أصلاً.`
                : T`أُعيد «${name}» إلى نص النسخة ${x.v}، وحُفظ نسخةً جديدة رقم ${w.v}. النسخ السابقة باقية.`
              : T`لم يُسترجع: ${w.error}`,
          );
          await loadMemory();
        }),
      );
    ul.append(
      el(
        "li",
        {},
        el(
          "div",
          { className: "txt" },
          el("b", { textContent: T`النسخة ${x.v}` }),
          T`${x.v === cur ? T(" (المعتمدة)") : ""} — ${x.date} — ${x.text.length} حرفاً`,
          el("br"),
          el("span", { className: "muted", textContent: T("بصمة ") + x.sha.slice(0, 12) }),
        ),
        acts,
      ),
    );
  }
  if (!keep) {
    if (vs.length > 1) showDiff(vs, vs[vs.length - 2].v, vs[vs.length - 1].v);
    else if (vs.length) showDiff(vs, vs[0].v, vs[0].v);
  }
}

chrome.storage.onChanged.addListener((ch) => {
  if (ch.folderAt && !inPopup) {
    loadMemory();
    loadBackups();
    loadHistory();
  }
});

// ---------- the diagnostic diary (technical events only; see page/bridge.js) ----------
$("diagExport").addEventListener("click", async () => {
  const { diag = [] } = await chrome.storage.local.get("diag");
  const data = {
    extension: chrome.runtime.getManifest().version,
    browser: (navigator.userAgent.match(/Chrome\/[\d.]+/) || ["?"])[0],
    exported: new Date().toISOString(),
    events: diag,
  };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  a.download = T`ذاكرة المحادثة - سجل التشخيص ${new Date().toLocaleDateString("sv-SE")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  say(
    "diagMsg",
    diag.length ? T`✓ نُزّل السجل (عدد الأحداث: ${diag.length})، بلا أي نص من محادثاتك.` : T("✓ السجل فارغ: لم يحدث شيء يُذكر."),
  );
});

// ---------- optional: summaries in the background with your own API key ----------
const MODEL = { anthropic: "claude-haiku-5-5", openai: "gpt-5-mini" };
const ORIGIN = { anthropic: "https://api.anthropic.com/*", openai: "https://api.openai.com/*" };
// the key is kept in the extension's own database (its origin), which the scripts running on the chat sites can't open
const keyGet = () => kv("byokKey").catch(() => undefined);
const keyPut = (v) => kv("byokKey", v);
async function keyDel() {
  const db = await idb();
  await new Promise((res) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").delete("byokKey");
    tx.oncomplete = res;
    tx.onerror = res;
  });
}
async function loadKey() {
  const k = await keyGet(),
    { settings: s = {} } = await chrome.storage.local.get("settings");
  $("provider").value = (k && k.provider) || "anthropic";
  $("model").value = (k && k.model) || MODEL[$("provider").value];
  $("apiKey").value = "";
  $("apiKey").placeholder = k && k.key ? T("محفوظ ••••") + k.key.slice(-4) : "sk-…";
  $("keyOff").hidden = !(k && k.key); // nothing to turn off before a key is saved
  say(
    "keyMsg",
    s.byok && k && k.key ? T`✓ مفعّل: يُلخَّص في الخلفية بـ ${k.model || MODEL[k.provider]}.` : T("غير مفعّل: يُلخَّص داخل المحادثة."),
  );
}
$("provider").addEventListener("change", () => {
  if (Object.values(MODEL).includes($("model").value) || !$("model").value) $("model").value = MODEL[$("provider").value];
});
$("keySave").addEventListener("click", async () => {
  const provider = $("provider").value,
    model = $("model").value.trim() || MODEL[provider],
    typed = $("apiKey").value.trim();
  // asked first, while the click still counts as yours (the browser refuses a permission request after other waits)
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [ORIGIN[provider]] });
  } catch {}
  if (!granted) {
    say("keyMsg", T("لم يُمنح إذن الاتصال بموقع المزوّد، فلم يُفعَّل."));
    return;
  }
  const old = await keyGet();
  const key = typed || (old && old.provider === provider ? old.key : "");
  if (!/^[\x21-\x7e]{20,300}$/.test(key)) {
    say("keyMsg", T("اكتب المفتاح أولاً."));
    return;
  }
  await keyPut({ provider, model, key });
  const { settings: s = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...s, byok: true } });
  loadKey();
});
$("keyTest").addEventListener("click", async () => {
  say("keyMsg", T("يختبر…"));
  const r = await chrome.runtime
    .sendMessage({ cmd: "byok", text: "Reply with the single word OK.", test: true })
    .catch((e) => ({ ok: false, error: String(e) }));
  say("keyMsg", r && r.ok ? T`✓ المفتاح يعمل (${r.model}).` : T`لم ينجح: ${(r && r.error) || T("خطأ غير معروف")}`);
});
$("keyOff").addEventListener("click", async () => {
  const k = await keyGet();
  await keyDel();
  const { settings: s = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...s, byok: false } });
  if (k && ORIGIN[k.provider]) chrome.permissions.remove({ origins: [ORIGIN[k.provider]] }).catch(() => {});
  loadKey();
});
loadKey();

// ---------- a full copy of what is kept inside the browser (removing the extension deletes it) ----------
$("exportAll").addEventListener("click", async () => {
  const r = await fsOp("exportAll"),
    msg = $("keepMsg");
  if (!r || !r.ok) {
    msg.textContent = T("تعذّر حفظ النسخة.");
    return;
  }
  if (!r.count) {
    msg.textContent = T("لا توجد ذاكرة محفوظة بعد.");
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 1)], { type: "application/json" }));
  a.download = T`ذاكرة المحادثة - نسخة كاملة ${new Date().toLocaleDateString("sv-SE")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  msg.textContent = T`✓ حُفظت نسخة فيها ${self.MemoryCore.count(r.count, self.MemoryCore.W.project)}.`;
});
$("importAll").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0],
    msg = $("keepMsg");
  e.target.value = "";
  if (!f) return;
  if (f.size > 64 * 1024 * 1024) {
    msg.textContent = T("الملف أكبر من المتوقع لنسخة ذاكرة.");
    return;
  }
  let data;
  try {
    data = JSON.parse(await f.text());
  } catch {
    msg.textContent = T("الملف ليس نسخة من ذاكرة المحادثة.");
    return;
  }
  const r = await fsOp("importAll", { data });
  if (!r || !r.ok) {
    msg.textContent = (r && r.error) || T("تعذّرت الاستعادة.");
    return;
  }
  msg.textContent =
    T`✓ استُعيد ${r.added} من المشاريع.` + (r.skipped.length ? T` لم يُستبدل ما هو موجود أصلاً: ${r.skipped.join(T("، "))}.` : "");
  refresh();
});

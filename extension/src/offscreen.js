// The only code that touches the project folder. Uses the shared core (memory-core.js, identical to the plugin's).
// Every memory write: read → (migrate / keep hand edits) → apply → re-read to detect a concurrent writer → backup → write → read back.
"use strict";
const C = self.MemoryCore;
const JSON_FILE = "CONVERSATION_MEMORY.json", MD_FILE = "CONVERSATION_MEMORY.md", PINS = "CONVERSATION_PINS", DATA = ".conversation-memory";
const MAX_JSON = 4 * 1024 * 1024, TRIM_AT = 3 * 1024 * 1024, MAX_BACKUPS = 20, STATE_BUDGET = 3000, COMPACT_BUDGET = 5000, WLOCK_STALE = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nonce = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
const today = () => new Date().toLocaleString("sv-SE").slice(0, 16);
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(".", "-").slice(0, 19);

// ---------- where the memory lives ----------
// By default inside the browser (the extension's private file system: no folder to choose, no permission to grant),
// one folder per project of the site (a Claude or ChatGPT project; "general" for chats outside any project).
// If the user links a folder on their computer (to share the memory with Claude Code), everything goes there instead.
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("cm", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kvSet(k, v) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction("kv", "readwrite"); const q = tx.objectStore("kv").put(v, k); q.onsuccess = () => res(true); q.onerror = () => rej(q.error); }); }
async function kvGet(k) { const db = await idb(); return new Promise((res, rej) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
let SCOPE = "general", SCOPE_NAME = "";   // set for each request (requests run one at a time, under the "cm-write" lock)
const cleanScope = (s) => (/^[a-z0-9-]{1,80}$/.test(String(s || "")) ? String(s) : "general");
// the browser's own storage: no other program can reach it, and navigator.locks("cm-write") already runs one request at a time,
// so the file lock shared with the Claude Code plugin is not needed there
const IN_BROWSER = new WeakSet();
async function browserRoot(scope = SCOPE) { const d = await dir(await navigator.storage.getDirectory(), ["projects", scope]); IN_BROWSER.add(d); return d; }
async function root() {
  const h = await kvGet("root");
  if (!h) return { h: await browserRoot(), inBrowser: true };
  if ((await h.queryPermission({ mode: "readwrite" })) !== "granted") return { err: "needPermission" };
  return { h };
}
async function scopeNames() { return (await kvGet("scopeNames")) || {}; }
async function rememberScopeName() {
  if (!SCOPE_NAME) return;
  const n = await scopeNames(); if (n[SCOPE] === SCOPE_NAME) return;
  n[SCOPE] = SCOPE_NAME.slice(0, 80); await kvSet("scopeNames", n);
}
const scopeLabel = async (scope) => (scope === "general" ? "محادثات خارج المشاريع" : (await scopeNames())[scope] || scope);

// ---------- fs helpers ----------
async function dir(base, parts, create = true) { let d = base; for (const p of parts) d = await d.getDirectoryHandle(p, { create }); return d; }
async function readText(d, name) {
  try { const f = await (await d.getFileHandle(name)).getFile(); if (f.size > MAX_JSON) throw new Error(`${name} أكبر من 4 ميجا`); return await f.text(); }
  catch (e) { if (e.name === "NotFoundError" || e.name === "TypeMismatchError") return null; throw e; }
}
async function writeVerified(d, name, text) {
  const fh = await d.getFileHandle(name, { create: true });
  const w = await fh.createWritable();            // a swap file; the original is replaced only on close()
  await w.write(text); await w.close();
  if ((await (await fh.getFile()).text()) !== text) throw new Error("فشل التحقق بعد الكتابة: " + name);
}
async function sha256(t) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
async function dataDir(r) {
  const d = await dir(r, [DATA]);
  if ((await readText(d, ".gitignore")) === null) await writeVerified(d, ".gitignore", "*\n");
  return d;
}
// Backups in .conversation-memory/backups/, shared with the Claude Code plugin (same names, same folder), so "undo"
// reverts the last change whoever made it. A version is never replaced without its backup.
const BACKUP_RE = /^\d{8}-\d{6}-\d{3}(-[a-z0-9]{1,8})?\.json$/;
async function backupNames(r) {
  const b = await dir(await dataDir(r), ["backups"]);
  const names = [];
  for await (const [n, h] of b.entries()) if (h.kind === "file" && BACKUP_RE.test(n)) names.push(n);
  return { b, names: names.sort().reverse() };   // newest first
}
async function backupJson(r, text) {
  if (!text) return;
  const { b, names } = await backupNames(r);
  if (names.length && (await readText(b, names[0])) === text) return;
  let name = `${stamp()}.json`;
  while (names.includes(name)) name = `${stamp()}-${nonce().slice(0, 4)}.json`;
  await writeVerified(b, name, text);   // throws if it can't be written: then nothing else is written either
  names.unshift(name);
  for (const n of names.slice(MAX_BACKUPS)) await b.removeEntry(n).catch(() => {});
}
// The .md is a view of the current memory or of an earlier version (writes cut off between the two files can leave it
// several versions behind): then it is not a hand edit and is simply regenerated. Only real edits are kept aside.
async function isSomeGeneratedView(r, mdText, current) {
  if (C.isGeneratedView(mdText, current, null)) return true;
  const h = C.hash(String(mdText)), { b, names } = await backupNames(r);
  for (const n of names) { const p = C.parseMemory(await readText(b, n)); if (p.ok && (p.memory.mdHash === h || C.isGeneratedView(mdText, p.memory, null))) return true; }
  return false;
}
async function describeBackups(r, currentText) {
  const { b, names } = await backupNames(r), out = [];
  for (const n of names) {
    const text = await readText(b, n), p = C.parseMemory(text);
    if (!p.ok || text === currentText) continue;
    const m = p.memory;
    out.push({ name: n, when: `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 8)} ${n.slice(9, 11)}:${n.slice(11, 13)}`, text, memory: m,
      log: m.log.length, decisions: m.decisions.filter((d) => d.status === "active").length, goal: m.summary.goal.slice(0, 60) });
  }
  return out;
}

// ---------- the memory (the only writer in the extension) ----------
async function readMemory(r) {
  const jsonText = await readText(r, JSON_FILE), mdText = await readText(r, MD_FILE);
  const p = C.parseMemory(jsonText);
  if (!p.ok) return { bad: p.error };
  return { memory: p.memory, jsonText, mdText, token: C.token(jsonText || ""), exists: jsonText != null };
}
// Shared with the Claude Code plugin (same protocol in hook.js): an advisory lock file ".conversation-memory/write.lock",
// "<owner> <epoch-ms>", stale after 15 s; taken by writing it and confirming it still holds our owner a moment later.
async function takeWriteLock(r) {
  if (IN_BROWSER.has(r)) return { browser: true };
  const d = await dataDir(r), me = nonce(), until = Date.now() + 3000;
  while (Date.now() < until) {
    // the other writer may be replacing the lock file while we read it: that read fails, which only means "busy, look again"
    let held = false;
    try {
      const f = await (await d.getFileHandle("write.lock")).getFile(), at = +String(await f.text()).trim().split(" ")[1] || f.lastModified;
      held = Date.now() - at < WLOCK_STALE;
    } catch (e) { if (e && e.name !== "NotFoundError") { await sleep(50); continue; } }
    if (held) { await sleep(50); continue; }
    try { await writeVerified(d, "write.lock", `${me} ${Date.now()}`); } catch { await sleep(50); continue; }
    await sleep(40);
    let mine = false; try { mine = String(await readText(d, "write.lock")).startsWith(me + " "); } catch {}
    if (mine) return { d, me };
  }
  return null;
}
async function dropWriteLock(lk) { if (!lk || lk.browser) return; try { if (String(await readText(lk.d, "write.lock")).startsWith(lk.me + " ")) await lk.d.removeEntry("write.lock"); } catch {} }
async function archive(r, entries) {
  if (!entries.length) return;
  await writeVerified(await dir(await dataDir(r), ["archive"]), `${stamp()}-${nonce().slice(0, 4)}.json`, JSON.stringify(entries, null, 1));
}
// mutate(memory, token) → { memory, extra } | { err }; it may run more than once, so it must depend only on its input.
// confirm(memoryReadBackFromFile) → true when our change is really in the file (not just in our copy).
// Without the lock nothing is written: { err, busy: true } and the caller tries again later.
async function writeMemory(r, mutate, confirm, held) {
  const notes = [];
  let keptEdit = false;
  const lk = held || await takeWriteLock(r);
  if (!lk) return { err: "برنامج آخر يكتب في الذاكرة الآن", busy: true };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await readMemory(r);
      if (cur.bad) return { err: cur.bad + " — لم أكتب فوقه؛ أصلحه أو انقله ثم أعد المحاولة" };
      let m = cur.memory;
      if (!cur.exists && cur.mdText) { m = C.importLegacy(m, cur.mdText, today()); if (!attempt) notes.push("نُقل محتوى CONVERSATION_MEMORY.md القديم كما هو تحت «من الإصدار السابق»."); }
      else if (!keptEdit && cur.exists && cur.mdText != null && m.mdHash && !(await isSomeGeneratedView(r, cur.mdText, m))) {
        const name = `CONVERSATION_MEMORY.edited-${stamp()}.md`;
        await writeVerified(r, name, cur.mdText);
        keptEdit = true; notes.push(`عُدّل CONVERSATION_MEMORY.md يدوياً، فحُفظت نسختك في ${name} قبل إعادة توليده.`);
      }
      const out = mutate(m, cur.token);
      if (out.err) return { err: out.err };
      const t = C.trimForSize(out.memory, TRIM_AT);
      if (t.archived.length) { await archive(r, t.archived); notes.push(`نُقلت ${t.archived.length} دفعة قديمة إلى الأرشيف (.conversation-memory/archive/) للحفاظ على حجم الملف.`); }
      const next = t.memory;
      const md = C.render(next);
      next.mdHash = C.hash(md);
      const json = C.serialize(next);
      if (new Blob([json]).size > MAX_JSON) return { err: "ملف الذاكرة سيتجاوز 4 ميجا" };
      if ((await readText(r, JSON_FILE)) !== cur.jsonText) continue;   // someone else wrote meanwhile: start over on their version
      try { await backupJson(r, cur.jsonText); } catch { return { err: "تعذّر حفظ نسخة احتياطية من الذاكرة الحالية، فلم أكتب فوقها" }; }
      await writeVerified(r, JSON_FILE, json);
      await writeVerified(r, MD_FILE, md);
      const after = C.parseMemory(await readText(r, JSON_FILE));        // confirm from the file itself
      if (!after.ok || (confirm && !confirm(after.memory))) continue;
      return { memory: after.memory, notes, extra: out.extra };
    }
    return { err: "الملف يتغيّر باستمرار من برنامج آخر؛ أعد المحاولة بعد قليل" };
  } finally { if (!held) await dropWriteLock(lk); }
}

// the current state the model needs to write a correct draft: summary, active decisions with ids, constraints
function stateForPrompt(m) {
  const s = m.summary, L = [];
  if (s.goal) L.push(`الهدف: ${s.goal}`);
  if (s.status) L.push(`الوضع: ${s.status}`);
  if (s.next.length) L.push(`الخطوة التالية: ${s.next.join("؛ ")}`);
  if (s.open.length) L.push(`أسئلة مفتوحة: ${s.open.join("؛ ")}`);
  const act = m.decisions.filter((d) => d.status === "active");
  if (act.length) L.push("القرارات السارية:", ...act.slice(-40).map((d) => `- ${d.id} [${d.source}] ${d.text}`));
  if (m.constraints.length) L.push("القيود:", ...m.constraints.slice(-30).map((c) => `- ${c}`));
  const t = L.join("\n") || "(لا توجد ذاكرة محفوظة بعد)";
  return t.length > STATE_BUDGET ? t.slice(0, STATE_BUDGET) + "\n…" : t;
}

// the project's id lives inside the folder (.conversation-memory/project-id): chat links and progress are kept per project,
// and a request made for one folder is refused if the folder has changed since
async function projectId(r) {
  const d = await dataDir(r);
  const t = (await readText(d, "project-id")) || "";
  if (/^[a-f0-9]{16}$/.test(t.trim())) return t.trim();
  const id = nonce();
  await writeVerified(d, "project-id", id);
  return id;
}
async function rootFor(project) {
  const { h, err } = await root(); if (err) return { err };
  if (project !== undefined && project !== (await projectId(h))) return { err: "تغيّر مجلد المشروع منذ طُلب الملخص؛ لم يُحفظ في المجلد الجديد" };
  return { h };
}

// ---------- pinned texts ----------
async function withLock(h, fn) {
  const lk = await takeWriteLock(h);   // before writing anything
  if (!lk) return { ok: false, busy: true, error: "برنامج آخر يكتب في الذاكرة الآن؛ أعد المحاولة بعد لحظات" };
  try { return await fn(lk); } finally { await dropWriteLock(lk); }
}
async function versionsOf(h, name) {
  let d; try { d = await dir(h, [PINS, name], false); } catch { return []; }
  const out = [];
  for await (const [n, fh] of d.entries()) {
    const m = n.match(/^v(\d+)\.md$/); if (!m || fh.kind !== "file") continue;
    const f = await fh.getFile(); if (f.size > 400000) continue;
    const text = await f.text();
    out.push({ v: +m[1], text, sha: await sha256(text), date: new Date(f.lastModified).toISOString().slice(0, 16).replace("T", " ") });
  }
  return out.sort((a, b) => a.v - b.v);
}
// write text as the next version of a pin (or report it unchanged) and index it; the caller holds the lock
async function pinWrite(h, name, text, lk) {
  const d = await dir(h, [PINS, name]);
  let last = 0;
  for await (const [n, fh] of d.entries()) { const m = n.match(/^v(\d+)\.md$/); if (m && fh.kind === "file") last = Math.max(last, +m[1]); }
  const sha = await sha256(text);
  let v = last, unchanged = false;
  if (last && (await readText(d, `v${last}.md`)) === text) unchanged = true;
  else {
    v = last + 1;
    await writeVerified(d, `v${v}.md`, text);
    if ((await sha256(await readText(d, `v${v}.md`))) !== sha) { await d.removeEntry(`v${v}.md`).catch(() => {}); return { ok: false, error: "فشل التحقق من البصمة" }; }
  }
  const w = await writeMemory(h, (m) => ({ memory: C.upsertPin(m, { name, version: v, path: C.pinPath(name, v), sha, date: today() }) }), (mm) => mm.pins.some((x) => x.name === name && x.version === v), lk);
  if (w.err) return { ok: false, error: "حُفظ النص لكن لم يُحدَّث فهرسه: " + w.err };
  return { ok: true, name, v, unchanged, hash: sha.slice(0, 12), notes: w.notes };
}

// ---------- operations ----------
const ops = {
  async status() {
    const h = await kvGet("root");
    if (!h) {
      await rememberScopeName();
      try { const b = await browserRoot(); return { ok: true, folder: await scopeLabel(SCOPE), inBrowser: true, scope: SCOPE, permission: "granted", projectId: await projectId(b) }; }
      catch (e) { return { ok: false, error: "تعذّر الحفظ داخل المتصفح: " + String((e && e.message) || e) }; }
    }
    const permission = await h.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") return { ok: true, folder: h.name, permission };
    try { return { ok: true, folder: h.name, permission, projectId: await projectId(h) }; }
    catch (e) { return { ok: true, folder: h.name, permission, error: String((e && e.message) || e) }; }
  },
  async prepare({ project }) {
    const { h, err } = await rootFor(project); if (err) return { ok: false, error: err };
    const cur = await readMemory(h);
    if (cur.bad) return { ok: false, error: cur.bad };
    return { ok: true, base: cur.token, state: stateForPrompt(cur.memory) };
  },
  async readCompact() {
    const { h, err } = await root(); if (err) return { ok: false, error: err };
    const cur = await readMemory(h);
    if (cur.bad) return { ok: false, error: cur.bad };
    if (!cur.exists && !cur.mdText) return { ok: true, text: "" };
    const m = !cur.exists ? C.importLegacy(cur.memory, cur.mdText, "") : cur.memory;
    return { ok: true, text: C.renderCompact(m, COMPACT_BUDGET) };
  },
  // the model's reply → validated draft → applied by the core
  async commit({ project, reply, batch, base, platform, chat, range }) {
    const { h, err } = await rootFor(project); if (err) return { ok: false, error: err };
    const p = C.parseModelReply(String(reply || ""));
    if (!p.ok) return { ok: false, error: p.error };
    const fields = p.fields && typeof p.fields === "object" && !Array.isArray(p.fields) ? p.fields : null;
    if (!fields) return { ok: false, error: "الملخص ليس كائن JSON" };
    const v = C.validateDraft({ ...fields, batch, base }, batch);
    if (!v.ok) return { ok: false, error: v.error };
    let w;
    try {
      w = await writeMemory(h, (m, token) => {
        const r = C.applyDraft(m, v.draft, { platform, chat, range, date: today(), allowSummary: v.draft.base === token });
        return { memory: r.memory, extra: r };
      }, (mm) => mm.log.some((e) => e.id === batch));
    } catch (e) {   // the file system refused (permission withdrawn, disk full…): the reply itself is valid — keep it and retry
      return { ok: false, writeFailed: true, error: "تعذّرت الكتابة في الملفات: " + String((e && e.message) || e) };
    }
    if (w.err) return { ok: false, error: w.err, busy: !!w.busy };
    const r = w.extra;
    return { ok: true, already: !r.applied, redacted: r.redacted, summarySkipped: r.skipped.includes("summary"), notes: w.notes };
  },
  // the backups the user can restore (newest first; the same numbering as the plugin's /conversation-memory:restore)
  async listBackups() {
    const { h, err } = await root(); if (err) return { ok: false, error: err };
    const cur = await readMemory(h);
    if (cur.bad) return { ok: false, error: cur.bad };
    return { ok: true, list: (await describeBackups(h, cur.jsonText)).map(({ when, log, decisions, goal }) => ({ when, log, decisions, goal })) };
  },
  // restore backup n (1 = the newest one that differs from the current file); the current version is backed up first
  async restore({ n }) {
    const { h, err } = await root(); if (err) return { ok: false, error: err };
    const lk = await takeWriteLock(h);
    if (!lk) return { ok: false, busy: true, error: "برنامج آخر يكتب في الذاكرة الآن؛ أعد المحاولة بعد لحظات" };
    try {
      const cur = await readMemory(h);
      if (cur.bad) return { ok: false, error: cur.bad };
      const list = await describeBackups(h, cur.jsonText), b = list[(Math.floor(+n) || 1) - 1];
      if (!b) return { ok: false, error: list.length ? `لا توجد نسخة رقم ${n}` : "لا توجد نسخة سابقة للاسترجاع بعد" };
      await backupJson(h, cur.jsonText);
      const m = b.memory, md = C.render(m);
      m.mdHash = C.hash(md);
      await writeVerified(h, JSON_FILE, C.serialize(m));
      await writeVerified(h, MD_FILE, md);
      return { ok: true, when: b.when, log: b.log, decisions: b.decisions };
    } finally { await dropWriteLock(lk); }
  },
  // full transcript of one conversation, every message complete
  async saveRaw({ project, chatKey, label, url, turns }) {
    const { h, err } = await rootFor(project); if (err) return { ok: false, error: err };
    if (!/^[a-z-]{3,12}-[a-z0-9-]{1,40}$/.test(chatKey)) return { ok: false, error: "معرّف محادثة غير صالح" };
    const list = (Array.isArray(turns) ? turns : []).filter((t) => t && typeof t.text === "string");
    const body = list.map((t) => `### ${t.role === "user" ? `أنت (${t.n})` : "المساعد"}\n${t.text}\n`).join("\n");
    const text = `# نص المحادثة كاملاً — ${C.cleanStr(String(label || ""), 200)}\n\n> ${C.cleanStr(String(url || ""), 500)}\n> آخر حفظ: ${today()} · رسائلك: ${list.filter((t) => t.role === "user").length}\n\n` + C.redact(body).text;
    await writeVerified(await dir(await dataDir(h), ["chats"]), `${chatKey}.md`, text);
    return { ok: true };
  },
  // verbatim pin: the exact selected text, versioned, fingerprinted, indexed in the memory
  async savePin({ name, text }) {
    const { h, err } = await root(); if (err) return { ok: false, error: err };
    name = String(name || "").trim().replace(/\s+/g, " ");
    text = String(text || "");
    if (!C.pinNameOk(name)) return { ok: false, error: "اسم غير صالح (حتى 60 حرفاً، بلا / أو : أو رموز)" };
    if (!text.trim()) return { ok: false, error: "لا يوجد نص محدد" };
    if (text.length > 200000) return { ok: false, error: "النص طويل جداً" };
    if (C.hasSecret(text)) return { ok: false, error: "النص يحتوي بيانات حساسة؛ لن يُحفظ" };
    return withLock(h, (lk) => pinWrite(h, name, text, lk));
  },
  // the whole memory, for the correction page and the share panel (read only)
  async readFull() {
    const { h, err } = await root(); if (err) return { ok: false, error: err };
    const cur = await readMemory(h);
    if (cur.bad) return { ok: false, error: cur.bad };
    const m = !cur.exists && cur.mdText ? C.importLegacy(cur.memory, cur.mdText, "") : cur.memory;
    return { ok: true, memory: m, exists: cur.exists };
  },
  // every saved version of a pinned text, oldest first: { v, text, sha, date }
  async pinVersions({ name }) {
    const { h, err } = await root(); if (err) return { ok: false, error: err };
    name = String(name || "").trim().replace(/\s+/g, " ");
    if (!C.pinNameOk(name)) return { ok: false, error: "اسم غير صالح" };
    return { ok: true, name, versions: await versionsOf(h, name) };
  },
  // the projects saved inside the browser, for the settings page
  async listScopes() {
    const out = [], names = await scopeNames();
    let d; try { d = await dir(await navigator.storage.getDirectory(), ["projects"]); } catch { return { ok: true, list: [], linked: !!(await kvGet("root")) }; }
    for await (const [scope, fh] of d.entries()) {
      if (fh.kind !== "directory") continue;
      const cur = await readMemory(fh).catch(() => null);
      if (!cur || !cur.exists) continue;
      out.push({ scope, name: scope === "general" ? "محادثات خارج المشاريع" : names[scope] || scope, decisions: cur.memory.decisions.filter((x) => x.status === "active").length, log: cur.memory.log.length, updated: cur.memory.updated });
    }
    out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    return { ok: true, list: out, linked: !!(await kvGet("root")) };
  },
  // the readable memory of one project, to download as a file
  async exportMd() {
    const { h, err } = await root(); if (err) return { ok: false, error: err };
    const cur = await readMemory(h);
    if (cur.bad) return { ok: false, error: cur.bad };
    if (!cur.exists) return { ok: false, error: "لا توجد ذاكرة محفوظة لهذا المشروع بعد" };
    return { ok: true, text: C.render(cur.memory), name: await scopeLabel(SCOPE) };
  },
  // bring back version v of a pinned text: saved as a new version, the older ones stay
  async pinRestore({ name, v }) {
    const { h, err } = await root(); if (err) return { ok: false, error: err };
    name = String(name || "").trim().replace(/\s+/g, " ");
    if (!C.pinNameOk(name)) return { ok: false, error: "اسم غير صالح" };
    const src = (await versionsOf(h, name)).find((x) => x.v === +v);
    if (!src) return { ok: false, error: `لا توجد النسخة ${v} من «${name}»` };
    const r = await withLock(h, (lk) => pinWrite(h, name, src.text, lk));
    return r.ok ? { ...r, from: +v } : r;
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== "offscreen" || !Object.prototype.hasOwnProperty.call(ops, msg.op)) return;
  const args = msg.args || {};
  navigator.locks.request("cm-write", () => { SCOPE = cleanScope(args.scope); SCOPE_NAME = String(args.scopeName || ""); return ops[msg.op](args); })
    .then(reply, (e) => reply({ ok: false, error: e && e.name === "NotAllowedError" ? "needPermission" : String((e && e.message) || e) }));
  return true;
});

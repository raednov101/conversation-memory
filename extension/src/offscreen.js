// The only code that touches the project folder. Uses the shared core (memory-core.js, identical to the plugin's).
// Every memory write: read → (migrate / keep hand edits) → apply → re-read to detect a concurrent writer → backup → write → read back.
"use strict";
const C = self.MemoryCore;
const JSON_FILE = "CONVERSATION_MEMORY.json", MD_FILE = "CONVERSATION_MEMORY.md", PINS = "CONVERSATION_PINS", DATA = ".conversation-memory";
const MAX_JSON = 4 * 1024 * 1024, TRIM_AT = 3 * 1024 * 1024, MAX_BACKUPS = 10, STATE_BUDGET = 3000, COMPACT_BUDGET = 5000, WLOCK_STALE = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nonce = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
const today = () => new Date().toLocaleString("sv-SE").slice(0, 16);
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(".", "-").slice(0, 19);

// ---------- stored folder handle ----------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("cm", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kvGet(k) { const db = await idb(); return new Promise((res, rej) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function root() {
  const h = await kvGet("root");
  if (!h) return { err: "noFolder" };
  if ((await h.queryPermission({ mode: "readwrite" })) !== "granted") return { err: "needPermission" };
  return { h };
}

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
async function backupJson(r, text) {
  if (!text) return;
  const b = await dir(await dataDir(r), ["backups"]);
  const names = [];
  for await (const [n, h] of b.entries()) if (h.kind === "file" && /^\d{8}-\d{6}-\d{3}\.json$/.test(n)) names.push(n);
  names.sort();
  if (names.length && (await readText(b, names[names.length - 1])) === text) return;
  let name = `${stamp()}.json`;
  while (names.includes(name)) { await new Promise((s) => setTimeout(s, 2)); name = `${stamp()}.json`; }
  await writeVerified(b, name, text);
  names.push(name); names.sort();
  for (const n of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) await b.removeEntry(n).catch(() => {});
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
  const d = await dataDir(r), me = nonce(), until = Date.now() + 3000;
  while (Date.now() < until) {
    let fh = null; try { fh = await d.getFileHandle("write.lock"); } catch {}
    if (fh) {
      const f = await fh.getFile(), at = +String(await f.text()).trim().split(" ")[1] || f.lastModified;
      if (Date.now() - at < WLOCK_STALE) { await sleep(50); continue; }
    }
    await writeVerified(d, "write.lock", `${me} ${Date.now()}`);
    await sleep(40);
    if (String(await readText(d, "write.lock")).startsWith(me + " ")) return { d, me };
  }
  return null;
}
async function dropWriteLock(lk) { if (!lk) return; try { if (String(await readText(lk.d, "write.lock")).startsWith(lk.me + " ")) await lk.d.removeEntry("write.lock"); } catch {} }
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
      else if (!keptEdit && cur.exists && cur.mdText != null && m.mdHash && C.hash(cur.mdText) !== m.mdHash) {
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
      await backupJson(r, cur.jsonText);
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

// ---------- operations ----------
const ops = {
  async status() {
    const h = await kvGet("root");
    if (!h) return { ok: true, folder: null, permission: "none" };
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
    const w = await writeMemory(h, (m, token) => {
      const r = C.applyDraft(m, v.draft, { platform, chat, range, date: today(), allowSummary: v.draft.base === token });
      return { memory: r.memory, extra: r };
    }, (mm) => mm.log.some((e) => e.id === batch));
    if (w.err) return { ok: false, error: w.err, busy: !!w.busy };
    const r = w.extra;
    return { ok: true, already: !r.applied, redacted: r.redacted, summarySkipped: r.skipped.includes("summary"), notes: w.notes };
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
    const lk = await takeWriteLock(h);   // before writing anything
    if (!lk) return { ok: false, busy: true, error: "برنامج آخر يكتب في الذاكرة الآن؛ أعد المحاولة بعد لحظات" };
    try {
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
    } finally { await dropWriteLock(lk); }
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== "offscreen" || !Object.prototype.hasOwnProperty.call(ops, msg.op)) return;
  navigator.locks.request("cm-write", () => ops[msg.op](msg.args || {}))
    .then(reply, (e) => reply({ ok: false, error: e && e.name === "NotAllowedError" ? "needPermission" : String((e && e.message) || e) }));
  return true;
});

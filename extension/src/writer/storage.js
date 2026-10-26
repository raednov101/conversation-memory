// The writer, part 1 of 3 — where the memory lives and safe file operations: the browser's private storage or a linked
// folder, read and write with verification, backups shared with the Claude Code plugin.
// Loaded by offscreen.html before writer/memory.js and offscreen.js; it touches no memory content itself.
(function (G) {
  "use strict";
  const C = G.MemoryCore;
  const T = C.T;
  // file names, backup naming, sizes and the shared lock come from the core: the plugin follows the same definition
  const {
    json: JSON_FILE,
    md: MD_FILE,
    pins: PINS,
    data: DATA,
    maxJson: MAX_JSON,
    trimAt: TRIM_AT,
    maxBackups: MAX_BACKUPS,
    writeLockStale: WLOCK_STALE,
    futureSkew: FUTURE_SKEW,
  } = C.PROTOCOL;
  const STATE_BUDGET = 1800,
    COMPACT_BUDGET = 5000;
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
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function kvSet(k, v) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction("kv", "readwrite");
      const q = tx.objectStore("kv").put(v, k);
      q.onsuccess = () => res(true);
      q.onerror = () => rej(q.error);
    });
  }
  async function kvGet(k) {
    const db = await idb();
    return new Promise((res, rej) => {
      const q = db.transaction("kv").objectStore("kv").get(k);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  }
  // the memory this request is for: set for each request (requests run one at a time, under the "cm-write" lock)
  const ctx = { scope: "general", name: "" };
  const cleanScope = (s) => (/^[a-z0-9-]{1,80}$/.test(String(s || "")) ? String(s) : "general");
  // the browser's own storage: no other program can reach it, and navigator.locks("cm-write") already runs one request at a time,
  // so the file lock shared with the Claude Code plugin is not needed there
  const IN_BROWSER = new WeakSet();
  async function browserRoot(scope = ctx.scope) {
    const d = await dir(await navigator.storage.getDirectory(), ["projects", scope]);
    IN_BROWSER.add(d);
    return d;
  }
  async function root() {
    const h = await kvGet("root");
    if (!h) return { h: await browserRoot(), inBrowser: true };
    if ((await h.queryPermission({ mode: "readwrite" })) !== "granted") return { err: "needPermission" };
    return { h };
  }
  async function scopeNames() {
    return (await kvGet("scopeNames")) || {};
  }
  async function rememberScopeName() {
    if (!ctx.name) return;
    const n = await scopeNames();
    if (n[ctx.scope] === ctx.name) return;
    n[ctx.scope] = ctx.name.slice(0, 80);
    await kvSet("scopeNames", n);
  }
  const GENERAL_NAMES = {
    // translated where shown: T(GENERAL_NAMES[x])

    general: "محادثات خارج المشاريع (إصدار سابق)",
    "chatgpt-general": "ChatGPT: محادثات خارج المشاريع (قبل 1.5)",
    "claude-general": "Claude: محادثات خارج المشاريع (قبل 1.5)",
  };
  const scopeLabel = async (scope) => (GENERAL_NAMES[scope] && T(GENERAL_NAMES[scope])) || (await scopeNames())[scope] || scope;

  // ---------- fs helpers ----------
  async function dir(base, parts, create = true) {
    let d = base;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    return d;
  }
  async function readText(d, name) {
    try {
      const f = await (await d.getFileHandle(name)).getFile();
      if (f.size > MAX_JSON) throw new Error(T`${name} أكبر من 4 ميجا`);
      return await f.text();
    } catch (e) {
      if (e.name === "NotFoundError" || e.name === "TypeMismatchError") return null;
      throw e;
    }
  }
  async function writeVerified(d, name, text) {
    const fh = await d.getFileHandle(name, { create: true });
    const w = await fh.createWritable(); // a swap file; the original is replaced only on close()
    await w.write(text);
    await w.close();
    if ((await (await fh.getFile()).text()) !== text) throw new Error(T("فشل التحقق بعد الكتابة: ") + name);
  }
  async function sha256(t) {
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  async function dataDir(r) {
    const d = await dir(r, [DATA]);
    if ((await readText(d, ".gitignore")) === null) await writeVerified(d, ".gitignore", "*\n");
    return d;
  }
  // Backups in .conversation-memory/backups/, shared with the Claude Code plugin (same names, same folder), so "undo"
  // reverts the last change whoever made it. A version is never replaced without its backup.
  const BACKUP_RE = C.PROTOCOL.backupRe;
  async function backupNames(r) {
    const b = await dir(await dataDir(r), ["backups"]);
    const names = [];
    for await (const [n, h] of b.entries()) if (h.kind === "file" && BACKUP_RE.test(n)) names.push(n);
    return { b, names: names.sort().reverse() }; // newest first
  }
  async function backupJson(r, text) {
    if (!text) return;
    const { b, names } = await backupNames(r);
    if (names.length && (await readText(b, names[0])) === text) return;
    let name = `${stamp()}.json`;
    while (names.includes(name)) name = `${stamp()}-${nonce().slice(0, 4)}.json`;
    await writeVerified(b, name, text); // throws if it can't be written: then nothing else is written either
    names.unshift(name);
    for (const n of names.slice(MAX_BACKUPS)) await b.removeEntry(n).catch(() => {});
  }
  // The .md is a view of the current memory or of an earlier version (writes cut off between the two files can leave it
  // several versions behind): then it is not a hand edit and is simply regenerated. Only real edits are kept aside.
  async function isSomeGeneratedView(r, mdText, current) {
    if (C.isGeneratedView(mdText, current, null)) return true;
    const h = C.hash(String(mdText)),
      { b, names } = await backupNames(r);
    for (const n of names) {
      const p = C.parseMemory(await readText(b, n));
      if (p.ok && (p.memory.mdHash === h || C.isGeneratedView(mdText, p.memory, null))) return true;
    }
    return false;
  }
  // backup names carry the time in UTC (shared with the plugin); people read it in their own time
  const localWhen = (n) =>
    new Date(Date.UTC(+n.slice(0, 4), +n.slice(4, 6) - 1, +n.slice(6, 8), +n.slice(9, 11), +n.slice(11, 13), +n.slice(13, 15)))
      .toLocaleString("sv-SE")
      .slice(0, 16);
  async function describeBackups(r, currentText) {
    const { b, names } = await backupNames(r),
      out = [];
    for (const n of names) {
      const text = await readText(b, n),
        p = C.parseMemory(text);
      if (!p.ok || text === currentText) continue;
      const m = p.memory;
      out.push({
        name: n,
        when: localWhen(n),
        text,
        memory: m,
        log: m.log.length,
        decisions: m.decisions.filter((d) => d.status === "active").length,
        goal: m.summary.goal.slice(0, 60),
      });
    }
    return out;
  }

  G.CMW = Object.assign(G.CMW || {}, {
    storage: {
      BACKUP_RE,
      COMPACT_BUDGET,
      DATA,
      FUTURE_SKEW,
      GENERAL_NAMES,
      IN_BROWSER,
      JSON_FILE,
      MAX_BACKUPS,
      MAX_JSON,
      MD_FILE,
      PINS,
      STATE_BUDGET,
      TRIM_AT,
      WLOCK_STALE,
      backupJson,
      backupNames,
      browserRoot,
      cleanScope,
      ctx,
      dataDir,
      describeBackups,
      dir,
      idb,
      isSomeGeneratedView,
      kvGet,
      kvSet,
      localWhen,
      nonce,
      readText,
      rememberScopeName,
      root,
      scopeLabel,
      scopeNames,
      sha256,
      sleep,
      stamp,
      today,
      writeVerified,
    },
  });
})(self);

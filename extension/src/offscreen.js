// The writer, part 3 of 3 — the operations the pages may ask for, one at a time. The only code that reads or writes the
// memory: inside the browser's private storage by default, or in a folder the user linked (writer/storage.js), through
// writer/memory.js. Uses the shared core (memory-core.js, byte-identical to the plugin's).
"use strict";
const C = self.MemoryCore;
const T = C.T;
const {
  COMPACT_BUDGET,
  GENERAL_NAMES,
  JSON_FILE,
  MD_FILE,
  backupJson,
  browserRoot,
  cleanScope,
  ctx,
  dataDir,
  describeBackups,
  dir,
  isSomeGeneratedView,
  kvGet,
  kvSet,
  readText,
  rememberScopeName,
  root,
  scopeLabel,
  scopeNames,
  sha256,
  stamp,
  today,
  writeVerified,
} = self.CMW.storage;
const {
  readMemory,
  pinTextsOf,
  readHealed,
  takeWriteLock,
  dropWriteLock,
  writeMemory,
  evidenceArg,
  stateForPrompt,
  projectId,
  rootFor,
  withLock,
  versionsOf,
  pinWrite,
} = self.CMW.memory;

// ---------- tickets: a summary is saved only into the memory and chat it was asked for ----------
// When a request is prepared the writer notes which memory (scope), project folder and chat it is for; the reply is
// written only if it comes back for the same three. Switching tabs, a chat moved to its own memory meanwhile, or a page
// sending a batch it never asked for: nothing is written. Kept in the extension's own storage, newest 300, for a week.
const TICKET_MAX = 300,
  TICKET_TTL = 7 * 24 * 3600 * 1000;
const okBatch = (b) => typeof b === "string" && /^[A-Za-z0-9-]{1,120}$/.test(b);
async function issueTicket(batch, project, chat) {
  if (!okBatch(batch)) return;
  const all = (await kvGet("tickets")) || {},
    now = Date.now();
  all[batch] = { scope: ctx.scope, project: String(project || ""), chat: String(chat || "").slice(0, 200), at: now };
  const keep = Object.entries(all)
    .filter(([, t]) => now - t.at < TICKET_TTL)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, TICKET_MAX);
  await kvSet("tickets", Object.fromEntries(keep));
}
// → "" when the reply may be written; otherwise why not
async function ticketFor(batch, project, chat) {
  const t = okBatch(batch) && ((await kvGet("tickets")) || {})[batch];
  if (!t) return T("لم يُطلب هذا الملخص من هنا (أو مضى عليه أكثر من أسبوع)؛ لم يُحفظ شيء");
  if (t.scope !== ctx.scope) return T("طُلب هذا الملخص لذاكرة أخرى؛ لم يُحفظ في هذه");
  if (t.project !== String(project || "")) return T("تغيّر مجلد المشروع منذ طُلب الملخص؛ لم يُحفظ في المجلد الجديد");
  if (t.chat && chat !== undefined && t.chat !== String(chat).slice(0, 200)) return T("طُلب هذا الملخص لمحادثة أخرى؛ لم يُحفظ هنا");
  return "";
}

// ---------- operations ----------
const ops = {
  async status() {
    const h = await kvGet("root");
    if (!h) {
      await rememberScopeName();
      try {
        const b = await browserRoot();
        return {
          ok: true,
          folder: await scopeLabel(ctx.scope),
          inBrowser: true,
          scope: ctx.scope,
          permission: "granted",
          projectId: await projectId(b),
        };
      } catch (e) {
        return { ok: false, error: T("تعذّر الحفظ داخل المتصفح: ") + String((e && e.message) || e) };
      }
    }
    const permission = await h.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") return { ok: true, folder: h.name, permission };
    try {
      return { ok: true, folder: h.name, permission, projectId: await projectId(h) };
    } catch (e) {
      return { ok: true, folder: h.name, permission, error: String((e && e.message) || e) };
    }
  },
  async prepare({ project, batch, chat }) {
    const { h, err } = await rootFor(project);
    if (err) return { ok: false, error: err };
    const cur = await readHealed(h);
    if (cur.bad) return { ok: false, error: cur.bad };
    if (batch !== undefined) await issueTicket(batch, project, chat);
    const m = cur.memory,
      has = !!(m.summary.goal || m.summary.status || m.decisions.length || m.constraints.length);
    return { ok: true, base: cur.token, state: stateForPrompt(m), hasMemory: has };
  },
  async readCompact() {
    const { h, err } = await root();
    if (err) return { ok: false, error: err };
    const cur = await readHealed(h);
    if (cur.bad) return { ok: false, error: cur.bad };
    if (!cur.exists && !cur.mdText) return { ok: true, text: "" };
    const m = !cur.exists ? C.importLegacy(cur.memory, cur.mdText, "") : cur.memory;
    if (!cur.exists) return { ok: true, text: C.renderCompact(m, COMPACT_BUDGET) };
    // for a chat box: everything in force, the pinned texts themselves (the site can't open their files), the latest
    // log entries, no markdown markers
    const sel = {
      summary: true,
      constraints: true,
      decisions: m.decisions.filter((d) => d.status === "active").map((d) => d.id),
      pins: m.pins.map((p) => p.name),
      log: m.log.slice(-3).map((e) => e.id),
    };
    return { ok: true, text: C.renderSelection(m, sel, COMPACT_BUDGET, { pinTexts: await pinTextsOf(h, m), plain: true }) };
  },
  // the model's reply → validated draft → applied by the core
  async commit({ project, reply, batch, base, platform, chat, chatKey, range, evidence }) {
    const { h, err } = await rootFor(project);
    if (err) return { ok: false, error: err };
    // checked here, by the writer, not by the page: the reply goes only where its request was meant to go
    const tk = await ticketFor(batch, project, chatKey);
    if (tk) return { ok: false, misplaced: true, error: tk };
    const p = C.parseModelReply(String(reply || ""));
    if (!p.ok) return { ok: false, error: p.error };
    const fields = p.fields && typeof p.fields === "object" && !Array.isArray(p.fields) ? p.fields : null;
    if (!fields) return { ok: false, error: T("الملخص ليس كائن JSON") };
    // the model says this chat is about something else than this memory: nothing is written; the user decides
    if (fields.different === true) return { ok: false, different: true };
    const v = C.validateDraft({ ...fields, batch, base }, batch);
    if (!v.ok) return { ok: false, error: v.error };
    let w;
    try {
      w = await writeMemory(
        h,
        (m, token) => {
          const r = C.applyDraft(m, v.draft, {
            platform,
            chat,
            range,
            date: today(),
            allowSummary: v.draft.base === token,
            evidence: evidenceArg(evidence),
          });
          return { memory: r.memory, extra: r };
        },
        (mm) => mm.log.some((e) => e.id === batch),
      );
    } catch (e) {
      // the file system refused (permission withdrawn, disk full…): the reply itself is valid — keep it and retry
      return { ok: false, writeFailed: true, error: T("تعذّرت الكتابة في الملفات: ") + String((e && e.message) || e) };
    }
    if (w.err) return { ok: false, error: w.err, busy: !!w.busy };
    const r = w.extra;
    return {
      ok: true,
      already: !r.applied,
      redacted: r.redacted,
      summarySkipped: r.skipped.includes("summary"),
      unverified: r.unverified || [],
      pending: r.pending || [],
      notes: w.notes,
    };
  },
  // what waits for the user: decisions not backed by their words, and changes to what they decided (C.reviewItems)
  async reviewList() {
    const { h, err } = await root();
    if (err) return { ok: false, error: err };
    const cur = await readMemory(h);
    if (cur.bad || !cur.exists) return { ok: true, list: [] };
    return {
      ok: true,
      list: C.reviewItems(cur.memory).map(({ key, kind, text, quote, reason, date, msg }) => ({
        key,
        kind,
        text,
        quote,
        reason,
        date,
        msg,
      })),
    };
  },
  // approve (the change happens) or reject it — a normal, backed-up, undoable write
  async review({ key, action }) {
    const { h, err } = await root();
    if (err) return { ok: false, error: err };
    if (!C.isReviewKey(String(key)) || (action !== "approve" && action !== "reject")) return { ok: false, error: T("طلب مراجعة غير صالح") };
    const v = C.validateFix({ pending: { [action]: [key] } });
    let changes = [];
    const w = await writeMemory(
      h,
      (m) => {
        if (!C.reviewItems(m).some((x) => x.key === key)) return { err: T("لم يعد هذا بانتظار المراجعة") };
        const r = C.applyFix(m, v.fix, today());
        changes = r.changes;
        return { memory: r.memory };
      },
      (mm) => !C.reviewItems(mm).some((x) => x.key === key),
    );
    if (w.err) return { ok: false, error: w.err, busy: !!w.busy };
    return { ok: true, changes };
  },
  // the backups the user can restore (newest first; the same numbering as the plugin's /conversation-memory:restore)
  async listBackups() {
    const { h, err } = await root();
    if (err) return { ok: false, error: err };
    const cur = await readMemory(h); // listed even when the current file is broken: that is when a restore is needed
    return {
      ok: true,
      broken: cur.bad || "",
      list: (await describeBackups(h, cur.bad ? null : cur.jsonText)).map(({ when, log, decisions, goal }) => ({
        when,
        log,
        decisions,
        goal,
      })),
    };
  },
  // restore backup n (1 = the newest one that differs from the current file); the current version is backed up first
  async restore({ n }) {
    const { h, err } = await root();
    if (err) return { ok: false, error: err };
    const lk = await takeWriteLock(h);
    if (!lk) return { ok: false, busy: true, error: T("برنامج آخر يكتب في الذاكرة الآن؛ أعد المحاولة بعد لحظات") };
    try {
      const cur = await readMemory(h);
      // a broken memory file is exactly when a restore is needed: the broken file is kept aside, never thrown away
      const list = await describeBackups(h, cur.bad ? null : cur.jsonText),
        b = list[(Math.floor(+n) || 1) - 1];
      if (!b)
        return { ok: false, error: cur.bad ? cur.bad : list.length ? T`لا توجد نسخة رقم ${n}` : T("لا توجد نسخة سابقة للاسترجاع بعد") };
      if (cur.bad) {
        if (typeof cur.brokenText === "string") await writeVerified(h, `CONVERSATION_MEMORY.broken-${stamp()}.json`, cur.brokenText);
      } else
        try {
          await backupJson(h, cur.jsonText);
        } catch {
          return { ok: false, error: T("تعذّر حفظ النسخة الحالية احتياطياً، فلم أسترجع شيئاً") };
        }
      let kept = ""; // a hand-edited .md is kept aside first, as every other write does
      if (!cur.bad && cur.exists && cur.mdText != null && cur.memory.mdHash && !(await isSomeGeneratedView(h, cur.mdText, cur.memory))) {
        kept = `CONVERSATION_MEMORY.edited-${stamp()}.md`;
        await writeVerified(h, kept, cur.mdText);
      }
      const m = b.memory,
        md = C.render(m);
      m.mdHash = C.hash(md);
      await writeVerified(h, JSON_FILE, C.serialize(m));
      await writeVerified(h, MD_FILE, md);
      return { ok: true, when: b.when, log: b.log, decisions: b.decisions, kept };
    } finally {
      await dropWriteLock(lk);
    }
  },
  // full transcript of one conversation, every message complete
  async saveRaw({ project, chatKey, label, url, turns }) {
    const { h, err } = await rootFor(project);
    if (err) return { ok: false, error: err };
    if (!/^[a-z-]{3,12}-[a-z0-9-]{1,40}$/.test(chatKey)) return { ok: false, error: T("معرّف محادثة غير صالح") };
    const list = (Array.isArray(turns) ? turns : []).filter((t) => t && typeof t.text === "string");
    const body = list.map((t) => `### ${t.role === "user" ? T`أنت (${t.n})` : T("المساعد")}\n${t.text}\n`).join("\n");
    const text =
      T`# نص المحادثة كاملاً — ${C.cleanStr(String(label || ""), 200)}\n\n> ${C.cleanStr(String(url || ""), 500)}\n> آخر حفظ: ${today()} · رسائلك: ${list.filter((t) => t.role === "user").length}\n\n` +
      C.redact(body).text;
    await writeVerified(await dir(await dataDir(h), ["chats"]), `${chatKey}.md`, text);
    return { ok: true };
  },
  // verbatim pin: the exact selected text, versioned, fingerprinted, indexed in the memory
  async savePin({ name, text }) {
    const { h, err } = await root();
    if (err) return { ok: false, error: err };
    name = String(name || "")
      .trim()
      .replace(/\s+/g, " ");
    text = String(text || "");
    if (!C.pinNameOk(name)) return { ok: false, error: T("اسم غير صالح (حتى 60 حرفاً، بلا / أو : أو رموز)") };
    if (!text.trim()) return { ok: false, error: T("لا يوجد نص محدد") };
    if (text.length > 200000) return { ok: false, error: T("النص طويل جداً") };
    if (C.hasSecret(text)) return { ok: false, error: T("النص يحتوي بيانات حساسة؛ لن يُحفظ") };
    return withLock(h, (lk) => pinWrite(h, name, text, lk));
  },
  // the whole memory, for the correction page and the share panel (read only)
  async readFull() {
    const { h, err } = await root();
    if (err) return { ok: false, error: err };
    const cur = await readMemory(h);
    if (cur.bad) return { ok: false, error: cur.bad };
    const m = !cur.exists && cur.mdText ? C.importLegacy(cur.memory, cur.mdText, "") : cur.memory;
    return { ok: true, memory: m, exists: cur.exists, pinTexts: await pinTextsOf(h, m) };
  },
  // every saved version of a pinned text, oldest first: { v, text, sha, date }
  async pinVersions({ name }) {
    const { h, err } = await root();
    if (err) return { ok: false, error: err };
    name = String(name || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!C.pinNameOk(name)) return { ok: false, error: T("اسم غير صالح") };
    return { ok: true, name, versions: await versionsOf(h, name) };
  },
  // the projects saved inside the browser, for the settings page
  async listScopes() {
    const out = [],
      names = await scopeNames();
    let d;
    try {
      d = await dir(await navigator.storage.getDirectory(), ["projects"]);
    } catch {
      return { ok: true, list: [], linked: !!(await kvGet("root")) };
    }
    for await (const [scope, fh] of d.entries()) {
      if (fh.kind !== "directory") continue;
      const cur = await readMemory(fh).catch(() => null);
      if (!cur || !cur.exists) continue;
      out.push({
        scope,
        name: (GENERAL_NAMES[scope] && T(GENERAL_NAMES[scope])) || names[scope] || scope,
        decisions: cur.memory.decisions.filter((x) => x.status === "active").length,
        log: cur.memory.log.length,
        updated: cur.memory.updated,
      });
    }
    out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    return { ok: true, list: out, linked: !!(await kvGet("root")) };
  },
  // this site's memories only (the background sets the site; "*" only on the local test pages)
  async listSiteScopes({ site }) {
    const r = await ops.listScopes();
    return { ok: true, list: (r.list || []).filter((x) => site === "*" || x.scope.startsWith(site + "-")) };
  },
  // the readable memory of one project, to download as a file
  // everything kept inside the browser, as one file to keep: removing the extension deletes its storage with it
  async exportAll() {
    const out = { format: "conversation-memory-backup", v: 1, exported: today(), projects: [] },
      names = await scopeNames();
    let d;
    try {
      d = await dir(await navigator.storage.getDirectory(), ["projects"]);
    } catch {
      return { ok: true, data: out };
    }
    for await (const [scope, fh] of d.entries()) {
      if (fh.kind !== "directory") continue;
      const jsonText = await readText(fh, JSON_FILE).catch(() => null),
        p = C.parseMemory(jsonText);
      if (!jsonText || !p.ok) continue;
      const pins = {};
      for (const pin of p.memory.pins) {
        const parts = pin.path.split("/");
        try {
          pins[pin.path] = await readText(await dir(fh, parts.slice(0, -1), false), parts[parts.length - 1]);
        } catch {}
      }
      out.projects.push({ scope, name: names[scope] || "", memory: JSON.parse(jsonText), pins });
    }
    return { ok: true, data: out, count: out.projects.length };
  },
  // brings such a file back; an existing memory is never replaced (its project is skipped and reported)
  async importAll({ data }) {
    if (!data || data.format !== "conversation-memory-backup" || !Array.isArray(data.projects))
      return { ok: false, error: T("الملف ليس نسخة من ذاكرة المحادثة") };
    let added = 0;
    const skipped = [],
      names = await scopeNames();
    for (const p of data.projects.slice(0, 500)) {
      const scope = p && typeof p.scope === "string" && /^[a-z0-9-]{1,80}$/.test(p.scope) ? p.scope : "";
      const parsed = scope ? C.parseMemory(JSON.stringify(p.memory)) : { ok: false };
      if (!parsed.ok) {
        skipped.push(scope || "?");
        continue;
      }
      const r = await browserRoot(scope),
        cur = await readMemory(r).catch(() => ({ bad: true }));
      if (cur.bad || cur.exists) {
        skipped.push((GENERAL_NAMES[scope] && T(GENERAL_NAMES[scope])) || names[scope] || p.name || scope);
        continue;
      }
      for (const pin of parsed.memory.pins) {
        // a pinned text comes back only if it is exactly the one recorded
        const text = p.pins && typeof p.pins[pin.path] === "string" ? p.pins[pin.path] : null;
        if (text === null || (await sha256(text)) !== pin.sha) continue;
        const parts = pin.path.split("/");
        await writeVerified(await dir(r, parts.slice(0, -1)), parts[parts.length - 1], text);
      }
      const w = await writeMemory(r, () => ({ memory: parsed.memory }), null);
      if (w.err) {
        skipped.push(scope);
        continue;
      }
      if (p.name && !GENERAL_NAMES[scope]) names[scope] = String(p.name).slice(0, 80);
      added++;
    }
    await kvSet("scopeNames", names);
    return { ok: true, added, skipped };
  },
  async exportMd() {
    const { h, err } = await root();
    if (err) return { ok: false, error: err };
    const cur = await readMemory(h);
    if (cur.bad) return { ok: false, error: cur.bad };
    if (!cur.exists) return { ok: false, error: T("لا توجد ذاكرة محفوظة لهذا المشروع بعد") };
    return { ok: true, text: C.render(cur.memory), name: await scopeLabel(ctx.scope) };
  },
  // bring back version v of a pinned text: saved as a new version, the older ones stay
  async pinRestore({ name, v }) {
    const { h, err } = await root();
    if (err) return { ok: false, error: err };
    name = String(name || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!C.pinNameOk(name)) return { ok: false, error: T("اسم غير صالح") };
    const src = (await versionsOf(h, name)).find((x) => x.v === +v);
    if (!src) return { ok: false, error: T`لا توجد النسخة ${v} من «${name}»` };
    const r = await withLock(h, (lk) => pinWrite(h, name, src.text, lk));
    return r.ok ? { ...r, from: +v } : r;
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== "offscreen" || !Object.prototype.hasOwnProperty.call(ops, msg.op)) return;
  const args = msg.args || {};
  // a scope that is not a valid name is refused, never turned into another memory (it once fell back to the shared one)
  if (args.scope !== undefined && !/^[a-z0-9-]{1,80}$/.test(String(args.scope))) {
    reply({ ok: false, error: "not allowed" });
    return;
  }
  navigator.locks
    .request("cm-write", () => {
      C.setLang(args.lang || "auto"); // write in the language of the page that asked
      ctx.scope = cleanScope(args.scope);
      ctx.name = String(args.scopeName || "");
      return ops[msg.op](args);
    })
    .then(reply, (e) => reply({ ok: false, error: e && e.name === "NotAllowedError" ? "needPermission" : String((e && e.message) || e) }));
  return true;
});

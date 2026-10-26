// The writer, part 2 of 3 — the memory itself: read (healing a write that was cut off), the shared write lock, every
// write as read → apply → re-read → backup → write → read back, and pinned texts.
(function (G) {
  "use strict";
  const C = G.MemoryCore;
  const T = C.T;
  const {
    FUTURE_SKEW,
    IN_BROWSER,
    JSON_FILE,
    MAX_JSON,
    MD_FILE,
    PINS,
    STATE_BUDGET,
    TRIM_AT,
    WLOCK_STALE,
    backupJson,
    dataDir,
    describeBackups,
    dir,
    isSomeGeneratedView,
    nonce,
    readText,
    root,
    sha256,
    sleep,
    stamp,
    today,
    writeVerified,
  } = G.CMW.storage;
  // ---------- the memory (the only writer in the extension) ----------
  async function readMemory(r) {
    let jsonText = await readText(r, JSON_FILE),
      p = C.parseMemory(jsonText);
    // a file being replaced by another writer at this very moment can read as cut off: look once more before calling it broken
    if (!p.ok) {
      await sleep(150);
      jsonText = await readText(r, JSON_FILE);
      p = C.parseMemory(jsonText);
    }
    const mdText = await readText(r, MD_FILE);
    if (!p.ok) return { bad: p.error, brokenText: jsonText };
    return { memory: p.memory, jsonText, mdText, token: C.token(jsonText || ""), exists: jsonText != null, newer: !!p.newer };
  }
  // Inside the browser nobody edits the file by hand: a cut-off file can only come from a write that was killed (the
  // browser closing the writer at the worst moment, seen about once in a few hundred forced closes under heavy load).
  // It is healed from the newest backup and kept aside. In a linked folder it may be someone's edit: reported, left alone.
  async function healCut(r, cur) {
    if (!cur.bad || !IN_BROWSER.has(r) || typeof cur.brokenText !== "string") return null;
    const b = (await describeBackups(r, null))[0];
    if (!b) return null;
    await writeVerified(r, `CONVERSATION_MEMORY.broken-${stamp()}.json`, cur.brokenText);
    const m = b.memory,
      md = C.render(m);
    m.mdHash = C.hash(md);
    await writeVerified(r, JSON_FILE, C.serialize(m));
    await writeVerified(r, MD_FILE, md);
    return T`وُجد ملف الذاكرة مقطوعاً (كتابة قُطعت)، فاستُرجعت آخر نسخة سليمة (${b.when}) وحُفظ المقطوع جانباً.`;
  }
  // the approved version of each pinned text, verified against its fingerprint (for inserting it verbatim into a chat)
  async function pinTextsOf(r, m) {
    const out = {};
    for (const p of m.pins) {
      try {
        const parts = p.path.split("/"),
          t = await readText(await dir(r, parts.slice(0, -1), false), parts[parts.length - 1]);
        if (t != null && (await sha256(t)) === p.sha) out[p.name] = t;
      } catch {}
    }
    return out;
  }
  async function readHealed(r) {
    let cur = await readMemory(r);
    if (cur.bad && (await healCut(r, cur))) cur = await readMemory(r);
    return cur;
  }
  // Shared with the Claude Code plugin (same protocol in hook.js): an advisory lock file ".conversation-memory/write.lock",
  // "<owner> <epoch-ms>", stale after 15 s; taken by writing it and confirming it still holds our owner a moment later.
  async function takeWriteLock(r) {
    if (IN_BROWSER.has(r)) return { browser: true };
    const d = await dataDir(r),
      me = nonce(),
      until = Date.now() + 3000;
    while (Date.now() < until) {
      // the other writer may be replacing the lock file while we read it: that read fails, which only means "busy, look again"
      let held = false;
      try {
        const f = await (await d.getFileHandle(C.PROTOCOL.writeLock)).getFile(),
          at =
            +String(await f.text())
              .trim()
              .split(" ")[1] || f.lastModified;
        held = at <= Date.now() + FUTURE_SKEW && Date.now() - at < WLOCK_STALE; // a future time can't hold the lock forever
      } catch (e) {
        if (e && e.name !== "NotFoundError") {
          await sleep(50);
          continue;
        }
      }
      if (held) {
        await sleep(50);
        continue;
      }
      try {
        await writeVerified(d, C.PROTOCOL.writeLock, `${me} ${Date.now()}`);
      } catch {
        await sleep(50);
        continue;
      }
      await sleep(40);
      let mine = false;
      try {
        mine = String(await readText(d, C.PROTOCOL.writeLock)).startsWith(me + " ");
      } catch {}
      if (mine) {
        // while held, the time in the lock is refreshed: a slow write is never taken for an abandoned one
        // a refresh in flight when the lock is released must not write it back: each one checks «done» right before
        // writing, and the release waits for it to finish (lk.beating)
        const lk = { d, me, done: false, beating: null };
        lk.beat = setInterval(
          () => {
            if (lk.done || lk.beating) return;
            lk.beating = (async () => {
              try {
                if (!lk.done && String(await readText(d, C.PROTOCOL.writeLock)).startsWith(me + " ") && !lk.done)
                  await writeVerified(d, C.PROTOCOL.writeLock, `${me} ${Date.now()}`);
              } catch {
              } finally {
                lk.beating = null;
              }
            })();
          },
          Math.floor(WLOCK_STALE / 3),
        );
        return lk;
      }
    }
    return null;
  }
  async function dropWriteLock(lk) {
    if (!lk || lk.browser) return;
    lk.done = true;
    clearInterval(lk.beat);
    if (lk.beating) await lk.beating;
    try {
      if (String(await readText(lk.d, C.PROTOCOL.writeLock)).startsWith(lk.me + " ")) await lk.d.removeEntry(C.PROTOCOL.writeLock);
    } catch {}
  }
  async function archive(r, entries) {
    if (!entries.length) return;
    await writeVerified(
      await dir(await dataDir(r), ["archive"]),
      `${stamp()}-${nonce().slice(0, 4)}.json`,
      JSON.stringify(entries, null, 1),
    );
  }
  // mutate(memory, token) → { memory, extra } | { err }; it may run more than once, so it must depend only on its input.
  // confirm(memoryReadBackFromFile) → true when our change is really in the file (not just in our copy).
  // Without the lock nothing is written: { err, busy: true } and the caller tries again later.
  async function writeMemory(r, mutate, confirm, held) {
    const notes = [];
    let keptEdit = false,
      healed = false;
    const lk = held || (await takeWriteLock(r));
    if (!lk) return { err: T("برنامج آخر يكتب في الذاكرة الآن"), busy: true };
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await readMemory(r);
        if (cur.bad) {
          const note = healed ? null : await healCut(r, cur);
          if (!note) return { err: cur.bad + T(" — لم أكتب فوقه؛ أصلحه أو انقله ثم أعد المحاولة") };
          notes.push(note);
          healed = true;
          attempt--;
          continue;
        }
        if (cur.newer) return { err: T("ملف الذاكرة كتبه إصدار أحدث من هذه الإضافة؛ لم أكتب فوقه حتى لا يضيع ما أضافه. حدّث الإضافة") };
        let m = cur.memory;
        if (!cur.exists && cur.mdText) {
          m = C.importLegacy(m, cur.mdText, today());
          if (!attempt) notes.push(T("نُقل محتوى CONVERSATION_MEMORY.md القديم كما هو تحت «من الإصدار السابق»."));
        } else if (!keptEdit && cur.exists && cur.mdText != null && m.mdHash && !(await isSomeGeneratedView(r, cur.mdText, m))) {
          const name = `CONVERSATION_MEMORY.edited-${stamp()}.md`;
          await writeVerified(r, name, cur.mdText);
          keptEdit = true;
          notes.push(T`عُدّل CONVERSATION_MEMORY.md يدوياً، فحُفظت نسختك في ${name} قبل إعادة توليده.`);
        }
        // an older writer (1.4) wrote over this file and dropped the marks it didn't know: bring back what still applies
        if (cur.exists && C.droppedByOlder(cur.jsonText)) {
          const prev = (await describeBackups(r, cur.jsonText)).find((b) => !C.droppedByOlder(b.text));
          const rec = prev && C.recoverDropped(m, prev.memory);
          if (rec && rec.restored) {
            m = rec.memory;
            if (!attempt)
              notes.push(
                T`كتب إصدار أقدم من الإضافة في الذاكرة فأسقط بعض العلامات (مراجعات تنتظرك، موافقاتك، اللغة)؛ أُعيد ${rec.restored} منها من آخر نسخة.`,
              );
          }
        }
        const out = mutate(m, cur.token);
        if (out.err) return { err: out.err };
        // every difference becomes an event in the history: what changed, when, by what, and why (out.meta)
        const t = C.trimForSize(C.withHistory(m, out.memory, { at: today(), ...(out.meta || {}) }), TRIM_AT);
        const next = t.memory;
        const md = C.render(next);
        next.mdHash = C.hash(md);
        const json = C.serialize(next);
        if (new Blob([json]).size > MAX_JSON) return { err: T("ملف الذاكرة سيتجاوز 4 ميجا") };
        try {
          await backupJson(r, cur.jsonText);
        } catch {
          return { err: T("تعذّر حفظ نسخة احتياطية من الذاكرة الحالية، فلم أكتب فوقها") };
        }
        // checked as late as possible: someone else wrote meanwhile → start over on their version (nothing archived twice)
        if ((await readText(r, JSON_FILE)) !== cur.jsonText) continue;
        if (t.archived.length) {
          await archive(r, t.archived);
          notes.push(T`نُقلت ${t.archived.length} دفعة قديمة إلى الأرشيف (.conversation-memory/archive/) للحفاظ على حجم الملف.`);
        }
        await writeVerified(r, JSON_FILE, json);
        await writeVerified(r, MD_FILE, md);
        const after = C.parseMemory(await readText(r, JSON_FILE)); // confirm from the file itself
        if (!after.ok || (confirm && !confirm(after.memory))) continue;
        return { memory: after.memory, notes, extra: out.extra };
      }
      return { err: T("الملف يتغيّر باستمرار من برنامج آخر؛ أعد المحاولة بعد قليل") };
    } finally {
      if (!held) await dropWriteLock(lk);
    }
  }

  // the current state the model needs to write a correct draft: summary, active decisions with ids, constraints
  // Only what the model cannot see in the chat itself, kept short (it is sent with every summary request and stays in the
  // chat): the project's goal and state (other chats feed them too), the decisions in force with their ids (to revoke one)
  // and the constraints (not to repeat them). Next steps and open questions are rewritten from the chat anyway.
  // the conversation text a commit is checked against (from the page; strings only, bounded)
  const EVIDENCE_MAX = 4 * 1024 * 1024;
  const evidenceArg = (e) => {
    if (!e || typeof e.all !== "string" || typeof e.user !== "string") return null;
    // the turns, newest kept, within the same bound
    let size = 0;
    const turns = [];
    for (const x of Array.isArray(e.turns) ? e.turns.slice().reverse() : []) {
      if (!x || (x.role !== "user" && x.role !== "assistant") || typeof x.text !== "string" || (size += x.text.length) > EVIDENCE_MAX)
        break;
      // a user message's number as on the page; without it (and once older turns are cut off) it is unknown, never guessed
      turns.unshift({ role: x.role, text: x.text, n: Number.isInteger(x.n) && x.n > 0 ? x.n : null });
    }
    return { user: e.user.slice(-EVIDENCE_MAX), all: e.all.slice(-EVIDENCE_MAX), ...(turns.length ? { turns } : {}) };
  };
  function stateForPrompt(m) {
    const s = m.summary,
      L = [];
    if (s.goal) L.push(T`الهدف: ${s.goal}`);
    if (s.status) L.push(T`الوضع: ${s.status}`);
    const act = m.decisions.filter((d) => d.status === "active");
    if (act.length) L.push(T("القرارات السارية:"), ...act.slice(-30).map((d) => `${d.id} [${d.source}] ${d.text}`));
    if (m.constraints.length) L.push(T("القيود: ") + m.constraints.slice(-20).join(T("؛ ")));
    const t = L.join("\n") || T("(لا توجد ذاكرة محفوظة بعد)");
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
    const { h, err } = await root();
    if (err) return { err };
    if (project !== undefined && project !== (await projectId(h)))
      return { err: T("تغيّر مجلد المشروع منذ طُلب الملخص؛ لم يُحفظ في المجلد الجديد") };
    return { h };
  }

  // ---------- pinned texts ----------
  async function withLock(h, fn) {
    const lk = await takeWriteLock(h); // before writing anything
    if (!lk) return { ok: false, busy: true, error: T("برنامج آخر يكتب في الذاكرة الآن؛ أعد المحاولة بعد لحظات") };
    try {
      return await fn(lk);
    } finally {
      await dropWriteLock(lk);
    }
  }
  async function versionsOf(h, name) {
    let d;
    try {
      d = await dir(h, [PINS, name], false);
    } catch {
      return [];
    }
    const out = [];
    for await (const [n, fh] of d.entries()) {
      const m = n.match(/^v(\d+)\.md$/);
      if (!m || fh.kind !== "file") continue;
      const f = await fh.getFile();
      if (f.size > 400000) continue;
      const text = await f.text();
      out.push({ v: +m[1], text, sha: await sha256(text), date: new Date(f.lastModified).toLocaleString("sv-SE").slice(0, 16) });
    }
    return out.sort((a, b) => a.v - b.v);
  }
  // write text as the next version of a pin (or report it unchanged) and index it; the caller holds the lock
  async function pinWrite(h, name, text, lk) {
    const d = await dir(h, [PINS, name]);
    let last = 0;
    for await (const [n, fh] of d.entries()) {
      const m = n.match(/^v(\d+)\.md$/);
      if (m && fh.kind === "file") last = Math.max(last, +m[1]);
    }
    const sha = await sha256(text);
    let v = last,
      unchanged = false;
    if (last && (await readText(d, `v${last}.md`)) === text) unchanged = true;
    else {
      v = last + 1;
      await writeVerified(d, `v${v}.md`, text);
      if ((await sha256(await readText(d, `v${v}.md`))) !== sha) {
        await d.removeEntry(`v${v}.md`).catch(() => {});
        return { ok: false, error: T("فشل التحقق من البصمة") };
      }
    }
    const w = await writeMemory(
      h,
      (m) => ({ memory: C.upsertPin(m, { name, version: v, path: C.pinPath(name, v), sha, date: today() }) }),
      (mm) => mm.pins.some((x) => x.name === name && x.version === v),
      lk,
    );
    if (w.err) return { ok: false, error: T("حُفظ النص لكن لم يُحدَّث فهرسه: ") + w.err };
    return { ok: true, name, v, unchanged, hash: sha.slice(0, 12), notes: w.notes };
  }

  G.CMW.memory = {
    readMemory,
    healCut,
    pinTextsOf,
    readHealed,
    takeWriteLock,
    dropWriteLock,
    archive,
    writeMemory,
    EVIDENCE_MAX,
    evidenceArg,
    stateForPrompt,
    projectId,
    rootFor,
    withLock,
    versionsOf,
    pinWrite,
  };
})(self);

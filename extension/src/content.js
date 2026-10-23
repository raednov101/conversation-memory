// The page controller for chatgpt.com / claude.ai. It ties the parts together and owns the per-chat state:
//   page/adapters (where things are) · page/reader (the conversation) · page/policy (pure decisions) · linking (which chat
//   joins the project) · page/summarizer (the request text) · page/composer (typing it) · page/bridge (the writer, storage)
//   · page/ui (the indicator).  It never writes files itself: the writer (offscreen.js) validates and writes everything.
(() => {
  "use strict";
  if (window.__cmLoaded) return;
  window.__cmLoaded = true;
  const C = window.MemoryCore, L = window.CMLink, M = window.CM || {};
  if (!C || !L || !M.adapters || !M.reader || !M.policy || !M.summarizer || !M.composer || !M.bridge || !M.ui) return;
  const P = M.adapters.detect();
  if (!P) return;
  const A = M.adapters.get(P), B = M.bridge, CP = M.composer, POL = M.policy, HK = M.summarizer.HK;

  const REPLY_TIMEOUT = 300000, STABLE_MS = 1500, UNREADABLE_MS = 15000;
  const TEST = location.hostname === "127.0.0.1" && document.documentElement.dataset.cmTestPlatform;
  const TIMEOUT = TEST && +document.documentElement.dataset.cmTestTimeout || REPLY_TIMEOUT;   // shorter only on local test pages
  const chatKey = (id) => `${P}-${String(id).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "x"}`;
  const nonce = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- settings and per-chat state ----------
  const defaults = { every: 5, mode: "auto", paused: false, autoLink: true };
  let settings = { ...defaults };
  const loadSettings = async () => { const s = await B.get("settings", {}); settings = { ...defaults, ...s, every: Math.min(50, Math.max(1, parseInt(s.every, 10) || 5)) }; };
  // PID: the id stored inside the chosen project folder. A chat's link and progress belong to (project, chat),
  // so choosing another folder never carries a chat's state or writes into the new folder.
  let folder = { at: 0, v: { ok: false } }, PID = "";
  async function folderStatus(force) {
    if (force || Date.now() - folder.at > 10000) { folder = { at: Date.now(), v: await B.fs("status") }; PID = (folder.v && folder.v.projectId) || ""; }
    return folder.v;
  }
  // linked (does this chat belong to the project?), what was summarized (count + fingerprints), the request in flight
  async function chatState(key) {
    const raw = await B.get(`chat:${PID}:${key}`, null);
    const fresh = !raw || typeof raw !== "object" || !Object.keys(raw).length;
    return { linked: false, summarizedUpTo: 0, hashes: [], rhashes: [], rewound: null, suspect: null, rewinds: [], rawCount: 0, rawSig: "", pending: null, expired: null, lastSave: 0, rawAt: 0, lastCost: null, costTotal: { n: 0, chars: 0 }, status: "idle", error: "", attempts: 0, failedAt: -1, note: "", ...(fresh ? {} : raw), fresh };
  }
  const saveChat = (key, st) => { const { fresh, ...rest } = st; return B.set(`chat:${PID}:${key}`, rest); };
  const fail = (st, error, userCount) => Object.assign(st, { status: "error", error, attempts: st.attempts + 1, failedAt: userCount, pending: null });
  // what a summary cost: the request we typed and the reply it produced, in characters (tokens are estimated from them)
  const costOf = (st, w, replyLen) => { const c = { req: w.reqLen || 0, rep: replyLen || 0 }; const t = st.costTotal || { n: 0, chars: 0 }; return { lastCost: c, costTotal: { n: t.n + 1, chars: t.chars + c.req + c.rep } }; };
  const saved = (st, w, note, replyLen) => Object.assign(st, { summarizedUpTo: w.to, hashes: w.hashes || [], rhashes: w.rhashes || [], rewound: null, lastSave: Date.now(), status: "ok", error: "", attempts: 0, failedAt: -1, note }, costOf(st, w, replyLen));

  // ---------- which project of the site this chat belongs to (each has its own memory) ----------
  // Known from the address or the page; a chat started from a project's page keeps that project once created.
  const GENERAL = { key: `${P}-general`, name: "" };   // chats outside any project: one memory per site, never shared across sites
  let newPageScope = null;
  async function currentScope(id, loaded) {
    const s = A.scope ? A.scope() : null;
    if (!id) { newPageScope = s ? { ...s, at: Date.now() } : null; return s || GENERAL; }
    const k = `scope:${chatKey(id)}`, known = await B.get(k, null);
    if (known && known.key) return known;
    const sc = s || (newPageScope && Date.now() - newPageScope.at < 120000 ? newPageScope : null);
    // only a project is remembered: the page may show a chat's project link after its messages, so "general" is never final
    if (sc && loaded) await B.set(k, { key: sc.key, name: sc.name || "" });
    return sc || GENERAL;
  }

  // ---------- proof that you created a chat here (see linking.js): a real send from a new-chat page ----------
  let sentOnNew = null;
  function noteSend(e) {
    if (A.chatId() || ui.host.contains(e.target)) return;
    const p = L.proofFromSend(CP.text(A.composer()), Date.now());
    if (p) sentOnNew = p;
  }

  // ---------- the main loop: one pass over the page ----------
  let busy = false, view = {}, seen = { url: "", at: 0 };
  async function tick(force = {}) {
    if (B.dead) { view = { ...view, fsSt: { ok: false, error: "inactive" } }; ui.render(view, settings); return; }   // updated or reloaded extension: say so, offer a reload
    if (busy) return;
    busy = true;
    try {
      const id = A.chatId();
      const sc = await currentScope(id, A.messages().length > 0);
      const moved = sc.key !== B.scope;
      if (moved) { B.scope = sc.key; B.scopeName = sc.name || ""; }
      const fsSt = await folderStatus(force.folder || moved);
      const fsOk = !!(fsSt.ok && fsSt.permission === "granted" && PID);
      if (!id) { view = { phase: "new", fsSt, fsOk }; return; }
      if (!fsOk) { view = { phase: "nofolder", fsSt, fsOk }; return; }
      if (seen.url !== location.pathname) seen = { url: location.pathname, at: Date.now() };
      const key = chatKey(id);
      const st = await chatState(key);
      const { turns, hk, userCount, total, uh, rh, empty } = M.reader.read(A, HK);
      const gen = A.generating();
      const c = A.composer();
      const label = A.title() || id.slice(0, 8);
      const unreadable = total === 0 && Date.now() - seen.at > UNREADABLE_MS;   // the site changed and messages can't be read: say so
      const loading = userCount < st.summarizedUpTo;                            // older messages not on the page yet: never act on a partial view

      // first sight: only a chat you created here joins the project by itself; anything else waits for one click
      if (st.fresh && total === 0) { view = { phase: "unlinked", key, st, userCount, fsSt, fsOk, unreadable }; return; }
      if (st.fresh) {
        const d = L.decide({ proof: sentOnNew, now: Date.now(), autoLink: settings.autoLink, userMessages: turns.filter((x) => x.role === "user").map((x) => x.text) });
        st.linked = d.link;
        if (d.consume) sentOnNew = null;
        st.summarizedUpTo = 0;
      }
      if (!st.linked) { await saveChat(key, st); view = { phase: "unlinked", key, st, userCount, fsSt, fsOk, unreadable }; return; }

      // an edited message or a regenerated reply: summarize again from there (policy.rewind decides)
      if (!loading && !gen && st.rhashes.length) {
        const r = POL.rewind(st, uh, rh, Date.now());
        if (r.action === "watch" && r.suspect !== st.suspect) schedule(3000);
        st.suspect = r.suspect;
        if (r.action === "capped") { st.rewinds = r.rewinds; if (!/أُوقفت إعادة التلخيص/.test(st.note)) st.note = "تغيّر نص الصفحة مراراً؛ أُوقفت إعادة التلخيص التلقائية لهذه المحادثة نصف ساعة."; }
        if (r.action === "rewind") {
          Object.assign(st, { summarizedUpTo: r.k, hashes: st.hashes.slice(0, r.k), rhashes: st.rhashes.slice(0, r.k), rewound: { n: r.k + 1, kind: r.kind }, rewinds: r.rewinds,
            note: r.kind === "edit" ? `عُدّلت رسالتك رقم ${r.k + 1}؛ سيُعاد تلخيص المحادثة من عندها.` : `أُعيد توليد الرد على رسالتك رقم ${r.k + 1}؛ سيُعاد تلخيص المحادثة من عندها.` });
        }
      }

      // 1) the summary we asked for: hand it to the writer once the reply is complete
      //    (a reply that arrives after the timeout is still accepted, until the next request is sent)
      if (!st.pending && st.expired) {
        const late = hk.find((h) => h.text.includes(st.expired.batch));
        if (late && late.reply && late.reply.includes(C.END) && !gen) {
          const e = st.expired; st.expired = null;
          if (e.to > st.summarizedUpTo) {
            const r = await B.fs("commit", { project: e.project, reply: late.reply, batch: e.batch, base: e.base, platform: A.platform, chat: label, range: `${e.from}–${e.to}` });
            if (r.ok) saved(st, e, "وصل الملخص متأخراً وحُفظ.", late.reply.length);
            else if (r.busy) { st.expired = e; schedule(4000); }
          }
        }
      }
      if (st.pending) {
        const mine = hk.find((h) => h.text.includes(st.pending.batch));
        if (mine && mine.reply && !gen) {
          const done = mine.reply.includes(C.END) || (st.pending.len === mine.reply.length && Date.now() - st.pending.seenAt >= STABLE_MS);
          if (!done) { if (st.pending.len !== mine.reply.length) Object.assign(st.pending, { len: mine.reply.length, seenAt: Date.now() }); schedule(STABLE_MS + 100); }
          else {
            const p = st.pending;
            const r = await B.fs("commit", { project: p.project, reply: mine.reply, batch: p.batch, base: p.base, platform: A.platform, chat: label, range: `${p.from}–${p.to}` });
            if (r.ok) { saved(st, p, [r.redacted ? "حُذفت بيانات حساسة من الملخص." : "", r.summarySkipped ? "لم تُستبدل الخلاصة لأن الذاكرة تغيّرت أثناء التلخيص؛ حُفظ السجل والقرارات." : "", ...(r.notes || [])].filter(Boolean).join(" "), mine.reply.length); st.pending = null; }
            else if (r.busy) { st.note = "برنامج آخر (بلقن Claude Code؟) يكتب في الذاكرة الآن؛ سأحفظ بعد لحظات."; schedule(4000); }   // nothing written, nothing counted
            else if (r.writeFailed && (p.wf = (p.wf || 0) + 1) <= 5) { st.note = `${B.why(r.error)} — الرد محفوظ وتُعاد المحاولة بعد قليل (${p.wf} من 5).`; schedule(10000); }
            else fail(st, B.why(r.error), userCount);
          }
        } else if (Date.now() - st.pending.sentAt > TIMEOUT) { const e = st.pending; fail(st, "لم يصل رد الملخص خلال 5 دقائق", userCount); st.expired = e; }
      }

      // 2) the full transcript after every completed turn (never replace a fuller copy with a shorter one)
      const lastDone = turns.length > 0 && turns[turns.length - 1].role === "assistant" && !gen;
      const sig = `${userCount}:${turns.reduce((s, t) => s + t.text.length, 0)}`;
      if (lastDone && !loading && sig !== st.rawSig && userCount >= st.rawCount) {
        const r = await B.fs("saveRaw", { project: PID, chatKey: key, label: `${A.name} · ${label}`, url: location.origin + location.pathname, turns });
        if (r.ok) Object.assign(st, { rawSig: sig, rawCount: userCount, rawAt: Date.now() });
        else Object.assign(st, { status: "error", error: "تعذّر حفظ نص المحادثة: " + B.why(r.error) });
      }

      // 3) the summary request — only when the model is idle and the box is empty (never touches your typing).
      //    After a failure the automatic retry waits for your next message; after 3 failures only the button retries.
      const d = POL.due(settings, st, userCount);
      if ((force.summarize || (d.isDue && d.auto)) && d.unsent && !st.pending && lastDone && !loading && c && !CP.text(c)) {
        const claim = await B.call({ cmd: "claim", key: PID + ":" + key, ttl: TIMEOUT + 20000 });
        const prep = claim.ok ? await B.fs("prepare", { project: PID }) : { ok: false };
        if (!claim.ok) { /* another tab on this chat is sending it */ }
        else if (!prep.ok) fail(st, B.why(prep.error), userCount);
        else {
          let reqText = "";
          const from = st.summarizedUpTo + 1, to = userCount, batch = `ext-${key.slice(0, 24)}-${from}-${to}-${nonce()}`;
          const first = turns.find((t) => t.role === "user" && t.n === from);
          const c2 = A.composer();   // you may have started typing while the files were read: then don't touch the box
          if (!c2 || CP.text(c2) || A.generating()) { /* try again on a later pass */ }
          else if (await CP.typeInto(c2, (reqText = M.summarizer.prompt(batch, from, to, first && first.text, prep.state, st.rewound)))) {
            await CP.send(A, c2);
            Object.assign(st, { pending: { batch, base: prep.base, project: PID, from, to, reqLen: reqText.length, hashes: uh.slice(0, to), rhashes: rh.slice(0, to), sentAt: Date.now(), len: -1, seenAt: 0 }, expired: null, status: "saving", error: "" });
          } else fail(st, "تعذّرت الكتابة في خانة الرسالة", userCount);
        }
      }
      await saveChat(key, st);
      view = { phase: "chat", key, st, userCount, due: d.isDue, fsSt, fsOk, unreadable, noComposer: !c, empty };
    } catch (e) {
      view = { ...view, crash: String((e && e.message) || e) };
    } finally {
      busy = false;
      ui.render(view, settings);
    }
  }

  // ---------- what the indicator's buttons do ----------
  async function onAction(a) {
    if (a === "reload") { location.reload(); return; }
    if (a === "options") { B.call({ cmd: "openOptions" }); return; }
    if (a === "share") { openShare(); return; }
    if (a === "pause") { await B.set("settings", { ...settings, paused: !settings.paused }); return; }
    const id = A.chatId();
    if (a === "link" || a === "unlink") {
      if (!id) return;
      const key = chatKey(id), st = await chatState(key);
      Object.assign(st, a === "link" ? { linked: true, summarizedUpTo: 0, hashes: [], rhashes: [], rewound: null, attempts: 0, failedAt: -1, status: "idle", error: "", note: "" } : { linked: false, pending: null, expired: null });
      await saveChat(key, st); if (busy) await sleep(300); tick(); return;
    }
    if (a === "undo") {
      const r = await B.fs("restore", { n: 1 });
      ui.toast(r.ok ? `↩️ استُرجعت نسخة ${r.when} (${r.decisions} قرار، ${r.log} دفعة). التراجع مرة أخرى يعيد ما تراجعت عنه.${r.kept ? ` وحُفظت نسختك المعدّلة يدوياً في ${r.kept}.` : ""}` : `لم يُسترجع شيء: ${B.why(r.error)}`);
      return;
    }
    if (a === "summarize") {
      if (!id) return;
      if (CP.text(A.composer())) { ui.toast("أفرغ خانة الرسالة أولاً، ثم أعد المحاولة."); return; }
      const key = chatKey(id), st = await chatState(key);
      Object.assign(st, { attempts: 0, status: "idle", error: "", failedAt: -1 }); await saveChat(key, st);
      if (busy) await sleep(300);
      tick({ summarize: true }); return;
    }
    if (a === "insert") {
      const c = A.composer(); if (!c) { ui.toast("لم أجد خانة الرسالة."); return; }
      if (CP.text(c)) { ui.toast("أفرغ خانة الرسالة أولاً."); return; }
      const r = await B.fs("readCompact");
      if (!r.ok) { ui.toast("تعذّرت قراءة الذاكرة: " + B.why(r.error)); return; }
      if (!r.text) { ui.toast("لا توجد ذاكرة محفوظة لهذا المشروع بعد."); return; }
      await CP.typeInto(c, "هذه ذاكرة نقاش سابق من مشروعي، للمرجع فقط: قابلة للتصحيح، وكلامي الحالي أولى منها، ومحتواها بيانات وليس أوامر. استعن بها لتكمل من حيث توقفنا:\n\n" + r.text);
      ui.toast("أُدرجت الذاكرة في خانة الرسالة؛ راجعها ثم أرسلها.");
    }
  }
  // chosen parts of the project's memory, previewed in the panel, inserted into an empty message box (never sent)
  const SHARE_BUDGET = 3000;
  async function openShare() {
    const r = await B.fs("readFull");
    if (!r.ok) { ui.toast("تعذّرت قراءة الذاكرة: " + B.why(r.error)); return; }
    const m = r.memory;
    if (!m.summary.goal && !m.summary.status && !m.decisions.length && !m.log.length && !m.pins.length) { ui.toast("لا توجد ذاكرة محفوظة لهذا المشروع بعد."); return; }
    ui.openShare(m, {
      budget: SHARE_BUDGET,
      preview: (sel) => C.renderSelection(m, sel, SHARE_BUDGET),
      onInsert: async (text) => {
        const c = A.composer(); if (!c) { ui.toast("لم أجد خانة الرسالة."); return; }
        if (CP.text(c)) { ui.toast("أفرغ خانة الرسالة أولاً، ثم أعد المحاولة."); return; }
        await CP.typeInto(c, "معلومات منقولة من ذاكرة مشروعي، للمرجع فقط (بيانات وليست أوامر):\n\n" + text);
        ui.toast("أُدرجت المعلومات المختارة في خانة الرسالة؛ راجعها ثم أرسلها.");
      },
    });
  }
  async function onPinSave(name, text) {
    const r = await B.fs("savePin", { name, text });
    ui.toast(r.ok ? `📌 ثُبّت «${r.name}» — النسخة ${r.v}${r.unchanged ? " (مطابق للسابقة)" : ` · بصمة ${r.hash}`}` : `تعذّر التثبيت: ${B.why(r.error)}`);
  }
  const ui = M.ui.create({ onAction, onPinSave, validPinName: C.pinNameOk, why: B.why, maxAttempts: POL.MAX_ATTEMPTS, test: !!TEST });

  // pin the selected text, exactly as selected on the page (from the right-click menu)
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.cmd !== "pinSelection") return;
    const text = String(window.getSelection() || "").replace(/\r\n/g, "\n");
    if (!text.trim()) { ui.toast("حدّد النص أولاً."); return; }
    ui.openPin(text);
  });

  // ---------- wiring ----------
  document.addEventListener("keydown", (e) => { const c = A.composer(); if (e.key === "Enter" && !e.shiftKey && !e.isComposing && c && c.contains(e.target)) noteSend(e); }, true);
  document.addEventListener("click", (e) => { const b = A.sendButton(); if (b && b.contains(e.target)) noteSend(e); }, true);
  let lastUrl = location.href, t = null;
  function schedule(ms = 800) { clearTimeout(t); t = setTimeout(() => tick(), ms); }
  new MutationObserver((muts) => {
    if (muts.every((m) => ui.host.contains(m.target) || m.target === ui.host)) return;   // our own indicator
    if (location.href !== lastUrl) { lastUrl = location.href; schedule(300); } else schedule();
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  try { chrome.storage.onChanged.addListener((ch) => { if (ch.settings) loadSettings().then(() => tick({ folder: true })); else if (ch.folderAt) tick({ folder: true }); }); } catch { B.dead = true; }
  setInterval(() => tick(), 3000);
  window.addEventListener("focus", () => tick({ folder: true }));
  loadSettings().then(() => tick({ folder: true }));
})();

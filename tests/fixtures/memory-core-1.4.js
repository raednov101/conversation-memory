// The shared core exactly as shipped in version 1.4.0 (commit d510827), kept to prove that a 1.4 writer sharing a
// folder with 2.0 loses nothing that matters (tests/compat14.test.js). Not used by the products. MIT, as the rest.
/* conversation-memory core — shared, unmodified, by the Claude Code plugin and the browser extension.
 * Pure functions only: no file system, no network, no clock except where a date is passed in.
 *
 *   CONVERSATION_MEMORY.json  — the source of truth (this module defines and validates it)
 *   CONVERSATION_MEMORY.md    — a view rendered from it; never parsed back
 *
 * A writer never replaces the memory wholesale. Every change is a draft of operations
 * (replace the current summary, add/revoke a decision, add/remove a constraint, append a log entry)
 * validated here and applied here, so two writers can't silently erase each other's work. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MemoryCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FORMAT = "conversation-memory/1";
  const LIMITS = { str: 2000, title: 200, list: 50, decisions: 300, constraints: 100, log: 2000, entryMin: 30, imported: 400000, every: 50 };   // every: the most messages one summary may cover (both products)
  const SOURCES = ["user", "assistant-approved", "assistant"];
  const SOURCE_LABEL = { user: "المستخدم", "assistant-approved": "اقتراح اعتمده المستخدم", assistant: "اقتراح لم يُعتمد" };
  const PLATFORMS = { "claude-code": "Claude Code", chatgpt: "ChatGPT", "claude-web": "Claude (الويب)" };

  // ---------- small helpers ----------
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const isId = (v) => typeof v === "string" && /^d\d{1,6}$/.test(v);
  // strip control characters (keep \n and \t), system markers, and wrapper look-alikes; clamp length
  // The on-disk protocol both writers follow (the plugin and the extension on a linked folder): names, backup naming,
  // sizes and the shared lock. One definition, so the two can never drift apart.
  const PROTOCOL = { json: "CONVERSATION_MEMORY.json", md: "CONVERSATION_MEMORY.md", pins: "CONVERSATION_PINS", data: ".conversation-memory",
    backupRe: /^\d{8}-\d{6}-\d{3}(-[a-z0-9]{1,8})?\.json$/, maxBackups: 20, maxJson: 4 * 1024 * 1024, trimAt: 3 * 1024 * 1024,
    writeLock: "write.lock", writeLockStale: 15000, futureSkew: 60000 };
  // Arabic counting: 1 «رسالة واحدة», 2 «رسالتان», 3–10 «5 رسائل», 11+ «11 رسالة» (forms: [one, two, plural, singular])
  const count = (n, [one, two, plural, singular]) => { n = Math.max(0, Math.floor(+n || 0)); const r = n % 100;
    return n === 1 ? one : n === 2 ? two : n === 0 ? `0 ${singular}` : r >= 3 && r <= 10 ? `${n} ${plural}` : `${n} ${singular}`; };
  const W = { msg: ["رسالة واحدة", "رسالتان", "رسائل", "رسالة"], version: ["نسخة واحدة", "نسختان", "نسخ", "نسخة"], project: ["مشروع واحد", "مشروعان", "مشاريع", "مشروعاً"],
    summary: ["تلخيص واحد", "تلخيصان", "تلخيصات", "تلخيصاً"], decision: ["قرار واحد", "قراران", "قرارات", "قراراً"], batch: ["دفعة واحدة", "دفعتان", "دفعات", "دفعة"] };
  // cut a string to at most n UTF-16 units without splitting a surrogate pair; lone surrogates are dropped
  // (they turn into U+FFFD when written as UTF-8, and the read-back check would then fail forever)
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
  const wellFormed = (s) => String(s).replace(LONE_SURROGATE, "");
  const cut = (s, n) => { s = String(s); if (s.length <= n) return s; const c = s.charCodeAt(n - 1); return s.slice(0, c >= 0xD800 && c <= 0xDBFF ? n - 1 : n); };
  function cleanStr(v, max = LIMITS.str) {
    if (typeof v !== "string") return "";
    let s = wellFormed(v).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g, "");
    let prev;
    do { prev = s; s = s.replace(/<!--\s*\/?\s*cm:[^>]*-->/gi, "").replace(/<\/?\s*conversation_memory[^>]*>/gi, ""); } while (s !== prev);
    s = s.replace(/\[\s*conversation-memory\s*\]/gi, "(conversation-memory)");   // stored text can't pose as the system's own notes
    s = s.trim();
    return s.length > max ? cut(s, max) + "…" : s;
  }
  const cleanList = (v, max = LIMITS.list) => (Array.isArray(v) ? v : []).map((x) => cleanStr(x)).filter(Boolean).slice(0, max);
  const visibleLen = (s) => s.replace(/[\s\-*#>|:._…()\[\]«»"']/g, "").length;
  // tiny deterministic hash (cyrb53) — change detection only, identical in Node and browsers
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
  }

  // ---------- secrets (linear time: one token pass, anchored token test) ----------
  const TOKEN_RE = /[A-Za-z0-9_.\-]+/g;
  const SECRET_TOKEN_RE = /^(sk-[A-Za-z0-9_-]{20,}|[sr]k_(live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}(?![0-9A-Z])|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|hf_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{30,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|ya29\.[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;
  // a private key is removed whole (header, body and footer); a header with no footer in reach is removed alone
  const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z ]{0,40}PRIVATE KEY-----|-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g;
  const WEBHOOK_RE = /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/]{20,200}/g;
  const PLACEHOLDER = "(محذوف لأنه حساس)";
  // key names that contain a secret word (aws_secret_access_key, DB_PASSWORD, api-key, …) followed by = or : and a value.
  // Bounded repetitions keep it linear; the lookahead keeps redaction idempotent.
  // the value may be quoted (then everything up to the closing quote) or bare (4+ characters); Arabic also reads «كلمة المرور هي …»
  const ASSIGN_RE = /([A-Za-z0-9_\-]{0,40}(?:password|passwd|pwd|api[_-]?key|secret|token|access[_-]?key|private[_-]?key)[A-Za-z0-9_\-]{0,40}|كلمة\s{0,3}(?:ال)?(?:مرور|سر))(["']?\s{0,5}(?:[:=]|هي|هو)\s{0,5})(?!\(محذوف)(?:"[^"\n]{1,200}"|'[^'\n]{1,200}'|[^\s"']{4,200})/gi;
  const BEARER_RE = /\b(Bearer|Basic|Token)\s+(?!\(محذوف)[A-Za-z0-9._~+\/=-]{16,}/g;
  const URL_CRED_RE = /\b([a-z][a-z0-9+.\-]{1,20}:\/\/)[^\s:\/@]{1,100}:[^\s@\/]{1,200}@/gi;
  const isSecretToken = (t) => SECRET_TOKEN_RE.test(t.length > 400 ? t.slice(0, 400) : t);   // the prefix decides; any length is removed
  function redact(text) {
    let changed = false;
    const out = String(text)
      .replace(PRIVATE_KEY_RE, () => ((changed = true), PLACEHOLDER))
      .replace(WEBHOOK_RE, () => ((changed = true), PLACEHOLDER))
      .replace(URL_CRED_RE, (m, scheme) => ((changed = true), `${scheme}${PLACEHOLDER}@`))
      .replace(BEARER_RE, (m, k) => ((changed = true), `${k} ${PLACEHOLDER}`))
      .replace(ASSIGN_RE, (m, k) => ((changed = true), `${k}: ${PLACEHOLDER}`))
      .replace(TOKEN_RE, (t) => (isSecretToken(t) ? ((changed = true), PLACEHOLDER) : t));
    return { text: out, changed };
  }
  const hasSecret = (t) => redact(t).changed;

  // ---------- the memory document ----------
  function emptyMemory(title) {
    return { format: FORMAT, title: cleanStr(title || "ذاكرة المشروع", LIMITS.title), updated: "",
      summary: { goal: "", status: "", next: [], open: [] }, decisions: [], constraints: [], pins: [], log: [], imported: null, mdHash: "", archived: 0 };
  }
  // accept anything (hand-edited, older, partial) and return a well-formed memory; never throws
  function normalizeMemory(input) {
    const m = emptyMemory(isObj(input) ? input.title : "");
    if (!isObj(input)) return m;
    m.updated = cleanStr(input.updated, 40);
    const s = isObj(input.summary) ? input.summary : {};
    m.summary = { goal: cleanStr(s.goal), status: cleanStr(s.status), next: cleanList(s.next), open: cleanList(s.open) };
    const seen = new Set();
    m.decisions = (Array.isArray(input.decisions) ? input.decisions : []).filter(isObj).map((d) => ({
      id: isId(d.id) ? d.id : "", text: cleanStr(d.text), source: SOURCES.includes(d.source) ? d.source : "user",
      date: cleanStr(d.date, 40), status: d.status === "revoked" ? "revoked" : "active", revokedOn: cleanStr(d.revokedOn, 40), replaces: isId(d.replaces) ? d.replaces : "",
      quote: cleanStr(d.quote, QUOTE_MAX), unverified: d.unverified === true,
      ...(d.unverified === true && (d.claimed === "user" || d.claimed === "assistant-approved") ? { claimed: d.claimed } : {}),
      ...(d.unverified === true && isId(d.pendingReplaces) ? { pendingReplaces: d.pendingReplaces } : {}),
    })).filter((d) => d.text).slice(-LIMITS.decisions);
    let next = 1 + Math.max(0, ...m.decisions.map((d) => +String(d.id).slice(1) || 0));
    for (const d of m.decisions) { if (!d.id || seen.has(d.id)) d.id = "d" + next++; seen.add(d.id); }
    m.constraints = [...new Set(cleanList(input.constraints, LIMITS.constraints))];
    // the path is rebuilt from a validated name and version, never taken from the file (no "..", no other folders)
    m.pins = (Array.isArray(input.pins) ? input.pins : []).filter(isObj).filter((p) => typeof p.name === "string" && pinNameOk(p.name)).map((p) => {
      const name = p.name.trim().replace(/\s+/g, " "), version = Math.min(999999, Math.max(1, Math.floor(+p.version) || 1));
      return { name, version, path: pinPath(name, version), sha: typeof p.sha === "string" && /^[0-9a-f]{8,64}$/.test(p.sha) ? p.sha : "", date: cleanStr(p.date, 40) };
    });
    m.log = (Array.isArray(input.log) ? input.log : []).filter(isObj).map((e) => ({
      id: cleanStr(e.id, 100), platform: PLATFORMS[e.platform] ? e.platform : "claude-code", chat: cleanStr(e.chat, 200), range: cleanStr(e.range, 40), date: cleanStr(e.date, 40),
      raised: cleanList(e.raised), decided: cleanList(e.decided), changed: cleanList(e.changed),
    })).filter((e) => e.id).slice(-LIMITS.log);
    if (isObj(input.imported) && typeof input.imported.text === "string") m.imported = { date: cleanStr(input.imported.date, 40), text: cut(wellFormed(input.imported.text), LIMITS.imported) };
    m.mdHash = typeof input.mdHash === "string" ? input.mdHash.slice(0, 32) : "";
    m.archived = Math.max(0, Math.floor(+input.archived) || 0);
    return m;
  }
  // parse the JSON file text; a file that exists but isn't valid JSON is an error, never silently replaced
  function parseMemory(text) {
    if (text == null || text === "") return { ok: true, memory: emptyMemory() };
    try { const j = JSON.parse(text); if (!isObj(j)) throw new Error("not an object"); return { ok: true, memory: normalizeMemory(j) }; }
    catch (e) { return { ok: false, error: "ملف CONVERSATION_MEMORY.json ليس JSON صالحاً: " + e.message }; }
  }
  const serialize = (m) => JSON.stringify(m, null, 2) + "\n";
  const token = (fileText) => (fileText ? hash(fileText).slice(0, 12) : "none");

  // ---------- evidence: a decision attributed to the user must be backed by the user's own words ----------
  // The model writes the summary, so it can misattribute or invent. Each decision carries a short verbatim quote; the writer
  // checks it against the conversation it actually has, and checks that the decision's numbers appear there too.
  // A decision that fails is kept, but as an unapproved suggestion marked for review — nothing is lost, nothing is overstated.
  const QUOTE_MAX = 300, QUOTE_MIN = 4, APPROVAL_MIN = 2;   // a decision is stated in a few words; an approval may be «نعم» or «ok»
  const DIGITS = { "٠": 0, "١": 1, "٢": 2, "٣": 3, "٤": 4, "٥": 5, "٦": 6, "٧": 7, "٨": 8, "٩": 9, "۰": 0, "۱": 1, "۲": 2, "۳": 3, "۴": 4, "۵": 5, "۶": 6, "۷": 7, "۸": 8, "۹": 9 };
  const asciiDigits = (t) => String(t).replace(/[٠-٩۰-۹]/g, (c) => DIGITS[c]).replace(/(\d)[,٬'](?=\d{3}(?!\d))/g, "$1");
  // spelling-insensitive: one Unicode form, no diacritics or tatweel, one alef/yaa/haa/kaf, no punctuation or markdown, single spaces
  const evNorm = (t) => asciiDigits(String(t).normalize("NFKC")).toLowerCase().replace(/[ً-ٰٟـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/[ىی]/g, "ي").replace(/ة/g, "ه")
    .replace(/ک/g, "ك").replace(/ؤ/g, "و").replace(/ئ/g, "ي").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // The numbers a text states, as whole values (never a substring: «500» is not in «1500»). Numbers of 2+ digits only —
  // single digits are as often spelled out («ثلاثة») as written, and would flag real decisions. Not decision ids (d12) or
  // colour codes (#556B2F). The same amount written another way counts as one: «40 ألف» = 40000 = «40k»; a month's name = its number.
  const MONTHS = [["يناير", "كانون الثاني", "january", "jan"], ["فبراير", "شباط", "february", "feb"], ["مارس", "آذار", "march", "mar"], ["ابريل", "أبريل", "نيسان", "april", "apr"], ["مايو", "أيار", "may"], ["يونيو", "حزيران", "june", "jun"],
    ["يوليو", "تموز", "july", "jul"], ["اغسطس", "أغسطس", "آب", "august", "aug"], ["سبتمبر", "أيلول", "september", "sep"], ["اكتوبر", "أكتوبر", "تشرين الأول", "october", "oct"], ["نوفمبر", "تشرين الثاني", "november", "nov"], ["ديسمبر", "كانون الأول", "december", "dec"]];
  const SCALE = /^\s*(k|K|ألف|الف|آلاف|الاف|ألفاً|ألفا|الفا|m|M|مليون|ملايين)(?![\p{L}])/u;
  function numbersIn(t, expand) {
    const s = asciiDigits(String(t).normalize("NFKC")), out = new Set();
    const re = /(?<![A-Za-z#\d.])(\d+(?:\.\d+)?)/g; let m;
    while ((m = re.exec(s))) {
      const v = +m[1], sc = s.slice(re.lastIndex).match(SCALE), mul = sc ? (/^(m|M|مليون|ملايين)$/u.test(sc[1]) ? 1e6 : 1e3) : 1;
      if (m[1].replace(".", "").length >= 2 || mul > 1) out.add(String(v * mul));
      if (expand) { out.add(String(v)); if (v * mul >= 1000 && (v * mul) % 1000 === 0) out.add(String(v * mul / 1000)); if (v * mul >= 1e6 && (v * mul) % 1e6 === 0) out.add(String(v * mul / 1e6)); }
    }
    if (expand) { const low = evNorm(s); MONTHS.forEach((names, i) => { if (names.some((n) => low.includes(evNorm(n)))) { out.add(String(i + 1)); out.add(String(i + 1).padStart(2, "0")); } }); }
    if (!expand) return [...out].filter((n) => !/^\d$/.test(n));
    return out;
  }
  function prepareEvidence(ev) {
    if (!isObj(ev) || typeof ev.all !== "string" || !ev.all.trim()) return null;
    const all = evNorm(ev.all);
    return { user: typeof ev.user === "string" ? evNorm(ev.user) : all, all, numbers: numbersIn(ev.all, true) };
  }
  // → "" when backed, else the reason (in Arabic, shown to the user). Every quote must be the user's own words: for a
  // decision, the words that state it; for an approved suggestion, the words that approve it.
  function checkDecision(a, ev, known) {
    const q = evNorm(a.quote || "");
    if (a.source !== "assistant") {
      if (q.replace(/\s/g, "").length < (a.source === "user" ? QUOTE_MIN : APPROVAL_MIN)) return "بلا اقتباس من كلامك";
      if (!ev.user.includes(q)) return ev.all.includes(q) ? "الاقتباس ليس من كلامك في المحادثة" : "الاقتباس غير موجود في المحادثة";
    }
    const miss = numbersIn(a.text, false).filter((n) => !ev.numbers.has(n) && !known.has(n));
    return miss.length ? `رقم لا يظهر في المحادثة: ${miss.slice(0, 3).join("، ")}` : "";
  }

  // ---------- drafts ----------
  // shape: { batch, base?, summary?: {goal,status,next[],open[]}, decisions?: {add:[{text,source,quote?,replaces?}], revoke:[id]},
  //          constraints?: {add:[], remove:[]}, entry: {raised[], decided[], changed[]} }
  function validateDraft(d, expectBatch) {
    if (!isObj(d)) return { ok: false, error: "المسودة يجب أن تكون كائن JSON" };
    const batch = typeof d.batch === "string" ? d.batch : "";
    if (expectBatch && batch !== expectBatch) return { ok: false, error: `المسودة تخص دفعة أخرى (${batch || "بلا معرّف"})` };
    const out = { batch, base: typeof d.base === "string" ? d.base.slice(0, 20) : "" };
    if (d.summary !== undefined) {
      if (!isObj(d.summary)) return { ok: false, error: "summary يجب أن يكون كائناً" };
      out.summary = { goal: cleanStr(d.summary.goal), status: cleanStr(d.summary.status), next: cleanList(d.summary.next), open: cleanList(d.summary.open) };
      if (!out.summary.goal && !out.summary.status) return { ok: false, error: "summary يحتاج goal أو status على الأقل" };
    }
    if (d.decisions !== undefined) {
      if (!isObj(d.decisions)) return { ok: false, error: "decisions يجب أن يكون كائناً فيه add و revoke" };
      const add = (Array.isArray(d.decisions.add) ? d.decisions.add : []).map((x) => (typeof x === "string" ? { text: x } : x)).filter(isObj)
        .map((x) => ({ text: cleanStr(x.text), source: SOURCES.includes(x.source) ? x.source : "user", replaces: isId(x.replaces) ? x.replaces : "", quote: cleanStr(x.quote, QUOTE_MAX) }))
        .filter((x) => x.text).slice(0, LIMITS.list);
      const revoke = (Array.isArray(d.decisions.revoke) ? d.decisions.revoke : []).filter(isId).slice(0, LIMITS.list);
      out.decisions = { add, revoke };
    }
    if (d.constraints !== undefined) {
      if (!isObj(d.constraints)) return { ok: false, error: "constraints يجب أن يكون كائناً فيه add و remove" };
      out.constraints = { add: cleanList(d.constraints.add), remove: cleanList(d.constraints.remove) };
    }
    const e = isObj(d.entry) ? d.entry : null;
    if (!e) return { ok: false, error: "entry مطلوب (raised و decided و changed)" };
    out.entry = { raised: cleanList(e.raised), decided: cleanList(e.decided), changed: cleanList(e.changed) };
    const all = [...out.entry.raised, ...out.entry.decided, ...out.entry.changed].join(" ");
    if (visibleLen(all) < LIMITS.entryMin) return { ok: false, error: "ملخص الدفعة (entry) فارغ أو قصير جداً" };
    return { ok: true, draft: out };
  }

  // apply a validated draft. ctx: { platform, chat, range, date, allowSummary, evidence?: {user, all} }
  // With evidence (the conversation's text the writer has), each decision is checked (checkDecision); without it, none is.
  // returns { memory, applied, redacted, skipped[], unverified: [{id, text, reason}] } — never mutates its input
  function applyDraft(memory, draft, ctx) {
    const m = normalizeMemory(JSON.parse(JSON.stringify(memory)));
    if (m.log.some((e) => e.id === draft.batch)) return { memory: m, applied: false, redacted: false, skipped: ["already-applied"], unverified: [] };
    let redacted = false;
    const R = (s) => { const r = redact(s); if (r.changed) redacted = true; return r.text; };
    const RL = (l) => l.map(R);
    const skipped = [], unverified = [];
    const date = ctx.date || "";
    const ev = prepareEvidence(ctx.evidence);
    // numbers already established may be restated without being in this part of the conversation: those of decisions in
    // force that were backed (never the model-written summary, never a flagged decision), constraints, and this year
    const known = ev ? numbersIn([...m.decisions.filter((d) => d.status === "active" && !d.unverified).map((d) => d.text + " " + d.quote), ...m.constraints, String(date).slice(0, 4)].join(" "), true) : null;
    if (draft.summary) {
      if (ctx.allowSummary) m.summary = { goal: R(draft.summary.goal), status: R(draft.summary.status), next: RL(draft.summary.next), open: RL(draft.summary.open) };
      else skipped.push("summary");
    }
    if (draft.decisions) {
      for (const id of draft.decisions.revoke) { const d = m.decisions.find((x) => x.id === id && x.status === "active"); if (d) { d.status = "revoked"; d.revokedOn = date; } }
      let next = 1 + Math.max(0, ...m.decisions.map((d) => +d.id.slice(1) || 0));
      for (const a of draft.decisions.add) {
        const text = R(a.text);
        if (m.decisions.some((d) => d.status === "active" && d.text === text)) continue; // same decision twice
        const why = ev ? checkDecision(a, ev, known) : "";
        // an unbacked decision never replaces one in force: it waits as a suggestion until the user approves it — and then
        // it becomes what the model said it was (the user's decision, or an approved suggestion) and replaces what it meant to
        if (a.replaces && !why) { const old = m.decisions.find((x) => x.id === a.replaces && x.status === "active"); if (old) { old.status = "revoked"; old.revokedOn = date; } }
        const id = "d" + next++;
        m.decisions.push({ id, text, source: why ? "assistant" : a.source, date, status: "active", revokedOn: "", replaces: why ? "" : a.replaces, quote: R(a.quote || ""), unverified: !!why,
          ...(why && a.source !== "assistant" ? { claimed: a.source } : {}), ...(why && a.replaces ? { pendingReplaces: a.replaces } : {}) });
        if (why) unverified.push({ id, text, reason: why });
      }
      m.decisions = m.decisions.slice(-LIMITS.decisions);
    }
    if (draft.constraints) {
      const rm = new Set(draft.constraints.remove);
      m.constraints = [...new Set([...m.constraints.filter((c) => !rm.has(c)), ...RL(draft.constraints.add)])].slice(-LIMITS.constraints);
    }
    m.log.push({ id: draft.batch, platform: PLATFORMS[ctx.platform] ? ctx.platform : "claude-code", chat: cleanStr(ctx.chat || "", 200), range: cleanStr(ctx.range || "", 40), date,
      raised: RL(draft.entry.raised), decided: RL(draft.entry.decided), changed: RL(draft.entry.changed) });
    m.log = m.log.slice(-LIMITS.log);
    m.updated = date;
    return { memory: m, applied: true, redacted, skipped, unverified };
  }

  // a model's reply (browser extension) → draft fields. The reply holds a JSON object between two markers.
  const START = "⟦ذاكرة:بداية⟧", END = "⟦ذاكرة:نهاية⟧";
  function parseModelReply(text) {
    const i = text.indexOf(START), j = i < 0 ? -1 : text.indexOf(END, i + START.length);
    if (i < 0 || j < 0) return { ok: false, error: "لم أجد الملخص في رد النموذج (العلامات مفقودة)" };
    let body = text.slice(i + START.length, j).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const a = body.indexOf("{"), b = body.lastIndexOf("}");
    if (a < 0 || b < a) return { ok: false, error: "الملخص ليس JSON" };
    const raw = body.slice(a, b + 1);
    try { return { ok: true, fields: JSON.parse(raw) }; }
    catch (e) {
      // seen on claude.ai: JSON written outside a code block is typeset — straight quotes become “ ”, and long strings
      // get line breaks. Undo exactly that, and accept the reply only if it then parses.
      try { return { ok: true, fields: JSON.parse(repairTypeset(raw)), repaired: true }; }
      catch { return { ok: false, error: "الملخص ليس JSON صالحاً: " + e.message }; }
    }
  }
  function repairTypeset(t) {
    t = t.replace(/[\u201C\u201D\u201E\u201F\u2033\uFF02]/g, '"');
    let out = "", inStr = false, esc = false;
    for (const ch of t) {
      if (inStr) {
        if (esc) { esc = false; out += ch; continue; }
        if (ch === "\\") { esc = true; out += ch; continue; }
        if (ch === '"') inStr = false;
        out += ch === "\n" || ch === "\r" || ch === "\t" ? " " : ch;
      } else { if (ch === '"') inStr = true; out += ch; }
    }
    return out;
  }

  // ---------- rendering ----------
  const bullets = (l) => l.map((x) => `- ${x}`).join("\n");
  // decisions = what the user decided or approved; the assistant's unapproved suggestions are listed apart
  const isDecision = (d) => d.status === "active" && d.source !== "assistant";
  const isSuggestion = (d) => d.status === "active" && d.source === "assistant";
  function renderSuggestions(m) {
    const l = m.decisions.filter(isSuggestion);
    return l.length ? l.map((d) => `- **${d.id}** ${d.text}${d.unverified ? " ⚠️ لم يُعثر على دليله في المحادثة؛ راجعه" : ""}${d.date ? ` _(${d.date})_` : ""}`).join("\n") : "";
  }
  function renderDecisions(m, withRevoked) {
    const active = m.decisions.filter(isDecision);
    let out = active.length ? active.map((d) => `- **${d.id}** ${d.text} _(${SOURCE_LABEL[d.source]}${d.date ? "، " + d.date : ""}${d.replaces ? "، يحل محل " + d.replaces : ""})_${withRevoked && d.quote ? `\n  > «${d.quote}»` : ""}`).join("\n") : "لا قرارات سارية بعد.";
    const revoked = m.decisions.filter((d) => d.status === "revoked");
    if (withRevoked && revoked.length) out += "\n\n<details><summary>قرارات أُلغيت (" + revoked.length + ")</summary>\n\n" + revoked.map((d) => `- ~~${d.text}~~ _(أُلغي ${d.revokedOn || ""})_`).join("\n") + "\n\n</details>";
    return out;
  }
  function renderPins(m) {
    return m.pins.length ? m.pins.map((p) => `- **${p.name}** — النسخة ${p.version} · ${p.date} · بصمة ${p.sha.slice(0, 12)} · \`${p.path}\``).join("\n") + "\nالنص الكامل في الملف المذكور؛ عند استخدامه اقرأه وانسخه حرفياً."
      : "لا توجد نصوص معتمدة بعد.";
  }
  function renderSummary(m) {
    const s = m.summary, lines = [];
    if (s.goal) lines.push(`- **الهدف:** ${s.goal}`);
    if (s.status) lines.push(`- **الوضع الآن:** ${s.status}`);
    if (s.next.length) lines.push(`- **الخطوة التالية:**\n${s.next.map((x) => `  - ${x}`).join("\n")}`);
    if (s.open.length) lines.push(`- **أسئلة مفتوحة:**\n${s.open.map((x) => `  - ${x}`).join("\n")}`);
    return lines.join("\n") || "لم تُكتب خلاصة بعد.";
  }
  function renderEntry(e) {
    const parts = [`### ${PLATFORMS[e.platform] || e.platform}${e.chat ? " · " + e.chat : ""}${e.range ? " · الرسائل " + e.range : ""}${e.date ? " · " + e.date : ""}`];
    if (e.raised.length) parts.push(`**ما طُرح:**\n${bullets(e.raised)}`);
    if (e.decided.length) parts.push(`**ما تقرّر:**\n${bullets(e.decided)}`);
    if (e.changed.length) parts.push(`**ما تغيّر:**\n${bullets(e.changed)}`);
    return parts.join("\n");
  }
  // the human view of the whole memory (generated; edits belong in the JSON, through Claude)
  function render(m) {
    const sug = renderSuggestions(m);
    const out = [`# ${m.title}`, "", `> يُولَّد تلقائياً من CONVERSATION_MEMORY.json — آخر تحديث: ${m.updated || "—"}. لا تعدّله يدوياً: يُعاد توليده عند كل حفظ، وتعديلك اليدوي يُحفظ في نسخة جانبية.`, "",
      "## الخلاصة الحالية", renderSummary(m), "", "## القرارات السارية", renderDecisions(m, true), "",
      ...(sug ? ["## مقترحات لم تُعتمد بعد", sug, ""] : []),
      "## القيود والمتطلبات", m.constraints.length ? bullets(m.constraints) : "لا قيود مسجلة بعد.", "",
      "## النصوص المعتمدة", renderPins(m), "", "## السجل", m.log.length ? m.log.map(renderEntry).join("\n\n") : "لا سجل بعد."];
    if (m.archived) out.push("", `_(${m.archived} دفعة أقدم نُقلت إلى الأرشيف في .conversation-memory/archive/ للحفاظ على حجم الملف.)_`);
    if (m.imported) out.push("", `## من الإصدار السابق (${m.imported.date})`, "", m.imported.text);
    return out.join("\n") + "\n";
  }
  // the small view loaded into context at session start: current state first, then the newest log entries within budget
  function renderCompact(m, budget = 5000) {
    const sug = renderSuggestions(m);
    const head = [`# ${m.title}`, "## الخلاصة الحالية", renderSummary(m), "## القرارات السارية", renderDecisions(m, false), ...(sug ? ["## مقترحات لم تُعتمد بعد", sug] : []),
      "## القيود والمتطلبات", m.constraints.length ? bullets(m.constraints) : "لا قيود مسجلة بعد.", "## النصوص المعتمدة", renderPins(m)].join("\n");
    let out = head.length > budget ? cut(head, budget) + "\n…(اقتُطع؛ الملف الكامل أدناه)" : head;
    const entries = [];
    for (let k = m.log.length - 1; k >= 0; k--) {
      const r = renderEntry(m.log[k]);
      if (out.length + entries.reduce((a, x) => a + x.length, 0) + r.length + 40 > budget) break;
      entries.unshift(r);
    }
    if (entries.length) out += "\n## أحدث السجل\n" + entries.join("\n\n");
    const hidden = m.log.length - entries.length;
    if (hidden > 0 || m.imported) out += `\n\n(${hidden > 0 ? `${hidden} دفعة أقدم` : ""}${hidden > 0 && m.imported ? " و" : ""}${m.imported ? "محتوى الإصدار السابق" : ""} في CONVERSATION_MEMORY.md — اقرأه عند الحاجة فقط.)`;
    return out;
  }

  // ---------- corrections (the user fixes the memory directly; every fix is a normal, backed-up, undoable write) ----------
  // shape: { decisions?: { edit: [{id, text}], approve: [id], revoke: [id], remove: [id] }, constraints?: { add: [], remove: [] },
  //          summary?: {goal, status, next[], open[]}, log?: { remove: [id] } }
  function validateFix(f) {
    if (!isObj(f)) return { ok: false, error: "التصحيح يجب أن يكون كائن JSON" };
    const out = {}, ids = (v) => (Array.isArray(v) ? v : []).filter(isId).slice(0, LIMITS.list);
    if (f.decisions !== undefined) {
      if (!isObj(f.decisions)) return { ok: false, error: "decisions يجب أن يكون كائناً" };
      const edit = (Array.isArray(f.decisions.edit) ? f.decisions.edit : []).filter(isObj).filter((x) => isId(x.id)).map((x) => ({ id: x.id, text: cleanStr(x.text) })).filter((x) => x.text).slice(0, LIMITS.list);
      out.decisions = { edit, approve: ids(f.decisions.approve), revoke: ids(f.decisions.revoke), remove: ids(f.decisions.remove) };
    }
    if (f.constraints !== undefined) {
      if (!isObj(f.constraints)) return { ok: false, error: "constraints يجب أن يكون كائناً" };
      out.constraints = { add: cleanList(f.constraints.add), remove: cleanList(f.constraints.remove) };
    }
    if (f.summary !== undefined) {
      if (!isObj(f.summary)) return { ok: false, error: "summary يجب أن يكون كائناً" };
      out.summary = { goal: cleanStr(f.summary.goal), status: cleanStr(f.summary.status), next: cleanList(f.summary.next), open: cleanList(f.summary.open) };
      if (!out.summary.goal && !out.summary.status) return { ok: false, error: "summary يحتاج goal أو status على الأقل" };
    }
    if (f.log !== undefined) {
      if (!isObj(f.log)) return { ok: false, error: "log يجب أن يكون كائناً فيه remove" };
      out.log = { remove: (Array.isArray(f.log.remove) ? f.log.remove : []).filter((x) => typeof x === "string" && x.length <= 100).slice(0, LIMITS.list) };
    }
    if (!Object.keys(out).length) return { ok: false, error: "لا يوجد ما يُصحَّح" };
    return { ok: true, fix: out };
  }
  // → { memory, changes: [human-readable lines], missing: [ids not found], redacted } — never mutates its input
  function applyFix(memory, fix, date) {
    const m = normalizeMemory(JSON.parse(JSON.stringify(memory)));
    const changes = [], missing = [];
    let redacted = false;
    const R = (t) => { const r = redact(t); if (r.changed) redacted = true; return r.text; };
    const find = (id) => { const d = m.decisions.find((x) => x.id === id); if (!d) missing.push(id); return d; };
    if (fix.decisions) {
      for (const e of fix.decisions.edit) { const d = find(e.id); if (d && d.text !== R(e.text)) { d.text = R(e.text); changes.push(`عُدّل نص ${d.id}`); } }
      for (const id of fix.decisions.approve) { const d = find(id); if (d && d.source === "assistant") {
        // a flagged decision, approved: it is what the model said it was, and it replaces what it was meant to replace
        d.source = d.unverified && d.claimed ? d.claimed : "assistant-approved";
        if (d.unverified && d.pendingReplaces) { const old = m.decisions.find((x) => x.id === d.pendingReplaces && x.status === "active" && x !== d); if (old) { old.status = "revoked"; old.revokedOn = date || ""; changes.push(`أُلغي ${old.id} (حلّ محله ${id})`); } d.replaces = d.pendingReplaces; }
        d.unverified = false; delete d.claimed; delete d.pendingReplaces;
        changes.push(`اعتُمد ${id}`);
      } }
      for (const id of fix.decisions.revoke) { const d = find(id); if (d && d.status === "active") { d.status = "revoked"; d.revokedOn = date || ""; changes.push(`أُلغي ${id}`); } }
      for (const id of fix.decisions.remove) { const before = m.decisions.length; m.decisions = m.decisions.filter((x) => x.id !== id); if (m.decisions.length < before) changes.push(`حُذف ${id} نهائياً`); else missing.push(id); }
    }
    if (fix.constraints) {
      const rm = new Set(fix.constraints.remove), had = m.constraints.length;
      m.constraints = m.constraints.filter((c) => !rm.has(c));
      if (m.constraints.length < had) changes.push(`حُذف ${had - m.constraints.length} من القيود`);
      for (const c of fix.constraints.add.map(R)) if (!m.constraints.includes(c)) { m.constraints.push(c); changes.push("أُضيف قيد"); }
    }
    if (fix.summary) { m.summary = { goal: R(fix.summary.goal), status: R(fix.summary.status), next: fix.summary.next.map(R), open: fix.summary.open.map(R) }; changes.push("استُبدلت الخلاصة الحالية"); }
    if (fix.log) for (const id of fix.log.remove) { const before = m.log.length; m.log = m.log.filter((e) => e.id !== id); if (m.log.length < before) changes.push(`حُذفت دفعة من السجل (${id})`); else missing.push(id); }
    if (changes.length) m.updated = date || m.updated;
    return { memory: m, changes, missing: [...new Set(missing)], redacted };
  }

  // ---------- sharing: chosen parts of the memory as text for another conversation ----------
  // sel: { summary: bool, decisions: [ids], constraints: bool, pins: [names], log: [ids] } → text, cut at `budget` characters
  // opts.pinTexts {name: text}: pinned texts inserted verbatim (a chat site cannot open the pin's file, Claude Code can);
  // opts.plain: no markdown markers (a message typed into a chat box shows them as they are)
  function renderSelection(m, sel, budget = 3000, opts = {}) {
    const parts = [], P = (t) => (opts.plain ? t.replace(/\*\*/g, "").replace(/^#{1,6} +/gm, "") : t);   // pinned texts stay verbatim
    if (sel.summary) parts.push(P("الخلاصة الحالية:\n" + renderSummary(m)));
    const ds = m.decisions.filter((d) => d.status === "active" && (sel.decisions || []).includes(d.id));
    if (ds.length) parts.push(P("قرارات:\n" + ds.map((d) => `- ${d.text} (${SOURCE_LABEL[d.source]})`).join("\n")));
    if (sel.constraints && m.constraints.length) parts.push(P("القيود:\n" + bullets(m.constraints)));
    const ps = m.pins.filter((p) => (sel.pins || []).includes(p.name));
    const texts = opts.pinTexts || {};
    for (const p of ps.filter((x) => typeof texts[x.name] === "string")) parts.push(`نص معتمد «${p.name}» (النسخة ${p.version}، انقله حرفياً):\n${texts[p.name]}`);
    const refs = ps.filter((x) => typeof texts[x.name] !== "string");
    if (refs.length) parts.push("نصوص معتمدة (النص الحرفي في ملفه):\n" + refs.map((p) => `- ${p.name} — النسخة ${p.version}، ${p.path}`).join("\n"));
    const es = m.log.filter((e) => (sel.log || []).includes(e.id));
    if (es.length) parts.push(P("من سجل النقاش:\n" + es.map(renderEntry).join("\n\n")));
    let out = parts.join("\n\n");
    if (out.length > budget) out = cut(out, budget) + "\n…(اقتُطع عند " + budget + " حرف)";
    return out;
  }

  // ---------- line diff (for comparing versions of a pinned text) ----------
  // → [{op: " " | "-" | "+", line}] ; LCS on lines, capped so huge texts stay fast (beyond the cap: whole-text replace)
  function diffLines(a, b) {
    const A = String(a).split("\n"), B = String(b).split("\n");
    // common start and end first: a typical revision touches a few lines in the middle
    let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
    let q = 0; while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
    const head = A.slice(0, p).map((line) => ({ op: " ", line })), tail = A.slice(A.length - q).map((line) => ({ op: " ", line }));
    const X = A.slice(p, A.length - q), Y = B.slice(p, B.length - q);
    if (X.length * Y.length > 4e6) return [...head, ...X.map((line) => ({ op: "-", line })), ...Y.map((line) => ({ op: "+", line })), ...tail];
    const n = X.length, k = Y.length, L = Array.from({ length: n + 1 }, () => new Uint32Array(k + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = k - 1; j >= 0; j--) L[i][j] = X[i] === Y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const mid = []; let i = 0, j = 0;
    while (i < n && j < k) { if (X[i] === Y[j]) { mid.push({ op: " ", line: X[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) mid.push({ op: "-", line: X[i++] }); else mid.push({ op: "+", line: Y[j++] }); }
    while (i < n) mid.push({ op: "-", line: X[i++] });
    while (j < k) mid.push({ op: "+", line: Y[j++] });
    return [...head, ...mid, ...tail];
  }

  // ---------- pins ----------
  const slug0 = (n) => String(n || "").replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ").replace(/\[\s*conversation-memory\s*\]/gi, " ").replace(/\s+/g, " ").replace(/^[.\s]+|[.\s]+$/g, "");
  const slug = (n) => cut(slug0(wellFormed(n || "")), 60).replace(/[.\s]+$/g, "");
  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
  const pinNameOk = (n) => { const s = slug(n); return !!s && s === String(n).trim().replace(/\s+/g, " ") && !WINDOWS_RESERVED.test(s); };
  const pinPath = (name, version) => `CONVERSATION_PINS/${name}/v${version}.md`;
  function upsertPin(m, pin) { const out = normalizeMemory(JSON.parse(JSON.stringify(m))); out.pins = out.pins.filter((p) => p.name !== pin.name); out.pins.push(pin); out.pins.sort((a, b) => (a.name < b.name ? -1 : 1)); return normalizeMemory(out); }

  // extract the exact text that starts with `start` and ends with `end` from candidate sources (newest/most likely first).
  // Rules: the first source with exactly one candidate wins; a source with several distinct candidates is ambiguous (error).
  function extractVerbatim(sources, start, end) {
    for (const src of sources) {
      if (typeof src !== "string" || !src) continue;
      const spans = new Set();
      for (let i = src.indexOf(start); i >= 0 && spans.size < 10; i = src.indexOf(start, i + 1)) {
        let e = src.indexOf(end, i + start.length);
        if (e < 0) e = src.indexOf(end, i);
        if (e >= 0) spans.add(src.slice(i, e + end.length));
      }
      if (spans.size === 1) return { ok: true, text: [...spans][0] };
      if (spans.size > 1) return { ok: false, error: `في رسالة واحدة أكثر من نص يطابق البداية والنهاية (${spans.size}). اختر بداية ونهاية أدق` };
    }
    return { ok: false, error: "لم أجد نصاً في المحادثة يبدأ وينتهي بما كُتب. انسخ البداية والنهاية حرفياً" };
  }

  // Is this Markdown just a generated view (of the current memory, or of the version before it)? Then it is not a hand edit.
  // The second case is a write cut off between the two files: the JSON was replaced, the view not yet.
  function isGeneratedView(mdText, current, previous) {
    const h = hash(String(mdText));
    for (const m of [current, previous]) if (m && (h === m.mdHash || h === hash(render(normalizeMemory(m))))) return true;
    return false;
  }

  // keep the JSON under maxBytes: the oldest log entries move to an archive (returned for the writer to store), then the imported v0 text is cut
  // a rough, honest estimate of model tokens from characters (Arabic and English mixed ≈ 3 characters per token); shown as "≈"
  const estTokens = (chars) => Math.ceil(Math.max(0, +chars || 0) / 3);
  const utf8Len = (s) => { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? (i++, 4) : 3; } return n; };
  function trimForSize(memory, maxBytes) {
    const m = normalizeMemory(JSON.parse(JSON.stringify(memory)));
    const archived = [];
    while (utf8Len(serialize(m)) > maxBytes && m.log.length > 20) { const k = Math.max(1, Math.floor(m.log.length / 10)); archived.push(...m.log.splice(0, k)); }
    if (utf8Len(serialize(m)) > maxBytes && m.imported) { archived.push({ id: "imported-v0", imported: m.imported }); m.imported = null; }
    m.archived += archived.length;
    return { memory: m, archived, fits: utf8Len(serialize(m)) <= maxBytes };
  }

  // a text from a v0.x Markdown file, kept read-only when migrating
  function importLegacy(m, mdText, date) { const out = normalizeMemory(JSON.parse(JSON.stringify(m))); out.imported = { date: date || "", text: cut(wellFormed(mdText), LIMITS.imported) }; return out; }

  return { FORMAT, LIMITS, PLATFORMS, START, END, emptyMemory, normalizeMemory, parseMemory, serialize, token, hash, validateDraft, applyDraft, parseModelReply,
    render, renderCompact, redact, hasSecret, cleanStr, slug, pinNameOk, pinPath, upsertPin, extractVerbatim, importLegacy, trimForSize, estTokens, isGeneratedView, validateFix, applyFix, renderSelection, diffLines, count, W, PROTOCOL, evNorm, numbersIn, QUOTE_MAX };
});

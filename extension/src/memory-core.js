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
      summary: { goal: "", status: "", next: [], open: [] }, decisions: [], constraints: [], pending: { constraints: { add: [], remove: [] } }, pins: [], log: [], imported: null, mdHash: "", archived: 0 };
  }
  // Fields a later version adds are kept as they are, never dropped: two writers of different versions (the plugin and the
  // extension, updated at different times) share one file, and the older one must not erase what the newer one wrote.
  const KNOWN_TOP = new Set(["format", "title", "updated", "summary", "decisions", "constraints", "pending", "pins", "log", "imported", "mdHash", "archived"]);
  const KNOWN_DEC = new Set(["id", "text", "source", "date", "status", "revokedOn", "replaces", "quote", "unverified", "claimed", "pendingReplaces", "msg", "confirmed", "pendingRevoke"]);
  function extras(o, known, max) {
    const out = {}; let size = 0;
    for (const k of Object.keys(o)) {
      if (known.has(k) || !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k) || k in Object.prototype) continue;
      let v; try { v = JSON.stringify(o[k]); } catch { continue; }
      if (v === undefined || size + v.length + k.length > max) continue;   // one too large is skipped; the others are still kept
      size += v.length + k.length; out[k] = JSON.parse(v);
    }
    return out;
  }
  // the format's version: a file written by a later format is read, but never written over (formatNewer)
  const formatVersion = (f) => { const x = /^conversation-memory\/(\d{1,4})$/.exec(String(f || "")); return x ? +x[1] : 1; };
  const formatNewer = (input) => isObj(input) && formatVersion(input.format) > formatVersion(FORMAT);
  const KNOWN_PEND = new Set(["text", "reason", "date", "quote"]), KNOWN_SUM = new Set(["goal", "status", "next", "open"]), KNOWN_PIN = new Set(["name", "version", "path", "sha", "date"]);
  const KNOWN_LOG = new Set(["id", "platform", "chat", "range", "date", "raised", "decided", "changed"]);
  const pendingItems = (v) => (Array.isArray(v) ? v : []).filter(isObj).map((x) => ({ text: cleanStr(x.text), reason: cleanStr(x.reason, 200), date: cleanStr(x.date, 40), quote: cleanStr(x.quote, QUOTE_MAX), ...extras(x, KNOWN_PEND, 500) }))
    .filter((x) => x.text).slice(-LIMITS.list);
  // accept anything (hand-edited, older, partial) and return a well-formed memory; never throws
  function normalizeMemory(input) {
    const m = emptyMemory(isObj(input) ? input.title : "");
    if (!isObj(input)) return m;
    m.updated = cleanStr(input.updated, 40);
    const s = isObj(input.summary) ? input.summary : {};
    m.summary = { goal: cleanStr(s.goal), status: cleanStr(s.status), next: cleanList(s.next), open: cleanList(s.open), ...extras(s, KNOWN_SUM, 8000) };
    const seen = new Set();
    m.decisions = (Array.isArray(input.decisions) ? input.decisions : []).filter(isObj).map((d) => ({
      id: isId(d.id) ? d.id : "", text: cleanStr(d.text), source: SOURCES.includes(d.source) ? d.source : "user",
      date: cleanStr(d.date, 40), status: d.status === "revoked" ? "revoked" : "active", revokedOn: cleanStr(d.revokedOn, 40), replaces: isId(d.replaces) ? d.replaces : "",
      quote: cleanStr(d.quote, QUOTE_MAX), unverified: d.unverified === true,
      ...(d.unverified === true && (d.claimed === "user" || d.claimed === "assistant-approved") ? { claimed: d.claimed } : {}),
      ...(d.unverified === true && isId(d.pendingReplaces) ? { pendingReplaces: d.pendingReplaces } : {}),
      ...(Number.isInteger(d.msg) && d.msg > 0 && d.msg < 1e7 ? { msg: d.msg } : {}),
      ...(d.confirmed === true && d.unverified !== true ? { confirmed: true } : {}),
      ...(d.status !== "revoked" && isObj(d.pendingRevoke) ? { pendingRevoke: { date: cleanStr(d.pendingRevoke.date, 40), reason: cleanStr(d.pendingRevoke.reason, 200), quote: cleanStr(d.pendingRevoke.quote, QUOTE_MAX) } } : {}),
      ...extras(d, KNOWN_DEC, 2000),
    })).filter((d) => d.text).slice(-LIMITS.decisions);
    let next = 1 + Math.max(0, ...m.decisions.map((d) => +String(d.id).slice(1) || 0));
    for (const d of m.decisions) { if (!d.id || seen.has(d.id)) d.id = "d" + next++; seen.add(d.id); }
    m.constraints = [...new Set(cleanList(input.constraints, LIMITS.constraints))];
    const pc = isObj(input.pending) && isObj(input.pending.constraints) ? input.pending.constraints : {};
    m.pending = { ...extras(isObj(input.pending) ? input.pending : {}, new Set(["constraints"]), 16000),
      constraints: { ...extras(pc, new Set(["add", "remove"]), 4000), add: pendingItems(pc.add).filter((x) => !m.constraints.includes(x.text)), remove: pendingItems(pc.remove).filter((x) => m.constraints.includes(x.text)) } };
    // the path is rebuilt from a validated name and version, never taken from the file (no "..", no other folders)
    m.pins = (Array.isArray(input.pins) ? input.pins : []).filter(isObj).filter((p) => typeof p.name === "string" && pinNameOk(p.name)).map((p) => {
      const name = p.name.trim().replace(/\s+/g, " "), version = Math.min(999999, Math.max(1, Math.floor(+p.version) || 1));
      return { name, version, path: pinPath(name, version), sha: typeof p.sha === "string" && /^[0-9a-f]{8,64}$/.test(p.sha) ? p.sha : "", date: cleanStr(p.date, 40), ...extras(p, KNOWN_PIN, 1000) };
    });
    m.log = (Array.isArray(input.log) ? input.log : []).filter(isObj).map((e) => ({
      id: cleanStr(e.id, 100), platform: PLATFORMS[e.platform] ? e.platform : "claude-code", chat: cleanStr(e.chat, 200), range: cleanStr(e.range, 40), date: cleanStr(e.date, 40),
      raised: cleanList(e.raised), decided: cleanList(e.decided), changed: cleanList(e.changed), ...extras(e, KNOWN_LOG, 1000),
    })).filter((e) => e.id).slice(-LIMITS.log);
    if (isObj(input.imported) && typeof input.imported.text === "string") m.imported = { date: cleanStr(input.imported.date, 40), text: cut(wellFormed(input.imported.text), LIMITS.imported) };
    m.mdHash = typeof input.mdHash === "string" ? input.mdHash.slice(0, 32) : "";
    m.archived = Math.max(0, Math.floor(+input.archived) || 0);
    Object.assign(m, extras(input, KNOWN_TOP, 64000));
    if (formatNewer(input)) m.format = cleanStr(input.format, 40);   // kept, so the file still says what wrote it
    return m;
  }
  // parse the JSON file text; a file that exists but isn't valid JSON is an error, never silently replaced
  function parseMemory(text) {
    if (text == null || text === "") return { ok: true, memory: emptyMemory() };
    try { const j = JSON.parse(text); if (!isObj(j)) throw new Error("not an object"); return { ok: true, memory: normalizeMemory(j), newer: formatNewer(j) }; }
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
  // ev: { user, all, turns?: [{ role: "user" | "assistant", text, n? }] } — turns in order, n = the user message's number
  // (counted from 1 when not given). With turns, a quote must sit inside one of your messages, and the decision records which.
  function prepareEvidence(ev) {
    if (!isObj(ev) || typeof ev.all !== "string" || !ev.all.trim()) return null;
    const all = evNorm(ev.all);
    let turns = null;
    if (Array.isArray(ev.turns)) {
      let k = 0;
      turns = ev.turns.filter((t) => isObj(t) && (t.role === "user" || t.role === "assistant") && typeof t.text === "string")
        .map((t) => ({ role: t.role, t: evNorm(t.text), n: t.role !== "user" || t.n === null ? 0 : Number.isInteger(t.n) && t.n > 0 ? (k = t.n) : ++k }));   // n: null = number unknown
      if (!turns.some((t) => t.role === "user")) turns = null;
    }
    return { user: typeof ev.user === "string" ? evNorm(ev.user) : all, all, numbers: numbersIn(ev.all, true), turns };
  }

  // ---------- meaning guards ----------
  // A quote that exists proves only that you said those words — not that the decision means what you meant. Two cheap,
  // deterministic guards catch the commonest misreadings; anything they doubt waits for you instead of being trusted:
  //  - polarity: «لا تنشر بياناتي» can't back «وافق على نشر بياناته» (a negation on one side only);
  //  - subject: the quote must share at least one content word with the decision (same root, roughly).
  // They are guards, not proof: «confirmed» is only ever set by you (approving it).
  const STOP = new Set(("في من على الى عن مع هذا هذه ذلك تلك ان او ثم كل بعد قبل عند اللي الذي التي الذين هو هي هم انا نحن احنا انت انتم هل قد لقد كان يكون " +
    "ايضا بس يعني شي شيء كذا هنا هناك عشان علشان لان لكن بل حتى اذا لو وش ايش كيف متى ليش اي ايه نعم تمام اوكي طيب خلاص " +
    "the a an to of in on for and or is are was be we i you it this that with as at by from so then just ok okay yes").split(" "));
  const NEG = new Set(("لا لاء لاا لم لن ليس ليست لست لسنا مو مب مش ماني مانيب بلاش بدون عدم ممنوع يمنع منع نمنع تمنع امنع رفض نرفض ارفض يرفض ترفض " +
    "ولا فلا ولم ولن وليس وبدون وعدم ومنع لاتنشر مابي مابغي مابغا مابغى ماابي مانبي مانبغي ماودي " +
    "not no never without cannot nor avoid stop dont nope nah").split(" "));
  // «ما» negates a verb or a «there is / I have»: «ما نستخدم»، «ما راح»، «ما ابي»، «ما عندي»، «ما فيه»
  const MA_NEG = (w) => !!w && (/^[ايتنب]/.test(w) || ["راح", "رح", "عاد", "عندي", "عندنا", "فيه", "في", "بقى", "صار", "لي", "لنا"].includes(w));
  // idioms that read as negative but agree («لا بأس», «ما عندي مانع», «why not») — whole words only (never «لا شكراً»)
  const AGREE_IDIOM = /(?:^| )(?:لا باس|لا مانع|ما فيه مانع|ما في مانع|ما عندي مانع|مافي مانع|ليش لا|ولا يهمك|لا شك|no problem|why not|not a problem|no doubt)(?= |$)/g;
  const tokens = (t) => evNorm(t).replace(AGREE_IDIOM, " ").split(" ").filter(Boolean);
  function negatedTokens(w) {
    for (let i = 0; i < w.length; i++) {
      if (NEG.has(w[i])) return true;
      if ((w[i] === "ما" || w[i] === "وما") && MA_NEG(w[i + 1])) return true;
      if (/^(don|doesn|didn|isn|aren|wasn|weren|won|can|couldn|shouldn|wouldn|mustn)$/.test(w[i]) && w[i + 1] === "t") return true;
    }
    return false;
  }
  const negated = (t) => negatedTokens(tokens(t));
  // a change of mind in words: «ألغِ»، «خلاص بدلها»، «ما عاد»، «instead», «cancel»… (or the opposite polarity, checked apart)
  const CHANGE = /(?:^| )(?:الغ|الغي|الغيه|الغيها|الغوه|الغيت|الغينا|نلغي|نلغيه|نلغيها|الغاء|ملغي|خلاص|بدل\S*|نبدل\S*|غيره|غيرها|غيروا|غيرت|غيرنا|نغير\S*|تغيير|تغير|انس|انسى|انساه|انسها|شيل\S*|احذف\S*|حذف\S*|نحذف\S*|امسح\S*|تراجع\S*|نرجع|عدل|عدله|عدلها|نعدل\S*|ما عاد|لا عاد|عاد ما|بلاش|ماعاد|لا داعي|ما له داعي|مو لازم|مب لازم|ما يحتاج|ما نحتاج|no need|not needed|cancel\S*|revok\S*|drop\S*|remov\S*|instead|chang\S*|switch\S*|replac\S*|no longer|forget|scrap\S*|undo|delete\S*)(?= |$)/;
  const changeWords = (t) => CHANGE.test(evNorm(t));
  // a rough stem: without the conjunction, the article and common suffixes (enough to compare two words, never shown)
  const stem = (w) => w.replace(/^(و|ف)(?=.{3,})/, "").replace(/^(ب|ل|ك)?ال(?=.{2,})|^لل(?=.{2,})/, "").replace(/(ها|هم|هن|كم|نا|ات|ون|ين|ان|ه|ي|ك)$/, (s, _, i) => (i >= 3 ? "" : s));
  const content = (t) => [...new Set(tokens(t).filter((w) => !STOP.has(w) && !NEG.has(w) && (w.length >= 3 || /^\d{2,}$/.test(w))).map(stem).filter((w) => w.length >= 2))];
  // two words are the same word, roughly: equal, one inside the other (3+ letters), or the same 4-letter start (a leading
  // verb or plural letter aside: «اعتمدنا» ~ «اعتماد», «تنشر» ~ «نشر»). Never a shared fragment in the middle.
  const lead = (w) => (w.length > 4 ? w.replace(/^[ايتن]/, "") : w);
  const near = (a, b) => a === b || (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) ||
    [[a, b], [lead(a), b], [a, lead(b)], [lead(a), lead(b)]].some(([x, y]) => x.length >= 4 && y.length >= 4 && x.slice(0, 4) === y.slice(0, 4));
  const shared = (a, b) => { const B = content(b); return content(a).filter((x) => B.some((y) => near(x, y))).length; };
  const shares = (a, b) => shared(a, b) > 0;
  // names and numbers written in Latin letters (a library, a product, a code) are the most often swapped: each must be in the quote
  const latinMissing = (quote, text) => { const Q = content(quote); return content(text).filter((w) => /^[a-z]{2,}$/.test(w) && !Q.some((y) => near(w, y))); };
  // the quote in its message: the words just before it may negate it («لا أريد [نشر بياناتي]»), so its polarity is read with them
  function polarityIn(q, ev, at) {
    if (!at || at.i < 0 || !ev.turns) return negatedTokens(q.split(" "));
    const msg = ev.turns[at.i].t, k = msg.lastIndexOf(q);
    const before = (k > 0 ? msg.slice(0, k) : "").replace(AGREE_IDIOM, " ").split(" ").filter(Boolean).slice(-4);
    return negatedTokens([...before, ...q.replace(AGREE_IDIOM, " ").split(" ").filter(Boolean)]);
  }
  // why a quote does not back a text, or "" (polarity, subject, names)
  function meaningGap(quote, text, negQuote) {
    if (negQuote !== negated(text)) return "المعنى قد يعاكس كلامك (نفي في أحدهما فقط)";
    const n = content(text).length, s = shared(quote, text);
    if (!s || s < Math.min(2, Math.ceil(n / 4))) return "الاقتباس لا يذكر موضوع القرار";
    const lm = latinMissing(quote, text); if (lm.length) return `اسم في القرار ليس في كلامك: ${lm.slice(0, 2).join("، ")}`;
    return "";
  }
  // where your words are: the number of your message that holds q (the newest one; 0 when unknown), and its place among the
  // turns (-1 when only the joined text is known); null when they are not yours at all
  function findUserQuote(q, ev) {
    if (ev.turns) { for (let i = ev.turns.length - 1; i >= 0; i--) if (ev.turns[i].role === "user" && ev.turns[i].t.includes(q)) return { n: ev.turns[i].n, i }; return null; }
    return ev.user.includes(q) ? { n: 0, i: -1 } : null;
  }
  const notYours = (q, ev) => (ev.all.includes(q) ? "الاقتباس ليس من كلامك في المحادثة" : "الاقتباس غير موجود في المحادثة");
  // → { why: "" when backed, else the reason (Arabic, shown to the user), msg: your message's number when known }.
  // Every quote must be your own words: for a decision, the words that state it; for an approved suggestion, the words that
  // approve it — and then the suggestion must be what the reply just before your approval proposed.
  function checkDecision(a, ev, known) {
    const q = evNorm(a.quote || "");
    let msg = 0;
    if (a.source !== "assistant") {
      if (q.replace(/\s/g, "").length < (a.source === "user" ? QUOTE_MIN : APPROVAL_MIN)) return { why: "بلا اقتباس من كلامك", msg };
      const at = findUserQuote(q, ev);
      if (!at) return { why: notYours(q, ev), msg };
      msg = at.n;
      if (a.source === "user") { const gap = meaningGap(a.quote, a.text, polarityIn(q, ev, at)); if (gap) return { why: gap, msg }; }
      else {
        // an approval is a plain yes: no refusal or reservation anywhere in that message («نعم، لكن لا تحذف…» is not one)
        if (negated(a.quote) || (at.i >= 0 && negatedTokens(ev.turns[at.i].t.replace(AGREE_IDIOM, " ").split(" ").filter(Boolean)))) return { why: "اقتباس الموافقة فيه رفض أو نفي أو تحفّظ", msg };
        if (ev.turns && at.i >= 0) {
          let j = at.i - 1; while (j >= 0 && ev.turns[j].role !== "assistant") j--;
          const n = content(a.text).length;
          if (j < 0 || shared(a.text, ev.turns[j].t) < Math.max(1, Math.ceil(n / 2)) || latinMissing(ev.turns[j].t, a.text).length) return { why: "موافقتك لا تتبع اقتراحاً بهذا المضمون", msg };
        }
      }
    }
    const miss = numbersIn(a.text, false).filter((n) => !ev.numbers.has(n) && !known.has(n));
    return { why: miss.length ? `رقم لا يظهر في المحادثة: ${miss.slice(0, 3).join("، ")}` : "", msg };
  }
  // A change to something you decided (revoking or replacing a decision, removing a constraint) needs your words for that
  // change: from a message after the one it came from, not the words it was made with, and saying so — a change of mind
  // («ألغِ»، «بدل»، «ما عاد»…) or the opposite of it. Adding a constraint needs your words stating it (polarity kept).
  // target: { text, quote?, msg? } — what is changed (a constraint has no quote or message of its own)
  function checkChange(quote, target, ev, kind) {
    if (!ev) return { why: "لم يتوفر نص المحادثة للتحقق", msg: 0 };
    const q = evNorm(quote || "");
    if (q.replace(/\s/g, "").length < QUOTE_MIN) return { why: "بلا اقتباس من كلامك", msg: 0 };
    const at = findUserQuote(q, ev);
    if (!at) return { why: notYours(q, ev), msg: 0 };
    const neg = polarityIn(q, ev, at);
    if (kind === "add") { const gap = meaningGap(quote, target.text, neg); return { why: gap ? gap.replace("القرار", "القيد") : "", msg: at.n }; }
    if (!shares(quote, target.text)) return { why: "الاقتباس لا يذكر ما يُلغى", msg: at.n };
    if (target.quote && (q.includes(evNorm(target.quote)) || evNorm(target.quote).includes(q))) return { why: "الاقتباس هو كلامك الذي قررته به، لا كلامك الذي ألغيته به", msg: at.n };
    if (target.msg && at.n && at.n <= target.msg) return { why: "الاقتباس من رسالة قبل القرار أو منها", msg: at.n };
    // a mere opposite («بيانات العملاء مهمة» against «لا ننشر…») is not a change of mind: the words must say it
    if (kind !== "replace" && !changeWords(quote)) return { why: "الاقتباس لا يقول إنك ألغيته أو غيّرته", msg: at.n };
    return { why: "", msg: at.n };
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
      // a revoke names the decision and, for one you made, quotes the words you revoked it with: "d3" or { id, quote }
      const revoke = (Array.isArray(d.decisions.revoke) ? d.decisions.revoke : []).map((x) => (typeof x === "string" ? { id: x } : x)).filter((x) => isObj(x) && isId(x.id))
        .map((x) => ({ id: x.id, quote: cleanStr(x.quote, QUOTE_MAX) })).slice(0, LIMITS.list);
      out.decisions = { add, revoke };
    }
    if (d.constraints !== undefined) {
      if (!isObj(d.constraints)) return { ok: false, error: "constraints يجب أن يكون كائناً فيه add و remove" };
      // a constraint is your standing requirement: "text" or { text, quote } (the quote: your words that state or drop it)
      const items = (v) => (Array.isArray(v) ? v : []).map((x) => (typeof x === "string" ? { text: x } : x)).filter(isObj)
        .map((x) => ({ text: cleanStr(x.text), quote: cleanStr(x.quote, QUOTE_MAX) })).filter((x) => x.text).slice(0, LIMITS.list);
      out.constraints = { add: items(d.constraints.add), remove: items(d.constraints.remove) };
    }
    const e = isObj(d.entry) ? d.entry : null;
    if (!e) return { ok: false, error: "entry مطلوب (raised و decided و changed)" };
    out.entry = { raised: cleanList(e.raised), decided: cleanList(e.decided), changed: cleanList(e.changed) };
    const all = [...out.entry.raised, ...out.entry.decided, ...out.entry.changed].join(" ");
    if (visibleLen(all) < LIMITS.entryMin) return { ok: false, error: "ملخص الدفعة (entry) فارغ أو قصير جداً" };
    return { ok: true, draft: out };
  }

  // apply a validated draft. ctx: { platform, chat, range, date, allowSummary, evidence?: {user, all, turns?} }
  // Everything that would change what you decided is checked against your own words in the conversation:
  //  - a decision attributed to you (checkDecision): unbacked → kept as a suggestion waiting for you, never trusted;
  //  - revoking or replacing a decision of yours: unbacked → it stays in force, and the revocation waits for you;
  //  - adding or removing a constraint: unbacked → waits for you (memory.pending), the constraints are untouched.
  // Without the conversation's text nothing can be checked, so nothing is trusted (it all waits for you).
  // returns { memory, applied, redacted, skipped[], unverified: [{id, text, reason}], pending: [{key, text, reason}] } — never mutates its input
  const NO_EVIDENCE = "لم يتوفر نص المحادثة للتحقق";
  function applyDraft(memory, draft, ctx) {
    const m = normalizeMemory(JSON.parse(JSON.stringify(memory)));
    if (m.log.some((e) => e.id === draft.batch)) return { memory: m, applied: false, redacted: false, skipped: ["already-applied"], unverified: [], pending: [] };
    let redacted = false;
    const R = (s) => { const r = redact(s); if (r.changed) redacted = true; return r.text; };
    const RL = (l) => l.map(R);
    const skipped = [], unverified = [], pending = [];
    const date = ctx.date || "";
    const ev = prepareEvidence(ctx.evidence);
    // numbers already established may be restated without being in this part of the conversation: those of decisions in
    // force that were backed (never the model-written summary, never a flagged decision), constraints, and this year
    const known = ev ? numbersIn([...m.decisions.filter((d) => d.status === "active" && !d.unverified).map((d) => d.text + " " + d.quote), ...m.constraints, String(date).slice(0, 4)].join(" "), true) : null;
    const yours = (d) => d.source !== "assistant";   // a decision you made or approved (not the model's own suggestion)
    // revoke d, or (when the words for it are missing) leave it in force with the revocation waiting for you
    const revokeOrHold = (d, quote, why) => {
      if (!why) { d.status = "revoked"; d.revokedOn = date; delete d.pendingRevoke; return; }
      d.pendingRevoke = { date, reason: why, quote: R(quote || "") };
      pending.push({ key: "x-" + d.id, text: d.text, reason: why });
    };
    if (draft.summary) {
      if (ctx.allowSummary) m.summary = { ...extras(m.summary, KNOWN_SUM, 8000), goal: R(draft.summary.goal), status: R(draft.summary.status), next: RL(draft.summary.next), open: RL(draft.summary.open) };
      else skipped.push("summary");
    }
    if (draft.decisions) {
      for (const r of draft.decisions.revoke) {
        const d = m.decisions.find((x) => x.id === r.id && x.status === "active"); if (!d) continue;
        // the model's own suggestions it may withdraw; one of yours needs your words for it
        revokeOrHold(d, r.quote, yours(d) ? checkChange(r.quote, d, ev, "revoke").why : "");
      }
      let next = 1 + Math.max(0, ...m.decisions.map((d) => +d.id.slice(1) || 0));
      for (const a of draft.decisions.add) {
        const text = R(a.text);
        if (m.decisions.some((d) => d.status === "active" && d.text === text)) continue; // same decision twice
        const c = ev ? checkDecision(a, ev, known) : { why: a.source === "assistant" ? "" : NO_EVIDENCE, msg: 0 };
        const why = c.why;
        // an unbacked decision never replaces one in force: it waits as a suggestion until the user approves it — and then
        // it becomes what the model said it was (the user's decision, or an approved suggestion) and replaces what it meant to.
        // A backed one replaces a decision of yours only if its words are about that decision too; else the old one waits for you.
        // A backed one replaces a decision of yours only with your words for the change (checkChange); the model's own
        // suggestion never replaces one of yours, it only proposes. It claims to replace only what it really replaced.
        let replaced = "";
        if (a.replaces && !why) {
          const old = m.decisions.find((x) => x.id === a.replaces && x.status === "active");
          if (old && !yours(old)) { revokeOrHold(old, a.quote, ""); replaced = old.id; }
          else if (old && a.source !== "assistant") { const ch = checkChange(a.quote, old, ev, "replace").why; revokeOrHold(old, a.quote, ch); if (!ch) replaced = old.id; }
        }
        const id = "d" + next++;
        m.decisions.push({ id, text, source: why ? "assistant" : a.source, date, status: "active", revokedOn: "", replaces: replaced, quote: R(a.quote || ""), unverified: !!why,
          ...(c.msg > 0 ? { msg: c.msg } : {}), ...(why && a.source !== "assistant" ? { claimed: a.source } : {}), ...(why && a.replaces ? { pendingReplaces: a.replaces } : {}) });
        if (why) unverified.push({ id, text, reason: why });
      }
      m.decisions = m.decisions.slice(-LIMITS.decisions);
    }
    if (draft.constraints) {
      const P = m.pending.constraints;
      for (const r of draft.constraints.remove) {
        const c = m.constraints.find((x) => x === r.text); if (!c) continue;
        const why = checkChange(r.quote, { text: c }, ev, "remove").why;
        if (!why) { m.constraints = m.constraints.filter((x) => x !== c); P.remove = P.remove.filter((x) => x.text !== c); continue; }
        if (!P.remove.some((x) => x.text === c)) { P.remove.push({ text: c, reason: why, date, quote: R(r.quote) }); pending.push({ key: ckey("-", c), text: c, reason: why }); }
      }
      for (const a of draft.constraints.add) {
        const text = R(a.text);
        if (m.constraints.includes(text)) continue;
        const why = checkChange(a.quote, { text }, ev, "add").why;
        if (!why) { m.constraints.push(text); P.add = P.add.filter((x) => x.text !== text); continue; }
        if (!P.add.some((x) => x.text === text)) { P.add.push({ text, reason: why, date, quote: R(a.quote) }); pending.push({ key: ckey("+", text), text, reason: why }); }
      }
      m.constraints = [...new Set(m.constraints)].slice(-LIMITS.constraints);
      P.add = P.add.slice(-LIMITS.list); P.remove = P.remove.slice(-LIMITS.list);
    }
    m.log.push({ id: draft.batch, platform: PLATFORMS[ctx.platform] ? ctx.platform : "claude-code", chat: cleanStr(ctx.chat || "", 200), range: cleanStr(ctx.range || "", 40), date,
      raised: RL(draft.entry.raised), decided: RL(draft.entry.decided), changed: RL(draft.entry.changed) });
    m.log = m.log.slice(-LIMITS.log);
    m.updated = date;
    return { memory: normalizeMemory(m), applied: true, redacted, skipped, unverified, pending };   // normalized again: one field order, always
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
    return l.length ? l.map((d) => `- **${d.id}** ${d.text}${d.unverified ? " ⚠️ لم يثبت من كلامك؛ راجعه" : ""}${d.date ? ` _(${d.date})_` : ""}`).join("\n") : "";
  }
  // constraint changes that wait for you (the model proposed them without your words)
  function renderPendingConstraints(m) {
    const P = m.pending.constraints, l = [...P.add.map((x) => `- إضافة: ${x.text} _(${x.reason})_`), ...P.remove.map((x) => `- حذف: ${x.text} _(${x.reason})_`)];
    return l.join("\n");
  }
  // how sure we are of a decision: you confirmed it, or your words were found (where), or neither
  const backing = (d) => (d.confirmed ? "✓ أكّدته" : d.quote ? (d.msg ? `اقتباس من رسالتك ${d.msg}` : "اقتباس من كلامك") : "");
  function renderDecisions(m, withRevoked) {
    const active = m.decisions.filter(isDecision);
    let out = active.length ? active.map((d) => `- **${d.id}** ${d.text} _(${SOURCE_LABEL[d.source]}${d.date ? "، " + d.date : ""}${d.replaces ? "، يحل محل " + d.replaces : ""}${withRevoked && backing(d) ? "، " + backing(d) : ""})_${d.pendingRevoke ? " ⚠️ اقتُرح إلغاؤه دون دليل من كلامك؛ راجعه" : ""}${withRevoked && d.quote ? `\n  > «${d.quote}»` : ""}`).join("\n") : "لا قرارات سارية بعد.";
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
      ...(renderPendingConstraints(m) ? ["## تغييرات على القيود تنتظر مراجعتك", renderPendingConstraints(m), ""] : []),
      "## النصوص المعتمدة", renderPins(m), "", "## السجل", m.log.length ? m.log.map(renderEntry).join("\n\n") : "لا سجل بعد."];
    if (m.archived) out.push("", `_(${m.archived} دفعة أقدم نُقلت إلى الأرشيف في .conversation-memory/archive/ للحفاظ على حجم الملف.)_`);
    if (m.imported) out.push("", `## من الإصدار السابق (${m.imported.date})`, "", m.imported.text);
    return out.join("\n") + "\n";
  }
  // the small view loaded into context at session start: current state first, then the newest log entries within budget
  function renderCompact(m, budget = 5000) {
    const sug = renderSuggestions(m);
    const head = [`# ${m.title}`, "## الخلاصة الحالية", renderSummary(m), "## القرارات السارية", renderDecisions(m, false), ...(sug ? ["## مقترحات لم تُعتمد بعد", sug] : []),
      "## القيود والمتطلبات", m.constraints.length ? bullets(m.constraints) : "لا قيود مسجلة بعد.",
      ...(renderPendingConstraints(m) ? ["## تغييرات على القيود تنتظر مراجعة المستخدم (ليست سارية)", renderPendingConstraints(m)] : []), "## النصوص المعتمدة", renderPins(m)].join("\n");
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
    if (f.pending !== undefined) {
      if (!isObj(f.pending)) return { ok: false, error: "pending يجب أن يكون كائناً فيه approve و reject" };
      const keys = (v) => (Array.isArray(v) ? v : []).filter(isReviewKey).slice(0, LIMITS.list);
      out.pending = { approve: keys(f.pending.approve), reject: keys(f.pending.reject) };
    }
    if (f.log !== undefined) {
      if (!isObj(f.log)) return { ok: false, error: "log يجب أن يكون كائناً فيه remove" };
      out.log = { remove: (Array.isArray(f.log.remove) ? f.log.remove : []).filter((x) => typeof x === "string" && x.length <= 100).slice(0, LIMITS.list) };
    }
    if (!Object.keys(out).length) return { ok: false, error: "لا يوجد ما يُصحَّح" };
    return { ok: true, fix: out };
  }
  // ---------- what waits for you, and your answer to it ----------
  // keys: "d3" a decision not backed by your words · "x-d3" revoking d3 was proposed without your words ·
  // "c+<8>" / "c-<8>" adding / removing a constraint was proposed without your words (<8> = the constraint's fingerprint)
  const isReviewKey = (k) => typeof k === "string" && /^(d\d{1,6}|x-d\d{1,6}|c[+-][0-9a-f]{8})$/.test(k);
  const ckey = (sign, text) => "c" + sign + hash(text).slice(-8);   // the low 32 bits (the hash's first digits carry fewer)
  function reviewItems(memory) {
    const m = normalizeMemory(memory), out = [];
    for (const d of m.decisions) {
      if (d.status !== "active") continue;
      if (d.unverified) out.push({ key: d.id, kind: "decision", id: d.id, text: d.text, quote: d.quote, date: d.date, msg: d.msg || 0 });
      if (d.pendingRevoke) out.push({ key: "x-" + d.id, kind: "revoke", id: d.id, text: d.text, quote: d.pendingRevoke.quote, reason: d.pendingRevoke.reason, date: d.pendingRevoke.date });
    }
    for (const x of m.pending.constraints.add) out.push({ key: ckey("+", x.text), kind: "constraint-add", text: x.text, quote: x.quote, reason: x.reason, date: x.date });
    for (const x of m.pending.constraints.remove) out.push({ key: ckey("-", x.text), kind: "constraint-remove", text: x.text, quote: x.quote, reason: x.reason, date: x.date });
    return out;
  }
  // approve: the change happens (the decision is yours, the revocation or the constraint change takes effect);
  // reject: it doesn't (the decision is revoked; the revocation or the constraint change is dropped). Applied to m in place.
  function answerReview(m, key, approve, date, changes, missing) {
    const P = m.pending.constraints;
    if (/^d\d+$/.test(key)) {
      const d = m.decisions.find((x) => x.id === key && x.status === "active" && x.unverified);
      if (!d) return missing.push(key);
      if (!approve) { d.status = "revoked"; d.revokedOn = date || ""; delete d.pendingRevoke; return changes.push(`أُلغي ${key}`); }
      d.source = d.claimed || "assistant-approved";
      if (d.pendingReplaces) { const old = m.decisions.find((x) => x.id === d.pendingReplaces && x.status === "active" && x !== d); if (old) { old.status = "revoked"; old.revokedOn = date || ""; delete old.pendingRevoke; changes.push(`أُلغي ${old.id} (حلّ محله ${key})`); } d.replaces = d.pendingReplaces; }
      d.unverified = false; d.confirmed = true; delete d.claimed; delete d.pendingReplaces;
      return changes.push(`اعتُمد ${key}`);
    }
    if (key.startsWith("x-")) {
      const d = m.decisions.find((x) => x.id === key.slice(2) && x.status === "active" && x.pendingRevoke);
      if (!d) return missing.push(key);
      delete d.pendingRevoke;
      if (approve) { d.status = "revoked"; d.revokedOn = date || ""; return changes.push(`أُلغي ${d.id}`); }
      return changes.push(`بقي ${d.id} سارياً`);
    }
    const add = key[1] === "+", list = add ? P.add : P.remove, x = list.find((y) => ckey(add ? "+" : "-", y.text) === key);
    if (!x) return missing.push(key);
    if (add) { P.add = P.add.filter((y) => y !== x); if (approve && !m.constraints.includes(x.text)) m.constraints.push(x.text); }
    else { P.remove = P.remove.filter((y) => y !== x); if (approve) m.constraints = m.constraints.filter((c) => c !== x.text); }
    return changes.push(approve ? (add ? "أُضيف قيد" : "حُذف قيد") : (add ? "رُفضت إضافة قيد" : "بقي القيد كما هو"));
  }

  // → { memory, changes: [human-readable lines], missing: [ids not found], redacted } — never mutates its input
  function applyFix(memory, fix, date) {
    const m = normalizeMemory(JSON.parse(JSON.stringify(memory)));
    const changes = [], missing = [];
    let redacted = false;
    const R = (t) => { const r = redact(t); if (r.changed) redacted = true; return r.text; };
    const find = (id) => { const d = m.decisions.find((x) => x.id === id); if (!d) missing.push(id); return d; };
    if (fix.decisions) {
      // a corrected text is no longer what was confirmed: confirming it again is a separate, explicit approval
      for (const e of fix.decisions.edit) { const d = find(e.id); if (d && d.text !== R(e.text)) { d.text = R(e.text); delete d.confirmed; changes.push(`عُدّل نص ${d.id}`); } }
      for (const id of fix.decisions.approve) {
        const d = find(id); if (!d || d.status !== "active") continue;
        // a flagged decision, approved: it is what the model said it was, and it replaces what it was meant to replace
        if (d.unverified) { answerReview(m, id, true, date, changes, missing); continue; }
        if (d.source === "assistant") d.source = "assistant-approved";
        if (!d.confirmed) { d.confirmed = true; changes.push(`أكّدتَ ${id}`); }
      }
      for (const id of fix.decisions.revoke) { const d = find(id); if (d && d.status === "active") { d.status = "revoked"; d.revokedOn = date || ""; delete d.pendingRevoke; changes.push(`أُلغي ${id}`); } }
      for (const id of fix.decisions.remove) { const before = m.decisions.length; m.decisions = m.decisions.filter((x) => x.id !== id); if (m.decisions.length < before) changes.push(`حُذف ${id} نهائياً`); else missing.push(id); }
    }
    if (fix.constraints) {
      const rm = new Set(fix.constraints.remove), had = m.constraints.length, P = m.pending.constraints;
      m.constraints = m.constraints.filter((c) => !rm.has(c));
      if (m.constraints.length < had) changes.push(`حُذف ${had - m.constraints.length} من القيود`);
      for (const c of fix.constraints.add.map(R)) if (!m.constraints.includes(c)) { m.constraints.push(c); changes.push("أُضيف قيد"); }
      // what you settled yourself no longer waits for you
      P.add = P.add.filter((x) => !m.constraints.includes(x.text) && !rm.has(x.text)); P.remove = P.remove.filter((x) => m.constraints.includes(x.text) && !fix.constraints.add.includes(x.text));
    }
    if (fix.pending) {
      for (const k of fix.pending.approve) answerReview(m, k, true, date, changes, missing);
      for (const k of fix.pending.reject) answerReview(m, k, false, date, changes, missing);
    }
    if (fix.summary) { m.summary = { ...extras(m.summary, KNOWN_SUM, 8000), goal: R(fix.summary.goal), status: R(fix.summary.status), next: fix.summary.next.map(R), open: fix.summary.open.map(R) }; changes.push("استُبدلت الخلاصة الحالية"); }
    if (fix.log) for (const id of fix.log.remove) { const before = m.log.length; m.log = m.log.filter((e) => e.id !== id); if (m.log.length < before) changes.push(`حُذفت دفعة من السجل (${id})`); else missing.push(id); }
    if (changes.length) m.updated = date || m.updated;
    return { memory: normalizeMemory(m), changes, missing: [...new Set(missing)], redacted };
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
    render, renderCompact, redact, hasSecret, cleanStr, slug, pinNameOk, pinPath, upsertPin, extractVerbatim, importLegacy, trimForSize, estTokens, isGeneratedView, validateFix, applyFix, renderSelection, diffLines, count, W, PROTOCOL, evNorm, numbersIn, QUOTE_MAX,
    reviewItems, isReviewKey, negated, meaningGap };
});

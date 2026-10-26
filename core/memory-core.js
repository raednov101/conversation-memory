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

  // ---------- the interface's language ----------
  // Strings are written in Arabic and wrapped in T() / T`…`; core/i18n-en.js maps each to English (keyed by the Arabic
  // text itself). The language: the browser's or the system's, unless the user chose one (setLang). Tables built when a
  // module loads use the language of that moment, so a change of language takes effect on the next load of the page.
  const EN = (() => {
    try {
      if (typeof self !== "undefined" && self.CM_I18N_EN) return self.CM_I18N_EN;
    } catch {}
    try {
      if (typeof module === "object" && module.exports && typeof require === "function") return require("./i18n-en.js");
    } catch {}
    return {};
  })();
  const normLang = (l) => (/^ar/i.test(String(l || "")) ? "ar" : "en");
  function detectLang() {
    try {
      if (typeof process !== "undefined" && process.env && process.env.CONV_MEMORY_LANG) return process.env.CONV_MEMORY_LANG;
    } catch {}
    try {
      if (typeof chrome !== "undefined" && chrome.i18n && chrome.i18n.getUILanguage) return chrome.i18n.getUILanguage();
    } catch {}
    try {
      if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
    } catch {}
    try {
      return Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      return "ar";
    }
  }
  let LANG = normLang(detectLang());
  const setLang = (l) => (LANG = l === "auto" || !l ? normLang(detectLang()) : normLang(l));
  const lang = () => LANG;
  // T("نص") or T`نص ${x}`: the text in the current language (placeholders {0}, {1}… in the catalog)
  function T(s, ...vals) {
    const tpl = Array.isArray(s) ? s.reduce((a, q, i) => a + q + (i < vals.length ? `{${i}}` : ""), "") : String(s);
    const out = LANG === "en" && EN[tpl] ? EN[tpl] : tpl;
    return Array.isArray(s) ? out.replace(/\{(\d+)\}/g, (m, i) => (+i < vals.length ? String(vals[+i]) : m)) : out;
  }

  const FORMAT = "conversation-memory/1";
  const LIMITS = {
    str: 2000,
    title: 200,
    list: 50,
    decisions: 300,
    constraints: 100,
    log: 2000,
    entryMin: 30,
    imported: 400000,
    every: 50,
  }; // every: the most messages one summary may cover (both products)
  const SOURCES = ["user", "assistant-approved", "assistant"];
  // labels: translated where they are shown (T(SOURCE_LABEL[x])), so they follow the language of that moment
  const SOURCE_LABEL = { user: "المستخدم", "assistant-approved": "اقتراح اعتمده المستخدم", assistant: "اقتراح لم يُعتمد" }; // i18n-skip
  const PLATFORMS = { "claude-code": "Claude Code", chatgpt: "ChatGPT", "claude-web": "Claude (الويب)", gemini: "Gemini" }; // i18n-skip

  // ---------- small helpers ----------
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const isId = (v) => typeof v === "string" && /^d\d{1,6}$/.test(v);
  const isBatchId = (v) => typeof v === "string" && /^[A-Za-z0-9-]{1,120}$/.test(v);
  // strip control characters (keep \n and \t), system markers, and wrapper look-alikes; clamp length
  // The on-disk protocol both writers follow (the plugin and the extension on a linked folder): names, backup naming,
  // sizes and the shared lock. One definition, so the two can never drift apart.
  const PROTOCOL = {
    json: "CONVERSATION_MEMORY.json",
    md: "CONVERSATION_MEMORY.md",
    pins: "CONVERSATION_PINS",
    data: ".conversation-memory",
    backupRe: /^\d{8}-\d{6}-\d{3}(-[a-z0-9]{1,8})?\.json$/,
    maxBackups: 20,
    maxJson: 4 * 1024 * 1024,
    trimAt: 3 * 1024 * 1024,
    writeLock: "write.lock",
    writeLockStale: 15000,
    futureSkew: 60000,
  };
  // Arabic counting: 1 «رسالة واحدة», 2 «رسالتان», 3–10 «5 رسائل», 11+ «11 رسالة» (forms: [one, two, plural, singular])
  const count = (n, forms) => {
    const [one, two, plural, singular] = forms;
    n = Math.max(0, Math.floor(+n || 0));
    if (LANG === "en" && forms.en) return `${n} ${n === 1 ? forms.en[0] : forms.en[1]}`;
    const r = n % 100;
    return n === 1 ? one : n === 2 ? two : n === 0 ? `0 ${singular}` : r >= 3 && r <= 10 ? `${n} ${plural}` : `${n} ${singular}`;
  };
  const W = {
    msg: ["رسالة واحدة", "رسالتان", "رسائل", "رسالة"],
    msgGen: ["رسالة واحدة", "رسالتين", "رسائل", "رسالة"], // after a preposition: «بعد رسالتين»
    version: ["نسخة واحدة", "نسختان", "نسخ", "نسخة"],
    project: ["مشروع واحد", "مشروعان", "مشاريع", "مشروعاً"],
    summary: ["تلخيص واحد", "تلخيصان", "تلخيصات", "تلخيصاً"],
    decision: ["قرار واحد", "قراران", "قرارات", "قراراً"],
    batch: ["دفعة واحدة", "دفعتان", "دفعات", "دفعة"],
  };
  const W_EN = {
    msg: ["message", "messages"],
    msgGen: ["message", "messages"],
    version: ["version", "versions"],
    project: ["project", "projects"],
    summary: ["summary", "summaries"],
    decision: ["decision", "decisions"],
    batch: ["batch", "batches"],
  };
  for (const k of Object.keys(W)) W[k].en = W_EN[k];
  // cut a string to at most n UTF-16 units without splitting a surrogate pair; lone surrogates are dropped
  // (they turn into U+FFFD when written as UTF-8, and the read-back check would then fail forever)
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
  const wellFormed = (s) => String(s).replace(LONE_SURROGATE, "");
  const cut = (s, n) => {
    s = String(s);
    if (s.length <= n) return s;
    const c = s.charCodeAt(n - 1);
    return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
  };
  function cleanStr(v, max = LIMITS.str) {
    if (typeof v !== "string") return "";
    let s = wellFormed(v)
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g, "");
    let prev;
    do {
      prev = s;
      s = s.replace(/<!--\s*\/?\s*cm:[^>]*-->/gi, "").replace(/<\/?\s*conversation_memory[^>]*>/gi, "");
    } while (s !== prev);
    s = s.replace(/\[\s*conversation-memory\s*\]/gi, "(conversation-memory)"); // stored text can't pose as the system's own notes
    s = s.trim();
    return s.length > max ? cut(s, max) + "…" : s;
  }
  const cleanList = (v, max = LIMITS.list) =>
    (Array.isArray(v) ? v : [])
      .map((x) => cleanStr(x))
      .filter(Boolean)
      .slice(0, max);
  const visibleLen = (s) => s.replace(/[\s\-*#>|:._…()\[\]«»"']/g, "").length;
  // tiny deterministic hash (cyrb53) — change detection only, identical in Node and browsers
  function hash(str) {
    let h1 = 0xdeadbeef,
      h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
  }

  // ---------- secrets (linear time: one token pass, anchored token test) ----------
  const TOKEN_RE = /[A-Za-z0-9_.\-]+/g;
  const SECRET_TOKEN_RE =
    /^(sk-[A-Za-z0-9_-]{20,}|[sr]k_(live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}(?![0-9A-Z])|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|hf_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{30,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|ya29\.[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;
  // a private key is removed whole (header, body and footer); a header with no footer in reach is removed alone
  const PRIVATE_KEY_RE =
    /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z ]{0,40}PRIVATE KEY-----|-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g;
  const WEBHOOK_RE = /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/]{20,200}/g;
  const PLACEHOLDER = "(محذوف لأنه حساس)";
  // key names that contain a secret word (aws_secret_access_key, DB_PASSWORD, api-key, …) followed by = or : and a value.
  // Bounded repetitions keep it linear; the lookahead keeps redaction idempotent.
  // the value may be quoted (then everything up to the closing quote) or bare (4+ characters); Arabic also reads «كلمة المرور هي …»
  const ASSIGN_RE =
    /([A-Za-z0-9_\-]{0,40}(?:password|passwd|pwd|api[_-]?key|secret|token|access[_-]?key|private[_-]?key)[A-Za-z0-9_\-]{0,40}|كلمة\s{0,3}(?:ال)?(?:مرور|سر))(["']?\s{0,5}(?:[:=]|هي|هو)\s{0,5})(?!\(محذوف)(?:"[^"\n]{1,200}"|'[^'\n]{1,200}'|[^\s"']{4,200})/gi;
  const BEARER_RE = /\b(Bearer|Basic|Token)\s+(?!\(محذوف)[A-Za-z0-9._~+\/=-]{16,}/g;
  const URL_CRED_RE = /\b([a-z][a-z0-9+.\-]{1,20}:\/\/)[^\s:\/@]{1,100}:[^\s@\/]{1,200}@/gi;
  const isSecretToken = (t) => SECRET_TOKEN_RE.test(t.length > 400 ? t.slice(0, 400) : t); // the prefix decides; any length is removed
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
    return {
      format: FORMAT,
      title: cleanStr(title || T("ذاكرة المشروع"), LIMITS.title),
      lang: LANG, // the language its Markdown view is written in (stays the same whoever writes it next)
      updated: "",
      summary: { goal: "", status: "", next: [], open: [] },
      decisions: [],
      constraints: [],
      pending: { constraints: { add: [], remove: [] } },
      pins: [],
      log: [],
      imported: null,
      mdHash: "",
      archived: 0,
      history: [],
    };
  }
  // Fields a later version adds are kept as they are, never dropped: two writers of different versions (the plugin and the
  // extension, updated at different times) share one file, and the older one must not erase what the newer one wrote.
  const KNOWN_TOP = new Set([
    "format",
    "title",
    "lang",
    "updated",
    "summary",
    "decisions",
    "constraints",
    "pending",
    "pins",
    "log",
    "imported",
    "mdHash",
    "archived",
    "history",
  ]);
  const KNOWN_DEC = new Set([
    "id",
    "text",
    "source",
    "date",
    "status",
    "revokedOn",
    "replaces",
    "quote",
    "unverified",
    "claimed",
    "pendingReplaces",
    "msg",
    "confirmed",
    "pendingRevoke",
    "batch",
    "recheck",
  ]);
  function extras(o, known, max) {
    const out = {};
    let size = 0;
    for (const k of Object.keys(o)) {
      if (known.has(k) || !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k) || k in Object.prototype) continue;
      let v;
      try {
        v = JSON.stringify(o[k]);
      } catch {
        continue;
      }
      if (v === undefined || size + v.length + k.length > max) continue; // one too large is skipped; the others are still kept
      size += v.length + k.length;
      out[k] = JSON.parse(v);
    }
    return out;
  }
  // the format's version: a file written by a later format is read, but never written over (formatNewer)
  const formatVersion = (f) => {
    const x = /^conversation-memory\/(\d{1,4})$/.exec(String(f || ""));
    return x ? +x[1] : 1;
  };
  const formatNewer = (input) => isObj(input) && formatVersion(input.format) > formatVersion(FORMAT);
  const KNOWN_PEND = new Set(["text", "reason", "date", "quote"]),
    KNOWN_SUM = new Set(["goal", "status", "next", "open"]),
    KNOWN_PIN = new Set(["name", "version", "path", "sha", "date"]);
  const KNOWN_LOG = new Set(["id", "platform", "chat", "range", "date", "raised", "decided", "changed"]);
  const KNOWN_EV = new Set(["id", "at", "by", "ref", "kind", "target", "label", "before", "after", "why", "undoes"]);
  const pendingItems = (v) =>
    (Array.isArray(v) ? v : [])
      .filter(isObj)
      .map((x) => ({
        text: cleanStr(x.text),
        reason: cleanStr(x.reason, 200),
        date: cleanStr(x.date, 40),
        quote: cleanStr(x.quote, QUOTE_MAX),
        ...extras(x, KNOWN_PEND, 500),
      }))
      .filter((x) => x.text)
      .slice(-LIMITS.list);
  // accept anything (hand-edited, older, partial) and return a well-formed memory; never throws
  function normalizeMemory(input) {
    const m = emptyMemory(isObj(input) ? input.title : "");
    if (!isObj(input)) return m;
    m.updated = cleanStr(input.updated, 40);
    const s = isObj(input.summary) ? input.summary : {};
    m.summary = {
      goal: cleanStr(s.goal),
      status: cleanStr(s.status),
      next: cleanList(s.next),
      open: cleanList(s.open),
      ...extras(s, KNOWN_SUM, 8000),
    };
    const seen = new Set();
    m.decisions = (Array.isArray(input.decisions) ? input.decisions : [])
      .filter(isObj)
      .map((d) => ({
        id: isId(d.id) ? d.id : "",
        text: cleanStr(d.text),
        source: SOURCES.includes(d.source) ? d.source : "user",
        date: cleanStr(d.date, 40),
        status: d.status === "revoked" ? "revoked" : "active",
        revokedOn: cleanStr(d.revokedOn, 40),
        replaces: isId(d.replaces) ? d.replaces : "",
        quote: cleanStr(d.quote, QUOTE_MAX),
        unverified: d.unverified === true,
        ...(d.unverified === true && (d.claimed === "user" || d.claimed === "assistant-approved") ? { claimed: d.claimed } : {}),
        ...(d.unverified === true && isId(d.pendingReplaces) ? { pendingReplaces: d.pendingReplaces } : {}),
        ...(Number.isInteger(d.msg) && d.msg > 0 && d.msg < 1e7 ? { msg: d.msg } : {}),
        ...(d.confirmed === true && d.unverified !== true ? { confirmed: true } : {}),
        ...(isBatchId(d.batch) ? { batch: d.batch } : {}),
        ...(d.status !== "revoked" && d.unverified !== true && isObj(d.recheck)
          ? {
              recheck: {
                date: cleanStr(d.recheck.date, 40),
                from: Math.max(0, Math.floor(+d.recheck.from) || 0),
                reason: cleanStr(d.recheck.reason, 300),
              },
            }
          : {}),
        ...(d.status !== "revoked" && isObj(d.pendingRevoke)
          ? {
              pendingRevoke: {
                date: cleanStr(d.pendingRevoke.date, 40),
                reason: cleanStr(d.pendingRevoke.reason, 200),
                quote: cleanStr(d.pendingRevoke.quote, QUOTE_MAX),
              },
            }
          : {}),
        ...extras(d, KNOWN_DEC, 2000),
      }))
      .filter((d) => d.text)
      .slice(-LIMITS.decisions);
    let next = 1 + Math.max(0, ...m.decisions.map((d) => +String(d.id).slice(1) || 0));
    for (const d of m.decisions) {
      if (!d.id || seen.has(d.id)) d.id = "d" + next++;
      seen.add(d.id);
    }
    m.constraints = [...new Set(cleanList(input.constraints, LIMITS.constraints))];
    const pc = isObj(input.pending) && isObj(input.pending.constraints) ? input.pending.constraints : {};
    m.pending = {
      ...extras(isObj(input.pending) ? input.pending : {}, new Set(["constraints"]), 16000),
      constraints: {
        ...extras(pc, new Set(["add", "remove"]), 4000),
        add: pendingItems(pc.add).filter((x) => !m.constraints.includes(x.text)),
        remove: pendingItems(pc.remove).filter((x) => m.constraints.includes(x.text)),
      },
    };
    // the path is rebuilt from a validated name and version, never taken from the file (no "..", no other folders)
    m.pins = (Array.isArray(input.pins) ? input.pins : [])
      .filter(isObj)
      .filter((p) => typeof p.name === "string" && pinNameOk(p.name))
      .map((p) => {
        const name = p.name.trim().replace(/\s+/g, " "),
          version = Math.min(999999, Math.max(1, Math.floor(+p.version) || 1));
        return {
          name,
          version,
          path: pinPath(name, version),
          sha: typeof p.sha === "string" && /^[0-9a-f]{8,64}$/.test(p.sha) ? p.sha : "",
          date: cleanStr(p.date, 40),
          ...extras(p, KNOWN_PIN, 1000),
        };
      });
    m.log = (Array.isArray(input.log) ? input.log : [])
      .filter(isObj)
      .map((e) => ({
        id: cleanStr(e.id, 100),
        platform: PLATFORMS[e.platform] ? e.platform : "claude-code",
        chat: cleanStr(e.chat, 200),
        range: cleanStr(e.range, 40),
        date: cleanStr(e.date, 40),
        raised: cleanList(e.raised),
        decided: cleanList(e.decided),
        changed: cleanList(e.changed),
        ...extras(e, KNOWN_LOG, 1000),
      }))
      .filter((e) => e.id)
      .slice(-LIMITS.log);
    if (isObj(input.imported) && typeof input.imported.text === "string")
      m.imported = { date: cleanStr(input.imported.date, 40), text: cut(wellFormed(input.imported.text), LIMITS.imported) };
    m.mdHash = typeof input.mdHash === "string" ? input.mdHash.slice(0, 32) : "";
    m.archived = Math.max(0, Math.floor(+input.archived) || 0);
    m.history = (Array.isArray(input.history) ? input.history : []).filter(isObj).map(cleanEvent).filter(Boolean).slice(-HISTORY_MAX);
    m.lang = input.lang === "en" || input.lang === "ar" ? input.lang : "ar"; // files from before 2.0 are Arabic
    Object.assign(m, extras(input, KNOWN_TOP, 64000));
    if (formatNewer(input)) m.format = cleanStr(input.format, 40); // kept, so the file still says what wrote it
    return m;
  }
  // parse the JSON file text; a file that exists but isn't valid JSON is an error, never silently replaced
  function parseMemory(text) {
    if (text == null || text === "") return { ok: true, memory: emptyMemory() };
    try {
      const j = JSON.parse(text);
      if (!isObj(j)) throw new Error("not an object");
      return { ok: true, memory: normalizeMemory(j), newer: formatNewer(j) };
    } catch (e) {
      return { ok: false, error: T("ملف CONVERSATION_MEMORY.json ليس JSON صالحاً: ") + e.message };
    }
  }
  const serialize = (m) => JSON.stringify(m, null, 2) + "\n";
  const token = (fileText) => (fileText ? hash(fileText).slice(0, 12) : "none");

  // ---------- evidence: a decision attributed to the user must be backed by the user's own words ----------
  // The model writes the summary, so it can misattribute or invent. Each decision carries a short verbatim quote; the writer
  // checks it against the conversation it actually has, and checks that the decision's numbers appear there too.
  // A decision that fails is kept, but as an unapproved suggestion marked for review — nothing is lost, nothing is overstated.
  const QUOTE_MAX = 300,
    QUOTE_MIN = 4,
    APPROVAL_MIN = 2; // a decision is stated in a few words; an approval may be «نعم» or «ok»
  const DIGITS = {
    "٠": 0,
    "١": 1,
    "٢": 2,
    "٣": 3,
    "٤": 4,
    "٥": 5,
    "٦": 6,
    "٧": 7,
    "٨": 8,
    "٩": 9,
    "۰": 0,
    "۱": 1,
    "۲": 2,
    "۳": 3,
    "۴": 4,
    "۵": 5,
    "۶": 6,
    "۷": 7,
    "۸": 8,
    "۹": 9,
  };
  const asciiDigits = (t) =>
    String(t)
      .replace(/[٠-٩۰-۹]/g, (c) => DIGITS[c])
      .replace(/(\d)[,٬'](?=\d{3}(?!\d))/g, "$1");
  // spelling-insensitive: one Unicode form, no diacritics or tatweel, one alef/yaa/haa/kaf, no punctuation or markdown, single spaces
  const evNorm = (t) =>
    asciiDigits(String(t).normalize("NFKC"))
      .toLowerCase()
      .replace(/[ً-ٰٟـ]/g, "")
      .replace(/[أإآٱ]/g, "ا")
      .replace(/[ىی]/g, "ي")
      .replace(/ة/g, "ه")
      .replace(/ک/g, "ك")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  // The numbers a text states, as whole values (never a substring: «500» is not in «1500»). Numbers of 2+ digits only —
  // single digits are as often spelled out («ثلاثة») as written, and would flag real decisions. Not decision ids (d12) or
  // colour codes (#556B2F). The same amount written another way counts as one: «40 ألف» = 40000 = «40k»; a month's name = its number.
  const MONTHS = [
    ["يناير", "كانون الثاني", "january", "jan"],
    ["فبراير", "شباط", "february", "feb"],
    ["مارس", "آذار", "march", "mar"],
    ["ابريل", "أبريل", "نيسان", "april", "apr"],
    ["مايو", "أيار", "may"],
    ["يونيو", "حزيران", "june", "jun"],
    ["يوليو", "تموز", "july", "jul"],
    ["اغسطس", "أغسطس", "آب", "august", "aug"],
    ["سبتمبر", "أيلول", "september", "sep"],
    ["اكتوبر", "أكتوبر", "تشرين الأول", "october", "oct"],
    ["نوفمبر", "تشرين الثاني", "november", "nov"],
    ["ديسمبر", "كانون الأول", "december", "dec"],
  ];
  const SCALE = /^\s*(k|K|ألف|الف|آلاف|الاف|ألفاً|ألفا|الفا|m|M|مليون|ملايين)(?![\p{L}])/u;
  function numbersIn(t, expand) {
    const s = asciiDigits(String(t).normalize("NFKC")),
      out = new Set();
    const re = /(?<![A-Za-z#\d.])(\d+(?:\.\d+)?)/g;
    let m;
    while ((m = re.exec(s))) {
      const v = +m[1],
        sc = s.slice(re.lastIndex).match(SCALE),
        mul = sc ? (/^(m|M|مليون|ملايين)$/u.test(sc[1]) ? 1e6 : 1e3) : 1;
      if (m[1].replace(".", "").length >= 2 || mul > 1) out.add(String(v * mul));
      if (expand) {
        out.add(String(v));
        if (v * mul >= 1000 && (v * mul) % 1000 === 0) out.add(String((v * mul) / 1000));
        if (v * mul >= 1e6 && (v * mul) % 1e6 === 0) out.add(String((v * mul) / 1e6));
      }
    }
    if (expand) {
      const low = evNorm(s);
      MONTHS.forEach((names, i) => {
        if (names.some((n) => (" " + low + " ").includes(" " + evNorm(n) + " "))) {
          out.add(String(i + 1));
          out.add(String(i + 1).padStart(2, "0"));
        }
      });
    }
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
      turns = ev.turns
        .filter((t) => isObj(t) && (t.role === "user" || t.role === "assistant") && typeof t.text === "string")
        .map((t) => ({
          role: t.role,
          t: evNorm(t.text),
          raw: t.text,
          n: t.role !== "user" || t.n === null ? 0 : Number.isInteger(t.n) && t.n > 0 ? (k = t.n) : ++k,
        })); // n: null = number unknown
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
  const STOP = new Set(
    (
      "في من على الى عن مع هذا هذه ذلك تلك ان او ثم كل بعد قبل عند اللي الذي التي الذين هو هي هم انا نحن احنا انت انتم هل قد لقد كان يكون " +
      "ايضا بس يعني شي شيء كذا هنا هناك عشان علشان لان لكن بل حتى اذا لو وش ايش كيف متى ليش اي ايه نعم تمام اوكي طيب خلاص " +
      "اولا ثانيا بعدين لاحقا حاليا الحين الان هلق هلا دابا دلوقتي توه " +
      "the a an to of in on for and or is are was be we i you it this that with as at by from so then just ok okay yes first firstly later now " +
      "me my go do up if us am he she his her our"
    ).split(" "),
  );
  const NEG = new Set(
    (
      "لا لاء لاا لم لن ليس ليست لست لسنا مو مب مش ماني مانيب بلاش بدون عدم ممنوع يمنع منع نمنع تمنع امنع رفض نرفض ارفض يرفض ترفض " +
      "ولا فلا ولم ولن وليس وبدون وعدم ومنع لاتنشر مابي مابغي مابغا مابغى ماابي مانبي مانبغي ماودي " +
      "دون بلا استبعاد استبعد نستبعد يستبعد تجنب نتجنب يتجنب وتجنب ودون وبلا " +
      "not no never without cannot nor avoid stop dont nope nah exclude excluding skip skipping instead except unless decline declining refuse reject"
    ).split(" "),
  );
  // «ما» negates a verb or a «there is / I have»: «ما نستخدم»، «ما راح»، «ما ابي»، «ما عندي»، «ما فيه»
  const MA_NEG = (w) =>
    !!w &&
    (/^[ايتنب]/.test(w) ||
      ["راح", "رح", "عاد", "عندي", "عندنا", "فيه", "في", "بقى", "صار", "لي", "لنا", "لازم", "ضروري", "يصير", "ينفع"].includes(w));
  // idioms that read as negative but agree («لا بأس», «ما عندي مانع», «why not») — whole words only (never «لا شكراً»)
  const AGREE_IDIOM =
    /(?:^| )(?:لا باس|لا مانع|ما فيه مانع|ما في مانع|ما عندي مانع|مافي مانع|ليش لا|ولا يهمك|لا شك|no problem|why not|not a problem|no doubt)(?= |$)/g;
  const tokens = (t) => evNorm(t).replace(AGREE_IDIOM, " ").split(" ").filter(Boolean);
  function negatedTokens(w) {
    for (let i = 0; i < w.length; i++) {
      if (NEG.has(w[i]) || NEG.has(w[i].replace(/^[وف](?=..)/, ""))) return true; // «ومش»، «فلا»
      if ((w[i] === "ما" || w[i] === "وما") && MA_NEG(w[i + 1])) return true;
      if (/^(don|doesn|didn|isn|aren|wasn|weren|won|can|couldn|shouldn|wouldn|mustn)$/.test(w[i]) && w[i + 1] === "t") return true;
    }
    return false;
  }
  const negated = (t) => negatedTokens(tokens(t));
  // a change of mind in words: «ألغِ»، «خلاص بدلها»، «ما عاد»، «instead», «cancel»… (or the opposite polarity, checked apart)
  const CHANGE =
    /(?:^| )(?:الغ|الغي|الغيه|الغيها|الغوه|الغيت|الغينا|نلغي|نلغيه|نلغيها|الغاء|ملغي|خلاص|بدل\S*|نبدل\S*|غيره|غيرها|غيروا|غيرت|غيرنا|نغير\S*|تغيير|تغير|انس|انسى|انساه|انسها|شيل\S*|احذف\S*|حذف\S*|نحذف\S*|امسح\S*|تراجع\S*|نرجع|عدل|عدله|عدلها|نعدل\S*|ما عاد|لا عاد|عاد ما|بلاش|ماعاد|لا داعي|ما له داعي|مو لازم|مب لازم|ما يحتاج|ما نحتاج|no need|not needed|cancel\S*|revok\S*|drop\S*|remov\S*|instead|chang\S*|switch\S*|replac\S*|no longer|forget|scrap\S*|undo|delete\S*|خلنا من|خلينا من|خلونا من|دعنا من|دعك من|سيبك من|سيبنا من|انسوا|ننسى|ننساه|نساو|نسيو|لنلغ\S*|فلنلغ\S*|بلاها|بلاه|بلاهم|تخل\S*|نتخلى|اتخلى|بطل\S*|كنسل\S*|never ?mind|nevermind|ditch\S*|skip\S*|abandon\S*|no more|not anymore|kill\S*|axe|nix)(?= |$)/;
  const changeWords = (t) => CHANGE.test(evNorm(t));
  // small numbers spelled out, so «three stools» and «3 stools», «تلات مرات» and «ثلاث مرات» share their number
  const NUM_WORDS = {
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
    ten: "10",
    اثنين: "2",
    اثنان: "2",
    اتنين: "2",
    ثنين: "2",
    جوج: "2",
    مرتين: "2",
    يومين: "2",
    ثلاث: "3",
    ثلاثه: "3",
    تلات: "3",
    تلاته: "3",
    اربع: "4",
    اربعه: "4",
    خمس: "5",
    خمسه: "5",
    ست: "6",
    سته: "6",
    سبع: "7",
    سبعه: "7",
    ثمان: "8",
    ثمانيه: "8",
    تمن: "8",
    تسع: "9",
    تسعه: "9",
    عشر: "10",
    عشره: "10",
    half: "0.5",
    quarter: "0.25",
    نصف: "0.5",
    نص: "0.5",
    النصف: "0.5",
    ربع: "0.25",
    الربع: "0.25",
    ثلث: "0.33",
    الثلث: "0.33",
  };
  // days of the week are as easily swapped as numbers («الأحد» → «الاثنين»)
  const DAYS = [
    ["sunday", "sun", "الاحد", "احد", "الحد"],
    ["monday", "mon", "الاثنين", "الاتنين", "الثنين", "التنين", "اثنين"],
    ["tuesday", "tue", "الثلاثاء", "الثلاثا", "التلات", "التلاتاء", "ثلاثاء"],
    ["wednesday", "wed", "الاربعاء", "الاربعا", "اربعاء", "الاربع"],
    ["thursday", "thu", "الخميس", "خميس"],
    ["friday", "fri", "الجمعه", "جمعه"],
    ["saturday", "sat", "السبت", "سبت"],
  ];
  const AMBIG_DAYS = new Set(["احد", "الحد", "اثنين", "ثلاثاء", "اربعاء", "الاربع", "خميس", "جمعه", "سبت", "sun", "mon", "sat", "wed"]);
  const daysIn = (t) => {
    const w = tokens(t),
      out = new Set();
    w.forEach((x, k) => {
      const i = DAYS.findIndex((names) => names.includes(x));
      if (i < 0) return;
      if (AMBIG_DAYS.has(x) && !/^(يوم|يومي|كل|ايام|نهار|on|every)$/.test(w[k - 1] || "")) return;
      out.add(i);
    });
    return out;
  };
  // a rough stem: without the conjunction, the article and common suffixes (enough to compare two words, never shown)
  const stem = (w) =>
    w
      .replace(/^(و|ف)(?=.{3,})/, "")
      .replace(/^(ب|ل|ك)?ال(?=.{2,})|^لل(?=.{2,})/, "")
      .replace(/(ها|هم|هن|كم|نا|ات|ون|ين|ان|ه|ي|ك)$/, (s, _, i) => (i >= 3 ? "" : s));
  const content = (t) => [
    ...new Set(
      tokens(t)
        .map((w) => NUM_WORDS[w] || w)
        .filter((w) => !STOP.has(w) && !NEG.has(w) && (w.length >= 3 || /^\d+$/.test(w) || /^[a-z0-9]{2}$/.test(w)))
        .map((w) => (/^\d+$/.test(w) ? w : stem(w)))
        .filter((w) => w.length >= 2 || /^\d+$/.test(w)),
    ),
  ];
  // the decision without the reason given for it («… لأن …», «… because …»): a reason is welcome extra, not the topic
  const REASON =
    /(?:^| )(?:لان|لانه|لانها|لأن|بسبب|عشان|علشان|لعدم|رغم|بالرغم|مراعاه|بدل|بدلا|عوضا|because|since|due|despite|as it|so that|instead|rather than)(?= |$)/;
  const reasonPart = (t) => splitReason(t)[1];
  // the text split, as written, at its first reason / «instead of» word: [the decision's own part, the rest]
  const splitReason = (t) => {
    const w = String(t).split(/(\s+)/);
    for (let i = 2; i < w.length; i += 2) {
      const two = evNorm(w[i] + " " + (w[i + 2] || ""));
      if (REASON.test(" " + evNorm(w[i]) + " ") || REASON.test(" " + two + " ")) {
        const m = REASON.exec(" " + two + " ");
        if (m && m.index <= 1) return [w.slice(0, i).join("").trim(), w.slice(i).join("")];
      }
    }
    return [String(t), ""];
  };
  const core = (t) => evNorm(splitReason(t)[0]);
  // two words are the same word, roughly: equal, one inside the other (3+ letters), or the same 4-letter start (a leading
  // verb or plural letter aside: «اعتمدنا» ~ «اعتماد», «تنشر» ~ «نشر»). Never a shared fragment in the middle.
  const lead = (w) => (w.length > 4 ? w.replace(/^[ايتن]/, "") : w);
  const near = (a, b) =>
    a === b ||
    (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) ||
    [
      [a, b],
      [lead(a), b],
      [a, lead(b)],
      [lead(a), lead(b)],
    ].some(([x, y]) => x.length >= 4 && y.length >= 4 && x.slice(0, 4) === y.slice(0, 4));
  const shared = (a, b) => {
    const B = content(b);
    return content(a).filter((x) => B.some((y) => near(x, y))).length;
  };
  const shares = (a, b) => shared(a, b) > 0;
  // names and numbers written in Latin letters (a library, a product, a code) are the most often swapped: each must be in the quote
  // In Arabic text any Latin word is such a name; in English text only the words that look like one: Capitalized inside a
  // sentence, CamelCase, ACRONYMS, or with digits (not «Field» opening the sentence, not «returning»).
  const nameLike = (text) => {
    const raw = String(text),
      ar = (raw.match(/[\u0600-\u06FF]/g) || []).length,
      la = (raw.match(/[A-Za-z]/g) || []).length;
    if (ar >= la) return null; // Arabic: every Latin word
    const out = new Set();
    raw.replace(/(^|[.!?:;\n]\s*|\s)([A-Za-z][A-Za-z0-9-]*)/g, (m, before, w) => {
      const start = !before.trim() ? before === "" || /[.!?:;\n]\s*$/.test(before) : true;
      if (/[A-Z].*[A-Z]|\d/.test(w.slice(1)) || /^[A-Z]{2,}$/.test(w) || (/^[A-Z]/.test(w) && !start && !/^I$/.test(w)))
        out.add(stem(evNorm(w)));
      return m;
    });
    return out;
  };
  // (the decision's own part only: a name after «instead of» is the one being replaced)
  const latinMissing = (quote, text) => {
    const Q = content(quote),
      names = nameLike(text);
    return content(core(text)).filter((w) => /^[a-z]{2,}$/.test(w) && (!names || names.has(w)) && !Q.some((y) => near(w, y)));
  };
  // the quote in its message: the words just before it may negate it («لا أريد [نشر بياناتي]»), so its polarity is read with them
  // Read within the quote's own clause (up to the last «.», «،», «!»…): «لا، أبل لاحقاً. نبدأ بيوتيوب» does not negate
  // «نبدأ بيوتيوب». A clause that is only a refusal of the previous suggestion («لأ، عربي بس», «No, Antalya») is set aside:
  // what follows it is the user's choice, stated positively.
  const REFUSAL_ONLY = /^(?:لا|لاء|لا لا|لأ|no|nope|nah|مو|مش|لا والله)$/;
  // «لأ خليه L»: a refusal of the last suggestion followed by keep/let/make is the user's own choice, not a negation
  const REFUSE_THEN_CHOOSE =
    /^(?:لا|لاء|لأ|no|nope|nah) (?=(?:خلي|خليه|خليها|خله|خلها|خلنا|خلينا|خلوه|خلوها|خليهم|خليني|نخلي|make|keep|let|go|use)(?: |$))/;
  function polarityIn(q, ev, at, about) {
    const words = (t) => t.replace(AGREE_IDIOM, " ").replace(REFUSE_THEN_CHOOSE, "").split(" ").filter(Boolean);
    const raw = at && at.i >= 0 && ev.turns ? ev.turns[at.i].raw : null;
    if (!raw) return negatedTokens(words(q));
    const clauses = raw
      .split(/[.!?؟،,؛;:\n]+/)
      .map(evNorm)
      .filter(Boolean);
    // the clauses the quote covers (whole, or where it begins), and the words before it in its first clause
    const head = q.split(" ").slice(0, 2).join(" ");
    const parts = clauses.filter((c) => q.includes(c) || c.includes(q) || c.includes(head));
    let kept = parts.filter((c) => !REFUSAL_ONLY.test(c));
    // «let's use cursor pagination, not offset» about «use cursor pagination»: the «not offset» clause is about the other thing
    if (about && kept.length > 1) {
      const on = kept.filter((c) => !content(c).length || sharedWeight(c, about) >= 1);
      if (on.length) kept = on;
    }
    if (!kept.length) return negatedTokens(words(q).filter((w, i, a) => !(i === 0 && a.length > 1 && REFUSAL_ONLY.test(w))));
    const first = kept[0],
      k = first.indexOf(q.split(" ")[0]);
    const before = c(first, q) ? [] : words(k > 0 ? first.slice(0, k) : "").slice(-4);
    return negatedTokens([...before, ...kept.flatMap((x) => words(x.includes(q) ? q : x))]);
    function c(x, y) {
      return y.includes(x);
    }
  }
  // why a quote does not back a text, or "" (polarity, subject, names)
  // shared topic words, a distinctive one (a name in Latin letters, a number) counting double
  const sharedWeight = (a, b) => {
    const B = content(b);
    return content(a)
      .filter((x) => B.some((y) => near(x, y)))
      .reduce((s, x) => s + (/^[a-z][a-z0-9-]{2,}$/.test(x) || /^\d+$/.test(x) ? 2 : 1), 0);
  };
  const RESTRICT = /(?:^| )(?:بس|فقط|وحده|وحدها|حصرا|only|just|alone)(?= |$)/;
  // the decision is positive with an exclusion after it («… فقط دون نسخة إنجليزية», «…, no income», «… لا كنطاق»)
  const trailingExclusion = (t) => {
    const w = tokens(core(t)),
      i = w.findIndex((x, k) => k > 0 && NEG.has(x));
    return i > 0 && !negatedTokens(w.slice(0, i));
  };
  // a text in clauses: at punctuation, «and», and a word joined by «و» (Arabic «and») — the units a detail belongs to
  const CLAUSES = new Map();
  const clausesOf = (t) => {
    const k = String(t);
    if (CLAUSES.has(k)) return CLAUSES.get(k);
    const v = clausesOf0(k);
    if (CLAUSES.size > 200) CLAUSES.clear();
    if (k.length > 200) CLAUSES.set(k, v);
    return v;
  };
  const clausesOf0 = (t) =>
    String(t)
      .split(/(?:(?<!\d)[.,:]|[.,:](?!\d)|[!?؟،؛;\n])+|\s+(?:and|while|but)\s+|\s+(?=و[^\s]{3,})/i) // «$5,000», «2.5» and «10:30» stay whole
      .map(evNorm)
      .filter(Boolean);
  // Two details swapped between their owners («أحمد يسوق وسالم يطبخ» → «سالم يسوق وأحمد يطبخ», «$300 here and $500
  // there» → the other way): two clauses of the decision each take one word from two different clauses of your words,
  // crosswise. A merged or reordered paraphrase never crosses.
  function swapped(text, source) {
    const D = clausesOf(text).map(content),
      words = D.flat(),
      Q = clausesOf(source)
        .map(content)
        .filter((c) => c.some((x) => words.some((y) => near(x, y))))
        .slice(0, 40);
    if (Q.length < 2 || D.length < 2) return false;
    // each decision word → the one clause of your words it belongs to (words found in several clauses tell nothing)
    const home = (w) => {
      const hits = Q.map((c, i) => (c.some((y) => near(w, y)) ? i : -1)).filter((i) => i >= 0);
      return hits.length === 1 ? hits[0] : -1;
    };
    const homes = D.map((c) => [...new Set(c.map(home).filter((i) => i >= 0))]);
    for (let a = 0; a < homes.length; a++)
      for (let b = a + 1; b < homes.length; b++)
        for (const x of homes[a]) for (const y of homes[a]) if (x !== y && homes[b].includes(x) && homes[b].includes(y)) return true;
    // «الأخت تجيب الحلوى، والأم ترسل الدعوات» against «ماما تجيب الحلوى، وأختي ترسل الدعوات»: the first clause's owner
    // comes from the clause the other one belongs to
    const owner = D.map((c) => c.map(home).find((i) => i >= 0));
    for (let a = 0; a < homes.length; a++)
      for (let b = 0; b < homes.length; b++)
        if (
          a !== b &&
          homes[a].length >= 2 &&
          homes[b].length &&
          homes[b].every((i) => homes[a].includes(i)) &&
          homes[b].includes(owner[a])
        )
          return true;
    return false;
  }
  // «from X to Y» read the other way: a word that comes after «from» in one and after «to» in the other
  const FROM = new Set(["من", "from"]),
    TO = new Set(["الى", "لل", "into", "to", "onto", "ل"]);
  function directions(t) {
    const out = new Map();
    let role = "";
    for (const raw of tokens(t)) {
      let w = raw;
      if (FROM.has(w)) {
        role = "from";
        continue;
      }
      if (TO.has(w)) {
        role = "to";
        continue;
      }
      if (/^لل.{2,}/.test(w) && role === "from") (role = "to"), (w = w.slice(2));
      if (role && !STOP.has(w) && w.length >= 3) out.set(stem(w), role);
    }
    return out;
  }
  function reversed(text, source) {
    const a = directions(text),
      b = directions(source);
    if (![...a.values()].includes("from") || ![...b.values()].includes("from")) return false;
    for (const [w, r] of a) for (const [v, s2] of b) if (near(w, v) && r !== s2) return true;
    return false;
  }
  // words that mean the opposite of each other: one in the decision, its opposite (and not itself) in your words
  const OPPOSITES = [
    ["قبل", "بعد"],
    ["before", "after"],
    ["اكثر", "اقل"],
    ["more", "less"],
    ["فوق", "تحت"],
    ["above", "below"],
    ["زياده", "تقليل"],
    ["increase", "decrease"],
    ["ارفع", "اخفض"],
    ["اول", "اخر"],
    ["first", "last"],
    ["صباح", "مساء"],
    ["الصبح", "بالليل"],
    ["morning", "evening"],
    ["am", "pm"],
    ["شراء", "بيع"],
    ["buy", "sell"],
    ["يمين", "يسار"],
    ["left", "right"],
    ["داخل", "خارج"],
    ["inside", "outside"],
    ["حد ادنى", "حد اعلى"],
    ["minimum", "maximum"],
    ["min", "max"],
  ];
  function opposite(text, source) {
    const a = new Set(tokens(text)),
      b = new Set(tokens(source));
    const negAround = (t, w) => clausesOf(t).some((c) => c.split(" ").includes(w) && negated(c));
    const clash = (x, y) => a.has(x) && b.has(y) && !b.has(x) && negAround(text, x) === negAround(source, y);
    return OPPOSITES.some(([x, y]) => clash(x, y) || clash(y, x));
  }
  function detailGap(text, source) {
    if (swapped(text, source)) return T("تفصيلان تبادلا مكانيهما مقارنة بكلامك");
    if (reversed(text, source)) return T("الاتجاه معكوس مقارنة بكلامك (من/إلى)");
    if (opposite(text, source)) return T("في القرار عكس ما في كلامك (قبل/بعد، أكثر/أقل…)");
    return "";
  }
  // not a yes yet: «let me ask my father», «I'll run it by my wife», «سأناقشها مع الإدارة», «منشوف بعدين», «something else?»
  const DEFER =
    /(?:^| )[وف]?(?:اشاور|نشاور|اشيك|نشيك|افكر|نفكر|اسال|نسال|اراجع|نراجع|سأناقش\S*|ساناقش\S*|نناقش\S*|نشوف|منشوف|بنشوف|بشوف|بعدين|لاحقا|محتار|محتاره|مش متاكد|مو متاكد|مب متاكد|ما ادري|مدري|ارد عليك|نرد عليك|مبدئيا|حل واقعي|حل ثاني|غير كذا|شي ثاني|بنفسي|انا اتصرف|later|think about it|run it by|check with|ask my|talk to|not sure|in principle|something else|another option|alternative|myself|get back to you|let me think|let me check)(?= |$)/;
  // said about this one time («اليوم», «هذا الرد», «فهاد الوصفة», «for the cover letter»): not a standing rule
  const ONE_OFF =
    /(?:^| )(?:اليوم|الليله|هالمره|هذي المره|هذه المره|هالوصفه|هذه الوصفه|هذي الوصفه|فهاد الوصفه|هاد المره|في هذا الرد|هذا الرد|هالرد|بهالرد|this time|this reply|this one|today|tonight|for the cover letter|for this)(?= |$)/;
  const INSTEAD = /^(?:بدل|بدلا|عوضا|instead|rather)(?= |$)/;
  // the words before the first negation («خلي العزومة بالبيت» of «… مو بالمطعم»), and the rest
  function splitAtNeg(t) {
    const w = tokens(t);
    const i = w.findIndex(
      (x, k) =>
        NEG.has(x) ||
        NEG.has(x.replace(/^[وف](?=..)/, "")) ||
        ((x === "ما" || x === "وما") && MA_NEG(w[k + 1])) ||
        (x === "don" && w[k + 1] === "t"),
    );
    return i < 0 ? [w.join(" "), ""] : [w.slice(0, i).join(" "), w.slice(i).join(" ")];
  }
  // what you chose positively: your clauses without a negation or a «drop it» word
  const chosenIn = (quote) =>
    clausesOf(quote)
      .map((c) => splitAtNeg(c)[0])
      .filter((c) => c && !changeWords(c))
      .join(" ");
  function meaningGap(quote, text, negQuote) {
    const negText = negated(core(text)),
      rp = evNorm(reasonPart(text));
    const [mainD, exclD] = splitAtNeg(core(text)),
      chosen = chosenIn(quote),
      clean = (t) => t.replace(new RegExp(RESTRICT.source, "g"), " ");
    // «X only, without Y» / «X only» / «drop Y, keep X»: the same choice only if X is what you kept and Y is not
    const sameThing = sharedWeight(clean(chosen), clean(mainD)) >= 1 && !(exclD && sharedWeight(clean(chosen), exclD) >= 1);
    const restrictedSame = RESTRICT.test(core(text)) && clausesOf(quote).some((c) => RESTRICT.test(c) && !negated(c)) && sameThing;
    const sameChoice =
      (!negQuote && negText && trailingExclusion(text) && (RESTRICT.test(evNorm(quote)) || changeWords(quote)) && sameThing) ||
      // «X بدل Y» against «X، مو Y»: X must be in what you said positively, Y in what you refused
      (negQuote && !negText && INSTEAD.test(rp) && shares(rp, quote) && sharedWeight(chosen, core(text)) >= 1) ||
      (negQuote && !negText && restrictedSame);
    if (negQuote !== negText && !sameChoice) return T("المعنى قد يعاكس كلامك (نفي في أحدهما فقط)");
    const n = content(core(text)).length,
      s = sharedWeight(quote, core(text));
    const need = content(quote).length <= 3 ? 1 : Math.min(2, Math.ceil(n / 4));
    if (!s || s < need) return T("الاقتباس لا يذكر موضوع القرار");
    const lm = latinMissing(quote, text);
    if (lm.length) return T`اسم في القرار ليس في كلامك: ${lm.slice(0, 2).join(T("، "))}`;
    return "";
  }
  // where your words are: the number of your message that holds q (the newest one; 0 when unknown), and its place among the
  // turns (-1 when only the joined text is known); null when they are not yours at all
  // a quote of one or two words must be whole words («ok» is not in «look», «اي» is not in «النهائي»)
  const hasQuote = (t, q) => (q.split(" ").length >= 3 ? t.includes(q) : (" " + t + " ").includes(" " + q + " "));
  function findUserQuote(q, ev) {
    if (ev.turns) {
      for (let i = ev.turns.length - 1; i >= 0; i--)
        if (ev.turns[i].role === "user" && hasQuote(ev.turns[i].t, q)) return { n: ev.turns[i].n, i };
      return null;
    }
    return hasQuote(ev.user, q) ? { n: 0, i: -1 } : null;
  }
  const notYours = (q, ev) => (ev.all.includes(q) ? T("الاقتباس ليس من كلامك في المحادثة") : T("الاقتباس غير موجود في المحادثة"));
  // → { why: "" when backed, else the reason (Arabic, shown to the user), msg: your message's number when known }.
  // Every quote must be your own words: for a decision, the words that state it; for an approved suggestion, the words that
  // approve it — and then the suggestion must be what the reply just before your approval proposed.
  // The numbers a decision states must be in the words it rests on — the message of your quote (and, for an approval, the
  // suggestion just before it) — or already established (known). Anywhere in the conversation is not enough: when you say
  // 3 days after the assistant proposed 5, «5 days» is not yours. Single digits and spelled-out small numbers count here.
  const digitsIn = (t) => {
    const out = new Set();
    for (const m of asciiDigits(String(t).normalize("NFKC")).matchAll(/(?<![A-Za-z\d.#])\d+(?:\.\d+)?(?![\dA-Za-z])/g))
      out.add(String(+m[0]));
    for (const w of tokens(t)) if (NUM_WORDS[w]) out.add(NUM_WORDS[w]);
    for (const n of numbersIn(t, false)) out.add(n); // «5K», «40 ألف» as whole values
    return out;
  };
  const localNumbers = (ev, at, prevAssistant) => {
    if (!at || at.i < 0 || !ev.turns) return ev.numbers;
    const raw = [ev.turns[at.i].raw || ev.turns[at.i].t, prevAssistant || ""].join("\n");
    return new Set([...numbersIn(raw, true), ...digitsIn(raw)]);
  };
  const numbersMissing = (text, local, known) => [...digitsIn(text)].filter((n) => !local.has(n) && !(known && known.has(n)));
  // the days you named outside a negated clause («التلاتا، مش الأربعا» names Tuesday), once per message
  const DAYS_SEEN = new Map();
  function positiveDays(raw) {
    const k = String(raw);
    if (DAYS_SEEN.has(k)) return DAYS_SEEN.get(k);
    const v = new Set(
      clausesOf(k)
        .filter((c) => !negated(c))
        .flatMap((c) => [...daysIn(c)]),
    );
    if (DAYS_SEEN.size > 200) DAYS_SEEN.clear();
    DAYS_SEEN.set(k, v);
    return v;
  }
  // a question is not a decision: «وش رأيك نحط زعيم؟», «What about a raffle?»
  const QUESTION_START =
    /^(?:وش رايك|ايش رايك|شو رايك|شرايك|ما رايك|ايش رايكم|وش رايكم|هل|ممكن|يمكن|ليش ما|ليش لا|تتوقع|تقترح|what about|how about|should we|shall we|could we|can we|would it|do you think|what if)(?= |$)/;
  function asQuestion(q, ev, at) {
    if (QUESTION_START.test(q)) return true;
    const raw = at && at.i >= 0 && ev.turns ? ev.turns[at.i].raw : "";
    if (!raw) return false;
    // the sentence the quote sits in ends with a question mark
    for (const m of String(raw).matchAll(/[^.!?؟\n]+[.!?؟]*/g)) if (evNorm(m[0]).includes(q)) return /[?؟]\s*$/.test(m[0]);
    return false;
  }
  // an approval says yes, or names what it approves («do the raffle», «التوقيع أوكي»)
  const AGREE =
    /(?:^| )(?:نعم|اي|ايه|ايوه|ايوا|اكيد|تمام|اوكي|اوك|ok|okay|موافق|موافقه|ماشي|طيب|زين|حلو|حلوه|ممتاز|يلا|يالله|yalla|اعتمد\S*|معتمد|بالظبط|بالضبط|ياريت|ياليت|خلاص|توكل|توكلنا|سوها|سوه|نفذ\S*|كمل|مزيان|واخا|صافي|تمشي|بتمشي|يمشي|منيح|yes|yep|yeah|sure|fine|great|perfect|agreed|deal|sounds|go ahead|do it|lets do it|approved|good|love it|كذا تمام)(?= |$)/;
  // «…, but …»: what follows a reservation in the approval message is the user changing part of it
  const RESERVATION = /(?:^| )(?:بس|لكن|بشرط|الا|غير ان|but|however|except|only if|as long as)(?= )/;
  function checkDecision(a, ev, known) {
    const q = evNorm(a.quote || "");
    let msg = 0,
      atRef = null,
      prevRaw = "";
    if (a.source !== "assistant") {
      if (q.replace(/\s/g, "").length < (a.source === "user" ? QUOTE_MIN : APPROVAL_MIN)) return { why: T("بلا اقتباس من كلامك"), msg };
      const at = findUserQuote(q, ev);
      if (!at) return { why: notYours(q, ev), msg };
      msg = at.n;
      atRef = at;
      if (asQuestion(q, ev, at)) return { why: T("اقتباسك سؤال، لا قرار"), msg };
      if (ev.turns && at.i >= 0) {
        const yourDays = positiveDays(ev.turns[at.i].raw || ev.turns[at.i].t);
        const dd = [...daysIn(a.text)].filter((d) => !yourDays.has(d));
        let j = at.i - 1;
        while (j >= 0 && ev.turns[j].role !== "assistant") j--;
        const prevDays = a.source === "assistant-approved" && j >= 0 ? daysIn(ev.turns[j].raw || ev.turns[j].t) : new Set();
        if (dd.some((d) => !prevDays.has(d) && !(known && known.has("day:" + d)))) return { why: T("يوم في القرار ليس في كلامك"), msg };
      }
      if (a.source === "user") {
        const gap = meaningGap(a.quote, a.text, polarityIn(q, ev, at, core(a.text)));
        if (gap) return { why: gap, msg };
        const dg = at.i >= 0 ? detailGap(a.text, ev.turns[at.i].raw || ev.turns[at.i].t) : detailGap(a.text, a.quote);
        if (dg) return { why: dg, msg };
      } else {
        if (ev.turns && at.i >= 0) {
          let j0 = at.i - 1;
          while (j0 >= 0 && ev.turns[j0].role !== "assistant") j0--;
          if (j0 >= 0) prevRaw = ev.turns[j0].raw || ev.turns[j0].t;
        }
        // an approval is a plain yes: no refusal or reservation anywhere in that message («نعم، لكن لا تحذف…» is not one)
        // «آبل باي ماشي، تابي لا» approves Apple Pay: the «لا» is about something else
        const negClauseAbout = (raw) =>
          String(raw || "")
            .split(/[.!?؟،,؛;:\n]+/)
            .map(evNorm)
            .filter((c) => c && negated(c))
            .some((c) => !content(c).length || sharedWeight(c, core(a.text)) >= 1);
        if (negated(a.quote) || (at.i >= 0 && negClauseAbout(ev.turns[at.i].raw || ev.turns[at.i].t)))
          return { why: T("اقتباس الموافقة فيه رفض أو نفي أو تحفّظ"), msg };
        if (!AGREE.test(q) && !shares(q, core(a.text))) return { why: T("الاقتباس ليس موافقة"), msg };
        if (at.i >= 0) {
          // a deferral in the same message: not agreed yet — unless it is clearly about something else and your yes names this
          const clauses = clausesOf(ev.turns[at.i].raw || ev.turns[at.i].t);
          const deferred = clauses.filter((c) => DEFER.test(c));
          if (deferred.length && (deferred.some((c) => sharedWeight(c, core(a.text)) >= 1) || !shares(q, core(a.text))))
            return { why: T("في ردك تأجيل أو تحفّظ، لا موافقة بعد"), msg };
        }
        if (at.i >= 0) {
          const m = ev.turns[at.i].t,
            r = RESERVATION.exec(m);
          // a reservation about the same thing: the user changed this part («Okay, but make it March 15»)
          if (r && r.index >= Math.max(0, m.indexOf(q))) {
            const rest = m.slice(r.index + r[0].length),
              restNums = digitsIn(rest),
              reflected = restNums.size > 0 && [...restNums].every((x) => digitsIn(a.text).has(x)) && !swapped(a.text, rest);
            if (!reflected && content(rest).length >= 1 && sharedWeight(rest, core(a.text)) >= 1)
              return { why: T("وافقتَ مع تعديل على هذا نفسه؛ القرار لا يعكس تعديلك"), msg };
          }
          // numbers the user stated in the approval itself are the ones that count
          const own = digitsIn(ev.turns[at.i].raw || m),
            took = [...own].every((x) => digitsIn(a.text).has(x));
          if (own.size) {
            const all = prevRaw ? digitsIn(prevRaw) : new Set(),
              picked = [...own].every((x) => all.has(x)); // your numbers are some of the suggested ones: you chose those
            const sugg = took && !picked ? all : new Set();
            const off = [...digitsIn(a.text)].filter((n) => !own.has(n) && !sugg.has(n) && !(known && known.has(n)));
            if (off.length) return { why: T`رقم ليس في كلامك الذي بُني عليه: ${off.slice(0, 3).join(T("، "))}`, msg };
          }
        }
        if (ev.turns && at.i >= 0) {
          let j = at.i - 1;
          while (j >= 0 && ev.turns[j].role !== "assistant") j--;
          // the suggestion approved must be what that reply proposed: a third of the decision's topic words (its reason
          // aside) are in it, and every name
          const n = content(core(a.text)).length;
          if (j >= 0) prevRaw = ev.turns[j].raw || ev.turns[j].t;
          const yoursBefore = ev.turns
            .slice(0, at.i + 1)
            .filter((x) => x.role === "user")
            .map((x) => x.t)
            .join(" ");
          if (
            j < 0 ||
            sharedWeight(ev.turns[j].t, core(a.text)) < Math.max(1, Math.ceil(n / 3)) ||
            latinMissing(ev.turns[j].t + " " + yoursBefore, a.text).length
          )
            return { why: T("موافقتك لا تتبع اقتراحاً بهذا المضمون"), msg };
        }
      }
    }
    const miss = numbersIn(a.text, false).filter((n) => !ev.numbers.has(n) && !known.has(n));
    if (!miss.length && a.source !== "assistant" && atRef) {
      let j = atRef.i - 1;
      while (ev.turns && j >= 0 && ev.turns[j].role !== "assistant") j--;
      const prev = ev.turns && j >= 0 ? ev.turns[j].raw || ev.turns[j].t : "";
      const local = localNumbers(ev, atRef, a.source === "assistant-approved" ? prevRaw : "");
      const off = [
        ...numbersMissing(splitReason(a.text)[0], local, known),
        ...numbersMissing(reasonPart(a.text), localNumbers(ev, atRef, prev), known),
      ];
      if (off.length) return { why: T`رقم ليس في كلامك الذي بُني عليه: ${off.slice(0, 3).join(T("، "))}`, msg };
    }
    return { why: miss.length ? T`رقم لا يظهر في المحادثة: ${miss.slice(0, 3).join(T("، "))}` : "", msg };
  }
  // A change to something you decided (revoking or replacing a decision, removing a constraint) needs your words for that
  // change: from a message after the one it came from, not the words it was made with, and saying so — a change of mind
  // («ألغِ»، «بدل»، «ما عاد»…) or the opposite of it. Adding a constraint needs your words stating it (polarity kept).
  // target: { text, quote?, msg? } — what is changed (a constraint has no quote or message of its own)
  function checkChange(quote, target, ev, kind) {
    if (!ev) return { why: T("لم يتوفر نص المحادثة للتحقق"), msg: 0 };
    const q = evNorm(quote || "");
    if (q.replace(/\s/g, "").length < QUOTE_MIN) return { why: T("بلا اقتباس من كلامك"), msg: 0 };
    const at = findUserQuote(q, ev);
    if (!at) return { why: notYours(q, ev), msg: 0 };
    const neg = polarityIn(q, ev, at, kind === "add" ? core(target.text) : "");
    if (kind === "add") {
      const src = ev.turns && at.i >= 0 ? ev.turns[at.i].raw || ev.turns[at.i].t : quote;
      if (ONE_OFF.test(evNorm(src))) return { why: T("قلتَه لهذه المرة فقط، لا قيداً دائماً"), msg: at.n };
      const dgc = detailGap(target.text, src);
      if (dgc) return { why: dgc, msg: at.n };
      const off = ev.turns && at.i >= 0 ? numbersMissing(target.text, localNumbers(ev, at, ""), null) : [];
      if (off.length) return { why: T`رقم ليس في كلامك الذي بُني عليه: ${off.slice(0, 3).join(T("، "))}`, msg: at.n };
      const gap = meaningGap(quote, target.text, neg);
      return { why: gap === T("الاقتباس لا يذكر موضوع القرار") ? T("الاقتباس لا يذكر موضوع القيد") : gap, msg: at.n };
    }
    // what is replaced must be named by your words — or, for a replacement, by the new decision those words back
    if (!shares(quote, target.text) && !(kind === "replace" && target.next && shares(target.next, target.text)))
      return { why: T("الاقتباس لا يذكر ما يُلغى"), msg: at.n };
    if (target.quote && (q.includes(evNorm(target.quote)) || evNorm(target.quote).includes(q)))
      return { why: T("الاقتباس هو كلامك الذي قررته به، لا كلامك الذي ألغيته به"), msg: at.n };
    if (target.msg && at.n && at.n <= target.msg) return { why: T("الاقتباس من رسالة قبل القرار أو منها"), msg: at.n };
    // a mere opposite («بيانات العملاء مهمة» against «لا ننشر…») is not a change of mind: the words must say it
    if (kind !== "replace" && !changeWords(quote)) return { why: T("الاقتباس لا يقول إنك ألغيته أو غيّرته"), msg: at.n };
    return { why: "", msg: at.n };
  }

  // ---------- drafts ----------
  // shape: { batch, base?, summary?: {goal,status,next[],open[]}, decisions?: {add:[{text,source,quote?,replaces?}], revoke:[id]},
  //          constraints?: {add:[], remove:[]}, entry: {raised[], decided[], changed[]} }
  function validateDraft(d, expectBatch) {
    if (!isObj(d)) return { ok: false, error: T("المسودة يجب أن تكون كائن JSON") };
    const batch = typeof d.batch === "string" ? d.batch : "";
    if (expectBatch && batch !== expectBatch) return { ok: false, error: T`المسودة تخص دفعة أخرى (${batch || T("بلا معرّف")})` };
    const out = { batch, base: typeof d.base === "string" ? d.base.slice(0, 20) : "" };
    if (d.summary !== undefined) {
      if (!isObj(d.summary)) return { ok: false, error: T("summary يجب أن يكون كائناً") };
      out.summary = {
        goal: cleanStr(d.summary.goal),
        status: cleanStr(d.summary.status),
        next: cleanList(d.summary.next),
        open: cleanList(d.summary.open),
      };
      if (!out.summary.goal && !out.summary.status) return { ok: false, error: T("summary يحتاج goal أو status على الأقل") };
    }
    if (d.decisions !== undefined) {
      if (!isObj(d.decisions)) return { ok: false, error: T("decisions يجب أن يكون كائناً فيه add و revoke") };
      const add = (Array.isArray(d.decisions.add) ? d.decisions.add : [])
        .map((x) => (typeof x === "string" ? { text: x } : x))
        .filter(isObj)
        .map((x) => ({
          text: cleanStr(x.text),
          source: SOURCES.includes(x.source) ? x.source : "user",
          replaces: isId(x.replaces) ? x.replaces : "",
          quote: cleanStr(x.quote, QUOTE_MAX),
        }))
        .filter((x) => x.text)
        .slice(0, LIMITS.list);
      // a revoke names the decision and, for one you made, quotes the words you revoked it with: "d3" or { id, quote }
      const revoke = (Array.isArray(d.decisions.revoke) ? d.decisions.revoke : [])
        .map((x) => (typeof x === "string" ? { id: x } : x))
        .filter((x) => isObj(x) && isId(x.id))
        .map((x) => ({ id: x.id, quote: cleanStr(x.quote, QUOTE_MAX) }))
        .slice(0, LIMITS.list);
      out.decisions = { add, revoke };
    }
    if (d.constraints !== undefined) {
      if (!isObj(d.constraints)) return { ok: false, error: T("constraints يجب أن يكون كائناً فيه add و remove") };
      // a constraint is your standing requirement: "text" or { text, quote } (the quote: your words that state or drop it)
      const items = (v) =>
        (Array.isArray(v) ? v : [])
          .map((x) => (typeof x === "string" ? { text: x } : x))
          .filter(isObj)
          .map((x) => ({ text: cleanStr(x.text), quote: cleanStr(x.quote, QUOTE_MAX) }))
          .filter((x) => x.text)
          .slice(0, LIMITS.list);
      out.constraints = { add: items(d.constraints.add), remove: items(d.constraints.remove) };
    }
    const e = isObj(d.entry) ? d.entry : null;
    if (!e) return { ok: false, error: T("entry مطلوب (raised و decided و changed)") };
    out.entry = { raised: cleanList(e.raised), decided: cleanList(e.decided), changed: cleanList(e.changed) };
    const all = [...out.entry.raised, ...out.entry.decided, ...out.entry.changed].join(" ");
    if (visibleLen(all) < LIMITS.entryMin) return { ok: false, error: T("ملخص الدفعة (entry) فارغ أو قصير جداً") };
    return { ok: true, draft: out };
  }

  // apply a validated draft. ctx: { platform, chat, range, date, allowSummary, evidence?: {user, all, turns?} }
  // Everything that would change what you decided is checked against your own words in the conversation:
  //  - a decision attributed to you (checkDecision): unbacked → kept as a suggestion waiting for you, never trusted;
  //  - revoking or replacing a decision of yours: unbacked → it stays in force, and the revocation waits for you;
  //  - adding or removing a constraint: unbacked → waits for you (memory.pending), the constraints are untouched.
  // Without the conversation's text nothing can be checked, so nothing is trusted (it all waits for you).
  // returns { memory, applied, redacted, skipped[], unverified: [{id, text, reason}], pending: [{key, text, reason}] } — never mutates its input
  const NO_EVIDENCE = () => T("لم يتوفر نص المحادثة للتحقق");
  function applyDraft(memory, draft, ctx) {
    const m = normalizeMemory(JSON.parse(JSON.stringify(memory)));
    if (m.log.some((e) => e.id === draft.batch))
      return { memory: m, applied: false, redacted: false, skipped: ["already-applied"], unverified: [], pending: [] };
    let redacted = false;
    const R = (s) => {
      const r = redact(s);
      if (r.changed) redacted = true;
      return r.text;
    };
    const RL = (l) => l.map(R);
    const skipped = [],
      unverified = [],
      pending = [];
    const date = ctx.date || "";
    const ev = prepareEvidence(ctx.evidence);
    // numbers already established may be restated without being in this part of the conversation: those of decisions in
    // force that were backed (never the model-written summary, never a flagged decision), constraints, and this year
    const known = ev
      ? numbersIn(
          [
            ...m.decisions.filter((d) => d.status === "active" && !d.unverified).map((d) => d.text + " " + d.quote),
            ...m.constraints,
            String(date).slice(0, 4),
          ].join(" "),
          true,
        )
      : null;
    // the days already established, like the numbers («… يوم الجمعة بدل وادي رم» keeps Friday from the decision it replaces)
    if (known)
      for (const d of m.decisions) if (d.status === "active" && !d.unverified) for (const i of daysIn(d.text)) known.add("day:" + i);
    const yours = (d) => d.source !== "assistant"; // a decision you made or approved (not the model's own suggestion)
    // revoke d, or (when the words for it are missing) leave it in force with the revocation waiting for you
    const revokeOrHold = (d, quote, why) => {
      if (!why) {
        d.status = "revoked";
        d.revokedOn = date;
        delete d.pendingRevoke;
        return;
      }
      d.pendingRevoke = { date, reason: why, quote: R(quote || "") };
      pending.push({ key: "x-" + d.id, text: d.text, reason: why });
    };
    if (draft.summary) {
      if (ctx.allowSummary)
        m.summary = {
          ...extras(m.summary, KNOWN_SUM, 8000),
          goal: R(draft.summary.goal),
          status: R(draft.summary.status),
          next: RL(draft.summary.next),
          open: RL(draft.summary.open),
        };
      else skipped.push("summary");
    }
    if (draft.decisions) {
      for (const r of draft.decisions.revoke) {
        const d = m.decisions.find((x) => x.id === r.id && x.status === "active");
        if (!d) continue;
        // the model's own suggestions it may withdraw; one of yours needs your words for it
        revokeOrHold(d, r.quote, yours(d) ? checkChange(r.quote, d, ev, "revoke").why : "");
      }
      let next = 1 + Math.max(0, ...m.decisions.map((d) => +d.id.slice(1) || 0));
      for (const a of draft.decisions.add) {
        const text = R(a.text);
        if (m.decisions.some((d) => d.status === "active" && d.text === text)) continue; // same decision twice
        const c = ev ? checkDecision(a, ev, known) : { why: a.source === "assistant" ? "" : NO_EVIDENCE(), msg: 0 };
        const why = c.why;
        // an unbacked decision never replaces one in force: it waits as a suggestion until the user approves it — and then
        // it becomes what the model said it was (the user's decision, or an approved suggestion) and replaces what it meant to.
        // A backed one replaces a decision of yours only if its words are about that decision too; else the old one waits for you.
        // A backed one replaces a decision of yours only with your words for the change (checkChange); the model's own
        // suggestion never replaces one of yours, it only proposes. It claims to replace only what it really replaced.
        let replaced = "";
        if (a.replaces && !why) {
          const old = m.decisions.find((x) => x.id === a.replaces && x.status === "active");
          if (old && !yours(old)) {
            revokeOrHold(old, a.quote, "");
            replaced = old.id;
          } else if (old && a.source !== "assistant") {
            // your words for the change fit another decision of yours better: that is the one you changed, not this one
            const fit = (x) => sharedWeight(a.quote, x.text + " " + x.quote);
            const other = m.decisions.find((x) => x.status === "active" && x !== old && yours(x) && fit(x) > fit(old));
            const ch = other
              ? T`كلامك يخص قراراً آخر (${other.id})، لا ${old.id}`
              : checkChange(a.quote, { ...old, next: core(a.text) }, ev, "replace").why;
            revokeOrHold(old, a.quote, ch);
            if (!ch) replaced = old.id;
          }
        }
        const id = "d" + next++;
        m.decisions.push({
          id,
          text,
          source: why ? "assistant" : a.source,
          date,
          status: "active",
          revokedOn: "",
          replaces: replaced,
          quote: R(a.quote || ""),
          unverified: !!why,
          ...(c.msg > 0 ? { msg: c.msg } : {}),
          ...(isBatchId(draft.batch) ? { batch: draft.batch } : {}),
          ...(why && a.source !== "assistant" ? { claimed: a.source } : {}),
          ...(why && a.replaces ? { pendingReplaces: a.replaces } : {}),
        });
        if (why) unverified.push({ id, text, reason: why });
      }
      m.decisions = m.decisions.slice(-LIMITS.decisions);
    }
    if (draft.constraints) {
      const P = m.pending.constraints;
      for (const r of draft.constraints.remove) {
        const c = m.constraints.find((x) => x === r.text);
        if (!c) continue;
        const why = checkChange(r.quote, { text: c }, ev, "remove").why;
        if (!why) {
          m.constraints = m.constraints.filter((x) => x !== c);
          P.remove = P.remove.filter((x) => x.text !== c);
          continue;
        }
        if (!P.remove.some((x) => x.text === c)) {
          P.remove.push({ text: c, reason: why, date, quote: R(r.quote) });
          pending.push({ key: ckey("-", c), text: c, reason: why });
        }
      }
      for (const a of draft.constraints.add) {
        const text = R(a.text);
        if (m.constraints.includes(text)) continue;
        const why = checkChange(a.quote, { text }, ev, "add").why;
        if (!why) {
          m.constraints.push(text);
          P.add = P.add.filter((x) => x.text !== text);
          continue;
        }
        if (!P.add.some((x) => x.text === text)) {
          P.add.push({ text, reason: why, date, quote: R(a.quote) });
          pending.push({ key: ckey("+", text), text, reason: why });
        }
      }
      m.constraints = [...new Set(m.constraints)].slice(-LIMITS.constraints);
      P.add = P.add.slice(-LIMITS.list);
      P.remove = P.remove.slice(-LIMITS.list);
    }
    m.log.push({
      id: draft.batch,
      platform: PLATFORMS[ctx.platform] ? ctx.platform : "claude-code",
      chat: cleanStr(ctx.chat || "", 200),
      range: cleanStr(ctx.range || "", 40),
      date,
      raised: RL(draft.entry.raised),
      decided: RL(draft.entry.decided),
      changed: RL(draft.entry.changed),
    });
    m.log = m.log.slice(-LIMITS.log);
    m.updated = date;
    return { memory: normalizeMemory(m), applied: true, redacted, skipped, unverified, pending }; // normalized again: one field order, always
  }

  // a model's reply (browser extension) → draft fields. The reply holds a JSON object between two markers.
  const START = "⟦ذاكرة:بداية⟧",
    END = "⟦ذاكرة:نهاية⟧";
  function parseModelReply(text) {
    const i = text.indexOf(START),
      j = i < 0 ? -1 : text.indexOf(END, i + START.length);
    if (i < 0 || j < 0) return { ok: false, error: T("لم يأتِ رد النموذج بالصيغة المطلوبة") };
    let body = text
      .slice(i + START.length, j)
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    const a = body.indexOf("{"),
      b = body.lastIndexOf("}");
    if (a < 0 || b < a) return { ok: false, error: T("الملخص ليس JSON") };
    const raw = body.slice(a, b + 1);
    try {
      return { ok: true, fields: JSON.parse(raw) };
    } catch (e) {
      // seen on claude.ai: JSON written outside a code block is typeset — straight quotes become “ ”, and long strings
      // get line breaks. Undo exactly that, and accept the reply only if it then parses.
      try {
        return { ok: true, fields: JSON.parse(repairTypeset(raw)), repaired: true };
      } catch {
        return { ok: false, error: T("الملخص ليس JSON صالحاً: ") + e.message };
      }
    }
  }
  function repairTypeset(t) {
    t = t.replace(/[\u201C\u201D\u201E\u201F\u2033\uFF02]/g, '"');
    let out = "",
      inStr = false,
      esc = false;
    for (const ch of t) {
      if (inStr) {
        if (esc) {
          esc = false;
          out += ch;
          continue;
        }
        if (ch === "\\") {
          esc = true;
          out += ch;
          continue;
        }
        if (ch === '"') inStr = false;
        out += ch === "\n" || ch === "\r" || ch === "\t" ? " " : ch;
      } else {
        if (ch === '"') inStr = true;
        out += ch;
      }
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
    return l.length
      ? l
          .map((d) => `- **${d.id}** ${d.text}${d.unverified ? T(" ⚠️ لم يثبت من كلامك؛ راجعه") : ""}${d.date ? ` _(${d.date})_` : ""}`)
          .join("\n")
      : "";
  }
  // constraint changes that wait for you (the model proposed them without your words)
  function renderPendingConstraints(m) {
    const P = m.pending.constraints,
      l = [...P.add.map((x) => T`- إضافة: ${x.text} _(${x.reason})_`), ...P.remove.map((x) => T`- حذف: ${x.text} _(${x.reason})_`)];
    return l.join("\n");
  }
  // how sure we are of a decision: you confirmed it, or your words were found (where), or neither
  const backing = (d) => (d.confirmed ? T("✓ أكّدته") : d.quote ? (d.msg ? T`اقتباس من رسالتك ${d.msg}` : T("اقتباس من كلامك")) : "");
  function renderDecisions(m, withRevoked) {
    const active = m.decisions.filter(isDecision);
    let out = active.length
      ? active
          .map(
            (d) =>
              `- **${d.id}** ${d.text} _(${T(SOURCE_LABEL[d.source])}${d.date ? T("، ") + d.date : ""}${d.replaces ? T("، يحل محل ") + d.replaces : ""}${withRevoked && backing(d) ? T("، ") + backing(d) : ""})_${d.pendingRevoke ? T(" ⚠️ اقتُرح إلغاؤه دون دليل من كلامك؛ راجعه") : ""}${withRevoked && d.quote ? `\n  > «${d.quote}»` : ""}`,
          )
          .join("\n")
      : T("لا قرارات سارية بعد.");
    const revoked = m.decisions.filter((d) => d.status === "revoked");
    if (withRevoked && revoked.length)
      out +=
        T("\n\n<details><summary>قرارات أُلغيت (") +
        revoked.length +
        ")</summary>\n\n" +
        revoked.map((d) => T`- ~~${d.text}~~ _(أُلغي ${d.revokedOn || ""})_`).join("\n") +
        "\n\n</details>";
    return out;
  }
  function renderPins(m) {
    return m.pins.length
      ? m.pins.map((p) => T`- **${p.name}** — النسخة ${p.version} · ${p.date} · بصمة ${p.sha.slice(0, 12)} · \`${p.path}\``).join("\n") +
          T("\nالنص الكامل في الملف المذكور؛ عند استخدامه اقرأه وانسخه حرفياً.")
      : T("لا توجد نصوص معتمدة بعد.");
  }
  function renderSummary(m) {
    const s = m.summary,
      lines = [];
    if (s.goal) lines.push(T`- **الهدف:** ${s.goal}`);
    if (s.status) lines.push(T`- **الوضع الآن:** ${s.status}`);
    if (s.next.length) lines.push(T`- **الخطوة التالية:**\n${s.next.map((x) => `  - ${x}`).join("\n")}`);
    if (s.open.length) lines.push(T`- **أسئلة مفتوحة:**\n${s.open.map((x) => `  - ${x}`).join("\n")}`);
    return lines.join("\n") || T("لم تُكتب خلاصة بعد.");
  }
  function renderEntry(e) {
    const parts = [
      `### ${PLATFORMS[e.platform] ? T(PLATFORMS[e.platform]) : e.platform}${e.chat ? " · " + e.chat : ""}${e.range ? T(" · الرسائل ") + e.range : ""}${e.date ? " · " + e.date : ""}`,
    ];
    if (e.raised.length) parts.push(T`**ما طُرح:**\n${bullets(e.raised)}`);
    if (e.decided.length) parts.push(T`**ما تقرّر:**\n${bullets(e.decided)}`);
    if (e.changed.length) parts.push(T`**ما تغيّر:**\n${bullets(e.changed)}`);
    return parts.join("\n");
  }
  // the human view of the whole memory (generated; edits belong in the JSON, through Claude)
  // the views of a memory are written in the memory's own language, not the interface's: the Markdown file must come out
  // the same whoever regenerates it (else it would look hand-edited to the other writer)
  function inLang(l, fn) {
    const prev = LANG;
    LANG = l === "en" ? "en" : "ar";
    try {
      return fn();
    } finally {
      LANG = prev;
    }
  }
  function render(m) {
    return inLang(m.lang, () => render0(m));
  }
  function render0(m) {
    const sug = renderSuggestions(m);
    const out = [
      `# ${m.title}`,
      "",
      T`> يُولَّد تلقائياً من CONVERSATION_MEMORY.json — آخر تحديث: ${m.updated || "—"}. لا تعدّله يدوياً: يُعاد توليده عند كل حفظ، وتعديلك اليدوي يُحفظ في نسخة جانبية.`,
      "",
      T("## الخلاصة الحالية"),
      renderSummary(m),
      "",
      T("## القرارات السارية"),
      renderDecisions(m, true),
      "",
      ...(sug ? [T("## مقترحات لم تُعتمد بعد"), sug, ""] : []),
      T("## القيود والمتطلبات"),
      m.constraints.length ? bullets(m.constraints) : T("لا قيود مسجلة بعد."),
      "",
      ...(renderPendingConstraints(m) ? [T("## تغييرات على القيود تنتظر مراجعتك"), renderPendingConstraints(m), ""] : []),
      T("## النصوص المعتمدة"),
      renderPins(m),
      "",
      T("## السجل"),
      m.log.length ? m.log.map(renderEntry).join("\n\n") : T("لا سجل بعد."),
    ];
    if (m.archived) out.push("", T`_(${m.archived} دفعة أقدم نُقلت إلى الأرشيف في .conversation-memory/archive/ للحفاظ على حجم الملف.)_`);
    if (m.imported) out.push("", T`## من الإصدار السابق (${m.imported.date})`, "", m.imported.text);
    return out.join("\n") + "\n";
  }
  // the small view loaded into context at session start: current state first, then the newest log entries within budget
  function renderCompact(m, budget = 5000) {
    return inLang(m.lang, () => renderCompact0(m, budget));
  }
  function renderCompact0(m, budget) {
    const sug = renderSuggestions(m);
    const head = [
      `# ${m.title}`,
      T("## الخلاصة الحالية"),
      renderSummary(m),
      T("## القرارات السارية"),
      renderDecisions(m, false),
      ...(sug ? [T("## مقترحات لم تُعتمد بعد"), sug] : []),
      T("## القيود والمتطلبات"),
      m.constraints.length ? bullets(m.constraints) : T("لا قيود مسجلة بعد."),
      ...(renderPendingConstraints(m) ? [T("## تغييرات على القيود تنتظر مراجعة المستخدم (ليست سارية)"), renderPendingConstraints(m)] : []),
      T("## النصوص المعتمدة"),
      renderPins(m),
    ].join("\n");
    let out = head.length > budget ? cut(head, budget) + T("\n…(اقتُطع؛ الملف الكامل أدناه)") : head;
    const entries = [];
    for (let k = m.log.length - 1; k >= 0; k--) {
      const r = renderEntry(m.log[k]);
      if (out.length + entries.reduce((a, x) => a + x.length, 0) + r.length + 40 > budget) break;
      entries.unshift(r);
    }
    if (entries.length) out += T("\n## أحدث السجل\n") + entries.join("\n\n");
    const hidden = m.log.length - entries.length;
    if (hidden > 0 || m.imported)
      out += T`\n\n(${hidden > 0 ? T`${hidden} دفعة أقدم` : ""}${hidden > 0 && m.imported ? T(" و") : ""}${m.imported ? T("محتوى الإصدار السابق") : ""} في CONVERSATION_MEMORY.md — اقرأه عند الحاجة فقط.)`;
    return out;
  }

  // ---------- corrections (the user fixes the memory directly; every fix is a normal, backed-up, undoable write) ----------
  // shape: { decisions?: { edit: [{id, text}], approve: [id], revoke: [id], remove: [id] }, constraints?: { add: [], remove: [] },
  //          summary?: {goal, status, next[], open[]}, log?: { remove: [id] } }
  function validateFix(f) {
    if (!isObj(f)) return { ok: false, error: T("التصحيح يجب أن يكون كائن JSON") };
    const out = {},
      ids = (v) => (Array.isArray(v) ? v : []).filter(isId).slice(0, LIMITS.list);
    if (f.decisions !== undefined) {
      if (!isObj(f.decisions)) return { ok: false, error: T("decisions يجب أن يكون كائناً") };
      const edit = (Array.isArray(f.decisions.edit) ? f.decisions.edit : [])
        .filter(isObj)
        .filter((x) => isId(x.id))
        .map((x) => ({ id: x.id, text: cleanStr(x.text) }))
        .filter((x) => x.text)
        .slice(0, LIMITS.list);
      out.decisions = { edit, approve: ids(f.decisions.approve), revoke: ids(f.decisions.revoke), remove: ids(f.decisions.remove) };
    }
    if (f.constraints !== undefined) {
      if (!isObj(f.constraints)) return { ok: false, error: T("constraints يجب أن يكون كائناً") };
      out.constraints = { add: cleanList(f.constraints.add), remove: cleanList(f.constraints.remove) };
    }
    if (f.summary !== undefined) {
      if (!isObj(f.summary)) return { ok: false, error: T("summary يجب أن يكون كائناً") };
      out.summary = {
        goal: cleanStr(f.summary.goal),
        status: cleanStr(f.summary.status),
        next: cleanList(f.summary.next),
        open: cleanList(f.summary.open),
      };
      if (!out.summary.goal && !out.summary.status) return { ok: false, error: T("summary يحتاج goal أو status على الأقل") };
    }
    if (f.pending !== undefined) {
      if (!isObj(f.pending)) return { ok: false, error: T("pending يجب أن يكون كائناً فيه approve و reject") };
      const keys = (v) => (Array.isArray(v) ? v : []).filter(isReviewKey).slice(0, LIMITS.list);
      out.pending = { approve: keys(f.pending.approve), reject: keys(f.pending.reject) };
    }
    if (f.log !== undefined) {
      if (!isObj(f.log)) return { ok: false, error: T("log يجب أن يكون كائناً فيه remove") };
      out.log = {
        remove: (Array.isArray(f.log.remove) ? f.log.remove : [])
          .filter((x) => typeof x === "string" && x.length <= 100)
          .slice(0, LIMITS.list),
      };
    }
    if (!Object.keys(out).length) return { ok: false, error: T("لا يوجد ما يُصحَّح") };
    return { ok: true, fix: out };
  }
  // ---------- what waits for you, and your answer to it ----------
  // keys: "d3" a decision not backed by your words · "x-d3" revoking d3 was proposed without your words ·
  // "c+<8>" / "c-<8>" adding / removing a constraint was proposed without your words (<8> = the constraint's fingerprint)
  const isReviewKey = (k) => typeof k === "string" && /^(d\d{1,6}|[xr]-d\d{1,6}|c[+-][0-9a-f]{8})$/.test(k);
  const ckey = (sign, text) => "c" + sign + hash(text).slice(-8); // the low 32 bits (the hash's first digits carry fewer)
  // You edited message n of a chat: every decision this chat gave from message n on is checked again, with the same
  // rules, against the conversation as it is now. One whose words are no longer there (or now say otherwise) stays in
  // force but is marked for you to look at again («🔎 Review decisions»); one still backed just gets its message number.
  // chatKey: the chat's id as in its batch ids (ext-<key>-… / api-<key>-…); evidence: the conversation now.
  function recheckDecisions(memory, { chatKey, from, evidence, date }) {
    const m = normalizeMemory(JSON.parse(JSON.stringify(memory)));
    const ev = prepareEvidence(evidence),
      k = String(chatKey || "").slice(0, 24),
      n0 = Math.max(1, Math.floor(+from) || 1),
      flagged = [];
    if (!ev || !k) return { memory: m, flagged };
    const mine = (d) => typeof d.batch === "string" && (d.batch.startsWith(`ext-${k}-`) || d.batch.startsWith(`api-${k}-`));
    const known = numbersIn(
      [
        ...m.decisions.filter((d) => d.status === "active" && !d.unverified && !mine(d)).map((d) => d.text + " " + d.quote),
        ...m.constraints,
        String(date || "").slice(0, 4),
      ].join(" "),
      true,
    );
    for (const d of m.decisions) {
      if (d.status !== "active" || d.unverified || !mine(d) || (d.msg && d.msg < n0)) continue;
      const c = checkDecision({ text: d.text, source: d.source, quote: d.quote }, ev, known);
      if (c.why) {
        d.recheck = { date: cleanStr(date, 40), from: n0, reason: T`عدّلتَ رسالتك رقم ${n0}: ${c.why}` };
        flagged.push(d.id);
      } else if (c.msg) d.msg = c.msg;
    }
    return { memory: m, flagged };
  }
  function reviewItems(memory) {
    const m = normalizeMemory(memory),
      out = [];
    for (const d of m.decisions) {
      if (d.status !== "active") continue;
      if (d.unverified) out.push({ key: d.id, kind: "decision", id: d.id, text: d.text, quote: d.quote, date: d.date, msg: d.msg || 0 });
      if (d.recheck)
        out.push({
          key: "r-" + d.id,
          kind: "recheck",
          id: d.id,
          text: d.text,
          quote: d.quote,
          reason: d.recheck.reason,
          date: d.recheck.date,
          msg: d.msg || 0,
        });
      if (d.pendingRevoke)
        out.push({
          key: "x-" + d.id,
          kind: "revoke",
          id: d.id,
          text: d.text,
          quote: d.pendingRevoke.quote,
          reason: d.pendingRevoke.reason,
          date: d.pendingRevoke.date,
        });
    }
    for (const x of m.pending.constraints.add)
      out.push({ key: ckey("+", x.text), kind: "constraint-add", text: x.text, quote: x.quote, reason: x.reason, date: x.date });
    for (const x of m.pending.constraints.remove)
      out.push({ key: ckey("-", x.text), kind: "constraint-remove", text: x.text, quote: x.quote, reason: x.reason, date: x.date });
    return out;
  }
  // approve: the change happens (the decision is yours, the revocation or the constraint change takes effect);
  // reject: it doesn't (the decision is revoked; the revocation or the constraint change is dropped). Applied to m in place.
  function answerReview(m, key, approve, date, changes, missing) {
    const P = m.pending.constraints;
    if (/^d\d+$/.test(key)) {
      const d = m.decisions.find((x) => x.id === key && x.status === "active" && x.unverified);
      if (!d) return missing.push(key);
      if (!approve) {
        d.status = "revoked";
        d.revokedOn = date || "";
        delete d.pendingRevoke;
        return changes.push(T`أُلغي ${key}`);
      }
      d.source = d.claimed || "assistant-approved";
      if (d.pendingReplaces) {
        const old = m.decisions.find((x) => x.id === d.pendingReplaces && x.status === "active" && x !== d);
        if (old) {
          old.status = "revoked";
          old.revokedOn = date || "";
          delete old.pendingRevoke;
          changes.push(T`أُلغي ${old.id} (حلّ محله ${key})`);
        }
        d.replaces = d.pendingReplaces;
      }
      d.unverified = false;
      d.confirmed = true;
      delete d.claimed;
      delete d.pendingReplaces;
      return changes.push(T`اعتُمد ${key}`);
    }
    // a decision whose message you edited: approve = it still holds (the mark goes), reject = cancel it
    if (key.startsWith("r-")) {
      const d = m.decisions.find((x) => x.id === key.slice(2) && x.status === "active" && x.recheck);
      if (!d) return missing.push(key);
      delete d.recheck;
      if (approve) return changes.push(T`بقي ${d.id} سارياً`);
      d.status = "revoked";
      d.revokedOn = date || "";
      delete d.pendingRevoke;
      return changes.push(T`أُلغي ${d.id}`);
    }
    if (key.startsWith("x-")) {
      const d = m.decisions.find((x) => x.id === key.slice(2) && x.status === "active" && x.pendingRevoke);
      if (!d) return missing.push(key);
      delete d.pendingRevoke;
      if (approve) {
        d.status = "revoked";
        d.revokedOn = date || "";
        return changes.push(T`أُلغي ${d.id}`);
      }
      return changes.push(T`بقي ${d.id} سارياً`);
    }
    const add = key[1] === "+",
      list = add ? P.add : P.remove,
      x = list.find((y) => ckey(add ? "+" : "-", y.text) === key);
    if (!x) return missing.push(key);
    if (add) {
      P.add = P.add.filter((y) => y !== x);
      if (approve && !m.constraints.includes(x.text)) m.constraints.push(x.text);
    } else {
      P.remove = P.remove.filter((y) => y !== x);
      if (approve) m.constraints = m.constraints.filter((c) => c !== x.text);
    }
    return changes.push(approve ? (add ? T("أُضيف قيد") : T("حُذف قيد")) : add ? T("رُفضت إضافة قيد") : T("بقي القيد كما هو"));
  }

  // → { memory, changes: [human-readable lines], missing: [ids not found], redacted } — never mutates its input
  // ---------- splitting the shared memory of earlier versions, one chat at a time ----------
  // Before 1.5 every chat outside a project wrote into one shared memory. Each summary in it carries its batch id, and
  // the batch id carries the chat (ext-<chat>-… / api-<chat>-…), so a chat's part can be found and moved to its own
  // memory: its log entries, the decisions its summaries added (by their batch, or — for decisions saved before they
  // recorded one — by their quote found word for word in that chat's saved text). Pure: the writer stores both results.
  // → { groups: [{ key, label, entries, decisions }] } for a preview, or with key: { moved, kept } (both memories)
  function splitShared(memory, key, transcripts) {
    const m = normalizeMemory(JSON.parse(JSON.stringify(memory)));
    // the chat part of a batch id (the first 24 characters of the chat's key)
    const chatOf = (batch) => {
      const x = /^(?:ext|api)-(.+)-\d+-\d+-[a-z0-9]+$/.exec(String(batch || ""));
      return x ? x[1].slice(0, 24) : "";
    };
    const tx = transcripts || {}; // chat key → the user's own messages in it (the writer passes only those)
    const inChat = (q, k) => !!tx[k] && hasQuote(evNorm(tx[k]), q);
    const belongs = (d, k) => {
      if (d.batch) return chatOf(d.batch) === k.slice(0, 24);
      // a decision saved before decisions recorded their batch: its quote, at least three words, in this chat and no other
      const q = evNorm(d.quote || "");
      if (q.split(" ").filter(Boolean).length < 3 || !inChat(q, k)) return false;
      return Object.keys(tx).filter((o) => inChat(q, o)).length === 1;
    };
    if (key === undefined) {
      const groups = new Map();
      for (const e of m.log) {
        const k = chatOf(e.id);
        if (!k) continue;
        // the chat's whole key, from its saved text's name when there is one (the batch keeps only its first 24 characters)
        const full = Object.keys(tx).find((n) => n.slice(0, 24) === k) || k;
        const g = groups.get(k) || { key: full, prefix: k, label: "", entries: 0, decisions: 0, last: "" };
        g.entries++;
        g.label = e.chat || g.label;
        g.last = e.date || g.last;
        groups.set(k, g);
      }
      for (const g of groups.values()) g.decisions = m.decisions.filter((d) => belongs(d, g.key)).length;
      return { groups: [...groups.values()].sort((a, b) => String(b.last).localeCompare(String(a.last))) };
    }
    const k = String(key).slice(0, 24);
    const moved = emptyMemory(m.log.find((e) => chatOf(e.id) === k)?.chat || "");
    moved.lang = m.lang;
    moved.log = m.log.filter((e) => chatOf(e.id) === k);
    moved.decisions = m.decisions.filter((d) => belongs(d, key));
    moved.constraints = m.constraints.slice(); // standing rules stay true for the chat that moves out
    const ids = new Set(moved.decisions.map((d) => d.id));
    m.log = m.log.filter((e) => chatOf(e.id) !== k);
    m.decisions = m.decisions.filter((d) => !ids.has(d.id));
    return { moved: normalizeMemory(moved), kept: m };
  }

  // ---------- relevance: what in the memory is about a task ----------
  // «I'm writing the invitation» → the date, the place, the approved wording. A plain word match (same roots, numbers,
  // names), no index and no model: decisions in force, pinned texts and recent log entries that share words with the
  // query, best first. The summary and the constraints (standing rules) always come along. Isolation between projects
  // is not affected: this only ever looks inside the one memory it is given.
  function relevant(memory, query, limits) {
    const m = normalizeMemory(memory),
      L = { decisions: 12, log: 4, pins: 3, ...(limits || {}) };
    const sel = { summary: true, constraints: m.constraints.length > 0, decisions: [], pins: [], log: [] };
    if (!content(query).length) return sel;
    const score = (t) => sharedWeight(query, t);
    const top = (items, key, text, n) =>
      items
        .map((x) => ({ k: x[key], s: score(text(x)) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, n)
        .map((x) => x.k);
    sel.decisions = top(
      m.decisions.filter((d) => d.status === "active"),
      "id",
      (d) => d.text + " " + d.quote,
      L.decisions,
    );
    sel.pins = top(m.pins, "name", (p) => p.name, L.pins);
    sel.log = top(m.log.slice(-60), "id", (e) => [e.chat, ...e.raised, ...e.decided, ...e.changed].join(" "), L.log);
    return sel;
  }

  // ---------- history: every change, why it happened, and undoing one change ----------
  // Each write is compared with what it replaced; every difference that matters to the user becomes an event: a decision
  // added, cancelled, brought back, reworded, approved; a constraint added or removed; the summary rewritten. An event
  // says when, what did it (a summary of messages 6–10, your review, a correction, a restore, an undo) and what the
  // value was before and after, so one change can be undone without bringing back a whole older file — as long as
  // nothing changed the same thing since. Undoing is itself an event, and can be undone.
  const HISTORY_MAX = 400;
  const EV_BY = ["summary", "review", "fix", "restore", "undo", "pin", "import", "write"];
  const EV_KINDS = [
    "decision.add",
    "decision.revoke",
    "decision.restore",
    "decision.edit",
    "decision.verify",
    "decision.unverify",
    "decision.confirm",
    "decision.unconfirm",
    "decision.remove",
    "constraint.add",
    "constraint.remove",
    "summary",
  ];
  // a value before or after: nothing, a text, or a small record of texts and true/false
  function evValue(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return cleanStr(v);
    if (typeof v === "boolean") return v;
    if (!isObj(v)) return null;
    const o = {};
    for (const k of Object.keys(v).slice(0, 6))
      if (/^[a-z][A-Za-z]{0,20}$/.test(k)) o[k] = typeof v[k] === "boolean" ? v[k] : cleanStr(String(v[k] ?? ""));
    return o;
  }
  function cleanEvent(e) {
    if (!/^e\d{1,7}$/.test(String(e.id)) || !EV_KINDS.includes(e.kind)) return null;
    return {
      id: e.id,
      at: cleanStr(e.at, 40),
      by: EV_BY.includes(e.by) ? e.by : "write",
      ref: cleanStr(e.ref, 100),
      kind: e.kind,
      target: cleanStr(e.target),
      ...(typeof e.label === "string" && e.label ? { label: cleanStr(e.label) } : {}),
      before: evValue(e.before),
      after: evValue(e.after),
      why: cleanStr(e.why, 300),
      ...(/^e\d{1,7}$/.test(String(e.undoes)) ? { undoes: e.undoes } : {}),
      ...extras(e, KNOWN_EV, 500),
    };
  }
  const decSnap = (d) => ({ text: d.text, source: d.source, unverified: !!d.unverified });
  // what changed between two versions, as events without ids
  function diffEvents(a, b) {
    a = normalizeMemory(a);
    b = normalizeMemory(b);
    // each decision event carries the text the decision had (label): an undo then never acts on another decision that
    // got the same id later (from a version that keeps no history); removals are recorded too
    const out = [],
      ev = (kind, target, before, after, label) => out.push({ kind, target, before, after, label });
    const old = new Map(a.decisions.map((d) => [d.id, d])),
      now = new Set(b.decisions.map((d) => d.id));
    for (const o of a.decisions) if (!now.has(o.id)) ev("decision.remove", o.id, decSnap(o), null, o.text);
    for (const d of b.decisions) {
      const o = old.get(d.id),
        L = d.text;
      if (!o) {
        ev("decision.add", d.id, null, decSnap(d), L);
        if (d.status === "revoked") ev("decision.revoke", d.id, "active", "revoked", L);
        continue;
      }
      if (o.text !== d.text) ev("decision.edit", d.id, o.text, d.text, L);
      if (o.unverified && !d.unverified)
        ev("decision.verify", d.id, { source: o.source, unverified: true }, { source: d.source, unverified: false }, L);
      if (!o.unverified && d.unverified)
        ev("decision.unverify", d.id, { source: o.source, unverified: false }, { source: d.source, unverified: true }, L);
      if (!o.confirmed && d.confirmed) ev("decision.confirm", d.id, false, true, L);
      if (o.confirmed && !d.confirmed && o.text === d.text) ev("decision.unconfirm", d.id, true, false, L);
      if (o.status !== d.status) ev(d.status === "revoked" ? "decision.revoke" : "decision.restore", d.id, o.status, d.status, L);
    }
    for (const c of b.constraints) if (!a.constraints.includes(c)) ev("constraint.add", c, null, c);
    for (const c of a.constraints) if (!b.constraints.includes(c)) ev("constraint.remove", c, c, null);
    if (a.summary.goal !== b.summary.goal || a.summary.status !== b.summary.status)
      ev("summary", "summary", { goal: a.summary.goal, status: a.summary.status }, { goal: b.summary.goal, status: b.summary.status });
    return out;
  }
  // `after` with the history of `before` plus the events of this change (meta: {at, by, ref, why}). The base is always
  // the history of the version being replaced, so a restore of an older file keeps the full story and adds to it.
  function withHistory(before, after, meta) {
    const b = normalizeMemory(before),
      next = normalizeMemory(after);
    if (meta && meta.keepHistory) return next; // a whole file brought back from a backup keeps the story it had
    const evs = diffEvents(b, next);
    let n = Math.max(0, ...b.history.map((e) => +e.id.slice(1)));
    const mt = meta || {};
    next.history = b.history
      .concat(
        evs.map((e) =>
          cleanEvent({
            id: "e" + ++n,
            at: mt.at || "",
            by: mt.by || "write",
            ref: mt.ref || "",
            why: mt.why || "",
            undoes: mt.undoes,
            ...e,
          }),
        ),
      )
      .slice(-HISTORY_MAX);
    return next;
  }
  // undo one change: → { ok, memory } | { ok: false, error }. Refused when the same thing changed again since.
  function undoEvent(memory, id, date) {
    const m = normalizeMemory(JSON.parse(JSON.stringify(memory)));
    const e = m.history.find((x) => x.id === id);
    if (!e) return { ok: false, error: T`لا يوجد تغيير برقم ${id} في السجل` };
    const later = m.history
      .slice(m.history.indexOf(e) + 1)
      .find((x) => x.target === e.target && x.kind !== "decision.confirm" && x.kind !== "decision.unconfirm");
    if (later) return { ok: false, error: T`تغيّر هذا مرة أخرى بعده (${later.id})؛ تراجع عن ذلك أولاً` };
    const stale = () => ({ ok: false, error: T("تغيّرت القيمة منذ ذلك الحين؛ لم أتراجع عنها") });
    if (e.kind === "decision.remove") {
      // a removed decision comes back as it was — under its id, or a new one if that id is taken now
      if (!e.before || !e.before.text) return stale();
      const taken = m.decisions.some((x) => x.id === e.target);
      const id = taken ? "d" + (1 + Math.max(0, ...m.decisions.map((x) => +x.id.slice(1) || 0))) : e.target;
      m.decisions.push({
        id,
        text: e.before.text,
        source: e.before.source || "assistant",
        status: "active",
        unverified: !!e.before.unverified,
        date: date || "",
      });
      return { ok: true, memory: normalizeMemory(m), event: e };
    }
    const d = e.kind.startsWith("decision.") ? m.decisions.find((x) => x.id === e.target) : null;
    if (e.kind.startsWith("decision.") && !d) return { ok: false, error: T`القرار ${e.target} لم يعد في الذاكرة` };
    // the same id may now hold another decision (written by a version that keeps no history): its text tells
    const textThen = e.kind === "decision.edit" ? e.after : e.label;
    if (d && typeof textThen === "string" && textThen && d.text !== textThen) return stale();
    switch (e.kind) {
      case "decision.add":
        if (d.status !== "active") return stale();
        d.status = "revoked";
        d.revokedOn = date || "";
        break;
      case "decision.revoke":
        if (d.status !== "revoked") return stale();
        d.status = "active";
        d.revokedOn = "";
        break;
      case "decision.restore":
        if (d.status !== "active") return stale();
        d.status = "revoked";
        d.revokedOn = date || "";
        break;
      case "decision.edit":
        if (d.text !== e.after) return stale();
        d.text = e.before;
        delete d.confirmed;
        break;
      case "decision.verify":
        if (d.unverified || !e.before || !e.after || d.source !== e.after.source) return stale();
        Object.assign(d, { unverified: true, claimed: d.source === "assistant" ? "user" : d.source, source: "assistant" });
        delete d.confirmed;
        break;
      case "decision.unverify":
        if (!d.unverified || !e.before) return stale();
        d.source = e.before.source;
        d.unverified = false;
        delete d.claimed;
        delete d.pendingReplaces;
        break;
      case "decision.confirm":
        if (!d.confirmed) return stale();
        delete d.confirmed;
        break;
      case "decision.unconfirm":
        if (d.confirmed || d.unverified) return stale();
        d.confirmed = true;
        break;
      case "constraint.add":
        if (!m.constraints.includes(e.target)) return stale();
        m.constraints = m.constraints.filter((c) => c !== e.target);
        break;
      case "constraint.remove":
        if (m.constraints.includes(e.target)) return stale();
        m.constraints.push(e.target);
        break;
      case "summary":
        if (!e.before || !e.after || m.summary.goal !== e.after.goal || m.summary.status !== e.after.status) return stale();
        m.summary.goal = e.before.goal;
        m.summary.status = e.before.status;
        break;
      default:
        return { ok: false, error: T("لا يمكن التراجع عن هذا النوع") };
    }
    return { ok: true, memory: normalizeMemory(m), event: e };
  }
  // one line per event, for people: "e12 · 2026-10-26 10:05 · decision d3 cancelled — summary of messages 6–10"
  function describeEvent(e) {
    const q = (t) => (LANG === "en" ? `“${t}”` : `«${t}»`);
    const short = (t) => cut(String(t || ""), 80);
    const L = () => (e.label ? q(short(e.label)) : e.target); // the decision's words, not its internal id
    const what = {
      "decision.add": () =>
        e.after && e.after.unverified
          ? T`سُجّل ليُعرض عليك (لم يُعتمد بعد): ${q(short(e.after.text))}`
          : e.after && e.after.source === "assistant"
            ? T`أُضيف اقتراح: ${q(short(e.after.text))}`
            : T`أُضيف قرار: ${q(short(e.after && e.after.text))}`,
      "decision.revoke": () => T`أُلغي قرار: ${L()}`,
      "decision.restore": () => T`أُعيد قرار سارياً: ${L()}`,
      "decision.edit": () => T`عُدّل قرار: ${q(short(e.before))} ← ${q(short(e.after))}`,
      "decision.verify": () => T`اعتُمد قراراً لك: ${L()}`,
      "decision.unverify": () => T`أُعيد اقتراحاً ينتظر مراجعتك: ${L()}`,
      "decision.confirm": () => T`أكّدتَ قراراً: ${L()}`,
      "decision.unconfirm": () => T`أُزيل تأكيد قرار: ${L()}`,
      "decision.remove": () => T`حُذف قرار: ${q(short(e.before && e.before.text))}`,
      "constraint.add": () => T`أُضيف قيد: ${q(short(e.target))}`,
      "constraint.remove": () => T`حُذف قيد: ${q(short(e.target))}`,
      summary: () => T("أُعيدت كتابة الخلاصة"),
    }[e.kind];
    return { id: e.id, at: e.at, by: e.by, what: what ? what() : e.kind, why: e.why, undoes: e.undoes || "" };
  }
  function applyFix(memory, fix, date) {
    const m = normalizeMemory(JSON.parse(JSON.stringify(memory)));
    const changes = [],
      missing = [];
    let redacted = false;
    const R = (t) => {
      const r = redact(t);
      if (r.changed) redacted = true;
      return r.text;
    };
    const find = (id) => {
      const d = m.decisions.find((x) => x.id === id);
      if (!d) missing.push(id);
      return d;
    };
    if (fix.decisions) {
      // a corrected text is no longer what was confirmed: confirming it again is a separate, explicit approval
      for (const e of fix.decisions.edit) {
        const d = find(e.id);
        if (d && d.text !== R(e.text)) {
          d.text = R(e.text);
          delete d.confirmed;
          changes.push(T`عُدّل نص ${d.id}`);
        }
      }
      for (const id of fix.decisions.approve) {
        const d = find(id);
        if (!d || d.status !== "active") continue;
        // a flagged decision, approved: it is what the model said it was, and it replaces what it was meant to replace
        if (d.unverified) {
          answerReview(m, id, true, date, changes, missing);
          continue;
        }
        if (d.source === "assistant") d.source = "assistant-approved";
        if (!d.confirmed) {
          d.confirmed = true;
          changes.push(T`أكّدتَ ${id}`);
        }
      }
      for (const id of fix.decisions.revoke) {
        const d = find(id);
        if (d && d.status === "active") {
          d.status = "revoked";
          d.revokedOn = date || "";
          delete d.pendingRevoke;
          changes.push(T`أُلغي ${id}`);
        }
      }
      for (const id of fix.decisions.remove) {
        const before = m.decisions.length;
        m.decisions = m.decisions.filter((x) => x.id !== id);
        if (m.decisions.length < before) changes.push(T`حُذف ${id} نهائياً`);
        else missing.push(id);
      }
    }
    if (fix.constraints) {
      const rm = new Set(fix.constraints.remove),
        had = m.constraints.length,
        P = m.pending.constraints;
      m.constraints = m.constraints.filter((c) => !rm.has(c));
      if (m.constraints.length < had) changes.push(T`حُذف ${had - m.constraints.length} من القيود`);
      for (const c of fix.constraints.add.map(R))
        if (!m.constraints.includes(c)) {
          m.constraints.push(c);
          changes.push(T("أُضيف قيد"));
        }
      // what you settled yourself no longer waits for you
      P.add = P.add.filter((x) => !m.constraints.includes(x.text) && !rm.has(x.text));
      P.remove = P.remove.filter((x) => m.constraints.includes(x.text) && !fix.constraints.add.includes(x.text));
    }
    if (fix.pending) {
      for (const k of fix.pending.approve) answerReview(m, k, true, date, changes, missing);
      for (const k of fix.pending.reject) answerReview(m, k, false, date, changes, missing);
    }
    if (fix.summary) {
      m.summary = {
        ...extras(m.summary, KNOWN_SUM, 8000),
        goal: R(fix.summary.goal),
        status: R(fix.summary.status),
        next: fix.summary.next.map(R),
        open: fix.summary.open.map(R),
      };
      changes.push(T("استُبدلت الخلاصة الحالية"));
    }
    if (fix.log)
      for (const id of fix.log.remove) {
        const before = m.log.length;
        m.log = m.log.filter((e) => e.id !== id);
        if (m.log.length < before) changes.push(T`حُذفت دفعة من السجل (${id})`);
        else missing.push(id);
      }
    if (changes.length) m.updated = date || m.updated;
    return { memory: normalizeMemory(m), changes, missing: [...new Set(missing)], redacted };
  }

  // ---------- sharing: chosen parts of the memory as text for another conversation ----------
  // sel: { summary: bool, decisions: [ids], constraints: bool, pins: [names], log: [ids] } → text, cut at `budget` characters
  // opts.pinTexts {name: text}: pinned texts inserted verbatim (a chat site cannot open the pin's file, Claude Code can);
  // opts.plain: no markdown markers (a message typed into a chat box shows them as they are)
  function renderSelection(m, sel, budget = 3000, opts = {}) {
    return inLang(m.lang, () => renderSelection0(m, sel, budget, opts));
  }
  function renderSelection0(m, sel, budget, opts) {
    const parts = [],
      P = (t) => (opts.plain ? t.replace(/\*\*/g, "").replace(/^#{1,6} +/gm, "") : t); // pinned texts stay verbatim
    if (sel.summary) parts.push(P(T("الخلاصة الحالية:\n") + renderSummary(m)));
    const ds = m.decisions.filter((d) => d.status === "active" && (sel.decisions || []).includes(d.id));
    if (ds.length) parts.push(P(T("قرارات:\n") + ds.map((d) => `- ${d.text} (${T(SOURCE_LABEL[d.source])})`).join("\n")));
    if (sel.constraints && m.constraints.length) parts.push(P(T("القيود:\n") + bullets(m.constraints)));
    const ps = m.pins.filter((p) => (sel.pins || []).includes(p.name));
    const texts = opts.pinTexts || {};
    for (const p of ps.filter((x) => typeof texts[x.name] === "string"))
      parts.push(T`نص معتمد «${p.name}» (النسخة ${p.version}، انقله حرفياً):\n${texts[p.name]}`);
    const refs = ps.filter((x) => typeof texts[x.name] !== "string");
    if (refs.length)
      parts.push(T("نصوص معتمدة (النص الحرفي في ملفه):\n") + refs.map((p) => T`- ${p.name} — النسخة ${p.version}، ${p.path}`).join("\n"));
    const es = m.log.filter((e) => (sel.log || []).includes(e.id));
    if (es.length) parts.push(P(T("من سجل النقاش:\n") + es.map(renderEntry).join("\n\n")));
    let out = parts.join("\n\n");
    if (out.length > budget) out = cut(out, budget) + T("\n…(اقتُطع عند ") + budget + T(" حرف)");
    return out;
  }

  // ---------- line diff (for comparing versions of a pinned text) ----------
  // → [{op: " " | "-" | "+", line}] ; LCS on lines, capped so huge texts stay fast (beyond the cap: whole-text replace)
  function diffLines(a, b) {
    const A = String(a).split("\n"),
      B = String(b).split("\n");
    // common start and end first: a typical revision touches a few lines in the middle
    let p = 0;
    while (p < A.length && p < B.length && A[p] === B[p]) p++;
    let q = 0;
    while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
    const head = A.slice(0, p).map((line) => ({ op: " ", line })),
      tail = A.slice(A.length - q).map((line) => ({ op: " ", line }));
    const X = A.slice(p, A.length - q),
      Y = B.slice(p, B.length - q);
    if (X.length * Y.length > 4e6)
      return [...head, ...X.map((line) => ({ op: "-", line })), ...Y.map((line) => ({ op: "+", line })), ...tail];
    const n = X.length,
      k = Y.length,
      L = Array.from({ length: n + 1 }, () => new Uint32Array(k + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = k - 1; j >= 0; j--) L[i][j] = X[i] === Y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const mid = [];
    let i = 0,
      j = 0;
    while (i < n && j < k) {
      if (X[i] === Y[j]) {
        mid.push({ op: " ", line: X[i] });
        i++;
        j++;
      } else if (L[i + 1][j] >= L[i][j + 1]) mid.push({ op: "-", line: X[i++] });
      else mid.push({ op: "+", line: Y[j++] });
    }
    while (i < n) mid.push({ op: "-", line: X[i++] });
    while (j < k) mid.push({ op: "+", line: Y[j++] });
    return [...head, ...mid, ...tail];
  }

  // ---------- pins ----------
  const slug0 = (n) =>
    String(n || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
      .replace(/\[\s*conversation-memory\s*\]/gi, " ")
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+|[.\s]+$/g, "");
  const slug = (n) => cut(slug0(wellFormed(n || "")), 60).replace(/[.\s]+$/g, "");
  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
  const pinNameOk = (n) => {
    const s = slug(n);
    return !!s && s === String(n).trim().replace(/\s+/g, " ") && !WINDOWS_RESERVED.test(s);
  };
  const pinPath = (name, version) => `CONVERSATION_PINS/${name}/v${version}.md`;
  function upsertPin(m, pin) {
    const out = normalizeMemory(JSON.parse(JSON.stringify(m)));
    out.pins = out.pins.filter((p) => p.name !== pin.name);
    out.pins.push(pin);
    out.pins.sort((a, b) => (a.name < b.name ? -1 : 1));
    return normalizeMemory(out);
  }

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
      if (spans.size > 1)
        return { ok: false, error: T`في رسالة واحدة أكثر من نص يطابق البداية والنهاية (${spans.size}). اختر بداية ونهاية أدق` };
    }
    return { ok: false, error: T("لم أجد نصاً في المحادثة يبدأ وينتهي بما كُتب. انسخ البداية والنهاية حرفياً") };
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
  const utf8Len = (s) => {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? (i++, 4) : 3;
    }
    return n;
  };
  // A writer from before 2.0 (the extension 1.4) keeps only the fields it knew, so writing over a newer file it drops
  // the marks added since: a suggested cancellation waiting for you, your approval mark, the message number, waiting
  // constraint changes, the memory's language, and anything a later version added. What it drops is never a decision
  // or a constraint, and never turns a suggestion into yours (tests/compat14.test.js) — but it should not stay lost.
  // Before writing over such a file, a newer writer brings back from the last version it saved what still applies.
  // A file written by 2.0 always has "lang"; one without it whose backup has it was rewritten by an older writer.
  const droppedByOlder = (jsonText) => typeof jsonText === "string" && jsonText.trim() !== "" && !/"lang"\s*:/.test(jsonText);
  function recoverDropped(memory, previous) {
    const m = normalizeMemory(JSON.parse(JSON.stringify(memory))),
      p = normalizeMemory(previous);
    let n = 0;
    if (m.lang !== p.lang) (m.lang = p.lang), n++;
    if (p.history.length && !m.history.length) (m.history = p.history), n++;
    for (const k of Object.keys(p)) if (!KNOWN_TOP.has(k) && !(k in m)) (m[k] = p[k]), n++;
    for (const d of m.decisions) {
      const o = p.decisions.find((x) => x.id === d.id && x.text === d.text);
      if (!o) continue;
      if (o.msg && !d.msg) (d.msg = o.msg), n++;
      if (o.confirmed && !d.confirmed && !d.unverified && d.status === "active") (d.confirmed = true), n++;
      if (o.pendingRevoke && !d.pendingRevoke && d.status === "active") (d.pendingRevoke = o.pendingRevoke), n++;
      if (o.batch && !d.batch) (d.batch = o.batch), n++;
      if (o.recheck && !d.recheck && d.status === "active" && !d.unverified) (d.recheck = o.recheck), n++;
      for (const k of Object.keys(o)) if (!KNOWN_DEC.has(k) && !(k in d)) (d[k] = o[k]), n++;
    }
    const P = m.pending.constraints,
      has = (l, x) => l.some((y) => y.text === x.text);
    for (const x of p.pending.constraints.add) if (!m.constraints.includes(x.text) && !has(P.add, x)) P.add.push(x), n++;
    for (const x of p.pending.constraints.remove) if (m.constraints.includes(x.text) && !has(P.remove, x)) P.remove.push(x), n++;
    return { memory: normalizeMemory(m), restored: n };
  }
  function trimForSize(memory, maxBytes) {
    const m = normalizeMemory(JSON.parse(JSON.stringify(memory)));
    const archived = [];
    while (utf8Len(serialize(m)) > maxBytes && m.log.length > 20) {
      const k = Math.max(1, Math.floor(m.log.length / 10));
      archived.push(...m.log.splice(0, k));
    }
    if (utf8Len(serialize(m)) > maxBytes && m.imported) {
      archived.push({ id: "imported-v0", imported: m.imported });
      m.imported = null;
    }
    // then the oldest history events go to the archive too (they can no longer be undone from the panel, but stay readable)
    while (utf8Len(serialize(m)) > maxBytes && m.history.length > 50) {
      const k = Math.max(1, Math.floor(m.history.length / 10));
      archived.push({ id: "history", events: m.history.splice(0, k) });
    }
    m.archived += archived.filter((x) => x.id !== "history").length;
    return { memory: m, archived, fits: utf8Len(serialize(m)) <= maxBytes };
  }

  // a text from a v0.x Markdown file, kept read-only when migrating
  function importLegacy(m, mdText, date) {
    const out = normalizeMemory(JSON.parse(JSON.stringify(m)));
    out.imported = { date: date || "", text: cut(wellFormed(mdText), LIMITS.imported) };
    return out;
  }

  return {
    FORMAT,
    LIMITS,
    PLATFORMS,
    START,
    END,
    emptyMemory,
    normalizeMemory,
    parseMemory,
    serialize,
    token,
    hash,
    validateDraft,
    applyDraft,
    parseModelReply,
    render,
    renderCompact,
    redact,
    hasSecret,
    cleanStr,
    slug,
    pinNameOk,
    pinPath,
    upsertPin,
    extractVerbatim,
    importLegacy,
    trimForSize,
    estTokens,
    isGeneratedView,
    validateFix,
    applyFix,
    renderSelection,
    diffLines,
    count,
    W,
    PROTOCOL,
    evNorm,
    numbersIn,
    QUOTE_MAX,
    reviewItems,
    isReviewKey,
    negated,
    meaningGap,
    T,
    setLang,
    lang,
    droppedByOlder,
    recoverDropped,
    diffEvents,
    withHistory,
    undoEvent,
    describeEvent,
    recheckDecisions,
    relevant,
    splitShared,
  };
});

// The conversation from the site's own data, for when its page can't be read (the site changed its design).
// Each site loads a chat from its own server as structured JSON; that structure changes far less often than the page.
// Asked from the site itself, with your session, like the page does — nothing goes anywhere else, nothing is kept:
// ChatGPT's session token lives in this script's memory only, for a few minutes.
// Only the branch you see (the current one) is returned, in order, as [{ role: "user" | "assistant", text }].
(function (root) {
  "use strict";
  const TTL = 10000, TOKEN_TTL = 5 * 60000, TIMEOUT = 8000;
  async function getJson(url, headers) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const r = await fetch(url, { credentials: "include", headers: { accept: "application/json", ...(headers || {}) }, signal: ctl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  const str = (v) => (typeof v === "string" ? v : "");
  // a reply split into several pieces (tools, steps) reads as one, as on the page. A message of yours with no text (an image,
  // a file) is still a message: kept, so messages are numbered exactly as on the page
  const merge = (out, role, text) => {
    if (!text && role !== "user") return;
    const last = out[out.length - 1];
    if (role === "assistant" && last && last.role === "assistant") last.text += "\n" + text; else out.push({ role, text });
  };

  // ---------- ChatGPT: GET /backend-api/conversation/<id>, a tree (mapping) whose visible branch ends at current_node ----------
  let token = { v: "", at: 0 };
  async function chatgptToken() {
    if (token.v && Date.now() - token.at < TOKEN_TTL) return token.v;
    const s = await getJson("/api/auth/session");
    token = { v: str(s && s.accessToken), at: Date.now() };
    return token.v;
  }
  function chatgptTurns(j) {
    const map = j && j.mapping;
    let id = j && j.current_node;
    if (!map || typeof map !== "object" || typeof id !== "string") return null;
    const path = [], seen = new Set();
    while (id && map[id] && !seen.has(id) && path.length < 20000) { seen.add(id); path.unshift(map[id]); id = map[id].parent; }
    const out = [];
    for (const node of path) {
      const m = node && node.message; if (!m || !m.author) continue;
      const role = m.author.role; if (role !== "user" && role !== "assistant") continue;
      const md = m.metadata || {};
      if (md.is_visually_hidden_from_conversation || md.is_user_system_message) continue;
      if (role === "assistant" && m.recipient && m.recipient !== "all") continue;   // a tool call, not a reply you read
      const c = m.content || {};
      if (c.content_type && c.content_type !== "text" && c.content_type !== "multimodal_text") continue;   // reasoning, code runs…
      const parts = Array.isArray(c.parts) ? c.parts : [];
      merge(out, role, parts.map((p) => (typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n").trim());
    }
    return out;
  }
  async function chatgpt(id) {
    const auth = await chatgptToken();
    const j = await getJson(`/backend-api/conversation/${encodeURIComponent(id)}`, auth ? { authorization: "Bearer " + auth } : {});
    return chatgptTurns(j);
  }

  // ---------- claude.ai: GET /api/organizations/<org>/chat_conversations/<id>; the visible branch ends at current_leaf_message_uuid ----------
  let orgs = { v: [], at: 0 };
  async function claudeOrgs() {
    const c = (document.cookie.match(/(?:^|;\s*)lastActiveOrg=([0-9a-f-]{8,64})/i) || [])[1];
    if (c) return [c];
    if (orgs.v.length && Date.now() - orgs.at < TOKEN_TTL) return orgs.v;
    const l = await getJson("/api/organizations");
    orgs = { v: (Array.isArray(l) ? l : []).map((o) => str(o && o.uuid)).filter((u) => /^[0-9a-f-]{8,64}$/i.test(u)).slice(0, 5), at: Date.now() };
    return orgs.v;
  }
  function claudeText(m) {
    if (Array.isArray(m.content) && m.content.length) return m.content.filter((b) => b && b.type === "text").map((b) => str(b.text)).join("\n").trim();
    return str(m.text).trim();
  }
  function claudeTurns(j) {
    const msgs = j && Array.isArray(j.chat_messages) ? j.chat_messages.filter((m) => m && typeof m === "object") : null;
    if (!msgs) return null;
    let list;
    const by = new Map(msgs.map((m) => [m.uuid, m]));
    if (typeof j.current_leaf_message_uuid === "string" && by.has(j.current_leaf_message_uuid)) {
      list = []; const seen = new Set();
      for (let m = by.get(j.current_leaf_message_uuid); m && !seen.has(m.uuid); m = by.get(m.parent_message_uuid)) { seen.add(m.uuid); list.unshift(m); }
    } else list = msgs.slice().sort((a, b) => (+a.index || 0) - (+b.index || 0));   // no tree: the order the site gives
    const out = [];
    for (const m of list) { const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : ""; if (role) merge(out, role, claudeText(m)); }
    return out;
  }
  async function claude(id) {
    let last = null;
    for (const org of await claudeOrgs()) {   // the chat belongs to one of your organizations; the first that has it answers
      try { return claudeTurns(await getJson(`/api/organizations/${org}/chat_conversations/${encodeURIComponent(id)}?tree=True&rendering_mode=messages&render_all_tools=true`)); }
      catch (e) { last = e; }
    }
    if (last) throw last;
    return null;
  }

  // → { turns } or { error }; answers are kept TTL ms per chat, so the page's 3-second loop asks the site rarely
  const cache = new Map();
  async function read(platform, id, ttl = TTL) {
    if (!/^[\w-]{6,80}$/.test(String(id || ""))) return { error: "bad-id" };
    const k = platform + ":" + id, c = cache.get(k);
    if (c && Date.now() - c.at < (c.v.turns ? ttl : Math.max(ttl, 60000))) return c.v;   // a failure is asked again once a minute
    let v;
    try {
      const turns = platform === "chatgpt" ? await chatgpt(id) : platform === "claude-web" ? await claude(id) : null;
      v = turns && turns.length ? { turns } : { error: turns ? "empty" : "shape" };   // "shape": the data changed too
    } catch (e) { v = { error: String((e && e.message) || e).slice(0, 80) }; }
    cache.set(k, { at: Date.now(), v });
    return v;
  }

  (root.CM = root.CM || {}).sitedata = { read, chatgptTurns, claudeTurns };
})(self);

// Routes page requests to the offscreen writer, serializes "who sends the summary request" between tabs,
// and owns the "pin selected text" menu.
"use strict";
importScripts("i18n-en.js", "memory-core.js"); // the interface's language (T) for the few messages written here
const T = self.MemoryCore.T;
const OFFSCREEN = "src/offscreen.html";
const SITES = ["https://chatgpt.com/*", "https://chat.openai.com/*", "https://claude.ai/*"];
// Gemini is optional: turned on in the settings (the browser asks for the site), its content script registered here
const GEMINI = "https://gemini.google.com/*";
const CONTENT = [
  "src/i18n-en.js",
  "src/memory-core.js",
  "src/linking.js",
  "src/page/policy.js",
  "src/page/adapters.js",
  "src/page/reader.js",
  "src/page/sitedata.js",
  "src/page/composer.js",
  "src/page/summarizer.js",
  "src/page/bridge.js",
  "src/page/ui.js",
  "src/content.js",
];
async function syncGemini() {
  try {
    const on = await chrome.permissions.contains({ origins: [GEMINI] });
    const have = (await chrome.scripting.getRegisteredContentScripts({ ids: ["cm-gemini"] })).length > 0;
    if (on && !have)
      await chrome.scripting.registerContentScripts([{ id: "cm-gemini", matches: [GEMINI], js: CONTENT, runAt: "document_idle" }]);
    if (!on && have) await chrome.scripting.unregisterContentScripts({ ids: ["cm-gemini"] });
  } catch {}
}
chrome.permissions.onAdded.addListener(syncGemini);
chrome.permissions.onRemoved.addListener(syncGemini);
chrome.runtime.onStartup.addListener(syncGemini);
const DEFAULTS = { every: 10, mode: "auto", paused: false, autoLink: true, byok: false };

// ---------- optional: summaries in the background with the user's own API key ----------
// The key stays in the extension's local storage and goes only to the provider the user chose. Nothing passes through us.
const API = self.CM_TEST_API || {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
};
const MODELS = { anthropic: "claude-haiku-5-5", openai: "gpt-5-mini" }; // small, cheap models; the user may name another in the settings
// the key lives in the extension's own database (options.js writes it): the chat sites' content scripts can't open it
const keyGet = () =>
  new Promise((res) => {
    const r = indexedDB.open("cm", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onerror = () => res(undefined);
    r.onsuccess = () => {
      try {
        const q = r.result.transaction("kv").objectStore("kv").get("byokKey");
        q.onsuccess = () => res(q.result);
        q.onerror = () => res(undefined);
      } catch {
        res(undefined);
      }
    };
  });
async function byok(text, maxTokens) {
  const c = await keyGet();
  if (!c || !c.key || !API[c.provider]) return { ok: false, error: T("لا يوجد مفتاح محفوظ؛ أضفه من الإعدادات") };
  const model = String(c.model || MODELS[c.provider]).slice(0, 80);
  const hide = (t) =>
    String(t || "")
      .split(c.key)
      .join(T("(المفتاح)"))
      .slice(0, 200);
  const ctl = new AbortController(),
    t = setTimeout(() => ctl.abort(), 120000);
  try {
    let r, j;
    if (c.provider === "anthropic") {
      r = await fetch(API.anthropic, {
        method: "POST",
        signal: ctl.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": c.key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: text }] }),
      });
      j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: `${c.provider} ${r.status}: ${hide(j.error && j.error.message)}` };
      return {
        ok: true,
        text: (j.content || [])
          .filter((b) => b && b.type === "text")
          .map((b) => b.text)
          .join(""),
        usage: j.usage || null,
        model,
      };
    }
    r = await fetch(API.openai, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", authorization: "Bearer " + c.key },
      body: JSON.stringify({ model, max_completion_tokens: maxTokens, messages: [{ role: "user", content: text }] }),
    });
    j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: `${c.provider} ${r.status}: ${hide(j.error && j.error.message)}` };
    return {
      ok: true,
      text: String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ""),
      usage: j.usage || null,
      model,
    };
  } catch (e) {
    return {
      ok: false,
      error: /abort/i.test(String(e))
        ? T("لم يرد المزوّد خلال دقيقتين")
        : /failed to fetch|network/i.test(String(e))
          ? T("تعذّر الاتصال بالمزوّد (هل منحت الإذن من الإعدادات؟)")
          : hide(e && e.message),
    };
  } finally {
    clearTimeout(t);
  }
}

let creating = null;
async function ensureOffscreen() {
  const have = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL(OFFSCREEN)] });
  if (have.length) return;
  creating =
    creating ||
    chrome.offscreen
      .createDocument({
        url: OFFSCREEN,
        reasons: ["BLOBS"],
        justification:
          "Read and write the conversation memory: in the extension's private origin storage, or in a project folder the user linked (file handles and file writes are done here, then the result is returned to the page).",
      })
      .catch((e) => {
        if (!/single offscreen/i.test(String(e))) throw e;
      })
      .finally(() => {
        creating = null;
      });
  await creating;
}
// a writer just created may not be listening yet ("Receiving end does not exist"): ask again for up to ~2 s
async function toOffscreen(op, args) {
  // the writer answers in the asker's language; a caller that didn't say gets the one chosen in the settings
  if (!args || !args.lang) {
    const { settings = {} } = await chrome.storage.local.get("settings").catch(() => ({}));
    args = { ...(args || {}), lang: settings.lang || chrome.i18n.getUILanguage() };
  }
  for (let i = 0; ; i++) {
    await ensureOffscreen();
    try {
      return await chrome.runtime.sendMessage({ target: "offscreen", op, args });
    } catch (e) {
      if (i >= 20 || !/receiving end does not exist|could not establish connection/i.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

// one tab at a time may send the summary request for a given chat (two tabs open on the same chat)
let chain = Promise.resolve();
function claim(key, tab, ttl) {
  const run = async () => {
    const k = "claim:" + key,
      c = (await chrome.storage.session.get(k))[k];
    if (c && c.tab !== tab && Date.now() - c.at < ttl) return { ok: false };
    await chrome.storage.session.set({ [k]: { tab, at: Date.now() } });
    return { ok: true };
  };
  chain = chain.then(run, run);
  return chain;
}

const REPORT_URL = "https://github.com/raednov101/conversation-memory/issues/new?";

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.target === "offscreen") return;
  if (msg.cmd === "fs") {
    // a page of the extension may do anything; a chat site may only touch its own site's memory, and never the full copy
    const own = sender.url && sender.url.startsWith(chrome.runtime.getURL(""));
    if (!own) {
      const host = (() => {
        try {
          return new URL(sender.url).hostname;
        } catch {
          return "";
        }
      })();
      const site =
        host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com"
          ? "chatgpt"
          : host === "claude.ai" || host.endsWith(".claude.ai")
            ? "claude"
            : host === "gemini.google.com"
              ? "gemini"
              : self.CM_TEST_HOSTS
                ? "*"
                : "";
      const scope = String((msg.args && msg.args.scope) || "");
      if (
        !site ||
        ["exportAll", "importAll", "listScopes"].includes(msg.op) ||
        !/^[a-z0-9-]{1,80}$/.test(scope) ||
        (site !== "*" && !scope.startsWith(site + "-"))
      ) {
        reply({ ok: false, error: "not allowed" });
        return;
      }
      // the list of memories to bring into a new chat: this site's only, whatever the page asks
      if (msg.op === "listSiteScopes") msg.args = { ...msg.args, site };
    }
    toOffscreen(msg.op, msg.args).then(
      (r) => reply(r || { ok: false, error: "no reply" }),
      (e) => reply({ ok: false, error: String((e && e.message) || e) }),
    );
    return true;
  }
  if (msg.cmd === "byok") {
    byok(String(msg.text || "").slice(0, 400000), msg.test ? 20 : 8000).then(reply, (e) =>
      reply({ ok: false, error: String((e && e.message) || e) }),
    );
    return true;
  }
  if (msg.cmd === "claim") {
    claim(String(msg.key), sender.tab ? sender.tab.id : -1, Math.min(600000, +msg.ttl || 200000)).then(reply, () => reply({ ok: false }));
    return true;
  }
  if (msg.cmd === "openOptions") {
    chrome.runtime.openOptionsPage();
    reply({ ok: true });
    return;
  }
  // «أبلغ»: only the project's own new-issue page, with a technical report the user sees before sending anything
  if (msg.cmd === "openReport") {
    const u = String(msg.url || "");
    if (u.startsWith(REPORT_URL)) chrome.tabs.create({ url: u });
    reply({ ok: true });
    return;
  }
});

// housekeeping once per browser start: empty folders of chats that never got a memory (inside the browser only)
chrome.runtime.onStartup.addListener(() => toOffscreen("sweepEmpty", {}).catch(() => {}));
chrome.runtime.onInstalled.addListener(syncGemini);
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") chrome.runtime.openOptionsPage();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "cm-pin",
      title: T("📌 ثبّت النص المحدد في ذاكرة المشروع"),
      contexts: ["selection"],
      documentUrlPatterns: [...SITES, GEMINI, ...(self.CM_TEST_HOSTS || [])],
    });
  });
  const s = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...DEFAULTS, ...(s.settings || {}) } });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "cm-pin" && tab && tab.id) chrome.tabs.sendMessage(tab.id, { cmd: "pinSelection" }).catch(() => {});
});

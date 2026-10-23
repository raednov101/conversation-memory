// Routes page requests to the offscreen writer, serializes "who sends the summary request" between tabs,
// and owns the "pin selected text" menu.
"use strict";
const OFFSCREEN = "src/offscreen.html";
const SITES = ["https://chatgpt.com/*", "https://chat.openai.com/*", "https://claude.ai/*"];
const DEFAULTS = { every: 5, mode: "auto", paused: false, autoLink: true };

let creating = null;
async function ensureOffscreen() {
  const have = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL(OFFSCREEN)] });
  if (have.length) return;
  creating = creating || chrome.offscreen.createDocument({ url: OFFSCREEN, reasons: ["BLOBS"], justification: "Read and write the conversation memory: in the extension's private origin storage, or in a project folder the user linked (file handles and file writes are done here, then the result is returned to the page)." })
    .catch((e) => { if (!/single offscreen/i.test(String(e))) throw e; })
    .finally(() => { creating = null; });
  await creating;
}
async function toOffscreen(op, args) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", op, args });
}

// one tab at a time may send the summary request for a given chat (two tabs open on the same chat)
let chain = Promise.resolve();
function claim(key, tab, ttl) {
  const run = async () => {
    const k = "claim:" + key, c = (await chrome.storage.session.get(k))[k];
    if (c && c.tab !== tab && Date.now() - c.at < ttl) return { ok: false };
    await chrome.storage.session.set({ [k]: { tab, at: Date.now() } });
    return { ok: true };
  };
  chain = chain.then(run, run);
  return chain;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.target === "offscreen") return;
  if (msg.cmd === "fs") {
    // a page of the extension may do anything; a chat site may only touch its own site's memory, and never the full copy
    const own = sender.url && sender.url.startsWith(chrome.runtime.getURL(""));
    if (!own) {
      const host = (() => { try { return new URL(sender.url).hostname; } catch { return ""; } })();
      const site = host === "chatgpt.com" || host.endsWith(".chatgpt.com") ? "chatgpt" : host === "claude.ai" || host.endsWith(".claude.ai") ? "claude" : (self.CM_TEST_HOSTS ? "*" : "");
      const scope = String((msg.args && msg.args.scope) || "");
      if (!site || ["exportAll", "importAll", "listScopes"].includes(msg.op) || (site !== "*" && !scope.startsWith(site + "-"))) { reply({ ok: false, error: "not allowed" }); return; }
    }
    toOffscreen(msg.op, msg.args).then((r) => reply(r || { ok: false, error: "no reply" }), (e) => reply({ ok: false, error: String((e && e.message) || e) })); return true;
  }
  if (msg.cmd === "claim") { claim(String(msg.key), sender.tab ? sender.tab.id : -1, Math.min(600000, +msg.ttl || 200000)).then(reply, () => reply({ ok: false })); return true; }
  if (msg.cmd === "openOptions") { chrome.runtime.openOptionsPage(); reply({ ok: true }); return; }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") chrome.runtime.openOptionsPage();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "cm-pin", title: "📌 ثبّت النص المحدد في ذاكرة المشروع", contexts: ["selection"], documentUrlPatterns: [...SITES, ...(self.CM_TEST_HOSTS || [])] });
  });
  const s = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...DEFAULTS, ...(s.settings || {}) } });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "cm-pin" && tab && tab.id) chrome.tabs.sendMessage(tab.id, { cmd: "pinSelection" }).catch(() => {});
});

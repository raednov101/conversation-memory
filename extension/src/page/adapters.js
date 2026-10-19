// Reading the page: which site this is and where its messages, composer and buttons are. The only file that knows the sites' DOM.
(function (root) {
  "use strict";
  // the first selector that matches, in priority order (querySelector on a list would return the first in page order)
  const pick = (sels) => { for (const s of sels) { const e = document.querySelector(s); if (e) return e; } return null; };
  // outermost matches only, in document order
  const inOrder = (els) => els.filter((e, i) => !els.some((o, j) => j !== i && o.contains(e)))
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

  function detect() {
    const h = location.hostname;
    if (h === "chatgpt.com" || h === "chat.openai.com") return "chatgpt";
    if (h === "claude.ai") return "claude";
    const t = document.documentElement.dataset.cmTestPlatform;   // local test pages only; the real manifest never runs there
    return (h === "127.0.0.1" || h === "localhost") && (t === "chatgpt" || t === "claude") ? t : null;
  }

  const ADAPTERS = {
    chatgpt: {
      name: "ChatGPT", platform: "chatgpt",
      chatId: () => (location.pathname.match(/\/c\/([\w-]+)/) || [])[1],
      messages: () => inOrder([...document.querySelectorAll("[data-message-author-role]")])
        .map((el) => ({ role: el.getAttribute("data-message-author-role"), el })).filter((m) => m.role === "user" || m.role === "assistant"),
      generating: () => !!pick(['[data-testid="stop-button"]', 'button[aria-label*="Stop" i]', 'button[aria-label*="إيقاف"]']),
      composer: () => pick(["#prompt-textarea", "div.ProseMirror[contenteditable='true']", "form textarea"]),
      sendButton: () => pick(['[data-testid="send-button"]', 'button[aria-label*="Send" i]', 'button[aria-label*="إرسال"]']),
      title: () => document.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, "").replace(/^ChatGPT$/i, "").trim(),
    },
    claude: {
      name: "Claude", platform: "claude-web",
      chatId: () => (location.pathname.match(/\/chat\/([\w-]+)/) || [])[1],
      messages: () => {
        const u = [...document.querySelectorAll('[data-testid="user-message"]')];
        const a = [...document.querySelectorAll("[data-is-streaming], .font-claude-response")];
        const role = new Map(); u.forEach((e) => role.set(e, "user")); a.forEach((e) => { if (!role.has(e)) role.set(e, "assistant"); });
        return inOrder([...role.keys()]).map((el) => ({ role: role.get(el), el }));
      },
      generating: () => !!pick(['[data-is-streaming="true"]', 'button[aria-label*="Stop" i]', 'button[aria-label*="إيقاف"]']),
      composer: () => pick(["div.ProseMirror[contenteditable='true']", "[contenteditable='true'][role='textbox']", "fieldset textarea"]),
      sendButton: () => pick(['button[aria-label*="Send" i]', 'button[aria-label*="إرسال"]']),
      title: () => document.title.replace(/\s*[-|]\s*Claude\s*$/i, "").replace(/^Claude$/i, "").trim(),
    },
  };

  (root.CM = root.CM || {}).adapters = { detect, get: (p) => ADAPTERS[p] || null };
})(self);

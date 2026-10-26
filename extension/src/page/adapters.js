// Reading the page: which site this is and where its messages, composer and buttons are. The only file that knows the sites' DOM.
(function (root) {
  "use strict";
  // the first selector that matches, in priority order (querySelector on a list would return the first in page order)
  const pick = (sels) => {
    for (const s of sels) {
      const e = document.querySelector(s);
      if (e) return e;
    }
    return null;
  };
  // outermost matches only, in document order
  const inOrder = (els) =>
    els
      .filter((e, i) => !els.some((o, j) => j !== i && o.contains(e)))
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

  // the text of a message without what screen readers or the toolbar add ("قال ChatGPT:", "Claude responded:", "just now"):
  // those change over time and would look like an edited message
  const SKIP = ".sr-only, time, button, [data-cds='RelativeTime'], [aria-hidden='true']";
  const visible = (el) => el.innerText || el.textContent || "";
  function cleanText(el) {
    if (!el.querySelector(SKIP)) return visible(el);
    const parts = [];
    (function walk(e) {
      for (const c of e.children) {
        if (c.matches(SKIP)) continue;
        if (c.querySelector(SKIP)) walk(c);
        else parts.push(visible(c));
      }
    })(el);
    return parts.filter((t) => t.trim()).join("\n");
  }
  // all outermost matches of the first selector that finds any inside el, joined; else the cleaned text of el
  function partsText(el, sels) {
    for (const s of sels) {
      const f = [...el.querySelectorAll(s)];
      if (f.length) return inOrder(f).map(visible).join("\n");
    }
    return cleanText(el);
  }

  function detect() {
    const h = location.hostname;
    if (h === "chatgpt.com" || h === "chat.openai.com") return "chatgpt";
    if (h === "claude.ai") return "claude";
    if (h === "gemini.google.com") return "gemini";
    const t = document.documentElement.dataset.cmTestPlatform; // local test pages only; the real manifest never runs there
    return (h === "127.0.0.1" || h === "localhost") && (t === "chatgpt" || t === "claude" || t === "gemini") ? t : null;
  }

  const ADAPTERS = {
    // ChatGPT has served several page structures at once (by account, experiment and sign-in): all are read
    chatgpt: {
      name: "ChatGPT",
      platform: "chatgpt",
      chatId: () => (location.pathname.match(/\/u?c\/([\w-]+)/) || [])[1],
      messages: () => {
        const role = new Map();
        for (const e of document.querySelectorAll("[data-message-author-role]")) role.set(e, e.getAttribute("data-message-author-role"));
        for (const e of document.querySelectorAll("li[data-message-role]")) role.set(e, e.getAttribute("data-message-role"));
        for (const e of document.querySelectorAll("[data-content-search-unit-key$=':user'], [data-content-search-unit-key$=':assistant']"))
          role.set(e, e.getAttribute("data-content-search-unit-key").split(":").pop());
        return inOrder([...role.keys()])
          .map((el) => ({ role: role.get(el), el }))
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            ...m,
            text:
              m.role === "user"
                ? partsText(m.el, ["[data-user-message-bubble] [dir='auto']", "[data-user-message-bubble]"])
                : partsText(m.el, ["[data-assistant-markdown-root]", ".markdown"]),
          }));
      },
      generating: () =>
        !!pick([
          '[data-testid="stop-button"]',
          'button[aria-label*="Stop" i]',
          'button[aria-label*="إيقاف"]',
          "li[data-message-role='assistant'][data-assistant-content-started]:not([data-message-complete])",
        ]),
      composer: () => pick(["#prompt-textarea", "div.ProseMirror[contenteditable='true']", "textarea[name='prompt']", "form textarea"]),
      sendButton: () => pick(['[data-testid="send-button"]', 'button[aria-label*="Send" i]', 'button[aria-label*="إرسال"]']),
      title: () =>
        document.title
          .replace(/\s*[-|]\s*ChatGPT\s*$/i, "")
          .replace(/^ChatGPT(:.*)?$/i, "")
          .trim(),
      // what a bug report counts (how many of each known structure is on the page — never their text)
      probes: [
        "[data-message-author-role]",
        "li[data-message-role]",
        "[data-content-search-unit-key]",
        "[data-user-message-bubble]",
        "[data-assistant-markdown-root]",
        ".markdown",
        "#prompt-textarea",
        '[data-testid="send-button"]',
        '[data-testid="stop-button"]',
      ],
      // a ChatGPT project: /g/g-p-<id>-<name>/… (its chats and its new-chat page)
      scope: () => {
        const m = location.pathname.match(/\/g\/(g-p-[a-z0-9]+)(?:-([^/]+))?/i);
        return m ? { key: "chatgpt-" + m[1].toLowerCase(), name: m[2] ? decodeURIComponent(m[2]).replace(/-/g, " ") : "" } : null;
      },
    },
    claude: {
      name: "Claude",
      platform: "claude-web",
      chatId: () => (location.pathname.match(/\/chat\/([\w-]+)/) || [])[1],
      messages: () => {
        const u = [...document.querySelectorAll('[data-testid="user-message"]')];
        const a = [...document.querySelectorAll('[data-testid="assistant-message"], [data-is-streaming], .font-claude-response')];
        const role = new Map();
        u.forEach((e) => role.set(e, "user"));
        a.forEach((e) => {
          if (!role.has(e)) role.set(e, "assistant");
        });
        return inOrder([...role.keys()]).map((el) => ({
          role: role.get(el),
          el,
          text:
            role.get(el) === "user"
              ? cleanText(el)
              : partsText(el, ["[data-perf-reply-text]", ".standard-markdown", ".font-claude-response"]),
        }));
      },
      generating: () => !!pick(['[data-is-streaming="true"]', 'button[aria-label*="Stop" i]', 'button[aria-label*="إيقاف"]']),
      composer: () => pick(["div.ProseMirror[contenteditable='true']", "[contenteditable='true'][role='textbox']", "fieldset textarea"]),
      sendButton: () => pick(['button[aria-label*="Send" i]', 'button[aria-label*="إرسال"]']),
      title: () =>
        document.title
          .replace(/\s*[-|]\s*Claude\s*$/i, "")
          .replace(/^Claude$/i, "")
          .trim(),
      probes: [
        '[data-testid="user-message"]',
        '[data-testid="assistant-message"]',
        "[data-is-streaming]",
        ".font-claude-response",
        "[data-perf-reply-text]",
        ".standard-markdown",
        "div.ProseMirror[contenteditable='true']",
        'button[aria-label*="Send" i]',
      ],
      // a Claude project: its own page /project/<id>, or the project link shown in a chat (not the sidebar's list)
      scope: () => {
        const m = location.pathname.match(/^\/project\/([0-9a-f-]{8,64})/i);
        if (m) return { key: "claude-" + m[1].toLowerCase(), name: document.title.replace(/\s*[-|]\s*Claude\s*$/i, "").trim() };
        // never a link written inside a message (anyone can paste one): only the page's own header/breadcrumb
        const MSG =
          "[data-testid='user-message'], [data-testid='assistant-message'], [data-is-streaming], .font-claude-response, .standard-markdown, [data-perf-reply-text]";
        const a = [...document.querySelectorAll('a[href^="/project/"]')].find(
          (x) => !x.closest("nav, aside, [data-testid*='sidebar' i]") && !x.closest(MSG),
        );
        const id = a && (a.getAttribute("href").match(/^\/project\/([0-9a-f-]{8,64})/i) || [])[1];
        return id ? { key: "claude-" + id.toLowerCase(), name: (a.innerText || "").trim() } : null;
      },
    },
  };

  // Gemini (experimental, turned on in the settings): its page is built of <user-query> and <model-response> elements, the
  // composer is a rich-textarea editor. Chats live at /app/<id> (or /u/<n>/app/<id>); a Gem's chats at /gem/<gem>/<id>.
  ADAPTERS.gemini = {
    name: "Gemini",
    platform: "gemini",
    chatId: () => (location.pathname.match(/\/(?:app|gem\/[\w-]+)\/([0-9a-f]{8,})/i) || [])[1],
    messages: () => {
      const els = inOrder([...document.querySelectorAll("user-query, model-response")]);
      return els.map((el) => {
        const user = el.tagName.toLowerCase() === "user-query";
        return {
          role: user ? "user" : "assistant",
          el,
          text: user
            ? partsText(el, [".query-text-line", ".query-text", "[data-test-id='query-text']"])
            : partsText(el, ["message-content .markdown", "message-content", ".model-response-text", ".markdown"]),
        };
      });
    },
    generating: () =>
      !!pick([
        'button[aria-label*="Stop" i]',
        'button[aria-label*="إيقاف"]',
        ".send-button.stop",
        "model-response:last-of-type [aria-busy='true']",
      ]),
    composer: () =>
      pick([
        "rich-textarea .ql-editor[contenteditable='true']",
        "rich-textarea [contenteditable='true']",
        ".ql-editor[contenteditable='true']",
      ]),
    sendButton: () =>
      pick(['button[aria-label*="Send" i]', 'button[aria-label*="إرسال"]', "button.send-button", "button[data-test-id='send-button']"]),
    title: () =>
      document.title
        .replace(/\s*[-|]\s*Gemini\s*$/i, "")
        .replace(/^(Google )?Gemini$/i, "")
        .trim(),
    probes: ["user-query", "model-response", "message-content", ".query-text", "rich-textarea", ".ql-editor", "button.send-button"],
    // a Gem: its chats share one memory, like a project
    scope: () => {
      const m = location.pathname.match(/\/gem\/([\w-]{3,64})/i);
      return m ? { key: "gemini-gem-" + m[1].toLowerCase(), name: "" } : null;
    },
  };

  (root.CM = root.CM || {}).adapters = { detect, get: (p) => ADAPTERS[p] || null };
})(self);

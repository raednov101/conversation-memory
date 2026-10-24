// Fake chat page for tests: the DOM hooks the extension relies on (ChatGPT or Claude flavour) and a fake model.
(() => {
  const P = document.documentElement.dataset.cmTestPlatform;
  const thread = document.getElementById("thread");
  const composer = document.getElementById("prompt-textarea") || document.getElementById("composer") || document.querySelector(".ProseMirror");
  const bar = document.getElementById("bar");
  window.__delay = 500;
  window.__summaryOverride = null;
  window.__sent = [];
  // "2026": the structures seen on the real sites in October 2026 — ChatGPT's search-unit turns with a screen-reader
  // heading, Claude's assistant-message with a heading, markdown and a relative time that changes ("just now" → "1 min")
  const V = document.documentElement.dataset.cmTestVariant === "2026";
  let turn = 0;
  function addMsg2026(role, text) {
    const el = document.createElement("div");
    const setText = (t) => {
      if (P === "chatgpt") {
        if (role === "user") el.innerHTML = '<div data-user-message-bubble="true"><div dir="auto"></div></div>';
        else el.innerHTML = '<h4 class="sr-only" data-conversation-role="assistant" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">قال ChatGPT:</h4><div><div class="md"></div></div>';
        el.querySelector(role === "user" ? "[dir=auto]" : ".md").innerText = t;
      } else if (role === "user") { el.innerText = t; }
      else {
        el.innerHTML = '<h2 class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)"></h2><div><div data-cds="Prose"><div data-perf-reply-text="" class="standard-markdown"></div></div></div><div><button aria-label="Copy"></button><time data-cds="RelativeTime">just now</time></div>';
        el.querySelector("h2").textContent = "Claude responded: " + t.slice(0, 40);
        el.querySelector(".standard-markdown").innerText = t;
        setTimeout(() => { const tm = el.querySelector("time"); if (tm) tm.textContent = "1 minute ago"; }, 3000);
      }
    };
    if (P === "chatgpt") el.setAttribute("data-content-search-unit-key", `fallback-turn-${role === "user" ? ++turn : turn}:${role === "user" ? 0 : 1}:${role}`);
    else if (role === "user") el.setAttribute("data-testid", "user-message");
    else { el.setAttribute("data-testid", "assistant-message"); el.setAttribute("data-is-streaming", "true"); }
    setText(text); el.__set = setText; thread.appendChild(el); return el;
  }
  function addMsg(role, text) {
    if (V) return addMsg2026(role, text);
    const el = document.createElement("div");
    if (P === "chatgpt") el.setAttribute("data-message-author-role", role);
    else if (role === "user") el.setAttribute("data-testid", "user-message");
    else { el.setAttribute("data-is-streaming", "true"); el.className = "font-claude-response"; }
    el.innerText = text; thread.appendChild(el); return el;
  }
  function button(kind) {
    const b = document.createElement("button");
    if (kind === "send") { if (V && P === "chatgpt") b.setAttribute("aria-label", "إرسال"); else if (P === "chatgpt") b.setAttribute("data-testid", "send-button"); else b.setAttribute("aria-label", "Send message"); b.onclick = () => window.__send(); }
    else { if (V && P === "chatgpt") b.setAttribute("aria-label", "إيقاف"); else if (P === "chatgpt") b.setAttribute("data-testid", "stop-button"); else b.setAttribute("aria-label", "Stop response"); }
    b.textContent = kind; return b;
  }
  bar.appendChild(button("send"));
  // ?lazy: a long chat whose older messages arrive late (only the newest two turns at first), as on the real sites
  const lazy = new URLSearchParams(location.search).get("lazy");   // ?lazy=<ms> until the older messages arrive
  if (lazy !== null) {
    const kids = [...thread.children], older = kids.slice(0, Math.max(0, kids.length - 4));
    older.forEach((k) => k.remove());
    setTimeout(() => { for (const k of older.reverse()) thread.insertBefore(k, thread.firstChild); }, +lazy || 2500);
  }
  // the model: a summary request gets a JSON draft (ChatGPT flavour wraps it in a code block whose header leaks into innerText)
  function reply(t) {
    if (t.startsWith("🧠 ذاكرة المحادثة:")) {
      if (window.__summaryOverride) return window.__summaryOverride(t);
      const [from, to] = (t.match(/من (\d+) إلى (\d+)/) || []).slice(1);
      const draft = {
        summary: { goal: `هوية بصرية لمقهى (حتى الرسالة ${to})`, status: "اعتُمد اللون", next: ["اختيار الخط"], open: [] },
        decisions: { add: [{ text: "اعتماد اللون الأزرق الداكن للمشروع", source: "user" }], revoke: [] },
        constraints: { add: ["الميزانية 40 ألف ريال"], remove: [] },
        entry: { raised: [`نقاش تجريبي حول الهوية البصرية في الرسائل ${from}–${to}`], decided: ["اعتماد اللون الأزرق الداكن للمشروع"], changed: [] },
      };
      const json = JSON.stringify(draft, null, 1);
      return P === "chatgpt" ? `⟦ذاكرة:بداية⟧\njson\nCopy code\n${json}\n⟦ذاكرة:نهاية⟧` : `⟦ذاكرة:بداية⟧\n${json}\n⟦ذاكرة:نهاية⟧`;
    }
    return "رد النموذج على: " + t;
  }
  // a new-chat page gets its chat address only after the first message, as on the real sites
  const afterSend = document.documentElement.dataset.cmTestAfterSend;
  window.__send = () => {
    const t = (composer.innerText || "").trim(); if (!t) return;
    window.__sent.push(t);
    if (afterSend && location.pathname !== afterSend) history.pushState(null, "", afterSend);
    composer.innerHTML = "";
    addMsg("user", t);
    const stream = window.__stream;   // as on the real sites: the reply element appears at once and its text grows
    const a = P === "claude" || stream ? addMsg("assistant", "") : null;
    bar.innerHTML = ""; bar.appendChild(button("stop"));
    if (stream) {
      const full = reply(t), steps = 6; let i = 0;
      const iv = setInterval(() => {
        i++; const piece = full.slice(0, Math.ceil((full.length * i) / steps));
        if (V) a.__set(piece); else a.innerText = piece;
        if (i >= steps) { clearInterval(iv); if (P === "claude") a.setAttribute("data-is-streaming", "false"); bar.innerHTML = ""; bar.appendChild(button("send")); }
      }, window.__delay / steps);
      return;
    }
    setTimeout(() => {
      const text = reply(t);
      if (P === "chatgpt") addMsg("assistant", text); else if (V) { a.__set(text); a.setAttribute("data-is-streaming", "false"); } else { a.innerText = text; a.setAttribute("data-is-streaming", "false"); }
      bar.innerHTML = ""; bar.appendChild(button("send"));
    }, window.__delay);
  };
  composer.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); window.__send(); } });
  // typing fires "input", and sending is a real Enter key press, like a keyboard does
  window.__type = (t) => { composer.innerText = t; composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })); };
  window.__user = (t) => { window.__type(t); composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })); };
})();

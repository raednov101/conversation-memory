// Fake chat page for tests: the DOM hooks the extension relies on (ChatGPT or Claude flavour) and a fake model.
(() => {
  const P = document.documentElement.dataset.cmTestPlatform;
  const thread = document.getElementById("thread");
  const composer = document.getElementById("prompt-textarea") || document.getElementById("composer");
  const bar = document.getElementById("bar");
  window.__delay = 500;
  window.__summaryOverride = null;
  window.__sent = [];
  function addMsg(role, text) {
    const el = document.createElement("div");
    if (P === "chatgpt") el.setAttribute("data-message-author-role", role);
    else if (role === "user") el.setAttribute("data-testid", "user-message");
    else { el.setAttribute("data-is-streaming", "true"); el.className = "font-claude-response"; }
    el.innerText = text; thread.appendChild(el); return el;
  }
  function button(kind) {
    const b = document.createElement("button");
    if (kind === "send") { if (P === "chatgpt") b.setAttribute("data-testid", "send-button"); else b.setAttribute("aria-label", "Send message"); b.onclick = () => window.__send(); }
    else { if (P === "chatgpt") b.setAttribute("data-testid", "stop-button"); else b.setAttribute("aria-label", "Stop response"); }
    b.textContent = kind; return b;
  }
  bar.appendChild(button("send"));
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
    const a = P === "claude" ? addMsg("assistant", "") : null;
    bar.innerHTML = ""; bar.appendChild(button("stop"));
    setTimeout(() => {
      const text = reply(t);
      if (P === "chatgpt") addMsg("assistant", text); else { a.innerText = text; a.setAttribute("data-is-streaming", "false"); }
      bar.innerHTML = ""; bar.appendChild(button("send"));
    }, window.__delay);
  };
  composer.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); window.__send(); } });
  // typing fires "input", and sending is a real Enter key press, like a keyboard does
  window.__type = (t) => { composer.innerText = t; composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })); };
  window.__user = (t) => { window.__type(t); composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })); };
})();

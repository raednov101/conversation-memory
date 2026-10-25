// Writing into the site's message box and sending — used only when the box is empty and the model is idle.
(function (root) {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (c) => (c ? (c.value !== undefined ? c.value : c.innerText) || "" : "").trim();

  async function typeInto(c, value) {
    c.focus();
    if (c.value !== undefined) {
      // plain textarea (React-controlled: use the native setter)
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(c), "value").set.call(c, value);
      c.dispatchEvent(new Event("input", { bubbles: true }));
      return text(c).length > 0;
    }
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, value);
    if (!text(c)) {
      // fallback: a synthetic paste, which both editors accept
      const dt = new DataTransfer();
      dt.setData("text/plain", value);
      c.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }
    return text(c).length > 0;
  }
  async function send(adapter, c) {
    for (let i = 0; i < 30; i++) {
      const b = adapter.sendButton();
      if (b && !b.disabled) {
        b.click();
        return true;
      }
      await sleep(100);
    }
    c.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    return true;
  }

  (root.CM = root.CM || {}).composer = { text, typeInto, send };
})(self);

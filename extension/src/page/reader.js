// The conversation as turns. The extension's own request/reply pairs (prefix HK) are kept apart, never counted or saved as chat.
(function (root) {
  "use strict";
  const C = root.MemoryCore;
  const textOf = (el) => (el.innerText || el.textContent || "").replace(/\r\n/g, "\n").trim();
  const norm = (t) => t.replace(/\s+/g, " ").trim();

  // → { turns: [{role, n?, text}], hk: [{text, reply}], userCount, total, uh: [hash of your text], rh: [hash of your text + its replies] }
  // An edit changes uh and rh at that message; a regenerated reply changes only rh.
  function read(adapter, HK) {
    const turns = [],
      hk = [],
      empty = [];
    let n = 0,
      inHK = false;
    for (const m of adapter.messages()) {
      const text = (m.text != null ? String(m.text) : textOf(m.el)).replace(/\r\n/g, "\n").trim();
      if (m.role === "user") {
        if ((Array.isArray(HK) ? HK : [HK]).some((h) => text.startsWith(h))) {
          inHK = true;
          hk.push({ text, reply: null });
          continue;
        }
        inHK = false;
        n++;
        turns.push({ role: "user", n, text });
        if (!text) empty.push(n); // an image or a file only: nothing readable to save — the user is told which one
      } else if (inHK) {
        const h = hk[hk.length - 1];
        h.reply = h.reply ? h.reply + "\n" + text : text;
      } else turns.push({ role: "assistant", text });
    }
    const uh = [],
      rh = [];
    for (let i = 0; i < turns.length; i++) {
      if (turns[i].role !== "user") continue;
      let rep = "";
      for (let j = i + 1; j < turns.length && turns[j].role === "assistant"; j++) rep += "\n" + turns[j].text;
      uh.push(C.hash(norm(turns[i].text)));
      rh.push(C.hash(norm(turns[i].text) + "␞" + norm(rep)));
    }
    return { turns, hk, userCount: n, total: turns.length + hk.length, uh, rh, empty };
  }

  (root.CM = root.CM || {}).reader = { read };
})(self);

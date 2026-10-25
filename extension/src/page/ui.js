// The indicator on the page: the pill, its panel, the pin form and toasts — inside a closed shadow root, so the site's
// own scripts can neither read the memory shown in it nor press its buttons (only real clicks and keys count).
// It only draws a view object and reports button presses; it never reads the page or writes files itself.
(function (root) {
  "use strict";
  const CSS = `
    :host{all:initial}
    .pill{position:fixed;right:16px;bottom:96px;z-index:2147483646;font:12px/1.4 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;direction:rtl;
      background:#1f2328;color:#f6f8fa;border-radius:999px;padding:6px 12px;box-shadow:0 2px 10px rgba(0,0,0,.25);cursor:pointer;user-select:none;opacity:.92;border:0}
    .pill:hover{opacity:1}.pill:focus-visible{opacity:1;outline:3px solid #fff;outline-offset:2px;box-shadow:0 0 0 5px #0969da}
    .panel button:focus-visible,.panel input:focus-visible{outline:2px solid #0969da;outline-offset:1px}
    .ok{background:#1a7f37}.txt{background:#1b7c83}.warn{background:#9a6700}.err{background:#cf222e}.busy{background:#0969da}.idle{background:#57606a}
    .panel{position:fixed;right:16px;bottom:132px;z-index:2147483647;direction:rtl;font:13px/1.5 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;
      background:#fff;color:#1f2328;border:1px solid #d0d7de;border-radius:10px;padding:12px;width:280px;box-shadow:0 8px 24px rgba(0,0,0,.18);display:none}
    .panel.open{display:block}.panel p{margin:0 0 8px;overflow-wrap:anywhere}
    .panel button{display:block;width:100%;margin:6px 0 0;padding:7px 8px;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;color:#1f2328;cursor:pointer;font:inherit;text-align:right}
    .panel button:hover{background:#eaeef2}.muted{color:#57606a;font-size:12px}
    .panel input{box-sizing:border-box;width:100%;font:inherit;padding:6px 8px;border:1px solid #d0d7de;border-radius:6px;margin:4px 0}
    .preview{max-height:90px;overflow:auto;white-space:pre-wrap;background:#f6f8fa;border-radius:6px;padding:6px;font-size:12px;margin:0 0 6px}
    .panel.wide{width:340px;max-height:72vh;overflow:auto}
    .panel .opt{display:flex;gap:6px;align-items:flex-start;margin:3px 0;font-size:12px;cursor:pointer}.panel .opt input{width:auto;margin:2px 0 0}
    .panel .opt .tag{color:#9a6700;font-size:11px}
    .panel h4{margin:8px 0 2px;font-size:12px;color:#57606a}
    .rv{border-top:1px solid #d0d7de;padding-top:6px;margin-top:6px}.rv button{display:inline-block;width:auto;margin:0 0 0 6px}
    .share-prev{max-height:150px}.count{font-size:11px;color:#57606a;text-align:left}
    :host(.side-left) .pill,:host(.side-left) .panel,:host(.side-left) .toast{right:auto;left:16px}
    .toast{position:fixed;right:16px;bottom:56px;z-index:2147483647;direction:rtl;font:13px system-ui,Tahoma,sans-serif;background:#1f2328;color:#fff;padding:8px 12px;border-radius:8px;display:none;max-width:320px}`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const fmt = (n) => Number(n || 0).toLocaleString("en-US");
  const q = (t) => `«<bdi>${esc(t)}</bdi>»`;   // a name inside Arabic text keeps its own direction (English names, numbers)
  const n = (k, w) => root.MemoryCore.count(k, root.MemoryCore.W[w]);   // Arabic counting forms
  // "≈665" keeps its sign before the number inside Arabic text (isolated left-to-right run)
  const approx = (n) => `\u2066≈${fmt(n)}\u2069`;
  const tokens = (chars) => root.MemoryCore.estTokens(chars);   // the shared core's estimate (≈ 3 characters per token)
  const hhmm = (t) => (t ? new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }) : "");

  const SHARE = ["📤 انقل معلومات مختارة إلى هذه المحادثة", "share"];
  const REVIEW = (k) => [`🔎 راجع القرارات (${k})`, "review"];
  // the pill text, its colour, the panel text and its buttons for a view — pure, easy to reason about
  function describe(v, settings, why, maxAttempts) {
    const s = v.st || {};
    let cls = "idle", text = "🧠 الذاكرة", info = "";
    const btns = [];
    if (v.fsSt && v.fsSt.error === "inactive") { cls = "warn"; text = "🧠 🔄 حدّث الصفحة"; info = esc(why("inactive")) + "."; btns.push(["🔄 حدّث الصفحة الآن", "reload"]); return { cls, text, info, btns }; }
    if (!v.fsSt || !v.fsSt.ok || !v.fsSt.folder) { cls = "warn"; text = "🧠 ⚠️ الحفظ غير متاح"; info = "تعذّر تجهيز مكان حفظ الذاكرة" + (v.fsSt && v.fsSt.error ? ": " + esc(why(v.fsSt.error)) : "") + "."; btns.push(["⚙️ الإعدادات", "options"]); }
    else if (v.fsSt.permission === "granted" && !v.fsOk) { cls = "warn"; text = "🧠 ⚠️ الحفظ غير متاح"; info = `تعذّر تجهيز ذاكرة ${q(v.fsSt.folder)}${v.fsSt.error ? ": " + esc(why(v.fsSt.error)) : ""}.`; btns.push(["⚙️ الإعدادات", "options"]); }
    else if (!v.fsOk) { cls = "warn"; text = "🧠 🔓 امنح الإذن"; info = `يلزم إذن الكتابة في ${q(v.fsSt.folder)}.`; btns.push(["🔓 منح الإذن", "options"]); }
    else if (v.phase === "unlinked" && v.unreadable) { cls = "err"; text = "🧠 ⚠️ تعذّرت قراءة المحادثة"; info = "لا أستطيع قراءة رسائل هذه الصفحة؛ ربما تغيّر تصميم الموقع. لم يُحفظ منها شيء."; }
    else if (v.phase === "unlinked") {
      text = "🧠 غير مربوطة"; info = `هذه المحادثة غير مربوطة بالذاكرة ${q(v.fsSt.folder)}، فلا تُلخَّص ولا تُحفظ.` +
        `<br><span class="muted">اربطها إن كان موضوعها يخص هذه الذاكرة؛ تُلخَّص حينها من أولها (${n(v.userCount, "msg")} حتى الآن).</span>`;
      btns.push(["🔗 اربطها بالذاكرة", "link"], SHARE);
    }
    else if (v.phase === "new") { text = "🧠 محادثة جديدة"; info = v.fsSt.inBrowser ? `الذاكرة: <bdi>${esc(v.fsSt.folder)}</bdi>` : `المجلد: <bdi>${esc(v.fsSt.folder)}</bdi>`; btns.push(["📥 أدرج الذاكرة في الرسالة", "insert"], SHARE); }
    else if (v.phase === "chat") {
      const since = Math.max(0, v.userCount - s.summarizedUpTo), manual = settings.mode === "manual";
      const prog = manual ? `${since} · يدوي` : `${Math.min(since, settings.every)}/${settings.every}`;
      const cost = s.lastCost ? tokens(s.lastCost.req + s.lastCost.rep) : 0;
      if (v.unreadable) { cls = "err"; text = "🧠 ⚠️ تعذّرت قراءة المحادثة"; info = "لا أستطيع قراءة رسائل هذه الصفحة؛ ربما تغيّر تصميم الموقع. الحفظ متوقف هنا، ولم يُفقد شيء محفوظ."; }
      else if (s.pending) { cls = "busy"; text = `🧠 ⏳ ${prog} · يحفظ`; info = "طُلب الملخص من النموذج؛ يُحفظ عند اكتمال الرد."; }
      else if (s.status === "error") { cls = "err"; text = `🧠 ⚠️ ${prog} · تعثّر الحفظ`; info = `تعثّر الحفظ: ${esc(s.error)}` + (s.attempts >= maxAttempts ? " (توقف التلقائي بعد 3 محاولات؛ استخدم الزر)" : " (يعيد المحاولة بعد رسالتك القادمة)"); }
      // three outcomes, never confused: 📝 the full text is saved (summary later) · ✓ the summary was updated · ⚠️ failed
      else if (s.rawAt && s.rawAt > (s.lastSave || 0)) { cls = "txt"; text = `🧠 ${prog} · 📝 ${hhmm(s.rawAt)}`; info = `📝 النص الكامل محفوظ ${hhmm(s.rawAt)}.<br>${s.lastSave ? `✓ آخر تحديث للملخص ${hhmm(s.lastSave)} — الرسائل حتى ${s.summarizedUpTo}.` : "لم يُحدَّث الملخص بعد."}`; }
      else { cls = s.lastSave ? "ok" : "idle"; text = `🧠 ${prog}` + (s.lastSave ? ` · ✓ ${hhmm(s.lastSave)}` : "") + (s.lastSave && cost ? ` · ${approx(cost)} توكن` : ""); info = s.lastSave ? `✓ حُدّث الملخص ${hhmm(s.lastSave)} — الرسائل حتى ${s.summarizedUpTo}.` : "لم يُحفظ ملخص بعد."; }
      if (s.lastCost && !v.unreadable) info += `<br><span class="muted">كلفة آخر تلخيص: الطلب ${fmt(s.lastCost.req)} حرفاً والرد ${fmt(s.lastCost.rep)} ≈ ${fmt(cost)} توكن${s.costTotal && s.costTotal.n > 1 ? `؛ في هذه المحادثة ${s.costTotal.n} تلخيصات ≈ ${fmt(tokens(s.costTotal.chars))} توكن` : ""} (تقدير). ويبقى الطلب ورده في سياق المحادثة.</span>`;
      if (s.note && !v.unreadable) info += `<br><span class="muted">${esc(s.note)}</span>`;
      if (v.empty && v.empty.length && !v.unreadable) info += `<br><span class="muted">${v.empty.length === 1 ? `رسالتك رقم ${v.empty[0]}` : `رسائلك رقم ${v.empty.join("، ")}`} بلا نص مقروء (صورة أو ملف)؛ لا يُحفظ منها إلا ما يذكره الرد عنها.</span>`;
      if (!v.unreadable) {
        const left = Math.max(0, settings.every - since);
        info += `<br><span class="muted">${manual ? "الوضع اليدوي: لا يُطلب ملخص إلا بالزر." : `${left ? `التلخيص القادم بعد ${n(left, "msg")}.` : "التلخيص مستحق."}`} النص الكامل يُحفظ بعد كل رد.` +
          `${!manual && settings.paused ? " (التلخيص التلقائي متوقف)" : ""}${v.noComposer ? " لا أجد خانة الكتابة." : ""}</span>`;
        if (v.userCount > s.summarizedUpTo && !s.pending) btns.push(["💾 لخّص واحفظ الآن", "summarize"]);
        if (settings.mode === "auto") btns.push([settings.paused ? "▶️ تشغيل التلخيص التلقائي" : "⏸️ إيقاف التلخيص التلقائي", "pause"]);
      }
      btns.push(["📥 أدرج الذاكرة في الرسالة", "insert"], SHARE);
      btns.push(["↩️ تراجع عن آخر تغيير في الذاكرة", "undo"]);
      btns.push(["⛓️ فك ربط المحادثة بالمشروع", "unlink"]);
    }
    // decisions saved without evidence in the conversation wait for the user: said once, with one button
    const rv = (v.phase === "chat" || v.phase === "new") && v.review ? v.review.length : 0;
    if (rv) { text += ` · 🔎${rv}`; info += `<br><span class="muted">🔎 ${rv === 1 ? "قرار ينتظر" : rv === 2 ? "قراران ينتظران" : n(rv, "decision") + " تنتظر"} مراجعتك: لم أجد ${rv === 1 ? "دليله" : rv === 2 ? "دليلهما" : "دليلها"} في كلامك، فحُفظ اقتراحاً.</span>`; btns.unshift(REVIEW(rv)); }
    if (v.crash) { cls = "err"; info = "خطأ داخلي: " + esc(v.crash); }
    btns.push(["⚙️ الإعدادات", "options"]);
    return { cls, text, info, btns };
  }

  // opts: { onAction(name), onPinSave(name, text), validPinName(name), why, maxAttempts }
  function create(opts) {
    const host = document.createElement("div");
    host.id = "cm-memory-indicator";
    const shadow = host.attachShadow({ mode: opts.test ? "open" : "closed" });   // open only on the local test pages
    shadow.innerHTML = `<style>${CSS}</style><button class="pill idle" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="cm-panel">🧠 …</button><div class="panel" id="cm-panel" role="dialog" aria-label="ذاكرة المحادثة"></div><div class="toast" role="status" aria-live="polite"></div>`;
    const real = (e) => e.isTrusted;   // a click or key from the person, not from a page script
    const pill = shadow.querySelector(".pill"), panel = shadow.querySelector(".panel"), toastEl = shadow.querySelector(".toast");
    // keys typed in our panel must not reach the site's own shortcuts ("type anywhere to focus the composer")
    for (const ev of ["keydown", "keyup", "keypress", "input", "beforeinput", "paste"]) shadow.addEventListener(ev, (e) => e.stopPropagation());
    let pinDraft = null, share = null, last = { view: {}, settings: {} };

    function toast(msg) { toastEl.textContent = msg; toastEl.style.display = "block"; clearTimeout(toast.t); toast.t = setTimeout(() => (toastEl.style.display = "none"), 6000); }
    function render(view, settings) {
      if (view) last = { view, settings };
      if (!document.body) return;
      if (!host.isConnected) document.body.appendChild(host);
      // the side away from the site's sidebar: on the right of a left-to-right page, on the left of a right-to-left one
      host.classList.toggle("side-left", getComputedStyle(document.documentElement).direction === "rtl" || document.documentElement.dir === "rtl");
      if (pinDraft || share) return;   // don't redraw over the pin form or the share panel
      const d = describe(last.view, last.settings, opts.why, opts.maxAttempts);
      pill.className = "pill " + d.cls; pill.textContent = d.text; pill.setAttribute("aria-expanded", String(panel.classList.contains("open")));
      panel.innerHTML = `<p>${d.info}</p>` + d.btns.map(([t, a]) => `<button type="button" data-a="${a}">${t}</button>`).join("");
    }
    function closePin() { pinDraft = null; share = null; panel.classList.remove("open", "wide"); render(); }
    function openPin(text) {
      render();
      pinDraft = { text };
      panel.innerHTML = `<p><b>📌 تثبيت النص المحدد حرفياً</b></p><div class="preview"></div>` +
        `<label class="muted">الاسم (نفس الاسم = نسخة جديدة)<input type="text" maxlength="60" autocomplete="off"></label>` +
        `<button type="button" data-a="pin-save">حفظ</button><button type="button" data-a="pin-cancel">إلغاء</button>`;
      panel.querySelector(".preview").textContent = text.length > 400 ? text.slice(0, 400) + "…" : text;
      panel.classList.add("open");
      const input = panel.querySelector("input");
      input.addEventListener("keydown", (e) => { if (!real(e)) return; if (e.key === "Enter") { e.preventDefault(); savePin(); } if (e.key === "Escape") closePin(); });
      setTimeout(() => input.focus(), 0);
    }
    function savePin() {
      if (!pinDraft) return;
      const name = panel.querySelector("input").value.trim();
      if (!opts.validPinName(name)) { toast("اسم غير صالح: حتى 60 حرفاً، بلا / أو : أو رموز."); return; }
      const text = pinDraft.text;
      closePin();
      opts.onPinSave(name, text);
    }
    // decisions waiting for review: each with the words it was saved from, approve or revoke one at a time
    function openReview(list) {
      render();
      share = { review: true };
      const item = (d) => `<div class="rv"><p><b><bdi>${esc(d.id)}</bdi></b> ${esc(d.text)}${d.quote ? `<br><span class="muted">الاقتباس: ${q(d.quote)}</span>` : `<br><span class="muted">بلا اقتباس</span>`}</p>` +
        `<button type="button" data-a="rv-approve" data-id="${esc(d.id)}">✓ اعتمده قراراً</button><button type="button" data-a="rv-revoke" data-id="${esc(d.id)}">✕ ألغِه</button></div>`;
      panel.innerHTML = `<p><b>🔎 قرارات تنتظر مراجعتك</b><br><span class="muted">كتبها النموذج قراراً لك، ولم أجد كلامك الذي يثبتها في المحادثة. اعتمد الصحيح وألغِ الخطأ.</span></p>` +
        list.map(item).join("") + `<button type="button" data-a="pin-cancel">إغلاق</button>`;
      panel.classList.add("open", "wide");
    }
    // choose parts of the project's memory, see exactly what will be inserted (and its length), then insert — never sent
    // m: the memory; o: { preview(sel) → text, budget, onInsert(text) }
    function openShare(m, o) {
      render();
      share = { o };
      const opt = (kind, val, label, tag) => `<label class="opt"><input type="checkbox" data-k="${kind}" data-v="${esc(val)}"><span>${label}${tag ? ` <span class="tag">${tag}</span>` : ""}</span></label>`;
      const act = m.decisions.filter((d) => d.status === "active");
      const cut = (t, n = 90) => esc(t.length > n ? t.slice(0, n) + "…" : t);
      let h = `<p><b>📤 انقل معلومات مختارة</b><br><span class="muted">اختر ما تريد، وراجع المعاينة، ثم تُدرج في خانة الرسالة دون إرسال.</span></p>`;
      h += opt("summary", "1", "الخلاصة الحالية") + (m.constraints.length ? opt("constraints", "1", `القيود (${m.constraints.length})`) : "");
      if (act.length) h += `<h4>القرارات</h4>` + act.map((d) => opt("decisions", d.id, `${esc(d.id)} — ${cut(d.text)}`, d.source === "assistant" ? "اقتراح لم يُعتمد" : "")).join("");
      if (m.pins.length) h += `<h4>النصوص المعتمدة</h4>` + m.pins.map((p) => opt("pins", p.name, esc(p.name))).join("");
      const log = m.log.slice(-10).reverse();
      if (log.length) h += `<h4>من السجل</h4>` + log.map((e) => opt("log", e.id, `${esc(e.range ? "الرسائل " + e.range : e.date || "")}${e.chat ? " · " + cut(e.chat, 30) : ""}: ${cut(e.raised[0] || e.decided[0] || "", 60)}`)).join("");
      h += `<h4>المعاينة</h4><div class="preview share-prev"></div><div class="count"></div>` +
        `<button type="button" data-a="share-insert">📥 أدرج في الرسالة</button><button type="button" data-a="pin-cancel">إلغاء</button>`;
      panel.innerHTML = h;
      panel.classList.add("open", "wide");
      update();
    }
    function selection() {
      const sel = { summary: false, constraints: false, decisions: [], pins: [], log: [] };
      for (const c of panel.querySelectorAll("input[type=checkbox]:checked")) { const k = c.dataset.k; if (k === "summary" || k === "constraints") sel[k] = true; else sel[k].push(c.dataset.v); }
      return sel;
    }
    function update() {
      if (!share) return;
      const t = share.o.preview(selection());
      share.text = t;
      panel.querySelector(".share-prev").textContent = t || "(لم تختر شيئاً بعد)";
      panel.querySelector(".count").textContent = `${t.length.toLocaleString("en-US")} / ${share.o.budget.toLocaleString("en-US")} حرف`;
    }
    panel.addEventListener("change", (e) => { if (real(e) && share && e.target && e.target.type === "checkbox") update(); });
    const setOpen = (on) => { panel.classList.toggle("open", on); pill.setAttribute("aria-expanded", String(on)); if (on) { const f = panel.querySelector("button, input"); if (f) setTimeout(() => f.focus(), 0); } };
    pill.addEventListener("click", (e) => { if (!real(e) || pinDraft || share) return; render(); setOpen(!panel.classList.contains("open")); });
    panel.addEventListener("keydown", (e) => { if (real(e) && e.key === "Escape") { if (pinDraft || share) closePin(); else setOpen(false); pill.focus(); } });
    panel.addEventListener("click", (e) => {
      if (!real(e)) return;
      const b = e.target && e.target.closest && e.target.closest("button[data-a]"); if (!b) return;
      const a = b.dataset.a;
      if (a === "pin-save") return savePin();
      if (a === "pin-cancel") return closePin();
      if (a === "rv-approve" || a === "rv-revoke") {
        b.disabled = true;
        Promise.resolve(opts.onReview(b.dataset.id, a === "rv-approve" ? "approve" : "revoke")).then((left) => { if (left && left.length) openReview(left); else closePin(); });
        return;
      }
      if (a === "share-insert") { if (!share || !share.text) { toast("اختر شيئاً أولاً."); return; } const { o, text } = share; closePin(); o.onInsert(text); return; }
      setOpen(false);
      opts.onAction(a);
    });
    return { host, render, toast, openPin, openShare, openReview };
  }

  (root.CM = root.CM || {}).ui = { create, describe };
})(self);

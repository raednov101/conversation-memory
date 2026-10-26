// The indicator on the page: the pill, its panel, the pin form and toasts — inside a closed shadow root, so the site's
// own scripts can neither read the memory shown in it nor press its buttons (only real clicks and keys count).
// It only draws a view object and reports button presses; it never reads the page or writes files itself.
(function (root) {
  "use strict";
  const CSS = `
    :host{all:initial}
    .pill{position:fixed;right:16px;bottom:96px;z-index:2147483646;font:12px/1.4 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;direction:var(--cm-dir,rtl);
      background:#1f2328;color:#f6f8fa;border-radius:999px;padding:6px 12px;box-shadow:0 2px 10px rgba(0,0,0,.25);cursor:pointer;user-select:none;opacity:.92;border:0}
    .pill:hover{opacity:1}.pill:focus-visible{opacity:1;outline:3px solid #fff;outline-offset:2px;box-shadow:0 0 0 5px #0969da}
    .panel button:focus-visible,.panel input:focus-visible{outline:2px solid #0969da;outline-offset:1px}
    .ok{background:#1a7f37}.txt{background:#1b7c83}.warn{background:#9a6700}.err{background:#cf222e}.busy{background:#0969da}.idle{background:#57606a}
    .panel{position:fixed;right:16px;bottom:132px;z-index:2147483647;direction:var(--cm-dir,rtl);font:13px/1.5 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;
      background:#fff;color:#1f2328;border:1px solid #d0d7de;border-radius:10px;padding:12px;width:280px;box-shadow:0 8px 24px rgba(0,0,0,.18);display:none}
    .panel.open{display:block}.panel p{margin:0 0 8px;overflow-wrap:anywhere}
    .panel button{display:block;width:100%;margin:6px 0 0;padding:7px 8px;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;color:#1f2328;cursor:pointer;font:inherit;text-align:start}
    .panel button:hover{background:#eaeef2}.muted{color:#57606a;font-size:12px}
    .panel input{box-sizing:border-box;width:100%;font:inherit;padding:6px 8px;border:1px solid #d0d7de;border-radius:6px;margin:4px 0}
    .preview{max-height:90px;overflow:auto;white-space:pre-wrap;background:#f6f8fa;border-radius:6px;padding:6px;font-size:12px;margin:0 0 6px}
    .panel.wide{width:340px;max-height:72vh;overflow:auto}
    .panel .small{font-size:11px}
    .panel button.primary{background:#1f2328;color:#fff;border-color:#1f2328}.panel button.primary:hover{background:#32383f}
    .panel button.link{width:auto;background:none;border:none;padding:2px 0;margin:8px 0 0;color:#57606a;font-size:11.5px;text-decoration:underline}
    .panel .sec{display:flex;flex-wrap:wrap;gap:2px 10px;margin-top:6px;padding-top:6px;border-top:1px solid #eaeef2}
    .panel .sec button{width:auto;background:none;border:none;padding:2px 0;margin:0;color:#57606a;font-size:11.5px;text-decoration:underline;cursor:pointer}
    .panel details.tech{margin-top:4px}.panel details.tech summary{cursor:pointer;color:#57606a;font-size:11.5px}
    .panel input.find{width:100%;box-sizing:border-box;margin:4px 0 8px;padding:6px 8px;border:1px solid #d0d7de;border-radius:6px;font:inherit}
    .panel .opt{display:flex;gap:6px;align-items:flex-start;margin:3px 0;font-size:12px;cursor:pointer}.panel .opt input{width:auto;margin:2px 0 0}
    .panel .opt .tag{color:#9a6700;font-size:11px}
    .panel h4{margin:8px 0 2px;font-size:12px;color:#57606a}
    .rv{border-top:1px solid #d0d7de;padding-top:6px;margin-top:6px}.rv button{display:inline-block;width:auto;margin:0 0 0 6px}
    .share-prev{max-height:150px}.count{font-size:11px;color:#57606a;text-align:left}
    :host(.side-left) .pill,:host(.side-left) .panel,:host(.side-left) .toast{right:auto;left:16px}
    .toast.beside{right:372px;bottom:132px}:host(.side-left) .toast.beside{right:auto;left:372px}
    .toast{position:fixed;right:16px;bottom:136px;z-index:2147483647;direction:var(--cm-dir,rtl);font:13px system-ui,Tahoma,sans-serif;background:#1f2328;color:#fff;padding:8px 12px;border-radius:8px;display:none;max-width:320px}`;
  const T = root.MemoryCore.T;
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const fmt = (n) => Number(n || 0).toLocaleString("en-US");
  const en = () => root.MemoryCore.lang() === "en";
  // a name keeps its own direction inside the text (English names in Arabic, Arabic names in English)
  const q = (t) => (en() ? `“<bdi>${esc(t)}</bdi>”` : `«<bdi>${esc(t)}</bdi>»`);
  const n = (k, w) => root.MemoryCore.count(k, root.MemoryCore.W[w]); // Arabic counting forms
  const tokens = (chars) => root.MemoryCore.estTokens(chars); // the shared core's estimate (≈ 3 characters per token)
  const hhmm = (t) => (t ? new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }) : "");

  const SHARE = () => [T("📤 انقل معلومات مختارة إلى هذه المحادثة"), "share"];
  const REPORT = () => [T("🐞 أبلغ عن تغيّر الموقع (تقرير تقني بلا نص محادثتك)"), "report"];
  const BROKEN = () =>
    T("غيّر الموقع تصميمه فلم أعد أقرأ هذه المحادثة. ذاكرتك المحفوظة سليمة، والحفظ هنا متوقف مؤقتاً حتى يصل تحديث للإضافة.");
  const VIA_DATA = () => T("تغيّر تصميم صفحة الموقع، فأقرأ المحادثة من بيانات الموقع نفسه. الحفظ يعمل كالمعتاد.");
  const REVIEW = (k) => [T`🔎 راجع القرارات (${k})`, "review"];
  // the pill text, its colour, the panel text and its buttons for a view — pure, easy to reason about
  function describe(v, settings, why, maxAttempts) {
    const s = v.st || {};
    let cls = "idle",
      text = T("🧠 الذاكرة"),
      info = "",
      tech = ""; // what only a curious or technical reader needs, shown last behind «Details»
    const btns = [];
    if (v.fsSt && v.fsSt.error === "inactive") {
      cls = "warn";
      text = T("🧠 🔄 حدّث الصفحة");
      info = esc(why("inactive")) + ".";
      btns.push([T("🔄 حدّث الصفحة الآن"), "reload"]);
      return { cls, text, info, btns };
    }
    if (!v.fsSt || !v.fsSt.ok || !v.fsSt.folder) {
      cls = "warn";
      text = T("🧠 ⚠️ الحفظ غير متاح");
      info = T("تعذّر تجهيز مكان حفظ الذاكرة") + (v.fsSt && v.fsSt.error ? ": " + esc(why(v.fsSt.error)) : "") + ".";
      btns.push([T("⚙️ الإعدادات"), "options"]);
    } else if (v.fsSt.permission === "granted" && !v.fsOk) {
      cls = "warn";
      text = T("🧠 ⚠️ الحفظ غير متاح");
      info = T`تعذّر تجهيز ذاكرة ${q(v.fsSt.folder)}${v.fsSt.error ? ": " + esc(why(v.fsSt.error)) : ""}.`;
      btns.push([T("⚙️ الإعدادات"), "options"]);
    } else if (!v.fsOk) {
      cls = "warn";
      text = T("🧠 🔓 امنح الإذن");
      info = T`يلزم إذن الكتابة في ${q(v.fsSt.folder)}.`;
      btns.push([T("🔓 منح الإذن"), "options"]);
    } else if (v.phase === "wait") {
      text = "🧠 …";
      info = T("أتعرّف على ذاكرة هذه المحادثة…");
    } else if (v.phase === "unlinked" && v.unreadable) {
      cls = "warn";
      text = T("🧠 ⏸️ الموقع تغيّر");
      info = BROKEN();
      btns.push(REPORT());
    } else if (v.phase === "unlinked") {
      text = T("🧠 غير مربوطة");
      info =
        T`هذه المحادثة غير مربوطة بالذاكرة ${q(v.fsSt.folder)}، فلا تُلخَّص ولا تُحفظ.` +
        T`<br><span class="muted">اربطها إن كان موضوعها يخص هذه الذاكرة؛ تُلخَّص حينها من أولها (${n(v.userCount, "msg")} حتى الآن).</span>`;
      btns.push([T("🔗 اربطها بالذاكرة"), "link"], SHARE());
      if (v.src === "data") {
        info += `<br><span class="muted">${VIA_DATA()}</span>`;
        btns.push(REPORT());
      }
    } else if (v.phase === "new" && v.outside) {
      text = T("🧠 لا ذاكرة بعد");
      info = T("لهذه المحادثة ذاكرتها الخاصة، فلا تختلط مواضيعك. لتكمل محادثة سابقة اختر ذاكرتها.");
      btns.push([T("📥 أكمل من ذاكرة محادثة سابقة"), "insert"], [T("📤 انقل معلومات من ذاكرة سابقة"), "share"]);
    } else if (v.phase === "new") {
      text = T("🧠 الذاكرة جاهزة");
      info = v.fsSt.inBrowser ? T`الذاكرة: <bdi>${esc(v.fsSt.folder)}</bdi>` : T`المجلد: <bdi>${esc(v.fsSt.folder)}</bdi>`;
      btns.push([T("📥 ضع الذاكرة في خانة الكتابة"), "insert"], SHARE());
    } else if (v.phase === "chat") {
      const since = Math.max(0, v.userCount - s.summarizedUpTo),
        manual = settings.mode === "manual";
      const prog = manual ? T`${since} · يدوي` : `${Math.min(since, settings.every)}/${settings.every}`;
      const cost = s.lastCost ? tokens(s.lastCost.req + s.lastCost.rep) : 0;
      if (v.unreadable) {
        cls = "warn";
        text = T("🧠 ⏸️ الموقع تغيّر");
        info = BROKEN();
      } else if (s.topicAsk) {
        cls = "warn";
        text = T`🧠 ❓ موضوع آخر؟`;
        info = T`يبدو أن هذه المحادثة عن موضوع آخر غير ذاكرة ${q(v.fsSt.folder)}، فلم يُلخَّص شيء فيها حتى لا تختلط. هل تخصّها؟`;
        // one question at a time: only its two answers
        return {
          cls,
          text,
          info,
          btns: [
            [T("🔗 نعم، تخصّها: لخّصها فيها"), "topic-yes"],
            [T("✂️ لا، افصلها عن هذه الذاكرة"), "topic-no"],
            [T("⚙️ الإعدادات"), "options", "sec"],
          ],
        };
      } else if (s.pending) {
        cls = "busy";
        text = T`🧠 ⏳ ${prog} · يحفظ`;
        info = T("طُلب الملخص من النموذج؛ يُحفظ عند اكتمال الرد.");
      } else if (v.apiBusy) {
        cls = "busy";
        text = T`🧠 ⏳ ${prog} · 🔑 يلخّص`;
        info = T("يُلخَّص في الخلفية بمفتاحك؛ لا شيء يظهر في المحادثة.");
      } else if (s.status === "error") {
        cls = "err";
        text = T`🧠 ⚠️ ${prog} · تعثّر الحفظ`;
        info =
          T`لم يُحفظ الملخص هذه المرة: ${esc(String(s.error || "").replace(/\.\s*$/, ""))}.` +
          (s.attempts >= maxAttempts
            ? T("<br>توقفتُ عن المحاولة التلقائية بعد 3 محاولات. اضغط «لخّص واحفظ الآن» حين تريد.")
            : T("<br>سأحاول مجدداً بعد رسالتك القادمة، أو اضغط «لخّص واحفظ الآن»."));
      }
      // three outcomes, never confused: 📝 the full text is saved (summary later) · ✓ the summary was updated · ⚠️ failed
      else if (s.rawAt && s.rawAt > (s.lastSave || 0)) {
        cls = "txt";
        text = `🧠 ${prog} · 📝 ${hhmm(s.rawAt)}`;
        info = T`📝 النص الكامل محفوظ ${hhmm(s.rawAt)}.<br>${s.lastSave ? T`✓ آخر تحديث للملخص ${hhmm(s.lastSave)} — الرسائل حتى ${s.summarizedUpTo}.` : T("لم يُحدَّث الملخص بعد.")}`;
      } else {
        cls = s.lastSave ? "ok" : "idle";
        text = `🧠 ${prog}` + (s.lastSave ? ` · ✓ ${hhmm(s.lastSave)}` : "");
        info = s.lastSave ? T`✓ حُدّث الملخص ${hhmm(s.lastSave)} — الرسائل حتى ${s.summarizedUpTo}.` : T("لم يُحفظ ملخص بعد.");
      }
      // cost and where the text was read from: behind «Details», at the end
      if (s.lastCost && !v.unreadable)
        tech += T`<span class="muted">كلفة آخر تلخيص: الطلب ${fmt(s.lastCost.req)} حرفاً والرد ${fmt(s.lastCost.rep)} ≈ ${fmt(cost)} توكن${s.costTotal && s.costTotal.n > 1 ? T`؛ في هذه المحادثة ${s.costTotal.n} تلخيصات ≈ ${fmt(tokens(s.costTotal.chars))} توكن` : ""} (تقدير). ${v.byok ? T("يُحتسب على مفتاحك، لا على رسائلك في الموقع.") : T("ويبقى الطلب ورده في سياق المحادثة.")}</span>`;
      if (s.note && !v.unreadable) info += `<br><span class="muted">${esc(s.note)}</span>`;
      if (v.empty && v.empty.length && !v.unreadable)
        info += T`<br><span class="muted">${v.empty.length === 1 ? T`رسالتك رقم ${v.empty[0]}` : T`رسائلك رقم ${v.empty.join(T("، "))}`} بلا نص مقروء (صورة أو ملف)؛ لا يُحفظ منها إلا ما يذكره الرد عنها.</span>`;
      if (!v.unreadable) {
        const left = Math.max(0, settings.every - since);
        info +=
          T`<br><span class="muted">${manual ? T("الوضع اليدوي: لا يُطلب ملخص إلا بالزر.") : s.status === "error" ? "" : `${left ? T`التلخيص القادم بعد ${n(left, "msgGen")}.` : T("حان وقت التلخيص.")}`} النص الكامل يُحفظ بعد كل رد.` +
          `${!manual && settings.paused ? T(" (التلخيص التلقائي متوقف)") : ""}${v.noComposer ? T(" لا أجد خانة الكتابة.") : ""}</span>`;
        if (v.userCount > s.summarizedUpTo && !s.pending)
          btns[s.status === "error" ? "unshift" : "push"]([T("💾 لخّص واحفظ الآن"), "summarize"]);
        if (settings.mode === "auto")
          btns.push([settings.paused ? T("▶️ تشغيل التلخيص التلقائي") : T("⏸️ إيقاف التلخيص التلقائي"), "pause", "sec"]);
      }
      if (v.src === "data" && !v.unreadable) tech += `${tech ? "<br>" : ""}<span class="muted">${VIA_DATA()}</span>`;
      btns.push([T("📥 ضع الذاكرة في خانة الكتابة"), "insert"], SHARE());
      if (v.unreadable || v.src === "data") btns.push([...REPORT(), "sec"]);
      btns.push([T("🕘 سجل التغييرات"), "history", "sec"]);
      btns.push([T("↩️ تراجع عن آخر تغيير"), "undo", "sec"]);
      btns.push([T("⏹️ أوقف حفظ هذه المحادثة"), "unlink", "sec"]);
    }
    // decisions saved without evidence in the conversation wait for the user: said once, with one button
    const rv = (v.phase === "chat" || v.phase === "new") && v.review ? v.review.length : 0;
    if (rv) {
      text += ` · 🔎${rv}`;
      info += `<br><span class="muted">${rv === 1 ? T("🔎 عندي سؤال واحد قبل أن أعتمد شيئاً باسمك.") : rv === 2 ? T("🔎 عندي سؤالان قبل أن أعتمد شيئاً باسمك.") : rv <= 10 ? T`🔎 عندي ${rv} أسئلة قبل أن أعتمد شيئاً باسمك.` : T`🔎 عندي ${rv} سؤالاً قبل أن أعتمد شيئاً باسمك.`}</span>`;
      btns.splice(btns[0] && btns[0][1] === "summarize" && s.status === "error" ? 1 : 0, 0, REVIEW(rv));
    }
    if (tech) info += `<details class="tech"><summary>${T("التفاصيل")}</summary>${tech}</details>`;
    if (v.crash) {
      cls = "err";
      info = T("خطأ داخلي: ") + esc(v.crash);
    }
    btns.push([T("⚙️ الإعدادات"), "options", "sec"]);
    return { cls, text, info, btns };
  }

  // opts: { onAction(name), onPinSave(name, text), validPinName(name), why, maxAttempts }
  function create(opts) {
    const host = document.createElement("div");
    host.id = "cm-memory-indicator";
    const shadow = host.attachShadow({ mode: opts.test ? "open" : "closed" }); // open only on the local test pages
    shadow.innerHTML = T`<style>${CSS}</style><button class="pill idle" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="cm-panel">🧠 …</button><div class="panel" id="cm-panel" role="dialog" aria-label="ذاكرة المحادثة"></div><div class="toast" role="status" aria-live="polite"></div>`;
    const real = (e) => e.isTrusted; // a click or key from the person, not from a page script
    const pill = shadow.querySelector(".pill"),
      panel = shadow.querySelector(".panel"),
      toastEl = shadow.querySelector(".toast");
    // keys typed in our panel must not reach the site's own shortcuts ("type anywhere to focus the composer")
    for (const ev of ["keydown", "keyup", "keypress", "input", "beforeinput", "paste"])
      shadow.addEventListener(ev, (e) => e.stopPropagation());
    let pinDraft = null,
      share = null,
      last = { view: {}, settings: {} };

    // above the pill, or below it while the panel is open, so it never covers the panel's buttons
    const placeToast = () => toastEl.classList.toggle("beside", panel.classList.contains("open"));
    function toast(msg, ms) {
      toastEl.textContent = msg;
      placeToast();
      toastEl.style.display = "block";
      clearTimeout(toast.t);
      toast.t = setTimeout(() => (toastEl.style.display = "none"), ms || 6000);
    }
    function render(view, settings) {
      if (view) last = { view, settings };
      if (!document.body) return;
      if (!host.isConnected) document.body.appendChild(host);
      host.style.setProperty("--cm-dir", en() ? "ltr" : "rtl"); // the panel reads in the interface's language
      // the side away from the site's sidebar: on the right of a left-to-right page, on the left of a right-to-left one
      host.classList.toggle(
        "side-left",
        getComputedStyle(document.documentElement).direction === "rtl" || document.documentElement.dir === "rtl",
      );
      if (pinDraft || share) return; // don't redraw over the pin form or the share panel
      const d = describe(last.view, last.settings, opts.why, opts.maxAttempts);
      pill.className = "pill " + d.cls;
      pill.innerHTML = d.text
        .split(" · ")
        .map((x) => `<bdi>${esc(x)}</bdi>`)
        .join(" · ");
      pill.setAttribute("aria-expanded", String(panel.classList.contains("open")));
      const b = ([t, a]) => `<button type="button" data-a="${a}">${t}</button>`;
      const main = d.btns.filter((x) => x[2] !== "sec"),
        sec = d.btns.filter((x) => x[2] === "sec");
      panel.innerHTML = `<p>${d.info}</p>` + main.map(b).join("") + (sec.length ? `<div class="sec">${sec.map(b).join("")}</div>` : "");
    }
    function closePin() {
      pinDraft = null;
      share = null;
      panel.classList.remove("open", "wide");
      placeToast();
      render();
    }
    function openPin(text) {
      render();
      pinDraft = { text };
      panel.innerHTML =
        T`<p><b>📌 تثبيت النص المحدد حرفياً</b></p><div class="preview"></div>` +
        T`<label class="muted">الاسم (نفس الاسم = نسخة جديدة)<input type="text" maxlength="60" autocomplete="off"></label>` +
        T`<button type="button" data-a="pin-save">حفظ</button><button type="button" data-a="pin-cancel">إلغاء</button>`;
      panel.querySelector(".preview").textContent = text.length > 400 ? text.slice(0, 400) + "…" : text;
      panel.classList.add("open");
      placeToast();
      const input = panel.querySelector("input");
      input.addEventListener("keydown", (e) => {
        if (!real(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          savePin();
        }
        if (e.key === "Escape") closePin();
      });
      setTimeout(() => input.focus(), 0);
    }
    function savePin() {
      if (!pinDraft) return;
      const name = panel.querySelector("input").value.trim();
      if (!opts.validPinName(name)) {
        toast(T("اسم غير صالح: حتى 60 حرفاً، بلا / أو : أو رموز."));
        return;
      }
      const text = pinDraft.text;
      closePin();
      opts.onPinSave(name, text);
    }
    // what waits for review: each with the words it came from and why it was not trusted; approve or reject one at a time
    // each item a plain question: what I understood, your words, and two answers
    const RV = () => ({
      decision: [T("فهمتُ أنك قررت:"), T("✓ نعم، هذا قراري"), T("✕ لا، لم أقرره")],
      recheck: [T("عدّلتَ رسالتك. هل ما زال هذا صحيحاً؟"), T("✓ ما زال صحيحاً"), T("✕ ألغِه")],
      revoke: [T("فهمتُ أنك تريد إلغاء:"), T("✓ نعم، ألغِه"), T("✕ لا، أبقِه")],
      "constraint-add": [T("فهمتُ أنك تريد هذا دائماً:"), T("✓ نعم، احفظه"), T("✕ لا")],
      "constraint-remove": [T("فهمتُ أنك لم تعد تريد:"), T("✓ نعم، احذفه"), T("✕ لا، أبقِه")],
    });
    function openReview(list) {
      render();
      share = { review: true };
      const rvt = RV();
      const item = (d) => {
        const k = rvt[d.kind] || rvt.decision;
        return (
          `<div class="rv"><p><span class="muted">${k[0]}</span><br><b>${esc(d.text)}</b>` +
          `${d.quote ? T`<br><span class="muted">كلامك${d.msg ? T` (رسالتك ${esc(String(d.msg))})` : ""}: ${q(d.quote)}</span>` : ""}` +
          `${d.reason ? T`<br><span class="muted small">لماذا أسأل: ${esc(d.reason)}</span>` : ""}</p>` +
          `<button type="button" data-a="rv-approve" data-id="${esc(d.key)}">${k[1]}</button><button type="button" data-a="rv-revoke" data-id="${esc(d.key)}">${k[2]}</button></div>`
        );
      };
      panel.innerHTML =
        T`<p><b>🔎 هل هذا ما قصدته؟</b><br><span class="muted">لا أحفظ شيئاً باسمك إلا بعد تأكيدك.</span></p>` +
        list.map(item).join("") +
        T`<button type="button" class="link" data-a="pin-cancel">إغلاق</button>`;
      panel.classList.add("open", "wide");
      placeToast();
    }
    // which saved memory to bring into a new chat outside any project (each such chat has its own)
    function openPick(list, onPick) {
      render();
      share = { pick: onPick };
      panel.innerHTML =
        T`<p><b>📚 من أي ذاكرة؟</b><br><span class="muted">اختر ذاكرة المحادثة أو المشروع الذي تكمل منه.</span></p>` +
        list
          .slice(0, 30)
          .map(
            (x) =>
              T`<button type="button" data-a="pick" data-id="${esc(x.scope)}">${esc(x.name)}<br><span class="muted">${esc(x.updated || "")} · ${esc(String(x.decisions))} قرار</span></button>`,
          )
          .join("") +
        T`<button type="button" data-a="pin-cancel">إلغاء</button>`;
      panel.classList.add("open", "wide");
      placeToast();
    }
    // choose parts of the project's memory, see exactly what will be inserted (and its length), then insert — never sent
    // m: the memory; o: { preview(sel) → text, budget, onInsert(text) }
    function openShare(m, o) {
      render();
      share = { o };
      const opt = (kind, val, label, tag) =>
        `<label class="opt"><input type="checkbox" data-k="${kind}" data-v="${esc(val)}"><span>${label}${tag ? ` <span class="tag">${tag}</span>` : ""}</span></label>`;
      const act = m.decisions.filter((d) => d.status === "active");
      const cut = (t, n = 90) => esc(t.length > n ? t.slice(0, n) + "…" : t);
      let h = T`<p><b>📤 انقل معلومات مختارة</b><br><span class="muted">اختر ما تريد وراجع المعاينة، ثم يوضع في خانة الكتابة دون إرسال.</span></p>`;
      if (o.relevant)
        h += `<input type="search" class="find" data-a="share-find" placeholder="${esc(T("عمّ هذه المحادثة؟ أقترح لك ما يخصها"))}" aria-label="${esc(T("اختيار ما يخص مهمة"))}">`;
      h +=
        opt("summary", "1", T("الخلاصة الحالية")) +
        (m.constraints.length ? opt("constraints", "1", T`القيود (${m.constraints.length})`) : "");
      if (act.length)
        h +=
          T`<h4>القرارات</h4>` +
          act.map((d) => opt("decisions", d.id, cut(d.text), d.source === "assistant" ? T("اقتراح لم يُعتمد") : "")).join("");
      if (m.pins.length) h += T`<h4>النصوص المعتمدة</h4>` + m.pins.map((p) => opt("pins", p.name, esc(p.name))).join("");
      const log = m.log.slice(-10).reverse();
      if (log.length)
        h +=
          T`<h4>من السجل</h4>` +
          log
            .map((e) =>
              opt(
                "log",
                e.id,
                `${esc(e.range ? T("الرسائل ") + e.range : e.date || "")}${e.chat ? " · " + cut(e.chat, 30) : ""}: ${cut(e.raised[0] || e.decided[0] || "", 60)}`,
              ),
            )
            .join("");
      h +=
        T`<h4>المعاينة</h4><div class="preview share-prev"></div><div class="count"></div>` +
        T`<button type="button" class="primary" data-a="share-insert">📥 ضعه في خانة الكتابة</button><button type="button" data-a="pin-cancel">إلغاء</button>`;
      panel.innerHTML = h;
      panel.classList.add("open", "wide");
      placeToast();
      update();
    }
    function selection() {
      const sel = { summary: false, constraints: false, decisions: [], pins: [], log: [] };
      for (const c of panel.querySelectorAll("input[type=checkbox]:checked")) {
        const k = c.dataset.k;
        if (k === "summary" || k === "constraints") sel[k] = true;
        else sel[k].push(c.dataset.v);
      }
      return sel;
    }
    function update() {
      if (!share) return;
      const t = share.o.preview(selection());
      share.text = t;
      panel.querySelector(".share-prev").textContent = t || T("(لم تختر شيئاً بعد)");
      panel.querySelector(".count").textContent = T`${t.length.toLocaleString("en-US")} / ${share.o.budget.toLocaleString("en-US")} حرف`;
    }
    panel.addEventListener("change", (e) => {
      if (real(e) && share && e.target && e.target.type === "checkbox") update();
    });
    // typing the task picks what is about it (the user can still tick and untick)
    panel.addEventListener("input", (e) => {
      if (!real(e) || !share || !share.o || !share.o.relevant || !e.target || e.target.dataset.a !== "share-find") return;
      const sel = share.o.relevant(e.target.value);
      for (const c of panel.querySelectorAll("input[type=checkbox]")) {
        const k = c.dataset.k;
        c.checked = k === "summary" || k === "constraints" ? !!sel[k] : (sel[k] || []).includes(c.dataset.v);
      }
      update();
    });
    const setOpen = (on) => {
      panel.classList.toggle("open", on);
      pill.setAttribute("aria-expanded", String(on));
      placeToast();
      if (on) {
        const f = panel.querySelector("button, input");
        if (f) setTimeout(() => f.focus(), 0);
      }
    };
    pill.addEventListener("click", (e) => {
      if (!real(e) || pinDraft || share) return;
      render();
      setOpen(!panel.classList.contains("open"));
    });
    panel.addEventListener("keydown", (e) => {
      if (real(e) && e.key === "Escape") {
        if (pinDraft || share) closePin();
        else setOpen(false);
        pill.focus();
      }
    });
    panel.addEventListener("click", (e) => {
      if (!real(e)) return;
      const b = e.target && e.target.closest && e.target.closest("button[data-a]");
      if (!b) return;
      const a = b.dataset.a;
      if (a === "pin-save") return savePin();
      if (a === "pin-cancel") return closePin();
      if (a === "rv-approve" || a === "rv-revoke") {
        b.disabled = true;
        Promise.resolve(opts.onReview(b.dataset.id, a === "rv-approve" ? "approve" : "reject")).then((r) => {
          if (!share || !share.review) return; // closed meanwhile: leave it closed
          if (!r || !r.ok) {
            b.disabled = false;
            return;
          } // nothing changed: the button works again
          if (r.list && r.list.length) openReview(r.list);
          else closePin();
        });
        return;
      }
      if (a === "pick") {
        const f = share && share.pick;
        closePin();
        if (f) f(b.dataset.id);
        return;
      }
      if (a === "share-insert") {
        if (!share || !share.text) {
          toast(T("اختر شيئاً أولاً."));
          return;
        }
        const { o, text } = share;
        closePin();
        o.onInsert(text);
        return;
      }
      setOpen(false);
      opts.onAction(a);
    });
    return { host, render, toast, openPin, openShare, openReview, openPick };
  }

  (root.CM = root.CM || {}).ui = { create, describe };
})(self);

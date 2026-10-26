# Screenshots of every screen a user meets, for a usability review (not a test: nothing is asserted).
# Uses the e2e harness (the test build of the extension and the fake chat pages).
# Usage: python3 tests/ux/shots.py <out-dir> [ar|en]
import os, sys
E2E = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "extension", "tests", "e2e.py")
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "shots")
LANG = sys.argv[2] if len(sys.argv) > 2 else "ar"
os.makedirs(OUT, exist_ok=True)
src = open(E2E, encoding="utf8").read()
head = src[: src.index("    # ---------------------------------------------------------------- shared core")]
body = r'''
    if LANG == "en":
        opt.evaluate("l => chrome.storage.local.get('settings').then(({settings = {}}) => chrome.storage.local.set({settings: {...settings, lang: l}}))", "en")
    def shot(p, name, open_panel=True):
        p.set_viewport_size({"width": 1280, "height": 860})
        if open_panel and not p.evaluate("!!document.getElementById('cm-memory-indicator')?.shadowRoot?.querySelector('.panel.open')"):
            p.locator("#cm-memory-indicator .pill").click()
        p.wait_for_timeout(400)
        p.screenshot(path=os.path.join(OUT, f"{LANG}-{name}.png"))
        print("shot", name, flush=True)
    def close(p):
        if p.evaluate("!!document.getElementById('cm-memory-indicator')?.shadowRoot?.querySelector('.panel.open')"):
            p.locator("#cm-memory-indicator .pill").click()
    # settings page and the tour
    opt.evaluate("() => chrome.storage.local.remove('welcomeSeen')"); opt.reload(); opt.wait_for_load_state(); opt.wait_for_timeout(500)
    opt.set_viewport_size({"width": 1280, "height": 1100}); opt.screenshot(path=os.path.join(OUT, f"{LANG}-settings-tour.png"), full_page=True)
    opt.locator("#tourSkip").click()
    # a new chat
    p = ctx.new_page(); p.goto(BASE + new_chat("chatgpt", "/c/ux-1/", "مقهى - ChatGPT"))
    wait(lambda: "🧠" in pill(p) and "…" not in pill(p), 10)
    shot(p, "01-new-chat"); close(p)
    for t in ["نبي نصمم هوية لمقهى صغير", "أفكر في اللون الأزرق", "والميزانية 40 ألف ريال"]: say(p, t)
    shot(p, "02-counting"); close(p)
    for t in ["الخط نختاره بعدين", "تمام"]: say(p, t)
    wait(lambda: "✓" in pill(p), 20)
    shot(p, "03-saved"); close(p)
    say(p, "سؤال جانبي")
    if "🔎" in pill(p) or True:
        p.locator("#cm-memory-indicator .pill").click()
        b = p.locator("#cm-memory-indicator .panel button[data-a=review]")
        if b.count(): b.click(); p.wait_for_timeout(500); shot(p, "04-review", open_panel=False); p.locator("#cm-memory-indicator .panel button[data-a=pin-cancel]").click()
        close(p)
    p.locator("#cm-memory-indicator .pill").click(); p.locator("#cm-memory-indicator .panel button[data-a=share]").click(); p.wait_for_timeout(600)
    shot(p, "05-share", open_panel=False); p.locator("#cm-memory-indicator .panel button[data-a=pin-cancel]").click(); p.wait_for_timeout(300); close(p)
    # a failed summary
    for t in ["رسالة 7", "رسالة 8", "رسالة 9"]: say(p, t)
    p.evaluate("() => { window.__summaryOverride = () => { window.__summaryOverride = null; return 'عذراً، لا أستطيع'; }; }")
    say(p, "رسالة 10")
    wait(lambda: "⚠️" in pill(p), 25)
    shot(p, "06-failed"); close(p)
    p.close()
    # the topic question in a shared memory
    use_folder("ux-shared")
    pa = ctx.new_page(); pa.goto(BASE + new_chat("chatgpt", "/c/ux-a/", "مقهى - ChatGPT")); wait(lambda: "🧠" in pill(pa), 10)
    for i in range(1, 6): say(pa, f"هوية المقهى {i}")
    wait(lambda: "✓" in pill(pa), 20); pa.close()
    pb = ctx.new_page(); pb.goto(BASE + new_chat("chatgpt", "/c/ux-b/", "رحلة - ChatGPT")); wait(lambda: "🧠" in pill(pb), 10)
    for i in range(1, 5): say(pb, f"نخطط رحلة العلا {i}")
    pb.evaluate("() => { window.__summaryOverride = () => { window.__summaryOverride = null; return '⟦ذاكرة:بداية⟧ {\"different\": true} ⟦ذاكرة:نهاية⟧'; }; }")
    say(pb, "نخطط رحلة العلا 5"); wait(lambda: "موضوع آخر" in pill(pb) or "different" in pill(pb).lower() or "❓" in pill(pb), 15)
    shot(pb, "07-topic"); pb.close()
    # an old chat, not linked
    page("chatgpt", "/c/ux-old/", "قديمة - ChatGPT", pre=[1, 2, 3])
    po = ctx.new_page(); po.goto(BASE + "/c/ux-old/"); wait(lambda: "🧠" in pill(po), 10)
    shot(po, "08-unlinked"); po.close()
    # settings: the memory, history, earlier versions
    opt.reload(); opt.wait_for_load_state(); opt.wait_for_timeout(800)
    opt.screenshot(path=os.path.join(OUT, f"{LANG}-settings.png"), full_page=True)
    opt.locator(".tabs button[data-tab=histSec]").click(); opt.wait_for_timeout(600)
    opt.locator("#tools").screenshot(path=os.path.join(OUT, f"{LANG}-settings-history.png"))
    opt.locator(".tabs button[data-tab=bkSec]").click(); opt.wait_for_timeout(600)
    opt.locator("#tools").screenshot(path=os.path.join(OUT, f"{LANG}-settings-versions.png"))
    print("done", flush=True)
    ctx.close()
srv.shutdown()
'''
code = head.replace("def ok(cond, name, extra=\"\"):", "def ok(cond, name, extra=\"\"):\n    return\n    _unused = 0\ndef _ok_unused(cond, name, extra=\"\"):", 1) + body
g = {"__file__": E2E, "__name__": "__main__", "LANG": LANG, "OUT": OUT}
exec(compile(code, E2E, "exec"), g)

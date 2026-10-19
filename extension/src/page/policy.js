/* Pure decisions the page script makes — no DOM, no browser APIs, so they run under Node tests as well (tests/policy.test.js).
 *   rewind(): an edited message or a regenerated reply makes what was summarized after it stale — but only if the change is
 *             still there on a second look (not a flicker while the page redraws), and at most 3 times in 30 minutes.
 *   due():    is a summary due now, and may it be sent automatically?                                                     */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.CM = root.CM || {}).policy = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const CONFIRM_MS = 2500, REWIND_WINDOW_MS = 1800000, MAX_REWINDS = 3, MAX_ATTEMPTS = 3;

  // st: { summarizedUpTo, hashes[], rhashes[], suspect, rewinds[] }; uh/rh: current fingerprints (your text / your text + replies)
  // → { action: "none" | "watch" | "rewind" | "capped", k?, kind?, suspect? }  (never mutates st)
  function rewind(st, uh, rh, now) {
    const k = (st.rhashes || []).findIndex((h, i) => i < st.summarizedUpTo && h !== rh[i]);
    if (k < 0) return { action: "none", suspect: null };
    const sig = rh.slice(0, st.summarizedUpTo).join();
    const s = st.suspect;
    if (!s || s.k !== k || s.sig !== sig) return { action: "watch", suspect: { k, sig, at: now } };
    if (now - s.at < CONFIRM_MS) return { action: "watch", suspect: s };
    const recent = (st.rewinds || []).filter((t) => now - t < REWIND_WINDOW_MS);
    if (recent.length >= MAX_REWINDS) return { action: "capped", suspect: s, rewinds: recent };
    return { action: "rewind", k, kind: (st.hashes || [])[k] !== uh[k] ? "edit" : "reply", suspect: null, rewinds: [...recent, now] };
  }

  // settings: { every, mode, paused }; st: { summarizedUpTo, attempts, failedAt }
  function due(settings, st, userCount) {
    const isDue = userCount - st.summarizedUpTo >= settings.every;
    const auto = settings.mode === "auto" && !settings.paused && st.attempts < MAX_ATTEMPTS && userCount > st.failedAt;
    return { isDue, auto, unsent: userCount > st.summarizedUpTo };
  }

  return { rewind, due, CONFIRM_MS, MAX_REWINDS, MAX_ATTEMPTS };
});

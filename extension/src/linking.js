/* Which chat may join the project on its own — pure logic, shared by content.js and the Node tests (tests/linking.test.js).
 * A chat is linked automatically only with proof that you created it in this tab: on a new-chat page you actually sent a
 * message (Enter or the send button), and the chat's one and only message is exactly that text. The proof is used once. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CMLink = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const WINDOW_MS = 120000;
  const norm = (t) => String(t == null ? "" : t).replace(/\s+/g, " ").trim();
  // the message you sent from a new-chat page (null if the composer was empty)
  const proofFromSend = (composerText, now) => { const text = norm(composerText); return text ? { text, at: now } : null; };
  // { link, consume }: link this chat? consume the proof?
  function decide({ proof, now, autoLink, userMessages }) {
    const ok = autoLink !== false && !!proof && now - proof.at >= 0 && now - proof.at < WINDOW_MS &&
      Array.isArray(userMessages) && userMessages.length === 1 && norm(userMessages[0]) === proof.text;
    return { link: ok, consume: ok };
  }
  return { WINDOW_MS, norm, proofFromSend, decide };
});

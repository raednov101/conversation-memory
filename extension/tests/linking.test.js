// node --test tests/linking.test.js   — runs without a browser
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/linking.js");

test("a draft typed but never sent is no proof: the old one-message chat opened next is not linked", () => {
  const proof = null;   // typing alone records nothing; only Enter/the send button calls proofFromSend
  assert.deepEqual(L.decide({ proof, now: 1000, autoLink: true, userMessages: ["رسالة قديمة وحيدة"] }), { link: false, consume: false });
});
test("a sent message links only the chat whose one message is exactly that text", () => {
  const proof = L.proofFromSend("  رسالتي   الجديدة \n", 1000);
  assert.equal(L.decide({ proof, now: 2000, autoLink: true, userMessages: ["رسالة قديمة مختلفة"] }).link, false, "another chat");
  assert.equal(L.decide({ proof, now: 2000, autoLink: true, userMessages: ["رسالتي الجديدة", "ثانية"] }).link, false, "more than one message");
  assert.deepEqual(L.decide({ proof, now: 2000, autoLink: true, userMessages: ["رسالتي الجديدة"] }), { link: true, consume: true }, "the created chat (whitespace-insensitive)");
});
test("the proof expires after two minutes, is refused if auto-link is off, and an empty send is no proof", () => {
  const proof = L.proofFromSend("مرحبا", 0);
  assert.equal(L.decide({ proof, now: L.WINDOW_MS, autoLink: true, userMessages: ["مرحبا"] }).link, false);
  assert.equal(L.decide({ proof, now: 5, autoLink: false, userMessages: ["مرحبا"] }).link, false);
  assert.equal(L.proofFromSend("   ", 0), null);
  assert.equal(L.decide({ proof: { text: "مرحبا", at: 10 }, now: 5, autoLink: true, userMessages: ["مرحبا"] }).link, false, "clock went backwards");
});
test("used once: after linking, the same proof is consumed by the caller", () => {
  let proof = L.proofFromSend("نص", 0);
  const d = L.decide({ proof, now: 1, autoLink: true, userMessages: ["نص"] });
  if (d.consume) proof = null;
  assert.equal(L.decide({ proof, now: 2, autoLink: true, userMessages: ["نص"] }).link, false);
});
test("content.js links a chat in exactly two places: this rule, and your click on «🔗 اربطها بالذاكرة»", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "content.js"), "utf8");
  const sets = (src.match(/linked\s*[:=]\s*[^,;}]+/g) || []).filter((x) => !/[:=]\s*false\s*$/.test(x));
  assert.deepEqual(sets.map((x) => x.replace(/\s+/g, " ")), ["linked = d.link", "linked: true"], sets.join(" | "));
  assert.match(src, /a === "link" \? \{ linked: true/, "the only literal true is the link button");
  assert.doesNotMatch(src, /typedOnNew|"input", \(e\) =>/, "typing is not used as proof");
});

// node --test tests/   — reading a conversation from the sites' own data (pure parsing; no network)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
globalThis.self = globalThis;
require("../src/page/sitedata.js");
const { chatgptTurns, claudeTurns } = self.CM.sitedata;

test("ChatGPT: only the visible branch, in order; hidden, system, tool and reasoning messages left out; pieces of one reply joined", () => {
  const n = (id, parent, role, parts, extra = {}) => ({ id, parent, message: role && { author: { role }, content: { content_type: extra.ct || "text", parts }, metadata: extra.md || {}, recipient: extra.rcp || "all" } });
  const j = { current_node: "a3", mapping: {
    r: n("r", null, null), s: n("s", "r", "system", ["x"]), h: n("h", "s", "user", ["مخفي"], { md: { is_visually_hidden_from_conversation: true } }),
    u1: n("u1", "h", "user", ["سؤال"]), a1: n("a1", "u1", "assistant", ["جواب"]), alt: n("alt", "u1", "assistant", ["جواب متروك"]),
    u2: n("u2", "a1", "user", [{ text: "سؤال بصورة" }, { asset_pointer: "file://x" }], { ct: "multimodal_text" }),
    t: n("t", "u2", "assistant", ["search()"], { rcp: "browser" }), th: n("th", "t", "assistant", ["تفكير"], { ct: "thoughts" }),
    a2: n("a2", "th", "assistant", ["الجزء الأول"]), a3: n("a3", "a2", "assistant", ["والثاني"]) } };
  assert.deepEqual(chatgptTurns(j), [{ role: "user", text: "سؤال" }, { role: "assistant", text: "جواب" }, { role: "user", text: "سؤال بصورة" }, { role: "assistant", text: "الجزء الأول\nوالثاني" }]);
  assert.equal(chatgptTurns({}), null, "an unknown shape is «can't read», never an empty chat");
  assert.equal(chatgptTurns({ current_node: "x", mapping: { x: { id: "x", parent: "x" } } }).length, 0, "a loop in the tree ends");
});

test("claude.ai: the branch ending at the current leaf; text blocks only (no thinking, no tools)", () => {
  const j = { current_leaf_message_uuid: "m4", chat_messages: [
    { uuid: "m1", parent_message_uuid: "root", sender: "human", index: 0, text: "سؤال" },
    { uuid: "m2", parent_message_uuid: "m1", sender: "assistant", index: 1, content: [{ type: "thinking", thinking: "…" }, { type: "tool_use", name: "x" }, { type: "text", text: "جواب" }] },
    { uuid: "mx", parent_message_uuid: "m2", sender: "human", index: 2, text: "فرع متروك" },
    { uuid: "m3", parent_message_uuid: "m2", sender: "human", index: 2, content: [{ type: "text", text: "سؤال ثانٍ" }] },
    { uuid: "m4", parent_message_uuid: "m3", sender: "assistant", index: 3, text: "جواب ثانٍ" }] };
  assert.deepEqual(claudeTurns(j), [{ role: "user", text: "سؤال" }, { role: "assistant", text: "جواب" }, { role: "user", text: "سؤال ثانٍ" }, { role: "assistant", text: "جواب ثانٍ" }]);
  assert.equal(claudeTurns({ chat_messages: [{ uuid: "b", sender: "assistant", index: 1, text: "2" }, { uuid: "a", sender: "human", index: 0, text: "1" }] }).map((t) => t.text).join(), "1,2", "no leaf: the site's order");
  assert.equal(claudeTurns({ messages: [] }), null);
});

test("a message of yours with no text (an image, a file) still counts, so messages are numbered as on the page", () => {
  const j = { chat_messages: [{ uuid: "a", sender: "human", index: 0, text: "", content: [{ type: "image" }] }, { uuid: "b", sender: "assistant", index: 1, text: "صورة جميلة" }, { uuid: "c", sender: "human", index: 2, text: "التالي" }] };
  assert.deepEqual(claudeTurns(j).map((t) => t.role), ["user", "assistant", "user"]);
});

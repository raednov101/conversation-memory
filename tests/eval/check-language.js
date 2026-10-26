// Lists eval items whose decision text is in another language than the conversation (the product writes decisions in
// the language of the words they quote). Usage: node tests/eval/check-language.js tests/eval/dev2.json
const f = process.argv[2];
const cases = require(f);
const ar = (t) => (t.match(/[؀-ۿ]/g) || []).length,
  la = (t) => (t.match(/[A-Za-z]/g) || []).length;
const isAr = (t) => ar(t) >= la(t);
let n = 0,
  x = 0;
for (const k of cases) {
  const u = k.turns
    .filter((t) => t.role === "user")
    .map((t) => t.text)
    .join(" ");
  const items = [...(k.draft.decisions?.add || []), ...(k.draft.constraints?.add || [])];
  for (const a of items) {
    n++;
    if (isAr(a.text) !== isAr(u)) x++;
  }
}
console.log(f, "items with text", n, "cross-language", x);

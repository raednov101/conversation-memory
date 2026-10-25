// Static checks for the whole repository: every name defined, nothing unused. Run: npx eslint .
const node = Object.fromEntries(["require","module","process","Buffer","console","__dirname","setTimeout","clearTimeout","setInterval","clearInterval","Atomics","SharedArrayBuffer"].map((k) => [k, "readonly"]));
const browser = Object.fromEntries(["window","document","location","navigator","chrome","indexedDB","crypto","Blob","Node","MutationObserver","DataTransfer","ClipboardEvent","KeyboardEvent","InputEvent","Event","TextEncoder","URLSearchParams","URL","self","setTimeout","clearTimeout","setInterval","clearInterval","getComputedStyle","history","fetch","AbortController"].map((k) => [k, "readonly"]));
export default [
  { ignores: ["dist/**", "**/node_modules/**"] },
  { files: ["plugin/**/*.js"], languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: node }, rules: { "no-undef": "error", "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }] } },
  { files: ["extension/**/*.js"], languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: { ...browser, module: "readonly", require: "readonly", __dirname: "readonly" } }, rules: { "no-undef": "error", "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }] } },
  { files: ["**/memory-core.js"], languageOptions: { globals: { self: "readonly" } } },
];

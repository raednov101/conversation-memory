"use strict";
// Small pure helpers.
const fs = require("fs");
const crypto = require("crypto");

// ---------------- small helpers ----------------
// hook.js may have read stdin already (for its fast exits): then that text is used
const readStdin = () => {
  try {
    const raw = typeof global.__cmRaw === "string" ? global.__cmRaw : fs.readFileSync(0, "utf8");
    return JSON.parse(raw || "{}") || {};
  } catch {
    return {};
  }
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lst = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
const sha256 = (t) => crypto.createHash("sha256").update(t).digest("hex");
const nonce = (n = 4) => crypto.randomBytes(n).toString("hex");
const int = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const sid8of = (s) =>
  String(s || "default")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8) || "default";
const today = () => new Date().toLocaleString("sv-SE").slice(0, 16);
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(".", "-").slice(0, 19);
const uid = typeof process.getuid === "function" ? process.getuid() : null;
const normText = (t) =>
  String(t)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
const fullHash = (t) => sha256(normText(t)).slice(0, 24);

module.exports = { readStdin, sleep, lst, sha256, nonce, int, sid8of, today, stamp, uid, normText, fullHash };

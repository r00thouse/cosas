#!/usr/bin/env node
// Print the sticker codes a sheet carries, without running the app (SPEC.md §7.5).
// Usage: node tools/gen-codes.js <start> [n] [--url ORIGIN]
// Codes are printed lowercase because that is exactly the QR payload suffix (§7.5);
// the app stores the uppercase form and accepts either.
import { loadConfig } from "../config.js";
import { sheetCodes, MAX_SHEET } from "../codes.js";

const args = process.argv.slice(2);
const urlAt = args.indexOf("--url");
const urlArg = urlAt >= 0 ? args.splice(urlAt, 2)[1] : undefined;
const [startRaw, nRaw] = args;
const start = Number(startRaw);
const n = nRaw === undefined ? 1 : Number(nRaw);

if (!Number.isInteger(start) || start < 0) {
  console.error("usage: node tools/gen-codes.js <start> [n] [--url ORIGIN]");
  console.error("  start = the first sequence number of the sheet (0 for the first sheet)");
  process.exit(2);
}
if (!Number.isInteger(n) || n < 1 || n > MAX_SHEET) {
  console.error(`n must be an integer between 1 and ${MAX_SHEET}`);
  process.exit(2);
}

let cfg;
try {
  cfg = loadConfig(process.env);
} catch (e) {
  console.error(`config error: ${e.message}`);
  console.error("set CODE_SECRET (>= 32 chars) and PUBLIC_ORIGIN, or use ./dev.sh code <start> [n]");
  process.exit(2);
}
const origin = urlArg || cfg.publicOrigin;
for (const { code, url } of sheetCodes(cfg.codeSecret, origin, start, n)) {
  console.log(`${code.toLowerCase()}\t${url}`);
}
console.error(`# ${n} code(s) starting at ${start}; the next sheet starts at ${start + n}`);

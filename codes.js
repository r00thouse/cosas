// Sheets of stickers (SPEC.md §7.5, §8.7): the one place that turns
// (CODE_SECRET, month, start, n) into codes and QR payloads.
import { readFileSync } from "node:fs";
import { sheetCode, oneOff, monthNow } from "./code.js";

export const MAX_SHEET = 500;

export function parseSheetQuery(searchParams, counter = 0) {
  const hasN = searchParams.has("n");
  const n = hasN ? Number(searchParams.get("n")) : NaN;
  if (!hasN) return { mode: "form", n: 100, start: counter };
  const start = Number(searchParams.get("start") ?? counter);
  const bad = (v) => !Number.isInteger(v) || v < 0;
  if (bad(n) || n < 1 || n > MAX_SHEET || bad(start) || start > 2 ** 30 - 1 || start + n > 2 ** 30) {
    return { mode: "range" };
  }
  return { mode: "sheet", n, start };
}

/** The sticker payload: the short URL, lowercase, no dashes (§7.5). */
export const stickerUrl = (publicOrigin, code) => `${publicOrigin}/r/${code.toLowerCase()}`;

/** [{code, url, text:[l1,l2]}] for a sheet; pure function of its inputs. */
export function sheetCodes(secret, publicOrigin, start, n, month = monthNow()) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const code = sheetCode(secret, month, start, i);
    out.push({ code, url: stickerUrl(publicOrigin, code), text: [code.slice(0, 4), code.slice(4, 8), code.slice(8, 12), code.slice(12, 16)].join("-") });
  }
  return out;
}

/** The next code for a brand-new item (POST /items/new). Uses the current month. */
export function freshCode(secret, seq, month = monthNow()) {
  return oneOff(secret, seq, month);
}

/**
 * codes.counter (§8.7): the next starting number. Read-only convenience used as the
 * form default; nothing depends on it for validity (a code is valid regardless).
 */
export function readCounter(path) {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

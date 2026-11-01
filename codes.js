// Sheets of stickers (SPEC.md §7.5, §8.7): the one place that turns
// (CODE_SECRET, month, n) into codes and QR payloads.
import { randomCode, monthNow, pretty } from "./code.js";

export const MAX_SHEET = 500;

/** `?n=` only: there is no starting number any more, the codes are random (§7.5). */
export function parseSheetQuery(searchParams) {
  const hasN = searchParams.has("n");
  if (!hasN) return { mode: "form", n: 100 };
  const n = Number(searchParams.get("n"));
  if (!Number.isInteger(n) || n < 1 || n > MAX_SHEET) return { mode: "range" };
  return { mode: "sheet", n };
}

/** The sticker payload: the short URL, lowercase, no dashes (§7.5). */
export const stickerUrl = (publicOrigin, code) => `${publicOrigin}/r/${code.toLowerCase()}`;

/**
 * [{code, url, text}] for one sheet, all distinct. Random every time: generating a
 * sheet twice gives different stickers, which is the point (§7.3 — no sequence).
 */
export function sheetCodes(secret, publicOrigin, n, month = monthNow()) {
  const seen = new Set();
  const out = [];
  while (out.length < n) {
    const code = randomCode(secret, month);
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code, url: stickerUrl(publicOrigin, code), text: pretty(code) });
  }
  return out;
}

/** The code for a brand-new item (POST /items/new) or a rebind. */
export const freshCode = (secret, month = monthNow()) => randomCode(secret, month);

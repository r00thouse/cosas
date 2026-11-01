// Sticker codes (SPEC.md §7): 16 Crockford-base32 chars, HMAC-signed, never sequential.
//   MM SSSSSS NNNN HHHH
//     MM      month index (year-2020)*12 + (month-1), 10 bits
//     SSSSSS  batch sequence, 30 bits (informational: what a sheet would have printed)
//     NNNN    nonce, 20 bits (derived for a sheet, random for a one-off item)
//     HHHH    first 20 bits of HMAC-SHA256(key, "v1" + MM+SSSSSS+NNNN)
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BATCH_PREFIX = "hacklab-cosas/batch/v1:";
const KEY_LABEL = "hacklab-cosas/code/v1";

const keyCache = new Map();
function key(secret) {
  let k = keyCache.get(secret);
  if (!k) {
    k = createHmac("sha256", secret).update(KEY_LABEL).digest();
    keyCache.set(secret, k);
  }
  return k;
}

const pow32 = (w) => 32 ** w;

/** value -> exactly `w` Crockford chars, most significant first. */
export function encode(value, w) {
  let out = "";
  for (let i = w - 1; i >= 0; i--) out += ALPHABET[Math.floor(value / pow32(i)) % 32];
  return out;
}

/**
 * base32 chars -> the §7.2 field value: the characters read as one big-endian base32
 * integer, truncated to the low `bits` (non-power-of-two widths included).
 */
export function fieldValue(chars, bits) {
  let v = 0;
  for (const c of chars) {
    const d = ALPHABET.indexOf(c.toUpperCase());
    if (d < 0) return null;
    v = v * 32 + d;
  }
  return v % 2 ** bits;
}

/**
 * Human/URL input -> canonical 16-char uppercase code, or null.
 * Tolerates lowercase, dashes, spaces and the classic confusables (I/L->1, O->0, U->V).
 */
export function normalize(input) {
  if (typeof input !== "string" || input.length > 64) return null;
  let out = "";
  for (const ch of input) {
    if (ch === "-" || ch === " ") continue;
    const c = ch.toUpperCase();
    if (c === "I" || c === "L") out += "1";
    else if (c === "O") out += "0";
    else if (c === "U") out += "V";
    else if (ALPHABET.includes(c)) out += c;
    else return null;
  }
  return out.length === 16 ? out : null;
}

/** The printed/stored form: 4 groups of 4. Cosmetic only. */
export const pretty = (code) => `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12, 16)}`;
/** Two lines of 9 characters, as printed on a 60x30 mm sticker (§7.5): "MMMM-MMMM-" then "MMMM-MMMM". */
export const stickerLines = (code) => [pretty(code).slice(0, 9), pretty(code).slice(10)];

const monthNow = () => {
  const d = new Date();
  return (d.getUTCFullYear() - 2020) * 12 + d.getUTCMonth();
};

function tagValue(secret, body) {
  const mac = createHmac("sha256", key(secret)).update(`v1${body}`).digest();
  return (((mac[0] << 16) | (mac[1] << 8) | mac[2]) >> 4) & 0xfffff;
}

/** The 12-char signed body for (mm, seq, nonce). */
function body(mm, seq, nonce) {
  return encode(mm % 2 ** 10, 2) + encode(seq % 2 ** 30, 6) + encode(nonce % 2 ** 20, 4);
}

/** The §7.4/§7.5 deterministic nonce for sticker `i` of the sheet starting at `start`. */
export function batchNonce(secret, start, i) {
  const mac = createHmac("sha256", secret).update(`${BATCH_PREFIX}${start}:${i}`).digest();
  return mac.readUIntBE(0, 3) >> 4;
}

/** build(mm, seq, nonce) -> canonical code */
export function build(secret, mm, seq, nonce) {
  const b = body(mm, seq, nonce);
  return b + encode(tagValue(secret, b), 4);
}

/**
 * Code `i` (0-based) of the sheet that starts at sequence `start` (§7.4/§7.5):
 * sheetCode(secret, monthIndex, start, i). `start + i` must be < 2**30.
 */
export function sheetCode(secret, monthIndex, start, i) {
  if (start + i >= 2 ** 30) throw new RangeError("sequence counter exhausted (2^30)");
  return build(secret, monthIndex, start + i, batchNonce(secret, start, i));
}

/** One standalone code (a brand-new item): random nonce, seq from the counter. */
export function oneOff(secret, seq, monthIndex = monthNow()) {
  return build(secret, monthIndex, seq, randomInt(0, 2 ** 20));
}

/**
 * Verify + decode. Returns {code, mm, seq, nonce} for a valid code, null otherwise.
 * Normalizes first, then checks the HMAC, then decodes (never trust unverified input).
 */
export function parse(secret, input) {
  const code = normalize(input);
  if (!code) return null;
  const bodyChars = code.slice(0, 12);
  const got = Buffer.alloc(4);
  got.writeUInt32BE(fieldValue(code.slice(12), 20));
  const want = Buffer.alloc(4);
  want.writeUInt32BE(tagValue(secret, bodyChars));
  if (!timingSafeEqual(got, want)) return null;
  return {
    code,
    mm: fieldValue(bodyChars.slice(0, 2), 10),
    seq: fieldValue(bodyChars.slice(2, 8), 30),
    nonce: fieldValue(bodyChars.slice(8, 12), 20),
  };
}

export const isValid = (secret, input) => parse(secret, input) !== null;
export { monthNow };

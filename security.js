// Cookie signing, CSRF tokens, the per-IP rate limiter and client-IP resolution
// (SPEC.md §4.4, §4.5, §5.1, §5.4). No dependencies.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** `<base64url(JSON)>.<base64url(HMAC)>` — the scheme shared by `session` and `oidc_tx`. */
export function sign(secret, payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

/** Verified payload, or null when the signature is wrong, malformed or expired. */
export function unsign(secret, value, now = Date.now()) {
  if (typeof value !== "string" || value.length > 4096) return null;
  const dot = value.indexOf(".");
  if (dot < 1 || value.indexOf(".", dot + 1) !== -1) return null;
  const body = value.slice(0, dot);
  const mac = Buffer.from(value.slice(dot + 1), "base64url");
  const want = createHmac("sha256", secret).update(body).digest();
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
  return payload;
}

/**
 * CSRF = base64url(HMAC(SESSION_SECRET, "csrf:" + cookie signature)) (§5.1, padded to
 * two Crockford-ish groups). Never truncate below the full 32-byte MAC: 22 base64url
 * chars is only 132 bits, but the real bug this fixed was comparing strings that were
 * *different in the page* vs *in the validator* — keep one function, call it twice.
 */
export function csrfFor(secret, sessionCookie) {
  const dot = sessionCookie.indexOf(".");
  const sig = dot < 0 ? "" : sessionCookie.slice(dot + 1);
  return b64url(createHmac("sha256", secret).update(`csrf:${sig}`).digest());
}

export function csrfValid(secret, sessionCookie, given) {
  if (!sessionCookie || typeof given !== "string" || given.length === 0) return false;
  const want = Buffer.from(csrfFor(secret, sessionCookie));
  const got = Buffer.from(given);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A random secret, e.g. for the `state` parameter of the OIDC flow. */
export function newSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Client IP for rate limiting (§5.4). With TRUST_PROXY=1 the key is the *last*
 * X-Forwarded-For entry (what our own nginx appended); never the first, which the
 * client controls.
 */
export function clientIp(socketAddr, xff, trustProxy) {
  if (!trustProxy) return socketAddr || "unknown";
  if (typeof xff === "string" && xff.trim() !== "") {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return socketAddr || "unknown";
}

/**
 * Fixed-window limiter: limit requests per windowMs per key. One Map, swept lazily.
 * Returns { ok, retryAfter, remaining }.
 */
export function createLimiter({ limit, windowMs, sweepMs = 300_000, now = () => Date.now() }) {
  const buckets = new Map();
  let lastSweep = now();
  return function hit(key) {
    const t = now();
    if (t - lastSweep > sweepMs) {
      for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
      lastSweep = t;
    }
    let b = buckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    const retryAfter = Math.max(1, Math.ceil((b.resetAt - t) / 1000));
    return { ok: b.count <= limit, retryAfter, remaining: Math.max(0, limit - b.count) };
  };
}

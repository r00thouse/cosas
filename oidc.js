// Minimal OpenID Connect client for Kanidm (SPEC.md §4.3, §5.3):
// discovery, authorization-code + PKCE (S256), Basic-auth token exchange, ES256
// id_token verification against the issuer JWKS. ~180 lines, no dependencies.
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

const JWKS_TTL_MS = 60 * 60 * 1000;

export class OidcError extends Error {
  constructor(kind, detail) {
    super(`${kind}${detail ? `: ${detail}` : ""}`);
    this.kind = kind;
  }
}

const b64urlJson = (part) => {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new OidcError("malformed_jwt");
  }
};

export async function fetchJson(url, init, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, redirect: "error" });
    if (!res.ok) throw new OidcError("http_status", `${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class OidcClient {
  /**
   * @param {object} cfg loadConfig() result
   * @param {(level,msg,fields?)=>void} log
   */
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.discovery = null;
    this.discoveryPromise = null;
    this.jwks = null;
    this.jwksAt = 0;
    this.jwksPromise = null;
  }

  async init() {
    // `skipDiscoveryCheck` (env SKIP_DISCOVERY_CHECK=1) boots without an IdP: the
    // fetch is deferred to the first /login instead of killing the process (§10.1).
    if (this.cfg.skipDiscoveryCheck) {
      this.log("warn", "oidc.discovery_skipped", { url: this.cfg.oidcDiscoveryUrl });
      return;
    }
    await this.ensureDiscovery();
  }

  /** Fetch and validate the discovery document, once. */
  async ensureDiscovery() {
    if (this.discovery) return this.discovery;
    if (this.discoveryPromise) return this.discoveryPromise;
    this.discoveryPromise = (async () => {
      const doc = await fetchJson(this.cfg.oidcDiscoveryUrl);
      for (const k of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"]) {
        if (typeof doc[k] !== "string" || !doc[k]) throw new OidcError("bad_discovery", k);
      }
      if (this.cfg.oidcIssuer && doc.issuer !== this.cfg.oidcIssuer) {
        throw new OidcError("issuer_mismatch", `expected ${this.cfg.oidcIssuer}, got ${doc.issuer}`);
      }
      this.discovery = doc;
      await this.getJwks();
      this.log("info", "oidc.discovery", { issuer: doc.issuer });
      return doc;
    })();
    try {
      return await this.discoveryPromise;
    } finally {
      this.discoveryPromise = null;
    }
  }

  redirectUri() {
    return `${this.cfg.publicOrigin}/oidc/callback`;
  }

  /** The authorization URL; `state` and `challenge` come from the oidc_tx cookie. */
  async authorizeUrl(state, challenge) {
    await this.ensureDiscovery();
    const u = new URL(this.discovery.authorization_endpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.cfg.oidcClientId);
    u.searchParams.set("redirect_uri", this.redirectUri());
    u.searchParams.set("scope", this.cfg.oidcScopes);
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
  }

  async getJwks(force = false) {
    await this.ensureDiscovery();
    if (!force && this.jwks && Date.now() - this.jwksAt < JWKS_TTL_MS) return this.jwks;
    if (this.jwksPromise) return this.jwksPromise; // single-flight
    this.jwksPromise = (async () => {
      const doc = await fetchJson(this.discovery.jwks_uri);
      if (!Array.isArray(doc.keys)) throw new OidcError("bad_jwks");
      this.jwks = doc.keys;
      this.jwksAt = Date.now();
      return this.jwks;
    })();
    try {
      return await this.jwksPromise;
    } finally {
      this.jwksPromise = null;
    }
  }

  async keyFor(kid) {
    let key = (await this.getJwks()).find((k) => k.kid === kid);
    if (!key) key = (await this.getJwks(true)).find((k) => k.kid === kid); // one refresh on miss
    if (!key) throw new OidcError("unknown_kid", kid);
    if (key.kty !== "EC" || key.crv !== "P-256") throw new OidcError("unsupported_key");
    return key;
  }

  /**
   * Verifies the id_token and returns its claims. Throws OidcError on any problem:
   * wrong alg, bad signature, wrong iss/aud, expired.
   */
  async verifyIdToken(idToken) {
    if (typeof idToken !== "string") throw new OidcError("no_id_token");
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new OidcError("malformed_jwt");
    const header = b64urlJson(parts[0]);
    const claims = b64urlJson(parts[1]);
    if (header.alg !== "ES256") throw new OidcError("bad_alg", String(header.alg));
    const jwk = await this.keyFor(header.kid);
    const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
    const ok = verify(
      "sha256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(parts[2], "base64url"),
    );
    if (!ok) throw new OidcError("bad_signature");

    const now = Math.floor(Date.now() / 1000);
    await this.ensureDiscovery();
    if (claims.iss !== this.discovery.issuer) throw new OidcError("bad_iss");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.cfg.oidcClientId)) throw new OidcError("bad_aud");
    if (typeof claims.exp !== "number" || claims.exp <= now - 60) throw new OidcError("expired");
    if (typeof claims.nbf === "number" && claims.nbf > now + 60) throw new OidcError("not_yet_valid");
    if (typeof claims.sub !== "string" || !claims.sub) throw new OidcError("no_sub");

    return { sub: claims.sub, claims };
  }

  /** Exchange the authorization code (Basic client auth + verifier), return claims. */
  async exchange(code, verifier) {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri(),
      code_verifier: verifier,
    });
    const basic = Buffer.from(
      `${encodeURIComponent(this.cfg.oidcClientId)}:${encodeURIComponent(this.cfg.oidcClientSecret)}`,
    ).toString("base64");
    await this.ensureDiscovery();
    let tok;
    try {
      tok = await fetchJson(this.discovery.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
        body: form.toString(),
      });
    } catch (e) {
      throw new OidcError("token_rejected", e.message);
    }
    const verified = await this.verifyIdToken(tok.id_token);
    // Kanidm may put groups/name in the userinfo response instead of the id_token. Read
    // both and let userinfo fill the gaps; a failure here must not break the login.
    const info = await this.tryUserinfo(tok.access_token);
    const claims = mergeClaims(verified.claims, info);
    return {
      sub: verified.sub,
      name: claims.preferred_username || claims.name || claims.email || claims.sub,
      role: roleFromClaims(claims, this.cfg.oidcAdminGroup),
      claims,
      sources: { userinfo: Boolean(info) },
    };
  }

  /** userinfo is optional: missing endpoint, bad token or a 5xx all mean "no extra claims". */
  async tryUserinfo(accessToken) {
    if (!accessToken) return null;
    try {
      await this.ensureDiscovery();
      if (!this.discovery.userinfo_endpoint) return null;
      return await fetchJson(this.discovery.userinfo_endpoint, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
    } catch (e) {
      this.log("warn", "oidc.userinfo_failed", { error: e.message });
      return null;
    }
  }
}

/** §5.3 step 6: decide the role from the token claims.
 *
 * 1. An explicit `roles` claim wins both ways: `["admin"]` is an admin, anything else is
 *    a reader. Only a claim map that emits `role` produces this.
 * 2. Otherwise, if OIDC_ADMIN_GROUP is configured, membership of that group decides.
 * 3. Otherwise the v1 default: whoever Kanidm let in is an admin.
 *
 * `groups` is deliberately NOT read without (2): Kanidm sends the person's real group
 * names ("inventory_users", ...), so treating `groups` as a role list demoted every
 * real deployment to read-only while the dev mock — whose group happened to be called
 * "admin" — kept working.
 */
export function roleFromClaims(claims, adminGroup = "") {
  const list = (raw) =>
    (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/) : []).map((v) => String(v));
  const roles = claims.roles;
  if (roles !== undefined && roles !== null) {
    return list(roles).includes("admin") ? "admin" : "member";
  }
  if (adminGroup) {
    return groupNames(claims.groups).includes(adminGroup.trim().toLowerCase()) ? "admin" : "member";
  }
  return "admin";
}

/**
 * id_token claims win for the protocol fields; userinfo fills in profile/group claims.
 * Real Kanidm deployments differ in which of the two carries `groups` (SPEC.md §5.3).
 */
export function mergeClaims(idClaims, infoClaims) {
  const protocolFields = new Set(["iss", "aud", "exp", "iat", "nbf", "nonce", "sub", "azp"]);
  if (!infoClaims) return idClaims;
  const merged = { ...idClaims };
  for (const [key, value] of Object.entries(infoClaims)) {
    if (protocolFields.has(key)) continue;
    if (value === undefined || value === null || value === "") continue;
    merged[key] = value;
  }
  return merged;
}

/** Everything needed to explain a role decision in the logs, and nothing secret. */
export function roleDiagnostics(claims, adminGroup = "") {
  const groups = claims?.groups ?? null;
  return {
    claims: Object.keys(claims || {}).sort(),
    roles: claims?.roles ?? null,
    groups,
    group_names: groupNames(groups),
    admin_group: adminGroup || null,
    role: roleFromClaims(claims, adminGroup),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Kanidm's `groups` claim is shaped by the requested scope (§4.2): `groups_name`
 * yields bare names, `groups` yields uuids AND spns, `groups_spn` yields spns.
 * Normalise all three to lowercase bare names so one comparison works everywhere.
 */
export function groupNames(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/) : [];
  return list
    .map((v) => String(v).trim().toLowerCase())
    .filter((v) => v && !UUID_RE.test(v))
    .map((v) => v.replace(/@.*$/, ""));
}

/** PKCE pair (§4.3): 32 random bytes -> 43-char base64url verifier, S256 challenge. */
export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** OIDC `next` allowlist (§10.3): `/` or `/r/...`, no scheme, no `//`, quiet charset. */
export function safeNext(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  if (!/^[A-Za-z0-9/_.?=&%-]+$/.test(value)) return "/";
  const path = value.split("?")[0];
  // Percent-decoding must not smuggle in a traversal or a scheme: "%2e%2e", "%2F%2F"
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "/";
  }
  if (/[\\]/.test(decoded) || decoded.includes("//") || /(^|\/)\.\.(\/|$)/.test(decoded)) return "/";
  return path.startsWith("/r/") || path === "/" ? value : "/";
}

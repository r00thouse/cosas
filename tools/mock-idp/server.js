// Mock Kanidm IdP — DEV/TEST ONLY. Never deploy this (SPEC.md §11).
// Mimics the parts of Kanidm's OIDC endpoints the app uses: per-client discovery,
// an auto-submitting authorization endpoint (no login form), an HTTP-Basic token
// endpoint that enforces PKCE S256, and an ES256 JWKS. Zero dependencies.
import { createServer } from "node:http";
import { createECDH, createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";

const PORT = Number(process.env.PORT || 9010);
const CLIENT_ID = process.env.MOCK_CLIENT_ID || "cosas";
const CLIENT_SECRET = process.env.MOCK_CLIENT_SECRET || "dev-client-secret";
const MOCK_PUBLIC_URL = (process.env.MOCK_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const MODE = process.env.MOCK_MODE || "ok";
// Kanidm puts the client id into the issuer path; the app compares `iss` to this.
const ISSUER = `${MOCK_PUBLIC_URL}/oauth2/openid/${CLIENT_ID}`;
// What the app container uses server-to-server; defaults to the public URL for local runs.
const INTERNAL_URL = (process.env.MOCK_INTERNAL_URL || MOCK_PUBLIC_URL).replace(/\/+$/, "");
const PUBLIC_URL = MOCK_PUBLIC_URL;
// `?as=member` at the authorization step issues a token without the admin role, so
// the read-only path (SPEC.md §4.1) can be tried by hand.
const USERS = {
  admin: { sub: "mock-user-uuid-00001", name: "mockadmin", role: "admin" },
  member: { sub: "mock-user-uuid-00002", name: "mockmember", role: "member" },
};
const userFor = (q) => USERS[q.get("as") === "member" ? "member" : "admin"];

// Stable key: the app caches the JWKS for an hour (oidc.js), so a fresh key per restart
// would make every id_token fail signature checks until that cache expired. A fixed dev
// seed keeps the JWKS identical across restarts; production uses Kanidm's real keys.
const SEED = process.env.MOCK_KEY_SEED || "hacklab-cosas mock idp dev key";
const seed = createHash("sha256").update(SEED).digest();
const ecJwk = (() => {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(seed.slice(0, 32));
  const pub = ecdh.getPublicKey(); // 0x04 || X || Y
  return { kty: "EC", crv: "P-256", d: seed.slice(0, 32).toString("base64url"), x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33, 65).toString("base64url") };
})();
const privateKey = createPrivateKey({ key: ecJwk, format: "jwk" });
const publicKey = createPublicKey({ key: ecJwk, format: "jwk" });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "mock-1", alg: "ES256", use: "sig" };

/** code -> { challenge, redirect_uri, created } — in memory, single use, 60 s TTL */
const codes = new Map();

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const text = (res, status, type, body) => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};

function jwt(claims) {
  const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: jwk.kid }));
  const payload = b64url(JSON.stringify(claims));
  const input = `${header}.${payload}`;
  const sig = sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}

function discovery(req) {
  // Kanidm publishes ONE issuer; the app verifies `iss` against it. Kanidm tokens also
  // carry the host the browser used, so a host-less path must behave the same.
  //
  // Two base URLs on purpose (dev only): the browser reaches us at :9010 through the
  // published port, while the app container reaches us as mock-idp:9010. Endpoints the
  // browser calls use MOCK_PUBLIC_URL; endpoints the app calls use MOCK_INTERNAL_URL.
  const base = PUBLIC_URL;
  const internal = INTERNAL_URL;
  return {
    issuer: ISSUER,
    authorization_endpoint: `${base}/oauth2/openid/${CLIENT_ID}/ui/oauth2`,
    token_endpoint: `${internal}/oauth2/token`,
    userinfo_endpoint: `${internal}/oauth2/openid/${CLIENT_ID}/userinfo`,
    jwks_uri: `${internal}/oauth2/openid/${CLIENT_ID}/public_key.jwk`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    id_token_signing_alg_values_supported: ["ES256"],
    scopes_supported: ["openid", "profile", "email"],
  };
}

function authorize(res, q) {
  const mode = q.get("as");
  const user = userFor(q);
  const state = q.get("state") || "";
  const redirect = q.get("redirect_uri") || "";
  if (!/^https?:\/\//.test(redirect)) return text(res, 400, "text/plain", "mock idp: redirect_uri required");

  if (mode === "error") return text(res, 400, "text/html; charset=utf-8", "<p>mock idp: simulated error</p>");
  if (mode === "denied") {
    res.writeHead(302, {
      location: `${redirect}?error=access_denied&error_description=user+denied&state=${encodeURIComponent(state)}`,
    });
    return res.end();
  }
  if (q.get("response_type") !== "code") return text(res, 400, "text/plain", "mock idp: response_type must be code");
  if (q.get("client_id") !== CLIENT_ID) return text(res, 400, "text/plain", "mock idp: unknown client_id");
  if (!q.get("code_challenge")) return text(res, 400, "text/plain", "mock idp: PKCE code_challenge required");
  if (q.get("code_challenge_method") !== "S256") return text(res, 400, "text/plain", "mock idp: PKCE method must be S256");

  const code = randomBytes(24).toString("base64url");
  codes.set(code, { challenge: q.get("code_challenge"), redirect_uri: redirect, created: Date.now(), user });
  const loc = `${redirect}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  // Stands in for Kanidm's login + consent page, which a human completes with their
  // Kanidm password in a real deployment: no dialog, straight back to the app, so
  // `curl -L` (and ./dev.sh test) can complete the whole login without JavaScript.
  res.writeHead(302, { location: loc, "cache-control": "no-store" });
  res.end();
}

async function tokenBody(req, res, body) {
  if (MODE === "wrong-secret") return json(res, 401, { error: "invalid_client" });
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) return json(res, 401, { error: "invalid_client" });
  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep < 0) return json(res, 401, { error: "invalid_client" });
  const id = decodeURIComponent(decoded.slice(0, sep));
  const secret = decodeURIComponent(decoded.slice(sep + 1));
  if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return json(res, 401, { error: "invalid_client" });

  const form = new URLSearchParams(body);
  if (form.get("grant_type") !== "authorization_code") return json(res, 400, { error: "unsupported_grant_type" });
  const code = form.get("code") || "";
  const tx = codes.get(code);
  codes.delete(code); // single use
  if (!tx) return json(res, 400, { error: "invalid_grant", error_description: "unknown code" });
  if (Date.now() - tx.created > 60_000) return json(res, 400, { error: "invalid_grant", error_description: "expired" });
  if ((form.get("redirect_uri") || "") !== tx.redirect_uri) {
    return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
  }
  const challenge = b64url(createHash("sha256").update(form.get("code_verifier") || "").digest());
  if (challenge !== tx.challenge) {
    return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
  }

  const now = Math.floor(Date.now() / 1000);
  const user = tx.user;
  json(res, 200, {
    access_token: randomBytes(24).toString("base64url"),
    token_type: "Bearer",
    expires_in: 300,
    scope: "openid profile",
    id_token: jwt({
      iss: ISSUER,
      sub: user.sub,
      aud: CLIENT_ID,
      iat: now,
      exp: now + 300,
      preferred_username: user.name,
      name: user.name,
      groups: [user.role],
    }),
  });
}

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  if (req.method === "GET" && p === "/healthz") return text(res, 200, "text/plain", "ok");
  if (req.method === "GET" && p === `/oauth2/openid/${CLIENT_ID}/.well-known/openid-configuration`) {
    return json(res, 200, discovery(req));
  }
  if (req.method === "GET" && p === `/oauth2/openid/${CLIENT_ID}/public_key.jwk`) return json(res, 200, { keys: [jwk] });
  if (req.method === "GET" && p === `/oauth2/openid/${CLIENT_ID}/ui/oauth2`) return authorize(res, url.searchParams);
  if (req.method === "POST" && p === "/oauth2/token") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => tokenBody(req, res, body));
    return;
  }
  json(res, 404, { error: "not_found", path: p });
}).listen(PORT, "0.0.0.0", () => {
  console.log(`mock idp listening on :${PORT} issuer=${ISSUER} mode=${MODE}`);
});

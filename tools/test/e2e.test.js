// In-process end-to-end check of the app (no Docker): mock IdP + app on one port,
// real OIDC flow, real forms. Run: node tools/test/e2e.test.js
// Uses only node:test + fetch (Node 24). Exits non-zero on the first failing check.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 18900;
const IDP = 18901;
const ORIGIN = `http://localhost:${PORT}`;
const SECRETS = {
  SESSION_SECRET: "test-session-secret-that-is-long-enough-000",
  CODE_SECRET: "test-code-secret-that-is-long-enough-00000",
};

let dir;
let app;
let idp;

/** A fetch with a cookie jar. */
function client() {
  const jar = new Map();
  return async function call(path, init = {}, extraCookie = null) {
    const headers = { ...(init.headers || {}) };
    const cookie = [extraCookie || "", ...[...jar].map(([k, v]) => `${k}=${v}`)].filter(Boolean).join("; ");
    if (cookie) headers.cookie = cookie;
    const res = await fetch(ORIGIN + path, { ...init, headers, redirect: "manual" });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (/max-age=0/i.test(sc)) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, setCookie: res.headers.getSetCookie(), text, jar };
  };
}

const csrfOf = (res) => (res.text.match(/name="_csrf" value="([^"]+)"/) || [])[1];
const codesOf = (res) => [...res.text.matchAll(/data-qr="[^"]*\/r\/([0-9a-z]+)"/g)].map((m) => m[1]);

function form(fields) {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() };
}

async function login(as = "admin") {
  const c = client();
  // Warm the rate limiter with a cheap GET so the login POST (also counted under /r/*) fits.
  assert.equal((await c("/r/0000000000000000")).status, 404);
  const start = await c("/login");
  assert.equal(start.status, 302);
  const authUrl = new URL(start.headers.get("location"));
  assert.equal(authUrl.pathname, `/oauth2/openid/cosas/ui/oauth2`);
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  if (as === "member") authUrl.searchParams.set("as", "member");
  // The mock IdP answers the authorization request with a 302 back to redirect_uri
  // (a real Kanidm would show its login page here); follow it like a browser would.
  const idpHost = `127.0.0.1:${IDP}`;
  const authRes = await fetch(authUrl.toString().replace(new URL(authUrl).host, idpHost), { redirect: "manual" });
  assert.equal(authRes.status, 302, "idp redirects straight back to the app");
  const back = new URL(authRes.headers.get("location"));
  const cb = await c(back.pathname + back.search);
  assert.ok(cb.status !== 403, `callback rejected: ${cb.text.replace(/<(style|script)[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200)}`);
  assert.equal(cb.status, 302, `callback should redirect, got ${cb.status}`);
  assert.ok(cb.setCookie.some((sc) => sc.startsWith("session=")), "session cookie set");
  return c;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "cosas-e2e-"));
  idp = spawn(process.execPath, ["tools/mock-idp/server.js"], {
    env: { ...process.env, PORT: String(IDP), MOCK_PUBLIC_URL: `http://localhost:${IDP}` },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    idp.stdout.on("data", (b) => String(b).includes("listening") && resolve());
    idp.on("exit", (code) => reject(new Error(`idp exited ${code}`)));
  });
  app = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      ...SECRETS,
      PORT: String(PORT),
      PUBLIC_ORIGIN: ORIGIN,
      DB_PATH: join(dir, "cosas.db"),
      OIDC_DISCOVERY_URL: `http://127.0.0.1:${IDP}/oauth2/openid/cosas/.well-known/openid-configuration`,
      OIDC_CLIENT_ID: "cosas",
      OIDC_CLIENT_SECRET: "dev-client-secret",
      LOG_LEVEL: "error",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    app.stdout.on("data", (b) => String(b).includes("listening") && resolve());
    app.on("exit", (code) => reject(new Error(`app exited ${code}`)));
    setTimeout(() => reject(new Error("app did not start")), 15000);
  });
});

after(async () => {
  const { copyFileSync } = await import("node:fs");
  try { const { copyFileSync: cp } = await import("node:fs"); cp(join(dir, "cosas.db"), "/tmp/mkded/cosas.db"); cp(join(dir, "cosas.db-wal"), "/tmp/mkded/cosas.db-wal"); } catch {}
  app?.kill("SIGKILL");
  idp?.kill("SIGKILL");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("health and headers", async () => {
  const c = client();
  const r = await c("/healthz");
  assert.equal(r.status, 200);
  // SPEC.md §5.2 verbatim: deny everything, then allow the same-origin assets.
  assert.equal(
    r.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
});

test("anonymous: list ok, member pages forbidden, unknown code 404", async () => {
  const c = client();
  assert.equal((await c("/")).status, 200);
  assert.equal((await c("/codes")).status, 403);
  assert.equal((await c("/export.csv")).status, 403);
  assert.equal((await c("/r/2h000000nf6h9ssf")).status, 404);
  assert.equal((await c("/r/notacode")).status, 404);
  assert.equal((await c("/static/app.css")).status, 200);
  assert.equal((await c("/static/../server.js")).status, 404);
});

test("login issues a session; member (no admin role) is read-only", async () => {
  const admin = await login("admin");
  const page = await admin("/");
  assert.equal(page.status, 200);
  assert.ok(csrfOf(page), "admin pages carry a CSRF token");

  const member = await login("member");
  const r = await member("/export.csv");
  assert.equal(r.status, 403);
  assert.match(r.text, /read but not change/);

  // The list stays readable for a member, but every write route refuses them (§4.1),
  // even with a valid session and CSRF token: the role check runs after CSRF on purpose.
  assert.equal((await member("/")).status, 200);
  const [code] = codesOf(await admin("/codes?n=1&start=100000"));
  const token = csrfOf(await member(`/r/${code}`));
  for (const [path, body] of [
    [`/r/${code}/register`, { name: "x", category: "c" }],
    [`/r/${code}/edit`, { name: "x", category: "c" }],
    [`/r/${code}/status`, { status: "broken" }],
    [`/r/${code}/qty`, { qty: "1" }],
    [`/r/${code}/delete`, { confirm: "1" }],
  ]) {
    const res = await member(path, form({ _csrf: token, ...body }));
    assert.equal(res.status, 403, `${path} must be forbidden for a member`);
  }
});

test("print sheet, register through the sticker URL, then edit/qty/status", async () => {
  const c = await login("admin");
  const sheet = await c("/codes?n=3&start=100");
  assert.equal(sheet.status, 200);
  const codes = codesOf(sheet);
  assert.equal(codes.length, 3);
  const svg = await c("/codes/svg?n=3&start=100");
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get("content-type"), /image\/svg\+xml/);
  const svg2 = await c("/codes/svg?n=3&start=100");
  assert.equal(svg.text, svg2.text, "sheet SVG is deterministic");

  const [code] = codes;
  const anon = client();
  const anonScan = await anon(`/r/${code}`);
  assert.equal(anonScan.status, 200);
  assert.match(anonScan.text, /Log in to continue/);

  const scan = await c(`/r/${code}`);
  assert.equal(scan.status, 200);
  const token = csrfOf(scan);
  const created = await c(
    `/r/${code}/register`,
    form({ _csrf: token, name: "Monitor LG 24", category: "monitor", location: "Shelf 2", qty: "1" }),
  );
  assert.ok(created.status !== 403, `register 403: ${created.text.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300)}`);
  assert.equal(created.status, 302);

  const item = await c(`/r/${code}`);
  assert.match(item.text, /Monitor LG 24/);
  assert.match(item.text, /Shelf 2/);

  // Duplicate registration on the same sticker: 409, never an overwrite.
  const dup = await c(`/r/${code}/register`, form({ _csrf: token, name: "Other", category: "monitor" }));
  assert.equal(dup.status, 409);

  // Anonymous visitor sees the public view only.
  const pub = await anon(`/r/${code}`);
  assert.match(pub.text, /Monitor LG 24/);
  assert.doesNotMatch(pub.text, /_csrf/);

  const edited = await c(`/r/${code}/edit`, form({ _csrf: token, name: "Monitor LG 27", category: "monitor", qty: "1" }));
  assert.equal(edited.status, 302);
  assert.match((await c(`/r/${code}`)).text, /Monitor LG 27/);

  const qty = await c(`/r/${code}/qty`, { ...form({ _csrf: token, delta: "1" }), headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" } });
  assert.equal(qty.status, 200);
  assert.deepEqual(JSON.parse(qty.text), { qty: 2 });

  const status = await c(`/r/${code}/status`, form({ _csrf: token, status: "broken" }));
  assert.equal(status.status, 302);
  assert.match((await c(`/r/${code}`)).text, /badge broken/);

  // No CSRF token: rejected.
  const noCsrf = await c(`/r/${code}/status`, form({ status: "available" }));
  assert.equal(noCsrf.status, 403);
});

test("export CSV, list filters, language switch", async () => {
  const c = await login("admin");
  const csv = await c("/export.csv");
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(csv.text, /^code,name,category/);

  const list = await c("/?category=monitor");
  assert.match(list.text, /Monitor LG 27/);

  const es = await c("/lang/es", { headers: { referer: `${ORIGIN}/` } });
  assert.equal(es.status, 302);
  const home = await c("/");
  assert.match(home.text, /Buscar/);
});

test("delete → 410 for anon, restore; rebind rotates the code", async () => {
  const c = await login("admin");
  const [code] = codesOf(await c("/codes?n=1&start=200")); // lowercase, as printed on the sticker
  const token = csrfOf(await c(`/r/${code}`));
  await c(`/r/${code}/register`, form({ _csrf: token, name: "HDD 2TB", category: "hdd" }));

  // First press asks, second press with confirm=1 acts (§7.2).
  const ask = await c(`/r/${code}/delete`, form({ _csrf: token }));
  assert.equal(ask.status, 200);
  assert.match(ask.text, /Continue\?/);
  const del = await c(`/r/${code}/delete`, form({ _csrf: token, confirm: "1" }));
  assert.equal(del.status, 302);
  assert.equal((await client()(`/r/${code}`)).status, 410, "deleted sticker is 410 even for anonymous");

  const restore = await c(`/r/${code}/restore`, form({ _csrf: token, confirm: "1" }));
  assert.equal(restore.status, 302, "restore is allowed");
  assert.equal((await c(`/r/${code}`)).status, 200);

  const token2 = csrfOf(await c(`/r/${code}`));
  const rebind = await c(`/r/${code}/rebind`, form({ _csrf: token2, confirm: "1" }));
  assert.equal(rebind.status, 302, "rebind rotates");
  const newCode = rebind.headers.get("location").split("/").pop();
  assert.notEqual(newCode, code, "a new sticker is issued");
  assert.equal((await c(`/r/${newCode}`)).status, 200);
  assert.equal((await c(`/r/${code}`)).status, 410, "the old sticker is revoked");
  assert.equal((await client()(`/r/${code}`)).status, 410, "revoked sticker is 410 even for anonymous");
});

test("rate limit: 31st GET on /r/* is 429", async () => {
  const c = await login("admin");
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await c("/r/2h000000nf6h9ssf")).status;
  assert.equal(last, 429);
});

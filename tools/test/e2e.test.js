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

// Just enough bytes for the server's magic-number check; content never parsed.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 0x22)]);

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
const codesOf = (res) => [...res.text.matchAll(/class="sticker" data-code="([0-9a-z]+)"/g)].map((m) => m[1]);

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
  app?.kill("SIGKILL");
  idp?.kill("SIGKILL");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("health and headers", async () => {
  const c = client();
  const r = await c("/healthz");
  assert.equal(r.status, 200);
  // SPEC.md §5.2: deny everything, then allow the same-origin assets the pages use.
  // connect-src covers the qty fetch, media-src the camera stream, and
  // manifest-src/worker-src the PWA (§8.10).
  assert.equal(
    r.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:; manifest-src 'self'; worker-src 'self'; media-src 'self' blob:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
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
  const [code] = codesOf(await admin("/codes?n=1"));
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

  // Write affordances are gone from the HTML for a reader, not merely rejected on POST.
  const memberHome = await (await member("/")).text;
  assert.doesNotMatch(memberHome, /class="nav-add"/, "no Add button for a member");
  assert.doesNotMatch(memberHome, /href="\/codes"/, "no sticker printing for a member");
  assert.doesNotMatch(memberHome, /href="\/export\.csv"/, "no export for a member");

  const memberItem = await (await member(`/r/${code}`)).text;
  assert.doesNotMatch(memberItem, /class="photo-panel"/, "no photo editor for a member");
  assert.doesNotMatch(memberItem, /data-qty-delta/, "no qty controls for a member");
  assert.doesNotMatch(memberItem, /\/rebind|\/delete/, "no rebind/delete for a member");

  // An unregistered sticker tells a reader so instead of offering the register form.
  const [free] = codesOf(await admin("/codes?n=1")).filter((k) => k !== code);
  const ro = await member(`/r/${free}`);
  assert.equal(ro.status, 403);
  assert.match(ro.text, /Sticker not registered|Etiqueta sin registrar/);
  assert.doesNotMatch(ro.text, /action="\/r\/[^"]+\/register"/);
});

test("print sheet, register through the sticker URL, then edit/qty/status", async () => {
  const c = await login("admin");
  const sheet = await c("/codes?n=3");
  assert.equal(sheet.status, 200);
  const codes = codesOf(sheet);
  assert.equal(codes.length, 3);
  const svg = await c("/codes/svg?n=3");
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(svg.text, /^<svg xmlns/);
  assert.equal((svg.text.match(/<g transform="translate\(/g) || []).length, 3);
  // Codes are random (§7.5): a second sheet must not repeat the first one.
  const svg2 = await c("/codes/svg?n=3");
  assert.notEqual(svg.text, svg2.text, "each sheet is freshly generated");

  const [code] = codes;
  const anon = client();
  const anonScan = await anon(`/r/${code}`);
  assert.equal(anonScan.status, 200);
  assert.match(anonScan.text, /Log in to continue/);

  const scan = await c(`/r/${code}`);
  assert.equal(scan.status, 200);
  const token = csrfOf(scan);
  // Notes carry free text with newlines; they must round-trip and stay escaped.
  const notes = "Comprado en la feria\nsegunda línea con ñ y <b>no markup</b>";
  const created = await c(
    `/r/${code}/register`,
    form({ _csrf: token, name: "Monitor LG 24", category: "monitor", location: "Shelf 2", qty: "1", notes }),
  );
  assert.ok(created.status !== 403, `register 403: ${created.text.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300)}`);
  assert.equal(created.status, 302);

  const item = await c(`/r/${code}`);
  assert.match(item.text, /Monitor LG 24/);
  assert.match(item.text, /Shelf 2/);
  assert.match(item.text, /Comprado en la feria\nsegunda línea con ñ y &lt;b&gt;no markup&lt;\/b&gt;/);
  assert.doesNotMatch(item.text, /<b>no markup<\/b>/, "notes are escaped, not rendered");

  // Duplicate registration on the same sticker: 409, never an overwrite.
  const dup = await c(`/r/${code}/register`, form({ _csrf: token, name: "Other", category: "monitor" }));
  assert.equal(dup.status, 409);

  // Anonymous visitor sees the public view only.
  const pub = await anon(`/r/${code}`);
  assert.match(pub.text, /Monitor LG 24/);
  assert.doesNotMatch(pub.text, /_csrf/);

  const edited = await c(
    `/r/${code}/edit`,
    form({ _csrf: token, name: "Monitor LG 27", category: "monitor", qty: "1", notes: "nota editada" }),
  );
  assert.equal(edited.status, 302);
  assert.match((await c(`/r/${code}`)).text, /nota editada/, "the edit kept the new notes");
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
  const [code] = codesOf(await c("/codes?n=1")); // lowercase, as printed on the sticker
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

test("PWA: manifest, service worker and icons are served", async () => {
  const c = client();
  const man = await c("/manifest.webmanifest");
  assert.equal(man.status, 200);
  assert.match(man.headers.get("content-type"), /application\/manifest\+json/);
  const json = JSON.parse(man.text);
  assert.equal(json.start_url, "/");
  assert.equal(json.display, "standalone");
  assert.ok(json.icons.some((i) => i.sizes === "512x512" && /maskable/.test(i.purpose)), "a maskable 512 icon");

  const sw = await c("/sw.js");
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get("content-type"), /javascript/);
  assert.match(sw.text, /addEventListener\("fetch"/);
  assert.match(sw.text, /network only/, "photos and pages stay network-only");

  for (const name of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "icon-180.png"]) {
    const r = await c(`/static/${name}`);
    assert.equal(r.status, 200, name);
    assert.match(r.headers.get("content-type"), /image\/png/);
  }

  const home = await c("/");
  assert.match(home.text, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(home.text, /\/static\/app\.js\?v=[0-9a-f]{10}/);
});

test("asset versioning: a deploy changes every asset URL and the worker cache", async () => {
  const c = client();
  const home = await c("/");
  const version = /\/static\/app\.css\?v=([0-9a-f]{10})/.exec(home.text)?.[1];
  assert.ok(version, "the stylesheet is linked with a content hash");

  // A versioned URL may be cached forever: changing the file changes the URL.
  const css = await c(`/static/app.css?v=${version}`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("cache-control"), /immutable/);
  // An unversioned one must not be pinned for a year.
  assert.doesNotMatch((await c("/static/app.css")).headers.get("cache-control"), /immutable/);

  const sw = await c("/sw.js");
  assert.doesNotMatch(sw.text, /__VERSION__|__ASSETS__/, "the worker template is filled in");
  assert.match(sw.text, new RegExp(`const VERSION = "${version}"`), "the worker carries the version");
  assert.match(sw.text, /const CACHE = "cosas-" \+ VERSION/, "the cache name is derived from it");
  assert.match(sw.text, new RegExp(`/static/app\\.css\\?v=${version}`), "the precache list is versioned");

  const man = JSON.parse((await c("/manifest.webmanifest")).text);
  assert.ok(man.icons.every((i) => i.src.endsWith(`?v=${version}`)), "icons are versioned too");
});

test("add by phone: /add scanner page is admin-only and accepts the typed fallback", async () => {
  assert.equal((await client()("/add")).status, 403, "anon");
  const member = await login("member");
  assert.equal((await member("/add")).status, 403, "member without the admin role");

  const c = await login("admin");
  const page = await c("/add");
  assert.equal(page.status, 200);
  assert.match(page.text, /data-scanner-video/);
  assert.match(page.text, /\/vendor\/jsQR\.js/);
  assert.match(page.text, /\/static\/scan\.js/);
  assert.match(page.text, /action="\/add"/);
  // The menu marks where you are: Add here, Items on the list, never both.
  assert.match(page.text, /<a class="nav-add" href="\/add" aria-current="page">/);
  assert.equal((page.text.match(/aria-current="page"/g) || []).length, 1);
  const home = await c("/");
  assert.match(home.text, /<a href="\/" aria-current="page">/);
  assert.doesNotMatch(home.text, /class="nav-add" href="\/add" aria-current/);

  const [code] = codesOf(await c("/codes?n=1"));
  const viaUrl = await c(`/add?code=${encodeURIComponent(`${ORIGIN}/r/${code}`)}`);
  assert.equal(viaUrl.status, 302);
  assert.equal(viaUrl.headers.get("location"), `/r/${code}`);

  const viaBare = await c(`/add?code=${code.replace(/(.{4})(?=.)/g, "$1-")}`);
  assert.equal(viaBare.status, 302, "a typed, dashed code also works");

  const bad = await c("/add?code=nope");
  assert.equal(bad.status, 422);
  assert.match(bad.text, /data-scanner-video/, "the page asks again instead of a bare error");
});

test("photos: multipart register, add several, delete one, access control", async () => {
  const c = await login("admin");
  const [code] = codesOf(await c("/codes?n=1"));
  const page = await c(`/r/${code}`);
  const token = csrfOf(page);

  const B = "----e2eboundary";
  const part = (name, value, filename = null, type = null) =>
    filename === null
      ? Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      : Buffer.concat([
          Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
          Buffer.from(value),
          Buffer.from("\r\n"),
        ]);
  const body = Buffer.concat([
    part("_csrf", token),
    part("name", "Switch 8 puertos"),
    part("category", "switch"),
    part("photo", JPEG, "switch.jpg", "image/jpeg"),
    // Two files in one register post: the form takes several photos at once (§8.8).
    part("photo", PNG, "label.png", "image/png"),
    Buffer.from(`--${B}--\r\n`),
  ]);

  // The crop step is offered by the page itself: template + Cropper assets (§8.8).
  const form0 = page.text;
  assert.match(form0, /<template data-crop-template>/);
  assert.match(form0, /\/vendor\/cropper\.js\?v=[0-9a-f]{10}/);
  assert.match(form0, /\/vendor\/cropper\.css\?v=[0-9a-f]{10}/);
  const cropper = await c(`/vendor/cropper.js`);
  assert.equal(cropper.status, 200);
  assert.match(cropper.headers.get("content-type"), /text\/javascript/);

  const created = await c(`/r/${code}/register`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${B}` },
    body,
  });
  assert.equal(created.status, 302, `multipart register: ${created.text.slice(0, 200)}`);

  const first = (await c(`/r/${code}`)).text;
  assert.match(first, /Switch 8 puertos/);
  const registered = [...first.matchAll(/<img class="photo-thumb" src="\/photo\/[0-9a-z]+\/(\d+)"/g)].map((m) => m[1]);
  assert.equal(registered.length, 2, "both photos of the register post are kept");
  const firstId = registered[0];
  assert.ok(firstId, "the registered photo is in the grid");
  assert.match(first, /Add another photo/, "the uploader switches to 'add another'");

  const img = await c(`/photo/${code}/${firstId}`);
  assert.equal(img.status, 200);
  assert.match(img.headers.get("content-type"), /image\/jpeg/);
  assert.match(img.headers.get("cache-control"), /private/);
  assert.equal((await client()(`/photo/${code}/${firstId}`)).status, 403, "photos need a session");

  // The phone's downscaled data URL adds a second photo; both stay.
  const added = await c(
    `/r/${code}/photo`,
    form({ _csrf: token, photo_data: `data:image/png;base64,${PNG.toString("base64")}` }),
  );
  assert.equal(added.status, 302);
  const two = (await c(`/r/${code}`)).text;
  const ids = [...two.matchAll(/<img class="photo-thumb" src="\/photo\/[0-9a-z]+\/(\d+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 3, "three photos in the grid");
  assert.match((await c(`/photo/${code}/${ids[1]}`)).headers.get("content-type"), /image\/png/);

  // Bytes that are not an image are refused and the grid is untouched.
  const notImage = await c(
    `/r/${code}/photo`,
    form({ _csrf: token, photo_data: `data:image/png;base64,${Buffer.from("this is not a png at all").toString("base64")}` }),
  );
  assert.equal(notImage.status, 422);
  // Nothing picked at all: a clear error, not a 500.
  assert.equal((await c(`/r/${code}/photo`, form({ _csrf: token }))).status, 422);

  // Delete the first photo only; the second must survive.
  const removed = await c(`/r/${code}/photo/${firstId}/delete`, form({ _csrf: token }));
  assert.equal(removed.status, 302);
  assert.equal((await c(`/photo/${code}/${firstId}`)).status, 404, "deleted photo is gone");
  assert.equal((await c(`/photo/${code}/${ids[1]}`)).status, 200, "the other photo survives");
  // Deleting it twice is a 404, not a crash.
  assert.equal((await c(`/r/${code}/photo/${firstId}/delete`, form({ _csrf: token }))).status, 404);
});

test("rate limit: GET /r/* answers 429 with retry-after once the window is full", async () => {
  // Anonymous on purpose: the bucket is per client IP, not per session, and the
  // earlier tests have already spent part of it — so count up to the first 429
  // instead of assuming it lands exactly on the 31st request.
  const c = client();
  let hits = 0;
  let res = null;
  for (let i = 0; i < 40 && !res; i++) {
    const r = await c("/r/2h000000nf6h9ssf");
    hits++;
    if (r.status === 429) res = r;
  }
  assert.ok(res, "a 429 arrives within 40 GETs");
  assert.match(res.headers.get("retry-after") || "", /^\d+$/);
});

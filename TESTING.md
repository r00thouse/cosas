# Testing hacklab-cosas locally

Everything below runs on one machine with nothing but Node 24. There is no staging
server, no seeding script and no test account: the platform boots with an empty
database and the mock IdP logs you in as `mockadmin` without a password (the
`as=member` variant has no admin role, so you can check the read-only path).

| What | Where |
|---|---|
| App | <http://localhost:8080> |
| Mock Kanidm IdP (dev only) | <http://localhost:9010> |
| SQLite database (on the host) | `./dev-data/cosas.dev.db` |

---

## 1. Prerequisites

- **Node 24 or newer**, on `PATH`, from an official build (it ships `node:sqlite`;
  the prebuilt packages and a plain `node --version` are enough). Node 22 will not do.
- **Bash** and **curl**, plus `setsid` (part of util-linux, present on any desktop
  Linux; on macOS run `npm run dev` and `npm run mock-idp` in two terminals instead).
- **Nothing else.** No npm install, no Docker, no Kanidm, no TLS, no database server.
  Docker is only needed if you want to build the deploy image (`compose.yaml`).

Check it all at once:

```bash
./dev.sh doctor
```

`ok` lines are good; the `warn … missing` lines only matter once the app has been
implemented (see §2).

## 2. Status: implemented, no dependencies

The app is implemented from [`SPEC.md`](SPEC.md): `server.js` (routing, pages,
auth guard), `store.js` (SQLite), `oidc.js` (Kanidm OIDC), `code.js`/`codes.js`
(stickers), `views.js`/`i18n.js` (HTML, en/es), `public/` (CSS, JS, vendored QR
encoder, so no npm install and no build step). `tools/mock-idp/` stands in for Kanidm
locally.

- `./dev.sh code <n>` prints `n` fresh sticker codes (§7.5 of the spec) using the dev
  `CODE_SECRET`, and `node tools/gen-codes.js <n> [--url ORIGIN]` prints the same list
  as `code<TAB>URL` (codes are printed lowercase, as in the QR payload). Codes are
  random, so these are new codes — not the ones already on a sheet in your hand —
  but they are valid stickers: handy to know what to type into the browser when you do
  not want to scan a QR.

## 3. Power it on

```bash
./dev.sh            # == ./dev.sh up : start app and mock IdP, wait until healthy
```

Nothing is built: the two processes start in about a second and you should see three
green lines (`mock idp`, `app /healthz`, `app / renders`) plus a URL summary. If
something fails, `dev.sh` prints the last 25 app log lines before exiting — those are
the real error.

Server-side edits reload on save (`node --watch`); `public/*.css` and `public/*.js`
are served from disk, so a browser reload is enough. Logs are in `.dev/app.log` and
`.dev/idp.log`; the generated dev environment is `.dev/env` (gitignored).

| Command | What it does |
|---|---|
| `./dev.sh` / `./dev.sh up` | start both processes, wait until healthy |
| `./dev.sh down` | stop both processes; **keeps** `dev-data/` (next `up` resumes the same data) |
| `./dev.sh reset` | delete `dev-data/` (items, claimed codes, sessions) and start empty again |
| `./dev.sh logs` (or `logs app`, `logs idp`) | follow the process logs |
| `./dev.sh ps` | process and port status |
| `./dev.sh test` | HTTP smoke test (§4.1) |
| `./dev.sh doctor` | node/curl/setsid, ports, repo files |
| `npm run dev` / `npm run mock-idp` | the same two processes, by hand (reads `.dev/env`) |

Dev secrets (session, client secret, `CODE_SECRET`) are written to `.dev/env` by
`dev.sh`, so a fresh clone works without any `.env` — and a real `.env` (the deploy
one) is never read or touched. Ports 8080 and 9010 must be free. `node --watch` is on
by default; `WATCH=0 ./dev.sh up` turns it off.

## 4. Test in layers

### 4.1 Layer 1 — automated smoke test (~30 s)

```bash
./dev.sh test
```

It exercises the cheap, scriptable part of the acceptance checklist
([`SPEC.md`](SPEC.md) §12) and prints one line per check with the spec item number:

| Check | Spec item |
|---|---|
| `/healthz` of app and mock IdP | 12.1 |
| Security headers (`nosniff`, `X-Frame-Options`, `Referrer-Policy: no-referrer`, CSP) | 12.19 |
| Login through the mock IdP sets a session cookie; dev cookie is not `Secure` | 12.4 |
| `/codes?n=5`, `/codes/svg?n=5`, same range twice → identical bytes | 12.6 |
| An unbound code: anon → login prompt, member → register form | 12.22 |
| Tampered code → 404 | 12.12 |
| `POST` without `_csrf` → 403 | 12.13 |
| `GET /export.csv` | 12.17 |
| 31st rapid `GET /r/<code>` → 429 | 12.15 |

Exit status is `0` only if everything passed. The rate-limit check runs **last**
because it blocks that IP (your `127.0.0.1`) for 60 seconds — if later manual
testing suddenly returns 429 everywhere, wait a minute or run `./dev.sh reset`.

### 4.2 Layer 2 — manual walk-through (10 minutes)

Run `./dev.sh reset` first so the database is empty, then open
<http://localhost:8080>. Do it in that order; every step maps to a §12 item, so a
bug report can just say "12.7 fails".

1. **Anonymous list** (12.2) — the empty state in English, a login link, no action
   buttons. The app has no accounts of its own; "login" is the mock IdP.
2. **Language** (12.3) — click *Español*; everything switches and stays Spanish after
   a reload. Switch back.
3. **Login** (12.4) — click *Log in*. You bounce through the mock IdP (no form) and come
   back to the app as `mockadmin`, with the admin role (the role comes from the
   `groups` claim served by the IdP's userinfo endpoint, so `?as=member` gives a
   read-only session instead). The `auth.login` line in `.dev/app.log` shows the
   claims and the decision; `OIDC_ADMIN_GROUP=cosas_admin ./dev.sh up` makes the
   group the only source of the role.
   Logging out is local: it clears the app session, with no round trip to the IdP.
4. **Print stickers** (12.6) — open `/codes?n=5`. Five stickers appear; *Print*
   (`Ctrl+P`) shows 4 × 11 stickers per A4 page and nothing else — no header, nav,
   buttons or footer. Every sticker has a QR plus the code in two lines of text.
   Also try `/codes/svg?n=5` — the same sheet as one downloadable SVG. Codes are
   random, so print them or write one down (or use `./dev.sh code 1`); you need it in
   the next step.
5. **Register by scan** (12.7, 12.22) — open `http://localhost:8080/r/<code>` as if you
   had scanned it. Unbound code while logged in → the register form. Fill name, category,
   location, status *in use*, qty *3*, save → the item page.
   *Tip:* instead of typing, render the QR on screen: `/codes/svg?n=1` is the real
   sticker, and any QR reader app on a phone solves it. Codes are lowercase in URLs
   (`/r/2jhd-tgkq3n13fqc3`) and dashes are optional — `2JHD-TGKQ-3N13-FQC3` typed by
   hand works too.
6. **Anonymous view** (12.14) — log out, open `/r/<same code>`: you see it exists, but
   **no** serial, model, holder or notes (`Ctrl+U` and search the source).
7. **Quantity** (12.9) — `+1` / `−1` change the number without a page reload; with
   JavaScript disabled the same buttons submit a normal form.
8. **Persistence** (12.8) — `./dev.sh down && ./dev.sh`; the item is still there on the
   same URL.
9. **Rebind** (12.10) — *Print new sticker* on the item gives a new URL; the old URL
   now says the sticker was revoked (410), the new one shows the same item.
10. **Delete / restore** (12.11, 12.21) — delete: the URL says deleted (410) and edit /
    rebind refuse; restore brings the item back under the same code.
11. **Search and filters** (12.16) — add a second item ("Laptop Dell"), search `mon`
    and filter by status; `q=%` should not return everything.
12. **CSV** (12.17) — `/export.csv` downloads; it opens in LibreOffice or Excel.
13. **Photos** (12.23) — on an item, *Take or choose a photo*, pick any JPEG/PNG, upload.
    It appears as a thumbnail in the grid; *Add another photo* adds a second one, and
    each thumbnail has its own *Delete photo* that leaves the others alone. Open one
    directly (`/photo/<code>/<id>`) and log out —
    that URL now returns 403. Try uploading a `.txt` renamed to `.jpg`: the server
    sniffs the bytes and answers 422, keeping the old photo.
14. **Add from the phone** (12.24) — click *Add* in the header. The page offers the
    camera and a box to type a code. Type a code from step 4 → you land on its sticker
    page. Visiting `/add` reserves nothing: the code stays unclaimed until you submit
    the register form.
15. **Camera** (12.27) — open `http://localhost:8080` on a phone in the same LAN: that
    is plain http, so the browser refuses the camera and the page says so. To actually
    scan, put the app behind https (or use `tailscale serve` / a tunnel, which
    terminate TLS for you) and open `/add`; point the phone at the printed sticker from
    step 4. Chrome/Android uses the built-in `BarcodeDetector`; Safari/iOS falls back to
    `jsQR` (`/vendor/jsQR.js`) — both land on `/r/<code>`.
16. **Mobile layout** (12.25) — resize the window to ~390 px or use device mode. The
    list becomes a card stack (each cell labelled), the nav wraps, buttons are
    thumb-sized. Nothing scrolls sideways.
17. **PWA** (12.26) — the address bar offers an install button (Chrome/Edge) or
    *Add to Home Screen* (Safari). Install it, then set devtools to *Offline* and
    reload: you get the built-in offline page, **not** a stale item list. Photos and
    `/export.csv` are never cached.

### 4.3 Layer 3 — the production shape

Only worth doing before putting the app on the real server:

1. Write a real `.env` from [`.env.example`](.env.example) with `PUBLIC_ORIGIN` =
   your real `https://` host and freshly generated secrets
   (`openssl rand -base64 48`).
2. `docker compose up -d --build` (no mock IdP; `compose.yaml` only). This is what
   `dev.sh` never does, and the only step that needs Docker.
3. Expect the session cookie to be `Secure`, QR URLs to be `https://…`, and login to
   fail until the Kanidm client (§10.1 of the spec) exists — that failure is the
   correct result of this layer.

Request-flow checks for these are §12 items 5, 15 (with nginx), 19 and 20.

### 4.4 Checking the scanner without a phone

The camera path is hard to eyeball on a laptop, so it can be driven headlessly. With
`google-chrome-stable` installed, `--use-file-for-fake-video-capture` feeds a video
file to `/add` as if it were the camera:

1. Generate a Y4M frame holding a QR for one of your stickers (the encoder in
   `qrcode.js` / `qrcode-generator` is the natural source).
2. Start Chrome with `--headless=new --use-fake-ui-for-media-stream
   --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<file>
   --remote-debugging-port=9446`.
3. Load `http://localhost:8080/add` with a session cookie, click `[Start camera]`,
   and check that `location.pathname` becomes `/r/<code>` within a couple of seconds.

That is how `jsQR` was verified against a real browser: Chrome on this machine has no
`BarcodeDetector`, so the browser borrowed the same decoder Safari uses. `npm test`
also round-trips `jsQR` over frames rendered from our own encoder at 1–6 px/module,
rotated, blurred and inverted. Note that `getUserMedia` needs `localhost` or https (SPEC.md §8.9), which is why
the check runs against `http://localhost` and not the LAN address.

## 5. Mock IdP behaviour (what "login" actually does)

The mock IdP stands in for Kanidm and mimics its endpoints
(`SPEC.md` §11). For testing it matters that it is **not a login form**:

- Any visit to `/login` logs you in immediately (no form, no password): `mockadmin`
  is an admin, and `/login?as=member` gives `mockmember`, who is read-only (403 on
  every write route). The app forwards `as` to the IdP only because the mock reads it.
- The token is shaped like a real Kanidm one so the role logic is actually exercised:
  `groups: ["cosas_admin"]` for the admin (a name that is *not* literally `admin`)
  and `groups: ["inventory_users"]` plus `roles: ["member"]` for the reader.
- It enforces PKCE and client authentication exactly like Kanidm, so the app's OIDC
  code is really exercised, not bypassed.
- `MOCK_PUBLIC_URL` / `MOCK_INTERNAL_URL` separate the URLs the browser sees from the
  ones the app calls. Locally both are `http://localhost:9010`, because the two
  processes share a host; in a container they would differ (`mock-idp:9010`). The
  app's `OIDC_ISSUER` is set to the browser-facing issuer so `iss` matches.
- Its signing key is derived from a fixed dev seed (`MOCK_KEY_SEED`), so the JWKS is the
  same after every restart. The app caches the JWKS for an hour, so a new key per
  restart would otherwise break every login until that cache expired. Existing app
  sessions survive restarts.
- `?as=denied` / `?as=error` on the authorization call, and `MOCK_MODE=wrong-secret`,
  simulate a user refusing access and a broken client secret. Use them to check the
  error pages (§4 of the spec) instead of breaking a real Kanidm.

## 6. Resetting and troubleshooting

| Symptom | Fix |
|---|---|
| container restarts with `db.open_failed ... permission denied` | the host directory behind `DB_DIR`/`PHOTO_HOST_DIR` is not writable by uid 1000 (Docker creates a missing one as root): `mkdir -p data photos && sudo chown -R 1000:1000 data photos` |
| `port 8080 is busy` / `:9010 is busy` | something else is using it: `ss -ltnp \| grep -E ':8080\|:9010'`, then stop it (or `PORT`/ports in `dev.sh`) |
| `node:sqlite` missing at boot | not an official Node 24 build; install Node 24 from nodejs.org |
| `setsid not found` | util-linux is missing (rare); run `npm run dev` and `npm run mock-idp` in two shells |
| `EADDRINUSE` in `.dev/app.log` | an old process survived: `./dev.sh down`, or kill what `./dev.sh ps` reports |
| I am in the admin group but the app shows "reader" | look at the `auth.login` line in `.dev/app.log` (or `docker compose logs app`): if `groups` is `null` the client neither requested a groups scope (`OIDC_SCOPES`, default `openid profile groups_name`) nor has it in its scope map — check `requested_scopes` vs `granted_scopes` in the same line, if `group_names` lacks your group compare the exact spelling, if `admin_group` is `null` set `OIDC_ADMIN_GROUP`. Role is baked into the session at login, so log out and back in |
| Login bounces back with an error page | the mock IdP restarted mid-login; just log in again, or `./dev.sh logs idp` |
| Edits to `.js` under `server/` are ignored | `WATCH=0` was used; `./dev.sh down && ./dev.sh` |
| 429 on every page for a while | the smoke test's rate-limit check; wait 60 s |
| Want a clean start | `./dev.sh reset` |
| Inspect the DB | `sqlite3 dev-data/cosas.dev.db` if `sqlite3` is installed, else `node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('dev-data/cosas.dev.db');console.log(d.prepare('select * from items').all())"` |

## 7. What "tested" means here

- `./dev.sh test` green = the plumbing (auth round trip, sticker generation, CSRF,
  permissions, rate limit) works on a clean start.
- §4.2 done end-to-end = the product works for a person with a phone camera.
- Neither proves the production deployment; that is §4.3 plus the operator's nginx.

For the full, exhaustive list — 28 numbered items including nginx and `https://`
behaviour — see [`SPEC.md`](SPEC.md) §12.

# Testing hacklab-cosas locally

Everything below runs on one machine with Docker. There is no staging server, no
seeding script and no test account: the platform boots with an empty database and the
mock IdP logs you in as `mockadmin` without a password (the `as=member` variant has no
admin role, so you can check the read-only path).

| What | Where |
|---|---|
| App | <http://localhost:8080> |
| Mock Kanidm IdP (dev only) | <http://localhost:9000> |
| SQLite database (on the host) | `./dev-data/cosas.dev.db` |

---

## 1. Prerequisites

- **Docker Engine / Docker Desktop, running**, with the Compose v2 plugin
  (`docker compose version` works). Raw Docker, Podman, Colima and Rancher Desktop
  are all fine — anything that runs `docker compose`.
- **Bash** and **curl**.
- **Nothing else.** No Node, no npm, no Kanidm, no TLS, no internet after the first
  image pull (`node:24-alpine`).

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

- `./dev.sh code <start> <n>` prints the exact sticker codes a printed sheet will
  carry (§7.5 of the spec) using the dev `CODE_SECRET`, and `node tools/gen-codes.js
  <start> <n> [--url ORIGIN]` prints the same list as `code<TAB>URL` (codes are printed
  lowercase, as in the QR payload). Handy to know what to type into the browser when
  you do not want to scan a QR.

## 3. Power it on

```bash
./dev.sh            # == ./dev.sh up : build + start app and mock IdP, wait until healthy
```

What you should see: the build output, then three green lines
(`mock idp`, `app /healthz`, `app / renders`) and the URL summary. If something fails,
`dev.sh` prints the last 25 app log lines before exiting — those are the real error.

| Command | What it does |
|---|---|
| `./dev.sh` / `./dev.sh up [--build]` | build if needed, start everything, wait until healthy |
| `./dev.sh down` | stop and remove the containers; **keeps** `dev-data/` (next `up` resumes the same data) |
| `./dev.sh reset` | delete `dev-data/` (items, claimed codes, sessions) and start empty again |
| `./dev.sh logs app` / `./dev.sh logs mock-idp` | follow logs |
| `./dev.sh ps` | container status and health |
| `./dev.sh shell` | `sh` inside the app container |
| `./dev.sh test` | HTTP smoke test (§4.1) |
| `./dev.sh doctor` | prerequisites + merged-compose sanity |

Dev secrets (session, client secret, `CODE_SECRET`) come from the `environment:`
block of [`compose.dev.yaml`](compose.dev.yaml), so a fresh clone works without any
`.env`. `dev.sh` creates an empty `.env` for the duration of a command if one is
missing (compose's `env_file:` insists on it) and removes it again on exit. A real
`.env` is never touched. Ports 8080 and 9000 must be free.

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
   back to the app as `mockadmin`, with the admin role (the role comes from the IdP's
   groups claim, so `?as=member` gives a read-only session instead).
   Logging out is local: it clears the app session, with no round trip to the IdP.
4. **Print stickers** (12.6) — open `/codes?n=5`. Five stickers appear; *Print* opens
   the browser dialog with 3 × 7 stickers per A4 page. Every sticker has a QR plus
   the code in two lines of text. Also try `/codes/svg?n=5` — the same sheet as one
   downloadable SVG. Write down one code (or use the output of
   `./dev.sh code 0 5`); you need it in the next step.
5. **Register by scan** (12.7, 12.22) — open `http://localhost:8080/r/<code>` as if you
   had scanned it. Unbound code while logged in → the register form. Fill name, category,
   location, status *in use*, qty *3*, save → the item page.
   *Tip:* instead of typing, render the QR on screen: `/codes/svg?n=1&start=0` is the
   real sticker, and any QR reader app on a phone solves it. Codes are lowercase in
   URLs (`/r/2h00000039nydg6d`) and dashes are optional — `2H00-0000-39NY-DG6D` typed
   by hand works too.
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

### 4.3 Layer 3 — the production shape

Only worth doing before putting the app on the real server:

1. Write a real `.env` from [`.env.example`](.env.example) with `PUBLIC_ORIGIN` =
   your real `https://` host and freshly generated secrets
   (`openssl rand -base64 48`).
2. `docker compose up -d --build` (weather: *without* `-f compose.dev.yaml`, so no mock
   IdP). This is what `dev.sh` never does.
3. Expect the session cookie to be `Secure`, QR URLs to be `https://…`, and login to
   fail until the Kanidm client (§10.1 of the spec) exists — that failure is the
   correct result of this layer.

Request-flow checks for these are §12 items 5, 15 (with nginx), 19 and 20.

## 5. Mock IdP behaviour (what "login" actually does)

The mock IdP stands in for Kanidm and mimics its endpoints
(`SPEC.md` §11). For testing it matters that it is **not a login form**:

- Any visit to `/login` logs you in immediately (no form, no password): the admin
  button returns `mockadmin` with the `admin` role, and `?as=member` returns a
  `member` without it, so the read-only path is testable.
- It enforces PKCE and client authentication exactly like Kanidm, so the app's OIDC
  code is really exercised, not bypassed.
- The browser-facing URLs (issuer, authorize) point at `localhost:9000`; the URLs the
  app calls server-to-server (token, JWKS) point at `mock-idp:9000`. That split lives in
  `compose.dev.yaml` (`MOCK_PUBLIC_URL` / `MOCK_INTERNAL_URL`) and is why the app sets
  `OIDC_ISSUER` to the browser-facing issuer.
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
| `port is already allocated` on 8080/9000 | something else is using it: `ss -ltnp \| grep -E ':8080\|:9000'`, stop it, or change the published ports in `compose.dev.yaml` |
| `cannot talk to the docker daemon` | Docker is not running, or your user is not in the `docker` group |
| `env file …/.env not found` from *another* compose command | run compose through `./dev.sh`, or `cp .env.example .env` |
| `dev.sh up` after editing `Dockerfile` or `package.json` | `./dev.sh up --build` (plain `up` reuses the image) |
| Login bounces back with an error page | the mock IdP restarted mid-login; just log in again, or `./dev.sh logs mock-idp` |
| 429 on every page for a while | the smoke test's rate-limit check; wait 60 s |
| Want a clean start | `./dev.sh reset` |
| Inspect the DB | `sqlite3 dev-data/cosas.dev.db` if `sqlite3` is installed; if not, use a throwaway Node container: `docker run --rm -v "$PWD/dev-data:/d" node:24-alpine node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/d/cosas.dev.db');console.log(d.prepare('select * from items').all())"` |

## 7. What "tested" means here

- `./dev.sh test` green = the plumbing (auth round trip, sticker generation, CSRF,
  permissions, rate limit) works on a clean start.
- §4.2 done end-to-end = the product works for a person with a phone camera.
- Neither proves the production deployment; that is §4.3 plus the operator's nginx.

For the full, exhaustive list — 23 numbered items including nginx and `https://`
behaviour — see [`SPEC.md`](SPEC.md) §12.

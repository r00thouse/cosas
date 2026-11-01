# hacklab-cosas — Inventory system spec

Version: 1.0 (draft for review) · Status: ready to implement · Languages: en, es

A barebones inventory for a hacklab / hackerspace. The defining constraint of the
whole project is that it stays small: one Node process, one SQLite file, no
frameworks, no ORM, no CSS toolchain, no i18n library. Everything below is written
so that an implementer can build it without making design decisions of their own.

---

## 1. Goals

1. Track physical gear: monitors, laptops, desktops, HDDs/SSDs, RAM, GPUs, PSUs,
   SBCs, phones, tablets, routers, switches, keyboards, mice, 3D printers,
   microcontrollers.
2. Every item is reachable by **sticker**: print a batch of QR codes *before*
   knowing what they will be stuck on, stick them on gear, scan to register.
3. Short, unguessable URLs that fit on a sticker. No sequential IDs in URLs.
4. Only **hacklab members** can log in, via **Kanidm** (OIDC). Every logged-in user
   is an admin *for now*; role separation is a Kanidm-side change later.
5. Two languages, English and Spanish.
6. Deploy with `docker compose` behind an existing nginx that terminates TLS.

## 2. Non-goals (explicitly deferred, not "later maybe" features)

- Item movement history, loans, "who has it when", due dates.
- Barcode / serial-number scanning. (Reading *our own* QR stickers from a phone is in
  scope, §8.9.)
- Galleries, image editing, EXIF cleanup or server-side thumbnails (several photos per
  item *are* in scope, §8.8, up to 8; no other file uploads).
- Email notifications.
- CSV/JSON *import* (export is in, see §8 route 17).
- API tokens, public REST API, webhooks.
- Label-sheet PDF generation, printer-specific templates. (The print page is
  generic: one QR per code, HTML + `@media print`.)
- Small parts (capacitors, resistors, screws), hand electrical tools, furniture.
- Multi-tenancy, multiple sites, multiple databases.
- Any "user profile" pages, avatars, display-name editing in-app.
- Audit log UI. (`items_audit` exists in the DB as a safety net, see §6.2; no UI.)
- A "revoked codes" list or history UI. `forgotten_codes` exists only so a revoked
  sticker keeps its 410 page (§6.3); it is never listed anywhere.
- Second factor / step-up auth beyond what Kanidm enforces.

## 3. Runtime contract (the rules the code must obey)

| Rule | Value |
|---|---|
| Runtime | Node.js ≥ 24 (uses built-in `node:sqlite`) |
| Dependencies | **Three** browser-side components, nothing else: `qrcode-generator` (render stickers), `jsqr` (read them from the camera), `cropperjs` (the optional crop step, §8.8). All three are vendored from `node_modules/` and served as plain `<script>`/`<link>` for a page under `/vendor/`; pinned in `package-lock.json`. No framework, no bundler, no transpile step, no dev-dependency toolchain. |
| Source layout | Flat files in the repo root: `server.js`, `oidc.js`, `code.js`, `store.js`, `i18n.js`, `html.js`; plus `db/migrations/`, `public/`, `tools/`. No bundler, no transpile step. See §13 for build order. |
| DB | Single SQLite file, `DB_PATH`, synchronous access via `DatabaseSync`. |
| Concurrency | Exactly one process. No horizontal scaling, never. |
| HTTP | Plain HTTP, `0.0.0.0:8080`. TLS is terminated by the operator's nginx. |
| Rendering | Server-rendered HTML strings. One `html` tagged-template helper. |
| CSS | One static `public/app.css` (~150 lines), no build step. |
| JS in the browser | One static `public/app.js`, only for: language switcher, `+1`/`−1` qty buttons (fetch), copy-to-clipboard. Pages work without it. |
| i18n | One `i18n.js` object of key→{en,es}. No library. Copy conventions in §9.3 are binding. |
| Migrations | `db/migrations/NNN_name.js` (exports `up(db)`) applied in numeric order under `PRAGMA user_version`; the runner wraps each in BEGIN/COMMIT (§6.2). No migration library. |

Not allowed anywhere: Express/Koa/Fastify, React/Vue, Tailwind/Bootstrap, an ORM,
`better-sqlite3`/`node-sqlite3`, `i18next`, `csurf`, `helmet`, a JSON-Web-Token
library (see §5.3 for the ~40-line replacement).

---

## 4. Roles and authentication

### 4.1 Who is who

| Actor | Can |
|---|---|
| Anonymous (no session) | Open `/r/<code>`. If bound: see the **public** item view (§8.3). If unbound: see a "log in to claim" screen. |
| Member (logged in) | Everything. Today a member *is* an admin. |
| Kanidm user not in the app's group | Cannot log in at all (Kanidm refuses the authorization; the app surfaces `auth.denied`). |
| Group member without `roles` claim | Logs in as `admin` (v1 default, §5.3 step 6), whether or not the token carries a `groups` claim. |
| Member of the app group but not of `OIDC_ADMIN_GROUP` | Logs in as `member`: reads everything, every write returns 403. Only when `OIDC_ADMIN_GROUP` is set. |

There is no admin/member split in the app in v1. The `role` value is carried in the
session cookie but only values `admin` exist today; the code checks
`session.role === 'admin'` for every write, so that promoting a second role later
means changing Kanidm config, not app code.

### 4.2 Kanidm configuration (confidential client — this deployment uses secret auth)

```bash
kanidm group create inventory_users
kanidm group add-members inventory_users <alice> ...
kanidm person update <alice> --legalname "..." --mail "alice@hacklab.example"

# Confidential client. name = client_id used by the app.
kanidm system oauth2 create cosas "Hacklab Cosas" "https://cosas.<domain>"
kanidm system oauth2 add-redirect-url cosas "https://cosas.<domain>/oidc/callback"
kanidm system oauth2 update-scope-map cosas inventory_users openid profile
# Optional, only if you want a role claim now; not required in v1:
# kanidm system oauth2 update-claim-map cosas role inventory_users admin

# Optional: a real admin/reader split, decided in the app by OIDC_ADMIN_GROUP.
# Use the `groups_name` scope, not `groups`: Kanidm's `groups` scope puts uuids and
# spns ("cosas_admin@idm.example.com") in the claim, `groups_name` puts plain names.
# The app normalises all three shapes, but plain names are what `OIDC_ADMIN_GROUP`
# compares against, so a bare name keeps the config obvious.
kanidm group create cosas_admin
kanidm group add-members cosas_admin <alice>
kanidm system oauth2 update-scope-map cosas inventory_users openid profile groups_name
#   then set OIDC_ADMIN_GROUP=cosas_admin in .env
kanidm system oauth2 show-basic-secret cosas   # → OIDC_CLIENT_SECRET
```

Notes that come from Kanidm's documentation and matter here:

- The **discovery URL is per-client**:
  `https://idm.<domain>/oauth2/openid/cosas/.well-known/openid-configuration`.
  Set `OIDC_DISCOVERY_URL` to that exact URL (the app does not append anything).
- Kanidm requires **PKCE S256** and **ES256** ID tokens. The app implements both.
- Kanidm requires **HTTP Basic** client authentication on the token endpoint
  (`client_secret_basic`). The app sends `Authorization: Basic base64(urlencode(id):urlencode(secret))`.
- The redirect URI is an **exact-match allowlist**. There is exactly one:
  `https://cosas.<domain>/oidc/callback`. No localhost redirects, no alternates.
- Kanidm **will not** enforce HTTPS; it is a browser-side requirement. Production
  must therefore be served over HTTPS by the fronting nginx.

### 4.3 OIDC flow (authorization code + PKCE, server-side)

```
GET /login
  state  = random 32 bytes → base32
  verifier = random 32 bytes → base64url (43 chars, RFC 7636 allowed charset)
  challenge = base64url(sha256(verifier))
  store in cookie `oidc_tx` = <base64url(JSON)>.<signature>   (same scheme as §4.4)
      payload = {state, verifier, next: validatedNext(request.next), exp: now+600}
  redirect to discovery.authorization_endpoint   # exact string from Kanidm's doc;
                                                 # do NOT hardcode /ui/oauth2
    ?response_type=code
    &client_id=<OIDC_CLIENT_ID>
    &redirect_uri=<PUBLIC_ORIGIN>/oidc/callback
    &scope=openid%20profile
    &state=<state>
    &code_challenge=<challenge>
    &code_challenge_method=S256

GET /oidc/callback?code=&state=
  verify cookie signature + expiry; verify state === tx.state (both ARE the state)
  if the IdP returned ?error= (user denied, etc.) → clear cookie, 403 auth.denied
  if the cookie is missing/invalid or code is missing → clear cookie, 400 auth.callback_error
  `next` is re-validated (§10.3) immediately before the redirect; never used raw
  POST token_endpoint
    Content-Type: application/x-www-form-urlencoded
    Authorization: Basic <id:secret>
    grant_type=authorization_code&code=&redirect_uri=&code_verifier=<verifier>
  → verify id_token (§5.3), read sub, preferred_username, role
  Set-Cookie: session = sign({sub, name, role, exp: now+8h}); clear `oidc_tx`
  302 → next (validated, §10.3) or `/`

POST /logout  (CSRF-protected)
  Set-Cookie: session=; Max-Age=0; 302 → /
```

No `/login` → `/logout` round trip hits Kanidm: logout is local (cookie deletion).
Kanidm's own session cookie is untouched; that is acceptable for v1.

### 4.4 Session cookie

- Name `session`. Value `<base64url(JSON)>.<base64url(HMAC-SHA256(secret, payload))>`
  where payload = `{sub, name, role, iat, exp}`.
- HMAC key: `SESSION_SECRET` (≥32 bytes). Rotating it logs everyone out.
- `Path=/; HttpOnly; SameSite=Lax`; add `Secure` **only if `PUBLIC_ORIGIN` starts
  with `https://`**. Same attributes on deletion.
- Lifetime 8 hours absolute. No sliding renewal, no refresh tokens stored.
- No session table. Logout = delete the cookie. There is no server-side revocation
  in v1 (documented consequence: a stolen cookie is valid ≤8 h). Expiry has no
  "session expired" screen: an expired cookie fails the same CSRF/auth checks as no
  cookie, so the next POST is 403 `err.csrf` (§5.1) and the next GET renders as an
  anonymous visitor with a login link.

### 4.5 The temporary `oidc_tx` cookie

Same signing scheme as §4.4, 10-minute lifetime, `Path=/; HttpOnly; SameSite=Lax`
(plus `Secure` under the §4.4 rule). It **must** be `Path=/`: it is set by the
browser on `GET /login`, so a narrower path would never be sent back. It is the *only* client-side
OAuth state; no server-side authorization-request table exists.

---

## 5. Security

### 5.1 CSRF

Every state-changing request is a **POST**. Every POST form contains
`<input type="hidden" name="_csrf" value="<csrf>">` where `csrf` is derived from
the session cookie signature:

```
cookie_signature = the ASCII base64url string that is the part of the `session`
                   cookie AFTER the first "." (the HMAC, not the payload)
csrf = base64url( HMAC-SHA256(SESSION_SECRET, "csrf:" + cookie_signature) )[0:22]
```

- Cookie-based sessions are `SameSite=Lax`, which already blocks cross-site POSTs
  from `<form>` submissions in current browsers. The `_csrf` token is defense in
  depth and *is* required (not optional) by this spec.
- Anonymous visitors have no `csrf`. They can only GET.
- **Pipeline order is fixed** (§13 step 4): rate limit → language → parse session →
  **CSRF check before the auth check** → route. So an anonymous or expired-session
  POST always gets **403 `err.csrf`** (never a login redirect), and an invalid
  `_csrf` is rejected before any handler runs.
- `/logout` accepts POST only.

### 5.2 Response headers (set on every response)

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Content-Security-Policy: default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:; manifest-src 'self'; worker-src 'self'; media-src 'self' blob:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'
Cache-Control: no-store          (all HTML; on static assets use max-age=3600,
                                  or max-age=31536000, immutable when ?v= matches — §8.11)
```

The extra directives beyond the original allowlist are load-bearing for §8.9/§8.10:
`connect-src 'self' blob:` lets the qty `fetch()` call the app — and lets Cropper.js
read the picked file's own blob to honour EXIF orientation (§8.8) — `media-src 'self'
blob:` allows the camera stream, `img-src … blob:` lets `app.js` load the picked file
into an `<img>` before it downscales it to `photo_data`, and `manifest-src` /
`worker-src` let the PWA manifest and the service worker load.

CSP forbids inline `<script>` and inline `style=` attributes. This is deliberate:
it keeps `public/app.js` and `app.css` honest and keeps templates free of
injection surface. **Exception:** the print page may use a `<style>` block only if
`style-src` is widened to `'unsafe-inline'` — do **not** widen it; put print rules
in `app.css` under `@media print`. **Same rule for scripts:** with no `'unsafe-inline'`
and no imports, page-specific JS lives in `public/app.js` that dispatches on
`document.body.dataset.page` (e.g. `"add"` for the scanner), and the scanner's
decoder is loaded as a plain `<script src="/vendor/jsQR.js" defer>` before it. The
QR *encoder* never runs in the browser: every sticker is server-rendered SVG (§7.5). Never emit an inline `<script>`
from a template.

### 5.3 ID token verification (~40 lines, in `oidc.js`)

1. Split the JWT; decode header and claim part (base64url → JSON). Reject if either fails.
2. Require `header.alg === 'ES256'`. Reject `none`, `HS256`, `RS256` (never negotiate).
3. Fetch `<issuer>/.well-known/jwks.json` (the issuer's own key endpoint from the
   discovery doc; cache 1 hour, single-flight refresh on `kid` miss), select the
   JWK with matching `kid`, require `kty:'EC'`, `crv:'P-256'`.
4. Verify the signature with `crypto.createPublicKey({key: jwk, format:'jwk'})` and
   `crypto.verify('sha256', Buffer.from(sigB64url), key)` (ES256 = JWS raw
   r‖s, which `crypto.verify` accepts).
5. Validate claims: `iss === discovery.issuer`, `aud === OIDC_CLIENT_ID`,
   `exp > now - 60`, optional `nbf`, optional `nonce` if we ever send one (we don't
   in v1 — the `state` cookie covers the callback).
6. `role`, first rule that matches:
   1. a `roles` claim (from a Kanidm claim map) decides both ways — contains `admin`
      → `admin`, otherwise `member`;
   2. else, if `OIDC_ADMIN_GROUP` is set, membership of that group in the `groups`
      claim → `admin`, otherwise `member`;
   3. else `admin` (v1: everyone who got in is an admin).

   `groups` alone is **not** treated as a role list: Kanidm sends the user's real
   groups (`inventory_users`, ...), so looking for the literal string `admin` among
   them silently demoted every real deployment to read-only while the dev mock
   (whose group happened to be called `admin`) kept working.

   Kanidm shapes the claim by scope: `groups_name` → bare names, `groups` → uuids
   *and* spns (`cosas_admin@idm.example.com`), `groups_spn` → spns only. The app
   normalises every entry to a lowercase bare name before comparing (dropping
   uuids), so all three scopes work; `groups_name` is the recommended one because
   then `OIDC_ADMIN_GROUP` is literally the group name.

### 5.4 `/r/<code>` protections

- The **sticker code is a capability but not an authorization**: reading a bound
  item requires nothing more than the code, writing requires a member session.
- Codes are HMAC-signed (§7), so random 404-probing of `/r/*` is cheap to reject:
  compute the HMAC first, and only then look in the DB (no DB hit for forged codes).
- Rate limit, in-memory, per client IP. When `TRUST_PROXY=0` the key is the socket
  address. When `TRUST_PROXY=1` the key is the **last** comma-separated entry of
  `X-Forwarded-For` (the right-most entry is the address our own nginx saw, since
  it appends to any client-supplied list — the left-most entries are
  client-controlled and must never be used), falling back to the socket
  address if the header is absent. The nginx block overwrites XFF outright, which
  is the stronger version of the same rule: send
  `proxy_set_header X-Forwarded-For $remote_addr;` (§10.2 shows the config). Limits: **30 requests / 60 s** for all `/r/*`
  GETs, **10 / 60 s** for `/r/*` POSTs, **30 / 60 s** for `/login` and
  `/oidc/callback`. On exceed: `429` with `Retry-After: 60` and a translated page.
  Implementation: one `Map<ip, {bucket, count, resetAt}>`, swept every 5 min. No
  Redis, no library.
- The public view deliberately hides serial, model, `held_by`, notes (§8.3).

### 5.5 Code enumeration (accepted risk)

A live code sits in a ≥ 2⁵⁰ space by construction (`MM`+`SSS`+`NNN`, §7.1), so
guessing one is infeasible. The 20-bit HMAC tag is what makes random 404-probing
cheap to reject (§5.4), not what makes guessing hard. The accepted residual risk is that an **admin's own** sticker photos
leak a code; that grants read of one item's public view, not write.

---

### 5.6 Escaping (mandatory)

- The `html` tagged template **escapes every interpolated value** (`& < > " '`).
- The only way to emit trusted markup is an explicit `raw(trustedString)` call.
  `raw()` may appear in: layout chrome, and `dangerously`-named spots only — grep for
  `raw(` as a review step; every occurrence must be justified in a comment.
- Attributes are always double-quoted. `href` values come only from `url(path)`
  (internal paths) or `PUBLIC_ORIGIN`; user-controlled URLs are never rendered.
- `data-*` attributes used by `public/app.js` are escaped the same way; the JS reads
  them with `dataset` and never uses `innerHTML`.
- Multi-line user text (`notes`) is rendered inside `<p>`/`<pre>` **text** nodes,
  never with `<br>` injection.

### 5.7 Profile and group claims from userinfo

Kanidm clients differ in where the profile claims arrive: some deployments put
`groups` in the id_token, others only in the userinfo response. After the id_token
verifies, `exchange()` does `GET <userinfo_endpoint>` with the access token and merges
the result: **id_token wins for the protocol fields** (`iss`, `aud`, `sub`, `exp`,
`iat`, `nbf`, `nonce`, `azp`), userinfo fills in `groups`, `name`,
`preferred_username`, `email`, `roles`. A missing endpoint, an expired token or a 5xx
logs `oidc.userinfo_failed` and continues with the id_token claims alone, so a broken
userinfo can never block a login.

Every successful login writes one diagnostic line, at `info`, so a role surprise is
visible without a debugger:

```json
{"level":"info","msg":"auth.login","sub":"…","name":"alice","userinfo":true,
 "claims":["aud","exp","groups","iss","name","sub"],"roles":null,
 "groups":["cosas_admin@idm.example.com"],"group_names":["cosas_admin"],
 "admin_group":"cosas_admin","role":"admin"}
```

`requested_scopes` and `granted_scopes` come from `OIDC_SCOPES` and from the token's
own `scopes` claim; when `OIDC_ADMIN_GROUP` is set but no groups arrived, the line also
carries a `hint`.

Read it as: `groups` is what the IdP actually sent, `group_names` is that after
normalisation (uuid dropped, `@domain` stripped, lowercased), `admin_group` is
`OIDC_ADMIN_GROUP` as configured, `role` is the decision. If `groups` is `null` or
`[]`, the scope map is wrong; if `admin_group` is `null`, the variable is unset; if
`group_names` does not contain it, compare the exact spelling.

## 6. Data model

### 6.1 Why there is no `codes` table

Per the design decision, codes are **generated freely** and the system only learns
a code when a sticker is applied, so there is no "unused code pool" and no `codes`
table. `item_codes` holds claimed codes (the current binding) and `forgotten_codes`
holds revoked ones, so a dead sticker can still explain itself (§6.3).

### 6.2 `db/migrations/001_init.js` (schema below)

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE items (
  id            INTEGER PRIMARY KEY,
  code          TEXT    NOT NULL UNIQUE,          -- canonical 16-char code, §7
  code_seq      INTEGER NOT NULL,                 -- the SSSSSS field, informational (§7.1)
  name          TEXT    NOT NULL DEFAULT '',      -- short human name, e.g. "Monitor LG 24"
  category      TEXT    NOT NULL DEFAULT '',      -- free text w/ autocomplete, §8.5
  model         TEXT    NOT NULL DEFAULT '',
  serial        TEXT    NOT NULL DEFAULT '',
  location      TEXT    NOT NULL DEFAULT '',      -- free text w/ autocomplete
  status        TEXT    NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available','in_use','broken','missing')),
  held_by       TEXT    NOT NULL DEFAULT '',      -- free text (who has it), '' = nobody
  qty_mode      TEXT    NOT NULL DEFAULT 'count'
                        CHECK (qty_mode IN ('count','bin')),  -- see §8.3 qty rules
  qty           INTEGER NOT NULL DEFAULT 1 CHECK (qty >= 0 AND qty <= 100000),
  notes         TEXT    NOT NULL DEFAULT '',      -- may contain newlines
  deleted_at    TEXT,                             -- ISO-8601 UTC or NULL
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX idx_items_live      ON items (deleted_at);

-- one row per photo (§8.8): the file name lives here, never in `items`
CREATE TABLE item_photos (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items(id),
  name       TEXT    NOT NULL UNIQUE,             -- file name in PHOTO_DIR
  created_at TEXT    NOT NULL
);
CREATE INDEX item_photos_item ON item_photos (item_id, id);
CREATE INDEX idx_items_category  ON items (category);
CREATE INDEX idx_items_status    ON items (status);
CREATE INDEX idx_items_location  ON items (location);

CREATE TABLE item_codes (             -- claimed codes = the audit trail of bindings
  code       TEXT    PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL
);
CREATE INDEX idx_item_codes_item ON item_codes (item_id);

CREATE TABLE items_audit (            -- safety net; no UI in v1
  id         INTEGER PRIMARY KEY,
  code       TEXT    NOT NULL,        -- code at the time of the event (may be gone)
  action     TEXT    NOT NULL,        -- 'register' | 'update' | 'delete' | 'restore' | 'rebind' | 'qty'
  actor      TEXT    NOT NULL,        -- session.sub
  before     TEXT,                    -- JSON snapshot, NULL for register
  after      TEXT,                    -- JSON snapshot, NULL for delete (soft)
  at         TEXT    NOT NULL
);

CREATE TABLE forgotten_codes (        -- freed sticker codes must not be reusable
  code       TEXT    PRIMARY KEY,
  reason     TEXT    NOT NULL,        -- always 'rebind'; deleting never forgets a code
  at         TEXT    NOT NULL
);
```

`002_code_history.js` adds one table, `code_history (code PRIMARY KEY, item_id, reason, at)`:
the code at the time of a rebind and the item it came from. It exists because
`items.code` is `UNIQUE` and item rows are never deleted (§6.3 r4): the retired
owner's row may keep a retired code string, so "which item did this sticker once belong to" is
history, not a column on `items`.

`003_photo.js` added a single `items.photo` column (§8.8); `004_item_photos.js`
replaces it with the `item_photos` table — it creates the table, copies every existing
file name into it, and drops the column, so an upgraded database keeps its images and
the order of the copied rows is the row id. The bytes are never in the DB — only file
names are.

`db/migrations/002_*.js` and up as needed. `db/migrations/index.js` imports each
module and exports `[{ version: 1, up }, …]` sorted by version (no directory
scanning, no file naming rules). The runner (pseudocode):

```js
const v = db.prepare('PRAGMA user_version').get().user_version;
for (const { version, up } of migrations) {   // from db/migrations/index.js
  if (version <= v) continue;
  db.exec('BEGIN');
  try { up(db); db.exec(`PRAGMA user_version = ${version}`); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }  // boot exits 1, container stays down
}
```

Migrations are **JS modules** (`db/migrations/001_init.js` exporting `up(db)`), not
`.sql` files: no SQL statement splitting, and the SQL inside `up()` is the same text
shown in §6.2 (written as `db.exec(\`...\`)`). `node:sqlite` (Node ≥ 22, in Node 24
no experimental flag needed) is the only DB API used: `new DatabaseSync(DB_PATH)`,
prepared statements via `db.prepare(...).run/get/all`. `PRAGMA journal_mode=WAL`,
`PRAGMA foreign_keys=ON` and `PRAGMA busy_timeout=5000` are set at boot.

### 6.3 Invariants (enforced in `store.js`)

1. `item_codes.code` **and** `forgotten_codes.code` are both unique; a code that is
   in `forgotten_codes` can never be claimed again (checked before every claim).
2. `items.code` equals the code claimed to it. **Rebind** an item in one
   `BEGIN`/`COMMIT` via `db.exec`: insert the new code into `item_codes`, move the old
   code to `forgotten_codes` (`reason='rebind'`), **delete** the old `item_codes` row,
   set `items.code = new`, and write `(old code, item id, 'rebind')` into
   `code_history`. History lives in `items_audit` too. The new code passes the
   rule-3 check first (a retired code is **never** accepted as a new code).
   Because the old code is forgotten, a re-scan of the retired sticker is **410
   `scan.revoked`**. A retired code that shows up again on a brand-new sticker
   (`freshCode` may pick any code, `start` is only a counter default, §7.5) is
   explained as `scan.reused`: printing does not consult the database. Claiming a
   *retired* code for a new item is refused (409 `err.code_taken`): the retired
   owner's row still holds it, and older items must remain explainable.
3. A *register* on a code that is already claimed → **409** `err.code_taken` page with
   a `[Revoke and print new sticker]` link (never a silently re-rendered form).
4. Delete = **soft delete only** (`deleted_at` set); the row and its code stay,
   and the code is NEVER moved to `forgotten_codes`. The **claim** (`item_codes`
   row) is dropped, so the code is free for registration again: a fresh item
   registered with that code takes over the old sticker (and shows `scan.reused`).
   Until that happens the deleted item's page is **410 "deleted"** (§8.6), which is
   the recovery path: a member can *restore* it there, and `restore` re-claims the
   code. `restore` on a code that a live item has claimed, or that is a retired
   sticker, since → **409** `err.code_taken` (nothing is overwritten). No archive
   UI. `store.js` keeps this in one BEGIN/COMMIT.
5. **A soft-deleted item accepts exactly one write: `restore`** (by item id, on
   its 410 page). Every other POST that resolves to a deleted item returns 410 and
   changes nothing (`rebind` looks the item up by id and refuses deleted items too).
6. `item_codes` and `forgotten_codes` are disjoint (a retired code is both removed
   from the claims and added to `forgotten_codes`). A code in `forgotten_codes` can
   never be claimed *again* (§6.3 r2: the retired sticker keeps explaining itself).
   The one predicate the code paths share:
   - `hasLiveClaim(code)` = an `item_codes` row joined to a non-deleted item.
   - `register` refuses when `hasLiveClaim(code)`; a retired code whose owner's row
     still holds it (rows are never deleted) is refused as well: 409 `err.code_taken`.
   - `rebind` refuses a new code when `hasLiveClaim(newCode)` or when the code is in
     `forgotten_codes`.

### 6.4 Timestamps

All timestamps are stored as `new Date().toISOString()` (UTC, ISO-8601, second
precision). Rendering is server-side, so there is no browser locale: use
`new Intl.DateTimeFormat(activeLang)` (the §9.1 language, `en` or `es`). Nothing is
stored local.

---

## 7. Sticker code format

### 7.1 Layout

Canonical code, exactly **16 characters**, alphabet = Crockford base32
(`0-9 A-H J K M N P Q R S T V W X Y Z`, i.e. no `I`, `L`, `O`, `U`) so it is
case-insensitive and human-typeable.

```
MM RRRRRR RRRR HHHH      16 chars, Crockford base32
```

| Field | Chars | Bits | Meaning |
|---|---|---|---|
| `MM` | 2 | 10 | month index `(year-2020)*12 + (month-1)`, big-endian base32 (≈85 years) |
| `RRRRRR` | 6 | 30 | random bits, drawn per code (`crypto.randomInt(0, 2**30)`) |
| `RRRR` | 4 | 20 | random bits, drawn per code (`crypto.randomInt(0, 2**20)`) |
| `HHHH` | 4 | 20 | HMAC-SHA256 truncation, below |

- **Nothing is sequential.** The 50 random bits of `RRRRRR`+`RRRR` are drawn fresh
  for every code, on a sheet and for a new item alike. Two stickers printed in the
  same second have unrelated codes, so a sheet leaks neither its size nor its order,
  and there is no counter to keep in sync (§7.4).

- **Written canonical form on stickers:** `MMMM-MMMM-MMMM-MMMM` as printed text
  (dashes are cosmetic only, never part of the stored value), e.g.
  `2JHD-TGKQ-3N13-FQC3` (the characters are random; only the shape is fixed).
- **URL form:** `/r/<16 chars, no dashes>, accepted case-insensitively`.
- **Type-ahead tolerance:** `I`,`L`→`1`; `O`→`0`; `U`→`V`; strips dashes, spaces
  and lowercase. A code that normalizes to a different string but whose original
  HMAC matched is rejected (normalize *before* HMAC check).
- Effective entropy: forging a code for a **specific** sticker (e.g. to read the
  serial of the monitor you already suspect) costs ~2²⁰ online attempts, which the
  §5.4 rate limit turns into ~24 days per IP — and §5.4 rate-limits `/r/*` for
  exactly that reason. Forging *any* live item needs it to land in the set of
  codes that someone has actually printed: ~10⁴ stickers per decade out of a 2⁵⁰
  random space, i.e. ~2⁻³⁶. The HMAC is what makes `/r/*` reject 99.9999% of
  guesses without a DB lookup; it is not secret material.
- **Collision check on claim:** if `item_codes`/`forgotten_codes` already holds the
  code, refuse (should essentially never happen; time-based MM makes cross-month
  collisions possible in principle, so it is a real check).

### 7.2 Crockford base32 helpers

```
ALPHABET   = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"     # index = value, 0..31
decode(c)  = ALPHABET.indexOf(c) after normalization (I,L->1; O->0; uppercase)
encode(n, w) -> w chars, MSB first, value = floor(n / 32**(w-1-i)) % 32

# verification of a 20-bit tag field (used by /r/* and by code.js tests):
# base32 carries 32 values per char and 20 is not a multiple of 5, so 4 chars
# CANNOT encode 20 bits directly. Decode the 4 tag chars to a 20-bit value:
tagValue = ((((d0*32 + d1)*32 + d2)*32 + d3) % 2**20)
# and compare it with the same expression over the recomputed MAC's 4 chars
# (the MAC side is reduced with the identical final modulo, so both sides agree:
# encode() sees tagValue exactly, so its 4 chars decode back to tagValue).
# Constant-time compare: crypto.timingSafeEqual over the two values as 4-byte
# big-endian buffers.
```

Never compare tag *strings* (string compare is not constant-time and hides the
modulo mistake). One helper, used everywhere:

```js
fieldValue(chars, bits)  // base32-chars -> integer, then % 2**bits
                         // MM: (2,10)  SSSSSS: (6,30)  NNNN: (4,20)  HHHH: (4,20)
```

(For `decode` the *inverse* is `encode(n, w)`; a decoded value must first be
reduced with `% 2**10` / `% 2**30` before comparing with a known `(mm, seq)`.)

All fields are big-endian base32 of fixed width. `SSSSSS` = 6 chars = 30 bits,
max 1,073,741,823 codes per month; `MM` wraps at value 1023 (>85 years).

### 7.3 HMAC tag

```
key   = HMAC-SHA256(CODE_SECRET, "hacklab-cosas/code/v1")       # 32 bytes
msg   = ASCII("v1" + MM + SSSSSS + NNNN)                        # 12 chars
mac   = HMAC-SHA256(key, msg)                                   # 32 bytes
tag   = base32( (mac[0] << 12) | (mac[1] << 4) | (mac[2] >> 4) )  # top 20 bits
```

Concretely: build a 20-bit integer from the first three MAC bytes as shown, then
encode it as exactly 4 Crockford base32 chars, most-significant first.
Verification recomputes the tag and compares with `crypto.timingSafeEqual` over
the 20-bit value (compare bytes of the decoded integer, not strings, to avoid
unicode/length timing).

### 7.4 Generation

Two entry points, both using the same `code.js` module and the same `CODE_SECRET`:

1. **In-app**: `GET /codes` (member) → form "How many? [100] [Generate]" →
   `GET /codes?n=100` → the print page. Nothing is written to the DB.
2. **Offline CLI**: `node tools/gen-codes.js 100 [--url ORIGIN]`.
   Same output, for printing without touching the app.

**Randomness, not a counter.** Every code is `randomCode(secret, monthIndex)` =
`build(secret, month, randomInt(0, 2**30), randomInt(0, 2**20))`, i.e. 50 random
bits. There is no sequence number, no `codes.counter` file and nothing to keep in
sync between the app and the CLI. A sheet cannot be regenerated — and does not need
to be: codes that were printed but never scanned point at nothing, so nothing is
lost by simply printing another sheet.

Collisions are birthday-bounded: 100k codes over 2⁵⁰ bits collide with probability
≈ 4·10⁻⁶. `sheetCodes()` additionally de-duplicates within a single sheet (a repeat
would cost one extra draw, not a broken sticker).

### 7.5 QR content

`<PUBLIC_ORIGIN>/r/<code>` — e.g. `https://cosas.hacklab.example/r/2jhd-tgkq3n13fqc3`
  (lowercase, no dashes — the QR payload, §7.1). Codes are random, so the example is
  only a shape. `2H000000NF6H9SSF` is the `build(secret, 2026-10, seq 0, nonce 0xABCD1)`
  vector used by `tools/test/code.test.js`; it is an encoding check, not a sheet.

- Encoding uses the **`qrcode-generator`** npm package (MIT, no transitive deps),
  wrapped in `qrcode.js`: `qrMatrix(text, "M") -> { size, modules: boolean[][] }` and
  `matrixToSvg(matrix, opts)` which serialises one `<path>` of squares plus a white
  background; `opts` is `{px, quiet, dark, light, title, cls, bodyOnly, unit}` where
  `unit` multiplies every coordinate (the print sheet passes `24 / size` so the path
  is already in **millimetres** and needs no nested `<svg>` or transform — a scaled
  `<g>` was a real bug once: the QRs came out 10× too large). Nothing is encoded in
  the browser — every QR on screen and on paper is an inline server-rendered `<svg>`.
  - Error correction level **M**; quiet zone 4 modules; no logo, no colors.
  - Sticker = **50 × 25 mm**: QR 20 × 20 mm on the left; on the right the code as
    **two lines of 9 characters** (`MMMM-MMMM-` / `MMMM-MMMM`) at 6.5 pt monospace,
    with the bare `PUBLIC_ORIGIN` host below it at 5 pt. **44 stickers per A4 sheet
    (4 × 11)**, i.e. 275 mm of the 287 mm printable height. The printed grid is
    4 × **49.9 mm** = 199.6 mm, a hair under the 200 mm printable width, so no browser
    rounds the right-hand column off the page. The 19-character single line does
    **not** fit; never put it on one line. (Denser than a 60 × 30 mm / 21-up sheet:
    printing 100 stickers takes 3 pages instead of 5.)
- **The QR payload is the lowercase URL** `PUBLIC_ORIGIN/r/<code.lowercase()>` — no dashes,
  no trailing slash (URL form, §7.1). Encoders must not wrap or pad it.
- The **sticker HTML** is generated server-side on `/codes`; each sticker is an inline
  `<svg class="qr">` from `matrixToSvg(qrMatrix(url))`. No canvas, no JS: the sheet
  prints correctly even with scripting disabled. CSS handles pagination:
  `@media print { .sheet { display:grid; grid-template-columns: repeat(3, 1fr); } }`
  and `@page { margin: 5mm }`. No PDF library.
- `/codes/svg` renders the same sheet server-side as one standalone SVG through the
  same `matrixToSvg`/`sheetSvg` code, so the HTML stickers and the download can never
  disagree. There is no HTML fallback: `/codes/svg` is always `image/svg+xml`
  (acceptance item 6 checks it).
- **A sheet is generated once and then frozen on paper.** `sheetCodes(secret, origin, n, month)`
  draws `n` codes with `randomCode()` (§7.4), rejects duplicates inside the sheet, and
  returns `[{code, url, text}]`. Generating again gives different codes — deliberate:
  a printed sheet is the only copy that matters, and nothing in the flow needs to
  reproduce one (§7.4). The in-app generator, `/codes/svg` and the CLI all call this
  one function, so they can only agree on *shape*, never drift.

---

## 8. Pages and routes

Every route is listed with its method, auth requirement, and behavior. `302` means
a redirect. All HTML responses are `text/html; charset=utf-8`.

| # | Route | Auth | Behavior |
|---|---|---|---|
| 1 | `GET /` | anon | Item list: search + filters + 50/page. Anon sees only the §8.3 public subset per row (name, category, status, location, qty) and no actions; anon `q` searches name, category and location only. |
| 2 | `GET /login` | anon | Start OIDC (§4.3). Optional `?next=` (allowlisted to `/` and `/r/*`, §10.3). |
| 3 | `GET /oidc/callback` | anon | Finish OIDC, set session, redirect. |
| 4 | `POST /logout` | member | Clear session, 302 `/`. |
| 5 | `GET /lang/:lang` | anon | `en` or `es` → set `lang` cookie (1 year), 302 back to `Referer`-derived same-origin path or `/`. |
| 6 | `GET /r/:code` | anon→member | Scan landing; **one path, two modes** (§8.3). |
| 7 | `POST /r/:code/register` | member | Create an item bound to this code from the "new item" form. Any code already claimed/deleted/forgotten → 409/410 per §6.3; never overwrites. |
| 8 | `POST /r/:code/edit` | member | Update any editable field of the bound item. |
| 9 | `POST /r/:code/status` | member | Set `status` (action sheet buttons). |
| 10 | `POST /r/:code/qty` | member | Set absolute qty or `delta=±1`. With JS the ±1 buttons fetch this route and get `{qty}` (JSON) back; without JS they are plain form posts (§8.3). |
| 11 | `POST /r/:code/rebind` | member | Give the bound item a *new* code (reprint); `302 → /r/<new>`, which renders the new-sticker panel (QR + text + `[Download SVG]`). |
| 12 | `POST /r/:code/delete` | member | Soft delete (confirm on the page, no `confirm()`). |
| 13 | `POST /r/:code/restore` | member | Restore a soft-deleted item (via the 410 page). |
| 14 | `POST /items/new` | member | Generate one fresh random code and `302 → /r/<new>`, which renders the **register form** for it. Creates no row. |
| 15 | `GET /codes` | member | No `n` → the count form. With `n` → the print sheet (§8.7). `n` outside 1–500 → **422** `err.range`. |
| 16 | `GET /codes/svg?n=` | member | `image/svg+xml` download of the same sheet (print/archive). |
| 17 | `GET /export.csv` | member | All non-deleted items + `code, name, category, model, serial, location, status, held_by, qty, notes, created_at, updated_at`. `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="cosas-YYYY-MM-DD.csv"`. Values RFC 4180 quoted; UTF-8 BOM **not** emitted. |
| 18 | `GET /healthz` | anon | `200 text/plain "ok"` after `SELECT 1`. No DB detail, no version. |
| 19 | `GET /static/*` | anon | `public/` files, `max-age=3600`, correct `Content-Type`, path-traversal rejected. |
| 20 | `GET /add` | member | Phone add page (§8.9): the camera QR scanner plus a typed-code fallback. `?code=` is normalized and validated → `302 /r/<code>`; anything invalid → `422 scan.not_found` rendered on the same page. |
| 21 | `POST /r/:code/photo` | member | Attach one more photo (§8.8): a `photo` file part, or `photo_data` (a downscaled data URL). 413 `err.photo_too_big`, 422 `err.bad_photo`, 422 `err.photo_limit` at 8 photos, 302 back to the item with `?flash=photo`. |
| 22 | `POST /r/:code/photo/:photo/delete` | member | Delete one photo and its file (§8.8). 404 for a photo id that is not this item's. 302 with `?flash=photo_removed`. |
| 22b | `GET /photo/:code/:photo` | member | The bytes of one photo with its real `Content-Type`, `cache-control: private, max-age=300`. 404 when that photo does not exist. |
| 23 | `GET /manifest.webmanifest` | anon | The PWA manifest (§8.10), `application/manifest+json`, `cache-control: no-cache`. |
| 24 | `GET /sw.js` | anon | The service worker (§8.10) at the origin root so its scope is `/`, `text/javascript; charset=utf-8`, `cache-control: no-cache`. |

There is **no** `/i/<code>` (decision Q30: one path). `/admin`, `/api`, and `/i`
are reserved path prefixes: they 404.

### 8.1 `/r/:code` — scan landing

```
rate limit (§5.4) → exceeded? 429
normalize code (§7.2) → recompute HMAC → invalid or length ≠ 16? 404 scan.not_found
  (no DB access for a forged code)
look up the item bound to the code (the stored form is canonical)
  → item exists, deleted_at set → 410 scan.deleted (§8.6)
  → item exists                 → item view (§8.3): public subset + (member) action sheet
  → no item, code in forgotten_codes → 410 scan.revoked (§8.6)
  → no item                     → (member) register form (§8.2); (anon) login prompt
```

Every `POST /r/:code/*` runs the same decision table **before** its handler (after
rate limit, CSRF and auth): invalid → 404; deleted → 410 (except `restore`); forgotten
or unbound → 410. POST handlers never fall back to re-rendering a stale page.

### 8.2 Register form (unbound code, member)

Fields exactly the columns of `items` minus `id, code*, code_seq, deleted_at,
created_at, updated_at`. Layout, mobile-first single column:

```
Code        0K3X-9P2T-7Q4B                 (read-only: 16 chars in 4-char groups)
Name        [____________________]  *
Category    [monitor        ▾]        datalist from SELECT DISTINCT category
Model       [____________________]
Serial      [____________________]
Location    [Shelf 3        ▾]        datalist from SELECT DISTINCT location
Status      (o) available ( ) in_use ( ) broken ( ) missing
Held by     [____________________]
Qty         [ 1 ]  (+1 / −1 buttons)
Notes       [____________________]    textarea, 4 rows
              [ Register ]
```

- `name` and `category` are required (non-empty after trim); everything else optional.
- **No double-submit**: the POST returns a 302 to `GET /r/<code>`, which now shows
  the item. A concurrent second register of the same code hits §6.3 rule 3 → **409**
  `err.code_taken` page with a `[Revoke and print new sticker]` link; the entered
  values are not saved — never a silent overwrite.
- Validation errors re-render the same form with **422** and per-field
  `err.field_required` / `err.qty_range` messages, values preserved.

### 8.3 Item view / action sheet (bound code)

Public view (everyone): `name`, `category`, `status` (as a colored badge),
`location`, `qty` (only if ≠ 1) — and nothing else. Model, serial, `held_by` and
notes are **not** shown anonymously (§5.4). A list row for an anonymous visitor is
exactly that same subset plus the scan link (no model column).

**Member only** — rendered as a `<section>` after the public subset:

```
Model / Serial / Held by / Notes / Created / Updated   (definition list)
[ Edit fields ]   → inline form (same fields as §8.2)
[ Available ] [ In use ] [ Broken ] [ Missing ]  → POST /r/:code/status
Qty 12  [ −1 ] [ +1 ] [ Set… ]                     → POST /r/:code/qty
[ Print new sticker for this item ]                → POST /r/:code/rebind (confirm panel)
[ Delete item ]                                    → POST /r/:code/delete (confirm panel)
```

Sticker panel: after a `rebind` (or on demand for a bound item) this section also
shows the sticker for `items.code` — an inline QR `<svg>`, the hyphenated code, the
`PUBLIC_ORIGIN` host, and `[Download SVG]` (§7.5).

Quantity rules: `qty_mode` is `count` (a serialized thing, normally qty 1) or `bin`
(a container of identical parts). **Both modes render the same controls** (`[ −1 ]`,
`[ +1 ]`, an absolute `qty` input + `[ Set… ]`): a `count` item may still lose value
(e.g. a RAM module of a kit), and hiding the controls made the mode a trap. The mode
is a label (`form.qty_mode.*`) that documents intent, not a permission. `POST /r/:code/qty` takes **either** an absolute `qty` field **or**
`delta=±1`, never both and never neither:
`delta` → `qty = clamp(qty + delta, 0, 100000)`;
absolute `qty` outside 0…100000 → 422 `err.qty_range`;
both/neither → 422 `err.qty_range`. Toggling the mode is part of the edit form
(`form.qty_mode.*` keys).

### 8.4 Filtering / search on `GET /`

```
q         LIKE on name, model, serial, category, location, held_by, notes
            (anonymous visitors: LIKE on name, category, location only)
category  exact
status    exact
            [ Search ] [ clean ]
```

Always `deleted_at IS NULL`. Case-insensitive via `LIKE … ESCAPE '\'` with `%`,
`_`, `\` escaped. Pagination `?page=N` (50 rows), footer with prev/next and
"1–50 of 213". Empty state: a translated hint plus, for members, a
"print stickers" link. Sorting: `updated_at DESC`, fixed — no sort UI in v1.

### 8.5 Autocomplete values

- `category`: fixed seed list (decision Q26):
  `monitor, laptop, desktop, server, sbc, phone, tablet, hdd, ssd, ram, gpu, psu, keyboard, mouse, router, switch, 3d-printer, microcontroller`
  plus `SELECT DISTINCT category FROM items WHERE deleted_at IS NULL`
  → rendered as `<datalist id="categories">`. Never auto-created.
- `location`: `SELECT DISTINCT location FROM items WHERE location <> '' AND deleted_at IS NULL`.
  Not pre-seeded; free text is expected.

Both fields render twice, on purpose:

1. a `<datalist>` in the markup (kept for browsers without JS and for the native
   picker), and
2. `public/app.js` `wireCombo()` turns the input into a tappable combo box: the same
   options, filtered on every keystroke, prefix matches first, at most 8 rows,
   `ArrowUp/ArrowDown` to move, `Enter` to accept, `Escape` to dismiss, `mousedown`
   to pick with a thumb. The list is positioned inside a `.combo` wrapper that the
   template emits around the input, so it overlays the next field instead of pushing
   the form down.

Why both: the native datalist is unusable on some Android keyboards and Safari, and
the whole point of the field is that an operator with a sticker in one hand types
three letters and taps the right category. The input stays free text either way —
a new category is created by typing it (§8.5, no auto-creation).

### 8.6 410 and 409 pages

**410**, two variants, both rendered with the normal page shell:

| Cause | Key | Code shown | Member action |
|---|---|---|---|
| Soft-deleted item | `scan.deleted` | the code | `[ Restore item ]` → `POST /r/:code/restore` |
| Forgotten (revoked) code | `scan.revoked` | the code | `[ New item with a new code ]` → `POST /items/new` |

Anonymous visitors see the message and the code only. No POST writes anything on a
410 page except `restore`. **A POST on a deleted or forgotten code returns 410 as a
plain error page** (`err` shell, same status): the confirmation buttons of that
page's forms are not available to it. A code that is **signed but never bound** is not a 410:
it renders the register form (§8.2) for a member and the login prompt for an
anonymous visitor (§8.1).

**Reused code (200, not an error).** When `code_history` has a row for this code
written by a rebind of *another* item, the item page shows the hint
`scan.reused`: this sticker was printed for something else before. When the code
is a retired sticker, its 410 `scan.revoked` page says why (it was replaced).

**409** `err.code_taken` (only from `POST /r/:code/register` on an already-claimed
code): shows the existing item's name, a link to its page, and
`[ Revoke and print new sticker ]` → `POST /r/:code/rebind`, which retires the old
code and returns the item with a fresh sticker.

### 8.7 `/codes` print page

- Form: count only (default 100, 1–500) and `[ Generate sheet ]` (a GET to
  `/codes?n=`). There is no starting number: codes are random (§7.4).
- Layout: 50 × 25 mm stickers, 4 columns × 11 rows = **44 per A4 page** (the print
  grid is 4 × 49.9 mm = 199.6 mm wide; 11 × 25 = 275 mm tall). Each sticker: QR (`PUBLIC_ORIGIN/r/<code>`, 20 mm) on the
  left; on the right the code in the §7.1 form, **two lines of 9 characters**
  (`MMMM-MMMM-` / `MMMM-MMMM`, 6.5 pt monospace) and the **PUBLIC_ORIGIN host**
  below it at 5 pt. A full page of 44 prints on exactly one A4 page.
- `[ New sheet ]` re-runs the same count with a fresh set of random codes.
- `[ Print ]` uses `window.print()`; everything else hidden with `@media print`.
- `[ Download SVG ]` → `/codes/svg` (same content, `image/svg+xml`), for people
  who print from Inkscape/Illustrator — `views.sheetSvg()` reuses the same
  `matrixToSvg` geometry as the HTML stickers, so the two cannot drift.
- **Nothing is persisted** by generating a sheet, and nothing needs to be: the
  codes are random (§7.4), the QR payload *is* the code, and a code is valid because
  of its HMAC — never because of where it came from. A sheet you printed and lost is
  simply a sheet nobody scanned; print another.

### 8.8 Item photos

Photos are optional decoration on an item; the row is still the source of truth. An
item may carry up to **8** of them (`MAX_PHOTOS` in `photos.js`); the limit exists
so the panel stays a grid and the export stays small, not for storage reasons.

- **Storage.** Bytes are files on disk in `PHOTO_DIR` (default
  `dirname(DB_PATH)/photos`; `compose.yaml` overrides it to `/photos`, its own bind
  mount), named `<item_id>-<12 hex>.<ext>` with mode `0600`. The `item_photos` table
  stores only the file name (`name TEXT NOT NULL UNIQUE`); rows come back in
  insertion order, which is the display order. No image library, no thumbnails, no
  EXIF stripping — the server only sniffs magic bytes.
- **Accepted input.** `image/jpeg`, `image/png`, `image/webp`, detected from the
  bytes (never from the filename or the `Content-Type`), up to **8 MB** each.
  Anything else → 422 `err.bad_photo`; over the size cap → 413 `err.photo_too_big`;
  past the photo limit → 422 `err.photo_limit`.
- **Two upload paths, one meaning.**
  1. `multipart/form-data` with a `photo` file part (the plain `<form>` path, no JS);
  2. `photo_data` in the ordinary form body, a `data:image/…;base64,…` URL produced
     by `public/app.js` after it redraws the picked file at 1200 px / JPEG q0.75.
     This is the phone path: a 4 MB camera shot leaves as ~150 KB.
- **Crop, optionally.** The moment a photo is picked, `app.js` offers a crop step
  (Cropper.js: `/vendor/cropper.js` + `/vendor/cropper.css`, loaded only on pages
  that have a photo input — the register form and the item panel). The dialog is a
  native `<dialog>` in the top layer, so the phone gets a modal surface plus
  `Escape` and the back gesture for free; its labels come from a
  `<template data-crop-template>` rendered by `views.js`, which keeps them in the
  translation table. Buttons: **Rotate**, **Use whole photo**, **Crop**, **Cancel**.
  Crop yields `getCroppedCanvas({maxWidth: 1600})` → `toDataURL("image/jpeg", 0.82)`;
  "whole" falls through to the ordinary downscale path; Cancel skips that file.
  Several picked files queue one dialog each. Without Cropper.js, or without
  `<dialog>`, no dialog appears and every photo takes the old path, so the crop step
  is pure enhancement (`connect-src` must allow `blob:` for Cropper's EXIF read).
  Several files may be picked at once (`multiple`), and picking again adds more:
  each file becomes its own `photo_data` field, the file input is cleared (`value = ""`)
  so the originals never travel next to their downscaled copies, and a thumbnail is
  appended to `[data-photo-previews]`. A repeated field name is an array in both the
  multipart and the urlencoded parser (`multipart.js`), so one register post can carry
  up to `MAX_PHOTOS` (8) photos. The body cap is 24 MB (`server.js` `MAX_BODY`)
  and every file is checked against `MAX_PHOTO` (8 MB).
- **Where it shows.** The register form (§8.2) accepts several photos as part of
  creating the item, which is what the phone "Add" flow needs: scan the sticker, take
  the label photo, take the front photo, save — one form, one round trip. The item
  page (§8.3) has a photo panel: a grid of square thumbnails
  (each linked to the full-size bytes, each with its own `[Delete photo]` form), then
  `[Take or choose a photo]` / `[Add another photo]`, `[Upload]`, and a local preview
  via `[data-photo-preview]`. Deleting one photo never touches the others.
- **Who can see it.** `GET /photo/:code/:photo` is a member route, like every other
  write. Anonymous visitors never get a photo URL, so a photographed serial number
  cannot leak through the public view. Images are sent with
  `cache-control: private, max-age=300` so the browser may keep them, the CDN may not.
- **Deleting an item** keeps its files (the row survives as deleted, so a restore
  brings the photos back). The CSV export carries a `photos` column with the count,
  and `collectGarbage()` on boot removes any file in `PHOTO_DIR` that no
  `item_photos` row points at.
### 8.9 Add an item from the phone (`/add`)

The intended workflow is: print 100+ stickers up front (§8.7), stick them on the
things, and later register each one by scanning it. Nothing is pre-registered —
`/add` does not reserve codes; it only reads one.

- `[Add]` in the header (member only) → `GET /add`.
- The page starts the camera in a `<video playsinline muted>` box and decodes frames
  about six times a second:
  1. `BarcodeDetector` with `qr_code` when the browser has it (Chrome/Edge/Android);
  2. otherwise **`jsQR`** (`jsqr`, MIT), served from the app at `/vendor/jsQR.js`
     and fed with canvas RGBA pixels (`jsQR(data, w, h, {inversionAttempts:"dontInvert"})`).
     This is the Safari/iOS path. Do not hand-roll a decoder again: QR detection
     (finder patterns, perspective, Reed–Solomon) is the one thing here that a
     library must own.
- On a read, the payload is reduced to a sticker code — the scanner accepts
  `PUBLIC_ORIGIN/r/<code>`, any pasted `…/r/<code>` link, or a bare/dashed code — and
  the browser navigates to `/r/<code>`. That is the existing §8.1 landing: register
  form for a free code, item view for a bound one. **One flow, no new state.**
- A QR that is not ours shows `add.not_ours` and keeps scanning.
- No camera or no permission → `add.camera_denied` / `add.unsupported`, and the page
  always offers the typed fallback: a GET form to `/add?code=…` that validates the
  code server-side and redirects to `/r/<code>` (422 `scan.not_found` if it is not
  one of ours). The scan page works with JavaScript off via this form.
- **Camera needs a secure context.** Over plain `http://` on a LAN address
  `getUserMedia` is unavailable; the page says so (`add.https_hint`). `https://` (the
  nginx/CDN in front) or `localhost` is required. Nothing else on the page depends on
  it.

### 8.10 Responsive UI and PWA

**Responsive (one stylesheet, mobile first).** `public/app.css` is the only styling;
breakpoint `@media (max-width: 40rem)`:

- the header stacks and the nav wraps; the item list table becomes cards — every
  `<td>` carries `data-label` (name, category, status, location, qty) and is rendered
  by `td::before { content: attr(data-label) }`;
- `dl.item` becomes a single column; panels lose side padding; `.wrap` pads for
  `env(safe-area-inset-bottom)`;
- `@media (pointer: coarse)` gives every control a `min-height: 2.75rem` (44 px) tap
  target and widens the qty `[+]/[−]` buttons;
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
  and a `theme-color` per colour scheme are in `layout()`.

**PWA.** Installable and offline-tolerant, without a build step:

- `GET /manifest.webmanifest` (`application/manifest+json`, `no-cache`): name
  `Hacklab inventory`, short name `Hacklab`, `start_url`/`scope` `/`,
  `display: standalone`, `theme_color #1f5f3f`, background `#f7f6f2`, icons
  `icon-192.png` and `icon-512.png` (`any`) plus `icon-maskable-512.png`
  (`maskable`), and two `shortcuts` (`/add`, `/codes`). `icon-180.png` is the
  apple-touch-icon. Icons are generated by `node tools/gen-icons.js` (a ~120-line
  PNG writer over `node:zlib`); they are committed, like every other asset.
- `GET /sw.js` at the root (scope `/`). It caches **only** `/static/*` and
  `/manifest.webmanifest`, cache-first with a background refresh. **HTML pages,
  `/photo/*`, `/export.csv` and `/r/*` are network-only** — an inventory page must
  never be served stale from a cache, and a shared phone must not show a cached page
  from another session. A failed navigation gets a tiny built-in offline page.
- `public/app.js` registers the worker on load, only when
  `window.isSecureContext` is true (so plain-http LAN visits simply skip it).
  Nothing in the app requires the worker: it is an enhancement.

### 8.11 Asset versioning (invalidate the browser cache on deploy)

The problem: `/static/app.css` and `/static/app.js` keep their path across deploys,
so a browser or a CDN may serve the previous release for as long as its TTL says —
and an installed PWA keeps the old worker. A deploy must therefore change the URL
of every asset and the bytes of `/sw.js`.

- `assets.js` hashes the bytes of every file in `public/` (plus the vendored
  `jsQR.js`) at boot with sha256, folds them into one 10-hex `version`, and exposes
  `url(path)` → `path + "?v=" + version` for known assets, `path` untouched otherwise.
  There is no build step and no manifest to maintain: add a file to `public/` and it
  is covered. `createAssets(publicDir, extra)` also returns `version`.
- Every page links its stylesheet, icons and scripts through `c.asset(...)`
  (`ctxFor`), so a deploy changes the HTML the server sends — and HTML is
  `no-store` (§5.1), so nothing else has to be purged.
- `GET /static/:file?v=<current version>` answers
  `cache-control: public, max-age=31536000, immutable`; an unversioned request gets
  `public, max-age=300` (so a stray link cannot pin a year of stale bytes).
- `public/sw.js` is a template: `__VERSION__` becomes the version and `__ASSETS__`
  becomes the versioned precache list. The worker's cache name is `cosas-<version>`,
  so a new deploy installs a new worker, opens a new cache and deletes the old one
  (§8.10). `GET /sw.js` and `GET /manifest.webmanifest` substitute the same version;
  the manifest's icon URLs carry it too.
- Nothing is invalidated by hand, and no `APP_VERSION`/git hash has to be injected:
  the files on disk are the source of truth. A deploy that changes nothing changes
  no URL, which is correct.

---

## 9. i18n

### 9.1 Language resolution (per request)

```
1. cookie `lang` ∈ {en, es}              → use it
2. Accept-Language, first language tag matching /^es\b/i → es
3. anything else                          → en
```

Cookie set by `GET /lang/:lang`, `Path=/; Max-Age=31536000; SameSite=Lax`.
No `lang` query parameter anywhere (keeps `/r/<code>` short). Data (names,
locations, notes) is user text and is never translated. Dates: `Intl.DateTimeFormat`
with the active language for display only.

### 9.2 Key set

All UI strings live in `i18n.js` as `{ key: { en, es } }`. Keys are grouped by
prefix. **The complete v1 key list** (the implementer must not invent keys outside
this list — extend the list first, in the spec, if a page needs a new string):

```
app.title, app.subtitle
nav.home, nav.print, nav.login, nav.logout, nav.ui_lang, nav.export, nav.add
auth.login_cta, auth.must_login, auth.must_login_detail, auth.denied,
auth.callback_error
scan.public_title, scan.not_found, scan.not_found_detail, scan.revoked,
scan.deleted, scan.reused, scan.unclaimed_prompt, scan.claim_cta
add.title, add.subtitle, add.camera_hint, add.camera_start, add.camera_stop,
add.camera_denied, add.unsupported, add.scanning, add.not_ours, add.manual,
add.continue, add.https_hint
item.name, item.category, item.model, item.serial, item.location, item.status,
item.held_by, item.qty, item.notes, item.created, item.updated, item.photo
photo.none, photo.add, photo.add_more, photo.delete, photo.upload, photo.hint
crop.rotate, crop.whole, crop.apply, crop.cancel
item.status.available, item.status.in_use, item.status.broken, item.status.missing
form.field_required, form.register, form.save, form.cancel, form.notes_placeholder,
form.qty_mode, form.qty_mode.count, form.qty_mode.bin
form.name_placeholder, form.model_placeholder, form.serial_placeholder,
form.held_by_placeholder, form.location_placeholder, form.category_placeholder
action.edit, action.set_status, action.qty_plus, action.qty_minus, action.qty_set,
action.rebind, action.rebind_confirm, action.rebind_new_code, action.delete,
action.delete_confirm, action.restore, action.new_with_new_code, action.photo_saved, action.photo_removed
list.title, list.search_placeholder, list.filter_category, list.filter_status,
list.filter_all, list.clean, list.empty, list.empty_member, list.range, list.prev,
list.next, list.scan_hint
codes.title, codes.count, codes.generate, codes.view, codes.print, codes.new_sheet,
codes.download_svg, codes.download_sticker, codes.sticker_text
err.csrf, err.rate_limited, err.code_taken, err.code_invalid, err.field_required,
err.qty_range, err.not_found, err.range, err.forbidden, err.internal,
err.bad_photo, err.photo_too_big, err.photo_limit

footer.made_by
```

Plural handling: **none**. Use "items: 12" style labels where the number matters,
never "1 item / 2 items", so no pluralization library or rules are needed.

### 9.3 Copy conventions (binding for implementers)

- Tone: terse, neutral, no exclamation marks, no emoji, no marketing ("¡Listo!",
  "Oops!", "🚀" are forbidden). The UI is a tool, not a product page.
- Sentence case for every label, button and heading (`Save item`, not `Save Item`).
- Buttons are verbs or short verb phrases (`Register`, `Edit fields`, `Delete item`).
  Confirm buttons restate the action (`Delete`, `Revoke and print new sticker`).
- English strings in `i18n.js` are the source of truth for meaning; Spanish must be
  a faithful translation, not a paraphrase. Latin American Spanish, neutral.
- No string is ever assembled from fragments; every message is a complete sentence
  with placeholders written as `{name}` and substituted literally.
- Errors say what happened and what to do, in one line (`This sticker is not
  registered yet. Log in to register it.`).

### 9.3b Production payment order (read before the first sticker)

`CODE_SECRET`, `PUBLIC_ORIGIN` and the hostname are **effectively permanent** once
stickers exist:

1. Choose the final hostname and `PUBLIC_ORIGIN` (e.g. `https://cosas.<domain>`,
   no trailing slash, HTTPS in prod).
2. Generate and vault `CODE_SECRET` (≥32 random bytes). Rotating it or losing it
   kills every sticker ever printed; the only recovery is to re-scan each item's
   page and `rebind` it to a fresh sticker, by hand.
3. Only then print sheets. Re-printing the **same** `(start, n)` range in the same
   UTC month reproduces identical codes; in a different month the `MM` field
   changes, so codes differ even for the same `start`.

### 9.4 Untranslatable values

The `status` enum values are stored as the English slugs above and rendered with
the `item.status.*` keys. Search/filters for status use the slug internally.


### 9.5 Error pages

All errors render the same shell as every other page (nav + footer + language), a
single translated message and a `Back` link (`/`). Status codes and keys:

| Situation | Status | Key |
|---|---|---|
| Unknown/invalid sticker | 404 | `scan.not_found` (+ detail) |
| Soft-deleted item | 410 | `scan.deleted` |
| Revoked (forgotten) code | 410 | `scan.revoked` |
| Live item whose code was retired before (hint on the item page) | 200 | `scan.reused` |
| `n`/`start` out of range | 422 | `err.range` |
| Valid session, role not `admin` | 403 | `err.forbidden` |
| Missing/invalid `_csrf` | 403 | `err.csrf` |
| Not found outside `/r/*` (unknown route, traversal) | 404 | `err.not_found` |
| Rate limited | 429 | `err.rate_limited` |
| Validation failure | 422 | per-field keys (`err.field_required`, `err.qty_range`) |
| Code claimed meanwhile | 409 | `err.code_taken` |
| Session expired mid-action | 403 | `err.csrf` (no login redirect; relogin is a link on the error page) |
| Unhandled exception | 500 | `err.internal` |

Never render a stack trace or SQL text to the browser; log it with `LOG_LEVEL=debug`
and the request id.

---

## 9.6 URL scheme quick reference

```
/                         list (q, category, status, page)
/login                    start OIDC (next=)
/oidc/callback            OIDC callback
/logout                   POST only
/lang/en | /lang/es       set language cookie
/r/:code                  scan landing (register OR item view+actions)
/r/:code/photo            POST, attach one more photo
/r/:code/photo/:id/delete POST, delete one photo
/add                      phone add page (camera scanner, ?code= redirect)
/items/new                POST, create item with a fresh code
/codes                    print sheet (?n=)
/codes/svg                SVG download of the sheet
/export.csv               CSV export
/photo/:code/:id          one photo's bytes (member)
/manifest.webmanifest     PWA manifest
/sw.js                    service worker (root scope)
/healthz                  liveness
/static/*                 app.css, app.js, scan.js, icons
/vendor/jsQR.js           browser build of the jsqr dependency
/vendor/cropper.js        browser build of the cropperjs dependency
/vendor/cropper.css       cropperjs stylesheet
```

Reserved (404): `/i`, `/api`, `/admin`, anything else not listed.

## 10. Configuration, deployment, operations

### 10.1 Environment variables (all required unless marked)

| Var | Example | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `PUBLIC_ORIGIN` | `https://cosas.hacklab.example` | no trailing slash. Drives QR URLs, redirect URI, cookie `Secure`. |
| `DB_PATH` | `/data/cosas.db` | inside the container |
| `PHOTO_DIR` | *(optional)* | where §8.8 image files live; defaults to `dirname(DB_PATH)/photos`. `compose.yaml` sets `/photos` and bind-mounts `${PHOTO_HOST_DIR:-./photos}` there, so the database and the images can be backed up on separate schedules |
| `SESSION_SECRET` | `<openssl rand -base64 48>` | |
| `CODE_SECRET` | `<openssl rand -base64 48>` | **must never change** or all printed stickers die (codes are HMAC'd with it) |
| `OIDC_DISCOVERY_URL` | `https://idm.hacklab.example/oauth2/openid/cosas/.well-known/openid-configuration` | exact per-client URL |
| `OIDC_CLIENT_ID` | `cosas` | |
| `OIDC_CLIENT_SECRET` | `<from kanidm>` | secret auth (confidential client) |
| `OIDC_SCOPES` | `openid profile groups_name` (default) | space-separated; must include a groups scope (`groups_name`, `groups` or `groups_spn`) or the token carries no group list |
| `OIDC_ADMIN_GROUP` | *(unset)* | optional Kanidm group whose members may write (§4.1/§5.3), bare name like `cosas_admin`; works with the `groups`, `groups_name` and `groups_spn` scopes. Unset = anyone the IdP lets in is an admin |
| `TRUST_PROXY` | `0` / `1` | `1` → trust `X-Forwarded-For` and `X-Forwarded-Proto` |
| `LOG_LEVEL` | `info` | `debug` in dev |
| `SKIP_DISCOVERY_CHECK` | *(unset)* | optional. `1` skips the boot-time discovery fetch (tests only) |

The app must **refuse to start** (exit 1 with a clear message) if `CODE_SECRET` or
`SESSION_SECRET` is shorter than 32 bytes, if the directory of `DB_PATH` is unwritable, or
if discovery cannot be fetched at boot (unless `SKIP_DISCOVERY_CHECK=1`, used by tests).

### 10.2 Compose

**`compose.yaml` (production, app only):**

```yaml
services:
  app:
    build: .
    image: hacklab-cosas:1.0
    restart: unless-stopped
    env_file: .env
    environment:
      PORT: ${PORT:-8080}
      DB_PATH: ${DB_PATH:-/data/cosas.db}
      PHOTO_DIR: ${PHOTO_DIR:-/photos}
      TRUST_PROXY: "${TRUST_PROXY:-1}"
    volumes:
      - ${DB_DIR:-./data}:/data
      - ${PHOTO_HOST_DIR:-./photos}:/photos
    ports:
      - "${PORT:-8080}:${PORT:-8080}"   # all interfaces; firewall it (see below)
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:${PORT:-8080}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
```

The published port is bound to **every interface** on purpose: nginx is not
necessarily on the same host (or the same network namespace), so a loopback-only
publish would make `proxy_pass http://127.0.0.1:8080` impossible from anywhere else.
The cost is that the app is directly reachable, and with `TRUST_PROXY=1` it believes
`X-Forwarded-For` — a client that can reach the port can spoof its own address and
walk around the `/r/*` rate limiter. So the port must be firewalled to the proxy:
`ufw allow from <nginx address> to any port 8080 proto tcp` (or the equivalent), and
`TRUST_PROXY=0` if the app is ever published without a proxy in front.

**`.env` wins.** Compose reads `.env` for `${…}` interpolation *and* hands the whole
file to the container via `env_file`, but `env_file` loses to a literal `environment:`
value — so each knob is written as `${NAME:-default}`. That is why everything
operator-tunable (`PORT`, `DB_PATH`, `PHOTO_DIR`, `TRUST_PROXY`, `DB_DIR`,
`PHOTO_HOST_DIR`) is interpolated, and why nothing in `environment:` is a bare
constant: a bare constant would silently ignore `.env` (SPEC §10.1). Changing `PORT`
moves the listener, the published port and the healthcheck together; nginx's
`proxy_pass` has to follow it.

Note the two different names for photos: `PHOTO_DIR` is the path *inside* the
container (`/photos`, what the app writes to), `PHOTO_HOST_DIR` is the host directory
bind-mounted there — one name cannot be both without the risk of the app writing into
the image layer.

Both `DB_DIR` and `PHOTO_HOST_DIR` must be writable by **uid 1000** (the image's
`node` user);
compose creates a missing host directory as root, so `mkdir -p data photos &&
sudo chown 1000:1000 data photos` once is enough, and a wrong owner shows up as
`EACCES` in the logs on the first photo upload.

**Deployment behind the existing nginx** (one block, documented in README). Because
this block **overwrites** XFF, the app only ever sees one entry, so the §5.4 "last
entry" rule is trivially satisfied:

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;   # overwrite: never trust client-supplied XFF
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

**Local development: no container.** `./dev.sh` starts two plain Node processes —
the mock IdP (`tools/mock-idp/server.js`, port 9010) and the app
(`node --watch server.js`, port 8080) — writes their environment to `.dev/env`
(gitignored, dev secrets only) and their logs and pid files to `.dev/`. The dev
database is `dev-data/cosas.dev.db` and photos go to `dev-data/photos`.

```
PORT=8080
PUBLIC_ORIGIN=http://localhost:8080
DB_PATH=dev-data/cosas.dev.db
PHOTO_DIR=dev-data/photos
TRUST_PROXY=0
OIDC_DISCOVERY_URL=http://localhost:9010/oauth2/openid/cosas/.well-known/openid-configuration
OIDC_ISSUER=http://localhost:9010/oauth2/openid/cosas
OIDC_CLIENT_ID=cosas
OIDC_CLIENT_SECRET=dev-client-secret
OIDC_ADMIN_GROUP=
SESSION_SECRET=dev-session-secret-that-is-long-enough-000000
CODE_SECRET=dev-code-secret-that-is-long-enough-0000000
LOG_LEVEL=debug
```

`OIDC_ADMIN_GROUP` is written from the environment, so
`OIDC_ADMIN_GROUP=cosas_admin ./dev.sh up` exercises the read-only split locally (the
mock sends `cosas_admin` or `inventory_users`). Both mock URLs are `localhost:9010`,
because the app and the IdP share a host; in
containers the app reached the IdP by service name instead. Nothing is built: a
server-side edit restarts `node --watch`, and `public/*` changes are served from
disk and need only a browser reload. `./dev.sh down` stops both processes (they are
started with `setsid`, so the whole process group goes, including the watcher's
child).

There is no `compose.dev.yaml` and no mock-IdP image: the mock is one dependency-free
Node file, so putting it in a container only slowed the loop down.

Run: `./dev.sh` (or `npm run dev` plus `npm run mock-idp` in two shells after the
first `./dev.sh up` has written `.dev/env`).
Test guide: [`TESTING.md`](TESTING.md).

### 10.3 Redirect `next` validation

`?next=` is accepted only if it starts with `/` and not `//`, and contains only
`[A-Za-z0-9/_.?=&%-]` and its path starts with `/r/` or is exactly `/`. Anything
else is dropped silently and the redirect goes to `/`. This prevents open redirects
onto the login flow.

### 10.4 Persistence, backup, reset

- **Everything the app needs lives in this directory**: `./data/cosas.db`,
  `./photos/` and `.env` (plus the code). Nothing is written outside it — no named
  Docker volumes, no paths in `$HOME`, no log files. So `cp -a` (or `tar`) of the
  checked-out directory, minus `node_modules/`, is a complete backup, and restoring
  it on another machine is "copy it back, `docker compose up -d --build`".
- The DB is one file. Hot backup from the host:
  `sqlite3 data/cosas.db ".backup 'data/backup-$(date +%F).db'"`
  (the app is the single writer, so `.backup` is consistent). Copy `photos/` in the
  same breath: rows and image files are only meaningful together.
- `CODE_SECRET` goes into the password manager *first*, before the first sticker.
  A lost `CODE_SECRET` means every printed sticker is dead (recoverable only by
  re-scanning and manually rebinding each item).
- Reset in dev: `./dev.sh reset` (or `rm -rf dev-data/ && ./dev.sh up`). No reset
  endpoint, by decision.
- Migrations run automatically at boot; a failed migration exits non-zero and the
  container stays down (Compose `restart: unless-stopped` + failure is visible).

### 10.5 Dockerfile (intentionally trivial)

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# Every module by glob: an explicit list silently drops the next new file
# (assets.js was missing from an earlier list, and the image would not boot).
COPY *.js ./
COPY db ./db
COPY public ./public
COPY tools/gen-codes.js ./tools/
RUN mkdir -p /data /photos && chown -R node:node /app /data /photos
USER node
EXPOSE 8080
CMD ["node", "server.js"]
```

The image installs exactly the three runtime dependencies from the lockfile and
nothing else (no devDependencies exist). `.dockerignore`: `.git`, `dev-data`, `data`, `photos`,
`node_modules`, `*.db`, `.env*`, `SPEC-*.md`, `codes.txt`, `tools/mock-idp`,
`tools/test`. The dev mock IdP (`tools/mock-idp/`) is **not** copied into the app
image.

---

## 11. Dev OIDC mock (`tools/mock-idp/`)

A throwaway Node server (built-ins only) that mimics the parts of Kanidm the app
uses. It is **test/dev only** and must never be deployed.

- `GET /oauth2/openid/cosas/.well-known/openid-configuration` → a discovery doc
  whose `issuer` is `http://mock-idp:9010/oauth2/openid/cosas` (env-overridable via
  `MOCK_PUBLIC_URL`) and whose endpoints match Kanidm's shapes:
  `authorization_endpoint`, `token_endpoint` (`/oauth2/token`),
  `jwks_uri` (`.../public_key.jwk`), `userinfo_endpoint`.
- `GET <authorization_endpoint from the discovery doc>` → the mock serves the
  `authorization_endpoint` it advertises (`.../ui/oauth2`). **No form to fill in**: it
  immediately generates a code, stores `{code, challenge, redirect_uri, created}` in
  memory with a 60 s TTL, and answers with a one-line interstitial page that
  auto-continues (link + `location.replace`) to `redirect_uri?code=…&state=…` —
  jsdom-less scripts wait for that 200 rather than for a 302. The identity is fixed:
  `sub = "mock-user-uuid-00001"`, `preferred_username = "mockadmin"`.
  Query params `?as=denied` and `?as=error` simulate Kanidm refusing/erroring.
- `POST /oauth2/token` → validates **HTTP Basic** (`cosas:dev-client-secret`),
  `code_verifier` against the stored `challenge` (S256 only), single-use codes.
  Returns `{access_token, token_type:"Bearer", expires_in, id_token, scope}`.
- `GET /oauth2/openid/cosas/public_key.jwk` → an ES256 JWK generated at boot
  (P-256 keypair in memory; a fresh key on every restart is fine and exercises the
  app's JWKS refresh).
- **Must** enforce PKCE: a wrong verifier → `400 {"error":"invalid_grant"}`. This
  is what proves the app really does PKCE.
- `MOCK_MODE=wrong-secret` → token endpoint returns 401, so tests can prove the
  app fails safe.

The mock has no Dockerfile and no dependencies: `./dev.sh` runs it with
`node tools/mock-idp/server.js` (or `npm run mock-idp`), listening on `:9010`.

---

## 12. Acceptance checklist (runnable by a person, no code review required)

Environment: `./dev.sh` (starts the app with `node --watch` and the mock IdP on
`:9010`; no image build), then `http://localhost:8080`. The scriptable subset is
`./dev.sh test`;
[`TESTING.md`](TESTING.md) is the human guide. Every step is numbered so a report can say "12.7 pass".

0. **Static checks**: `node -e "console.log(Object.keys(require('./package.json').dependencies))"`
   prints exactly `["jsqr", "qrcode-generator"]`; `npm ls --omit=dev` is clean;
   `git ls-files public/` contains no QR library copy (both come from `node_modules`);
   `grep -rn "unsafe-inline" public/ views.js server.js` finds nothing.

1. **Boot**: logs show migration `001_init` applied, no `npm install`, the app
   answering (`/healthz` → `ok`). DB file exists at `dev-data/cosas.dev.db` with
   `PRAGMA user_version = 1`.
2. **Anonymous list**: `/` renders the empty state in **English** (browser
   `en-US`), with a login link and no action buttons.
3. **Language**: click the `Español` link (or open `/lang/es`) → the page reloads
   in Spanish and the `lang=es` cookie persists across reloads. A browser sending
   only `Accept-Language: fr` sees English.
4. **Login**: `/login` → mock IdP → back on `/` logged in as `mockadmin`, session
   cookie is `HttpOnly`, `SameSite=Lax`, **no `Secure`** (plain-http dev origin).
5. **PKCE**: with `MOCK_MODE=wrong-secret`, login fails with a translated error and
   no session cookie is set.
6. **Print**: `/codes?n=5` shows 5 stickers; `/codes/svg?n=5` downloads a 5-piece
   SVG. No two codes on a sheet are related and none is sequential — generate a
   second sheet and its codes are all different (they are random, §7.4). `n=44` fits
   exactly one A4 page.
7. **Scan → register**: take a code from the sheet you just printed (lowercase,
   without dashes) and visit `/r/<code>` as an anonymous user → "log in" prompt.
   Log in, revisit → register form; fill name/category, set status `in_use`,
   qty `3`, save → the action sheet view of the item.
8. **Persistence**: `./dev.sh down && ./dev.sh` → the item is still there, still
   bound to the same `/r/<code>`.
9. **Qty ±1**: with JS on, `+1` changes 3 → 4 in place (fetch, no reload). With JS
   off, the same buttons are real `<form method=post>` submissions that also land on
   4 after the redirect back to `/r/:code`.
10. **Rebind**: "Print new sticker" on the item → redirects to `/r/<new>` with the
    sticker panel; the old `/r/<old>` now returns **410 "revoked"**; `/r/<new>` shows
    the same item.
11. **Delete/restore**: delete → `/r/<code>` returns **410 "deleted"**; restore →
    the item is back, same code.
12. **Code tampering**: `/r/2h00000039nydg6e` (one character changed) → **404** with
    the translated "unknown sticker" page; no row is written to `items`
    (`SELECT count(*) FROM items` unchanged).
13. **CSRF**: a `POST /r/<code>/edit` from `curl` **without** the `_csrf` field
    returns **403** and changes nothing; with a valid session and valid `_csrf`, it
    succeeds.
14. **Anonymous privacy**: while logged out, `/r/<code>` shows **no** serial, model,
    `held_by` or notes in the HTML source (`grep` the response), and an anonymous
    `/` lists no model column and matches `q` only against name/category/location.
15. **Rate limit**: 31 rapid `GET /r/<valid code>` from one IP → the last returns
    **429** with `Retry-After`. With the prod nginx block (§10.2, XFF overwritten),
    spoofing `X-Forwarded-For: 1.2.3.4` still counts against the real socket IP.
16. **Search**: items named "Monitor LG" and "Laptop Dell" → searching `mon` shows
    only the monitor; filter `status=in_use` narrows correctly; `q=%` does not
    return everything (LIKE escaping).
17. **Export**: `/export.csv` downloads with all rows and RFC-4180 quoting around
    a notes field containing a comma and newline.
18. **i18n completeness**: every string on every page is translated in both `en`
    and `es` (manually flip language on each page); no raw key like `item.notes`
    is ever visible.
19. **Security headers**: response has CSP, `X-Frame-Options: DENY`,
    `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
20. **Prod-shaped run**: with `PUBLIC_ORIGIN=https://...` the session cookie gains
    `Secure`, the QR URLs (and redirect URI) use `https://` — even though the app
    listens on plain HTTP.
21. **Deleted writes are inert**: after deleting an item, `POST /r/<code>/edit` and
    `POST /r/<code>/rebind` with a valid session + `_csrf` both return **410** and
    change nothing; `POST /r/<code>/restore` succeeds.
22. **Unbound code**: a freshly generated code that was never registered →
    `GET /r/<code>` as a member shows the **register form** (never a 410); as an
    anonymous user it shows the login prompt whose `next` link returns to
    `/r/<code>` after login (§10.3).
23. **Photos**: as a member, register an item with a photo attached → the item page
    shows a thumbnail in the grid; `GET /photo/<code>/<id>` returns it with its real
    content type; `POST /r/<code>/photo` with a second image adds a second thumbnail;
    a 9th is refused with **422** `err.photo_limit`; deleting one thumbnail leaves the
    other; a data URL that is not an image → **422** and nothing changes; uploading to
    a photo id that belongs to another item → **404**.
24. **Add from the phone**: `/add` is member-only (anonymous **403**), the page has a
    `<video>` and a typed-code form, `/add?code=<sticker URL>` redirects to
    `/r/<code>`, and `/add?code=nope` re-renders the scanner with the "unknown
    sticker" error. No code is reserved by visiting the page — stickers stay
    stateless (§8.9).
25. **Mobile layout**: at a 390 px viewport the item list is a card stack with no
    horizontal scrolling, every button/nav link is at least 44 px tall, and the
    header wraps instead of overflowing. Printing still gives 4 × 11 stickers per
    A4 page, and Ctrl+P on `/codes` prints the stickers only (no header, nav,
    buttons, links, footer or hints).
26. **PWA**: `/manifest.webmanifest` parses as JSON with `display: standalone` and
    the 192/512 icons; the browser offers "Install"; `/sw.js` is served from the root
    with a JavaScript content type. With devtools set to offline, reloading a page
    shows the offline message rather than a stale item page, and `/photo/<code>/<id>` and
    `/export.csv` are never answered from the cache.
27. **Camera path**: on a phone over https, `/add` opens the camera and a printed
    sticker is recognised in a couple of seconds, landing on `/r/<code>`. A QR for
    another site shows "not one of our stickers" and scanning continues. Denying the
    camera leaves the typed fallback usable.
28. **Cache invalidation (§8.11)**: `curl -s $APP/ | grep -o 'app.css?v=[0-9a-f]*'`
    shows a hash; that exact URL is served with `cache-control: … immutable`, the bare
    `/static/app.css` is not; `/sw.js` has no `__VERSION__` left and its cache name
    carries the same hash. Touch a byte in `public/app.css`, restart, and both the
    page URL and the worker's cache name change — that is what makes a browser drop
    the previous release.
29. **Several photos at once**: on the register form pick two images, submit, and the
    item opens with two thumbnails (plus any added later). The browser must not post
    the originals: with devtools open, the multipart body carries two `photo_data`
    fields and an empty `photo` part.
30. **Category autocomplete**: typing `mon` into Category on the register form shows
    `monitor` in a tappable list; `ArrowDown` + `Enter` accepts it, `Escape` closes
    it, and typing a brand-new name still creates that category.
31. **Crop (optional)**: picking a photo opens a dialog over the form; drag its
    corners and press `[Crop]` — the preview under the input is the cropped
    rectangle, and the item shows exactly that after saving. `[Use whole photo]`
    keeps the untouched frame, `[Cancel]` skips the file, `[Rotate]` turns it a
    quarter turn. Escape closes with the same effect as Cancel. On a phone the same
    dialog must be reachable with a thumb, with the page dimmed and not scrollable
    behind it.

---

## 13. Build order (for the implementing agent)

No open design questions remain. Implement in this order; each step must leave the
app bootable.

1. `code.js` — Crockford base32 helpers, `build(secret, monthIndex, seq, nonce)`,
   `randomCode(secret, monthIndex)` (50 random bits, §7.4), `parse(secret, input)` →
   `{code, mm, seq, nonce}` or `null`, plus `pretty`, `stickerLines`, `normalize`.
   `codes.js` on top: `sheetCodes(secret, origin, n)` (§7.5). Unit-test with the
   `build` vector in §7.3 and round-trip 10,000 codes (`npm test`, §10.2).
2. `db/migrations/001_init.js` + the `user_version` runner + `store.js` (raw SQL
   only, prepared statements, one `nowIso()` helper).
3. `html.js` (tagged template that escapes by default, plus `raw()`), `i18n.js`
   (the full key list from §9.2, both languages), `public/app.css` (incl. the
   `@media print` rules from §8.7).
4. `server.js` — router + request pipeline in this order: rate limit → language →
   parse session → CSRF check for POST (**before** auth: an anonymous POST is 403
   `err.csrf`, never a redirect) → route. Then the static handler, `/healthz`,
   `GET /` and `GET /r/:code` (anonymous paths first).
5. `oidc.js` + `/login`, `/oidc/callback`, `POST /logout` (§4.3, §5.3).
6. Registration, edit, status, qty, delete/restore, rebind (§8.2, §8.3, §8.6).
7. `qrcode.js` (thin wrapper over `qrcode-generator`) + `/codes` and `/codes/svg`
   (§8.7), plus the CLI in §7.4 sharing `code.js`.
8. `/export.csv`.
8b. `assets.js` + the versioned asset URLs, the `/sw.js` and manifest placeholders
   (§8.11). Do this before the PWA step so the worker template already has a version.
8c. The optional crop step (§8.8): `/vendor/cropper.js` + `.css`, the
   `<template data-crop-template>`, and the dialog in `app.js`. Build it last: the
   register form must work without it.
9. `tools/mock-idp/` (§11), `Dockerfile`, `.dockerignore`, `compose.yaml`,
   `.env.example`, `dev.sh` (generates `.dev/env`).
10. Walk §12 top to bottom and fix what fails. Do not "improve" anything outside
    the spec; if something is genuinely missing, add it here as a dated v1.1 item
    first.

## 14. Decision log (why, for future readers)

| # | Decision | Why |
|---|---|---|
| Q1 | Scan renders item view / action sheet by session+state | one path, one route to test; anonymous "where does this belong" works |
| Q2 | Codes generated freely, never pre-registered | matches how stickers are actually made; removes a pool table |
| Q3/Q16 | Every logged-in user is admin; auth gate is Kanidm group membership | group is the gate, so roles stay in Kanidm config |
| Q4 | Prod domain, dev on `http://localhost` | no TLS termination needed in dev; nginx terminates prod |
| Q5/Q29 | Signed, short, non-sequential codes; one sticker per container | RAM bin = one record with qty |
| Q6 | Deleted = soft delete; code stays bound; restore via 410 page | sticker stays meaningful and recoverable |
| Q7/Q8 | Flat item table, free-text category/location, `held_by` column | no per-type schemas, no history |
| Q9/Q15 | `Accept-Language` + cookie override | no path prefixes (keeps `/r/` short) |
| Q19 | One search box + three fixed filters | no FTS, no sort UI |
| Q20 | Anonymous sees public subset only | found-device UX without leaking serials/held_by |
| Q21/Q23 | Hand-rolled migration runner, not a library | keeps deps at zero; native build avoided |
| Q34 | Optional crop with Cropper.js, offered after every pick | a phone photo is mostly desk; cropping is the cheapest way to keep the image useful, and a library beats hand-rolled canvas math. It stays optional so a broken vendor file cannot block registering |
| Q33 | Asset URLs carry a content hash; the worker cache name carries it too | a deploy must reach a browser that has the old CSS and an installed PWA, without asking anyone to hard-refresh |
| Q22/Q27 | CSV export in; no import/camera/uploads/email | cheap, read-only, operator-friendly |
| Q24/Q30 | Plain HTTP behind existing nginx; one scan path | operator already has TLS; fewer routes |
| Q25 | Friendly domain only; text fallback under QR | no second vhost |
| Q31 | Codes carry 50 random bits; no sequence, no counter, sheets are not reproducible | a printed `2J00-0002` told the world the sheet size and the order; randomness costs nothing and removes the counter to keep in sync |
| Q32 | 50 × 25 mm stickers, 4 × 11 = 44 per A4; print CSS shows nothing but stickers | 21-up wasted half a page per hundred; Ctrl+P is the only print path the operator wants |

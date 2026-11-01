# hacklab-cosas

Barebones inventory for a hacklab / hackerspace.

**Status: implemented.** [`SPEC.md`](SPEC.md) is the contract; the code follows it.

## Summary

- Node 24, one SQLite file, **two npm dependencies** (QR encode/decode only), no
  framework, no ORM, no bundler, no build step.
- Login via Kanidm (OIDC, confidential client with secret, PKCE S256, ES256).
- Every logged-in user is an admin (for now).
- QR stickers are generated freely and pre-printed; a code is bound to an item when
  it is first scanned and registered.
- Add from a phone: `/add` opens the camera, scans a printed sticker, and drops you on
  the register form. Typing the code is always available.
- Up to 8 photos per item (files next to the database, only names in the DB).
- Responsive from a 390 px phone up, installable as a PWA, works offline for the shell.
- Two languages: en, es.
- `docker compose` deployment behind the operator's existing nginx (TLS terminated
  there; the app speaks plain HTTP).

## Quick start (dev)

```bash
./dev.sh doctor      # node 24, curl, setsid, free ports, repo files
./dev.sh             # start app (:8080) and the mock Kanidm IdP (:9010) — no build
./dev.sh test        # HTTP smoke test of the running stack
./dev.sh down        # stop; ./dev.sh reset starts again from an empty database
```

`./dev.sh` is the whole platform in one command and needs **Node 24 plus curl, no
Docker**: it starts `node --watch server.js` and `node tools/mock-idp/server.js`,
writes the dev environment to `.dev/env` (gitignored, dev secrets only) and the logs
to `.dev/`, waits until both answer, and prints the URLs. Server-side edits reload on
save; `public/*` is served from disk. Data lives in `./dev-data/`. Docker is only for
building the deploy image.

How to test it, layer by layer, is in [`TESTING.md`](TESTING.md).

## Layout

| Path | What |
|---|---|
| [`SPEC.md`](SPEC.md) | The complete spec: routes, schema, OIDC, codes/QR, i18n, ops, acceptance checklist, build order, decision log |
| [`TESTING.md`](TESTING.md) | Manual test guide for the local platform |
| [`dev.sh`](dev.sh) | Powers on / off / resets / smoke-tests the local platform (plain node, no build) |
| [`compose.yaml`](compose.yaml) | Production-shaped: app only, published on all interfaces (firewall it), `${DB_DIR}`/`${PHOTO_HOST_DIR}` bind mounts, knobs from `.env` |
| [`.env.example`](.env.example) | Operator configuration reference |
| `server.js`, `store.js`, `oidc.js`, `code.js`, `codes.js`, `views.js`, `i18n.js`, `html.js`, `security.js`, `config.js`, `qrcode.js`, `multipart.js`, `photos.js` | The app: no framework, no build step (two deps, for QR only) |
| `db/migrations/` | Schema migrations, applied at boot (`001_init` … `004_item_photos`) |
| `public/` | CSS, browser scripts (`app.js`, `scan.js`), `sw.js`, manifest, icons |
| `package.json`, `package-lock.json` | Runtime deps: `qrcode-generator` (server-side sticker SVG) and `jsqr` (camera decoding, served at `/vendor/jsQR.js`) |
| `tools/mock-idp/` | Dev-only stand-in for Kanidm (PKCE + ES256, same shape) |
| `tools/gen-codes.js`, `tools/gen-icons.js` | Sticker codes and PWA icons from the CLI (both zero-dep) |
| `tools/test/` | Unit (`code`, `upload`, `qr`) and end-to-end tests (`npm test`, `npm run test:e2e`) |

## Production

`docker compose up -d --build` with a real `.env`, behind the operator's nginx. Pick the
public hostname and store `CODE_SECRET` **before printing stickers** — both are baked
into every printed QR (SPEC.md §9.3b).

The published port listens on every interface so nginx can live elsewhere; firewall
it to the proxy host and keep `TRUST_PROXY=1` only when a proxy really sets
`X-Forwarded-For`.

`.env` is authoritative: `PORT`, `DB_PATH`, `PHOTO_DIR`, `TRUST_PROXY`, `DB_DIR` and
`PHOTO_HOST_DIR` are interpolated by `compose.yaml` (`${NAME:-default}`), so editing the
file is enough — no compose edits, no `-e` flags.

All state lives inside this directory, in the two bind mounts `./data` (database) and
`./photos` (item images), plus `.env`. Nothing is written elsewhere — no named Docker
volumes, no home directories — so `tar` of the checkout (minus `node_modules/`) is a
complete backup, and restoring it is "copy it back, `docker compose up -d --build`".
Both directories must be writable by uid 1000 (the image's `node` user):
`mkdir -p data photos && sudo chown 1000:1000 data photos`. Skip that and the app exits
with `db.open_failed` plus that exact hint in `docker compose logs`. Hot copy of just the
database: `sqlite3 data/cosas.db ".backup 'data/backup-$(date +%F).db'"`.

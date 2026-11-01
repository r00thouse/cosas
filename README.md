# hacklab-cosas

Barebones inventory for a hacklab / hackerspace.

**Status: implemented.** [`SPEC.md`](SPEC.md) is the contract; the code follows it.

## Summary

- Node 24, one SQLite file, **zero npm dependencies**, no framework, no ORM.
- Login via Kanidm (OIDC, confidential client with secret, PKCE S256, ES256).
- Every logged-in user is an admin (for now).
- QR stickers are generated freely and pre-printed; a code is bound to an item when
  it is first scanned and registered.
- Add from a phone: `/add` opens the camera, scans a printed sticker, and drops you on
  the register form. Typing the code is always available.
- One optional photo per item (stored next to the database, none in the DB).
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
| [`compose.yaml`](compose.yaml) | Production-shaped: app only, loopback port, `${DB_DIR}` data mount |
| [`.env.example`](.env.example) | Operator configuration reference |
| `server.js`, `store.js`, `oidc.js`, `code.js`, `codes.js`, `views.js`, `i18n.js`, `html.js`, `security.js`, `config.js`, `qrcode.js`, `multipart.js`, `photos.js` | The app: no framework, no build step (two deps, for QR only) |
| `db/migrations/` | Schema migrations, applied at boot (`001_init`, `002_code_history`, `003_photo`) |
| `public/` | CSS, browser scripts (`app.js`, `scan.js`), `sw.js`, manifest, icons |
| `package.json`, `package-lock.json` | Runtime deps: `qrcode-generator` (server-side sticker SVG) and `jsqr` (camera decoding, served at `/vendor/jsQR.js`) |
| `tools/mock-idp/` | Dev-only stand-in for Kanidm (PKCE + ES256, same shape) |
| `tools/gen-codes.js`, `tools/gen-icons.js` | Sticker codes and PWA icons from the CLI (both zero-dep) |
| `tools/test/` | Unit (`code`, `upload`, `qr`) and end-to-end tests (`npm test`, `npm run test:e2e`) |

## Production

`docker compose up -d --build` with a real `.env`, behind the operator's nginx. Pick the public hostname and store `CODE_SECRET` **before printing
stickers** — both are baked into every printed QR (SPEC.md §9.3b).

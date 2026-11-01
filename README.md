# hacklab-cosas

Barebones inventory for a hacklab / hackerspace.

**Status: specification only — no application code yet.** Implement from
[`SPEC.md`](SPEC.md); read it in full before writing anything.

## Summary

- Node 24, one SQLite file, **zero npm dependencies**, no framework, no ORM.
- Login via Kanidm (OIDC, confidential client with secret, PKCE S256, ES256).
- Every logged-in user is an admin (for now).
- QR stickers are generated freely and pre-printed; a code is bound to an item when
  it is first scanned and registered.
- Two languages: en, es.
- `docker compose` deployment behind the operator's existing nginx (TLS terminated
  there; the app speaks plain HTTP).

## Quick start (dev)

```bash
./dev.sh doctor      # docker, compose, curl, node — and the compose merge
./dev.sh             # build + start app (:8080) and the mock Kanidm IdP (:9000)
./dev.sh test        # HTTP smoke test of the running stack
./dev.sh down        # stop; ./dev.sh reset starts from an empty database
```

`./dev.sh` is the whole platform in one command: it runs
`docker compose -f compose.yaml -f compose.dev.yaml up -d --build`, waits until the
mock IdP and the app answer, and prints the URLs. Dev secrets come from
[`compose.dev.yaml`](compose.dev.yaml), so no `.env` is needed; `dev.sh` uses a
throwaway empty `.env` for the duration of a command (compose's `env_file:` requires
the file to exist) and removes it on exit. Data lives in `./dev-data/`.

How to test it, layer by layer, is in [`TESTING.md`](TESTING.md).

## Layout

| Path | What |
|---|---|
| [`SPEC.md`](SPEC.md) | The complete spec: routes, schema, OIDC, codes/QR, i18n, ops, acceptance checklist, build order, decision log |
| [`TESTING.md`](TESTING.md) | Manual test guide for the local platform |
| [`dev.sh`](dev.sh) | Powers on / off / resets / smoke-tests the local platform |
| [`compose.yaml`](compose.yaml) | Production-shaped: app only, loopback port, `${DB_DIR}` data mount |
| [`compose.dev.yaml`](compose.dev.yaml) | Dev overlay: dev secrets, mock IdP, `./dev-data` |
| [`.env.example`](.env.example) | Operator configuration reference |
| `server.js`, `store.js`, `oidc.js`, `code.js`, `codes.js`, `views.js`, `i18n.js`, `html.js`, `security.js`, `config.js`, `qrcode.js` | The app: no dependencies, no build step |
| `db/migrations/` | Schema migrations, applied at boot |
| `public/` | CSS, the small browser script, and the vendored QR encoder |
| `tools/mock-idp/` | Dev-only stand-in for Kanidm (PKCE + ES256, same shape) |
| `tools/gen-codes.js`, `tools/test/` | Sticker codes from the CLI; unit + end-to-end tests (`npm test`) |

## Production

`docker compose up -d --build` with a real `.env` (no `compose.dev.yaml`), behind the
operator's nginx. Pick the public hostname and store `CODE_SECRET` **before printing
stickers** — both are baked into every printed QR (SPEC.md §9.3b).

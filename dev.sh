#!/usr/bin/env bash
# dev.sh powers on everything needed to test the system locally:
# the app container + the mock Kanidm IdP container, on one compose project,
# with a dev SQLite file in ./dev-data and dev secrets from compose.dev.yaml.
#
#   ./dev.sh                  up: build, start everything, wait until healthy
#   ./dev.sh up [--build]     same (it IS the default action)
#   ./dev.sh down             stop and remove the containers (dev-data/ is kept)
#   ./dev.sh reset            erase dev-data/ (items, codes, sessions) and start fresh
#   ./dev.sh logs [svc]       follow logs (svc = app | mock-idp)
#   ./dev.sh ps               what is running
#   ./dev.sh test             HTTP smoke test of the running stack (TESTING.md §4.1)
#   ./dev.sh shell            shell inside the app container
#   ./dev.sh doctor           check prerequisites and the merge of compose files
#   ./dev.sh code <start> [n] print the sticker codes a sheet would carry (no app needed)
#
# Podman users: put `podman compose` in COMPOSE_CMD instead of docker compose.
set -euo pipefail
cd "$(dirname "$0")"

APP_URL=http://localhost:8080
IDP_URL=http://localhost:9000
# merged prod + dev files, exactly as SPEC.md §10.2 describes
# override the runtime with e.g. COMPOSE_CMD="podman compose" ./dev.sh up
read -r -a COMPOSE <<<"${COMPOSE_CMD:-docker compose}"
# Legacy builder by default: buildx writes state under ~/.docker, which is read-only on
# some (sandboxed/CI) hosts and fails the build with a confusing message. Override with
# DOCKER_BUILDKIT=1 ./dev.sh up --build if you want buildx features.
export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-0}"
COMPOSE+=(-f compose.yaml -f compose.dev.yaml)
# compose.yaml declares `env_file: .env` (a file that holds prod secrets and does not
# exist in a fresh clone). The dev overlay sets every value the app needs, so an empty
# placeholder is enough — and it is removed again on exit.
MADE_ENV=0
[[ -f .env ]] || { : > .env; MADE_ENV=1; trap '((MADE_ENV)) && rm -f .env' EXIT; }

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mfail\033[0m %s\n' "$*" >&2; exit 1; }

require_runtime() {
  command -v "${COMPOSE[0]}" >/dev/null || die "${COMPOSE[0]} not found — install it, or set COMPOSE_CMD (see TESTING.md §1)"
  "${COMPOSE[0]}" info >/dev/null 2>&1 || die "cannot talk to the ${COMPOSE[0]} daemon — is it running and may this user use it? (TESTING.md §1)"
}

# Wait until URL answers with any HTTP status < 500. $1=url $2=seconds $3=label
wait_for() {
  local url=$1 secs=$2 label=$3 code
  for ((i = 0; i < secs; i++)); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null || true)
    if [[ -n $code && $code != 000 && $code -lt 500 ]]; then ok "$label ($url → $code)"; return 0; fi
    sleep 1
  done
  return 1
}

cmd_up() {
  require_runtime
  command -v curl >/dev/null || die "curl not found"
  if [[ ! -f server.js ]]; then
    die "no server.js yet — the app is still spec-only (SPEC.md §13 step 4)."$'\n'"Run './dev.sh code 0 5' for a sticker sheet that needs no app."
  fi
  mkdir -p dev-data
  say "building and starting app + mock idp…"
  "${COMPOSE[@]}" up -d --build "$@"

  say "waiting for services…"
  wait_for "$IDP_URL/healthz" 60 "mock idp"          || { logs_tail; die "mock idp did not become healthy"; }
  wait_for "$APP_URL/healthz" 90 "app /healthz"      || { logs_tail; die "app did not become healthy"; }
  wait_for "$APP_URL/"       30 "app / renders"      || { logs_tail; die "app / is not answering"; }

  cat <<EOF

  app        $APP_URL
  mock idp   $IDP_URL   (dev only, no login form: every login succeeds as \`mockuser\`)
  database   $(pwd)/dev-data/cosas.dev.db
  logs       ./dev.sh logs app
  stop       ./dev.sh down

  Next: ./dev.sh test   (smoke test)   then TESTING.md for the manual walk-through.
EOF
}

logs_tail() {
  printf '\n--- last 25 app lines ---\n'
  "${COMPOSE[@]}" logs --no-color --tail 25 app 2>&1 || true
}

cmd_down() {
  require_runtime
  "${COMPOSE[@]}" down --remove-orphans
  ok "stopped (dev-data/ kept; ./dev.sh up resumes, ./dev.sh reset wipes)"
}

cmd_reset() {
  require_runtime
  "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
  rm -rf dev-data
  say "dev-data/ erased"
  cmd_up --build "$@"
}

cmd_logs() { require_runtime; "${COMPOSE[@]}" logs -f --tail 50 "$@"; }
cmd_ps()   { require_runtime; "${COMPOSE[@]}" ps -a; }
cmd_shell() { require_runtime; "${COMPOSE[@]}" exec app sh; }

cmd_doctor() {
  say "prerequisites"
  for c in "${COMPOSE[0]}" curl bash node; do
    if command -v "$c" >/dev/null; then ok "$c: $(command -v "$c")"; else warn "$c: NOT FOUND"; fi
  done
  if "${COMPOSE[@]:0:2}" version >/dev/null 2>&1; then
    ok "compose: $("${COMPOSE[@]:0:2}" version --short 2>/dev/null || "${COMPOSE[@]:0:2}" version)"
  else
    warn "compose (v2 plugin) for ${COMPOSE[0]} NOT FOUND"
  fi
  if "${COMPOSE[0]}" info >/dev/null 2>&1; then ok "${COMPOSE[0]} daemon reachable"; else warn "${COMPOSE[0]} daemon NOT reachable"; fi

  say "compose merge (prod + dev)"
  local cfg appcfg mounts published
  cfg=$("${COMPOSE[@]}" config 2>&1) \
    || { warn "compose config failed:"; printf '%s\n' "$cfg" | sed 's/^/         /' >&2; return 0; }
  ok "compose.yaml + compose.dev.yaml merge cleanly"
  # services may render alphabetically with `app` last and nothing after it, hence the EOF sentinel
  appcfg=$(printf '%s\n' "$cfg" | sed -n '/^  app:[[:space:]]*$/,/^  [^[:space:]]|^EOF/p')
  mounts=$(printf '%s\n' "$appcfg" | grep -cE 'target:[[:space:]]*/data[[:space:]]*$' || true)
  [[ $mounts == 1 ]] && ok "exactly one /data mount on app" || warn "/data mounts on app in merged config: $mounts (expected 1)"
  published=$(printf '%s\n' "$appcfg" | grep -cE 'published:[[:space:]]*"?8080"?' || true)
  [[ $published == 1 ]] && ok "app published once on :8080" || warn "app published $published time(s) on :8080 (expected 1)"

  say "repo"
  for f in SPEC.md compose.yaml compose.dev.yaml .env.example server.js tools/mock-idp/server.js public/qr.js; do
    if [[ -e $f ]]; then ok "$f"; else warn "$f missing"; fi
  done
}

# ---- HTTP smoke test -------------------------------------------------------
# Mirrors the cheap, scriptable half of SPEC.md §12. Each check prints PASS/FAIL
# and the script exits 1 if anything failed.
cmd_test() {
  require_runtime
  command -v curl >/dev/null || die "curl not found"
  local fails=0 jar
  jar=$(mktemp); trap 'rm -f "$jar"' RETURN
  check() { # name expected actual
    if [[ "$2" == "$3" ]]; then ok "$1"; else printf '  \033[31mFAIL\033[0m %s (expected %s, got %s)\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi
  }
  code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@"; }
  hdr()  { curl -s -D - -o /dev/null --max-time 5 "$@" | tr -d '\r' | tr 'A-Z' 'a-z'; }

  say "smoke test against $APP_URL"

  check "12.1 mock idp /healthz" 200 "$(code "$IDP_URL/healthz")"
  check "12.1 app /healthz"      200 "$(code "$APP_URL/healthz")"

  local h; h=$(hdr "$APP_URL/")
  grep -q '^x-content-type-options: nosniff' <<<"$h" && ok "12.19 nosniff header"    || { warn "12.19 nosniff missing"; fails=$((fails + 1)); }
  grep -q '^x-frame-options: deny'          <<<"$h" && ok "12.19 X-Frame-Options"  || { warn "12.19 X-Frame-Options missing"; fails=$((fails + 1)); }
  grep -q '^content-security-policy:'       <<<"$h" && ok "12.19 CSP header"        || { warn "12.19 CSP missing"; fails=$((fails + 1)); }

  check "12.2 anonymous / renders" 200 "$(code "$APP_URL/")"

  # login: follow the OIDC redirect dance through the mock idp (auto-submit, no form)
  curl -s -c "$jar" -b "$jar" -L -o /dev/null --max-time 10 "$APP_URL/login"
  grep -q 'session' "$jar" && ok "12.4 session cookie stored" || { warn "12.4 no session cookie in jar"; fails=$((fails + 1)); }
  local sec; sec=$(awk -F'\t' 'NF>=7 && $1=="localhost" && $6 ~ /session/ {print $4}' "$jar" | sort -u | tr '\n' ' ')
  [[ -z ${sec// /} ]] && ok "12.4 dev cookie has no Secure flag" || warn "12.4 cookie Secure flag = ${sec:-(none)} (expected FALSE on an http origin)"

  # stickers
  local svg; svg=$(code -b "$jar" "$APP_URL/codes/svg?n=5")
  check "12.6 /codes/svg?n=5" 200 "$svg"
  local c1 c2
  c1=$(curl -s -b "$jar" --max-time 5 "$APP_URL/codes/svg?n=3&start=0" | sha256sum | cut -c1-16)
  c2=$(curl -s -b "$jar" --max-time 5 "$APP_URL/codes/svg?n=3&start=0" | sha256sum | cut -c1-16)
  check "12.6 codes are deterministic" "$c1" "$c2"
  check "12.6 /codes sheet page" 200 "$(code -b "$jar" "$APP_URL/codes?n=5")"
  check "12.6 /codes/svg without a session → 403" 403 "$(code "$APP_URL/codes/svg?n=1")"

  # The /r/* limiter (§5.4) also counts the OIDC hop back to the app, so let its
  # 60 s window roll over instead of failing the scan checks with a 429.
  # Wait until the limiter lets a scan through (it may have just hit the 31-request cap).
  local waited=0
  while [[ $(code "$APP_URL/r/0000000000000000") == 429 ]] && (( waited < 65 )); do sleep 1; waited=$((waited + 1)); done

  # scan paths: member sees the register form on an unbound code, anon can't
  local first
  first=$(CODE_SECRET=${CODE_SECRET:-dev-code-secret-that-is-long-enough-0000000} ./dev.sh code ${CODE_START:-1000000} 1 2>/dev/null | awk '{print $1}' | tr -d '-' | tr 'A-Z' 'a-z' || true)
  if [[ -z $first ]]; then warn "could not compute a sticker code (node missing?)"; fails=$((fails + 1)); else
    # codes are month-scoped (SPEC §7.3): CODE_START is the batch counter, not a month
    check "12.22 unbound code, anon → login prompt" 200 "$(code "$APP_URL/r/$first")"
    check "12.22 unbound code, member → register form" 200 "$(code -b "$jar" "$APP_URL/r/$first")"
    check "12.12 tampered code → 404" 404 "$(code "$APP_URL/r/${first%?}Z")"
    check "12.13 POST without CSRF → 403" 403 "$(code -b "$jar" -X POST "$APP_URL/r/$first/edit" -d 'name=x')"
  fi
  check "12.17 export.csv" 200 "$(code -b "$jar" "$APP_URL/export.csv")"

  # rate limit: 31 rapid reads of a valid-shaped code must end in 429 (§5.4)
  local last
  for i in $(seq 1 31); do last=$(code "$APP_URL/r/$first"); done
  check "12.15 rate limit → 429 on 31st GET" 429 "$last"

  echo
  if (( fails == 0 )); then say "all smoke checks passed"; else die "$fails smoke check(s) failed (see TESTING.md §6)"; fi
}

# Sticker codes without the app: same formula as SPEC.md §7.5 batch generation,
# using CODE_SECRET from the environment or the dev default from compose.dev.yaml.
cmd_code() {
  local start=${1:-0} n=${2:-1} secret=${CODE_SECRET:-dev-code-secret-that-is-long-enough-0000000}
  CODE_SECRET=$secret CODE_START=$start CODE_COUNT=$n node --input-type=module -e '
    import { createHmac } from "node:crypto";
    const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const enc = (v, w) => Array.from({ length: w }, (_, i) => A[Math.floor(v / 32 ** (w - 1 - i)) % 32]).join("");
    const secret = process.env.CODE_SECRET, start = +process.env.CODE_START, n = +process.env.CODE_COUNT;
    const key = createHmac("sha256", secret).update("hacklab-cosas/code/v1").digest();
    const mm = (() => { const d = new Date(); return (d.getUTCFullYear() - 2020) * 12 + d.getUTCMonth(); })();
    for (let i = 0; i < n; i++) {
      const h = createHmac("sha256", secret).update(`hacklab-cosas/batch/v1:${start}:${i}`).digest();
      const nonce = h.readUIntBE(0, 3) >> 4;                       // first 20 bits
      const body = enc(mm, 2) + enc(start + i, 6) + enc(nonce, 4);
      const mac = createHmac("sha256", key).update("v1" + body).digest();
      const tag = ((mac[0] << 16) | (mac[1] << 8) | mac[2]) >> 4;   // first 20 bits
      const c = (body + enc(tag, 4)).toLowerCase();
      console.log(`${c.slice(0,4)}-${c.slice(4,8)}-${c.slice(8,12)}-${c.slice(12,16)}  seq=${start + i}`);
    }'
}

case "${1:-up}" in
  up)     shift || true; cmd_up "$@" ;;
  down|stop)  cmd_down ;;
  reset)  shift || true; cmd_reset "$@" ;;
  logs)   shift; cmd_logs "$@" ;;
  ps|status)  cmd_ps ;;
  shell)  cmd_shell ;;
  test)   cmd_test ;;
  doctor) cmd_doctor ;;
  code|codes) shift; cmd_code "$@" ;;
  -h|--help|help) awk 'NR>=2 && !/^set -euo/ { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0" ;;
  *) die "unknown command '$1' (try ./dev.sh --help)" ;;
esac

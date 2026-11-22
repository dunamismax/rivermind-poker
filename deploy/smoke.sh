#!/usr/bin/env bash
# The site's smoke check: its main routes, a 404, /healthz, the headers it
# promises and that it offers table voice. deploy/update.sh runs it against the release candidate, the live
# port and the public site; it is also the quick check of the live site.
#
#   deploy/smoke.sh [--candidate] [--revision COMMIT] BASE_URL
#
#   BASE_URL      http://127.0.0.1:PORT for a local server, or https://rivermindpoker.com
#   --candidate   a release candidate (RIVERMIND_CANDIDATE=1): /healthz must also
#                 report the saved tables restorable and the champion loaded, and
#                 the API, which a candidate does not serve, is not checked
#   --revision    /healthz must report this commit
#
# Exits non-zero at the first failure and says what failed.
set -Eeuo pipefail

candidate=0
revision=
while (($#)); do
    case $1 in
        --candidate) candidate=1; shift ;;
        --revision) revision=$2; shift 2 ;;
        -*) echo "smoke: unknown option $1" >&2; exit 64 ;;
        *) break ;;
    esac
done
(($# == 1)) || { echo 'usage: smoke.sh [--candidate] [--revision COMMIT] BASE_URL' >&2; exit 64; }
base=${1%/}
public=0
[[ $base == https://* ]] && public=1

fail() { echo "smoke: $base: $*" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Behind Caddy the server sees the public host and scheme; locally, say so.
local_headers=()
((public)) || local_headers=(-H 'Host: rivermindpoker.com' -H 'X-Forwarded-Proto: https')

# fetch PATH: the status code; the headers and body are left in $work.
fetch() {
    curl -sS --max-time 20 "${local_headers[@]}" -D "$work/headers" -o "$work/body" \
        -w '%{http_code}' "$base$1" || echo 000
}
header() { grep -i "^$1:" "$work/headers" | head -n 1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }

status=$(fetch /healthz)
[[ $status == 200 ]] || fail "/healthz answered $status: $(head -c 300 "$work/body")"
python3 - "$work/body" "$revision" "$candidate" <<'EOF' || fail "/healthz: $(head -c 300 "$work/body")"
import json, sys
body = json.load(open(sys.argv[1]))
revision, candidate = sys.argv[2], sys.argv[3] == '1'
assert body.get('status') == 'ok', 'status is not ok'
if revision:
    assert body.get('revision') == revision, f"revision is {body.get('revision')}, not {revision}"
assert body.get('database') == 'ok', 'database is not ok'
if candidate:
    assert body.get('tables') == 'ok', 'a saved table cannot be restored by this release'
    assert body.get('champions') == 'ok', 'the champion was not loaded'
EOF

status=$(fetch /)
[[ $status == 200 ]] || fail "/ answered $status"
[[ $(header content-type) == text/html* ]] || fail "/ is not HTML"
[[ $(header content-security-policy) == *"script-src 'self'"* ]] || fail "/ has no page policy"
[[ $(header x-content-type-options) == nosniff ]] || fail "/ lacks X-Content-Type-Options"
[[ $(header x-frame-options) == DENY ]] || fail "/ lacks X-Frame-Options"
[[ $(header referrer-policy) == strict-origin-when-cross-origin ]] || fail "/ lacks Referrer-Policy"
# The microphone for the site's own pages, for table voice, and nothing else (P4C.9).
[[ $(header permissions-policy) == 'camera=(), microphone=(self), geolocation=()' ]] ||
    fail "/ sends Permissions-Policy: $(header permissions-policy)"
((public)) && { [[ $(header strict-transport-security) == max-age=* ]] || fail "/ lacks HSTS"; }
grep -q 'RiverMind' "$work/body" || fail "/ does not name RiverMind"

for path in /hands /fairness /bots /style; do
    status=$(fetch "$path")
    [[ $status == 200 ]] || fail "$path answered $status"
done
# The hashes of the files the release's pages run, which the fairness page links to (P4C.8).
status=$(fetch /voice-files.json)
[[ $status == 200 ]] || fail "/voice-files.json answered $status"
grep -q 'sframe.worker' "$work/body" || fail "/voice-files.json does not list the voice worker"
status=$(fetch "/no-such-page-$RANDOM")
[[ $status == 404 ]] || fail "an unknown page answered $status, not 404"
status=$(fetch /_app/immutable/missing.js)
[[ $status == 404 ]] || fail "a missing asset answered $status, not 404"

if ((!candidate)); then
    status=$(fetch /api/config)
    [[ $status == 200 ]] || fail "/api/config answered $status"
    grep -q '"seat_counts":' "$work/body" || fail "/api/config has no seat counts"
    grep -q '"kind":"hard"' "$work/body" || fail "/api/config does not offer RiverMind Hard"
    # Table voice is offered (P4C.9): RIVERMIND_VOICE_OFFER=1 with a voice service.
    status=$(fetch /api/voice)
    [[ $status == 200 ]] || fail "/api/voice answered $status"
    grep -q '"offered":true' "$work/body" || fail "/api/voice does not offer table voice: $(head -c 100 "$work/body")"
fi

if ((public)); then
    status=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code} %{redirect_url}' https://www.rivermindpoker.com/fairness || true)
    [[ $status == '301 https://rivermindpoker.com/fairness' ]] || fail "www answered $status"
    # /voice reaches the voice service (P4C.9): it is what refuses a page from
    # another origin with 403. The Node server would drop the handshake instead.
    status=$(curl -sS --http1.1 --max-time 20 -o /dev/null -w '%{http_code}' \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
        -H 'Sec-WebSocket-Key: cml2ZXJtaW5kLXNtb2tlIQ==' -H 'Origin: https://elsewhere.invalid' \
        "$base/voice" || true)
    [[ $status == 403 ]] || fail "/voice from another origin answered $status, not the voice service's 403"
fi
echo "smoke: $base ok"

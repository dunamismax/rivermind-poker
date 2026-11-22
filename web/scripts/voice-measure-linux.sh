#!/bin/bash
# Runs `pnpm voice:measure` in Playwright's Linux browsers in Docker, from the
# working tree, with the network impaired by Linux's own `tc netem` (P4C.7):
# the container may change its network (NET_ADMIN), and the host's kernel must
# have sch_netem (colima's has: `colima ssh -- sudo modprobe sch_netem`).
#
#   web/scripts/voice-measure-linux.sh [arguments for playwright test]
#
# With no arguments it runs the loss measure. The tree is copied in, as
# voice-check-linux.sh does it. The loss measure plays speech, which a
# container has no voice to make: the WAVE file MEASURE_SPEECH names is copied
# in, or, on macOS, one made here with `say`.
set -euo pipefail
web=$(cd "$(dirname "$0")/.." && pwd)
node=$(cat "$web/.node-version")
pnpm=$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$web/package.json")
playwright=$(sed -n 's/.*"@playwright\/test": "\([^"]*\)".*/\1/p' "$web/package.json")
image="mcr.microsoft.com/playwright:v$playwright-noble"
(($#)) || set -- loss
speech=${MEASURE_SPEECH:-}
made=
if [[ -z $speech ]] && command -v say >/dev/null && command -v afconvert >/dev/null; then
	made=$(mktemp -d)
	say -o "$made/speech.aiff" 'The river card is the last of the five. I will raise to four hundred, and we will see who was bluffing. Nine players at this table, and everyone has something to say about that hand. Deal the next one.'
	afconvert -f WAVE -d LEI16@48000 -c 1 "$made/speech.aiff" "$made/speech.wav"
	speech=$made/speech.wav
fi

inside=$(cat <<SCRIPT
set -euo pipefail
arch=\$(uname -m | sed 's/aarch64/arm64/; s/x86_64/x64/')
command -v tc >/dev/null || { apt-get update -qq && apt-get install -y -qq iproute2 >/dev/null; }
curl -fsSL -o /tmp/node.tar.gz "https://nodejs.org/dist/v$node/node-v$node-linux-\$arch.tar.gz"
mkdir -p /opt/node && tar -xzf /tmp/node.tar.gz -C /opt/node --strip-components 1
export PATH=/opt/node/bin:\$PATH CI=1 IMPAIR=netem MEASURE_SECONDS=${MEASURE_SECONDS:-30}
[[ -f /speech.wav ]] && export MEASURE_SPEECH=/speech.wav
npm install -g "pnpm@$pnpm" >/dev/null 2>&1
cd /web
pnpm install --frozen-lockfile 2>&1 | tail -1
pnpm exec svelte-kit sync
pnpm exec playwright test --config playwright.voice-measure.config.ts "\$@"
SCRIPT
)

container=$(docker create --ipc=host --cap-add NET_ADMIN "$image" bash -c "$inside" voice-measure "$@")
trap 'docker rm -f "$container" >/dev/null; [[ -n $made ]] && rm -rf "$made"' EXIT
[[ -n $speech ]] && docker cp "$speech" "$container:/speech.wav"
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -C "$web/.." \
	--exclude web/node_modules --exclude web/build --exclude web/.svelte-kit \
	--exclude 'web/test-results*' --exclude web/playwright-report \
	-cf - web | docker cp - "$container:/"
docker start -a "$container"

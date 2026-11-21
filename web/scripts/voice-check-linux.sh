#!/bin/bash
# Runs `pnpm voice:check` in Playwright's Linux browsers, as CI does, from the
# working tree, without a push: Playwright's image in Docker, Node from
# web/.node-version, pnpm from packageManager.
#
#   web/scripts/voice-check-linux.sh [arguments for playwright test]
#
# The tree is copied into the container, not mounted: colima shares only the
# home directory. The install runs install scripts, as CI's does: the room
# checks start the voice service, whose mediasoup fetches its worker for the
# container's platform from GitHub.
set -euo pipefail
web=$(cd "$(dirname "$0")/.." && pwd)
node=$(cat "$web/.node-version")
pnpm=$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$web/package.json")
playwright=$(sed -n 's/.*"@playwright\/test": "\([^"]*\)".*/\1/p' "$web/package.json")
image="mcr.microsoft.com/playwright:v$playwright-noble"

inside=$(cat <<SCRIPT
set -euo pipefail
arch=\$(uname -m | sed 's/aarch64/arm64/; s/x86_64/x64/')
curl -fsSL -o /tmp/node.tar.gz "https://nodejs.org/dist/v$node/node-v$node-linux-\$arch.tar.gz"
mkdir -p /opt/node && tar -xzf /tmp/node.tar.gz -C /opt/node --strip-components 1
export PATH=/opt/node/bin:\$PATH CI=1
npm install -g "pnpm@$pnpm" >/dev/null 2>&1
cd /web
pnpm install --frozen-lockfile 2>&1 | tail -1
pnpm exec svelte-kit sync
pnpm exec playwright test --config playwright.voice-check.config.ts "\$@"
SCRIPT
)

container=$(docker create --ipc=host "$image" bash -c "$inside" voice-check "$@")
trap 'docker rm -f "$container" >/dev/null' EXIT
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -C "$web/.." \
	--exclude web/node_modules --exclude web/build --exclude web/.svelte-kit \
	--exclude 'web/test-results*' --exclude web/playwright-report \
	-cf - web | docker cp - "$container:/"
docker start -a "$container"

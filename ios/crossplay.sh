#!/usr/bin/env bash
# Cross-play (P5D.7): the iPhone app in the Simulator and people in Playwright's browsers
# at one table. Starts a Node server from web/build, runs web/e2e/app.crossplay.ts, which
# seats a person in Chromium and one in WebKit at a table with no bots and names it, then
# runs the app's CrossPlayUITests at that table. Everyone checks or calls for a few hands;
# each side records the result every hand ended with, and this script checks that every
# screen ended every hand the same.
#
#   ios/crossplay.sh
#
# RIVERMIND_CROSSPLAY_PORT  the server's port (4386)
# RIVERMIND_SIMULATOR       the simulator ("RiverMind Test", as ios/test.sh makes it)
# CROSSPLAY_HANDS           how many hands to play (3)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
port=${RIVERMIND_CROSSPLAY_PORT:-4386}
simulator=${RIVERMIND_SIMULATOR:-RiverMind Test}
hands=${CROSSPLAY_HANDS:-3}
logs="$here/DerivedData/logs"
work=$(mktemp -d)
mkdir -p "$logs"

server_pid=
web_pid=
cleanup() {
	for pid in "$server_pid" "$web_pid"; do
		if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
	done
	rm -rf "$work"
}
trap cleanup EXIT

if [ ! -f "$root/web/build/start.js" ]; then
	echo "web/build is missing: run pnpm build in web/ first" >&2
	exit 1
fi
server="http://127.0.0.1:$port"
(cd "$root/web" && exec env PORT="$port" HOST=127.0.0.1 ORIGIN="$server" RIVERMIND_API=1 \
	node build/start.js) >"$logs/crossplay-server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 60); do
	if curl -sf -o /dev/null "$server/api/config"; then break; fi
	sleep 0.5
done
curl -sf -o /dev/null "$server/api/config" || { cat "$logs/crossplay-server.log" >&2; exit 1; }

udid=$(xcrun simctl list -j devices available | python3 -c '
import json, sys
for runtime, devices in json.load(sys.stdin)["devices"].items():
    for device in devices:
        if device["name"] == sys.argv[1] and "iOS" in runtime:
            print(device["udid"]); raise SystemExit
' "$simulator")
if [ -z "$udid" ]; then
	echo "no simulator called $simulator: run ios/test.sh app once to make it" >&2
	exit 1
fi
echo "server: $server; simulator: $simulator ($udid)"

# The app first, so it is ready by the time the browsers have sat down.
xcodebuild build-for-testing -project "$here/RiverMind.xcodeproj" -scheme RiverMind \
	-destination "id=$udid" -derivedDataPath "$here/DerivedData" -quiet >"$logs/crossplay-build.log" 2>&1

(cd "$root/web" && exec env CROSSPLAY_URL="$server" CROSSPLAY_TABLE_FILE="$work/table.json" \
	CROSSPLAY_RESULTS="$work/results.json" CROSSPLAY_HANDS="$hands" \
	pnpm exec playwright test --config playwright.crossplay.config.ts) >"$logs/crossplay-web.log" 2>&1 &
web_pid=$!
for _ in $(seq 1 240); do
	if [ -s "$work/table.json" ]; then break; fi
	if ! kill -0 "$web_pid" 2>/dev/null; then cat "$logs/crossplay-web.log" >&2; exit 1; fi
	sleep 0.5
done
table=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["tableId"])' "$work/table.json")
names=$(python3 -c 'import json, sys; print("|".join(json.load(open(sys.argv[1]))["names"]))' "$work/table.json")
echo "table: $table, with $names"

status=0
TEST_RUNNER_RIVERMIND_SERVER="$server" TEST_RUNNER_RIVERMIND_CROSSPLAY=1 \
	TEST_RUNNER_RIVERMIND_JOIN_TABLE="$table" TEST_RUNNER_RIVERMIND_CROSSPLAY_NAMES="$names" \
	TEST_RUNNER_RIVERMIND_CROSSPLAY_HANDS="$hands" xcodebuild test-without-building \
	-project "$here/RiverMind.xcodeproj" -scheme RiverMind -destination "id=$udid" \
	-derivedDataPath "$here/DerivedData" -only-testing:RiverMindUITests/CrossPlayUITests \
	>"$logs/crossplay-app.log" 2>&1 || status=$?
web_status=0
wait "$web_pid" || web_status=$?
web_pid=
if [ "$status" -ne 0 ] || [ "$web_status" -ne 0 ]; then
	grep -E "error:|failed" "$logs/crossplay-app.log" >&2 || true
	tail -30 "$logs/crossplay-web.log" >&2
	echo "cross-play failed: the app $status, the browsers $web_status" >&2
	exit 1
fi

# Every hand that all three screens saw end must have ended the same on each.
python3 - "$work/results.json" "$logs/crossplay-app.log" "$hands" <<'EOF'
import json, re, sys
web = json.load(open(sys.argv[1]))
line = next(l for l in open(sys.argv[2]) if l.startswith("CROSSPLAY-RESULTS "))
app = {str(h["hand"]): h["result"] for h in json.loads(line[len("CROSSPLAY-RESULTS "):])}
screens = {"app": app, **{k: {str(h): t for h, t in v.items()} for k, v in web["results"].items()}}
common = sorted(set.intersection(*(set(s) for s in screens.values())), key=int)
if len(common) < int(sys.argv[3]):
    sys.exit(f"only {len(common)} hands were seen ending on every screen: {screens}")
for hand in common:
    seen = {name: s[hand] for name, s in screens.items()}
    if len(set(seen.values())) != 1:
        sys.exit(f"hand #{hand} ended differently: {seen}")
    print(f"hand #{hand}: " + seen["app"].replace("\n", "; "))
print(f"cross-play: {len(common)} hands ended the same in the app, Chromium and WebKit; "
      f"{web['app']} (the app) acted in both browsers' logs")
EOF

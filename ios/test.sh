#!/usr/bin/env bash
# The iPhone app's checks (P5D.1, docs/ios.md): RiverMindKit's tests on this Mac,
# then the app's UI tests in a simulator of its own, both against a local Node
# server started from web/build. CI's ios job runs this script.
#
#   ios/test.sh             the package, then the app
#   ios/test.sh package     the package alone (swift test)
#   ios/test.sh app         the app alone (xcodebuild test)
#
# RIVERMIND_SERVER        use a server that is already running instead of starting one
# RIVERMIND_TEST_PORT     the port the started server listens on (4380)
# RIVERMIND_SIMULATOR     the simulator's name ("RiverMind Test"), made if missing
# RIVERMIND_DEVICE_TYPE   its device type when made (iPhone 17)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
what=${1:-all}
port=${RIVERMIND_TEST_PORT:-4380}
simulator=${RIVERMIND_SIMULATOR:-RiverMind Test}
device_type=${RIVERMIND_DEVICE_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17}
logs="$here/DerivedData/logs"
mkdir -p "$logs"

case "$what" in all | package | app) ;; *) echo "usage: ios/test.sh [all|package|app]" >&2; exit 2 ;; esac

server_pid=
cleanup() {
	if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

if [ -z "${RIVERMIND_SERVER:-}" ]; then
	if [ ! -f "$root/web/build/start.js" ]; then
		echo "web/build is missing: run pnpm build in web/ first" >&2
		exit 1
	fi
	if curl -s -o /dev/null "http://127.0.0.1:$port/"; then
		echo "something already answers on 127.0.0.1:$port; set RIVERMIND_TEST_PORT" >&2
		exit 1
	fi
	# A server with no database and a throwaway secret, as `pnpm start` runs locally.
	(cd "$root/web" && exec env PORT="$port" HOST=127.0.0.1 ORIGIN="http://127.0.0.1:$port" \
		RIVERMIND_API=1 node build/start.js) >"$logs/server.log" 2>&1 &
	server_pid=$!
	export RIVERMIND_SERVER="http://127.0.0.1:$port"
	for _ in $(seq 1 60); do
		if curl -sf -o /dev/null "$RIVERMIND_SERVER/api/config"; then break; fi
		if ! kill -0 "$server_pid" 2>/dev/null; then cat "$logs/server.log" >&2; exit 1; fi
		sleep 0.5
	done
	curl -sf -o /dev/null "$RIVERMIND_SERVER/api/config" || { cat "$logs/server.log" >&2; exit 1; }
fi
echo "server: $RIVERMIND_SERVER"

if [ "$what" != app ]; then
	(cd "$here/RiverMindKit" && swift test -Xswiftc -warnings-as-errors)
fi

if [ "$what" != package ]; then
	# A simulator of this script's own, on the newest iOS runtime installed: other
	# sessions boot simulators too (AGENTS.md).
	udid=$(xcrun simctl list -j devices available | python3 -c '
import json, sys
name = sys.argv[1]
for runtime, devices in json.load(sys.stdin)["devices"].items():
    for device in devices:
        if device["name"] == name and "iOS" in runtime:
            print(device["udid"]); raise SystemExit
' "$simulator")
	if [ -z "$udid" ]; then
		runtime=$(xcrun simctl list -j runtimes available | python3 -c '
import json, sys
ios = [r for r in json.load(sys.stdin)["runtimes"] if r["platform"] == "iOS" and r["isAvailable"]]
ios.sort(key=lambda r: [int(p) for p in r["version"].split(".")])
print(ios[-1]["identifier"])')
		udid=$(xcrun simctl create "$simulator" "$device_type" "$runtime")
		echo "made simulator $simulator ($udid) on $runtime"
	fi
	echo "simulator: $simulator ($udid)"
	# xcodebuild hands TEST_RUNNER_ variables to the test runner without the prefix.
	status=0
	TEST_RUNNER_RIVERMIND_SERVER="$RIVERMIND_SERVER" xcodebuild test \
		-project "$here/RiverMind.xcodeproj" -scheme RiverMind \
		-destination "id=$udid" -derivedDataPath "$here/DerivedData" \
		-resultBundlePath "$here/DerivedData/results/$(date +%Y%m%dT%H%M%S).xcresult" \
		-quiet 2>&1 | tee "$logs/xcodebuild.log" || status=$?
	if [ "$status" -ne 0 ]; then exit "$status"; fi
	# The targets treat warnings as errors, but Swift keeps a concurrency diagnostic
	# about an API imported with @preconcurrency (XCTest's, say) a warning whatever
	# the flag: fail on any warning in this directory's sources too.
	if grep -E "^$here/[^:]+:[0-9]+:[0-9]+: warning:" "$logs/xcodebuild.log"; then
		echo "warnings in the app's sources" >&2
		exit 1
	fi
fi

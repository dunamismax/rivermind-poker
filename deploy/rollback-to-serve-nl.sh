#!/usr/bin/env bash
# Undo the P4B.7 cutover on ubuntu-vm: give the tables back to the Python table
# server, serve-nl. Run as root, from the checkout the live release was built
# from (do not pull first):
#   bash /home/sawyer/github/rivermind-poker/deploy/rollback-to-serve-nl.sh
# The Node server keeps serving pages and assets from the current release, with
# its API and tables off; Caddy sends /api/* and /ws to serve-nl again. Open
# tables, guests, wallets and hands carry over: both servers read and write the
# same snapshots, cookies and histories (P4B.5b), which
# web/src/lib/server/api/tables.db.spec.ts checks on every test run and which
# was rehearsed on a copy of the live database before the cutover.
# deploy/update.sh cuts over again. Removed at P4B.8, with serve-nl itself.
set -euo pipefail

REPO=/home/sawyer/github/rivermind-poker
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -x $REPO/.venv/bin/rivermind-poker ]] || { echo "no $REPO/.venv: run uv sync first" >&2; exit 1; }
"$REPO/.venv/bin/rivermind-poker" serve-nl --help >/dev/null

# Stop the Node server first: it finishes the change it is saving and lets go
# of every table before serve-nl restores them. The two must never run the
# tables together.
systemctl stop rivermind-poker-web.service
install -m 0644 "$REPO/deploy/rollback/rivermind-poker.service" /etc/systemd/system/rivermind-poker.service
install -m 0644 "$REPO/deploy/rollback/rivermind-poker-web.service" /etc/systemd/system/rivermind-poker-web.service
install -m 0644 "$REPO/deploy/rollback/rivermindpoker.com.caddy" /etc/caddy/sites/rivermindpoker.com.caddy
systemctl daemon-reload
systemctl enable rivermind-poker.service
systemctl start rivermind-poker.service
ok=
for _ in $(seq 60); do
    if curl -fsS http://127.0.0.1:4316/api/config >/dev/null 2>&1; then
        ok=1
        break
    fi
    sleep 1
done
[[ -n $ok ]] || { echo "serve-nl is not answering; see journalctl -u rivermind-poker" >&2; exit 1; }
systemctl start rivermind-poker-web.service
for _ in $(seq 30); do
    curl -fsS http://127.0.0.1:4320/healthz >/dev/null 2>&1 && break
    sleep 1
done
systemctl reload caddy
systemctl --no-pager --lines=5 status rivermind-poker.service rivermind-poker-web.service

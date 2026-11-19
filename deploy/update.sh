#!/usr/bin/env bash
# Deploy or update rivermindpoker.com on ubuntu-vm. Run as root:
#   bash /home/sawyer/github/rivermind-poker/deploy/update.sh
# Pulls main as sawyer, syncs the locked environment on Python 3.12 from
# /opt/uv-python, runs the tests, installs the systemd unit and Caddy site,
# then restarts the service and checks it answers. The pinned checkpoint and
# tables are not in Git; copy them to artifacts/rm06/ first (see BUILD.md).
set -euo pipefail

REPO=/home/sawyer/github/rivermind-poker
UV=/home/sawyer/.local/bin/uv
export UV_PYTHON_INSTALL_DIR=/opt/uv-python
as_sawyer() { sudo -u sawyer --preserve-env=UV_PYTHON_INSTALL_DIR "$@"; }

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

if [[ "${1:-}" != --pulled ]]; then
    as_sawyer git -C "$REPO" pull --ff-only origin main
    # Bash keeps reading the file it started with; run the pulled version.
    exec bash "$REPO/deploy/update.sh" --pulled
fi
"$UV" python install 3.12  # shared, world-readable interpreter for the service user
chmod -R a+rX "$UV_PYTHON_INSTALL_DIR"
(cd "$REPO" && as_sawyer "$UV" sync --locked --python 3.12)
(cd "$REPO" && as_sawyer "$UV" run --locked pytest -q)

id rivermind-poker >/dev/null 2>&1 || useradd --system --no-create-home \
    --home-dir /nonexistent --shell /usr/sbin/nologin rivermind-poker
setfacl -m u:rivermind-poker:--x /home/sawyer
chmod -R a+rX "$REPO/.venv" "$REPO/artifacts/rm06"

install -m 0644 "$REPO/deploy/rivermind-poker.service" /etc/systemd/system/rivermind-poker.service
install -m 0644 "$REPO/deploy/rivermindpoker.com.caddy" /etc/caddy/sites/rivermindpoker.com.caddy
# The host's Caddy reload preflight requires every access log to be declared
# in its tmpfiles config, which also creates the file with caddy ownership.
LOGS=/etc/tmpfiles.d/caddy-access-logs.conf
grep -q rivermindpoker-access.log "$LOGS" || printf '%-50s %s\n' \
    "f /var/log/caddy/rivermindpoker-access.log" "0600 caddy caddy -" >> "$LOGS"
systemd-tmpfiles --create "$LOGS"
chown caddy:caddy /var/log/caddy/rivermindpoker-access.log
systemctl daemon-reload
systemctl enable rivermind-poker.service
systemctl restart rivermind-poker.service
# The reload runs the host preflight, which validates the whole config as the
# caddy user. (Validating as root would create log files caddy cannot write.)
systemctl reload caddy

for _ in $(seq 60); do
    curl -fsS http://127.0.0.1:4316/api/config && echo && break
    sleep 1
done
systemctl --no-pager --lines=5 status rivermind-poker.service

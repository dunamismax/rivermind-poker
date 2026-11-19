#!/usr/bin/env bash
# Deploy or update rivermindpoker.com on ubuntu-vm. Run as root:
#   bash /home/sawyer/github/rivermind-poker/deploy/update.sh
# Pulls main as sawyer, syncs the locked environment on Python 3.12 from
# /opt/uv-python, runs the tests (with the database tests, once
# deploy/setup-database.sh has run) and builds the web client from the frozen
# lockfile, stopping before the live site changes if any of that fails. Then it
# migrates the database, installs the systemd unit and Caddy site, restarts the service, publishes the
# build as a release under /srv/rivermindpoker.com and checks the app answers.
# The pinned checkpoint and tables are not in Git; copy them to artifacts/rm06/
# first (see BUILD.md). Node (the major in web/.node-version) must be on
# sawyer's PATH, directly or through mise; pnpm comes from corepack.
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
# Database credentials from deploy/setup-database.sh, root-only. Each file's
# variables are passed to one command through the environment, never argv.
DB_ENV=/etc/rivermind-poker
with_db_env() {
    local file=$1; shift
    (
        set -a
        # shellcheck disable=SC1090
        . "$file"
        set +a
        vars=$(sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' "$file" | paste -sd, -)
        sudo -u sawyer --preserve-env="UV_PYTHON_INSTALL_DIR,$vars" "$@"
    )
}
# With test.env the run includes the database tests on a separate test database.
if [[ -f $DB_ENV/test.env ]]; then
    (cd "$REPO" && with_db_env "$DB_ENV/test.env" "$UV" run --locked pytest -q)
else
    echo "no $DB_ENV/test.env: database tests skipped (run deploy/setup-database.sh)" >&2
    (cd "$REPO" && as_sawyer "$UV" run --locked pytest -q)
fi

# Build the SvelteKit client as sawyer, in a login shell for Node's PATH.
NODE_MAJOR=$(tr -d '[:space:]' < "$REPO/web/.node-version")
NODE_MAJOR=${NODE_MAJOR%%.*}
# shellcheck disable=SC2016  # expanded by the inner shell
as_sawyer env NODE_MAJOR="$NODE_MAJOR" WEB="$REPO/web" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    bash -lc 'set -euo pipefail
        export PATH="$HOME/.local/share/mise/shims:$PATH"
        have=$(node --version 2>/dev/null || echo none)
        [[ $have == "v$NODE_MAJOR".* ]] || {
            echo "web build needs Node $NODE_MAJOR, found $have" >&2; exit 1; }
        cd "$WEB"
        corepack pnpm install --frozen-lockfile
        corepack pnpm build'
[[ -f "$REPO/web/build/200.html" ]] || { echo "web build has no 200.html" >&2; exit 1; }

id rivermind-poker >/dev/null 2>&1 || useradd --system --no-create-home \
    --home-dir /nonexistent --shell /usr/sbin/nologin rivermind-poker
setfacl -m u:rivermind-poker:--x /home/sawyer
chmod -R a+rX "$REPO/.venv" "$REPO/artifacts/rm06"

# Migrate the site database before the new code starts.
if [[ -f $DB_ENV/migration.env ]]; then
    (cd "$REPO" && with_db_env "$DB_ENV/migration.env" "$UV" run --locked alembic upgrade head)
else
    echo "no $DB_ENV/migration.env: database not migrated (run deploy/setup-database.sh)" >&2
fi

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

# Publish the client as a new root-owned release and switch Caddy's root to it
# atomically. The three newest releases are kept for a quick rollback: point
# current at an older one with `ln -sfn <release> current.new && mv -T ...`.
RELEASES=/srv/rivermindpoker.com
RELEASE=$(date -u +%Y%m%dT%H%M%SZ)-$(as_sawyer git -C "$REPO" rev-parse --short=12 HEAD)
install -d -m 0755 "$RELEASES"
cp -R "$REPO/web/build" "$RELEASES/$RELEASE.tmp"
chown -R root:root "$RELEASES/$RELEASE.tmp"
chmod -R u=rwX,go=rX "$RELEASES/$RELEASE.tmp"
mv -T "$RELEASES/$RELEASE.tmp" "$RELEASES/$RELEASE"
ln -sfn "$RELEASE" "$RELEASES/current.new"
mv -T "$RELEASES/current.new" "$RELEASES/current"
find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -name '20*Z-*' -printf '%f\n' |
    sort -r | tail -n +4 | while read -r old; do rm -rf "${RELEASES:?}/$old"; done
# The reload runs the host preflight, which validates the whole config as the
# caddy user. (Validating as root would create log files caddy cannot write.)
systemctl reload caddy

for _ in $(seq 60); do
    curl -fsS http://127.0.0.1:4316/api/config && echo && break
    sleep 1
done
systemctl --no-pager --lines=5 status rivermind-poker.service

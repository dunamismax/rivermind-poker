#!/usr/bin/env bash
# Deploy or update rivermindpoker.com on ubuntu-vm. Run as root:
#   bash /home/sawyer/github/rivermind-poker/deploy/update.sh
# Pulls main as sawyer, then checks everything before the live site changes:
# the Python suite for the offline tools and, until P4B.8, the Python table
# server (on Python 3.12 from /opt/uv-python, with the database tests on the
# test database), and the web suite from the frozen lockfile (check, lint,
# Vitest on the same test database, the table parity run against the Python
# table, and the build). If any of that fails it stops there.
# Then it runs the Drizzle migrations, installs the systemd units and the Caddy
# site, stops the Python table server if it is still running (the P4B.7
# cutover), publishes the build as a release under /srv/rivermindpoker.com,
# restarts the Node server on it, which restores the open tables, and checks it
# answers. deploy/rollback-to-serve-nl.sh undoes the cutover.
# The service needs /etc/rivermind-poker/web.env from deploy/setup-database.sh,
# since tables live in PostgreSQL, and the session secret serve-nl made in
# /var/lib/rivermind-poker/secret. Node (the major in web/.node-version) must be
# on sawyer's PATH, directly or through mise; pnpm comes from corepack.
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

# The web suite and the build, as sawyer, in a login shell for Node's PATH.
# Playwright's browsers are not on this host: CI and `pnpm e2e:live` cover them.
NODE_MAJOR=$(tr -d '[:space:]' < "$REPO/web/.node-version")
NODE_MAJOR=${NODE_MAJOR%%.*}
# shellcheck disable=SC2016  # expanded by the inner shell
WEB_SUITE='set -euo pipefail
    export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
    have=$(node --version 2>/dev/null || echo none)
    [[ $have == "v$NODE_MAJOR".* ]] || {
        echo "web build needs Node $NODE_MAJOR, found $have" >&2; exit 1; }
    cd "$WEB"
    corepack pnpm install --frozen-lockfile
    corepack pnpm check
    corepack pnpm lint
    corepack pnpm test
    corepack pnpm table:parity
    corepack pnpm build'
if [[ -f $DB_ENV/test.env ]]; then
    with_db_env "$DB_ENV/test.env" env NODE_MAJOR="$NODE_MAJOR" WEB="$REPO/web" \
        COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -lc "$WEB_SUITE"
else
    echo "no $DB_ENV/test.env: web database tests skipped (run deploy/setup-database.sh)" >&2
    as_sawyer env NODE_MAJOR="$NODE_MAJOR" WEB="$REPO/web" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
        bash -lc "$WEB_SUITE"
fi
for built in start.js handler.js client; do
    [[ -e "$REPO/web/build/$built" ]] || { echo "web build has no $built" >&2; exit 1; }
done

[[ -f $DB_ENV/web.env ]] || { echo "no $DB_ENV/web.env: run deploy/setup-database.sh" >&2; exit 1; }
SECRET=/var/lib/rivermind-poker/secret
[[ -s $SECRET ]] || { echo "no session secret at $SECRET: every guest would be signed out" >&2; exit 1; }
# The Python table server's user and its access to the checkout, for a rollback.
id rivermind-poker >/dev/null 2>&1 || useradd --system --no-create-home \
    --home-dir /nonexistent --shell /usr/sbin/nologin rivermind-poker
setfacl -m u:rivermind-poker:--x /home/sawyer
chmod -R a+rX "$REPO/.venv"

# Migrate the site database before the new code starts (Drizzle, P4B.3; until
# P4B.8 its migrations build exactly the schema Alembic's do, so serve-nl can
# still run on it).
if [[ -f $DB_ENV/migration.env ]]; then
    # shellcheck disable=SC2016
    with_db_env "$DB_ENV/migration.env" env WEB="$REPO/web" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
        bash -lc 'set -euo pipefail
            export PATH="$HOME/.local/share/mise/shims:$PATH"
            cd "$WEB" && corepack pnpm db:migrate'
else
    echo "no $DB_ENV/migration.env: database not migrated (run deploy/setup-database.sh)" >&2
fi

install -m 0644 "$REPO/deploy/rollback/rivermind-poker.service" /etc/systemd/system/rivermind-poker.service
install -m 0644 "$REPO/deploy/rivermind-poker-web.service" /etc/systemd/system/rivermind-poker-web.service
install -m 0644 "$REPO/deploy/rivermindpoker.com.caddy" /etc/caddy/sites/rivermindpoker.com.caddy
# The host's Caddy reload preflight requires every access log to be declared
# in its tmpfiles config, which also creates the file with caddy ownership.
LOGS=/etc/tmpfiles.d/caddy-access-logs.conf
grep -q rivermindpoker-access.log "$LOGS" || printf '%-50s %s\n' \
    "f /var/log/caddy/rivermindpoker-access.log" "0600 caddy caddy -" >> "$LOGS"
systemd-tmpfiles --create "$LOGS"
chown caddy:caddy /var/log/caddy/rivermindpoker-access.log
systemctl daemon-reload
# The tables belong to the Node server (P4B.7). Stop the Python one first, so it
# saves its last change and lets go of every table before they are restored;
# the web unit's Conflicts= would stop it too. It stays installed, stopped and
# disabled, for deploy/rollback-to-serve-nl.sh.
if systemctl is-active --quiet rivermind-poker.service; then
    echo "Stopping the Python table server: the Node server takes the tables over"
fi
systemctl disable --now rivermind-poker.service

# Publish the web build as a new root-owned release (its build/ directory and a
# package.json marking it as ES modules), switch current to it atomically and
# restart the Node web server there. The three newest releases are kept for a
# quick rollback to an older build: point current at one with
# `ln -sfn <release> current.new && mv -T ...` and restart rivermind-poker-web.
RELEASES=/srv/rivermindpoker.com
RELEASE=$(date -u +%Y%m%dT%H%M%SZ)-$(as_sawyer git -C "$REPO" rev-parse --short=12 HEAD)
install -d -m 0755 "$RELEASES"
install -d -m 0755 "$RELEASES/$RELEASE.tmp"
cp -R "$REPO/web/build" "$RELEASES/$RELEASE.tmp/build"
printf '{ "private": true, "type": "module" }\n' > "$RELEASES/$RELEASE.tmp/package.json"
chown -R root:root "$RELEASES/$RELEASE.tmp"
chmod -R u=rwX,go=rX "$RELEASES/$RELEASE.tmp"
mv -T "$RELEASES/$RELEASE.tmp" "$RELEASES/$RELEASE"
ln -sfn "$RELEASE" "$RELEASES/current.new"
mv -T "$RELEASES/current.new" "$RELEASES/current"
find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -name '20*Z-*' -printf '%f\n' |
    sort -r | tail -n +4 | while read -r old; do rm -rf "${RELEASES:?}/$old"; done
systemctl enable rivermind-poker-web.service
systemctl restart rivermind-poker-web.service
# The server restores the open tables before it listens, so wait for it, and for
# the API and the database behind it, before Caddy sends /api and /ws its way.
ok=
for _ in $(seq 60); do
    if curl -fsS http://127.0.0.1:4320/healthz >/dev/null 2>&1 &&
        curl -fsS -H 'Host: rivermindpoker.com' -H 'X-Forwarded-Proto: https' \
            http://127.0.0.1:4320/api/config >/dev/null 2>&1; then
        ok=1
        break
    fi
    sleep 1
done
[[ -n $ok ]] || {
    echo "the Node server is not answering; see journalctl -u rivermind-poker-web" >&2
    echo "to go back to serve-nl: bash $REPO/deploy/rollback-to-serve-nl.sh" >&2
    systemctl --no-pager --lines=30 status rivermind-poker-web.service || true
    exit 1
}
# The reload runs the host preflight, which validates the whole config as the
# caddy user. (Validating as root would create log files caddy cannot write.)
systemctl reload caddy
systemctl --no-pager --lines=8 status rivermind-poker-web.service

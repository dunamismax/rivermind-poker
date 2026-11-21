#!/usr/bin/env bash
# Deploy rivermindpoker.com on ubuntu-vm, fix-forward, as docs/web-platform.md
# in ubuntu-vm-backup sets out. Run as root:
#
#   bash /home/sawyer/github/rivermind-poker/deploy/update.sh
#
# It deploys origin/main. Every step stops the deploy at its first failure and
# says which step; until the switch (step 5) the release already serving is
# untouched and keeps serving. A release that fails after the switch is fixed
# by a new commit and a new deploy, never by pointing `current` back.
#
# Outside the lock, as sawyer:
#   1. build   git archive the commit into /home/sawyer/web-work/rivermindpoker.com-<commit>,
#              then the Python suite (uv.lock, Python from .python-version), the
#              champions on this host against the registry, and the web suite
#              (frozen pnpm-lock.yaml on the pinned Node 26 and pnpm: check, lint,
#              Vitest with the database tests on the test database, the engine,
#              bot and table parity checks against the Python references) and
#              the build. Playwright's browsers are not on this host: CI runs them.
# Inside one with-deploy-lock process, as root:
#   2. stage      the release under /srv/rivermindpoker.com/<UTC time>-<commit12>,
#                 root-owned, with REVISION, .node-version, package.json, build/
#                 (start.js, the server; migrate.js, the migrator; moderation.js, the
#                 moderator's commands; voice/, the voice service and mediasoup's
#                 worker), deploy/ and drizzle/
#   3. migrate    dump the database to /var/backups/rivermindpoker.com, then run
#                 the release's migrator as the service's user with migration.env
#                 only, and check Drizzle's journal against the release's
#   4. candidate  start the release from its own directory under a copy of its
#                 unit (rivermind-poker-web-candidate, port 4400-4499) with
#                 RIVERMIND_CANDIDATE=1, which checks the database, the saved
#                 tables and the champion but never restores or deals a table;
#                 then deploy/smoke.sh against it, and stop it; the same for the
#                 voice service (rivermind-poker-voice-candidate, on loopback and
#                 free ports in 4400-4499), with the voice key derived from the
#                 session secret into /var/lib/rivermind-poker/voice-key
#   5. switch     install the unit if it changed, point `current` at the release
#                 and restart rivermind-poker-web, which saves nothing on the way
#                 down that it had not saved already and restores every open
#                 table, hands in progress included, before it listens
#   6. verify     /healthz reports the commit, deploy/smoke.sh passes on the live
#                 port, and the running process is the release on /opt/node-26
#   7. voice      install rivermind-poker-voice's unit if it changed, allow its
#                 media port (3478, UDP and TCP) in ufw, and restart it only if
#                 its unit, its key or build/voice/ changed or it is not running,
#                 so a site deploy leaves conversations alone; then /healthz on
#                 127.0.0.1:4323 and the origin check
#   8. caddy      caddy-apply the site's fragment, only if it changed
#   9. record     log "rivermindpoker.com <commit> live" and smoke the public site
#
# The release name keeps the <time>-<commit12> form the host backup expects
# (config/applications.json in ubuntu-vm-backup); REVISION holds the full commit.
# The five newest releases are kept as evidence for debugging, as
# server-disk-cleanup keeps them for /srv/www sites, and so is the one the voice
# service runs from, which may be older.
#
# Needs, from deploy/setup-database.sh: /etc/web-apps/rivermind_poker/web.env
# (the service), migration.env (step 3) and test.env (the database tests); the
# session secret in /var/lib/rivermind-poker/secret; and every champion in
# docs/models.json in /srv/rivermind-poker/models/champions (docs/bots.md says
# how to copy one there).
set -Eeuo pipefail

SITE=rivermindpoker.com
UNIT=rivermind-poker-web
PORT=4320
VOICE_UNIT=rivermind-poker-voice
VOICE_PORT=4323
VOICE_MEDIA_PORT=3478
DB=rivermind_poker
REPO=/home/sawyer/github/rivermind-poker
RELEASES=/srv/$SITE
ENV_DIR=/etc/web-apps/$DB
MODELS=/srv/rivermind-poker/models/champions
SECRET=/var/lib/rivermind-poker/secret
VOICE_KEY=/var/lib/rivermind-poker/voice-key
NODE=/opt/node-26/bin/node
NODE_REAL=/opt/node-v26.13.1-linux-x64/bin/node
UV=/home/sawyer/.local/bin/uv
WEB_LIVE=/home/sawyer/github/ubuntu-vm-backup/bin/web-live
# Python 3.12 from .python-version lives here, readable by sawyer; never downloaded.
export UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_PYTHON_DOWNLOADS=never

step() { current_step=$*; printf '\n== %s: %s\n' "$SITE" "$*"; }
current_step="1. build"
# Any command that fails stops the deploy; say in which step.
trap 'printf "%s deploy stopped in step %s\n" "$SITE" "$current_step" >&2' ERR
die() { printf '%s deploy stopped: %s\n' "$SITE" "$*" >&2; exit 1; }

# Run a command as sawyer with one env file's variables in its environment,
# never on a command line.
with_env_as_sawyer() {
    local file=$1; shift
    (
        set -a
        # shellcheck disable=SC1090
        . "$file"
        set +a
        vars=$(sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' "$file" | paste -sd, -)
        sudo -u sawyer --preserve-env="UV_PYTHON_INSTALL_DIR,UV_PYTHON_DOWNLOADS,$vars" "$@"
    )
}

# The voice service's /healthz on a port, and its refusal of a page from
# another origin: a browser's handshake from elsewhere gets 403.
voice_check() {
    local port=$1 body status
    body=$(curl -fsS --max-time 5 "http://127.0.0.1:$port/healthz") || return 1
    grep -q '"status":"ok"' <<<"$body" || { echo "voice /healthz: $body" >&2; return 1; }
    status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
        -H 'Sec-WebSocket-Key: cml2ZXJtaW5kLXNtb2tlIQ==' -H 'Origin: https://elsewhere.invalid' \
        "http://127.0.0.1:$port/voice")
    [[ $status == 403 ]] || { echo "voice /voice from another origin: $status, not 403" >&2; return 1; }
}

# The voice key: tokens are signed with it, and it is all the voice service
# holds of the session secret. Derived from the release's own bundle as a
# dynamic user, never as root; voice_key_changed=1 when it was (re)written.
derive_voice_key() {
    local release=$1 new_key
    new_key=$(mktemp "$VOICE_KEY.XXXXXX")
    systemd-run --wait --collect --pipe --quiet --unit="$VOICE_UNIT-derive-key" \
        -p DynamicUser=yes -p NoNewPrivileges=true -p ProtectSystem=strict -p ProtectHome=true \
        -p PrivateTmp=true -p PrivateNetwork=true \
        "$NODE" "$release/build/voice/voice.js" derive-key < "$SECRET" > "$new_key" ||
        die "could not derive the voice key; the previous release is still serving"
    grep -qxE '[0-9a-f]{64}' "$new_key" || die "the voice key is not 64 hex digits"
    if cmp -s "$new_key" "$VOICE_KEY"; then
        rm -f "$new_key"
    else
        chmod 0600 "$new_key"
        mv -f "$new_key" "$VOICE_KEY"
        voice_key_changed=1
        echo "wrote $VOICE_KEY"
    fi
}

# The voice service as a candidate (step 4): the release's bundle and worker
# start under the unit's sandbox and answer, on loopback and ports of their
# own in 4400-4499, while the live service keeps 3478. Run alone as
# `update.sh voice-candidate RELEASE`, inside with-deploy-lock.
voice_candidate() {
    local release=$1 skip=${2:-} used port vport mport voiced
    local -a voice_ports=()
    local voice_candidate_unit=$VOICE_UNIT-candidate
    local voice_candidate_file=/run/systemd/system/$voice_candidate_unit.service
    used=$( (ss -ltnH; ss -lunH) | awk '{print $4}' | sed 's/.*://' | sort -u)
    for port in $(seq 4400 4499); do
        [[ $port == "$skip" ]] && continue
        grep -qx "$port" <<<"$used" && continue
        grep -rqs "127.0.0.1:$port\b" /etc/caddy/sites && continue
        voice_ports+=("$port")
        ((${#voice_ports[@]} == 2)) && break
    done
    ((${#voice_ports[@]} == 2)) || die "no free voice candidate ports in 4400-4499"
    vport=${voice_ports[0]} mport=${voice_ports[1]}
    sed -e "s|/srv/$SITE/current|$release|g" \
        -e "s|\bPORT=$VOICE_PORT\b|PORT=$vport|" \
        -e "s|^Environment=VOICE_MEDIA_PORT=$VOICE_MEDIA_PORT VOICE_LISTEN_IPS=0.0.0.0$|Environment=VOICE_MEDIA_PORT=$mport VOICE_LISTEN_IPS=127.0.0.1|" \
        -e "s|^SocketBindAllow=tcp:$VOICE_PORT$|SocketBindAllow=tcp:$vport|" \
        -e "s|^SocketBindAllow=udp:$VOICE_MEDIA_PORT$|SocketBindAllow=udp:$mport|" \
        -e "s|^SocketBindAllow=tcp:$VOICE_MEDIA_PORT$|SocketBindAllow=tcp:$mport|" \
        -e "s|^SyslogIdentifier=.*|SyslogIdentifier=$voice_candidate_unit|" \
        -e "s|^Restart=.*|Restart=no|" \
        "$release/deploy/$VOICE_UNIT.service" > "$voice_candidate_file"
    grep -q "PORT=$vport" "$voice_candidate_file" &&
        grep -q "VOICE_MEDIA_PORT=$mport VOICE_LISTEN_IPS=127.0.0.1" "$voice_candidate_file" &&
        grep -qx "SocketBindAllow=tcp:$vport" "$voice_candidate_file" &&
        grep -qx "SocketBindAllow=udp:$mport" "$voice_candidate_file" &&
        grep -qx "SocketBindAllow=tcp:$mport" "$voice_candidate_file" &&
        ! grep -q "/srv/$SITE/current\|PORT=$VOICE_PORT\b\|:$VOICE_MEDIA_PORT$" "$voice_candidate_file" ||
        die "could not make the voice candidate unit from $release/deploy/$VOICE_UNIT.service"
    systemctl daemon-reload
    systemctl start "$voice_candidate_unit.service"
    voiced=
    for _ in $(seq 60); do
        if voice_check "$vport" 2>/dev/null; then
            voiced=1
            break
        fi
        systemctl is-active --quiet "$voice_candidate_unit.service" || break
        sleep 1
    done
    if [[ -z $voiced ]] || ! voice_check "$vport"; then
        journalctl -u "$voice_candidate_unit.service" -n 40 --no-pager >&2 || true
        die "the voice candidate failed its checks; the previous release is still serving"
    fi
    systemctl stop "$voice_candidate_unit.service" 2>/dev/null || true
    rm -f "$voice_candidate_file"
    systemctl daemon-reload
    echo "voice candidate on ports $vport and $mport passed"
}

mode=${1:-start}
case $mode in
start)
    # Fetch, take origin/main and archive it; then run the archived script, so
    # every later step is the commit's own.
    [[ $EUID -eq 0 ]] || die "run as root"
    sudo -u sawyer git -C "$REPO" fetch --quiet origin main
    commit=$(sudo -u sawyer git -C "$REPO" rev-parse origin/main)
    work=/home/sawyer/web-work/$SITE-$commit
    step "1. build $commit in $work"
    sudo -u sawyer bash -c 'set -e; rm -rf "$1"; mkdir -p "$1"; git -C "$2" archive "$3" | tar -x -C "$1"' \
        _ "$work" "$REPO" "$commit"
    exec bash "$work/deploy/update.sh" archived "$commit"
    ;;

archived)
    commit=$2
    work=/home/sawyer/web-work/$SITE-$commit
    [[ -f $ENV_DIR/test.env ]] || die "no $ENV_DIR/test.env for the database tests"
    with_env_as_sawyer "$ENV_DIR/test.env" bash "$work/deploy/update.sh" build "$commit"
    exec /usr/local/sbin/with-deploy-lock bash "$work/deploy/update.sh" activate "$commit"
    ;;

build)
    # As sawyer, in the work directory, with RIVERMIND_TEST_DATABASE_URL set.
    commit=$2
    work=/home/sawyer/web-work/$SITE-$commit
    cd "$work"
    [[ $(id -un) == sawyer ]] || die "the build runs as sawyer"
    [[ -n ${RIVERMIND_TEST_DATABASE_URL:-} ]] || die "no test database for the web suite"
    # The pinned toolchain first, and uv for the parity checks' Python side.
    pnpm() { /usr/local/bin/node-26 env PATH="/opt/node-26/bin:/opt/pnpm:${UV%/*}:/usr/bin:/bin" pnpm "$@"; }
    [[ $(/usr/local/bin/node-26 node --version) == "v$(cat web/.node-version)" ]] || die "Node is not web/.node-version"
    "$UV" sync --locked
    "$UV" run --locked python --version
    "$UV" run --locked pytest -q
    "$UV" run --locked rivermind-poker blueprint champions --verify "$MODELS" ||
        die "a champion in docs/models.json is not in $MODELS as registered; copy it there first (docs/bots.md)"
    cd web
    pnpm install --frozen-lockfile
    pnpm run check
    pnpm run lint
    pnpm run test
    pnpm run engine:parity
    pnpm run bots:parity
    pnpm run table:parity
    pnpm run build
    for built in start.js migrate.js moderation.js handler.js client voice/voice.js voice/mediasoup-worker; do
        [[ -e build/$built ]] || die "the build has no $built"
    done
    # Every dependency is bundled into build/, so the release needs no node_modules.
    printf '%s\n' "$commit" > REVISION
    ;;

activate)
    # Root, inside with-deploy-lock.
    commit=$2
    work=/home/sawyer/web-work/$SITE-$commit
    [[ $EUID -eq 0 ]] || die "run as root"
    [[ $(head -n 1 "$work/web/REVISION") == "$commit" ]] || die "the build in $work is not $commit"
    for file in "$ENV_DIR/web.env" "$ENV_DIR/migration.env"; do
        [[ -f $file ]] || die "no $file: run deploy/setup-database.sh"
    done
    [[ -s $SECRET ]] || die "no session secret at $SECRET: every guest would be signed out"
    candidate_unit=$UNIT-candidate
    candidate_file=/run/systemd/system/$candidate_unit.service
    voice_candidate_unit=$VOICE_UNIT-candidate
    voice_candidate_file=/run/systemd/system/$voice_candidate_unit.service
    stop_candidate() {
        local unit file
        for unit in "$candidate_unit" "$voice_candidate_unit"; do
            file=/run/systemd/system/$unit.service
            if [[ -e $file ]]; then
                systemctl stop "$unit.service" 2>/dev/null || true
                rm -f "$file"
                systemctl daemon-reload
            fi
        done
    }
    trap stop_candidate EXIT

    step "2. stage the release"
    release_name=$(date -u +%Y%m%dT%H%M%SZ)-${commit:0:12}
    release=$RELEASES/$release_name
    staging=$release.staging
    install -d -m 0755 "$RELEASES"
    rm -rf "$staging"
    install -d -m 0755 "$staging"
    cp -R "$work/web/build" "$staging/build"
    cp -R "$work/web/drizzle" "$staging/drizzle"
    cp -R "$work/deploy" "$staging/deploy"
    cp "$work/web/REVISION" "$work/web/.node-version" "$work/web/package.json" "$staging/"
    chown -R root:root "$staging"
    chmod -R u=rwX,go=rX "$staging"
    mv -T "$staging" "$release"
    echo "staged $release"

    step "3. migrate the database"
    install -d -m 0700 "/var/backups/$SITE"
    dump=/var/backups/$SITE/pre-migrate-$commit.dump
    (umask 077 && runuser -u postgres -- pg_dump --format=custom "$DB" > "$dump")
    echo "dumped $DB to $dump ($(stat -c %s "$dump") bytes)"
    systemd-run --wait --collect --pipe --quiet --unit="$UNIT-migrate" \
        -p DynamicUser=yes -p User="$UNIT" -p Group="$UNIT" \
        -p EnvironmentFile="$ENV_DIR/migration.env" -p WorkingDirectory="$release" \
        -p NoNewPrivileges=true -p ProtectSystem=strict -p ProtectHome=true -p PrivateTmp=true \
        "$NODE" "$release/build/migrate.js" || die "the migration failed; the previous release is still serving"
    applied=$(runuser -u postgres -- psql -d "$DB" -Atc 'SELECT count(*) FROM drizzle.__drizzle_migrations')
    expected=$(python3 -c 'import json, sys; print(len(json.load(open(sys.argv[1]))["entries"]))' \
        "$release/drizzle/meta/_journal.json")
    [[ $applied == "$expected" ]] || die "the database records $applied migrations, the release has $expected"
    echo "migrations: $applied of $expected applied"

    step "4. check the release as a candidate"
    used=$(ss -ltnH | awk '{print $4}' | sed 's/.*://' | sort -u)
    candidate_port=
    for port in $(seq 4400 4499); do
        grep -qx "$port" <<<"$used" && continue
        grep -rqs "127.0.0.1:$port\b" /etc/caddy/sites && continue
        candidate_port=$port
        break
    done
    [[ -n $candidate_port ]] || die "no free candidate port in 4400-4499"
    sed -e "s|/srv/$SITE/current|$release|g" \
        -e "s|\bPORT=$PORT\b|PORT=$candidate_port|" \
        -e "s|^Environment=RIVERMIND_API=1$|Environment=RIVERMIND_API=1 RIVERMIND_CANDIDATE=1|" \
        -e "s|^SyslogIdentifier=.*|SyslogIdentifier=$candidate_unit|" \
        -e "s|^Restart=.*|Restart=no|" \
        "$release/deploy/$UNIT.service" > "$candidate_file"
    grep -q "PORT=$candidate_port" "$candidate_file" && grep -q 'RIVERMIND_CANDIDATE=1' "$candidate_file" &&
        ! grep -q "/srv/$SITE/current\|PORT=$PORT\b" "$candidate_file" ||
        die "could not make the candidate unit from $release/deploy/$UNIT.service"
    systemctl daemon-reload
    systemctl start "$candidate_unit.service"
    healthy=
    for _ in $(seq 180); do
        if curl -fsS --max-time 5 "http://127.0.0.1:$candidate_port/healthz" 2>/dev/null | grep -q '"status":"ok"'; then
            healthy=1
            break
        fi
        systemctl is-active --quiet "$candidate_unit.service" || break
        sleep 1
    done
    if [[ -z $healthy ]] || ! bash "$release/deploy/smoke.sh" --candidate --revision "$commit" \
        "http://127.0.0.1:$candidate_port"; then
        curl -sS --max-time 5 "http://127.0.0.1:$candidate_port/healthz" >&2 || true
        journalctl -u "$candidate_unit.service" -n 40 --no-pager >&2 || true
        die "the candidate failed its checks; the previous release is still serving"
    fi
    stop_candidate
    echo "candidate on port $candidate_port passed"

    voice_key_changed=
    derive_voice_key "$release"
    voice_candidate "$release" "$candidate_port"

    step "5. switch to the release and restart"
    unit_file=/etc/systemd/system/$UNIT.service
    if ! cmp -s "$release/deploy/$UNIT.service" "$unit_file"; then
        systemd-analyze verify "$release/deploy/$UNIT.service"
        install -m 0644 "$release/deploy/$UNIT.service" "$unit_file"
        systemctl daemon-reload
        echo "installed $unit_file"
    fi
    ln -sfn "$release" "$RELEASES/current.next"
    mv -Tf "$RELEASES/current.next" "$RELEASES/current"
    systemctl enable --quiet "$UNIT.service"
    systemctl restart "$UNIT.service"

    step "6. verify what is live"
    live=
    for _ in $(seq 180); do
        if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q "\"revision\":\"$commit\""; then
            live=1
            break
        fi
        sleep 1
    done
    if [[ -z $live ]]; then
        journalctl -u "$UNIT.service" -n 40 --no-pager >&2 || true
        die "$release is live and not answering with $commit: fix it in a new commit"
    fi
    bash "$release/deploy/smoke.sh" --revision "$commit" "http://127.0.0.1:$PORT" ||
        die "$release is live and fails the smoke check: fix it in a new commit"
    IFS=$'\t' read -r _ exe cwd revision _ < <("$WEB_LIVE" "$UNIT.service")
    [[ $exe == "$NODE_REAL" && $cwd == "$release" && $revision == "$commit" ]] ||
        die "the running process is $exe in $cwd at $revision, not $release on Node 26"
    echo "live: $exe in $cwd at $revision"

    step "7. voice"
    voice_file=/etc/systemd/system/$VOICE_UNIT.service
    restart_voice=
    if ! cmp -s "$release/deploy/$VOICE_UNIT.service" "$voice_file"; then
        systemd-analyze verify "$release/deploy/$VOICE_UNIT.service"
        install -m 0644 "$release/deploy/$VOICE_UNIT.service" "$voice_file"
        systemctl daemon-reload
        echo "installed $voice_file"
        restart_voice="its unit changed"
    fi
    [[ -n $voice_key_changed ]] && restart_voice="its key changed"
    voice_pid=$(systemctl show -p MainPID --value "$VOICE_UNIT.service")
    voice_from=
    if [[ $voice_pid == 0 ]]; then
        restart_voice="it was not running"
    else
        voice_from=$(readlink "/proc/$voice_pid/cwd")
        if [[ ! -d $voice_from/build/voice ]] || ! diff -rq "$voice_from/build/voice" "$release/build/voice" >/dev/null; then
            restart_voice="its bundle changed"
        fi
    fi
    # Its media port, which nothing else on the host uses (Q-9).
    if ufw status | grep -q '^Status: active'; then
        for proto in udp tcp; do
            if ! ufw status | grep -qE "^$VOICE_MEDIA_PORT/$proto +ALLOW IN +Anywhere$"; then
                ufw allow "$VOICE_MEDIA_PORT/$proto" comment 'RiverMind table voice (rivermind-poker-voice)'
            fi
        done
    fi
    systemctl enable --quiet "$VOICE_UNIT.service"
    if [[ -n $restart_voice ]]; then
        echo "restarting $VOICE_UNIT: $restart_voice"
        systemctl restart "$VOICE_UNIT.service"
        voice_live=
        for _ in $(seq 60); do
            if curl -fsS --max-time 5 "http://127.0.0.1:$VOICE_PORT/healthz" 2>/dev/null | grep -q "\"revision\":\"$commit\""; then
                voice_live=1
                break
            fi
            sleep 1
        done
        if [[ -z $voice_live ]]; then
            journalctl -u "$VOICE_UNIT.service" -n 40 --no-pager >&2 || true
            die "$VOICE_UNIT is not answering with $commit: fix it in a new commit"
        fi
        voice_from=$release
    else
        echo "$VOICE_UNIT is unchanged: left running from $voice_from"
    fi
    voice_check "$VOICE_PORT" || die "$VOICE_UNIT fails its checks: fix it in a new commit"
    IFS=$'\t' read -r _ exe cwd revision _ < <("$WEB_LIVE" "$VOICE_UNIT.service")
    [[ $exe == "$NODE_REAL" && $cwd == "$voice_from" ]] ||
        die "the voice process is $exe in $cwd, not $voice_from on Node 26"
    echo "voice: $exe in $cwd at $revision"

    step "8. Caddy"
    fragment=$release/deploy/$SITE.caddy
    if cmp -s "$fragment" "/etc/caddy/sites/$SITE.caddy"; then
        echo "the site's fragment is unchanged"
    else
        /usr/local/sbin/caddy-apply "$SITE" "$fragment"
    fi

    step "9. record"
    logger -t web-deploy "$SITE $commit live"
    bash "$release/deploy/smoke.sh" --revision "$commit" "https://$SITE"
    find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -name '20*Z-*' -printf '%f\n' | sort -r | tail -n +6 |
        while read -r old; do
            [[ $RELEASES/$old == "$release" || $RELEASES/$old == "$voice_from" ]] || rm -rf "${RELEASES:?}/$old"
        done
    systemctl --no-pager --lines=5 status "$UNIT.service" || true
    ;;

voice-candidate)
    # Check a staged release's voice service alone, as step 4 does.
    [[ $EUID -eq 0 && -d ${2:-} ]] || die "usage: update.sh voice-candidate RELEASE (as root)"
    current_step="voice candidate"
    trap 'systemctl stop "$VOICE_UNIT-candidate.service" 2>/dev/null || true; rm -f "/run/systemd/system/$VOICE_UNIT-candidate.service"' EXIT
    [[ -s $VOICE_KEY ]] || derive_voice_key "$2"
    voice_candidate "$2"
    ;;

*)
    die "usage: update.sh"
    ;;
esac

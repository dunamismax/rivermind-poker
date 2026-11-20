#!/usr/bin/env bash
# Create RiverMind Poker's PostgreSQL databases, roles and credentials on
# ubuntu-vm. Run as root; safe to rerun (existing passwords are kept):
#   bash /home/sawyer/github/rivermind-poker/deploy/setup-database.sh
#
# Follows the host's convention for app databases:
#   rivermind_poker              the site database, owned by a NOLOGIN role
#   rivermind_poker_owner        owns the database and its `app` schema
#   rivermind_poker_migration    LOGIN, NOINHERIT; may SET ROLE to the owner,
#                                which Alembic and `pnpm db:migrate` do
#                                (RIVERMIND_MIGRATION_ROLE)
#   rivermind_poker_web          LOGIN, NOINHERIT; reads and writes rows only
#   rivermind_poker_test         LOGIN; owns the separate rivermind_poker_test
#                                database used by the deploy's test run
# Each role may connect only to its database over 127.0.0.1 with
# scram-sha-256 (pg_hba.conf). All roles use search_path = app. The owner
# also owns the `drizzle` schema, where Drizzle's migrator records applied
# migrations (P4B.3); the web role cannot see it. Credentials
# are written once as root-only env files in /etc/rivermind-poker:
#   web.env        DATABASE_URL for the service (EnvironmentFile in the unit)
#   migration.env  DATABASE_URL and RIVERMIND_MIGRATION_ROLE for update.sh
#   test.env       RIVERMIND_TEST_DATABASE_URL for update.sh's test run
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

DB=rivermind_poker
TEST_DB=rivermind_poker_test
OWNER=${DB}_owner
WEB=${DB}_web
MIGRATION=${DB}_migration
TESTER=$TEST_DB
ETC=/etc/rivermind-poker
HOST=127.0.0.1
PORT=5432

CLUSTER=$(pg_lsclusters --no-header | awk '$2 == "main" { print $1; exit }')
[[ -n $CLUSTER ]] || { echo "no PostgreSQL main cluster" >&2; exit 1; }
HBA=/etc/postgresql/$CLUSTER/main/pg_hba.conf

install -d -m 0700 -o root -g root "$ETC"

# The password in an env file's URL, or a new random one (hex needs no URL
# escaping). Passwords are never printed or passed on a command line.
password_from() {
    local file=$1 key=$2
    if [[ -f $file ]]; then
        sed -n "s|^$key=postgresql://[^:]*:\\([^@]*\\)@.*|\\1|p" "$file"
    else
        openssl rand -hex 24
    fi
}
WEB_PW=$(password_from "$ETC/web.env" DATABASE_URL)
MIGRATION_PW=$(password_from "$ETC/migration.env" DATABASE_URL)
TEST_PW=$(password_from "$ETC/test.env" RIVERMIND_TEST_DATABASE_URL)
for pw in "$WEB_PW" "$MIGRATION_PW" "$TEST_PW"; do
    [[ $pw =~ ^[0-9a-f]{48}$ ]] || { echo "unexpected password format in $ETC" >&2; exit 1; }
done

export WEB_PW MIGRATION_PW TEST_PW
psql_admin() {
    sudo --preserve-env=WEB_PW,MIGRATION_PW,TEST_PW -u postgres \
        psql -X -q -v ON_ERROR_STOP=1 \
        -v db="$DB" -v test_db="$TEST_DB" -v owner="$OWNER" -v web="$WEB" \
        -v migration="$MIGRATION" -v tester="$TESTER" "$@"
}

psql_admin -d postgres <<'SQL'
\getenv web_pw WEB_PW
\getenv migration_pw MIGRATION_PW
\getenv test_pw TEST_PW
SELECT format('CREATE ROLE %I', r) FROM unnest(ARRAY[:'owner', :'web', :'migration', :'tester']) AS r
    WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) \gexec
ALTER ROLE :"owner" NOLOGIN;
ALTER ROLE :"web" LOGIN NOINHERIT PASSWORD :'web_pw';
ALTER ROLE :"migration" LOGIN NOINHERIT PASSWORD :'migration_pw';
ALTER ROLE :"tester" LOGIN NOINHERIT PASSWORD :'test_pw';
GRANT :"owner" TO :"migration" WITH INHERIT FALSE, SET TRUE;
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'owner')
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'test_db', :'tester')
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'test_db') \gexec
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO :"web", :"migration";
REVOKE ALL ON DATABASE :"test_db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"test_db" TO :"tester";
ALTER ROLE :"web" IN DATABASE :"db" SET search_path = app;
ALTER ROLE :"migration" IN DATABASE :"db" SET search_path = app;
ALTER ROLE :"owner" IN DATABASE :"db" SET search_path = app;
SQL

psql_admin -d "$DB" <<'SQL'
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION :"owner";
CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION :"owner";
REVOKE ALL ON SCHEMA drizzle FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO :"web";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA app
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"web";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA app
    GRANT USAGE, SELECT ON SEQUENCES TO :"web";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO :"web";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO :"web";
SQL

# Allow each role into its own database before the host's final reject rules.
add_hba() {
    local line="host    $1    $2    $HOST/32    scram-sha-256"
    grep -qE "^host[[:space:]]+$1[[:space:]]+$2[[:space:]]" "$HBA" && return
    local reject
    reject=$(grep -nE '^host[[:space:]]+all[[:space:]]+all[[:space:]]+0\.0\.0\.0/0[[:space:]]+reject' "$HBA" | head -1 | cut -d: -f1)
    if [[ -n $reject ]]; then
        sed -i "${reject}i $line" "$HBA"
    else
        echo "$line" >> "$HBA"
    fi
    HBA_CHANGED=1
}
HBA_CHANGED=0
cp -p "$HBA" "$HBA.rivermind.bak"
add_hba "$DB" "$WEB"
add_hba "$DB" "$MIGRATION"
add_hba "$TEST_DB" "$TESTER"
if (( HBA_CHANGED )); then
    errors=$(sudo -u postgres psql -X -Atc "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL")
    if [[ $errors != 0 ]]; then
        cp -p "$HBA.rivermind.bak" "$HBA"
        echo "pg_hba.conf had errors; restored the previous file" >&2
        exit 1
    fi
    systemctl reload "postgresql@$CLUSTER-main"
fi

write_env() {
    local file=$1 content=$2
    umask 077
    printf '%s\n' "$content" > "$file.tmp"
    chown root:root "$file.tmp"
    chmod 0600 "$file.tmp"
    mv -f "$file.tmp" "$file"
}
write_env "$ETC/web.env" "DATABASE_URL=postgresql://$WEB:$WEB_PW@$HOST:$PORT/$DB"
write_env "$ETC/migration.env" "DATABASE_URL=postgresql://$MIGRATION:$MIGRATION_PW@$HOST:$PORT/$DB
RIVERMIND_MIGRATION_ROLE=$OWNER"
write_env "$ETC/test.env" "RIVERMIND_TEST_DATABASE_URL=postgresql://$TESTER:$TEST_PW@$HOST:$PORT/$TEST_DB"

echo "PostgreSQL $CLUSTER: $DB and $TEST_DB are ready; credentials are in $ETC"

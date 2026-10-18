#!/usr/bin/env bash
# Hermetic checks for the release scripts. No droplet, no real database, no secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

# shellcheck source=release-common.sh
. deploy/release-common.sh

redact_out=$(printf '%s\n' 'see postgresql://user:supersecret@db.example:5432/sho?sslmode=require now' | redact)
case "$redact_out" in
  *supersecret*|*db.example*) fail "redact left a connection string" ;;
  *'postgresql://[redacted]'*) ;;
  *) fail "redact did not mark the URL" ;;
esac
pass "redact hides connection strings"

assert_push_target staging /opt/sho-staging /etc/sho-staging/app.env
assert_push_target production /opt/sho /etc/sho/app.env
if assert_push_target staging /opt/sho /etc/sho/app.env >/dev/null; then
  fail "staging accepted the production paths"
fi
if assert_push_target production /opt/sho-staging /etc/sho-staging/app.env >/dev/null; then
  fail "production accepted the staging paths"
fi
pass "push targets stay on their own directories"

if grep -vE '^[[:space:]]*#' deploy/release.sh | grep -E 'npm ci|npm run build|npx next build|prisma migrate dev|prisma migrate reset'; then
  fail "release.sh must install the tarball and keep migrations forward-only"
fi
pass "release.sh does not rebuild or reverse migrations"

grep -q 'ROOT=/opt/sho-staging' deploy/push-release.sh
grep -q 'ENV_FILE=/etc/sho-staging/app.env' deploy/push-release.sh
grep -Eq '^[[:space:]]*ROOT=/opt/sho$' deploy/push-release.sh
grep -Eq '^[[:space:]]*ENV_FILE=/etc/sho/app.env$' deploy/push-release.sh
if grep -q 'systemctl' deploy/push-release.sh; then
  fail "push-release.sh must not restart services itself"
fi
pass "push-release.sh keeps staging and production paths apart"

run_env() {
  local tier="$1" expect="$2"
  shift 2
  local err out rc
  err=$(mktemp)
  set +e
  out=$(env "$@" bash deploy/write-app-env.sh "$tier" 2>"$err")
  rc=$?
  set -e
  if [ "$expect" = ok ]; then
    [ "$rc" = 0 ] || { echo "$err" >&2; fail "write-app-env $tier exited $rc"; }
  else
    [ "$rc" != 0 ] || fail "write-app-env $tier should have failed"
  fi
  if printf '%s\n%s\n' "$out" "$(cat "$err")" | grep -q 'supersecret'; then
    fail "write-app-env printed a secret"
  fi
  printf '%s' "$out" > "${err}.out"
  # Return paths via globals for the caller to grep without printing.
  ENV_OUT="${err}.out"
  ENV_ERR="$err"
}

run_env staging fail \
  DATABASE_URL='postgresql://u:supersecret@db.example:25061/sho?sslmode=require&pgbouncer=true' \
  RESEND_API_KEY='re_test'
grep -q 'PROD_DB_HOST and PROD_DB_NAME must be set' "$ENV_ERR"
pass "staging env fails closed when the production database identity is unset"

run_env production fail \
  DATABASE_URL='postgresql://u:test-only@127.0.0.1:25061/prod?sslmode=require&pgbouncer=true' \
  DIRECT_DATABASE_URL='postgresql://u:test-only@127.0.0.1:25060/prod?sslmode=require' \
  RESEND_API_KEY='re_test'
grep -q 'PROD_DB_HOST and PROD_DB_NAME must be set' "$ENV_ERR"
pass "production env fails closed when the production database identity is unset"

run_env staging fail \
  PROD_DB_HOST=prod.db.example \
  PROD_DB_NAME=prod \
  DATABASE_URL='postgresql://u:test-only@staging.db.example:25061/sho_staging?sslmode=require&pgbouncer=true&pool_timeout=10' \
  DIRECT_DATABASE_URL='postgresql://u:test-only@staging.db.example:25060/sho_staging?sslmode=require' \
  RESEND_API_KEY='re_test'
grep -q 'connection_limit=2' "$ENV_ERR"
pass "staging pool requires connection_limit=2"

run_env staging fail \
  PROD_DB_HOST=db.example \
  PROD_DB_NAME=sho \
  DATABASE_URL='postgresql://u:supersecret@db.example:25061/sho?sslmode=require&pgbouncer=true&connection_limit=2&pool_timeout=10' \
  DIRECT_DATABASE_URL='postgresql://u:test-only@db.example:25060/other?sslmode=require' \
  RESEND_API_KEY='re_test'
grep -q 'production database' "$ENV_ERR"
pass "staging pool refuses the production host and database"

run_env staging ok \
  PROD_DB_HOST=prod.db.example \
  PROD_DB_NAME=prod \
  DATABASE_URL='postgresql://u:test-only@staging.db.example:25061/sho_staging?sslmode=require&pgbouncer=true&connection_limit=2&pool_timeout=10' \
  DIRECT_DATABASE_URL='postgresql://u:test-only@staging.db.example:25060/sho_staging?sslmode=require' \
  RESEND_API_KEY='re_test'
grep -q '^DIRECT_DATABASE_URL=' "$ENV_OUT"
pass "staging pool is allowed when it is not production and the limit is 2"

run_env staging ok \
  PROD_DB_HOST=prod.db.example \
  PROD_DB_NAME=prod \
  DATABASE_URL='postgresql://u:test-only@127.0.0.1:5432/staging?sslmode=require' \
  RESEND_API_KEY='re_test'
grep -q "APP_URL='https://staging.sheethappensofficer.com'" "$ENV_OUT"
grep -q '^DATABASE_URL=' "$ENV_OUT"
if grep -q 'app.sheethappensofficer.com' "$ENV_OUT"; then fail "staging env used the production host"; fi
pass "staging env points at staging"

run_env production fail \
  PROD_DB_HOST=127.0.0.1 \
  PROD_DB_NAME=prod \
  DATABASE_URL='postgresql://u:test-only@127.0.0.1:25061/prod?sslmode=require&pgbouncer=true' \
  RESEND_API_KEY='re_test'
grep -q 'DIRECT_DATABASE_URL' "$ENV_ERR"
pass "production env requires DIRECT_DATABASE_URL"

run_env production fail \
  PROD_DB_HOST=127.0.0.1 \
  PROD_DB_NAME=prod \
  DATABASE_URL='postgresql://u:test-only@127.0.0.1:25061/prod?sslmode=require&pgbouncer=true' \
  DIRECT_DATABASE_URL='postgresql://u:supersecret@127.0.0.1:25061/prod?sslmode=require&pgbouncer=true' \
  RESEND_API_KEY='re_test'
grep -q 'direct connection' "$ENV_ERR"
pass "production env rejects a direct URL aimed at the pool"

run_env production ok \
  PROD_DB_HOST=127.0.0.1 \
  PROD_DB_NAME=prod \
  DATABASE_URL='postgresql://u:test-only@127.0.0.1:25061/prod?sslmode=require&pgbouncer=true' \
  DIRECT_DATABASE_URL='postgresql://u:test-only@127.0.0.1:25060/prod?sslmode=require' \
  RESEND_API_KEY='re_test'
grep -q "APP_URL='https://app.sheethappensofficer.com'" "$ENV_OUT"
grep -q '^DIRECT_DATABASE_URL=' "$ENV_OUT"
if grep -q 'staging.sheethappensofficer.com' "$ENV_OUT"; then fail "production env used the staging host"; fi
pass "production env keeps the pool URL and the direct URL"

run_env staging fail \
  DATABASE_URL="postgresql://u:test-only@127.0.0.1:5432/db?sslmode=require'" \
  RESEND_API_KEY='re_test'
grep -q 'quote' "$ENV_ERR"
pass "env writer rejects a quote"

dump_err=$(DIRECT_DATABASE_URL='postgresql://u:supersecret@db.example:25061/sho?pgbouncer=true' \
  node deploy/pg-dump.mjs /tmp/sho-dump-should-not-exist 2>&1 || true)
case "$dump_err" in
  *supersecret*|*db.example*) fail "pg-dump printed a connection string" ;;
  *refusing*) ;;
  *) fail "pg-dump did not refuse the pool: $dump_err" ;;
esac
pass "pg-dump refuses the pool without printing the URL"

fix=$(mktemp)
cat > "$fix" <<'JSON'
{"protection_rules":[{"type":"required_reviewers","prevent_self_review":true,"reviewers":[{"type":"User","reviewer":{"login":"nakul175"}}]}]}
JSON
bash deploy/check-production-environment.sh --fixture "$fix" >/dev/null
for bad in \
  '{"protection_rules":[]}' \
  '{"protection_rules":[{"type":"required_reviewers","prevent_self_review":false,"reviewers":[{"type":"User","reviewer":{"login":"nakul175"}}]}]}' \
  '{"protection_rules":[{"type":"required_reviewers","prevent_self_review":true,"reviewers":[{"type":"User","reviewer":{"login":"someone-else"}}]}]}'
do
  printf '%s' "$bad" > "$fix"
  if bash deploy/check-production-environment.sh --fixture "$fix" >/dev/null 2>&1; then
    fail "environment check accepted $bad"
  fi
done
pass "production environment check requires nakul175 and prevent self-review"

# --- release.sh harness -------------------------------------------------------

new_tree() {
  WORK=$(mktemp -d /tmp/sho-rel.XXXXXX)
  SRC="$WORK/tree"
  mkdir -p "$SRC/.next" "$SRC/node_modules/next" "$SRC/prisma" "$SRC/src/generated/prisma" "$SRC/deploy"
  echo '{}' > "$SRC/package.json"
  echo '{}' > "$SRC/node_modules/next/package.json"
  echo 'datasource db { provider = "postgresql" }' > "$SRC/prisma/schema.prisma"
  mkdir -p "$SRC/prisma/migrations/20261018000000_harness"
  printf '%s\n' '-- expand-only' 'select 1;' > "$SRC/prisma/migrations/20261018000000_harness/migration.sql"
  echo 'export {}' > "$SRC/src/generated/prisma/client.ts"
  echo engine > "$SRC/src/generated/prisma/libquery_engine-test.node"
  echo '#!/bin/bash' > "$SRC/deploy/job.sh"
  TAR="$WORK/release.tar.gz"
  pack_tar
  SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  STUB="$WORK/bin"
  mkdir -p "$STUB"
  HARNESS_LOG="$WORK/log"
  : > "$HARNESS_LOG"
  MIGRATE_STATUS_FILE="$WORK/status.txt"
  printf '%s\n' 'Database schema is up to date!' > "$MIGRATE_STATUS_FILE"
  cat > "$STUB/sudo" <<'EOF'
#!/bin/bash
printf 'sudo %s\n' "$*" >> "$HARNESS_LOG"
if [ "${SUDO_FAIL:-}" = 1 ]; then exit 1; fi
exit 0
EOF
  cat > "$STUB/curl" <<'EOF'
#!/bin/bash
url="${*: -1}"
case "$url" in
  */api/health)
    [ "${HEALTH_FAIL:-}" = 1 ] && exit 1
    exit 0
    ;;
  */api/version)
    printf '{"sha":"%s","digest":"%s"}\n' "$EXPECT_SHA" "$EXPECT_DIGEST"
    exit 0
    ;;
esac
exit 1
EOF
  cat > "$STUB/npx" <<'EOF'
#!/bin/bash
printf 'npx %s\n' "$*" >> "$HARNESS_LOG"
if [ "$1" = prisma ] && [ "$2" = migrate ] && [ "$3" = status ]; then
  cat "$MIGRATE_STATUS_FILE"
  exit "${MIGRATE_STATUS_RC:-0}"
fi
if [ "$1" = prisma ] && [ "$2" = migrate ] && [ "$3" = deploy ]; then
  exit "${MIGRATE_DEPLOY_RC:-0}"
fi
echo "unexpected npx: $*" >&2
exit 1
EOF
  cat > "$STUB/pg_dump" <<'EOF'
#!/bin/bash
echo pg_dump >> "$HARNESS_LOG"
if [ "${PG_DUMP_FAIL:-}" = 1 ]; then exit 1; fi
file=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--file" ]; then file=$a; fi
  prev=$a
done
if [ "${PG_DUMP_EMPTY:-}" = 1 ]; then : > "$file"; exit 0; fi
printf 'PGDMP' > "$file"
exit 0
EOF
  cat > "$STUB/pg_restore" <<'EOF'
#!/bin/bash
echo pg_restore >> "$HARNESS_LOG"
if [ "${PG_RESTORE_FAIL:-}" = 1 ]; then exit 1; fi
if [ "${PG_RESTORE_EMPTY:-}" = 1 ]; then exit 0; fi
echo "TOC"
exit 0
EOF
  cat > "$STUB/df" <<'EOF'
#!/bin/bash
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
if [ "${DF_LOW:-}" = 1 ]; then
  echo "tmpfs 100 90 100 90% /"
else
  echo "tmpfs 900000000 1000 800000000 1% /"
fi
exit 0
EOF
  chmod 755 "$STUB/sudo" "$STUB/curl" "$STUB/npx" "$STUB/pg_dump" "$STUB/pg_restore" "$STUB/df"
}

pack_tar() {
  tar -C "$SRC" -czf "$TAR" .
  DIGEST=$(sha256sum "$TAR" | awk '{print $1}')
  printf '%s\n' "$DIGEST" > "$TAR.sha256"
}

set_pending() {
  printf '%s\n' 'Following migration have not yet been applied:' '20261018000000_harness' > "$MIGRATE_STATUS_FILE"
}

write_env() {
  local tier="$1"
  local root="$WORK/root"
  if [ "$tier" = staging ]; then
    mkdir -p "$root/etc/sho-staging"
    cat > "$root/etc/sho-staging/app.env" <<'EOF'
DATABASE_URL='postgresql://u:test-only@127.0.0.1:5432/staging?sslmode=require'
EOF
    printf '%s\n' "JOB_SECRET='ci-only-not-a-real-secret-0123'" > "$root/etc/sho-staging/local.env"
  else
    mkdir -p "$root/etc/sho"
    cat > "$root/etc/sho/app.env" <<'EOF'
DATABASE_URL='postgresql://u:test-only@127.0.0.1:25061/prod?sslmode=require&pgbouncer=true'
DIRECT_DATABASE_URL='postgresql://u:test-only@127.0.0.1:25060/prod?sslmode=require'
EOF
    printf '%s\n' "JOB_SECRET='ci-only-not-a-real-secret-0123'" > "$root/etc/sho/local.env"
  fi
}

run_rel() {
  local tier="$1"
  shift
  # Harness app.env uses 127.0.0.1. Production's database name is prod; staging's is staging.
  env -u DATABASE_URL -u DIRECT_DATABASE_URL \
    PATH="$STUB:$PATH" \
    SHO_TIER="$tier" \
    SHO_PREFIX="$WORK/root" \
    HARNESS_LOG="$HARNESS_LOG" \
    MIGRATE_STATUS_FILE="$MIGRATE_STATUS_FILE" \
    EXPECT_SHA="$SHA" \
    EXPECT_DIGEST="$DIGEST" \
    PROD_DB_HOST=127.0.0.1 \
    PROD_DB_NAME=prod \
    "$@" \
    bash deploy/release.sh --harness "$SHA" "$TAR" "$DIGEST"
}

new_tree
write_env staging
BAD=${DIGEST:0:63}0
if [ "$BAD" = "$DIGEST" ]; then BAD=${DIGEST:0:63}1; fi
set +e
env PATH="$STUB:$PATH" SHO_TIER=staging SHO_PREFIX="$WORK/root" \
  bash deploy/release.sh --harness "$SHA" "$TAR" "$BAD" >"$WORK/out" 2>&1
rc=$?
set -e
[ "$rc" != 0 ] || fail "digest mismatch was accepted"
[ ! -d "$WORK/root/opt/sho-staging/releases/$SHA" ] || fail "digest mismatch extracted a release"
pass "digest mismatch does not install"

new_tree
write_env staging
printf '%s\n' 'postgresql://u:test-only@127.0.0.1:5432/staging was here' 'Database schema is up to date!' > "$MIGRATE_STATUS_FILE"
run_rel staging >"$WORK/out"
grep -q 'postgresql://\[redacted\]' "$WORK/out" || fail "migrate status was not redacted"
if grep -q 'test-only' "$WORK/out"; then fail "release log contained the test password"; fi
[ "$(readlink -f "$WORK/root/opt/sho-staging/current")" = "$WORK/root/opt/sho-staging/releases/$SHA" ]
grep -q 'npx prisma migrate deploy' "$HARNESS_LOG"
if grep -q '^pg_dump$' "$HARNESS_LOG"; then fail "staging called pg_dump"; fi
grep -q 'sudo systemctl restart sho-staging' "$HARNESS_LOG"
if grep -E '^sudo systemctl restart sho$' "$HARNESS_LOG"; then fail "staging restarted production"; fi
pass "staging install skips the backup and restarts sho-staging"

new_tree
write_env staging
set_pending
run_rel staging PG_DUMP_FAIL=1 >"$WORK/out"
if grep -q '^pg_dump$' "$HARNESS_LOG"; then fail "staging backed up while migrations were pending"; fi
grep -q 'npx prisma migrate deploy' "$HARNESS_LOG"
pass "staging applies migrations without a production backup"

new_tree
write_env production
set_pending
set +e
run_rel production PG_DUMP_FAIL=1 >"$WORK/out" 2>&1
rc=$?
set -e
[ "$rc" != 0 ] || fail "pg_dump failure continued"
grep -q 'pg_dump failed' "$WORK/out"
if grep -q 'npx prisma migrate deploy' "$HARNESS_LOG"; then fail "migrate ran after a failed backup"; fi
[ ! -L "$WORK/root/opt/sho/current" ] || fail "app was switched after a failed backup"
pass "production backup failure stops the migration"

new_tree
write_env production
set_pending
run_rel production >"$WORK/out"
grep -q '^pg_dump$' "$HARNESS_LOG"
grep -q 'npx prisma migrate deploy' "$HARNESS_LOG"
grep -q 'expand-only: yes' "$WORK/out"
grep -q 'restore check passed' "$WORK/out"
grep -q 'rollback target none' "$WORK/out"
backup=$(find "$WORK/root/opt/sho/backups" -type f -name '*.dump' -print -quit)
[ -n "$backup" ] && [ -s "$backup" ] || fail "backup file missing"
[ "$(readlink -f "$WORK/root/opt/sho/current")" = "$WORK/root/opt/sho/releases/$SHA" ]
grep -E '^sudo systemctl restart sho$' "$HARNESS_LOG" >/dev/null
if grep -q 'sho-staging' "$HARNESS_LOG"; then fail "production restart mentioned staging"; fi
pass "production backup runs before migrate and the app switches"

new_tree
write_env production
printf '%s\n' 'Database schema is up to date!' > "$MIGRATE_STATUS_FILE"
run_rel production >"$WORK/out"
if grep -q '^pg_dump$' "$HARNESS_LOG"; then fail "backup ran when nothing was pending"; fi
grep -q 'npx prisma migrate deploy' "$HARNESS_LOG"
pass "production skips the backup when the schema is current"

new_tree
write_env production
printf '%s\n' 'connection error while checking migrations' > "$MIGRATE_STATUS_FILE"
set +e
run_rel production MIGRATE_STATUS_RC=1 >"$WORK/out" 2>&1
rc=$?
set -e
[ "$rc" != 0 ] || fail "unknown migration status continued"
grep -q 'not recognised' "$WORK/out"
if grep -q '^pg_dump$' "$HARNESS_LOG"; then fail "backup ran on an unknown migration status"; fi
if grep -q 'npx prisma migrate deploy' "$HARNESS_LOG"; then fail "migrate ran on an unknown migration status"; fi
pass "unknown migration status fails closed"

new_tree
write_env staging
mkdir -p "$WORK/root/opt/sho-staging/releases/previous"
ln -s "$WORK/root/opt/sho-staging/releases/previous" "$WORK/root/opt/sho-staging/current"
set +e
run_rel staging HEALTH_FAIL=1 >"$WORK/out" 2>&1
rc=$?
set -e
[ "$rc" != 0 ] || fail "health failure was treated as success"
grep -q 'forward-only' "$WORK/out"
[ "$(readlink -f "$WORK/root/opt/sho-staging/current")" = "$WORK/root/opt/sho-staging/releases/previous" ]
[ "$(cat "$WORK/root/opt/sho-staging/previous-sha")" = previous ]
pass "failed health check restores the previous code only"

new_tree
write_env production
set +e
run_rel production DF_LOW=1 >"$WORK/out" 2>&1
rc=$?
set -e
[ "$rc" != 0 ] || fail "low disk was accepted"
grep -q 'not enough free disk' "$WORK/out"
[ ! -d "$WORK/root/opt/sho/releases/$SHA" ] || fail "low disk extracted a release"
pass "low disk stops the release before extract"

new_tree
write_env production
set_pending
set +e
run_rel production PG_RESTORE_FAIL=1 >"$WORK/out" 2>&1
rc=$?
set -e
[ "$rc" != 0 ] || fail "restore check failure continued"
grep -q 'restore check failed' "$WORK/out"
if grep -q 'npx prisma migrate deploy' "$HARNESS_LOG"; then fail "migrate ran after a failed restore check"; fi
pass "restore check failure stops the migration"

new_tree
write_env production
set_pending
mkdir -p "$WORK/root/opt/sho/backups"
echo old > "$WORK/root/opt/sho/backups/old.dump"
touch -d '2020-01-01' "$WORK/root/opt/sho/backups/old.dump"
run_rel production KEEP_DUMPS=1 >"$WORK/out"
[ ! -f "$WORK/root/opt/sho/backups/old.dump" ] || fail "old backup was kept"
[ "$(find "$WORK/root/opt/sho/backups" -type f -name '*.dump' | wc -l)" = 1 ]
grep -q 'removed 1 old database backup' "$WORK/out"
pass "backup retention keeps the newest dump"

new_tree
printf '%s\n' 'select 1;' > "$SRC/prisma/migrations/20261018000000_harness/migration.sql"
pack_tar
write_env production
set_pending
set +e
run_rel production >"$WORK/out" 2>&1
rc=$?
set -e
[ "$rc" != 0 ] || fail "contract migration was applied"
grep -q 'not marked expand-only' "$WORK/out"
if grep -q '^pg_dump$' "$HARNESS_LOG"; then fail "backup ran for a contract migration"; fi
: > "$HARNESS_LOG"
run_rel production SHO_ALLOW_CONTRACT_MIGRATION=1 >"$WORK/out" 2>&1
grep -q 'contract migration override' "$WORK/out"
grep -q 'npx prisma migrate deploy' "$HARNESS_LOG"
pass "contract migrations fail closed unless the override is set"

new_tree
write_env production
run_rel production >"$WORK/out"
old=cccccccccccccccccccccccccccccccccccccccc
old_dir="$WORK/root/opt/sho/releases/$old"
mkdir -p "$old_dir"
echo marker > "$old_dir/marker"
touch -d '2019-01-01' "$old_dir"
ln -sfn "$old_dir" "$WORK/root/opt/sho/previous"
printf '%s\n' "$old" > "$WORK/root/opt/sho/previous-sha"
for i in 1 2 3 4; do
  junk="$WORK/root/opt/sho/releases/junk$i"
  mkdir -p "$junk"
  echo x > "$junk/x"
  touch -d "2020-0${i}-15" "$junk"
done
run_rel production >"$WORK/out"
grep -q 'kept' "$WORK/out"
[ -L "$WORK/root/opt/sho/previous" ] || fail "same-SHA redeploy removed the previous symlink"
[ "$(readlink -f "$WORK/root/opt/sho/previous")" = "$old_dir" ] || fail "same-SHA redeploy retargeted previous"
[ "$(cat "$WORK/root/opt/sho/previous-sha")" = "$old" ]
[ -f "$old_dir/marker" ] || fail "same-SHA redeploy pruned the previous tree"
[ ! -d "$WORK/root/opt/sho/releases/junk1" ] || fail "prune did not run on the same-SHA redeploy"
[ "$(readlink -f "$WORK/root/opt/sho/current")" = "$WORK/root/opt/sho/releases/$SHA" ]
pass "same-SHA redeploy keeps the previous symlink and its tree"

new_tree
write_env production
old=dddddddddddddddddddddddddddddddddddddddd
old_dir="$WORK/root/opt/sho/releases/$old"
mkdir -p "$old_dir"
echo marker > "$old_dir/marker"
touch -d '2019-01-01' "$old_dir"
ln -s "$old_dir" "$WORK/root/opt/sho/current"
for i in 1 2 3 4; do
  junk="$WORK/root/opt/sho/releases/junk$i"
  mkdir -p "$junk"
  echo x > "$junk/x"
  touch -d "2020-0${i}-15" "$junk"
done
run_rel production >"$WORK/out"
grep -q 'because it is the rollback target' "$WORK/out"
[ "$(readlink -f "$WORK/root/opt/sho/previous")" = "$old_dir" ]
[ -f "$old_dir/marker" ] || fail "prune deleted the tree previous points at"
[ ! -d "$WORK/root/opt/sho/releases/junk1" ] || fail "prune did not delete an unreferenced old tree"
pass "prune keeps the tree the previous symlink points at"

# --- rollback ----------------------------------------------------------------

new_tree
write_env production
mkdir -p "$WORK/root/opt/sho/releases/$SHA"
printf 'RELEASE=%s\nARTIFACT_SHA256=%s\n' "$SHA" "$DIGEST" > "$WORK/root/opt/sho/releases/$SHA/release.env"
ln -s "$WORK/root/opt/sho/releases/$SHA" "$WORK/root/opt/sho/previous"
env PATH="$STUB:$PATH" SHO_TIER=production SHO_PREFIX="$WORK/root" \
  HARNESS_LOG="$HARNESS_LOG" EXPECT_SHA="$SHA" EXPECT_DIGEST="$DIGEST" \
  bash deploy/rollback.sh --harness >"$WORK/out"
grep -q 'no migration' "$WORK/out"
grep -q "rolled back to $SHA" "$WORK/out"
[ "$(readlink -f "$WORK/root/opt/sho/current")" = "$WORK/root/opt/sho/releases/$SHA" ]
if grep -q 'npx prisma' "$HARNESS_LOG"; then fail "rollback ran a migration"; fi
pass "rollback switches the symlink and does not migrate"

if env PATH="$STUB:$PATH" SHO_TIER=production SHO_PREFIX="$WORK/root" \
  bash deploy/rollback.sh --harness /tmp/not-a-release >"$WORK/out" 2>&1; then
  fail "rollback accepted a directory outside /opt/sho/releases"
fi
pass "rollback rejects a directory outside the release tree"

live=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
live_dir="$WORK/root/opt/sho/releases/$live"
mkdir -p "$live_dir"
echo '{}' > "$live_dir/package.json"
ln -sfn "$live_dir" "$WORK/root/opt/sho/previous"
env PATH="$STUB:$PATH" SHO_TIER=production SHO_PREFIX="$WORK/root" \
  HARNESS_LOG="$HARNESS_LOG" EXPECT_SHA=wrong EXPECT_DIGEST=wrong \
  bash deploy/rollback.sh --harness >"$WORK/out"
grep -q 'has no release.env; checking health only' "$WORK/out"
grep -q "rolled back to $live" "$WORK/out"
[ "$(readlink -f "$WORK/root/opt/sho/current")" = "$live_dir" ]
if grep -q 'npx prisma' "$HARNESS_LOG"; then fail "rollback of a live tree ran a migration"; fi
pass "rollback of today's live tree checks health and does not need release.env"

empty=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
mkdir -p "$WORK/root/opt/sho/releases/$empty"
ln -sfn "$WORK/root/opt/sho/releases/$empty" "$WORK/root/opt/sho/previous"
if env PATH="$STUB:$PATH" SHO_TIER=production SHO_PREFIX="$WORK/root" \
  bash deploy/rollback.sh --harness >"$WORK/out" 2>&1; then
  fail "rollback accepted a directory that is not an app tree"
fi
grep -q 'not an app tree' "$WORK/out"
pass "rollback rejects a previous tree that is not an app"

# --- host guard --------------------------------------------------------------

run_guard() {
  local assignments=()
  while [ $# -gt 0 ] && [[ "$1" == *=* ]]; do
    assignments+=("$1")
    shift
  done
  env -u PROD_DB_HOST -u PROD_DB_NAME -u DATABASE_URL -u DIRECT_DATABASE_URL -u ZZ_PREFIX -u APP_URL -u BASE_URL \
    PROD_DB_HOST=prod.example PROD_DB_NAME=prod \
    "${assignments[@]}" node deploy/prod-host-guard.mjs "$@"
}
if run_guard TASKBOARD_URL=https://app.sheethappensofficer.com --grep @write >"$WORK/out" 2>&1; then
  fail "@write was allowed against production"
fi
grep -q 'refusing' "$WORK/out"
if grep -q 'postgresql://' "$WORK/out"; then fail "host guard printed a connection string"; fi
pass "@write against the production host exits non-zero"

run_guard TASKBOARD_URL=https://app.sheethappensofficer.com --grep @readonly --grep-invert @write
if run_guard TASKBOARD_URL=https://app.sheethappensofficer.com --grep @prod-safe --grep-invert @write >"$WORK/out" 2>&1; then
  fail "@prod-safe was treated as the read-only smoke"
fi
if run_guard TASKBOARD_URL=https://app.sheethappensofficer.com --grep '@readonly|' --grep-invert @write >"$WORK/out" 2>&1; then
  fail "a grep regex was treated as the read-only smoke"
fi
if run_guard TASKBOARD_URL=https://app.sheethappensofficer.com --grep @readonly --grep-invert @writeXXX >"$WORK/out" 2>&1; then
  fail "a grep-invert substring was treated as the read-only smoke"
fi
run_guard TASKBOARD_URL=http://localhost:3100 --grep @write
if run_guard TASKBOARD_URL=https://app.sheethappensofficer.com ZZ_PREFIX=ZZ-TEST-01 --seed --grep @readonly --grep-invert @write >"$WORK/out" 2>&1; then
  fail "ZZ-TEST seeding was allowed against production"
fi
grep -q 'ZZ-TEST' "$WORK/out"
if PROD_DB_HOST=db.example PROD_DB_NAME=prod \
  DATABASE_URL='postgresql://u:supersecret@db.example:25061/prod?sslmode=require&pgbouncer=true' \
  node deploy/prod-host-guard.mjs --grep @write >"$WORK/out" 2>&1; then
  fail "@write was allowed against the production database"
fi
if grep -q 'supersecret' "$WORK/out"; then fail "host guard printed a password"; fi
if env -u PROD_DB_HOST -u PROD_DB_NAME TASKBOARD_URL=http://localhost:3100 \
  node deploy/prod-host-guard.mjs --grep @readonly --grep-invert @write >"$WORK/out" 2>&1; then
  fail "host guard ran without the production database identity"
fi
grep -q 'PROD_DB_HOST and PROD_DB_NAME must be set' "$WORK/out"
pass "read-only smoke is exact, ZZ-TEST seeding is refused, and an unset identity fails closed"

# --- qa gate, window, ruleset, ssh ------------------------------------------

digest=$(printf 'a%.0s' {1..64})
other=$(printf 'b%.0s' {1..64})
# shellcheck source=qa-gate.sh
. deploy/qa-gate.sh
export QA_GATE_LOGIN=pam
qa_gate_decide rel-2026.10.18.1 tag yes "$digest" "$digest" success "READY $digest" pam >/dev/null
qa_gate_decide rel-2026.10.18.2 tag yes "$digest" "$digest" success "WITH_EXCEPTION $digest" pam >/dev/null
if qa_gate_decide rel-test-1 tag yes "$digest" "$digest" success "READY $digest" pam >/dev/null 2>&1; then
  fail "qa gate accepted a rehearsal tag"
fi
if qa_gate_decide rel-2026.10.18.1 commit yes "$digest" "$digest" success "READY $digest" pam >/dev/null 2>&1; then
  fail "qa gate accepted a lightweight tag"
fi
if qa_gate_decide rel-2026.10.18.1 tag no "$digest" "$digest" success "READY $digest" pam >/dev/null 2>&1; then
  fail "qa gate accepted a commit that is not on main"
fi
if qa_gate_decide rel-2026.10.18.1 tag yes "$digest" "$other" success "READY $digest" pam >/dev/null 2>&1; then
  fail "qa gate accepted a digest staging did not report"
fi
if qa_gate_decide rel-2026.10.18.1 tag yes "$digest" "$digest" success "READY $other" pam >/dev/null 2>&1; then
  fail "qa gate accepted a QA record for a different digest"
fi
unset QA_GATE_LOGIN
if qa_gate_decide rel-2026.10.18.1 tag yes "$digest" "$digest" success "READY $digest" pam >"$WORK/out" 2>&1; then
  fail "qa gate ran without QA_GATE_LOGIN"
fi
grep -q 'QA_GATE_LOGIN is unset' "$WORK/out"
export QA_GATE_LOGIN='github-actions[bot]'
if qa_gate_decide rel-2026.10.18.1 tag yes "$digest" "$digest" success "READY $digest" 'github-actions[bot]' >"$WORK/out" 2>&1; then
  fail "qa gate accepted a bot as the QA identity"
fi
grep -q 'must be a person' "$WORK/out"
export QA_GATE_LOGIN=pam
if qa_gate_decide rel-2026.10.18.1 tag yes "$digest" "$digest" success "READY $digest" 'github-actions[bot]' >"$WORK/out" 2>&1; then
  fail "qa gate accepted a status created by a bot"
fi
grep -q 'QA identity' "$WORK/out"
if qa_gate_decide rel-2026.10.18.1 tag yes "$digest" "$digest" success "READY $digest" someone-else >"$WORK/out" 2>&1; then
  fail "qa gate accepted a status created by a different person"
fi
grep -q 'was not set by the QA identity' "$WORK/out"
pass "qa gate matches the tag, the ancestor, the digest, and the QA identity"

window_out=$(mktemp)
window_at() {
  : > "$window_out"
  env GITHUB_OUTPUT="$window_out" GITHUB_EVENT_NAME="$1" GITHUB_REF="$2" SHO_NOW_IST="$3" bash deploy/staging-window.sh >/dev/null
  tr -d '[:space:]' < "$window_out"
}
[ "$(window_at push refs/heads/main 16:00)" = "skip=true" ]
[ "$(window_at push refs/heads/main 18:29)" = "skip=true" ]
[ "$(window_at push refs/heads/main 15:59)" = "skip=false" ]
[ "$(window_at push refs/heads/main 18:30)" = "skip=false" ]
[ "$(window_at push refs/tags/rc-2026.10.18.1 17:00)" = "skip=false" ]
[ "$(window_at workflow_dispatch refs/heads/main 17:00)" = "skip=false" ]
pass "automatic staging deploys are held from 16:00 to 18:30 IST"

rules=$(mktemp)
cat > "$rules" <<'JSON'
{"rulesets":[{"name":"Protect rel tags","target":"tag","enforcement":"active","conditions":{"ref_name":{"include":["refs/tags/rel-*"],"exclude":[]}},"rules":[{"type":"creation"}],"bypass_actors":[{"actor_type":"Team"}]}]}
JSON
bash deploy/check-tag-ruleset.sh --fixture "$rules" >/dev/null
printf '%s' '{"rulesets":[]}' > "$rules"
if bash deploy/check-tag-ruleset.sh --fixture "$rules" >/dev/null 2>&1; then
  fail "missing tag ruleset was accepted"
fi
pass "rel-* tag creation requires a ruleset"

home=$(mktemp -d)
scan=$(mktemp -d)
cat > "$scan/ssh-keyscan" <<'EOF'
#!/bin/bash
echo scanned > "$HOME/scanned"
echo "example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly"
EOF
chmod 755 "$scan/ssh-keyscan"
if env HOME="$home" PATH="$scan:$PATH" SHO_TIER=production HOST=example.com SSH_PRIVATE_KEY='not-a-real-key' \
  bash deploy/ci-ssh.sh >"$WORK/out" 2>&1; then
  fail "production ssh trusted an unpinned host key"
fi
grep -q 'DROPLET_HOST_KEY' "$WORK/out"
[ ! -f "$home/scanned" ] || fail "production ssh scanned the host key"
rm -rf "$home"
home=$(mktemp -d)
env HOME="$home" PATH="$scan:$PATH" SHO_TIER=staging HOST=example.com SSH_PRIVATE_KEY='not-a-real-key' \
  bash deploy/ci-ssh.sh >"$WORK/out" 2>&1
[ -f "$home/scanned" ] || fail "staging did not keep the first-use warning path"
pass "production ssh fails closed without DROPLET_HOST_KEY"

sha40=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
cat > "$rules" <<JSON
{"sha":"$sha40","artifacts":[
  {"id":9,"name":"release-$sha40","expired":false,"created_at":"2026-10-18T02:00:00Z","workflow_run":{"head_sha":"$sha40","path":".github/workflows/other.yml"}},
  {"id":4,"name":"release-$sha40","expired":false,"created_at":"2026-10-18T01:00:00Z","workflow_run":{"head_sha":"$sha40","path":".github/workflows/ship.yml"}},
  {"id":3,"name":"release-$sha40","expired":false,"created_at":"2026-10-18T00:00:00Z","workflow_run":{"head_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","path":".github/workflows/ship.yml"}}
]}
JSON
chosen=$(node deploy/select-artifact.mjs < "$rules")
[ "$chosen" = 4 ] || fail "artifact selector chose $chosen"
pass "canonical artifact is the oldest one built by ship.yml for this commit"

if grep -n 'secrets: inherit' .github/workflows/*.yml; then
  fail "a workflow still inherits every secret"
fi
if grep -n 'push-release\|ci-ssh\|SSH_PRIVATE_KEY' .github/workflows/rehearse.yml; then
  fail "the rehearsal workflow can deploy"
fi
grep -q '!rel-test-\*' .github/workflows/release.yml
grep -q 'rel-test-' .github/workflows/ship.yml
grep -q 'actions: read' .github/workflows/ship.yml
deploy_job=$(awk '/^  deploy-staging:/{f=1} /^  record-staging-digest:/{f=0} f' .github/workflows/ship.yml)
case "$deploy_job" in
  *statuses:*) fail "the staging deploy job can still write commit statuses" ;;
esac
digest_job=$(awk '/^  record-staging-digest:/{f=1} /^  qa-gate:/{f=0} f' .github/workflows/ship.yml)
case "$digest_job" in
  *"statuses: write"*) ;;
  *) fail "the digest job cannot post the staging digest" ;;
esac
grep -q "context='staging/digest'" deploy/record-staging-digest.sh
if grep -q 'qa/gate' deploy/record-staging-digest.sh; then
  fail "the digest script can name the QA status"
fi
if grep -q 'vars.ALLOW_CONTRACT_MIGRATION' .github/workflows/ship.yml .github/workflows/release.yml; then
  fail "ALLOW_CONTRACT_MIGRATION is still a repository variable"
fi
grep -q 'allow_contract_migration' .github/workflows/release.yml
pass "workflows keep rehearsals, secrets, statuses and the contract override apart"

rm -rf /tmp/sho-rel.*
echo "all release checks passed"

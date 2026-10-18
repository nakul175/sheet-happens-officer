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
grep -q 'PgBouncer' "$ENV_ERR"
pass "staging env rejects the production pool"

run_env staging ok \
  DATABASE_URL='postgresql://u:test-only@127.0.0.1:5432/staging?sslmode=require' \
  RESEND_API_KEY='re_test'
grep -q "APP_URL='https://staging.sheethappensofficer.com'" "$ENV_OUT"
grep -q '^DATABASE_URL=' "$ENV_OUT"
if grep -q 'app.sheethappensofficer.com' "$ENV_OUT"; then fail "staging env used the production host"; fi
pass "staging env points at staging"

run_env production fail \
  DATABASE_URL='postgresql://u:test-only@127.0.0.1:25061/prod?sslmode=require&pgbouncer=true' \
  RESEND_API_KEY='re_test'
grep -q 'DIRECT_DATABASE_URL' "$ENV_ERR"
pass "production env requires DIRECT_DATABASE_URL"

run_env production fail \
  DATABASE_URL='postgresql://u:test-only@127.0.0.1:25061/prod?sslmode=require&pgbouncer=true' \
  DIRECT_DATABASE_URL='postgresql://u:supersecret@127.0.0.1:25061/prod?sslmode=require&pgbouncer=true' \
  RESEND_API_KEY='re_test'
grep -q 'direct connection' "$ENV_ERR"
pass "production env rejects a direct URL aimed at the pool"

run_env production ok \
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
  echo 'export {}' > "$SRC/src/generated/prisma/client.ts"
  echo engine > "$SRC/src/generated/prisma/libquery_engine-test.node"
  echo '#!/bin/bash' > "$SRC/deploy/job.sh"
  TAR="$WORK/release.tar.gz"
  tar -C "$SRC" -czf "$TAR" .
  DIGEST=$(sha256sum "$TAR" | awk '{print $1}')
  printf '%s\n' "$DIGEST" > "$TAR.sha256"
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
  chmod 755 "$STUB/sudo" "$STUB/curl" "$STUB/npx" "$STUB/pg_dump"
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
  env -u DATABASE_URL -u DIRECT_DATABASE_URL \
    PATH="$STUB:$PATH" \
    SHO_TIER="$tier" \
    SHO_PREFIX="$WORK/root" \
    HARNESS_LOG="$HARNESS_LOG" \
    MIGRATE_STATUS_FILE="$MIGRATE_STATUS_FILE" \
    EXPECT_SHA="$SHA" \
    EXPECT_DIGEST="$DIGEST" \
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
printf '%s\n' 'Following migration have not yet been applied:' > "$MIGRATE_STATUS_FILE"
run_rel staging PG_DUMP_FAIL=1 >"$WORK/out"
if grep -q '^pg_dump$' "$HARNESS_LOG"; then fail "staging backed up while migrations were pending"; fi
grep -q 'npx prisma migrate deploy' "$HARNESS_LOG"
pass "staging applies migrations without a production backup"

new_tree
write_env production
printf '%s\n' 'Following migration have not yet been applied:' > "$MIGRATE_STATUS_FILE"
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
printf '%s\n' 'Following migration have not yet been applied:' > "$MIGRATE_STATUS_FILE"
run_rel production >"$WORK/out"
grep -q '^pg_dump$' "$HARNESS_LOG"
grep -q 'npx prisma migrate deploy' "$HARNESS_LOG"
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
pass "failed health check restores the previous code only"

rm -rf /tmp/sho-rel.*
echo "all release checks passed"

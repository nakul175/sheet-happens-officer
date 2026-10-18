#!/usr/bin/env bash
# Installs one prebuilt release tarball and switches the app to it.
# CI builds the tarball once per commit. This script does not run npm ci or next build.
# Migrations are forward-only: a failed health check puts the previous code back and leaves the schema.
# Usage: release.sh <sha> <tarball> <digest>
#   SHO_TIER=staging|production is required. Paths and the service come from the tier, not from other variables.
#   --harness is for deploy/test-release.sh only. The workflows never pass it.
set -euo pipefail

HARNESS=0
if [ "${1:-}" = --harness ]; then
  HARNESS=1
  shift
fi

SHA="${1:?release sha}"
TARBALL="${2:?tarball}"
DIGEST="${3:?digest}"
SHO_TIER="${SHO_TIER:?SHO_TIER is required}"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=release-common.sh
. "$SCRIPT_DIR/release-common.sh"

assert_sha "$SHA"
assert_digest "$DIGEST"

# A caller cannot redirect staging at production by exporting a path. The tier picks the path.
unset SHO_ROOT SHO_PORT SHO_SERVICE SHO_ENV_DIR || true
case "$SHO_TIER" in
  staging)
    ROOT=/opt/sho-staging
    PORT=3001
    SERVICE=sho-staging
    ENV_DIR=/etc/sho-staging
    ;;
  production)
    ROOT=/opt/sho
    PORT=3000
    SERVICE=sho
    ENV_DIR=/etc/sho
    ;;
  *)
    echo "unknown tier"
    exit 1
    ;;
esac

if [ "$HARNESS" = 1 ]; then
  case "${SHO_PREFIX:?SHO_PREFIX is required with --harness}" in
    /tmp/*|/var/tmp/*) ;;
    *) echo "harness prefix must be under /tmp"; exit 1 ;;
  esac
  case "$SHO_PREFIX" in
    *..*) echo "harness prefix must not contain .."; exit 1 ;;
  esac
  ROOT="${SHO_PREFIX}${ROOT}"
  ENV_DIR="${SHO_PREFIX}${ENV_DIR}"
elif [ -n "${SHO_PREFIX:-}" ]; then
  echo "SHO_PREFIX is only available to the test harness"
  exit 1
fi

REL="$ROOT/releases/$SHA"
CUR="$ROOT/current"
KEEP=3

log() { printf '[release %s %s] %s\n' "$SHO_TIER" "$(date +%H:%M:%S)" "$*"; }

if [ "$HARNESS" = 1 ]; then
  HEALTH_TRIES=1
  HEALTH_SLEEP=0
else
  HEALTH_TRIES=45
  HEALTH_SLEEP=2
fi

case "$SERVICE" in
  sho-staging) [ "$SHO_TIER" = staging ] || exit 1 ;;
  sho) [ "$SHO_TIER" = production ] || exit 1 ;;
  *) echo "unexpected service"; exit 1 ;;
esac
case "$PORT" in
  3000|3001) ;;
  *) echo "unexpected port"; exit 1 ;;
esac

healthy() {
  local _
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    if curl -fsS -m 5 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then return 0; fi
    [ "$HEALTH_SLEEP" = 0 ] || sleep "$HEALTH_SLEEP"
  done
  return 1
}

# /api/version must report this commit and this tarball. A unit that does not load release.env fails here.
version_ok() {
  local body
  body=$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/api/version" 2>/dev/null) || return 1
  VERSION_BODY="$body" EXPECT_SHA="$SHA" EXPECT_DIGEST="$DIGEST" node -e '
    let j;
    try { j = JSON.parse(process.env.VERSION_BODY); } catch { process.exit(1); }
    if (j.sha !== process.env.EXPECT_SHA || j.digest !== process.env.EXPECT_DIGEST) {
      const shown = JSON.stringify(j).replace(/postgres(ql)?:\/\/\S+/gi, "postgres://[redacted]");
      console.error("running /api/version does not match this release");
      console.error(shown);
      console.error("If sha is null, the service is not loading release.env from its working directory.");
      process.exit(1);
    }
  '
}

switch() { ln -sfn "$1" "$CUR.new" && mv -T "$CUR.new" "$CUR"; }

rollback() {
  log "rolling back the code only (migrations are forward-only and were not reverted)"
  sudo journalctl -u "$SERVICE" -n 80 --no-pager || true
  if [ -n "${PREV:-}" ] && [ -d "$PREV" ] && [ "$PREV" != "$REL" ]; then
    switch "$PREV"
    sudo systemctl restart "$SERVICE" || true
    if healthy; then log "rolled back to $(basename "$PREV")"; else log "the previous release did not come up either"; fi
  else
    log "no previous release to roll back to"
  fi
}

free_kb() {
  df -Pk "$1" | awk 'NR==2 {print $4}'
}

require_disk() {
  local avail min
  avail=$(free_kb "$1") || { echo "could not check free disk"; exit 1; }
  case "$avail" in
    ''|*[!0-9]*) echo "could not read free disk"; exit 1 ;;
  esac
  min=${SHO_MIN_FREE_KB:-2097152}
  if [ "$avail" -lt "$min" ]; then
    echo "not enough free disk (${avail} KiB free, need ${min} KiB)"
    exit 1
  fi
}

[ -f "$TARBALL" ] || { echo "No release tarball at $TARBALL"; exit 1; }
actual=$(sha256sum "$TARBALL" | awk '{print $1}')
[ "$actual" = "$DIGEST" ] || { echo "release tarball digest does not match"; exit 1; }
if [ -f "${TARBALL}.sha256" ]; then
  side=$(tr -d '[:space:]' < "${TARBALL}.sha256")
  [ "$side" = "$DIGEST" ] || { echo "digest sidecar does not match"; exit 1; }
fi

mkdir -p "$ROOT/releases" "$ROOT/bin"
require_disk "$ROOT"
[ -f "$ENV_DIR/app.env" ] || { echo "$ENV_DIR/app.env is missing"; exit 1; }
[ -f "$ENV_DIR/local.env" ] || { echo "$ENV_DIR/local.env is missing (JOB_SECRET stays on the droplet)"; exit 1; }

log "extracting $SHA"
tmp=$(mktemp -d "$ROOT/releases/.partial.XXXXXX")
if ! tar -xzf "$TARBALL" -C "$tmp"; then
  rm -rf "$tmp"
  echo "could not extract the release tarball"
  exit 1
fi
fail_extract() {
  rm -rf "$tmp"
  echo "$*"
  exit 1
}
[ -f "$tmp/package.json" ] || fail_extract "tarball has no package.json"
[ -d "$tmp/.next" ] || fail_extract "tarball has no .next build"
[ -d "$tmp/node_modules/next" ] || fail_extract "tarball has no next runtime"
[ -f "$tmp/prisma/schema.prisma" ] || fail_extract "tarball has no Prisma schema"
[ -f "$tmp/src/generated/prisma/client.ts" ] || fail_extract "tarball has no Prisma client"
find "$tmp/src/generated/prisma" -name 'libquery_engine*.node' -print -quit | grep -q . \
  || fail_extract "tarball has no Prisma engine"
rm -rf "$REL"
mv "$tmp" "$REL"
tmp=

set -a
# shellcheck disable=SC1091
. "$ENV_DIR/app.env"
# shellcheck disable=SC1091
. "$ENV_DIR/local.env"
set +a

app_facts=$(db_facts "$DATABASE_URL") || { echo "DATABASE_URL could not be read"; exit 1; }
if [ "$SHO_TIER" = production ] || [ "$(json_get "$app_facts" pool)" = true ]; then
  [ -n "${DIRECT_DATABASE_URL:-}" ] || { echo "DIRECT_DATABASE_URL is required for migrations through PgBouncer"; exit 1; }
else
  export DIRECT_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}"
fi
assert_database_urls "$SHO_TIER"
export NODE_ENV=production
direct_facts=$(db_facts "$DIRECT_DATABASE_URL") || { echo "DIRECT_DATABASE_URL could not be read"; exit 1; }
log "migration connection port $(json_get "$direct_facts" port)"

cd "$REL"
status_file=$(mktemp)
set +e
npx prisma migrate status >"$status_file" 2>&1
status_rc=$?
set -e
redact < "$status_file"
pending=0
if grep -q "Database schema is up to date" "$status_file"; then
  pending=0
elif grep -Eq "not yet been applied|have failed" "$status_file"; then
  pending=1
else
  rm -f "$status_file"
  echo "refusing to continue: migration status was not recognised (exit $status_rc)"
  exit 1
fi

if [ "$pending" = 1 ] && [ "$SHO_TIER" = production ]; then
  [ -f "$SCRIPT_DIR/expand-only.mjs" ] || { echo "expand-only.mjs is missing; refusing to migrate production"; exit 1; }
  set +e
  node "$SCRIPT_DIR/expand-only.mjs" "$status_file" "$REL/prisma/migrations"
  expand_rc=$?
  set -e
  if [ "$expand_rc" = 4 ]; then
    echo "refusing to migrate production: the pending migrations could not be named"
    exit 1
  fi
  if [ "$expand_rc" != 0 ] && [ "${SHO_ALLOW_CONTRACT_MIGRATION:-}" != 1 ]; then
    echo "refusing to migrate production: a pending migration is not marked expand-only"
    exit 1
  fi
  if [ "$expand_rc" != 0 ]; then
    log "contract migration override is set; continuing"
  fi
  rm -f "$status_file"
  command -v pg_dump >/dev/null || { echo "pg_dump is not installed; refusing to migrate production"; exit 1; }
  command -v pg_restore >/dev/null || { echo "pg_restore is not installed; refusing to migrate production"; exit 1; }
  [ -f "$SCRIPT_DIR/pg-dump.mjs" ] || { echo "pg-dump.mjs is missing; refusing to migrate production"; exit 1; }
  require_disk "$ROOT"
  mkdir -p "$ROOT/backups"
  chmod 700 "$ROOT/backups"
  backup="$ROOT/backups/${SHA}-$(date -u +%Y%m%dT%H%M%SZ).dump"
  log "backing up the database before migrate"
  if ! node "$SCRIPT_DIR/pg-dump.mjs" "$backup"; then
    rm -f "$backup"
    echo "pg_dump failed; production migration was not started"
    exit 1
  fi
  if [ ! -s "$backup" ]; then
    rm -f "$backup"
    echo "pg_dump wrote an empty file; production migration was not started"
    exit 1
  fi
  chmod 600 "$backup"
  restore_list=$(mktemp)
  if ! pg_restore --list "$backup" >"$restore_list"; then
    rm -f "$restore_list"
    echo "restore check failed; production migration was not started"
    exit 1
  fi
  if [ ! -s "$restore_list" ]; then
    rm -f "$restore_list"
    echo "restore check returned an empty listing; production migration was not started"
    exit 1
  fi
  rm -f "$restore_list"
  log "restore check passed for $(basename "$backup") ($(wc -c < "$backup") bytes)"
  keep_dumps=${KEEP_DUMPS:-7}
  old_dumps=()
  mapfile -t old_dumps < <(find "$ROOT/backups" -maxdepth 1 -type f -name '*.dump' -printf '%T@ %p\n' | sort -rn | awk '{print $2}' | tail -n +"$((keep_dumps + 1))")
  if [ "${#old_dumps[@]}" -gt 0 ]; then
    rm -f "${old_dumps[@]}"
    log "removed ${#old_dumps[@]} old database backup(s); keeping ${keep_dumps}"
  fi
elif [ "$pending" = 1 ]; then
  rm -f "$status_file"
  log "pending migrations on staging; no production backup is taken here"
else
  rm -f "$status_file"
  log "no pending migrations"
fi

log "applying migrations"
migrate_log=$(mktemp)
set +e
npx prisma migrate deploy >"$migrate_log" 2>&1
migrate_rc=$?
set -e
redact < "$migrate_log"
rm -f "$migrate_log"
[ "$migrate_rc" = 0 ] || { echo "prisma migrate deploy failed; the app was not switched"; exit 1; }

printf 'RELEASE=%s\nARTIFACT_SHA256=%s\n' "$SHA" "$DIGEST" > "$REL/release.env"
chmod 644 "$REL/release.env"

if [ "$SHO_TIER" = production ] && [ "$HARNESS" != 1 ]; then
  install -m 755 deploy/job.sh "$ROOT/bin/job.sh"
  install_cron() {
    local name="$1" when="$2"
    if grep -qs "job.sh $name" /etc/cron.d/sho; then return 0; fi
    if crontab -l 2>/dev/null | grep -qs "job.sh $name # sho-managed"; then return 0; fi
    { crontab -l 2>/dev/null || true; echo "$when /opt/sho/bin/job.sh $name # sho-managed"; } | crontab - \
      && log "$name cron installed for $(id -un)" || log "WARNING: could not install the $name cron"
  }
  install_cron reminders '0 8 * * *'
  install_cron purge-chat '47 3 * * *'
  install_cron concierge-budget '57 3 * * *'
  if ! grep -qs 'job.sh stalled-deals' /etc/cron.d/sho && ! crontab -l 2>/dev/null | grep -q 'job.sh stalled-deals'; then
    { crontab -l 2>/dev/null || true; echo '50 7 * * * /opt/sho/bin/job.sh stalled-deals # crm-stalled'; } | crontab - \
      && log "stalled-deals cron installed for $(id -un)" || log "WARNING: could not install the stalled-deals cron"
  fi
else
  log "not installing production cron"
fi

PREV="$(readlink -f "$CUR" 2>/dev/null || true)"
if [ -n "${PREV:-}" ] && [ -d "$PREV" ] && [ "$PREV" != "$REL" ]; then
  ln -sfn "$PREV" "$ROOT/previous"
  basename "$PREV" > "$ROOT/previous-sha"
  log "rollback target $(basename "$PREV")"
else
  rm -f "$ROOT/previous" "$ROOT/previous-sha"
  log "rollback target none"
fi
switch "$REL"
log "restarting $SERVICE"
if ! sudo systemctl restart "$SERVICE"; then
  log "restart failed"
  rollback
  exit 1
fi
if healthy && version_ok; then
  log "healthy: $SHA is live"
  find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2- | { grep -vx "$REL" || true; } | xargs -r rm -rf
  case "$TARBALL" in
    "$ROOT"/incoming/*) rm -f "$TARBALL" "${TARBALL}.sha256" ;;
  esac
  exit 0
fi

log "health check failed"
rollback
exit 1

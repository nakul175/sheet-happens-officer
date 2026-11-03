#!/usr/bin/env bash
# App-only release: never applies migrations, provisions secrets or installs schedules.
# Builds one release on the droplet and switches the app to it. If the health check fails
# after the restart, the previous release is put back (SHO-US-9.3 AC2).
# GitHub Actions runs it as the deploy user: bash /opt/sho/releases/<sha>/deploy/release.sh <sha>
set -Eeuo pipefail

SHA="${1:?release sha}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "Expected full lowercase commit SHA"; exit 1; }
ROOT=/opt/sho
REL="$ROOT/releases/$SHA"
CUR="$ROOT/current"
PORT=3000
KEEP=3
PREV=""
# Serialize the entire build/switch/recovery path; never race another app cut.
exec 9>"$ROOT/.release.lock"
flock -n 9 || { echo "Another app release holds the deployment lock"; exit 1; }

log() { printf '[release %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
healthy() {
  local _
  for _ in $(seq 1 45); do
    if curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}
switch() { ln -sfn "$1" "$CUR.new" && mv -T "$CUR.new" "$CUR"; }

recover() {
  local status="$?"
  trap - ERR
  set +e
  if [ "$(readlink -f "$CUR" 2>/dev/null)" = "$REL" ] && [ -n "$PREV" ] && [ -d "$PREV" ] && [ "$PREV" != "$REL" ]; then
    log "release failed; restoring previous release"
    if switch "$PREV" && sudo -n systemctl restart sho && healthy; then
      log "rollback verified: $(basename "$PREV")"
    else
      log "RECOVERY_FAILED: operator attention required"
    fi
  else
    log "release failed before switch, or current is no longer this candidate"
  fi
  exit "$status"
}
trap recover ERR

[ -d "$REL" ] || { echo "No release folder at $REL"; exit 1; }
[ -f /etc/sho/app.env ] || { echo "/etc/sho/app.env is missing"; exit 1; }
PREV="$(readlink -f "$CUR" 2>/dev/null || true)"
[ "$PREV" != "$REL" ] || { echo "Refusing to rebuild the active release"; exit 1; }
[ -n "$PREV" ] && [ -d "$PREV" ] || { echo "Verified previous release required"; exit 1; }
cd "$REL"
set -a
# shellcheck disable=SC1091
. /etc/sho/app.env
# shellcheck disable=SC1091
[ ! -r /etc/sho/local.env ] || . /etc/sho/local.env
set +a
# Migrations go to DIRECT_DATABASE_URL (bypassing PgBouncer); until it is set, use DATABASE_URL (APL-2685).
export DIRECT_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}"
export NODE_ENV=production NODE_OPTIONS=--max-old-space-size=3072

log "installing packages"
npm ci --include=dev --no-audit --no-fund --loglevel=error
log "checking migration prerequisites (read-only)"
npx --no-install prisma migrate status
log "building"
npx next build
printf 'RELEASE=%s\n' "$SHA" > release.env
# Job installation and schedules belong to separately approved operations.

switch "$REL"
log "restarting the app"
sudo -n systemctl restart sho
healthy || { log "health check failed"; false; }
log "healthy: $SHA is live"
# Keep both the active and rollback release even if older than the retention window.
find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2- | { grep -vx "$REL" || true; } | { grep -vx "$PREV" || true; } | xargs -r rm -rf

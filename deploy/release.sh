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
PREV_VERIFIER=""
# Serialize the entire build/switch/recovery path; never race another app cut.
exec 9>"$ROOT/.release.lock"
flock -n 9 || { echo "Another app release holds the deployment lock"; exit 1; }

log() { printf '[release %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
healthy() {
  local release_root="$1" expected="$2" verifier="$3" _ pid
  for _ in $(seq 1 45); do
    pid="$(systemctl show sho -p MainPID --value)"
    if node "$verifier" "$release_root" "$expected" "http://127.0.0.1:$PORT" "$pid"; then return 0; fi
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
    if switch "$PREV" && sudo -n systemctl restart sho && healthy "$PREV" "$PREV_SHA" "$PREV_VERIFIER"; then
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

[ -d "$ROOT/releases" ] && [ ! -L "$ROOT/releases" ] || { echo "Release parent is missing or symlinked"; exit 1; }
[ -d "$REL" ] && [ ! -L "$REL" ] && [ "$(readlink -f "$REL")" = "$REL" ] || { echo "Release folder is missing or resolves outside its reserved path"; exit 1; }
[ -f "$REL/deploy/verify-release.mjs" ] && [ ! -L "$REL/deploy/verify-release.mjs" ] &&
  [ "$(readlink -f "$REL/deploy/verify-release.mjs")" = "$REL/deploy/verify-release.mjs" ] || { echo "Candidate release verifier is missing or outside its release"; exit 1; }
[ -f /etc/sho/app.env ] || { echo "/etc/sho/app.env is missing"; exit 1; }
PREV="$(readlink -f "$CUR" 2>/dev/null || true)"
[ "$PREV" != "$REL" ] || { echo "Refusing to rebuild the active release"; exit 1; }
[ -n "$PREV" ] && [ -d "$PREV" ] || { echo "Verified previous release required"; exit 1; }
[ "$(dirname "$PREV")" = "$ROOT/releases" ] || { echo "Previous release is outside the release directory"; exit 1; }
PREV_NAME="$(basename "$PREV")"
if [[ "$PREV_NAME" =~ ^[0-9a-f]{40}$ ]]; then
  PREV_EXPECTED_SHA="$PREV_NAME"
elif [[ "$PREV_NAME" =~ ^e1-[a-z0-9][a-z0-9-]*-([0-9a-f]{40})$ ]]; then
  PREV_EXPECTED_SHA="${BASH_REMATCH[1]}" # Existing story-specific release layout.
else
  echo "Previous release directory has an unknown identity"; exit 1
fi
[ -f "$PREV/COMMIT" ] && [ ! -L "$PREV/COMMIT" ] || { echo "Previous release identity missing"; exit 1; }
PREV_SHA="$(cat "$PREV/COMMIT")"
[ "$PREV_SHA" = "$PREV_EXPECTED_SHA" ] || { echo "Previous release identity does not match its directory"; exit 1; }
if [ -e "$PREV/deploy/verify-release.mjs" ] || [ -L "$PREV/deploy/verify-release.mjs" ]; then
  [ -f "$PREV/deploy/verify-release.mjs" ] && [ ! -L "$PREV/deploy/verify-release.mjs" ] &&
    [ "$(readlink -f "$PREV/deploy/verify-release.mjs")" = "$PREV/deploy/verify-release.mjs" ] || { echo "Previous release verifier is invalid"; exit 1; }
  PREV_VERIFIER="$PREV/deploy/verify-release.mjs"
else
  [ -f "$REL/deploy/verify-previous-release.mjs" ] && [ ! -L "$REL/deploy/verify-previous-release.mjs" ] &&
    [ "$(readlink -f "$REL/deploy/verify-previous-release.mjs")" = "$REL/deploy/verify-previous-release.mjs" ] || { echo "Legacy rollback verifier is missing or symlinked"; exit 1; }
  PREV_VERIFIER="$REL/deploy/verify-previous-release.mjs"
fi
pid="$(systemctl show sho -p MainPID --value)"
node "$PREV_VERIFIER" "$PREV" "$PREV_SHA" "http://127.0.0.1:$PORT" "$pid" || { echo "Previous release failed pre-cut verification"; exit 1; }
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
printf '%s\n' "$SHA" > COMMIT
printf 'RELEASE=%s\n' "$SHA" > release.env
# Job installation and schedules belong to separately approved operations.

switch "$REL"
log "restarting the app"
sudo -n systemctl restart sho
healthy "$REL" "$SHA" "$REL/deploy/verify-release.mjs" || { log "health check failed"; false; }
log "healthy: $SHA is live"
# Retention is best effort after a verified cut. A cleanup failure must not
# roll back a healthy release; incomplete or unknown directories are preserved.
if [ -f "$REL/deploy/prune-releases.mjs" ] && [ ! -L "$REL/deploy/prune-releases.mjs" ] &&
  [ "$(readlink -f "$REL/deploy/prune-releases.mjs")" = "$REL/deploy/prune-releases.mjs" ] &&
  node "$REL/deploy/prune-releases.mjs" "$ROOT/releases" "$REL" "$PREV" "$KEEP"; then
  log "release retention checked"
else
  log "release retention deferred for operator review"
fi

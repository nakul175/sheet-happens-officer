#!/usr/bin/env bash
# Point production at a release directory that is already on the droplet.
# Does not migrate, does not take a backup, and does not rewrite app.env.
# Usage: rollback.sh [/opt/sho/releases/<sha>]
# With no directory, switches back to the symlink recorded in /opt/sho/previous.
#   --harness is for deploy/test-release.sh only.
set -euo pipefail

HARNESS=0
if [ "${1:-}" = --harness ]; then
  HARNESS=1
  shift
fi

SHO_TIER="${SHO_TIER:?SHO_TIER is required}"
[ "$SHO_TIER" = production ] || { echo "rollback is production only"; exit 1; }

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=release-common.sh
. "$SCRIPT_DIR/release-common.sh"

ROOT=/opt/sho
PORT=3000
SERVICE=sho
REQUESTED="${1:-}"

if [ "$HARNESS" = 1 ]; then
  case "${SHO_PREFIX:?SHO_PREFIX is required with --harness}" in
    /tmp/*|/var/tmp/*) ;;
    *) echo "harness prefix must be under /tmp"; exit 1 ;;
  esac
  case "$SHO_PREFIX" in
    *..*) echo "harness prefix must not contain .."; exit 1 ;;
  esac
  ROOT="${SHO_PREFIX}${ROOT}"
elif [ -n "${SHO_PREFIX:-}" ]; then
  echo "SHO_PREFIX is only available to the test harness"
  exit 1
fi

if [ -n "$REQUESTED" ]; then
  [[ "$REQUESTED" =~ ^/opt/sho/releases/[0-9a-f]{40}$ ]] || { echo "release dir must be /opt/sho/releases/<sha>"; exit 1; }
  TARGET="${ROOT}/releases/$(basename "$REQUESTED")"
else
  TARGET="$(readlink -f "$ROOT/previous" 2>/dev/null || true)"
fi

if [ -z "${TARGET:-}" ] || [ ! -d "$TARGET" ]; then
  echo "rollback target is not on the droplet"
  exit 1
fi
[ -f "$TARGET/release.env" ] || { echo "rollback target has no release.env"; exit 1; }
# shellcheck disable=SC1091
. "$TARGET/release.env"
assert_sha "${RELEASE:-}"
assert_digest "${ARTIFACT_SHA256:-}"

CUR="$ROOT/current"
if [ "$HARNESS" = 1 ]; then
  HEALTH_TRIES=1
  HEALTH_SLEEP=0
else
  HEALTH_TRIES=45
  HEALTH_SLEEP=2
fi

log() { printf '[rollback %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

healthy() {
  local _
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    if curl -fsS -m 5 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then return 0; fi
    [ "$HEALTH_SLEEP" = 0 ] || sleep "$HEALTH_SLEEP"
  done
  return 1
}

version_ok() {
  local body
  body=$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/api/version" 2>/dev/null) || return 1
  VERSION_BODY="$body" EXPECT_SHA="$RELEASE" EXPECT_DIGEST="$ARTIFACT_SHA256" node -e '
    let j;
    try { j = JSON.parse(process.env.VERSION_BODY); } catch { process.exit(1); }
    if (j.sha !== process.env.EXPECT_SHA || j.digest !== process.env.EXPECT_DIGEST) process.exit(1);
  '
}

switch() { ln -sfn "$1" "$CUR.new" && mv -T "$CUR.new" "$CUR"; }

log "rollback target $(basename "$TARGET") (no migration)"
switch "$TARGET"
if ! sudo systemctl restart "$SERVICE"; then
  echo "restart failed"
  exit 1
fi
if healthy && version_ok; then
  log "rolled back to $(basename "$TARGET")"
  exit 0
fi
echo "rolled-back release did not become healthy"
exit 1

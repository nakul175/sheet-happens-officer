#!/usr/bin/env bash
# Builds one release on the droplet and switches the app to it. If the health check fails
# after the restart, the previous release is put back (SHO-US-9.3 AC2).
# GitHub Actions runs it as the deploy user: bash /opt/sho/releases/<sha>/deploy/release.sh <sha>
set -euo pipefail

SHA="${1:?release sha}"
ROOT=/opt/sho
REL="$ROOT/releases/$SHA"
CUR="$ROOT/current"
PORT=3000
KEEP=3

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

[ -d "$REL" ] || { echo "No release folder at $REL"; exit 1; }
[ -f /etc/sho/app.env ] || { echo "/etc/sho/app.env is missing"; exit 1; }
cd "$REL"
set -a
# shellcheck disable=SC1091
. /etc/sho/app.env
# shellcheck disable=SC1091
. /etc/sho/local.env
set +a
export NODE_ENV=production NODE_OPTIONS=--max-old-space-size=3072

log "installing packages"
npm ci --include=dev --no-audit --no-fund --loglevel=error
log "applying migrations"
npx prisma migrate deploy
log "building"
npx next build
printf 'RELEASE=%s\n' "$SHA" > release.env
install -m 755 deploy/job.sh "$ROOT/bin/job.sh"

PREV="$(readlink -f "$CUR" 2>/dev/null || true)"
switch "$REL"
log "restarting the app"
sudo systemctl restart sho
if healthy; then
  log "healthy: $SHA is live"
  # Keep the newest releases only; never the one just released.
  find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2- | grep -vx "$REL" | xargs -r rm -rf
  exit 0
fi

log "health check failed; rolling back"
sudo journalctl -u sho -n 80 --no-pager || true
if [ -n "$PREV" ] && [ -d "$PREV" ] && [ "$PREV" != "$REL" ]; then
  switch "$PREV"
  sudo systemctl restart sho
  if healthy; then log "rolled back to $(basename "$PREV")"; else log "the previous release did not come up either"; fi
else
  log "no previous release to roll back to"
fi
exit 1

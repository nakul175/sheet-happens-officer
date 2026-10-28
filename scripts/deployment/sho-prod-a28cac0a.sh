#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
SHA=a28cac0a085cb4c569ee0dc08935f009abb72514
SOURCE_SHA=3e53956f55b45f1201adf11890c86d550cb9762a
EXPECTED_PREV=b78b53634aebdb67b304fa6e142e50b442567d11
ARCHIVE=/home/deploy/sho-release-a28cac0a.tar.gz
ARCHIVE_URL=https://github.com/nakul175/sheet-happens-officer/archive/a28cac0a085cb4c569ee0dc08935f009abb72514.tar.gz
ARCHIVE_SHA256=b6f6c639a11cd5f028131bd5c3ab45a3386e137ef84604a2250c06b86e913478
BASE=/opt/sho
DEST="$BASE/releases/$SHA"
LOG=/home/deploy/sho-prod-a28cac0a-build.log
RECEIPT=/home/deploy/sho-prod-a28cac0a-receipt.json
SWITCHED=0
health_sha() { curl -fsS --max-time 10 "http://127.0.0.1:$1/api/health" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True; print(d["release"])'; }
wait_sha() { for _ in $(seq 1 60); do test "$(health_sha 3000 2>/dev/null || true)" != "$1" || return 0; sleep 1; done; return 1; }
switch_to() { test -d "$1"; systemctl stop sho; ln -s "$1" "$BASE/current.mobile-next"; mv -Tf "$BASE/current.mobile-next" "$BASE/current"; systemctl start sho; }
assert_assets_process() {
 local target="$1" pid assets asset count=0
 pid=$(systemctl show sho -p MainPID --value); test "$pid" -gt 1
 test "$(readlink -f "/proc/$pid/cwd")" = "$target"
 assets=$(curl -fsS --max-time 10 http://127.0.0.1:3000/signin | grep -oE '(/_next/static/[^" ]+\.(js|css))' | sort -u); test -n "$assets"
 while IFS= read -r asset; do test "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000$asset")" = 200; count=$((count+1)); done <<< "$assets"
 test "$count" -gt 0
}
assert_stage_unchanged() {
 test "$(readlink -f /home/shoslot/pr9/current)" = "$STAGE_POINTER"
 test "$(systemctl show sho-pr9 -p MainPID --value)" = "$STAGE_PID"
 test "$(health_sha 3109)" = "$SOURCE_SHA"
}
recover() {
 local status=$?; trap - ERR; set +e
 if test "$SWITCHED" = 1; then
  systemctl stop sho; rm -f "$BASE/current.mobile-next"; ln -s "$PREVIOUS" "$BASE/current.mobile-next"; mv -Tf "$BASE/current.mobile-next" "$BASE/current"; systemctl start sho
  wait_sha "$EXPECTED_PREV" && echo RECOVERY=PASS || echo RECOVERY=FAILED
 fi
 echo "PRODUCTION_FAILED status=$status"; exit "$status"
}
trap recover ERR
test "$(id -u)" = 0
exec 9>/run/lock/sho-production-deploy.lock; flock -n 9
exec 8>/run/lock/sho-slot9-deploy.lock; flock -n 8
PREVIOUS=$(readlink -f "$BASE/current"); test "$PREVIOUS" = "$BASE/releases/$EXPECTED_PREV"
STAGE_POINTER=$(readlink -f /home/shoslot/pr9/current); STAGE_PID=$(systemctl show sho-pr9 -p MainPID --value); test "$STAGE_PID" -gt 1
test "$(health_sha 3000)" = "$EXPECTED_PREV"; assert_stage_unchanged
test "$(systemctl show sho -p User --value)" = deploy
test ! -e "$DEST"; test ! -L "$DEST"; test ! -e "$BASE/current.mobile-next"; test ! -L "$BASE/current.mobile-next"
if test ! -e "$ARCHIVE"; then curl -fsSL "$ARCHIVE_URL" -o "$ARCHIVE"; chown deploy:deploy "$ARCHIVE"; chmod 0600 "$ARCHIVE"; fi
test "$(sha256sum "$ARCHIVE" | awk '{print $1}')" = "$ARCHIVE_SHA256"
python3 - "$ARCHIVE" <<'PY'
import sys,tarfile,posixpath
with tarfile.open(sys.argv[1],'r:gz') as archive:
 for m in archive.getmembers():
  assert not m.name.startswith('/') and '..' not in m.name.split('/'),m.name
  assert not (m.ischr() or m.isblk() or m.isfifo()),m.name
  if m.issym() or m.islnk():
   target=posixpath.normpath(posixpath.join(posixpath.dirname(m.name),m.linkname))
   assert not m.linkname.startswith('/') and target!='..' and not target.startswith('../'),m.name
PY
install -d -o deploy -g deploy -m 0700 "$DEST"
tar -xzf "$ARCHIVE" -C "$DEST" --strip-components=1 --no-same-owner; chown -R deploy:deploy "$DEST"
test ! -e "$DEST/node_modules"; test ! -e "$DEST/.next"; test ! -e "$DEST/src/generated"
(
 set -a; source /etc/sho/app.env; source /etc/sho/local.env; set +a
 export DIRECT_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}" NODE_ENV=production NODE_OPTIONS=--max-old-space-size=3072
 cd "$DEST"
 runuser -u deploy --preserve-environment -- env HOME=/home/deploy XDG_CACHE_HOME="$DEST/.cache" npm_config_cache="$DEST/.npm-cache" npm ci --include=dev --no-audit --no-fund
 runuser -u deploy --preserve-environment -- env HOME=/home/deploy XDG_CACHE_HOME="$DEST/.cache" npm_config_cache="$DEST/.npm-cache" npm run build -- --webpack
) > "$LOG" 2>&1
# SHO-2902 test-only release marker: runtime tree equals previous production; no database migrations or business-data writes.
test -s "$DEST/.next/BUILD_ID"; test -d "$DEST/.next/static"
test -d "$DEST/node_modules"; test ! -L "$DEST/node_modules"
test -d "$DEST/src/generated"; test ! -L "$DEST/src/generated"
test "$(readlink -f "$DEST/node_modules")" != "$(readlink -f "$PREVIOUS/node_modules")"
test "$(readlink -f "$DEST/src/generated")" != "$(readlink -f "$PREVIOUS/src/generated")"
runuser -u deploy -- test -r "$DEST/server.js"
BUILD_ID=$(cat "$DEST/.next/BUILD_ID")
printf '%s\n' "$SHA" > "$DEST/COMMIT"
printf 'RELEASE=%s\nBUILD_ID=%s\n' "$SHA" "$BUILD_ID" > "$DEST/release.env"
chown deploy:deploy "$DEST/COMMIT" "$DEST/release.env"; chmod 0600 "$DEST/release.env"
test "$(health_sha 3000)" = "$EXPECTED_PREV"; assert_stage_unchanged
SWITCHED=1
switch_to "$DEST"; wait_sha "$SHA"; assert_assets_process "$DEST"; assert_stage_unchanged
switch_to "$PREVIOUS"; wait_sha "$EXPECTED_PREV"; assert_assets_process "$PREVIOUS"; assert_stage_unchanged
switch_to "$DEST"; wait_sha "$SHA"; assert_assets_process "$DEST"; assert_stage_unchanged
python3 - "$RECEIPT" "$SHA" "$EXPECTED_PREV" "$BUILD_ID" <<'PY'
import json,sys,datetime
with open(sys.argv[1],'w') as f: json.dump(dict(release=sys.argv[2],rollbackRelease=sys.argv[3],buildId=sys.argv[4],freshBuild=True,isolatedModules=True,isolatedGeneratedClient=True,assets=True,processIdentity=True,rollbackRehearsal=True,stagingUnchanged=True,verifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat()),f,indent=2)
PY
chown deploy:deploy "$RECEIPT"
SWITCHED=0
printf 'PRODUCTION_VERIFIED release=%s rollback=%s stagingUnchanged=true\n' "$SHA" "$EXPECTED_PREV"

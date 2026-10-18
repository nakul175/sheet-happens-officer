#!/usr/bin/env bash
# Upload the release tarball and app.env, then run release.sh on the droplet.
# Usage: push-release.sh staging|production
# Requires HOST, GITHUB_SHA, DIGEST, and the secret variables write-app-env.sh reads.
# SSH is already configured by deploy/ci-ssh.sh.
set -euo pipefail

tier="${1:?tier}"
: "${HOST:?}" "${GITHUB_SHA:?}" "${DIGEST:?}"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=release-common.sh
. "$SCRIPT_DIR/release-common.sh"
assert_sha "$GITHUB_SHA"
assert_digest "$DIGEST"

case "$tier" in
  staging)
    ROOT=/opt/sho-staging
    ENV_FILE=/etc/sho-staging/app.env
    ;;
  production)
    ROOT=/opt/sho
    ENV_FILE=/etc/sho/app.env
    ;;
  *)
    echo "::error::unknown tier"
    exit 1
    ;;
esac
assert_push_target "$tier" "$ROOT" "$ENV_FILE"
ENV_DIR=$(dirname "$ENV_FILE")

# upload-artifact stores the two files at the archive root. Accept either layout.
if [ ! -f dist/sho-release.tar.gz ]; then
  found=$(find . -name sho-release.tar.gz -type f -not -path './node_modules/*' -print -quit)
  side=$(find . -name sho-release.tar.gz.sha256 -type f -not -path './node_modules/*' -print -quit)
  [ -n "$found" ] && [ -n "$side" ] || { echo "::error::release tarball is missing"; exit 1; }
  mkdir -p dist
  cp "$found" dist/sho-release.tar.gz
  cp "$side" dist/sho-release.tar.gz.sha256
fi
[ -f dist/sho-release.tar.gz ] || { echo "::error::release tarball is missing"; exit 1; }
actual=$(sha256sum dist/sho-release.tar.gz | awk '{print $1}')
[ "$actual" = "$DIGEST" ] || { echo "::error::local tarball digest does not match the one this job will deploy"; exit 1; }
side=$(tr -d '[:space:]' < dist/sho-release.tar.gz.sha256)
[ "$side" = "$DIGEST" ] || { echo "::error::digest sidecar does not match"; exit 1; }

umask 077
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
bash "$SCRIPT_DIR/write-app-env.sh" "$tier" > "$tmp"
grep -q '^DATABASE_URL=' "$tmp"
grep -q '^RESEND_API_KEY=' "$tmp"
# The file is a secret. Do not print it.

SSH=(ssh -o BatchMode=yes -o IdentitiesOnly=yes)
SCP=(scp -o BatchMode=yes -o IdentitiesOnly=yes)

echo "Checking $ROOT on $HOST"
"${SSH[@]}" "deploy@$HOST" "test -d '$ROOT' && test -d '$ENV_DIR' && test -f '$ENV_DIR/local.env' && mkdir -p '$ROOT/releases' '$ROOT/incoming' '$ROOT/bin'"

echo "Writing $ENV_FILE"
"${SSH[@]}" "deploy@$HOST" "umask 077 && cat > '$ENV_FILE.new' && chmod 600 '$ENV_FILE.new' && mv '$ENV_FILE.new' '$ENV_FILE'" < "$tmp"

echo "Uploading the release tarball"
"${SCP[@]}" dist/sho-release.tar.gz "deploy@$HOST:$ROOT/incoming/$GITHUB_SHA.tar.gz"
"${SCP[@]}" dist/sho-release.tar.gz.sha256 "deploy@$HOST:$ROOT/incoming/$GITHUB_SHA.tar.gz.sha256"
"${SCP[@]}" "$SCRIPT_DIR/release.sh" "$SCRIPT_DIR/release-common.sh" "$SCRIPT_DIR/pg-dump.mjs" "deploy@$HOST:$ROOT/incoming/"
"${SSH[@]}" "deploy@$HOST" "chmod 755 '$ROOT/incoming/release.sh'"

echo "Installing $GITHUB_SHA on $tier"
"${SSH[@]}" "deploy@$HOST" "SHO_TIER='$tier' bash '$ROOT/incoming/release.sh' '$GITHUB_SHA' '$ROOT/incoming/$GITHUB_SHA.tar.gz' '$DIGEST'"

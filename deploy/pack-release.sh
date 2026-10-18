#!/usr/bin/env bash
# Pack the current next build into dist/sho-release.tar.gz and write its SHA-256.
# Run this after `npm ci` and `npm run build` in CI. It does not rebuild the app.
# The digest is of the tarball, so it is not written inside the tarball.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -d .next/standalone ] || { echo "next build did not produce .next/standalone"; exit 1; }
[ -d src/generated/prisma ] || { echo "Prisma client is missing; run prisma generate"; exit 1; }
find src/generated/prisma -name 'libquery_engine*.node' -print -quit | grep -q . \
  || { echo "Prisma engine binary is missing"; exit 1; }

base="${RUNNER_TEMP:-/tmp}"
STAGE=$(mktemp -d "$base/sho-stage.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/deploy" "$STAGE/src/generated" "$STAGE/prisma"
cp package.json package-lock.json prisma.config.ts next.config.ts "$STAGE/"
cp -a prisma/. "$STAGE/prisma/"
cp -a public "$STAGE/public"
cp deploy/release.sh deploy/release-common.sh deploy/job.sh deploy/pg-dump.mjs "$STAGE/deploy/"

# Production dependencies only. prisma generate runs from postinstall; the client built
# with this app is copied over it so the engine matches the build.
(
  cd "$STAGE"
  DATABASE_URL="${DATABASE_URL:-postgresql://unused:unused@127.0.0.1:1/unused}" \
  DIRECT_DATABASE_URL="${DIRECT_DATABASE_URL:-postgresql://unused:unused@127.0.0.1:1/unused}" \
    npm ci --omit=dev --no-audit --no-fund
)
rm -rf "$STAGE/src/generated"
mkdir -p "$STAGE/src/generated"
cp -a src/generated/prisma "$STAGE/src/generated/prisma"

mkdir -p .next/standalone/.next
rm -rf .next/standalone/public .next/standalone/.next/static
cp -a public .next/standalone/public
cp -a .next/static .next/standalone/.next/static
mkdir -p "$STAGE/.next"
# Copy the build except the cache. tar is used so the pack does not depend on rsync.
tar -C .next --exclude cache -cf - . | tar -C "$STAGE/.next" -xf -

[ -d "$STAGE/node_modules/next" ] || { echo "packed tree has no next"; exit 1; }
[ -f "$STAGE/.next/standalone/server.js" ] || { echo "packed tree has no standalone server"; exit 1; }

mkdir -p dist
tar -C "$STAGE" -czf dist/sho-release.tar.gz .
sha256sum dist/sho-release.tar.gz | awk '{print $1}' > dist/sho-release.tar.gz.sha256
echo "packed $(wc -c < dist/sho-release.tar.gz) bytes digest $(cat dist/sho-release.tar.gz.sha256)"

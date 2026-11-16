#!/usr/bin/env bash
# Run before rsync. Never upload over an existing (possibly live) release tree.
set -euo pipefail
SHA="${1:?release sha}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "INVALID_RELEASE_SHA"; exit 1; }
ROOT=/opt/sho
TARGET="$ROOT/releases/$SHA"
[ -d "$ROOT/releases" ] && [ ! -L "$ROOT/releases" ] || { echo "RELEASE_PARENT_INVALID"; exit 1; }
[ ! -e "$TARGET" ] && [ ! -L "$TARGET" ] || { echo "RELEASE_TARGET_EXISTS"; exit 1; }
# Atomic reservation: concurrent upload of this SHA loses before it can overwrite files.
mkdir "$TARGET"
echo "RELEASE_TARGET_RESERVED $SHA"

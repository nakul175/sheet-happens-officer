#!/usr/bin/env bash
# Run before rsync. Never upload over an existing (possibly live) release tree.
set -euo pipefail
SHA="${1:?release sha}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "INVALID_RELEASE_SHA"; exit 1; }
ROOT=/opt/sho
TARGET="$ROOT/releases/$SHA"
[ -d "$ROOT/releases" ] && [ ! -L "$ROOT/releases" ] || { echo "RELEASE_PARENT_INVALID"; exit 1; }
[ ! -e "$TARGET" ] && [ ! -L "$TARGET" ] || { echo "RELEASE_TARGET_EXISTS"; exit 1; }
# HR-121: isolated 16 GiB host measured <2.6 GiB for a third retained release,
# package and cold candidate install/build. Require 6 GiB before upload, leaving >3.4 GiB
# for host variance and concurrent writes. Recheck before build in release.sh.
available_kib="$(LC_ALL=C df -Pk "$ROOT/releases" | awk 'NR==2 {print $4}')"
[[ "$available_kib" =~ ^[0-9]+$ ]] || { echo "RELEASE_SPACE_UNKNOWN"; exit 1; }
[ "$available_kib" -ge 6291456 ] || { echo "INSUFFICIENT_RELEASE_SPACE available_kib=$available_kib required_kib=6291456"; exit 1; }
# Atomic reservation: concurrent upload of this SHA loses before it can overwrite files.
mkdir "$TARGET"
echo "RELEASE_TARGET_RESERVED $SHA"

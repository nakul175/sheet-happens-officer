#!/usr/bin/env bash
# Export the slot-9 containment artifacts from a pinned commit into a REPRODUCIBLE tarball.
# Coordinator-side only (never on the host). Produces: slot9/ tree, MANIFEST.sha256, slot9-<sha>.tar.gz.
#
# WHY THIS SCRIPT IS VERSIONED HERE: the handoff used to cut the pin with an unversioned script that
# lived outside the repo, so "the pin" could not be re-derived or reviewed. Two cuts of the SAME commit
# gave two different sha256 values, which makes the published hash useless as an identity: a human cannot
# tell a re-cut from a tampered artifact. The cause was metadata only (see REPRODUCIBILITY below), but a
# hash that moves for any reason is not a pin.
#
# REPRODUCIBILITY: the same commit + this script must yield a byte-identical tarball. Three metadata
# sources made that false before, and each is now removed at the source rather than papered over:
#   1. gzip wrote the wall-clock time into its header            -> `gzip -n` (no name, no timestamp)
#   2. tar stored each member's mtime at NANOSECOND precision in a PAX extended header, taken from
#      whenever `git show >` happened to write the file          -> ustar format (no PAX records at all)
#      + every mtime pinned to the commit's own committer date, so the cut time cannot leak in
#   3. macOS tags freshly written files with com.apple.provenance, and bsdtar stores that as a
#      LIBARCHIVE.xattr PAX record                              -> xattrs stripped; ustar cannot carry them
# Ownership is normalised to uid/gid 0 as well, so the pin does not encode the cutter's account.
#
# usage: slot9-export.sh <commit> [outdir]
#        REPO=/path/to/worktree slot9-export.sh HEAD /tmp/slot9-artifacts
set -euo pipefail

REPO=${REPO:-$(git rev-parse --show-toplevel 2>/dev/null || true)}
SHA=${1:?usage: slot9-export.sh <commit> [outdir]}
OUTDIR=${2:-/tmp/slot9-artifacts}
: "${REPO:?REPO must be set (or run inside a git worktree)}"

# Exactly the files the root run needs. Nothing else is shipped, so the tarball cannot carry a surprise.
# Each is a file a runbook sources or calls; scripts/containment/slot9-export-repro.test.mjs asserts this
# list still covers every dependency the two runbooks name.
FILES=(
  scripts/containment/slot9-optionR.sh
  scripts/containment/slot9-proof.sh
  scripts/containment/lib/prod-marker-scan.sh
  scripts/containment/lib/unit-env-sources.sh
)

cd "$REPO"
FULL=$(git rev-parse --verify --end-of-options "$SHA^{commit}")
SHORT=$(git rev-parse --short "$FULL")
# The one clock the archive is allowed to know: when the commit was made.
STAMP=$(TZ=UTC git log -1 --format=%cd --date=format-local:'%Y%m%d%H%M.%S' "$FULL")

umask 022
rm -rf "$OUTDIR"
mkdir -p "$OUTDIR/slot9"

for f in "${FILES[@]}"; do
  if ! git cat-file -e "$FULL:$f" 2>/dev/null; then
    echo "MISSING $f at $SHORT — refusing to build a partial artifact" >&2
    exit 3
  fi
  mkdir -p "$OUTDIR/slot9/$(dirname "$f")"
  git show "$FULL:$f" > "$OUTDIR/slot9/$f"
done
chmod 0755 "$OUTDIR/slot9/scripts/containment/slot9-optionR.sh" \
           "$OUTDIR/slot9/scripts/containment/slot9-proof.sh"
chmod 0644 "$OUTDIR/slot9/scripts/containment/lib/prod-marker-scan.sh" \
           "$OUTDIR/slot9/scripts/containment/lib/unit-env-sources.sh"

# The commit the bytes came from, recorded inside the artifact as well as in its name.
printf '%s\n' "$FULL" > "$OUTDIR/slot9/COMMIT"

(
  cd "$OUTDIR/slot9"
  find . -type f ! -name MANIFEST.sha256 | LC_ALL=C sort | while IFS= read -r f; do
    printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "${f#./}"
  done > MANIFEST.sha256
)

# Pin every mtime to the commit date (whole seconds, UTC) so the cut time cannot enter the archive.
find "$OUTDIR/slot9" -exec touch -t "$STAMP" {} +
if [ "$(uname -s)" = "Darwin" ]; then
  xattr -cr "$OUTDIR/slot9" 2>/dev/null || true   # com.apple.provenance would become a PAX xattr record
fi

# Member list: "slot9" first, then every entry in LC_ALL=C order, directories masked with a trailing
# slash. bsdtar/libtar read the tree in readdir order, which is not a stable input.
LIST="$OUTDIR/.members"
{
  printf 'slot9/\n'
  ( cd "$OUTDIR" && find slot9 -mindepth 1 | LC_ALL=C sort ) | while IFS= read -r p; do
    if [ -d "$OUTDIR/$p" ]; then printf '%s/\n' "$p"; else printf '%s\n' "$p"; fi
  done
} > "$LIST"

# Normalise ownership so the artifact does not encode the account that cut it.
if tar --version 2>/dev/null | grep -qi 'gnu tar'; then
  ID_FLAGS=(--owner=0 --group=0 --numeric-owner)
else
  ID_FLAGS=(--uid 0 --gid 0 --uname root --gname root)
fi

TARBALL="$OUTDIR/slot9-$SHORT.tar.gz"
tar --format=ustar --no-recursion "${ID_FLAGS[@]}" -C "$OUTDIR" -cf - -T "$LIST" | gzip -n -9 > "$TARBALL"
rm -f "$LIST"

echo "COMMIT=$FULL"
echo "TARBALL=$TARBALL"
echo "TARBALL_SHA256=$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
echo "--- MANIFEST.sha256"
cat "$OUTDIR/slot9/MANIFEST.sha256"

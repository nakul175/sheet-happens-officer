#!/usr/bin/env bash
# CONTAINMENT / slot 9 — production-marker scanner for a slot env directory.
#
# Prints COUNTS ONLY. It never prints a matched line, a value, or a file name: `grep -rl` is
# piped straight into `wc -l`, so only the number survives. The marker list is not invented here; it is
# verbatim from OS-IDENTITY-ISOLATION.md:334 (and re-used at :424 for the runtime environ check).
#
# Exit: 0 clean, 1 contaminated, 2 usage. Callers must treat non-zero as "stop, do not start the unit".
set -euo pipefail

readonly MARKERS='defaultdb|doadmin|25061|sho-prod-pool'

if [ "$#" -lt 1 ]; then
  printf 'usage: %s <env-dir|env-file> [...]\n' "$(basename "$0")" >&2
  exit 2
fi
files=0
matches=0
# A directory is scanned as before (maxdepth 1, symlinks followed). A FILE is accepted too: the slot
# unit loads a fourth source, `current/release.env`, which phase 2 creates AFTER R4. It cannot be
# scanned as part of the env dir, so it must be scannable by path — otherwise the marker gate covers
# 3 of the 4 EnvironmentFile sources the unit actually loads.
for target in "$@"; do
  if [ -d "$target" ]; then
  # `-L` and `-type l`: the slot env dir is writable by the account the slot runs as, so `db.env` can be
  # a symlink to a production file. Plain `find -type f` skips it and `grep -r` does not follow a link
  # found while walking, so that dir used to report ENV_FILE_COUNT=0 PROD_MARKER_COUNT=0 ENV_CLEAN,
  # exit 0 (measured). Both the count and the scan therefore resolve the tree with -L.
  dir_files=$(find -L "$target" -maxdepth 1 \( -type f -o -type l \) 2>/dev/null | wc -l | tr -d ' ')
  # `-i`: the marker list is matched case-insensitively. A DSN pasted as DOADMIN used to scan clean
  # (measured); a false positive only stops a run, which is the safe direction.
  # The `|| true` is load-bearing: grep exits 1 when nothing matches, and under `set -o pipefail`
  # that would fail the assignment and abort on the clean case — the exact opposite of the intent.
  dir_matches=$( { find -L "$target" -maxdepth 1 \( -type f -o -type l \) \
    -exec grep -lEi -- "$MARKERS" {} + 2>/dev/null || true; } | wc -l | tr -d ' ')
  files=$((files + dir_files))
  matches=$((matches + dir_matches))
elif [ -e "$target" ] || [ -L "$target" ]; then
  # An explicit file (release.env). A symlink is followed; an unreadable file matches nothing here,
  # and the callers treat "exists but unreadable" as a refusal rather than a clean result.
  files=$((files + 1))
  if [ -r "$target" ] && grep -qEi -- "$MARKERS" "$target" 2>/dev/null; then
    matches=$((matches + 1))
  fi
fi
done

printf 'ENV_FILE_COUNT=%s\n' "$files"
printf 'PROD_MARKER_COUNT=%s\n' "$matches"

if [ "$matches" -ne 0 ]; then
  printf 'ENV_CONTAMINATED\n'
  exit 1
fi
printf 'ENV_CLEAN\n'

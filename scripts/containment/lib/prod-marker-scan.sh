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

if [ "$#" -ne 1 ]; then
  printf 'usage: %s <env-dir>\n' "$(basename "$0")" >&2
  exit 2
fi
readonly ENV_DIR=$1

files=0
matches=0
if [ -d "$ENV_DIR" ]; then
  files=$(find "$ENV_DIR" -maxdepth 1 -type f | wc -l | tr -d ' ')
  # The `|| true` is load-bearing: grep exits 1 when nothing matches, and under `set -o pipefail`
  # that would fail the assignment and abort on the clean case — the exact opposite of the intent.
  matches=$({ grep -rlE -- "$MARKERS" "$ENV_DIR" 2>/dev/null || true; } | wc -l | tr -d ' ')
fi

printf 'ENV_FILE_COUNT=%s\n' "$files"
printf 'PROD_MARKER_COUNT=%s\n' "$matches"

if [ "$matches" -ne 0 ]; then
  printf 'ENV_CONTAMINATED\n'
  exit 1
fi
printf 'ENV_CLEAN\n'

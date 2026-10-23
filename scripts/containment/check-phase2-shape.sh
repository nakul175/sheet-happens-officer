#!/usr/bin/env bash
# ============================================================================
# CONTAINMENT / slot 9 — PHASE 2 SHAPE CHECKER. Read-only. No root. No host.
# ============================================================================
#
# R6 installs the unit and exits 4 when `current/server.js` is absent: that is the designed stopping point,
# and phase 2 is what fills it in. Phase 2 then ships code, points `current` at it, and creates
# `current/release.env` — the FOURTH EnvironmentFile the unit loads, and the first one that did not exist
# when R3/R4 scanned the slot. A wrong phase 2 can therefore put the production env back into the slot
# without touching the unit at all.
#
# PHASE2-CONTRACT.md states what phase 2 must produce. This script is the falsifier for that statement:
# given a slot root it answers, in booleans/counts only,
#
#     is the on-disk shape the one the contract describes?
#
# It never prints a file's content, a key, a value or a DSN. It prints octal modes, numeric uids/gids and
# counts, which are metadata, not secrets.
#
# THREE VERDICTS (the whole point: "phase 2 shipped it" stops being unfalsifiable)
#   PHASE2_SHAPE=ABSENT  `current/server.js` is missing — phase 2 has NOT shipped. This is R6's exit 4.
#                        Not a defect; re-run slot9-optionR.sh after phase 2.
#   PHASE2_SHAPE=BROKEN  the files exist but the shape is not the contract's: a marker in release.env, a
#                        path that leaves the slot tree, a mode/owner that lets the slot or the world write
#                        it, a release.env without identity/port/slot DSN, or phase 2 touched the env dir.
#   PHASE2_SHAPE=OK      every check passed. The unit's own ExecStartPre guards are still the runtime gate;
#                        this is the pre-flight, not a substitute.
#
# Exit: 0 OK · 1 ABSENT or BROKEN (safe to treat as "do not start/enable") · 2 usage/env error
#
# USAGE
#   bash check-phase2-shape.sh <slot-root>
#   bash check-phase2-shape.sh <slot-root> --expect-release-owner-uid 1000 --expect-slot-uid 99
#
#   <slot-root>                 e.g. /home/shoslot/pr9 (never inferred; pass it explicitly)
#   --expect-release-owner-uid  uid that must own current/release.env. Default 1000 (deploy, §5:43):
#                               the shipping identity owns the file, the slot group only reads it.
#   --expect-slot-uid           uid that must own the env files and the slot tree. Default: the owner of
#                               <slot-root> (R2 makes that shoslot).
#   --expect-group-gid          gid that must own release.env. Default: the group of <slot-root> (shoslot).
#   --expect-release-mode       octal mode release.env must have. Default 640.
#
# The three --expect-* overrides exist for the offline test tier (scripts/containment/phase2-shape.test.mjs),
# where no file can be chowned to uid 1000. A host run uses the defaults, which encode the contract.
#
# WHAT THIS DOES NOT DO
#   * It does not read or write the unit, does not call systemctl, does not touch the host.
#   * It does not re-derive the unit's EnvironmentFile list — that is `lib/unit-env-sources.sh`'s job, and
#     slot9-proof.sh P4 runs it. Combine the two for the full answer:
#       unit_env_sources /etc/systemd/system/sho-pr9.service "$SLOT/env" "$SLOT/current"
#   * It cannot prove WHO wrote a file or WHEN. See PHASE2-CONTRACT.md §7.
set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly UNIT_ENV_LIB="${HERE}/lib/unit-env-sources.sh"
readonly MARKER_SCAN="${HERE}/lib/prod-marker-scan.sh"
readonly MARKERS='defaultdb|doadmin|25061|sho-prod-pool'   # :334, the same list the unit's guards use
readonly SLOT_PORT='3109'                                  # :340
readonly DSN_DB='sho_staging'                              # §5 role sho_slot_pr9_app: CONNECT on sho_staging only
# A release.env is identity + port + slot DSN. Anything else is either a mistake or a way back in.
readonly ALLOW_KEYS='RELEASE|PORT|DATABASE_URL|DIRECT_DATABASE_URL'
# NODE_OPTIONS=--require, LD_PRELOAD=, NODE_PATH= and friends turn a data file into code execution inside
# the slot, which is the one thing the EnvironmentFile list is supposed to be unable to do.
readonly UNSAFE_KEYS='NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|BASH_ENV|ENV|PATH|PYTHONPATH'


SLOT_ROOT=''
EXPECT_RELEASE_OWNER_UID='1000'
EXPECT_SLOT_UID=''
EXPECT_GROUP_GID=''
EXPECT_RELEASE_MODE='640'

usage() {
  printf 'usage: %s <slot-root> [--expect-release-owner-uid <uid>] [--expect-slot-uid <uid>] [--expect-group-gid <gid>] [--expect-release-mode <octal>]\n' \
    "$(basename "$0")" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --expect-release-owner-uid) [ "$#" -ge 2 ] || usage; EXPECT_RELEASE_OWNER_UID=$2; shift 2 ;;
    --expect-slot-uid)          [ "$#" -ge 2 ] || usage; EXPECT_SLOT_UID=$2; shift 2 ;;
    --expect-group-gid)         [ "$#" -ge 2 ] || usage; EXPECT_GROUP_GID=$2; shift 2 ;;
    --expect-release-mode)      [ "$#" -ge 2 ] || usage; EXPECT_RELEASE_MODE=$2; shift 2 ;;
    -h|--help)                  sed -n '3,52p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*)                         printf 'unknown option %s\n' "$1" >&2; usage ;;
    *)                          [ -z "$SLOT_ROOT" ] || usage; SLOT_ROOT=$1; shift ;;
  esac
done
[ -n "$SLOT_ROOT" ] || usage

# Reuse the one path implementation the runbook and the proof already share rather than growing a second
# prefix glob (that is exactly the bug lib/unit-env-sources.sh exists to prevent). Sourced, not executed.
[ -r "$UNIT_ENV_LIB" ] || { printf 'REFUSING: missing %s\n' "$UNIT_ENV_LIB" >&2; exit 2; }
[ -r "$MARKER_SCAN" ] || { printf 'REFUSING: missing %s\n' "$MARKER_SCAN" >&2; exit 2; }
# shellcheck source=lib/unit-env-sources.sh
. "$UNIT_ENV_LIB"

# GNU and BSD stat take different flags, and this tier runs on macOS where `stat -c` does not exist.
# Try GNU first, fall back to BSD; an unanswerable stat prints nothing, and every caller treats that as 0.
_stat_field() {
  local gnu=$1 bsd=$2 p=$3 out=''
  if out=$(stat -c "$gnu" -- "$p" 2>/dev/null); then printf '%s' "$out"; return 0; fi
  stat -f "$bsd" -- "$p" 2>/dev/null || printf ''
}
mode_of() { _stat_field '%a' '%Lp' "$1"; }
uid_of()  { _stat_field '%u' '%u'  "$1"; }
gid_of()  { _stat_field '%g' '%g'  "$1"; }

# Octal mode -> decimal, so permission bits can be tested with arithmetic. Anything unparsable is 0, which
# makes every "bit must be clear" test pass and every "bit must be set" test fail — the safe direction.
octal() {
  local m=${1:-}
  case "$m" in ''|*[!0-7]*) printf '0' ;; *) printf '%s' "$((8#$m))" ;; esac
}

bad=0
reasons=''
failed() { bad=$((bad + 1)); reasons="${reasons}${reasons:+,}$1"; }

printf 'phase2 shape: booleans, octal modes and counts only - no file content, no key, no value\n'

root=$(unit_env_canon_path "$SLOT_ROOT")
root_present=0
if [ -d "$root" ]; then root_present=1; fi
printf 'SLOT_ROOT_PRESENT=%s\n' "$root_present"
if [ "$root_present" -ne 1 ]; then
  # Not "phase 2 has not shipped": the slot tree itself does not exist, which is R2, not phase 2.
  printf 'SHAPE_CHECKS_FAILED=1\nPHASE2_SHAPE=BROKEN reason=slot_root_missing\n'
  exit 1
fi

slot_uid=$(uid_of "$root"); slot_uid=${slot_uid:-0}
slot_gid=$(gid_of "$root"); slot_gid=${slot_gid:-0}
[ -n "$EXPECT_SLOT_UID" ] || EXPECT_SLOT_UID=$slot_uid
[ -n "$EXPECT_GROUP_GID" ] || EXPECT_GROUP_GID=$slot_gid

# --- current/ must stay inside the slot tree -------------------------------------------------------------
# `unit_env_canon_path` resolves symlinks *and* `..` against the real tree, so `current -> /somewhere/else`
# and `current/server.js -> /etc/sho/app.env` are both caught here; a string-prefix test would not be.
cur="$root/current"
cur_present=0
if [ -e "$cur" ] || [ -L "$cur" ]; then cur_present=1; fi
cur_inside=0
if [ "$cur_present" -eq 1 ] && unit_env_under "$root" "$(unit_env_canon_path "$cur")"; then cur_inside=1; fi
printf 'CURRENT_PRESENT=%s\nCURRENT_INSIDE_TREE=%s\n' "$cur_present" "$cur_inside"
[ "$cur_present" -eq 1 ] || failed current_missing
[ "$cur_inside" -eq 1 ] || failed current_outside_tree

# --- current/server.js -----------------------------------------------------------------------------------
js="$cur/server.js"
js_present=0
if [ -f "$js" ]; then js_present=1; fi
js_inside=0
js_mode=''
js_mode_ok=0
if [ "$js_present" -eq 1 ]; then
  if unit_env_under "$root" "$(unit_env_canon_path "$js")"; then js_inside=1; fi
  js_mode=$(mode_of "$js")
  m=$(octal "$js_mode")
  # Readable by a non-owner (the unit runs as shoslot, the file is shipped by deploy), and writable by
  # nobody but its owner: a group/other-writable server.js is a slot that can rewrite itself.
  if [ $((m & 8#022)) -eq 0 ] && [ $((m & 8#044)) -ne 0 ]; then js_mode_ok=1; fi
fi
printf 'SERVER_JS_PRESENT=%s\nSERVER_JS_INSIDE_TREE=%s\nSERVER_JS_MODE=%s\nSERVER_JS_MODE_OK=%s\n' \
  "$js_present" "$js_inside" "${js_mode:-none}" "$js_mode_ok"
if [ "$js_present" -ne 1 ]; then
  # ABSENT is its own verdict: R6 exit 4, the designed stopping point, not a broken phase 2.
  printf 'SHAPE_CHECKS_FAILED=1\nPHASE2_SHAPE=ABSENT reason=current_server_js_missing\n'
  exit 1
fi
[ "$js_inside" -eq 1 ] || failed server_js_outside_tree
[ "$js_mode_ok" -eq 1 ] || failed server_js_mode

# --- current/release.env: the fourth EnvironmentFile -----------------------------------------------------
rel="$cur/release.env"
rel_present=0
if [ -f "$rel" ]; then rel_present=1; fi
rel_inside=0
rel_mode=''
rel_mode_ok=0
rel_owner_ok=0
rel_group_ok=0
rel_markers=0
rel_keys=0
rel_release_ok=0
rel_port_ok=0
dsn_present=0
dsn_loopback=0
dsn_port=0
dsn_db_ok=0
etc_sho=0
unsafe_keys=0
unexpected=0
if [ "$rel_present" -eq 1 ]; then
  if unit_env_under "$root" "$(unit_env_canon_path "$rel")"; then rel_inside=1; fi
  rel_mode=$(mode_of "$rel")
  m=$(octal "$rel_mode")
  # The slot must be able to READ it (group read) and must NOT be able to write it (no group/other write),
  # and it is not world-readable (a slot DSN carries a password). ProtectHome=read-only backs this at
  # runtime; this check is the on-disk half of the same rule.
  if [ $((m & 8#040)) -ne 0 ] && [ $((m & 8#022)) -eq 0 ] && [ $((m & 8#004)) -eq 0 ]; then rel_mode_ok=1; fi
  [ "$rel_mode" = "$EXPECT_RELEASE_MODE" ] || rel_mode_ok=0
  if [ "$(uid_of "$rel")" = "$EXPECT_RELEASE_OWNER_UID" ]; then rel_owner_ok=1; fi
  if [ "$(gid_of "$rel")" = "$EXPECT_GROUP_GID" ]; then rel_group_ok=1; fi

  # The marker gate: the same scanner and the same list the unit's four ExecStartPre lines use. A scan that
  # printed nothing is NOT a clean scan — fail closed, exactly as lib/unit-env-sources.sh does.
  scan_out=$(bash "$MARKER_SCAN" "$rel" 2>/dev/null || true)
  rel_markers=$(printf '%s\n' "$scan_out" | sed -n 's/^PROD_MARKER_COUNT=//p')
  case "${rel_markers:-}" in ''|*[!0-9]*) rel_markers=1 ;; esac

  rel_keys=$(grep -cE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "$rel" || true)
  rel_keys=${rel_keys:-0}
  # Release identity: the health route answers `release: process.env.RELEASE`, and slot9-proof.sh P4 reads
  # it back — a release.env without it cannot be proven to be the shipped release.
  if grep -qE '^RELEASE=[0-9a-f]{7,40}$' "$rel" 2>/dev/null; then rel_release_ok=1; fi
  if grep -qxE "PORT=${SLOT_PORT}" "$rel" 2>/dev/null; then rel_port_ok=1; fi
  # DSN shape, answered with exit statuses only: loopback (P5), 5432 (not the pooler), sho_staging.
  if grep -qE '^DATABASE_URL=' "$rel" 2>/dev/null; then
    dsn_present=1
    if grep -qE '^DATABASE_URL=[^[:space:]]*@(127\.0\.0\.1|localhost):' "$rel" 2>/dev/null; then dsn_loopback=1; fi
    if grep -qE '^DATABASE_URL=[^[:space:]]*:5432/' "$rel" 2>/dev/null; then dsn_port=1; fi
    if grep -E '^DATABASE_URL=' "$rel" 2>/dev/null | grep -qE "/${DSN_DB}([?\"]|$)"; then dsn_db_ok=1; fi
  fi
  etc_sho=$(grep -cE '/etc/sho' "$rel" 2>/dev/null || true)
  etc_sho=${etc_sho:-0}
  unsafe_keys=$(grep -cE "^[[:space:]]*(${UNSAFE_KEYS})=" "$rel" 2>/dev/null || true)
  unsafe_keys=${unsafe_keys:-0}
  unexpected=$(sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$rel" 2>/dev/null \
    | grep -vcxE "${ALLOW_KEYS}${PHASE2_ALLOW_KEYS:+|$PHASE2_ALLOW_KEYS}" || true)
  unexpected=${unexpected:-0}
fi
printf 'RELEASE_ENV_PRESENT=%s\nRELEASE_ENV_INSIDE_TREE=%s\nRELEASE_ENV_MODE=%s\nRELEASE_ENV_MODE_OK=%s\n' \
  "$rel_present" "$rel_inside" "${rel_mode:-none}" "$rel_mode_ok"
printf 'RELEASE_ENV_OWNER_OK=%s\nRELEASE_ENV_GROUP_OK=%s\n' "$rel_owner_ok" "$rel_group_ok"
printf 'RELEASE_ENV_MARKER_COUNT=%s\nRELEASE_ENV_KEY_COUNT=%s\n' "$rel_markers" "$rel_keys"
printf 'RELEASE_ENV_RELEASE_OK=%s\nRELEASE_ENV_PORT_%s=%s\n' "$rel_release_ok" "$SLOT_PORT" "$rel_port_ok"
printf 'RELEASE_ENV_DSN_PRESENT=%s\nRELEASE_ENV_DSN_LOOPBACK=%s\nRELEASE_ENV_DSN_PORT_5432=%s\nRELEASE_ENV_DSN_SLOT_DB=%s\n' \
  "$dsn_present" "$dsn_loopback" "$dsn_port" "$dsn_db_ok"
printf 'RELEASE_ENV_ETC_SHO_COUNT=%s\nRELEASE_ENV_UNSAFE_KEY_COUNT=%s\nRELEASE_ENV_UNEXPECTED_KEY_COUNT=%s\n' \
  "$etc_sho" "$unsafe_keys" "$unexpected"
[ "$rel_present" -eq 1 ] || failed release_env_missing
[ "$rel_inside" -eq 1 ] || failed release_env_outside_tree
[ "$rel_mode_ok" -eq 1 ] || failed release_env_mode
[ "$rel_owner_ok" -eq 1 ] || failed release_env_owner
[ "$rel_group_ok" -eq 1 ] || failed release_env_group
[ "$rel_markers" -eq 0 ] || failed release_env_marker
[ "$rel_release_ok" -eq 1 ] || failed release_env_no_release_identity
[ "$rel_port_ok" -eq 1 ] || failed release_env_port
[ "$dsn_present" -eq 1 ] || failed release_env_no_dsn
[ "$dsn_loopback" -eq 1 ] || failed release_env_dsn_not_loopback
[ "$dsn_port" -eq 1 ] || failed release_env_dsn_port
[ "$dsn_db_ok" -eq 1 ] || failed release_env_dsn_db
[ "$etc_sho" -eq 0 ] || failed release_env_etc_sho
[ "$unsafe_keys" -eq 0 ] || failed release_env_unsafe_key
[ "$unexpected" -eq 0 ] || failed release_env_unexpected_key


printf 'SLOT_UID=%s\nSLOT_GID=%s\n' "$slot_uid" "$slot_gid"


# --- env/: R3's three files. Phase 2 must not rewrite these; a mode/owner change here is the signal. -----
env_missing=0
env_mode_bad=0
env_owner_bad=0
env_group_bad=0
for name in db app local; do
  f="$root/env/$name.env"
  if [ ! -f "$f" ]; then env_missing=$((env_missing + 1)); continue; fi
  m=$(octal "$(mode_of "$f")")
  # 0600 in R3: owner-only. Any group/other bit at all is a widening.
  [ $((m & 8#077)) -eq 0 ] || env_mode_bad=$((env_mode_bad + 1))
  [ "$(uid_of "$f")" = "$EXPECT_SLOT_UID" ] || env_owner_bad=$((env_owner_bad + 1))
  [ "$(gid_of "$f")" = "$EXPECT_GROUP_GID" ] || env_group_bad=$((env_group_bad + 1))
done
printf 'ENV_FILE_MISSING=%s\nENV_FILE_MODE_BAD=%s\nENV_FILE_OWNER_BAD=%s\nENV_FILE_GROUP_BAD=%s\n' \
  "$env_missing" "$env_mode_bad" "$env_owner_bad" "$env_group_bad"
[ "$env_missing" -eq 0 ] || failed env_file_missing
[ "$env_mode_bad" -eq 0 ] || failed env_file_mode
[ "$env_owner_bad" -eq 0 ] || failed env_file_owner
[ "$env_group_bad" -eq 0 ] || failed env_file_group

printf 'SHAPE_CHECKS_FAILED=%s\n' "$bad"
if [ "$bad" -eq 0 ]; then
  printf 'PHASE2_SHAPE=OK\n'
  exit 0
fi
printf 'PHASE2_SHAPE=BROKEN reason=%s\n' "$reasons"
exit 1

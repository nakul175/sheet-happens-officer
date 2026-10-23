#!/usr/bin/env bash
# ============================================================================
# SHO SLOT 9 CONTAINMENT — PROOF BLOCK (P1..P5). Staging host only, RUN AS ROOT.
# ============================================================================
#
# This is OS-IDENTITY-ISOLATION.md §6 made runnable. It answers ONE question with booleans and counts:
#
#     can the slot's runtime uid read the production env?      expect: no
#
# and reports the shape of the slot (uid, listener, release) without ever reading a value out.
#
# WHY THIS IS NOT JUST §6 COPIED: §6:416 uses `sudo -u shoslot cat /etc/sho/app.env` as its negative test.
# That is only safe while containment holds — the moment it does NOT hold, the command dumps the production
# env to your terminal and into scrollback/journal. The same applies to §6:423-424, which pipe
# /proc/<pid>/environ through `cut`/`grep` and would print keys (and, if a line has no `=`, a value).
# Here every assertion is `test` (a boolean) or `grep -c` (a count). No `cat`, no `printenv`, no value.
#
# A denial alone proves nothing: a missing file is also "denied". So each probe reports EXISTS and DENIED
# separately, and PASS requires both. That is the difference between a proof and a coincidence.
#
# Exit: 0 gap closed and slot healthy · 1 gap NOT closed (stop, do not deploy) · 2 refused precondition
set -euo pipefail

readonly UNIT_NAME='sho-pr9'
readonly SLOT_ACCOUNT='shoslot'
readonly PROD_ENV='/etc/sho/app.env'
readonly DEPLOY_HOME='/home/deploy'
readonly EXPECT_PORT='3109'
readonly MARKERS='defaultdb|doadmin|25061|sho-prod-pool'   # :334
readonly SLOT_ROOT='/home/shoslot/pr9'                      # :325-327 — the only tree a source may live in
readonly MARKER_SCAN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/prod-marker-scan.sh"
readonly UNIT_ENV_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/unit-env-sources.sh"
readonly HEALTH_URL="http://127.0.0.1:${EXPECT_PORT}/api/health"

say()  { printf '%s\n' "$*"; }
fail() { printf 'REFUSING: %s\n' "$*" >&2; exit 2; }

[ "$(id -u)" -eq 0 ] || fail "must be run as root (it uses sudo -u ${SLOT_ACCOUNT} to test another uid's rights)"
[ "$(uname -s)" = 'Linux' ] || fail "not Linux; this is the staging host's proof block"
id -u "$SLOT_ACCOUNT" >/dev/null 2>&1 || fail "account ${SLOT_ACCOUNT} does not exist - run slot9-optionR.sh first"

# 0 = yes (it could), 1 = no (denied). Never prints the path's contents, only the answer.
as_slot() { if sudo -n -u "$SLOT_ACCOUNT" "$@" >/dev/null 2>&1; then echo 0; else echo 1; fi; }

# POSITIVE CONTROL. A denial proves nothing if the probe itself is broken - if sudo cannot switch to the
# account, every check below reports "denied" and the proof would pass for the wrong reason.
if [ "$(as_slot test -e /)" -ne 0 ]; then
  fail "sudo -n -u ${SLOT_ACCOUNT} cannot run a known-good probe (test -e /); proof would be meaningless"
fi
say "probe_positive_control=1"
# 1 = exists (checked as root, so permissions cannot confuse the two answers)
exists() { if [ -e "$1" ]; then echo 1; else echo 0; fi; }

say ""
say "== P1  THE gap-closing proof: uid separation denies the credential =="
say "slot_uid=$(id -u "$SLOT_ACCOUNT") deploy_uid=$(id -u deploy 2>/dev/null || echo absent) uids_differ=$( [ "$(id -u "$SLOT_ACCOUNT")" != "$(id -u deploy 2>/dev/null || echo x)" ] && echo 1 || echo 0 )"

prod_env_exists=$(exists "$PROD_ENV")
prod_env_readable=$(as_slot test -r "$PROD_ENV")
say "shoslot_can_read_prod_env=${prod_env_readable}   (prod_env_exists=${prod_env_exists})"

deploy_home_exists=$(exists "$DEPLOY_HOME")
deploy_home_traversable=$(as_slot test -x "$DEPLOY_HOME")
say "shoslot_can_traverse_deploy_home=${deploy_home_traversable}   (deploy_home_exists=${deploy_home_exists})"

# The stale copies §4 mentions (18 of them, :305). Counted, and one named copy probed by path only.
bak_count=$(find /etc/sho -maxdepth 1 -name 'app.env.bak*' -type f 2>/dev/null | wc -l | tr -d ' ')
bak_probe='/etc/sho/app.env.bak-20261019-115253'
bak_exists=$(exists "$bak_probe")
bak_readable=$(as_slot test -r "$bak_probe")
say "prod_env_bak_count=${bak_count} shoslot_can_read_prod_env_bak=${bak_readable}   (probe_exists=${bak_exists})"

# The path Option N could not close: another uid's /proc entry (:247-249). Cross-uid ptrace is denied.
deploy_pid=$(pgrep -u deploy -n 2>/dev/null || true)
if [ -n "$deploy_pid" ]; then
  say "shoslot_can_read_deploy_environ=$(as_slot test -r "/proc/${deploy_pid}/environ")   (deploy_pid_present=1)"
else
  say "shoslot_can_read_deploy_environ=skipped   (deploy_pid_present=0)"
fi

# SSH persistence was the other durable path (:254).
say "shoslot_can_write_authorized_keys=$(as_slot test -w "$DEPLOY_HOME/.ssh/authorized_keys")"


say ""
say "== P2  runtime identity, and the SHAPE of its environment (counts and key names only) =="
pid=$(systemctl show -p MainPID --value "$UNIT_NAME" 2>/dev/null || true)
[ -n "$pid" ] && [ "$pid" != '0' ] || fail "${UNIT_NAME} has no MainPID - is it running? (R6)"
say "main_pid_present=1 run_uid=$(ps -o uid= -p "$pid" | tr -d ' ') run_user=$(ps -o user= -p "$pid" | tr -d ' ')"
environ_readable=$( if [ -r "/proc/${pid}/environ" ]; then echo 1; else echo 0; fi )
say "environ_readable=${environ_readable}"
env_key_count=$(tr '\0' '\n' < "/proc/${pid}/environ" | grep -c '=' || true)
say "environ_key_count=${env_key_count}   (a count of keys; no key and no value is printed)"
# :424 — the runtime environ must carry zero production markers.
runt_markers=$(tr '\0' '\n' < "/proc/${pid}/environ" | grep -cE "$MARKERS" || true)
say "environ_prod_marker_count=${runt_markers}"
say "slot_sees_its_own_environ=$(as_slot test -r "/proc/${pid}/environ")   (expect 0)"

say ""
say "== P3  the sandbox is applied by the SYSTEM manager, not a wrapper (contrast :250-253) =="
systemctl show "$UNIT_NAME" -p User -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p PrivateTmp \
  -p InaccessiblePaths -p RestrictNamespaces

say ""
say "== P4  the unit cannot silently regain the production env; the slot answers =="
# The unit loads FOUR EnvironmentFile sources. Grepping only for `EnvironmentFile=/etc/sho` covered one
# literal shape and missed the fourth source entirely: `current/release.env` is created by phase 2 AFTER
# the apply script exits, and a marker pasted there would be loaded at the next start. Enumerate every
# source the unit actually names, require each to live inside the slot tree, and scan each existing one.
unit_file="/etc/systemd/system/${UNIT_NAME}.service"
# One enumeration, shared with R4 (lib/unit-env-sources.sh). The previous version answered this with a
# `case` prefix glob, which `.../env/../../etc/sho/app.env` satisfies (a case pattern is a STRING glob),
# counted guards instead of matching them to sources, and never asked where a source resolves to — so a
# fifth, unguarded, out-of-tree source passed as `count=5 outside=0 guard=4`.
# shellcheck source=lib/unit-env-sources.sh
. "$UNIT_ENV_LIB"
src_out=$(unit_env_sources "$unit_file" "${SLOT_ROOT}/env" "${SLOT_ROOT}/current" || true)
# `|| true`: the lib exits 2 when it cannot read the unit, and under `set -e` that would abort with no
# verdict at all. An unreadable unit must FAIL the verdict, not end the run silently.
src_field() { printf '%s\n' "$src_out" | sed -n "s/^UNIT_${1}=//p"; }
unit_env_count=$(src_field ENVFILE_COUNT)
unit_env_existing=$(src_field ENV_EXISTING)
unit_env_outside=$(src_field ENV_OUTSIDE)
unit_env_unreadable=$(src_field ENV_UNREADABLE)
unit_env_unguarded=$(src_field ENV_UNGUARDED)
unit_env_prod=$(src_field ENV_PROD)
unit_env_guard=$(src_field ENV_GUARD)
# A lib that produced nothing must not read as a clean unit: every field is then empty and `-ne 0` would
# error out of the comparison (leaving gap unset would be worse).
for v in unit_env_count unit_env_existing unit_env_outside unit_env_unreadable unit_env_unguarded unit_env_prod unit_env_guard; do
  case "${!v}" in ''|*[!0-9]*) printf '%s\n' "WARNING ${v} unset - the enumeration did not answer" >&2; printf -v "$v" '%s' 99 ;; esac
done
say "unit_envfile_count=${unit_env_count} existing=${unit_env_existing} outside_slot=${unit_env_outside} unreadable=${unit_env_unreadable} unguarded=${unit_env_unguarded} prod_markers=${unit_env_prod} env_guard=${unit_env_guard}   (expect 4 / - / 0 / 0 / 0 / 0 / 4)"
listen_count=$(ss -ltn 2>/dev/null | grep -c ":${EXPECT_PORT} " || true)
say "listen_on_${EXPECT_PORT}_count=${listen_count}   (expect >=1)"
health_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" || echo 000)
say "health_http_code=${health_code}   (expect 200; 503 means the app cannot reach its database)"
# Release identity. src/app/api/health/route.ts:10 returns { ok, release: process.env.RELEASE }, so the
# release SHA is read from the app itself rather than guessed from a path. No env value is involved.
release=$(curl -s --max-time 5 "$HEALTH_URL" 2>/dev/null | sed -n 's/.*"release":"\([^"]*\)".*/\1/p' || true)
say "release_sha=${release:-unknown}"

say ""
say "== P5  DB identity unchanged and still slot-only (booleans; the DSN is never printed) =="
# Held in a variable, compared, then discarded. Only the boolean answers are echoed.
dsn=$(tr '\0' '\n' < "/proc/${pid}/environ" | grep -m1 '^DATABASE_URL=' | cut -d= -f2- || true)
say "dsn_present=$([ -n "${dsn:-}" ] && echo 1 || echo 0)"
say "dsn_is_loopback=$([ -n "${dsn:-}" ] && { case "$dsn" in *@127.0.0.1:*|*@localhost:*) echo 1 ;; *) echo 0 ;; esac; } || echo 0)"
say "dsn_port_5432=$([ -n "${dsn:-}" ] && { case "$dsn" in *:5432/*) echo 1 ;; *) echo 0 ;; esac; } || echo 0)"
say "dsn_prod_marker_count=$(printf '%s' "${dsn:-}" | grep -cE "$MARKERS" || true)   (expect 0)"
unset dsn

say ""
say "== VERDICT =="
# `if` blocks rather than `cond && gap=1`: under `set -e` a false `[ ]` in a bare `&&` list is a failing
# command and would abort the script mid-verdict.
gap=0
# INVERTED, and it was the whole verdict. `as_slot` echoes 0 when the probe SUCCEEDS (the slot could do
# it — the contract its own comment states, and the one the positive control depends on), and 1 when the
# probe fails. These three terms tested for 1, i.e. they set gap=1 exactly when containment HELD:
#   * a correct host (all three denied) printed gap_closed=0 PROOF=FAIL, every time, so the proof could
#     never confirm anything;
#   * a host where shoslot CAN read /etc/sho/app.env printed gap_closed=1 PROOF=PASS — the proof's own
#     headline claim, asserted green while the credential was readable (measured in the sandbox).
# 0 is the gap here; 1 is the denial that closes it.
if [ "$prod_env_readable" -eq 0 ]; then gap=1; fi
if [ "$deploy_home_traversable" -eq 0 ]; then gap=1; fi
if [ "$bak_readable" -eq 0 ]; then gap=1; fi
# The header's rule, now in the verdict: a denial over a path that does not exist proves nothing, so
# EXISTS is part of the answer. It used to be a WARNING only — the run printed gap_closed=1 with the
# prod env absent (measured in isolation).
if [ "$prod_env_exists" -eq 0 ]; then
  say "WARNING prod_env_exists=0 - a denial here proves nothing; check the path before trusting this run"
  gap=1
fi
# Same rule for the stale copies: if the count says copies exist but the named probe does not, the
# denial was measured against a missing file, not against a copy.
if [ "$bak_count" -gt 0 ] && [ "$bak_exists" -eq 0 ]; then
  say "WARNING prod_env_bak_count=${bak_count} but the named probe is absent - re-point bak_probe at a real copy"
  gap=1
fi
# A vanished /proc/<pid>/environ makes the marker count 0 for the wrong reason: an empty read is
# indistinguishable from a clean environ. `grep -c` still prints 0 when its input never opened
# (measured: dead pid -> key_count=0 marker_count=0 gap_closed=1), so readability is its own answer.
if [ "$environ_readable" -eq 0 ] || [ "$env_key_count" -eq 0 ]; then
  say "WARNING environ_unreadable - the zero marker count came from an empty read, not a clean environ"
  gap=1
fi
if [ "${runt_markers:-1}" -ne 0 ]; then gap=1; fi
if [ "$unit_env_prod" -ne 0 ]; then gap=1; fi
if [ "$unit_env_outside" -ne 0 ]; then gap=1; fi
if [ "$unit_env_unreadable" -ne 0 ]; then gap=1; fi
# Guard PARITY, not a guard count. `env_guard != 4` alone let a fifth source appended to the unit pass with
# four guards, because nothing tied a guard to the source it was supposed to guard.
if [ "$unit_env_unguarded" -ne 0 ]; then gap=1; fi
if [ "$unit_env_guard" -ne 4 ]; then gap=1; fi
# Exactly four: the unit is rendered by R4, so any other number means the file on disk is not what R4 wrote.
if [ "$unit_env_count" -ne 4 ]; then gap=1; fi
if [ "$health_code" != '200' ]; then gap=1; fi

say "gap_closed=$([ "$gap" -eq 0 ] && echo 1 || echo 0)"
if [ "$gap" -eq 0 ]; then
  say "PROOF=PASS  slot 9 runtime cannot read the production env, and the slot is healthy."
  exit 0
fi
say "PROOF=FAIL  the gap is NOT closed, or the slot is unhealthy. STOP: do not deploy, do not migrate." >&2
exit 1

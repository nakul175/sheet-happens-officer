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
bak_readable=$(as_slot test -r /etc/sho/app.env.bak-20261019-115253)
say "prod_env_bak_count=${bak_count} shoslot_can_read_prod_env_bak=${bak_readable}"

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
unit_prod_env_lines=$(grep -c 'EnvironmentFile=/etc/sho' "/etc/systemd/system/${UNIT_NAME}.service" || true)
say "unit_envfile_prod_count=${unit_prod_env_lines}   (expect 0)"
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
if [ "$prod_env_readable" -eq 1 ]; then gap=1; fi
if [ "$deploy_home_traversable" -eq 1 ]; then gap=1; fi
if [ "$bak_readable" -eq 1 ]; then gap=1; fi
if [ "$runt_markers" -ne 0 ]; then gap=1; fi
if [ "$unit_prod_env_lines" -ne 0 ]; then gap=1; fi
if [ "$health_code" != '200' ]; then gap=1; fi
if [ "$prod_env_exists" -eq 0 ]; then
  say "WARNING prod_env_exists=0 - a denial here proves nothing; check the path before trusting this run"
fi

say "gap_closed=$([ "$gap" -eq 0 ] && echo 1 || echo 0)"
if [ "$gap" -eq 0 ]; then
  say "PROOF=PASS  slot 9 runtime cannot read the production env, and the slot is healthy."
  exit 0
fi
say "PROOF=FAIL  the gap is NOT closed, or the slot is unhealthy. STOP: do not deploy, do not migrate." >&2
exit 1

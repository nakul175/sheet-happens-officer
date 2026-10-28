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
# THE OUTPUT RULE (W98). Every line this script prints is one of three things:
#   * a VERDICT TERM — `name=value`, where the name is in the verdict's own vocabulary and a bad value sets
#     `gap` (see term_fail). A term's value is compared, never merely displayed;
#   * `INFO …` — a line that deliberately cannot be a term, carrying the reason it cannot be one;
#   * a fixed `== … ==` section header, or the CONTAINMENT=/PROOF= verdict line itself.
# Nothing else. The rule exists because P3 printed `systemctl show -p User … -p InaccessiblePaths` and nothing
# consumed it: a unit with User=root and an empty InaccessiblePaths= printed CONTAINMENT=PASS, and a
# `shoslot_can_write_authorized_keys` printed next to real terms read as if it gated the verdict too.
# scripts/containment/proof-verdict-terms.test.mjs enforces the rule over the whole transcript.
#
# TWO GATES, ONE DIRECTION. The rule this serves is "no candidate execution on slot 9 until PROOF=PASS",
# but that rule used to be circular: P2 needs a MainPID, and R6 exits 4 until phase 2 has started the unit,
# so the only achievable order was start-the-candidate -> then prove it should not have started.
#   * `--pre-start` (alias `--containment`) authorises the FIRST start. It answers only the questions that
#     exist with no process running: the positive control, P1's uid/denial probes, P3's sandbox properties,
#     and P4's static EnvironmentFile enumeration. It SKIPS P2, P5, the listener, health and release.
#     It prints CONTAINMENT=PASS|FAIL and exits 0|1.
#   * The full run (no flag) keeps its P1..P5 contract, still prints PROOF=PASS|FAIL, and now also prints
#     CONTAINMENT=... BEFORE gap_closed=/PROOF= so one run can never be mistaken for the other gate.
# ORDERING: the pre-start gate authorises the first start; the full run is a POST-START revocation check and
# can only retract that authorisation, never grant one.
#
# NO FLAG AUTHORISES AN UNRUN CONTROL (W150, W102 F3). Every control that could not be measured used to have a
# way out: the cross-uid /proc probe could be waived with `--accept-unproven`, and the pre-start gate then
# printed `CONTAINMENT=PASS` over a control that never ran. That flag is GONE, refused (exit 2) if it is still
# passed, and the unrun control is a FAIL by name (`deploy_environ_unproven`) in both modes - so the sentence
# "it may be started" is only ever printed after every control answered. A qualifier on a PASS is not a
# mitigation; it is the same authorisation with a footnote.
#
# Exit: 0 gate passed · 1 gate FAILED (pre-start: do not start the unit · full: do not deploy) · 2 refused
# precondition (not root, not Linux, account absent, unit file absent, positive control broken, bad argument)
set -euo pipefail

readonly UNIT_NAME='sho-pr9'
readonly SLOT_ACCOUNT='shoslot'
readonly PROD_ENV='/etc/sho/app.env'
# The directory the production env lives in. A separate variable because the copy policy below enumerates the
# WHOLE directory, not one path, and a reader should see that in one place rather than in a hard-coded glob.
readonly PROD_ENV_DIR='/etc/sho'
readonly DEPLOY_HOME='/home/deploy'
readonly EXPECT_PORT='3109'
readonly MARKERS='defaultdb|doadmin|25061|sho-prod-pool'   # :334
readonly SLOT_ROOT='/home/shoslot/pr9'                      # :325-327 — the only tree a source may live in
readonly MARKER_SCAN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/prod-marker-scan.sh"
readonly UNIT_ENV_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/unit-env-sources.sh"
readonly HEALTH_URL="http://127.0.0.1:${EXPECT_PORT}/api/health"
# Declared here because the pre-start gate refuses (exit 2) when R4 has not rendered it yet, which happens
# before P4 runs.
readonly UNIT_FILE="/etc/systemd/system/${UNIT_NAME}.service"

say()  { printf '%s\n' "$*"; }
fail() { printf 'REFUSING: %s\n' "$*" >&2; exit 2; }

# MODE=prestart is the gate that may run against a stopped unit; MODE=full is the historical proof block.
MODE='full'
# NO FLAG MAY ACCEPT AN UNRUN CONTROL (W150, W102 F3). There used to be `--accept-unproven`, and with it an
# unrun cross-uid /proc probe printed a `CONTAINMENT=PASS` line carrying an `unproven` qualifier (naming
# deploy_environ), and a full run printed `PROOF=PASS` beside it. That is a route to authorisation, and the red
# team read it as one - correctly: a verdict line in the PASS column is what a start decision is made on, and a
# qualifier beside it is negotiable. So the variable, the assignment and the qualifier are all gone rather than
# downgraded: an unrun control FAILS by name (`deploy_environ_unproven`) in BOTH modes, and the old spelling is
# REFUSED (exit 2) instead of being ignored, so a stale invocation cannot quietly keep working against a verdict
# that no longer honours it. The string a reader would grep for is absent from this file on purpose.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pre-start|--containment) MODE='prestart' ;;
    --accept-unproven)
      fail "--accept-unproven was REMOVED (W150, W102 F3): an unrun cross-uid probe is a FAIL (deploy_environ_unproven) in both modes and no flag converts it into a PASS. The remedy is a deploy-owned process to probe, not an opt-out" ;;
    *)                         fail "unknown argument '$1'; usage: ${0##*/} [--pre-start|--containment]" ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || fail "must be run as root (it uses sudo -u ${SLOT_ACCOUNT} to test another uid's rights)"
[ "$(uname -s)" = 'Linux' ] || fail "not Linux; this is the staging host's proof block"
id -u "$SLOT_ACCOUNT" >/dev/null 2>&1 || fail "account ${SLOT_ACCOUNT} does not exist - run slot9-optionR.sh first"
# A real precondition, not a verdict: with no unit file there is nothing to be contained, and answering
# "CONTAINMENT=PASS" would be a statement about a unit that does not exist. Only the pre-start gate refuses
# here - the full run keeps its contract (its P4 enumeration fails the verdict instead).
if [ "$MODE" = 'prestart' ] && [ ! -e "$UNIT_FILE" ]; then
  fail "${UNIT_FILE} is absent - R4 has not rendered the unit yet, so there is nothing to contain"
fi

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

# --- THE VERDICT'S VOCABULARY ---------------------------------------------------------------------------
# A failing term is NAMED on stdout (`containment_terms_failed=` / `proof_terms_failed=`), so a FAIL always
# says which control failed instead of leaving the reader to diff two transcripts. The list is the verdict's,
# not a section's: a term raised in P1, P3 or the post-start block lands in the same place, which is what makes
# "every line is a term" checkable rather than decorative.
term_failures=''
term_fail() {
  gap=1
  case " ${term_failures} " in
    *" $1 "*) ;;
    *) term_failures="${term_failures:+${term_failures},}$1" ;;
  esac
}

# The containment properties, and the value each must hold. These are render_unit()'s values
# (slot9-optionR.sh) - NOT a second opinion: proof-verdict-terms.test.mjs extracts render_unit() and fails if
# this table and the rendered unit ever disagree, so the requirement cannot drift away from the unit that is
# actually installed. A leading `~` means "contains" (systemd renders InaccessiblePaths= as a list).
# Entries are space-free on purpose: the loop below word-splits the table.
readonly SANDBOX_REQUIRED='User=shoslot
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
~InaccessiblePaths=/etc/sho
RestrictNamespaces=yes'
readonly SANDBOX_TERM_COUNT=7

# systemd's own rendering of one property, or empty when the unit does not set it. An unset property is NOT a
# satisfied one: empty never equals a required value and never contains one.
sb_get() {
  printf '%s\n' "${sandbox_raw:-}" |
    awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }'
}

# Every containment property, printed and JUDGED. This is the section that used to be a bare
# `systemctl show` display: it answered `User=root` and `InaccessiblePaths=` and the verdict never looked.
assess_sandbox_properties() {
  local entry prop want mode got ok judged
  judged=0
  for entry in $SANDBOX_REQUIRED; do
    mode='equals'
    case "$entry" in
      '~'*) mode='contains'; entry="${entry:1}" ;;
    esac
    prop=${entry%%=*}
    want=${entry#*=}
    got=$(sb_get "$prop")
    ok=0
    if [ "$mode" = 'contains' ]; then
      say "sandbox_${prop}=${got:-absent}   (required contains ${want})"
      case " ${got} " in *" ${want} "*) ok=1 ;; esac
    else
      say "sandbox_${prop}=${got:-absent}   (required ${want})"
      if [ "$got" = "$want" ]; then ok=1; fi
    fi
    if [ "$ok" -ne 1 ]; then term_fail "sandbox_${prop}"; fi
    judged=$((judged + 1))
  done
  # A term that never runs is not an assertion. If the table or the loop is ever cut short, the count says so.
  say "sandbox_terms_judged=${judged}   (required ${SANDBOX_TERM_COUNT})"
  if [ "$judged" -ne "$SANDBOX_TERM_COUNT" ]; then term_fail sandbox_terms_judged; fi
  sandbox_terms_judged=$judged
}

# THE CONTAINMENT TERMS — every one of them answers with no process running, which is exactly why the
# pre-start gate and the full run share this one function instead of each keeping a copy that could drift
# apart (the failure mode this repo has already paid for once: two prefix globs answering one question).
# Sets `gap`: 0 = containment holds, 1 = it does not (the accumulator name the full verdict already used).
#
# INVERTED, and it was the whole verdict. `as_slot` echoes 0 when the probe SUCCEEDS (the slot could do it
# - the contract its own comment states, and the one the positive control depends on), and 1 when the probe
# fails. These terms used to compare with 1, i.e. they set the gap exactly when containment HELD:
#   * a correct host (all three denied) printed gap_closed=0 PROOF=FAIL, every time, so the proof could
#     never confirm anything;
#   * a host where shoslot CAN read /etc/sho/app.env printed gap_closed=1 PROOF=PASS - the proof's own
#     headline claim, asserted green while the credential was readable (measured in the sandbox).
# 0 is the gap here; 1 is the denial that closes it.
assess_containment() {
  gap=0
  if [ "$prod_env_readable" -eq 0 ]; then gap=1; fi
  if [ "$deploy_home_traversable" -eq 0 ]; then gap=1; fi
  # Every env-shaped copy the policy names, not one path: 1 = the slot was denied ALL of them. Named, so the
  # FAIL says which control failed (and a copy under a name the old `app.env.bak*` glob never matched now
  # fails here instead of passing unseen).
  if [ "$stale_denied" -ne 1 ]; then term_fail shoslot_can_read_stale_copy; fi
  # The header's rule, in the verdict: a denial over a path that does not exist proves nothing, so EXISTS is
  # part of the answer. It used to be a WARNING only - the run printed gap_closed=1 with the prod env absent.
  if [ "$prod_env_exists" -eq 0 ]; then
    say "prod_env_exists=0   (required 1: a denial measured against a missing path proves nothing)"
    term_fail prod_env_exists
  fi
  # Same rule for the stale copies, and it is why EXISTS is a term of its own rather than a precondition of
  # the readability answer: `test -r` on a path that is not there also says "denied", so the number of copies
  # CONFIRMED PRESENT must equal the number the policy counted, or a denial was measured against a missing
  # path. A copy that exists but cannot be read still means a copy exists - that is the term.
  if [ "${stale_exists}" -ne "${stale_count}" ]; then
    say "prod_env_stale_exists=${stale_exists}   (required ${stale_count}: every copy the policy counted must be confirmed present before its denial counts)"
    term_fail prod_env_stale_exists
  fi
  # An /etc/sho that could not be enumerated makes the count 0 for the wrong reason. Fail closed, by name.
  if [ "${stale_scan}" -ne 1 ]; then term_fail prod_env_stale_scan; fi
  if [ "$unit_env_prod" -ne 0 ]; then term_fail prod_markers; fi
  if [ "$unit_env_outside" -ne 0 ]; then term_fail outside_slot; fi
  if [ "$unit_env_unreadable" -ne 0 ]; then term_fail unreadable; fi
  # Guard PARITY, not a guard count. `env_guard != 4` alone let a fifth source appended to the unit pass
  # with four guards, because nothing tied a guard to the source it was supposed to guard.
  if [ "$unit_env_unguarded" -ne 0 ]; then term_fail unguarded; fi
  if [ "$unit_env_guard" -ne 4 ]; then term_fail env_guard; fi
  # Exactly four: the unit is rendered by R4, so any other number means the file on disk is not what R4 wrote.
  if [ "$unit_env_count" -ne 4 ]; then term_fail unit_envfile_count; fi

  # --- THE CONTROLS THE CONTAINMENT IS MADE OF (W98) -----------------------------------------------------
  # P3 printed these and nothing consumed them. A `User=root` unit with an empty `InaccessiblePaths=` printed
  # CONTAINMENT=PASS because the only thing looking at a uid was a probe run AS the slot, which is contained
  # by definition - it cannot ask "am I root?". The unit's own properties are asserted here instead, from
  # `systemctl show`, which answers for an inactive unit, so --pre-start keeps working without a process.
  assess_sandbox_properties
  if [ "${sandbox_terms_judged:-0}" -ne "$SANDBOX_TERM_COUNT" ]; then term_fail sandbox_terms_judged; fi

  # SSH persistence. uid separation does not stop the slot from appending a key to the deployer's
  # authorized_keys, so this is a term, not a line printed beside terms. `as_slot` echoes 0 when the write
  # SUCCEEDS, so 1 (denied) is the required answer - the same inversion the rest of the verdict uses.
  if [ "$authkeys_write" -ne 1 ]; then term_fail shoslot_can_write_authorized_keys; fi

  # The cross-uid /proc proof - the one negative proof that needs a second uid at runtime. `skipped` used to be
  # printed when no deploy-owned process existed, which read like a passing term. An unrun probe is not a
  # denial: it FAILS, by name, and there is no argument that turns it into a PASS (W150 removed the old
  # opt-out). Otherwise a PASS could be earned by not measuring - which is exactly what F3 recorded.
  if [ "$deploy_environ_probeable" -eq 1 ]; then
    if [ "$deploy_environ_denied" -ne 1 ]; then term_fail shoslot_can_read_deploy_environ; fi
  else
    term_fail deploy_environ_unproven
  fi

  # A term raised before this point (P1, P3) still has to close the gap: term_fail sets `gap`, but `gap=0`
  # above is the function's own reset, so the accumulated names are folded back in here - one accumulator,
  # so a term cannot be printed somewhere the verdict does not read.
  if [ -n "$term_failures" ]; then gap=1; fi
  say "containment_terms_failed=${term_failures:-none}"
}

say ""
say "== P1  THE gap-closing proof: uid separation denies the credential =="
# INFO, not a term: the uids are context for the probes below. The uid separation itself is asserted statically
# by sandbox_User (the unit's User=) and measured by shoslot_can_read_prod_env - a probe run AS the slot cannot
# answer "am I root?", which is exactly the hole the sandbox terms close.
say "INFO slot_uid=$(id -u "$SLOT_ACCOUNT") deploy_uid=$(id -u deploy 2>/dev/null || echo absent) uids_differ=$( [ "$(id -u "$SLOT_ACCOUNT")" != "$(id -u deploy 2>/dev/null || echo x)" ] && echo 1 || echo 0 ) - not a verdict term: two uids differing says nothing about which one the unit runs as (see sandbox_User)"

prod_env_exists=$(exists "$PROD_ENV")
prod_env_readable=$(as_slot test -r "$PROD_ENV")
say "shoslot_can_read_prod_env=${prod_env_readable}   (required 1 = denied; prod_env_exists=${prod_env_exists})"

deploy_home_exists=$(exists "$DEPLOY_HOME")
deploy_home_traversable=$(as_slot test -x "$DEPLOY_HOME")
say "shoslot_can_traverse_deploy_home=${deploy_home_traversable}   (required 1 = denied; deploy_home_exists=${deploy_home_exists})"

# --- STALE COPIES OF THE PRODUCTION ENV (W102 F1, HIGH) ------------------------------------------------
# POLICY, in words: an ENV-SHAPED COPY is any regular file or symlink ANYWHERE under ${PROD_ENV_DIR} whose
# basename is a name this app uses to hold environment variables - `app.env` plus any suffix (`app.env.old`,
# `app.env.save`, `app.env.bak-20261019-115253`, `app.env~`, `app.env-2026`), `release.env` plus any suffix,
# or any other `*.env` file with or without one (`db.env`, `db.env.old`, `local.env.save`, `*.env~`).
# Anywhere, not just beside app.env: the unit loads NOTHING from that directory (P4 asserts all four
# EnvironmentFile sources resolve under the slot tree), so an env-named file one level down is a copy for the
# same reason one beside app.env is, and a top-level-only scan would be the old blind spot with a new depth.
# A SYMLINKED DIRECTORY under ${PROD_ENV_DIR} is followed, not skipped (W119). "Anywhere under /etc/sho" is a
# PATH, not a filesystem subtree: `ln -s /var/backups/sho-envs /etc/sho/previous` makes the slot read a copy by
# a path that starts with /etc/sho, and plain `find` does not descend into a directory link and does not match
# the link's own name against the env patterns - so every copy behind it was invisible to the count AND the
# probe, which is F1's exact failure mode one indirection further out. `-L` closes it by enumerating both; a
# loop it cannot resolve makes find exit non-zero, which FAILS the scan term rather than passing quietly.
# Not "everything in /etc/sho": a directory of READMEs and certs is not a directory of env copies, and a term
# that fires on `*.pem` would be measuring something else. Two exclusions, both deliberate:
#   * the live ${PROD_ENV} - it is the credential the headline claim is about, and it already has its own
#     EXISTS + DENIED pair (prod_env_exists / shoslot_can_read_prod_env). Counting it here as well would make
#     prod_env_stale_count nonzero on a host with no copies at all, so the count would stop meaning "copies"
#     and one term would silently answer the other term's question.
#   * documentation/template names (`*.example`, `*.sample`, `*.template`, `*.tmpl`, `*.dist`). They carry
#     placeholders, not a credential; failing a host for a world-readable `.env.example` would be a gate
#     nobody can pass, and a check that flags the legitimate file is not a fix.
# `release.env` under ${PROD_ENV_DIR} counts - it is NOT the file the unit loads. The unit's release.env is
# ${SLOT_ROOT}/current/release.env, and P4 already asserts that it resolves inside the slot tree
# (outside_slot). A release.env in the production env directory is a production artifact by definition, so it
# is a copy; counting it costs a correct host nothing, because PASS only requires that the slot cannot READ it.
# WHY THIS IS ENUMERATION AND NOT A GLOB: the old code counted `-name 'app.env.bak*'` and probed ONE hard-coded
# path. Both are naming conventions, so `app.env.old`, `release.env.2026` and `app.env.save` were invisible to
# the count AND the probe, and a slot that could read one still printed CONTAINMENT=PASS. The suffix is now
# irrelevant: every file the policy names is counted and every counted file is probed, by path, one by one.
# FAIL CLOSED ON THE ENUMERATION ITSELF: if `find` cannot walk the directory (absent, unreadable, or it gives
# up part-way through), the count would be 0 for the wrong reason - an unmeasured "no copies". pipefail makes
# that a FAIL by name (prod_env_stale_scan) rather than a silent pass.
stale_scan=1
stale_list=''
if [ -d "$PROD_ENV_DIR" ] && [ -r "$PROD_ENV_DIR" ] && [ -x "$PROD_ENV_DIR" ]; then
  # shellcheck disable=SC2016  # the single-quoted -name patterns are find's, not the shell's
  # `-L`: follow a symlink, file or DIRECTORY, so a copy behind a link is enumerated too (see the policy above).
  stale_list=$(find -L "$PROD_ENV_DIR" \( -type f -o -type l \) \
    \( -name 'app.env*' -o -name 'release.env*' -o -name '*.env' \
       -o -name '*.env.*' -o -name '*.env-*' -o -name '*.env~' \) \
    ! -name '*.example' ! -name '*.sample' ! -name '*.template' ! -name '*.tmpl' ! -name '*.dist' \
    ! -path "$PROD_ENV" 2>/dev/null | LC_ALL=C sort) || stale_scan=0
else
  stale_scan=0
fi
stale_count=0
stale_exists=0
stale_readable=0
stale_names=''
while IFS= read -r stale_path; do
  [ -n "$stale_path" ] || continue
  stale_count=$((stale_count + 1))
  # Basenames only, and sanitized: the transcript lists WHICH copies were measured, and a filename with a
  # space, paren or `=` in it must not be able to make the line stop parsing as a term line. Never a value.
  case "${stale_path##*/}" in
    *[!A-Za-z0-9._+~-]*) stale_names="${stale_names:+${stale_names},}?" ;;
    *)                   stale_names="${stale_names:+${stale_names},}${stale_path##*/}" ;;
  esac
  # EXISTS is its own answer, checked as root so a permission bit cannot turn "absent" into "denied".
  if [ -e "$stale_path" ]; then
    stale_exists=$((stale_exists + 1))
    # And the read attempt is `test -r` as the slot: a boolean, never a value, one probe per copy.
    if [ "$(as_slot test -r "$stale_path")" -eq 0 ]; then
      stale_readable=$((stale_readable + 1))
    fi
  fi
done <<< "${stale_list}"
stale_denied=1
if [ "$stale_readable" -ne 0 ]; then stale_denied=0; fi
say "prod_env_stale_count=${stale_count} prod_env_stale_exists=${stale_exists} prod_env_stale_scan=${stale_scan} shoslot_can_read_stale_copy=${stale_denied}   (required exists=${stale_count} scan=1 and 1 = denied for EVERY copy; readable_by_slot=${stale_readable}/${stale_count}; names=${stale_names:-none})"

# The path Option N could not close: another uid's /proc entry (:247-249). Cross-uid ptrace is denied.
# THE variable is `deploy_environ_probeable`: it, not the printed line, decides whether the verdict has a
# measurement. The old code printed `skipped` here and moved on, so a host with no deploy-owned process earned
# a PASS by never asking the question.
deploy_environ_probeable=0
deploy_environ_denied=1
deploy_pid=$(pgrep -u deploy -n 2>/dev/null || true)
if [ -n "$deploy_pid" ]; then
  deploy_environ_probeable=1
  deploy_environ_denied=$(as_slot test -r "/proc/${deploy_pid}/environ")
  say "deploy_environ_probe=probeable   (deploy_pid_present=1)"
  say "shoslot_can_read_deploy_environ=${deploy_environ_denied}   (required 1 = denied)"
else
  say "deploy_environ_probe=not_probeable   (deploy_pid_present=0: pgrep -u deploy found no process)"
  # The reason it cannot be a term, and the reason it cannot be waived, in one line. Deliberately no `name=value`
  # shape: there is nothing here to compare with, because nothing was measured.
  say "INFO the cross-uid probe did NOT run - not a verdict term and not a denial, and no flag can accept it (--accept-unproven was removed, W150), so containment_terms_failed names deploy_environ_unproven and this run FAILS. remedy: rerun while a deploy-owned process is alive (the production sho unit always is one)"
fi

# SSH persistence was the other durable path (:254). A term: uid separation does not remove it, so a slot that
# can append a key to the deployer's authorized_keys has a way back in that no other probe would notice.
# EXISTS is a term here too (W102): `test -w <missing file>` answers "denied", so on a host with no
# authorized_keys the passing value meant "there was no key file to plant a key in", not "the slot is denied".
# That is the same vacuity the header forbids for /etc/sho/app.env, and it made the SSH control unmeasured
# while CONTAINMENT=PASS was printed. A host that really has no authorized_keys fails this term on purpose:
# the control cannot be observed there, so the proof says so instead of banking a denial it never measured.
authkeys_exists=$(exists "${DEPLOY_HOME}/.ssh/authorized_keys")
authkeys_write=$(as_slot test -w "${DEPLOY_HOME}/.ssh/authorized_keys")
say "shoslot_can_write_authorized_keys=${authkeys_write}   (required 1 = denied; authkeys_exists=${authkeys_exists})"
if [ "$authkeys_exists" -eq 0 ]; then
  term_fail authorized_keys_absent
fi


# P2 needs a MainPID, so it is the one section the pre-start gate cannot and must not answer.
if [ "$MODE" != 'prestart' ]; then
say ""
say "== P2  runtime identity, and the SHAPE of its environment (counts and key names only) =="
pid=$(systemctl show -p MainPID --value "$UNIT_NAME" 2>/dev/null || true)
[ -n "$pid" ] && [ "$pid" != '0' ] || fail "${UNIT_NAME} has no MainPID - is it running? (R6)"
say "INFO main_pid_present=1 run_uid=$(ps -o uid= -p "$pid" | tr -d ' ') run_user=$(ps -o user= -p "$pid" | tr -d ' ') - not a verdict term: the static User= is already judged (sandbox_User), and every term this run adds below is read without a MainPID so --pre-start can answer the same questions"
environ_readable=$( if [ -r "/proc/${pid}/environ" ]; then echo 1; else echo 0; fi )
say "environ_readable=${environ_readable}   (required 1: an unreadable environ makes a zero marker count meaningless)"
env_key_count=$(tr '\0' '\n' < "/proc/${pid}/environ" | grep -c '=' || true)
say "environ_key_count=${env_key_count}   (required >=1; a count of keys, and no key or value is printed)"
# :424 — the runtime environ must carry zero production markers.
runt_markers=$(tr '\0' '\n' < "/proc/${pid}/environ" | grep -cE "$MARKERS" || true)
say "environ_prod_marker_count=${runt_markers}   (required 0)"
say "INFO slot_sees_its_own_environ=$(as_slot test -r "/proc/${pid}/environ") - not a verdict term: reading its own /proc entry is not a containment path, the cross-uid read is (shoslot_can_read_deploy_environ)"
fi

say ""
say "== P3  the sandbox is applied by the SYSTEM manager, asserted property by property (contrast :250-253) =="
# MEASURED here, JUDGED in assess_containment (assess_sandbox_properties): the terms are printed where they are
# read, and the verdict they feed is the same accumulator both gates use. One call, because a property asked
# twice can be answered twice. An inactive unit still answers, which is why --pre-start keeps working.
sandbox_raw=$(systemctl show "$UNIT_NAME" -p User -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p PrivateTmp \
  -p InaccessiblePaths -p RestrictNamespaces 2>/dev/null || true)
if [ -z "$sandbox_raw" ]; then
  # A manager that answers nothing is not a manager that answered "yes": every property below then reads
  # `absent` and fails, which is the correct verdict for "the unit's sandbox could not be read".
  say "INFO systemctl show returned nothing - not a verdict term in itself: the per-property terms below then read absent, and absent never matches a required value"
fi

say ""
say "== P4  the unit cannot silently regain the production env; the slot answers =="
# The unit loads FOUR EnvironmentFile sources. Grepping only for `EnvironmentFile=/etc/sho` covered one
# literal shape and missed the fourth source entirely: `current/release.env` is created by phase 2 AFTER
# the apply script exits, and a marker pasted there would be loaded at the next start. Enumerate every
# source the unit actually names, require each to live inside the slot tree, and scan each existing one.
unit_file="$UNIT_FILE"
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
  case "${!v}" in ''|*[!0-9]*) printf '%s\n' "INFO ${v} unset - not a verdict term: the enumeration did not answer, so every P4 counter above reads 99 and fails" >&2; printf -v "$v" '%s' 99 ;; esac
done
say "unit_envfile_count=${unit_env_count} existing=${unit_env_existing} outside_slot=${unit_env_outside} unreadable=${unit_env_unreadable} unguarded=${unit_env_unguarded} prod_markers=${unit_env_prod} env_guard=${unit_env_guard}   (expect 4 / - / 0 / 0 / 0 / 0 / 4)"

# --- PRE-START GATE -------------------------------------------------------------------------------------
# Everything this gate needs has been measured above, and none of it needed a process. Nothing below this
# point is answerable with the unit stopped (P2's MainPID, P5's environ, the listener, health, release), so
# this is the exit that authorises the FIRST start. Before it existed, the only order that worked was
# start-the-candidate and then prove it should not have started - the circularity this mode removes.
if [ "$MODE" = 'prestart' ]; then
  say ""
  say "== VERDICT (pre-start containment gate; P2/P5/listener/health not applicable to a stopped unit) =="
  assess_containment
  if [ "$gap" -eq 0 ]; then
    say "CONTAINMENT=PASS  the slot cannot reach the production env while the unit is stopped; it may be started."
    exit 0
  fi
  say "CONTAINMENT=FAIL  containment does NOT hold with the unit stopped."
  say "STOP: do not start it." >&2
  exit 1
fi

# From here on a started unit is assumed. These terms can only retract the pre-start verdict.
if [ "$MODE" != 'prestart' ]; then
listen_count=$(ss -ltn 2>/dev/null | grep -c ":${EXPECT_PORT} " || true)
say "listen_on_${EXPECT_PORT}_count=${listen_count}   (expect >=1)"
health_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" || echo 000)
say "health_http_code=${health_code}   (expect 200; 503 means the app cannot reach its database)"
# Release identity. src/app/api/health/route.ts:10 returns { ok, release: process.env.RELEASE }, so the
# release SHA is read from the app itself rather than guessed from a path. No env value is involved.
release=$(curl -s --max-time 5 "$HEALTH_URL" 2>/dev/null | sed -n 's/.*"release":"\([^"]*\)".*/\1/p' || true)
say "release_sha=${release:-unknown}"
fi


say ""
say "== P5  DB identity unchanged and still slot-only (booleans; the DSN is never printed) =="
# Held in a variable, compared, then discarded. Only the boolean answers are echoed.
dsn=$(tr '\0' '\n' < "/proc/${pid}/environ" | grep -m1 '^DATABASE_URL=' | cut -d= -f2- || true)
dsn_present=0; dsn_is_loopback=0; dsn_port_5432=0
if [ -n "${dsn:-}" ]; then
  dsn_present=1
  case "$dsn" in *@127.0.0.1:*|*@localhost:*) dsn_is_loopback=1 ;; esac
  case "$dsn" in *:5432/*) dsn_port_5432=1 ;; esac
fi
dsn_prod_marker_count=$(printf '%s' "${dsn:-}" | grep -cE "$MARKERS" || true)
unset dsn
say "INFO dsn_present=${dsn_present} dsn_is_loopback=${dsn_is_loopback} dsn_port_5432=${dsn_port_5432} - not a verdict term: the slot may rewrite its own DSN at will, so the P5 answer is environ_prod_marker_count (the runtime environ scan), and no value of the DSN is ever printed"
say "INFO dsn_prod_marker_count=${dsn_prod_marker_count} - not a verdict term: it repeats environ_prod_marker_count over the slot's own variable rather than the process environ"

say ""
say "== VERDICT =="
# `if` blocks rather than `cond && gap=1`: under `set -e` a false `[ ]` in a bare `&&` list is a failing
# command and would abort the script mid-verdict.
# The containment terms are the SAME function the pre-start gate runs, so the two gates cannot drift: a
# CONTAINMENT=FAIL here retracts what --pre-start authorised, and neither gate can lend the other a PASS.
assess_containment
# Printed BEFORE gap_closed=/PROOF= on purpose: this is the pre-start gate's answer, and one run must never
# be mistakable for the other gate.
say "CONTAINMENT=$([ "$gap" -eq 0 ] && echo PASS || echo FAIL)   (terms that need no running process)"
# Everything below needs a started unit, so it can only retract the verdict above.
# A vanished /proc/<pid>/environ makes the marker count 0 for the wrong reason: an empty read is
# indistinguishable from a clean environ. `grep -c` still prints 0 when its input never opened
# (measured: dead pid -> key_count=0 marker_count=0 gap_closed=1), so readability is its own answer.
if [ "$environ_readable" -eq 0 ] || [ "$env_key_count" -eq 0 ]; then
  # Named, because "the marker count is zero" and "the marker count is zero because nothing was read" are the
  # same transcript line otherwise. Both terms were already printed in P2 with their required values.
  if [ "$environ_readable" -eq 0 ]; then term_fail environ_readable; fi
  if [ "$env_key_count" -eq 0 ]; then term_fail environ_key_count; fi
  gap=1
fi
if [ "${runt_markers:-1}" -ne 0 ]; then term_fail environ_prod_marker_count; fi
if [ "$health_code" != '200' ]; then term_fail health_http_code; fi
# W102: the listener line printed its own expectation "(expect >=1)" and no term read it, so a host without
# iproute2 (`ss` absent) printed listen_on_3109_count=0 and still reached PROOF=PASS. An unmeasured count is
# not a satisfied one - the same rule the environ and health terms above follow.
case "${listen_count:-}" in
  ''|*[!0-9]*) term_fail listen_on_3109_count ;;
  *) if [ "$listen_count" -lt 1 ]; then term_fail listen_on_3109_count; fi ;;
esac

# The complete list, after the post-start terms have joined the pre-start ones. `containment_terms_failed=`
# above answers the pre-start gate; this one answers this run, and a reader can tell which is which by name.
say "proof_terms_failed=${term_failures:-none}"
say "gap_closed=$([ "$gap" -eq 0 ] && echo 1 || echo 0)"
if [ "$gap" -eq 0 ]; then
  say "PROOF=PASS  slot 9 runtime cannot read the production env, and the slot is healthy."
  exit 0
fi
say "PROOF=FAIL  the gap is NOT closed, or the slot is unhealthy. STOP: do not deploy, do not migrate." >&2
exit 1

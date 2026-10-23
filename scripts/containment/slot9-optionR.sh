#!/usr/bin/env bash
# ============================================================================
# SHO SLOT 9 CONTAINMENT — Option R, staging host only, RUN AS ROOT.
# ============================================================================
#
# This is OS-IDENTITY-ISOLATION.md §5 (R1–R6) turned into one fail-closed unit. Every literal below is
# traceable to that document; nothing here is invented:
#
#   hostname aplyd-productivity-suite .......... :44   (measured `hostname`)
#   deploy uid/gid 1000 ........................ :43
#   unit name/path sho-pr9.service .............. :338
#   slot port 3109 .............................. :340, :403, :433
#   account shoslot, /usr/sbin/nologin .......... :321
#   slot tree /home/shoslot/pr9{,/env,/var,/log}  :325-327
#   env source /home/deploy/preview/pr9/env/* ... :331-333
#   production markers .......................... :334
#   sudoers file /etc/sudoers.d/50-sho-pr9 ...... :377-379
#   phase-2 precondition `current` .............. :389
#   rollback .................................... :453-457
#
# DIFFERENCES FROM §5, each one deliberate (see CONTAINMENT-RUNBOOK.md):
#   D1. §5's R3 *echoes* "ABORT" and continues into R4/R6, so a slot carrying a production marker would
#       still be installed and started. Here a marker exits 3 and nothing after it runs.
#   D2. §5 writes the sudoers file and only then runs `visudo -c`. A malformed file in /etc/sudoers.d
#       can cost you sudo entirely. Here it is validated on a temp path first, then moved into place,
#       then re-validated.
#   D3. §5's R1/R2/R3 are not re-runnable. Here they are: an existing correct account is verified, not
#       re-created, and an existing slot env is left alone unless --refresh-env is given.
#   D4. §5 assumes `systemctl`/`visudo` live at fixed paths. Here they are resolved with `command -v`
#       and the resolved absolute path is written into the sudoers rule, so a different prefix cannot
#       produce a rule that silently does nothing.
#
# USAGE (root, on the staging host):
#   bash slot9-optionR.sh                 # R1..R6, or stop at the first failed precondition
#   bash slot9-optionR.sh --check         # print the plan + rendered unit; changes NOTHING; needs no root
#   bash slot9-optionR.sh --refresh-env   # also overwrite the copied slot env from the deploy originals
#   bash slot9-optionR.sh --rollback      # R7: return the slot to its current (stopped) state
#
# EXIT CODES: 0 done · 2 refused (precondition) · 3 env contaminated · 4 phase-2 code missing
# NEVER prints a value from an env file. Output is uids, counts, booleans and systemd property names.
set -euo pipefail

readonly UNIT_NAME='sho-pr9'
readonly UNIT_PATH='/etc/systemd/system/sho-pr9.service'
readonly ACCOUNT='shoslot'
readonly SLOT_HOME='/home/shoslot'
readonly SLOT_ROOT='/home/shoslot/pr9'
readonly CURRENT_DIR='/home/shoslot/pr9/current'
readonly ENV_DIR='/home/shoslot/pr9/env'
readonly SRC_ENV_DIR='/home/deploy/preview/pr9/env'
readonly SUDOERS_PATH='/etc/sudoers.d/50-sho-pr9'
readonly EXPECT_HOST='aplyd-productivity-suite'   # :44
readonly SLOT_PORT='3109'                          # :340
readonly DEPLOY_UID='1000'                         # :43
readonly MARKER_SCAN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/prod-marker-scan.sh"

MODE='apply'
REFRESH_ENV=0

say()  { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf 'REFUSING: %s\n' "$*" >&2; exit 2; }

for arg in "$@"; do
  case "$arg" in
    --check)       MODE='check' ;;
    --rollback)    MODE='rollback' ;;
    --refresh-env) REFRESH_ENV=1 ;;
    -h|--help)     sed -n '3,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)             fail "unknown argument '$arg' (see --help)" ;;
  esac
done


# §5 R4, byte-for-byte, with the port only in the Description (see A-3: the port itself comes from the slot env).
render_unit() {
  cat <<UNIT
[Unit]
Description=SHO PR preview slot 9 (port ${SLOT_PORT})
After=network-online.target
Wants=network-online.target

[Service]
User=${ACCOUNT}
Group=${ACCOUNT}
WorkingDirectory=${CURRENT_DIR}
Environment=NODE_ENV=production NODE_OPTIONS=--max-old-space-size=512 SHO_BIND_HOST=127.0.0.1
EnvironmentFile=${ENV_DIR}/db.env
EnvironmentFile=${ENV_DIR}/app.env
EnvironmentFile=-${ENV_DIR}/local.env
EnvironmentFile=-${CURRENT_DIR}/release.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
MemoryMax=700M
# --- containment (enforced by root, not by the candidate) ---
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
InaccessiblePaths=/etc/sho
ReadWritePaths=${SLOT_ROOT}/var ${SLOT_ROOT}/log
RestrictSUIDSGID=yes
RestrictNamespaces=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
LockPersonality=yes
[Install]
WantedBy=multi-user.target
UNIT
}

# §5 R5. `daemon-reload` is deliberately absent: deploy must not be able to reload the unit that contains it.
render_sudoers() {
  printf '%s\n' \
    "deploy ALL=(root) NOPASSWD: ${SYSTEMCTL_BIN:-/usr/bin/systemctl} restart ${UNIT_NAME}, ${SYSTEMCTL_BIN:-/usr/bin/systemctl} start ${UNIT_NAME}, ${SYSTEMCTL_BIN:-/usr/bin/systemctl} status ${UNIT_NAME}, ${SYSTEMCTL_BIN:-/usr/bin/systemctl} status ${UNIT_NAME} *, ${JOURNALCTL_BIN:-/usr/bin/journalctl} -u ${UNIT_NAME} *"
}

# ---------------------------------------------------------------------------
# --check: render the plan and the exact bytes that would be written. No root, no writes, and an explicit
# list of what it cannot verify off-host.
# ---------------------------------------------------------------------------
if [ "$MODE" = 'check' ]; then
  say "PLAN"
  say "host       ${EXPECT_HOST}  (enforced on a real run; DEFERRED here)"
  say "account    ${ACCOUNT} (system, nologin, locked, no sudo)        [R1]"
  say "slot tree  ${SLOT_ROOT}/{env,var,log} 0700, releases 2770 ${ACCOUNT}:deploy   [R2]"
  say "env source ${SRC_ENV_DIR}/{db,app,local}.env, copied 0600, then marker-scanned   [R3]"
  say "unit       ${UNIT_PATH}   [R4]"
  say "listener   127.0.0.1:${SLOT_PORT} (from the slot env; see A-3)"
  say "sudoers    ${SUDOERS_PATH} 0440, validated by visudo -c before install   [R5]"
  say "start      daemon-reload, verify, enable --now ${UNIT_NAME}   [R6]"
  say "DEFERRED: root, hostname, source-env presence, current/ presence, visudo, systemd - not checkable off-host"
  say ""
  say "----- ${UNIT_PATH} -----"
  render_unit
  say "----- ${SUDOERS_PATH} (0440 root:root) -----"
  render_sudoers
  say "-----"
  say "nothing was created, modified or started."
  exit 0
fi

# ---------------------------------------------------------------------------
# Preconditions that must hold for both apply and rollback. Anything failing here exits 2 before a single
# change is made.
# ---------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || fail "must be run as root on the staging host (this script refuses to act otherwise)"

[ "$(uname -s)" = 'Linux' ] || fail "not Linux; this is the staging host's runbook"
hostname -s | grep -qx "$EXPECT_HOST" \
  || fail "host is not ${EXPECT_HOST}; refusing to touch a unit outside the staging host"
[ -x "$MARKER_SCAN" ] || fail "marker scanner missing at ${MARKER_SCAN}"
[ "$UNIT_NAME" = 'sho-pr9' ] || fail "unit name drift; this runbook is the slot-9 runbook"

SYSTEMCTL_BIN=$(command -v systemctl || true)
[ -n "$SYSTEMCTL_BIN" ] || fail "systemctl not found"
JOURNALCTL_BIN=$(command -v journalctl || true)
VISUDO_BIN=$(command -v visudo || true)

# ---------------------------------------------------------------------------
# R7 — rollback to the CURRENT state, which is "stopped and absent". Idempotent: safe on a half-applied run.
# Scope is sho-pr9 plus the shoslot account, per §7:453-457. It does not touch sho, sho-pr1..8, sho-staging,
# Caddy, DNS, Postgres, or the DB role sho_slot_pr9_app.
# ---------------------------------------------------------------------------
if [ "$MODE" = 'rollback' ]; then
  say "R7 rollback: ${UNIT_NAME} + ${ACCOUNT} only"

  # Key the stop on the UNIT'S STATE, not on the presence of the unit file. Gating on `[ -e "$UNIT_PATH" ]`
  # meant an interrupted rollback (file already removed, process still live) took the "absent already"
  # branch, never called disable, and still printed ROLLBACK_OK - measured in a sandbox where is-active
  # says `active` and the file is gone: zero stop calls, exit 0.
  if [ "$("$SYSTEMCTL_BIN" is-active "$UNIT_NAME" 2>/dev/null || true)" = 'active' ] || [ -e "$UNIT_PATH" ]; then
    # A failed stop is NOT "the unit was not running" (that conflation is how a live slot survived).
    "$SYSTEMCTL_BIN" disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
    say "  stopped+disabled ${UNIT_NAME}"
  else
    say "  ${UNIT_NAME} not active and its file is absent"
  fi
  # Never remove the unit file over a live slot: that leaves a running process systemd cannot manage,
  # which is worse than the stopped state this mode promises.
  if [ "$("$SYSTEMCTL_BIN" is-active "$UNIT_NAME" 2>/dev/null || true)" = 'active' ]; then
    fail "${UNIT_NAME} is still active after disable --now; refusing to remove the unit file over a live slot"
  fi

  rm -f "$UNIT_PATH" "$SUDOERS_PATH"
  say "  removed unit file and sudoers file (absent is fine)"
  systemctl daemon-reload
  say "  daemon-reload done"

  # ${SLOT_HOME:?} — never let this expand to empty and turn `rm -rf` into something else.
  rm -rf "${SLOT_HOME:?}" /var/mail/"${ACCOUNT}"
  say "  removed ${SLOT_HOME}"
  if id -u "$ACCOUNT" >/dev/null 2>&1; then
    userdel "$ACCOUNT"
    say "  removed account ${ACCOUNT}"
  else
    say "  account ${ACCOUNT} absent already"
  fi

  if id -u "$ACCOUNT" >/dev/null 2>&1; then account_gone=0; else account_gone=1; fi
  if [ -e "$UNIT_PATH" ]; then unit_gone=0; else unit_gone=1; fi
  if [ -e "$SUDOERS_PATH" ]; then sudoers_gone=0; else sudoers_gone=1; fi
  # "the file is gone" and "the slot is stopped" are different questions; the booleans used to answer
  # only the first, so a live slot with no unit file read as a successful rollback.
  if [ "$("$SYSTEMCTL_BIN" is-active "$UNIT_NAME" 2>/dev/null || true)" = 'active' ]; then unit_stopped=0; else unit_stopped=1; fi
  say "ROLLBACK unit_gone=${unit_gone} account_gone=${account_gone} sudoers_gone=${sudoers_gone} unit_stopped=${unit_stopped}"
  [ "$account_gone" -eq 1 ] && [ "$unit_gone" -eq 1 ] && [ "$sudoers_gone" -eq 1 ] && [ "$unit_stopped" -eq 1 ] \
    || fail "rollback incomplete; inspect the four booleans above"
  say "ROLLBACK_OK"
  exit 0
fi

# ---------------------------------------------------------------------------
# R1..R6 — the change itself. Every step is re-entrant: it verifies an existing good state instead of
# re-creating it, and it never overwrites live slot env without --refresh-env.
# ---------------------------------------------------------------------------
tmp_sudo=''
cleanup() { if [ -n "${tmp_sudo:-}" ]; then rm -f "$tmp_sudo"; fi; return 0; }
trap cleanup EXIT

for name in db app local; do
  [ -r "${SRC_ENV_DIR}/${name}.env" ] \
    || fail "slot env source missing: ${SRC_ENV_DIR}/${name}.env (§5:331-333)"
done

say "R1 account ${ACCOUNT}"
if id -u "$ACCOUNT" >/dev/null 2>&1; then
  acct_uid=$(id -u "$ACCOUNT")
  acct_home=$(getent passwd "$ACCOUNT" | cut -d: -f6)
  acct_shell=$(getent passwd "$ACCOUNT" | cut -d: -f7)
  acct_state=$(passwd -S "$ACCOUNT" | awk '{print $2}')
  [ "$acct_home" = "$SLOT_HOME" ] || fail "existing ${ACCOUNT} home is ${acct_home}, expected ${SLOT_HOME}"
  [ "$acct_shell" = '/usr/sbin/nologin' ] || fail "existing ${ACCOUNT} shell is ${acct_shell}, expected nologin"
  [ "$acct_state" = 'L' ] || fail "existing ${ACCOUNT} password is not locked (passwd -S says ${acct_state})"
  [ "$acct_uid" -ne "$DEPLOY_UID" ] || fail "existing ${ACCOUNT} has deploy's uid ${DEPLOY_UID}; that is not a separation"
  note "present uid=${acct_uid} password_locked=1 (verified, not re-created)"
else
  useradd --system --user-group --home-dir "$SLOT_HOME" --shell /usr/sbin/nologin "$ACCOUNT"
  note "created uid=$(id -u "$ACCOUNT") password_locked=$(passwd -S "$ACCOUNT" | awk '{print $2}')"
fi
note "group_memberships=$(id -nG "$ACCOUNT" | wc -w | tr -d ' ') (1 = its own group only, no sudo)"

say "R2 slot tree"
install -d -m 0700 -o "$ACCOUNT" -g "$ACCOUNT" "$SLOT_ROOT" "$ENV_DIR" "${SLOT_ROOT}/var" "${SLOT_ROOT}/log"
install -d -m 2770 -o "$ACCOUNT" -g deploy "${SLOT_ROOT}/releases"
note "$(stat -c '%a %U:%G' "$SLOT_ROOT")  releases $(stat -c '%a %U:%G' "${SLOT_ROOT}/releases")"

say "R3 slot env (copied, never printed)"
for name in db app local; do
  dst="${ENV_DIR}/${name}.env"
  if [ -e "$dst" ] && [ "$REFRESH_ENV" -eq 0 ]; then
    note "kept existing ${name}.env (use --refresh-env to overwrite)"
    continue
  fi
  install -m 0600 -o "$ACCOUNT" -g "$ACCOUNT" "${SRC_ENV_DIR}/${name}.env" "$dst"
  note "wrote ${name}.env 0600 ${ACCOUNT}:${ACCOUNT}"
done

scan_out=$(bash "$MARKER_SCAN" "$ENV_DIR") && scan_rc=0 || scan_rc=$?
printf '%s\n' "$scan_out"
env_files=$(printf '%s\n' "$scan_out" | sed -n 's/^ENV_FILE_COUNT=//p')
if [ "$scan_rc" -ne 0 ]; then
  # D1: this is the line §5 got wrong — it printed ABORT and continued into R4/R6.
  printf 'REFUSING: production marker in the slot env; nothing was installed or started.\n' >&2
  printf 'REFUSING: inspect %s by hand, then re-run. Do not start the unit.\n' "$ENV_DIR" >&2
  exit 3
fi
[ "${env_files:-0}" -ge 3 ] || { printf 'REFUSING: only %s env file(s) in %s\n' "${env_files:-0}" "$ENV_DIR" >&2; exit 3; }

say "R4 unit"
unit_tmp=$(mktemp)
render_unit > "$unit_tmp"
if [ -e "$UNIT_PATH" ]; then
  if cmp -s "$unit_tmp" "$UNIT_PATH"; then
    note "unit already identical (no backup needed)"
  else
    backup="${UNIT_PATH}.bak-w46-$(date -u +%Y%m%dT%H%M%SZ)"
    cp -p "$UNIT_PATH" "$backup"
    note "existing unit differed; previous copy kept at $(basename "$backup")"
  fi
fi
install -m 0644 -o root -g root "$unit_tmp" "$UNIT_PATH"
rm -f "$unit_tmp"
# The one line that would undo every other control (§4, "EnvironmentFile= only the slot files").
prod_env_lines=$(grep -c 'EnvironmentFile=/etc/sho' "$UNIT_PATH" || true)
[ "$prod_env_lines" -eq 0 ] || fail "unit loads a production env file"
note "written; unit_loads_production_env=${prod_env_lines}"

say "R5 sudoers fragment"
tmp_sudo="/etc/sudoers.d/.w46-tmp-$$"          # dot-prefixed: sudo ignores it while it is being written
render_sudoers > "$tmp_sudo"
chmod 0600 "$tmp_sudo"
if [ -n "$VISUDO_BIN" ]; then
  # D2: validate BEFORE it can affect sudo. A broken fragment in /etc/sudoers.d can cost you sudo entirely.
  "$VISUDO_BIN" -c -f "$tmp_sudo" >/dev/null 2>&1 \
    || fail "rendered sudoers fragment does not parse; nothing installed"
  note "fragment parses (visudo -c on a temp path)"
else
  note "visudo not found; fragment NOT installed (refusing to write unvalidated sudoers)"
  fail "visudo missing"
fi
install -m 0440 -o root -g root "$tmp_sudo" "$SUDOERS_PATH"
rm -f "$tmp_sudo"
tmp_sudo=''
"$VISUDO_BIN" -c >/dev/null 2>&1 || { rm -f "$SUDOERS_PATH"; fail "global sudoers check failed; fragment removed"; }
note "installed 0440; global sudoers check OK"

say "R6 start"
# §5:389 — phase 2 creates `current` as deploy. Missing here is a precondition failure, not a reason to
# loosen ProtectHome. R1..R5 stay applied so phase 2 can ship into releases/.
if [ ! -d "$CURRENT_DIR" ] || [ ! -f "${CURRENT_DIR}/server.js" ]; then
  say "R6 SKIPPED: ${CURRENT_DIR}/server.js is absent (phase 2 has not shipped code yet)"
  say "R6 skipped is safe: unit installed but NOT enabled. Re-run this script after phase 2."
  say "RESULT r1_5=done r6=skipped"
  exit 4
fi

systemctl daemon-reload
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$UNIT_PATH" || fail "unit failed systemd-analyze verify"
  note "systemd-analyze verify OK"
fi
systemctl enable --now "$UNIT_NAME"
systemctl show "$UNIT_NAME" -p User -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p PrivateTmp -p InaccessiblePaths
say "RESULT r1_6=done unit=${UNIT_NAME} listener=127.0.0.1:${SLOT_PORT}"
say "NEXT: bash $(dirname "${BASH_SOURCE[0]}")/slot9-proof.sh"


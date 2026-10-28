#!/usr/bin/env bash
# CONTAINMENT / slot 9 — enumerate the EnvironmentFile= sources a unit actually loads.
#
# Sourced (not executed) by slot9-optionR.sh (R4, before install) and slot9-proof.sh (P4, on the host).
# One implementation, because the two used to answer the same question with two different prefix globs:
#
#   case "$p" in /home/shoslot/pr9/env/*|/home/shoslot/pr9/current/*) ;; *) outside++ ;;&
#
# A `case` pattern is a STRING glob. `.../env/../../../etc/sho/app.env` matches it, so a path that leaves
# the slot tree was counted as inside — and `env/*` spans `/` too. Two further holes rode on that:
#
#   * the proof only counted guards (== 4) and the source count (>= 3), so a FIFTH source appended to the
#     unit with no guard printed unit_envfile_count=5 … env_guard=4 and still passed;
#   * a source that exists and reads back clean was never checked for where it *resolves* to, so
#     `current/release.env -> /somewhere/outside/release.env` (no marker) passed as a slot source.
#
# So: normalize every path (lexically AND through directory symlinks), require it under an allowed root at
# a path-component boundary, require one ExecStartPre guard naming that exact path, and scan each existing
# source with prod-marker-scan.sh.
#
# Prints COUNTS ONLY — no path, no value, no matched line. Exit 2 only for a usage error, so a caller
# cannot mistake "I could not read the unit" for "there is nothing to report".
#
# Usage: unit_env_sources <unit-file> <allowed-root> [<allowed-root> ...]
#   UNIT_ENVFILE_COUNT   EnvironmentFile= lines found (4 on a correct slot unit)
#   UNIT_ENV_EXISTING    of those, how many exist on disk right now
#   UNIT_ENV_OUTSIDE     sources that do not resolve under an allowed root  (expect 0)
#   UNIT_ENV_UNREADABLE  existing sources this uid cannot read               (expect 0)
#   UNIT_ENV_UNGUARDED   sources with no ExecStartPre guard naming them      (expect 0)
#   UNIT_ENV_PROD        marker hits across all existing sources             (expect 0)
#   UNIT_ENV_GUARD       ExecStartPre marker-guard lines (expect == COUNT)

# Lexical normalization: collapse `//`, drop `.`, resolve `..` against the components seen so far. Pure
# string work, so it also answers for a path that does not exist yet (release.env before phase 2).
unit_env_norm_path() {
  local p=$1 part
  local -a stack=()
  local n=0
  local IFS='/'
  # shellcheck disable=SC2206  # deliberate split on IFS='/'
  local -a parts=($p)
  unset IFS
  for part in ${parts[@]+"${parts[@]}"}; do
    case "$part" in
      ''|.) continue ;;
      ..)   if [ "$n" -gt 0 ]; then unset 'stack[n-1]'; n=$((n - 1)); fi ;;
      *)    stack[n]=$part; n=$((n + 1)) ;;
    esac
  done
  local out=''
  local i=0
  while [ "$i" -lt "$n" ]; do out="${out}/${stack[i]}"; i=$((i + 1)); done
  printf '%s' "${out:-/}"
}

# Resolve a path the way the kernel would: `cd -P` on the directory (resolves symlinks AND `..` against
# the real tree), then follow the final component if it is a link. Portable across GNU and BSD userland —
# no `realpath -m`: this repo's test tier runs on macOS, where that flag does not exist, and a check that
# silently degrades to "no opinion" on the machine that runs the tests is worse than no check.
unit_env_canon_path() {
  local p=$1 d b t hops=0
  while :; do
    d=$(dirname -- "$p" 2>/dev/null) || { printf '%s' "$p"; return 0; }
    b=$(basename -- "$p" 2>/dev/null) || { printf '%s' "$p"; return 0; }
    if [ -d "$d" ]; then
      d=$(cd -P -- "$d" 2>/dev/null && pwd -P) || d=''
    fi
    [ -n "$d" ] || break
    p="${d%/}/${b}"
    [ -L "$p" ] || break
    [ "$hops" -lt 8 ] || break
    t=$(readlink -- "$p" 2>/dev/null) || break
    hops=$((hops + 1))
    case "$t" in
      /*) p=$t ;;
      *)  p="${d%/}/${t}" ;;
    esac
  done
  unit_env_norm_path "$p"
}

# 0 when <path> is under <root> at a component boundary — so /home/shoslot/pr9x is NOT under
# /home/shoslot/pr9, which a bare prefix test would have said it was.
unit_env_under() {
  local root=$1 p=$2
  [ "$root" != '/' ] && root=${root%/}
  [ "$p" = "$root" ] && return 0
  case "$p" in "$root"/*) return 0 ;; esac
  return 1
}

unit_env_sources() {
  local unit=$1
  shift
  if [ "$#" -lt 1 ] || [ -z "$unit" ] || [ ! -f "$unit" ]; then
    printf 'unit_env_sources: usage: unit_env_sources <unit-file> <allowed-root>...\n' >&2
    return 2
  fi
  local -a roots=()
  local r
  for r in "$@"; do
    [ -n "$r" ] || continue
    roots+=("$(unit_env_canon_path "$r")")
  done

  local scan="${UNIT_ENV_MARKER_SCAN:-$(dirname "${BASH_SOURCE[0]}")/prod-marker-scan.sh}"
  local count=0 existing=0 outside=0 unreadable=0 unguarded=0 prod=0 guard=0

  guard=$(grep -c '^ExecStartPre=.*grep -qEi' "$unit" || true)

  local p cp inside m
  while IFS= read -r p; do
    p=${p%$'\r'}
    [ -n "$p" ] || continue
    count=$((count + 1))

    cp=$(unit_env_canon_path "$p")
    inside=0
    for r in ${roots[@]+"${roots[@]}"}; do
      if unit_env_under "$r" "$cp"; then inside=1; break; fi
    done
    # An ABSENT source outside the tree is still outside: the ExecStartPre guard lets systemd load it the
    # moment somebody creates it — that is exactly how release.env appears — so absence must not excuse it.
    [ "$inside" -eq 1 ] || outside=$((outside + 1))

    # One guard per source, naming this exact path. `-F`: the path is data, not a pattern.
    if grep '^ExecStartPre=' "$unit" 2>/dev/null | grep -qF -- "$p"; then
      :
    else
      unguarded=$((unguarded + 1))
    fi

    [ -e "$p" ] || [ -L "$p" ] || continue
    existing=$((existing + 1))
    if [ ! -r "$p" ]; then
      unreadable=$((unreadable + 1))
      continue
    fi
    m=$(bash "$scan" "$p" 2>/dev/null | sed -n 's/^PROD_MARKER_COUNT=//p' || true)
    # A scan that printed nothing is not a clean scan; count a hit so the gate fails closed.
    case "$m" in ''|*[!0-9]*) m=1 ;; esac
    prod=$((prod + m))
  done < <(sed -n 's/^[[:space:]]*EnvironmentFile=-\{0,1\}[[:space:]]*//p' "$unit")

  printf 'UNIT_ENVFILE_COUNT=%s\n'   "$count"
  printf 'UNIT_ENV_EXISTING=%s\n'    "$existing"
  printf 'UNIT_ENV_OUTSIDE=%s\n'     "$outside"
  printf 'UNIT_ENV_UNREADABLE=%s\n'  "$unreadable"
  printf 'UNIT_ENV_UNGUARDED=%s\n'   "$unguarded"
  printf 'UNIT_ENV_PROD=%s\n'        "$prod"
  printf 'UNIT_ENV_GUARD=%s\n'       "$guard"
  return 0
}

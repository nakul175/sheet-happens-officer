#!/usr/bin/env bash
# CI tier — A BOOT PROBE FOR A RUNNING SERVER.
#
# Why this exists: the router-root incident (app/sho-status-plan/execution/PHASE2-CONTRACT.md, undone by commit
# 7dd3581) left every route answering 404 while the offline suite stayed 86/86 green. Offline tests cannot say
# whether a candidate boots — something has to ask a running server. This is that something, and it is small enough
# to read: no app, no DB, no browser, no Chromium.
#
#   scripts/ci/boot-probe.sh http://localhost:3100/api/health            # one attempt
#   scripts/ci/boot-probe.sh http://localhost:3100/api/health 30 2       # up to 30 attempts, 2s apart
#
# Contract:
#   stdout   the last HTTP status code seen, exactly one line ("000" = nothing answered)
#   exit 0   that status was 200
#   exit 1   anything else, including 000 (connection refused, DNS failure, timeout, 404)
#   exit 2   bad usage: no URL, an empty URL, a non-numeric or zero attempt count, a non-numeric pause
#   exit 3   curl is not installed
#
# A caller that only wants a boolean reads the exit code; one that wants to say WHY prints the line. The retries are
# for a server that is still booting: the probe does not start it, and does not pretend a 000 is a 404.
set -uo pipefail

usage() {
  printf 'usage: %s <url> [attempts] [pause-seconds]\n' "${0##*/}" >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
url="${1:-}"
[ -n "$url" ] || usage
attempts="${2:-1}"
pause="${3:-1}"
case "$attempts" in '' | *[!0-9]*) usage ;; esac
case "$pause" in '' | *[!0-9]*) usage ;; esac
[ "$attempts" -ge 1 ] || usage

command -v curl >/dev/null 2>&1 || {
  printf '%s: curl is not installed\n' "${0##*/}" >&2
  exit 3
}

code=000
attempt=1
while [ "$attempt" -le "$attempts" ]; do
  # -w prints 000 when the connection never happened, so an unreachable server is a value and not an empty string.
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$url" 2>/dev/null) || true
  [ -n "$code" ] || code=000
  [ "$code" = "200" ] && break
  [ "$attempt" -lt "$attempts" ] && sleep "$pause"
  attempt=$((attempt + 1))
done

printf '%s\n' "$code"
[ "$code" = "200" ] || exit 1
exit 0

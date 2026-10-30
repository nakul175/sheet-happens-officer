#!/usr/bin/env bash
# Runs one scheduled job through the app with this machine's JOB_SECRET. Called by cron
# (/etc/cron.d/sho); appends one line per run to /var/log/sho/jobs.log.
set -uo pipefail
name="${1:?job name}"
# Older hosts may still have these retired entries in a root-owned crontab.
# They must be inert without contacting the application or producing failure notices.
case "$name" in purge-chat|concierge-budget) exit 0 ;; esac
set -a
# shellcheck disable=SC1091
. /etc/sho/local.env
set +a
log=/var/log/sho/jobs.log
printf '%s %s ' "$(date -Is)" "$name" >> "$log"
if out=$(curl -sS -m 900 -X POST -H "Authorization: Bearer $JOB_SECRET" -w ' HTTP%{http_code}' "http://127.0.0.1:3000/api/jobs/$name" 2>&1); then
  printf '%s\n' "$out" >> "$log"
else
  printf 'request failed: %s\n' "$out" >> "$log"
  exit 1
fi

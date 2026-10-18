#!/usr/bin/env bash
# Hold automatic main-to-staging deploys during the regression window.
# The window is 16:00 inclusive until 18:30 exclusive, Asia/Kolkata.
# An rc-* tag or a workflow_dispatch run is the RC deploy and is not held.
set -euo pipefail

: "${GITHUB_OUTPUT:?}"
event="${GITHUB_EVENT_NAME:-}"
ref="${GITHUB_REF:-}"

allow() {
  echo "skip=false" >> "$GITHUB_OUTPUT"
  echo "Staging deploy is allowed (${event} ${ref})."
}

if [ "$event" != "push" ] || [ "$ref" != "refs/heads/main" ]; then
  allow
  exit 0
fi

if [ -n "${SHO_NOW_IST:-}" ]; then
  hm="$SHO_NOW_IST"
else
  hm=$(TZ=Asia/Kolkata date +%H:%M)
fi
case "$hm" in
  [0-1][0-9]:[0-9][0-9]|2[0-3]:[0-9][0-9]) ;;
  *) echo "could not read the India clock ($hm)" >&2; exit 1 ;;
esac
hh=${hm%%:*}
mm=${hm##*:}
minutes=$((10#$hh * 60 + 10#$mm))
start=$((16 * 60))
end=$((18 * 60 + 30))
if [ "$minutes" -ge "$start" ] && [ "$minutes" -lt "$end" ]; then
  echo "skip=true" >> "$GITHUB_OUTPUT"
  echo "Holding the automatic staging deploy. Main is frozen from 16:00 to 18:30 IST (now ${hm})."
  echo "Deploy the release candidate with an rc-* tag or by running this workflow by hand."
  exit 0
fi
allow

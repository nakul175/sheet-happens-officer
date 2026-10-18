#!/usr/bin/env bash
# Tell the owner a deploy failed. Prints only the HTTP status, never the API key or a connection string.
set -u
: "${TIER:?}" "${GITHUB_SHA:?}" "${RUN_URL:?}"
if [ -z "${RESEND_API_KEY:-}" ]; then
  echo "RESEND_API_KEY is missing; skipping the owner email"
  exit 0
fi
case "$TIER" in
  staging) where="staging" ;;
  production) where="production" ;;
  *) where="$TIER" ;;
esac
short=${GITHUB_SHA:0:7}
subject="SHO ${where} deploy failed"
text="The ${where} deploy of ${short} failed. A failed health check restores the previous code; migrations are forward-only and are not reverted. Details: ${RUN_URL}"
body=$(jq -n \
  --arg subject "$subject" \
  --arg text "$text" \
  '{from:"Sheet Happens Officer <no-reply@sheethappensofficer.com>",to:["nakul.jain@aplyd.com"],subject:$subject,text:$text}')
curl -sS -o /dev/null -w "owner email: HTTP %{http_code}\n" https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$body" || true

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
  prod-smoke) where="production smoke" ;;
  *) where="$TIER" ;;
esac
short=${GITHUB_SHA:0:7}
subject="SHO ${where} failed"
if [ "$TIER" = prod-smoke ]; then
  text="The production smoke of ${short} failed. Rollback to the previous release was requested. Migrations are forward-only and are not reverted. Details: ${RUN_URL}"
else
  text="The ${where} deploy of ${short} failed. A failed health check restores the previous code; migrations are forward-only and are not reverted. Details: ${RUN_URL}"
fi
recipients='["nakul.jain@aplyd.com"]'
if [ -n "${OSCAR_EMAIL:-}" ]; then
  case "$OSCAR_EMAIL" in
    *"'"*|*"\\"*|*$'\n'*|*\"*) echo "OSCAR_EMAIL is not usable; mailing the owner only" ;;
    *@*) recipients=$(jq -n --arg extra "$OSCAR_EMAIL" '["nakul.jain@aplyd.com", $extra]') ;;
    *) echo "OSCAR_EMAIL is not usable; mailing the owner only" ;;
  esac
else
  echo "OSCAR_EMAIL is unset; the owner mail is the page"
fi
body=$(jq -n \
  --arg subject "$subject" \
  --arg text "$text" \
  --argjson to "$recipients" \
  '{from:"Sheet Happens Officer <no-reply@sheethappensofficer.com>",to:$to,subject:$subject,text:$text}')
curl -sS -o /dev/null -w "owner email: HTTP %{http_code}\n" https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$body" || true

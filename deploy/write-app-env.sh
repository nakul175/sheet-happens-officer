#!/usr/bin/env bash
# Print an app.env file to stdout. Diagnostics go to stderr and never include secret values.
# Usage: write-app-env.sh staging|production
set -euo pipefail

tier="${1:?tier}"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=release-common.sh
. "$SCRIPT_DIR/release-common.sh"

reject_quote() {
  local name="$1" val="$2"
  case "$val" in
    *"'"*|*$'\n'*) echo "::error::$name contains a quote or line break" >&2; exit 1 ;;
  esac
}

case "$tier" in
  staging) db_secret=STAGING_DATABASE_URL; direct_secret=STAGING_DIRECT_DATABASE_URL ;;
  production) db_secret=DATABASE_URL; direct_secret=DIRECT_DATABASE_URL ;;
  *) echo "::error::unknown tier" >&2; exit 1 ;;
esac

[ -n "${DATABASE_URL:-}" ] || { echo "::error::$db_secret is missing" >&2; exit 1; }
[ -n "${RESEND_API_KEY:-}" ] || { echo "::error::RESEND_API_KEY is missing" >&2; exit 1; }
reject_quote "$db_secret" "$DATABASE_URL"
reject_quote "$direct_secret" "${DIRECT_DATABASE_URL:-}"
reject_quote RESEND_API_KEY "$RESEND_API_KEY"
for v in ANTHROPIC_API_KEY MODEL_DATA_APPROVED MODEL_NAME MONTHLY_CEILING_USD WEEKLY_MESSAGE_CAP; do
  reject_quote "$v" "${!v:-}"
done

if [ "$tier" = staging ]; then
  export DIRECT_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}"
fi
assert_database_urls "$tier" >&2

case "$tier" in
  staging) host=staging.sheethappensofficer.com ;;
  production) host=app.sheethappensofficer.com ;;
esac

{
  printf "DATABASE_URL='%s'\n" "$DATABASE_URL"
  if [ "$tier" = production ] || [ -n "${DIRECT_DATABASE_URL:-}" ]; then
    printf "DIRECT_DATABASE_URL='%s'\n" "$DIRECT_DATABASE_URL"
  fi
  printf "RESEND_API_KEY='%s'\n" "$RESEND_API_KEY"
  printf "APP_URL='https://%s'\n" "$host"
  printf "SUPER_ADMIN_EMAILS='nakul.jain@aplyd.com'\n"
  printf "EMAIL_FROM='Sheet Happens Officer <no-reply@sheethappensofficer.com>'\n"
  printf "TZ='Asia/Kolkata'\n"
  for v in ANTHROPIC_API_KEY MODEL_DATA_APPROVED MODEL_NAME MONTHLY_CEILING_USD WEEKLY_MESSAGE_CAP; do
    val="${!v:-}"
    if [ -n "$val" ]; then printf "%s='%s'\n" "$v" "$val"; fi
  done
}

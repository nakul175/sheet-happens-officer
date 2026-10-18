#!/usr/bin/env bash
# Shared checks for the release scripts. Sourced, not executed.
# Nothing here prints a connection string.

# Strip URLs from a command's output before it is logged.
redact() {
  sed -E 's#(postgres(ql)?://)[^[:space:]'\''"<]+#\1[redacted]#g'
}

assert_sha() {
  [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "release sha must be 40 hex characters"; return 1; }
}

assert_digest() {
  [[ "${1:-}" =~ ^[0-9a-f]{64}$ ]] || { echo "artifact digest must be 64 hex characters"; return 1; }
}

# True when the URL is the production PgBouncer pool (port 25061 or pgbouncer=true).
is_pool_url() {
  case "${1:-}" in
    *pgbouncer=true*|*:25061/*|*:25061\?*) return 0 ;;
    *) return 1 ;;
  esac
}

# Staging and production each have one directory and one env file. Callers cannot substitute the other.
assert_push_target() {
  local tier="$1" root="$2" env_file="$3"
  case "$tier" in
    staging)
      [ "$root" = /opt/sho-staging ] || { echo "staging deploy must use /opt/sho-staging"; return 1; }
      [ "$env_file" = /etc/sho-staging/app.env ] || { echo "staging deploy must not write the production env file"; return 1; }
      ;;
    production)
      [ "$root" = /opt/sho ] || { echo "production deploy must use /opt/sho"; return 1; }
      [ "$env_file" = /etc/sho/app.env ] || { echo "production deploy must write /etc/sho/app.env"; return 1; }
      ;;
    *)
      echo "unknown tier"
      return 1
      ;;
  esac
}

# Production must use the pool for the app and a different direct URL for migrations.
# Staging must not be pointed at that pool. Values are never printed.
assert_database_urls() {
  local tier="$1"
  [ -n "${DATABASE_URL:-}" ] || { echo "DATABASE_URL is missing"; return 1; }
  case "$tier" in
    staging)
      if is_pool_url "$DATABASE_URL"; then
        echo "refusing to point staging at the production PgBouncer pool"
        return 1
      fi
      if [ -n "${DIRECT_DATABASE_URL:-}" ] && is_pool_url "$DIRECT_DATABASE_URL"; then
        echo "refusing to run staging migrations through the production PgBouncer pool"
        return 1
      fi
      ;;
    production)
      [ -n "${DIRECT_DATABASE_URL:-}" ] || { echo "DIRECT_DATABASE_URL is required for production migrations"; return 1; }
      case "$DATABASE_URL" in
        *:25061/*|*:25061\?*) ;;
        *) echo "production DATABASE_URL must use the PgBouncer port 25061"; return 1 ;;
      esac
      case "$DATABASE_URL" in
        *pgbouncer=true*) ;;
        *) echo "production DATABASE_URL must include pgbouncer=true"; return 1 ;;
      esac
      if is_pool_url "$DIRECT_DATABASE_URL"; then
        echo "DIRECT_DATABASE_URL must be a direct connection, not the PgBouncer pool"
        return 1
      fi
      if [ "$DATABASE_URL" = "$DIRECT_DATABASE_URL" ]; then
        echo "DIRECT_DATABASE_URL must differ from DATABASE_URL"
        return 1
      fi
      ;;
    *)
      echo "unknown tier"
      return 1
      ;;
  esac
}

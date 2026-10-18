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

_RELEASE_COMMON_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Parse a URL from the environment. The value is never printed and is not passed as an argument.
db_facts() {
  DB_URL_CHECK="$1" node "$_RELEASE_COMMON_DIR/db-url.mjs"
}

json_get() {
  node -e 'const j=JSON.parse(process.argv[1]); const v=j[process.argv[2]]; process.stdout.write(v===undefined||v===null?"":String(v))' "$1" "$2"
}

# True when both identity variables are set and this parsed URL is that database.
is_prod_db() {
  local facts="$1" host db prod_host prod_name
  [ -n "${PROD_DB_HOST:-}" ] && [ -n "${PROD_DB_NAME:-}" ] || return 1
  host=$(json_get "$facts" host)
  db=$(json_get "$facts" database)
  prod_host=$(printf '%s' "$PROD_DB_HOST" | tr '[:upper:]' '[:lower:]')
  prod_name=$(printf '%s' "$PROD_DB_NAME" | tr '[:upper:]' '[:lower:]')
  [ "$host" = "$prod_host" ] && [ "$db" = "$prod_name" ]
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

# Production is identified by PROD_DB_HOST and PROD_DB_NAME, not by port 25061.
# Every DigitalOcean pool uses that port. Staging may use its own pool when the
# host and database differ and the URL sets connection_limit=2 and pool_timeout.
# Values are never printed.
assert_database_urls() {
  local tier="$1" app direct pool
  [ -n "${DATABASE_URL:-}" ] || { echo "DATABASE_URL is missing"; return 1; }
  app=$(db_facts "$DATABASE_URL") || { echo "DATABASE_URL could not be read"; return 1; }
  pool=$(json_get "$app" pool)
  case "$tier" in
    staging)
      if is_prod_db "$app"; then
        echo "refusing to point staging at the production database"
        return 1
      fi
      if [ "$pool" = true ]; then
        if [ -z "${PROD_DB_HOST:-}" ] || [ -z "${PROD_DB_NAME:-}" ]; then
          echo "refusing to use a staging PgBouncer pool until PROD_DB_HOST and PROD_DB_NAME identify production"
          return 1
        fi
        [ "$(json_get "$app" connectionLimit)" = "2" ] || { echo "staging pool URL must set connection_limit=2"; return 1; }
        case "$(json_get "$app" poolTimeout)" in
          ''|*[!0-9]*) echo "staging pool URL must set pool_timeout"; return 1 ;;
          0) echo "staging pool URL must set pool_timeout"; return 1 ;;
        esac
        [ -n "${DIRECT_DATABASE_URL:-}" ] || { echo "STAGING_DIRECT_DATABASE_URL is required when staging uses PgBouncer"; return 1; }
      fi
      if [ -n "${DIRECT_DATABASE_URL:-}" ]; then
        direct=$(db_facts "$DIRECT_DATABASE_URL") || { echo "DIRECT_DATABASE_URL could not be read"; return 1; }
        if [ "$(json_get "$direct" pool)" = true ]; then
          echo "refusing to run migrations through a PgBouncer pool"
          return 1
        fi
        if is_prod_db "$direct"; then
          echo "refusing to point staging migrations at the production database"
          return 1
        fi
      fi
      ;;
    production)
      [ -n "${DIRECT_DATABASE_URL:-}" ] || { echo "DIRECT_DATABASE_URL is required for production migrations"; return 1; }
      [ "$(json_get "$app" port)" = "25061" ] || { echo "production DATABASE_URL must use the PgBouncer port 25061"; return 1; }
      [ "$(json_get "$app" pgbouncer)" = true ] || { echo "production DATABASE_URL must include pgbouncer=true"; return 1; }
      if [ -n "${PROD_DB_HOST:-}" ] && [ -n "${PROD_DB_NAME:-}" ] && ! is_prod_db "$app"; then
        echo "production DATABASE_URL does not match PROD_DB_HOST and PROD_DB_NAME"
        return 1
      fi
      direct=$(db_facts "$DIRECT_DATABASE_URL") || { echo "DIRECT_DATABASE_URL could not be read"; return 1; }
      if [ "$(json_get "$direct" pool)" = true ]; then
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

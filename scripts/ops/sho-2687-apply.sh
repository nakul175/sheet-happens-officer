#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${1:-verify}"

case "$MODE" in
  plan|apply|verify) ;;
  *) echo "Usage: $0 plan|apply|verify" >&2; exit 64 ;;
esac

: "${SHO_2687_ENV_FILE:=/etc/sho/app.env}"
: "${SHO_2687_SERVICE:=sho.service}"
: "${SHO_2687_HEALTH_URL:=http://127.0.0.1:3000/api/health}"
: "${SHO_2687_APP_ROLE:=sho_app}"
: "${SHO_2687_SCHEMA:=public}"
: "${SHO_2687_RELEASE_ROOT:=/opt/sho}"

export SHO_2687_ENV_FILE SHO_2687_SERVICE SHO_2687_HEALTH_URL SHO_2687_APP_ROLE SHO_2687_SCHEMA SHO_2687_RELEASE_ROOT

if [[ "$MODE" == apply ]]; then
  [[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "apply mode must run as root" >&2; exit 77; }
  [[ -n "${SHO_2687_PASSWORD_FILE:-}" ]] || { echo "SHO_2687_PASSWORD_FILE is required" >&2; exit 64; }
  [[ -n "${SHO_2687_EXPECTED_RELEASE:-}" ]] || { echo "SHO_2687_EXPECTED_RELEASE is required" >&2; exit 64; }
  current_health="$(curl -fsS "$SHO_2687_HEALTH_URL")"
  current_release="$(HEALTH_JSON="$current_health" node -e 'const h=JSON.parse(process.env.HEALTH_JSON); if(h.ok!==true||!h.release)process.exit(1); process.stdout.write(h.release)')"
  [[ "$current_release" == "$SHO_2687_EXPECTED_RELEASE" ]] || {
    echo "Refusing: selected service release changed (expected ${SHO_2687_EXPECTED_RELEASE}, found ${current_release:-missing})." >&2
    exit 78
  }
fi

node "$ROOT/scripts/ops/sho-2687-db-role.mjs" "$MODE"

if [[ "$MODE" == apply ]]; then
  backup_file="${SHO_2687_BACKUP_FILE:-${SHO_2687_ENV_FILE}.sho-2687-backup}"
  receipt_file="${SHO_2687_RECEIPT_FILE:-/var/lib/sho/sho-2687-receipt.json}"
  rollback_runtime() {
    if [[ -r "$backup_file" ]]; then
      install -m 0600 "$backup_file" "$SHO_2687_ENV_FILE"
      systemctl restart "$SHO_2687_SERVICE" || true
      echo "SHO-2687 runtime env rolled back after service validation failure." >&2
    fi
  }
  trap rollback_runtime ERR
  systemctl restart "$SHO_2687_SERVICE"
  systemctl is-active --quiet "$SHO_2687_SERVICE"
  health="$(curl -fsS "$SHO_2687_HEALTH_URL")"
  HEALTH_JSON="$health" node - <<'NODE'
const health = JSON.parse(process.env.HEALTH_JSON);
const expected = process.env.SHO_2687_EXPECTED_RELEASE;
if (health.ok !== true || health.release !== expected) {
  throw new Error(`health mismatch: ok=${health.ok} release=${health.release}`);
}
NODE
  set -a
  # shellcheck disable=SC1090
  . "$SHO_2687_ENV_FILE"
  set +a
  (
    cd "$SHO_2687_RELEASE_ROOT/current"
    ./node_modules/.bin/prisma migrate status >/dev/null
  )
  RECEIPT_FILE="$receipt_file" HEALTH_JSON="$health" node - <<'NODE'
const fs = require("node:fs");
const path = process.env.RECEIPT_FILE;
const receipt = JSON.parse(fs.readFileSync(path, "utf8"));
const health = JSON.parse(process.env.HEALTH_JSON);
receipt.serviceActive = true;
receipt.healthRelease = health.release;
receipt.migrationStatus = "pass";
receipt.completedAt = new Date().toISOString();
const staged = `${path}.new`;
fs.writeFileSync(staged, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(staged, path);
NODE
  trap - ERR
  echo "SHO-2687 service and exact release health verified."
fi

#!/usr/bin/env bash
# Ask the droplet to switch production to an existing release. Does not migrate.
# Usage: push-rollback.sh [/opt/sho/releases/<sha>]
# With no directory, the droplet uses /opt/sho/previous.
set -euo pipefail

dir="${1:-}"
: "${HOST:?}"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [ -n "$dir" ]; then
  [[ "$dir" =~ ^/opt/sho/releases/[0-9a-f]{40}$ ]] || { echo "::error::release dir must be /opt/sho/releases/<sha>"; exit 1; }
fi

SSH=(ssh -o BatchMode=yes -o IdentitiesOnly=yes)
SCP=(scp -o BatchMode=yes -o IdentitiesOnly=yes)
"${SSH[@]}" "deploy@$HOST" "mkdir -p /opt/sho/incoming"
"${SCP[@]}" "$SCRIPT_DIR/rollback.sh" "$SCRIPT_DIR/release-common.sh" "deploy@$HOST:/opt/sho/incoming/"
"${SSH[@]}" "deploy@$HOST" "chmod 755 /opt/sho/incoming/rollback.sh && SHO_TIER=production bash /opt/sho/incoming/rollback.sh ${dir}"

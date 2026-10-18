#!/usr/bin/env bash
# Record the digest staging is running. The status context below is fixed.
set -euo pipefail
: "${GITHUB_REPOSITORY:?}" "${GITHUB_SHA:?}" "${DIGEST:?}" "${GH_TOKEN:?}" "${GITHUB_RUN_ID:?}"
[[ "$DIGEST" =~ ^[0-9a-f]{64}$ ]] || { echo "digest is not 64 hex characters"; exit 1; }
gh api --method POST "/repos/${GITHUB_REPOSITORY}/commits/${GITHUB_SHA}/statuses" \
  -f state=success \
  -f context='staging/digest' \
  -f description="$DIGEST" \
  -f target_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" >/dev/null
echo "Recorded staging/digest for this commit."

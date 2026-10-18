#!/usr/bin/env bash
# Fail closed unless the rollback environment has a required reviewer and blocks self-review.
# ROLLBACK_REVIEWER is the GitHub login NJ assigns (Oscar). Tests pass --fixture <file>.
set -euo pipefail

reviewer="${ROLLBACK_REVIEWER:?ROLLBACK_REVIEWER is required}"

if [ "${1:-}" = "--fixture" ]; then
  meta=$(cat "${2:?fixture}")
else
  if ! meta=$(gh api "/repos/${GITHUB_REPOSITORY}/environments/rollback" 2>/dev/null); then
    echo "::error::Cannot read the rollback environment. Create it with Oscar as the required reviewer and prevent self-review, then set ROLLBACK_REVIEWER to that login."
    exit 1
  fi
fi

if ! echo "$meta" | jq -e --arg login "$reviewer" '
  [.protection_rules[]?
    | select(.type == "required_reviewers" and .prevent_self_review == true)
    | .reviewers[]?
    | select(.type == "User" and .reviewer.login == $login)
  ] | length > 0
' >/dev/null; then
  echo "::error::The rollback environment must require ${reviewer} with prevent self-review."
  echo "$meta" | jq '{rule_types:[.protection_rules[]?.type], prevent_self_review:[.protection_rules[]?.prevent_self_review], reviewers:[.protection_rules[]?.reviewers[]?.reviewer.login]}' || true
  exit 1
fi
echo "rollback environment requires ${reviewer} and prevents self-review"

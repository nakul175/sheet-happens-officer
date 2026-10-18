#!/usr/bin/env bash
# Fail closed unless the production environment requires nakul175 and blocks self-review.
# Tests pass --fixture <file>. The workflow calls this with no arguments.
set -euo pipefail

if [ "${1:-}" = --fixture ]; then
  meta=$(cat "${2:?fixture}")
else
  err=$(mktemp)
  if ! meta=$(gh api "/repos/${GITHUB_REPOSITORY}/environments/production" 2>"$err"); then
    echo "::error::Cannot read the production environment. Create it in Settings > Environments with required reviewer nakul175 and prevent self-review, then re-run. $(head -c 300 "$err")"
    rm -f "$err"
    exit 1
  fi
  rm -f "$err"
fi

if ! echo "$meta" | jq -e '
  [.protection_rules[]?
    | select(.type == "required_reviewers" and .prevent_self_review == true)
    | .reviewers[]?
    | select(.type == "User" and .reviewer.login == "nakul175")
  ] | length > 0
' >/dev/null; then
  echo "::error::The production environment must require reviewer nakul175 with prevent self-review. Refusing to deploy."
  echo "$meta" | jq '{rule_types:[.protection_rules[]?.type], prevent_self_review:[.protection_rules[]?.prevent_self_review], reviewers:[.protection_rules[]?.reviewers[]?.reviewer.login]}' || true
  exit 1
fi
echo "production environment requires nakul175 and prevents self-review"

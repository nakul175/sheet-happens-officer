#!/usr/bin/env bash
# Production may deploy only when the tag, the staging digest and the QA record agree.
# Sourced by the harness. Executed by the production workflow.
set -euo pipefail

qa_gate_decide() {
  local tag="$1" annotated="$2" ancestor="$3" digest="$4" staging="$5" qa_state="$6" qa_desc="$7" qa_login="$8"
  local expect="${QA_GATE_LOGIN:-}"
  [[ "$tag" =~ ^rel-[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$ ]] || { echo "tag must match rel-YYYY.MM.DD.N"; return 1; }
  [[ "$tag" != rel-test-* ]] || { echo "rel-test tags are rehearsals and cannot pass the production gate"; return 1; }
  [ "$annotated" = "tag" ] || { echo "tag must be annotated"; return 1; }
  [ "$ancestor" = "yes" ] || { echo "tag commit is not on origin/main"; return 1; }
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || { echo "artifact digest is missing"; return 1; }
  [ "$digest" = "$staging" ] || { echo "artifact digest does not match the digest staging reported for this commit"; return 1; }
  [ "$qa_state" = "success" ] || { echo "qa/gate for this commit is not success"; return 1; }
  case "$qa_desc" in
    "READY $digest"|"WITH_EXCEPTION $digest") ;;
    *) echo "qa/gate must say READY or WITH_EXCEPTION for this digest"; return 1 ;;
  esac
  [ -n "$expect" ] || { echo "QA_GATE_LOGIN is unset"; return 1; }
  case "$expect" in
    *'[bot]') echo "QA_GATE_LOGIN must be a person"; return 1 ;;
  esac
  case "$qa_login" in
    ""|*'[bot]') echo "qa/gate must be set by the QA identity"; return 1 ;;
  esac
  [ "$qa_login" = "$expect" ] || { echo "qa/gate was not set by the QA identity"; return 1; }
  echo "QA gate passed for $tag"
}

qa_gate_live() {
  local tag="${GITHUB_REF#refs/tags/}"
  local digest="${DIGEST:?}"
  git fetch --no-tags origin main
  git fetch origin "refs/tags/${tag}:refs/tags/${tag}"
  local annotated="commit"
  if [ "$(git cat-file -t "refs/tags/${tag}")" = "tag" ]; then annotated="tag"; fi
  local ancestor="no"
  if git merge-base --is-ancestor "$GITHUB_SHA" origin/main; then ancestor="yes"; fi
  local statuses staging qa_state qa_desc qa_login
  statuses=$(gh api "/repos/${GITHUB_REPOSITORY}/commits/${GITHUB_SHA}/statuses" 2>/dev/null) || {
    echo "could not read commit statuses"
    return 1
  }
  staging=$(printf '%s' "$statuses" | jq -r '[.[] | select(.context=="staging/digest")][0].description // empty')
  qa_state=$(printf '%s' "$statuses" | jq -r '[.[] | select(.context=="qa/gate")][0].state // empty')
  qa_desc=$(printf '%s' "$statuses" | jq -r '[.[] | select(.context=="qa/gate")][0].description // empty')
  qa_login=$(printf '%s' "$statuses" | jq -r '[.[] | select(.context=="qa/gate")][0].creator.login // empty')
  qa_gate_decide "$tag" "$annotated" "$ancestor" "$digest" "$staging" "$qa_state" "$qa_desc" "$qa_login"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  qa_gate_live
fi

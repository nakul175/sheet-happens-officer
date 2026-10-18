#!/usr/bin/env bash
# Fail closed unless an active tag ruleset stops the public from creating rel-* tags.
# NJ creates the ruleset in repository settings. Tests pass --fixture <file>.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [ "${1:-}" = "--fixture" ]; then
  node "$SCRIPT_DIR/tag-ruleset.mjs" < "${2:?fixture}"
  exit $?
fi

page=$(gh api "/repos/${GITHUB_REPOSITORY}/rulesets?per_page=100" 2>/dev/null) || {
  echo "::error::Cannot read repository rulesets."
  exit 1
}
ids=$(printf '%s' "$page" | jq -r '.[] | select(.target=="tag" and .enforcement=="active") | .id')
combined=$(mktemp)
echo '{"rulesets":[' > "$combined"
first=1
for id in $ids; do
  case "$id" in
    ''|*[!0-9]*) continue ;;
  esac
  one=$(gh api "/repos/${GITHUB_REPOSITORY}/rulesets/${id}" 2>/dev/null) || {
    echo "::error::Cannot read a tag ruleset."
    exit 1
  }
  if [ "$first" = 1 ]; then first=0; else echo ',' >> "$combined"; fi
  printf '%s' "$one" >> "$combined"
done
echo ']}' >> "$combined"
if ! node "$SCRIPT_DIR/tag-ruleset.mjs" < "$combined"; then
  rm -f "$combined"
  echo "::error::No active tag ruleset restricts creating refs/tags/rel-* to bypass actors. Add one before the first production tag. A sample is deploy/rel-tag-ruleset.json."
  exit 1
fi
rm -f "$combined"
echo "tag ruleset restricts rel-* creation"

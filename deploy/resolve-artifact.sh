#!/usr/bin/env bash
# Download the canonical release tarball for this commit, if CI already built one.
# Usage: resolve-artifact.sh download-if-present | require-canonical
# Writes dist/sho-release.tar.gz and dist/sho-release.tar.gz.sha256 when it downloads.
set -euo pipefail

mode="${1:?mode}"
name="release-${GITHUB_SHA:?}"
: "${GITHUB_REPOSITORY:?}" "${GH_TOKEN:?}"

lookup() {
  gh api "/repos/${GITHUB_REPOSITORY}/actions/artifacts?name=${name}&per_page=100" \
    --jq "[.artifacts[] | select(.name==\"${name}\" and .expired==false)] | sort_by(.created_at) | .[0].id // empty"
}

download() {
  local id="$1"
  rm -rf dist/unpacked dist/artifact.zip
  mkdir -p dist
  gh api "/repos/${GITHUB_REPOSITORY}/actions/artifacts/${id}/zip" > dist/artifact.zip
  unzip -qo dist/artifact.zip -d dist/unpacked
  local tar side
  tar=$(find dist/unpacked -name sho-release.tar.gz -type f -print -quit)
  side=$(find dist/unpacked -name sho-release.tar.gz.sha256 -type f -print -quit)
  [ -n "$tar" ] && [ -n "$side" ] || { echo "artifact $id has no release tarball"; exit 1; }
  cp "$tar" dist/sho-release.tar.gz
  cp "$side" dist/sho-release.tar.gz.sha256
  rm -rf dist/unpacked dist/artifact.zip
  local actual expected
  actual=$(sha256sum dist/sho-release.tar.gz | awk '{print $1}')
  expected=$(tr -d '[:space:]' < dist/sho-release.tar.gz.sha256)
  [ "$actual" = "$expected" ] || { echo "downloaded tarball does not match its digest"; exit 1; }
  echo "$actual"
}

case "$mode" in
  download-if-present)
    id=$(lookup)
    if [ -z "$id" ]; then
      echo "hit=false" >> "${GITHUB_OUTPUT:?}"
      echo "No release artifact for $name yet"
      exit 0
    fi
    digest=$(download "$id")
    echo "hit=true" >> "$GITHUB_OUTPUT"
    echo "digest=$digest" >> "$GITHUB_OUTPUT"
    echo "Reusing artifact $id ($digest)"
    ;;
  require-canonical)
    id=""
    for _ in 1 2 3 4 5 6; do
      id=$(lookup)
      [ -n "$id" ] && break
      sleep 5
    done
    [ -n "$id" ] || { echo "canonical artifact $name was not found"; exit 1; }
    digest=$(download "$id")
    echo "digest=$digest" >> "${GITHUB_OUTPUT:?}"
    echo "Canonical artifact $id digest $digest"
    ;;
  *)
    echo "unknown mode"
    exit 1
    ;;
esac

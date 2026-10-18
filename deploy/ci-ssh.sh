#!/usr/bin/env bash
# Install the deploy key for this job. The key is never printed.
set -euo pipefail
: "${HOST:?}"
: "${SSH_PRIVATE_KEY:?}"
mkdir -p ~/.ssh
chmod 700 ~/.ssh
printf '%s\n' "$SSH_PRIVATE_KEY" > ~/.ssh/id_ed25519
chmod 600 ~/.ssh/id_ed25519
if [ -n "${HOST_KEY:-}" ]; then
  printf '%s\n' "$HOST_KEY" > ~/.ssh/known_hosts
else
  echo "::warning::DROPLET_HOST_KEY is not set; trusting the host key seen now"
  ssh-keyscan -H "$HOST" > ~/.ssh/known_hosts 2>/dev/null
fi
chmod 600 ~/.ssh/known_hosts

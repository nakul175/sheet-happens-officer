#!/usr/bin/env bash
# Dry-run infra/caddy/Caddyfile.
# Runs caddy validate and caddy fmt --diff. Does not reload Caddy and does not
# contact the droplet.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
config="${root}/infra/caddy/Caddyfile"
version="2.11.7"

if [[ ! -f "$config" ]]; then
  echo "missing ${config}" >&2
  exit 1
fi

if grep -nE '\$2[aby]\$' "$config"; then
  echo "refusing a bcrypt hash in ${config}; use {env.SHO_QA_BASIC_AUTH_HASH}" >&2
  exit 1
fi

python3 - "$config" <<'PY'
import re
import sys

path = sys.argv[1]
text = open(path, encoding="utf-8").read()

if "{env.SHO_QA_BASIC_AUTH_HASH}" not in text:
    sys.exit("missing {env.SHO_QA_BASIC_AUTH_HASH}")

prod = re.search(r"(?ms)^app\.sheethappensofficer\.com \{\n(?P<body>.*?)\n\}", text)
if not prod:
    sys.exit("prod site block missing")
lines = [
    line.strip()
    for line in prod.group("body").splitlines()
    if line.strip() and not line.strip().startswith("#")
]
expected = ["encode gzip", "reverse_proxy 127.0.0.1:3000"]
if lines != expected:
    sys.exit(f"prod site block must stay {expected}, found {lines}")

if re.search(r"(?m)^http://app\.sheethappensofficer\.com\b", text):
    sys.exit("do not add an explicit http site for the prod host")

if "(staging_security)" not in text:
    sys.exit("missing (staging_security) snippet")

hosts = {
    "staging.sheethappensofficer.com": "127.0.0.1:3001",
    **{
        f"pr{n}.staging.sheethappensofficer.com": f"127.0.0.1:{3100 + n}"
        for n in range(1, 9)
    },
}
for host, upstream in hosts.items():
    block = re.search(rf"(?ms)^{re.escape(host)} \{{\n(?P<body>.*?)\n\}}", text)
    if not block:
        sys.exit(f"missing https site {host}")
    body = block.group("body")
    for needle in (
        "encode gzip",
        "import staging_security",
        "sho-qa {env.SHO_QA_BASIC_AUTH_HASH}",
        f"reverse_proxy {upstream}",
    ):
        if needle not in body:
            sys.exit(f"{host} is missing {needle}")

http_hosts = ["staging.sheethappensofficer.com"] + [
    f"pr{n}.staging.sheethappensofficer.com" for n in range(1, 9)
]
for host in http_hosts:
    if f"http://{host}" not in text:
        sys.exit(f"missing explicit http site for {host}")
if "redir https://{http.request.host}{uri} 301" not in text:
    sys.exit("missing explicit 301 redirect")
print("static checks ok")
PY

caddy_bin=""
if command -v caddy >/dev/null 2>&1; then
  caddy_bin="$(command -v caddy)"
else
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *)
      echo "unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
  case "$arch" in
    amd64) sum="a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7" ;;
    arm64) sum="3db36ba90c7a6e8dda40ee3dd71fa08844c76b5fb08f61b31e5e78d2ed38e71c51dc7baed875e50d1ca1279196e84302967237386ae87c91ae9f2aaceada682e" ;;
  esac
  cache="${TMPDIR:-/tmp}/caddy-validate-${version}-${arch}"
  mkdir -p "$cache"
  tarball="${cache}/caddy.tar.gz"
  if [[ ! -x "${cache}/caddy" ]]; then
    url="https://github.com/caddyserver/caddy/releases/download/v${version}/caddy_${version}_linux_${arch}.tar.gz"
    curl -fsSL -o "$tarball" "$url"
    python3 - "$tarball" "$sum" <<'PY'
import hashlib
import pathlib
import sys

got = hashlib.sha512(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest()
if got != sys.argv[2]:
    sys.exit(f"caddy tarball checksum mismatch: {got}")
PY
    tar -xzf "$tarball" -C "$cache" caddy
    chmod 755 "${cache}/caddy"
  fi
  caddy_bin="${cache}/caddy"
fi

if [[ -z "${SHO_QA_BASIC_AUTH_HASH:-}" ]]; then
  # Provisioning rejects an empty password. This is a throwaway bcrypt hash,
  # not the staging credential, and it is not written into the repo.
  SHO_QA_BASIC_AUTH_HASH="$("$caddy_bin" hash-password --plaintext 'ci-dummy-not-a-secret')"
  export SHO_QA_BASIC_AUTH_HASH
fi

echo "caddy: $("$caddy_bin" version)"
"$caddy_bin" validate --adapter caddyfile --config "$config"
fmt_out="$("$caddy_bin" fmt --diff --config "$config")" || {
  printf '%s\n' "$fmt_out" >&2
  echo "caddy fmt --diff reported changes" >&2
  exit 1
}
echo "caddy fmt --diff: no changes"
echo "caddy validate and fmt ok"

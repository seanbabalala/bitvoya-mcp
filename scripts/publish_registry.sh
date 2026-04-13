#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

resolve_publisher_bin() {
  if [ -n "${BITVOYA_MCP_PUBLISHER_BIN:-}" ]; then
    printf '%s\n' "$BITVOYA_MCP_PUBLISHER_BIN"
    return 0
  fi

  if command -v mcp-publisher >/dev/null 2>&1; then
    command -v mcp-publisher
    return 0
  fi

  if [ -x /root/.local/bin/mcp-publisher ]; then
    printf '%s\n' "/root/.local/bin/mcp-publisher"
    return 0
  fi

  echo "missing required command: mcp-publisher" >&2
  exit 1
}

publisher_bin="$(resolve_publisher_bin)"
registry_api="${BITVOYA_MCP_REGISTRY_API_BASE:-https://registry.modelcontextprotocol.io}"
domain="${BITVOYA_MCP_REGISTRY_DOMAIN:-bitvoya.com}"
key_file="${BITVOYA_MCP_REGISTRY_KEY_FILE:-/root/.config/mcp-registry/bitvoya.com/key.pem}"
server_json="${BITVOYA_MCP_SERVER_JSON:-${REPO_ROOT}/server.json}"
validate_only="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --validate-only)
      validate_only="true"
      shift
      ;;
    --server-json)
      server_json="$2"
      shift 2
      ;;
    --domain)
      domain="$2"
      shift 2
      ;;
    --key-file)
      key_file="$2"
      shift 2
      ;;
    --registry-api)
      registry_api="$2"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

require_cmd node
require_cmd curl
require_cmd openssl
require_cmd xxd

[ -f "$server_json" ] || {
  echo "server.json not found: $server_json" >&2
  exit 1
}

server_name="$(node --input-type=module -e "import fs from 'node:fs'; const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (!data.name || !data.version) { throw new Error('server.json must include name and version'); } console.log(data.name);" "$server_json")"
server_version="$(node --input-type=module -e "import fs from 'node:fs'; const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (!data.name || !data.version) { throw new Error('server.json must include name and version'); } console.log(data.version);" "$server_json")"

echo "Validating ${server_name} ${server_version} against ${registry_api}..."
"$publisher_bin" validate "$server_json"

if [ "$validate_only" = "true" ]; then
  exit 0
fi

set +e
registry_check_output="$(
  LOCAL_SERVER_JSON="$server_json" \
  REGISTRY_API="$registry_api" \
  SERVER_NAME="$server_name" \
  SERVER_VERSION="$server_version" \
  node --input-type=module <<'NODE' 2>&1
import fs from 'node:fs';

const local = JSON.parse(fs.readFileSync(process.env.LOCAL_SERVER_JSON, 'utf8'));
const url = `${process.env.REGISTRY_API}/v0.1/servers?search=${encodeURIComponent(process.env.SERVER_NAME)}`;
const response = await fetch(url);

if (!response.ok) {
  console.error(`failed to query registry: ${response.status} ${response.statusText}`);
  process.exit(2);
}

const payload = await response.json();
const matches = Array.isArray(payload.servers) ? payload.servers : [];
const existing = matches.find((entry) => entry?.server?.name === process.env.SERVER_NAME && entry?.server?.version === process.env.SERVER_VERSION);

if (!existing) {
  console.log('missing');
  process.exit(0);
}

const stable = (value) => {
  if (Array.isArray(value)) {
    return value.map(stable);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }

  return value;
};

if (JSON.stringify(stable(existing.server)) !== JSON.stringify(stable(local))) {
  console.error(`registry already has ${process.env.SERVER_NAME} ${process.env.SERVER_VERSION}, but the published metadata does not match local server.json`);
  process.exit(10);
}

console.log('present');
NODE
)"
registry_check_status=$?
set -e

case "$registry_check_status" in
  0)
    if [ "$registry_check_output" = "present" ]; then
      echo "Official MCP Registry already has ${server_name} ${server_version}; skipping publish."
      exit 0
    fi
    if [ "$registry_check_output" != "missing" ]; then
      echo "$registry_check_output" >&2
      exit 1
    fi
    ;;
  10)
    echo "$registry_check_output" >&2
    echo "bump server.json version before publishing updated metadata" >&2
    exit 1
    ;;
  *)
    echo "$registry_check_output" >&2
    exit 1
    ;;
esac

[ -f "$key_file" ] || {
  echo "registry DNS key not found: $key_file" >&2
  exit 1
}

private_key_hex="$(openssl pkey -in "$key_file" -outform DER 2>/dev/null | tail -c 32 | xxd -p -c 256)"
[ -n "$private_key_hex" ] || {
  echo "failed to derive registry DNS private key from: $key_file" >&2
  exit 1
}

echo "Publishing ${server_name} ${server_version} to the Official MCP Registry..."
"$publisher_bin" login dns --domain "$domain" --private-key "$private_key_hex"
"$publisher_bin" publish "$server_json"

echo "Official MCP Registry publish completed for ${server_name} ${server_version}."

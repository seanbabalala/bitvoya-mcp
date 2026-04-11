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

require_cmd pm2
require_cmd npm
require_cmd curl

app_name="${BITVOYA_MCP_PM2_APP_NAME:-bitvoya-mcp}"
bind_host="${BITVOYA_MCP_HTTP_HOST:-127.0.0.1}"
port="${BITVOYA_MCP_HTTP_PORT:-3011}"
path="${BITVOYA_MCP_HTTP_PATH:-/mcp}"
health_path="${BITVOYA_MCP_HTTP_HEALTH_PATH:-/healthz}"
env_path="${BITVOYA_MCP_ENV_PATH:-/root/.config/bitvoya-mcp/server.env}"

if pm2 describe "$app_name" >/dev/null 2>&1; then
  pm2 delete "$app_name" >/dev/null
fi

NODE_ENV=production \
BITVOYA_MCP_ENV_PATH="$env_path" \
BITVOYA_MCP_TRANSPORT=streamable_http \
BITVOYA_MCP_HTTP_HOST="$bind_host" \
BITVOYA_MCP_HTTP_PORT="$port" \
BITVOYA_MCP_HTTP_PATH="$path" \
BITVOYA_MCP_HTTP_HEALTH_PATH="$health_path" \
  pm2 start /usr/bin/npm \
    --name "$app_name" \
    --cwd "$REPO_ROOT" \
    -- run start >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS "http://${bind_host}:${port}${health_path}" >/dev/null 2>&1; then
    pm2 save >/dev/null
    echo "bitvoya MCP remote gateway deployed on http://${bind_host}:${port}${path}"
    exit 0
  fi
  sleep 1
done

echo "bitvoya MCP remote gateway failed health check on http://${bind_host}:${port}${health_path}" >&2
exit 1

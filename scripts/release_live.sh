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

ensure_dir() {
  mkdir -p "$1"
}

safe_ln() {
  local target="$1"
  local link_path="$2"

  ensure_dir "$(dirname "$link_path")"
  ln -sfn "$target" "$link_path"
}

git_release_id() {
  local repo_root="$1"

  if git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$repo_root" rev-parse --short=12 HEAD
    return 0
  fi

  date '+%Y%m%d%H%M%S'
}

latest_release_id() {
  local releases_dir="$1"

  if [ ! -d "$releases_dir" ]; then
    return 1
  fi

  find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r | head -n 1
}

keep_latest_dirs() {
  local root_dir="$1"
  local keep_count="$2"

  if [ ! -d "$root_dir" ]; then
    return 0
  fi

  mapfile -t old_dirs < <(find "$root_dir" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | awk -v keep="$keep_count" 'NR > keep { print $2 }')

  for dir_path in "${old_dirs[@]}"; do
    [ -n "$dir_path" ] || continue
    rm -rf "$dir_path"
  done
}

app_name="${BITVOYA_MCP_PM2_APP_NAME:-bitvoya-mcp}"
bind_host="${BITVOYA_MCP_HTTP_HOST:-127.0.0.1}"
port="${BITVOYA_MCP_HTTP_PORT:-3011}"
path="${BITVOYA_MCP_HTTP_PATH:-/mcp}"
health_path="${BITVOYA_MCP_HTTP_HEALTH_PATH:-/healthz}"
env_path="${BITVOYA_MCP_ENV_PATH:-/root/.config/bitvoya-mcp/server.env}"
release_root="${BITVOYA_MCP_RELEASE_ROOT:-/root/releases/bitvoya_mcp}"
current_link="${BITVOYA_MCP_CURRENT_LINK:-${release_root}/current}"
keep_releases="${BITVOYA_MCP_KEEP_RELEASES:-5}"

source_dir="$REPO_ROOT"
artifact_path=""
release_id=""
skip_install="false"
skip_check="false"
show_status="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --source)
      source_dir="$2"
      shift 2
      ;;
    --artifact)
      artifact_path="$2"
      shift 2
      ;;
    --release-id)
      release_id="$2"
      shift 2
      ;;
    --skip-install)
      skip_install="true"
      shift
      ;;
    --skip-check)
      skip_check="true"
      shift
      ;;
    --status)
      show_status="true"
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

require_cmd pm2
require_cmd npm
require_cmd curl
require_cmd rsync

show_live_status() {
  local current_release=""
  local current_release_id=""
  local latest_release=""
  local pm2_status="missing"
  local pm2_cwd=""
  local pm2_cwd_resolved=""
  local health_url="http://${bind_host}:${port}${health_path}"
  local health_status="down"
  local status_label="unknown"

  current_release="$(readlink -f "$current_link" 2>/dev/null || true)"
  current_release_id="$(basename "$current_release" 2>/dev/null || true)"
  latest_release="$(latest_release_id "${release_root}/releases" 2>/dev/null || true)"

  if pm2 describe "$app_name" >/dev/null 2>&1; then
    pm2_status="$(pm2 describe "$app_name" | awk -F'│' '/status[[:space:]]/ {gsub(/ /, "", $3); print $3; exit}')"
    pm2_cwd="$(pm2 describe "$app_name" | awk -F'│' '/exec cwd[[:space:]]/ {gsub(/^ +| +$/, "", $3); print $3; exit}')"
    pm2_cwd_resolved="$(readlink -f "$pm2_cwd" 2>/dev/null || printf '%s' "$pm2_cwd")"
  fi

  if curl -fsS "$health_url" >/dev/null 2>&1; then
    health_status="up"
  fi

  if [ -n "$current_release" ] && [ "$current_release" = "$pm2_cwd_resolved" ] && [ "$health_status" = "up" ]; then
    status_label="consistent"
  elif [ -n "$current_release" ] || [ -n "$pm2_cwd_resolved" ] || [ "$health_status" = "up" ]; then
    status_label="mismatch"
  fi

  printf 'release_root=%s\n' "$release_root"
  printf 'current_release=%s\n' "${current_release:-missing}"
  printf 'current_release_id=%s\n' "${current_release_id:-missing}"
  printf 'latest_prepared_release=%s\n' "${latest_release:-missing}"
  printf 'pm2_app=%s\n' "$app_name"
  printf 'pm2_status=%s\n' "${pm2_status:-missing}"
  printf 'pm2_cwd=%s\n' "${pm2_cwd:-missing}"
  printf 'pm2_cwd_resolved=%s\n' "${pm2_cwd_resolved:-missing}"
  printf 'health_url=%s\n' "$health_url"
  printf 'health_status=%s\n' "$health_status"
  printf 'env_path=%s\n' "$env_path"
  printf 'status=%s\n' "$status_label"
}

if [ "$show_status" = "true" ]; then
  show_live_status
  exit 0
fi

[ -z "$source_dir" ] || [ -d "$source_dir" ] || { echo "source directory not found: $source_dir" >&2; exit 1; }
[ -z "$artifact_path" ] || [ -f "$artifact_path" ] || { echo "artifact not found: $artifact_path" >&2; exit 1; }

if [ -z "$release_id" ]; then
  if [ -n "$source_dir" ]; then
    release_id="$(git_release_id "$source_dir")"
  else
    release_id="$(date '+%Y%m%d%H%M%S')"
  fi
fi

target_release="${release_root}/releases/${release_id}"

ensure_dir "${release_root}/releases"
rm -rf "$target_release"
ensure_dir "$target_release"

if [ -n "$artifact_path" ]; then
  tar -xzf "$artifact_path" -C "$target_release"
else
  rsync -a --delete \
    --exclude '.git' \
    --exclude '.github' \
    --exclude 'node_modules' \
    --exclude '.env' \
    --exclude '.env.*' \
    "${source_dir}/" "${target_release}/"
fi

if [ "$skip_install" != "true" ]; then
  (
    cd "$target_release"
    npm ci
  )
fi

if [ "$skip_check" != "true" ]; then
  (
    cd "$target_release"
    npm run check:syntax
  )
fi

safe_ln "$target_release" "$current_link"

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
    --cwd "$current_link" \
    -- run start >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS "http://${bind_host}:${port}${health_path}" >/dev/null 2>&1; then
    pm2 save >/dev/null
    keep_latest_dirs "${release_root}/releases" "$keep_releases"
    show_live_status
    exit 0
  fi
  sleep 1
done

echo "bitvoya MCP release failed health check on http://${bind_host}:${port}${health_path}" >&2
exit 1

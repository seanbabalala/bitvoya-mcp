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

allow_dirty="false"
skip_push="false"
skip_deploy="false"
skip_registry_publish="false"
skip_check="false"
release_args=()

while [ $# -gt 0 ]; do
  case "$1" in
    --allow-dirty)
      allow_dirty="true"
      shift
      ;;
    --skip-push)
      skip_push="true"
      shift
      ;;
    --skip-deploy)
      skip_deploy="true"
      shift
      ;;
    --skip-registry-publish)
      skip_registry_publish="true"
      shift
      ;;
    --release-id)
      release_args+=("$1" "$2")
      shift 2
      ;;
    --source|--artifact)
      echo "ship_release.sh only supports releasing the current repository HEAD; use release_live.sh directly for --source or --artifact" >&2
      exit 1
      ;;
    --skip-install)
      release_args+=("$1")
      shift
      ;;
    --skip-check)
      skip_check="true"
      release_args+=("$1")
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

require_cmd git
require_cmd npm

git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "repository is not a git work tree: $REPO_ROOT" >&2
  exit 1
}

branch_name="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
[ "$branch_name" != "HEAD" ] || {
  echo "release ship does not support detached HEAD; check out a branch first" >&2
  exit 1
}

if [ "$allow_dirty" != "true" ] && [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  echo "release ship requires a clean git worktree" >&2
  git -C "$REPO_ROOT" status --short >&2
  exit 1
fi

if [ "$skip_check" != "true" ]; then
  echo "Running local syntax checks..."
  (
    cd "$REPO_ROOT"
    npm run check:syntax
  )
fi

if [ "$skip_push" != "true" ]; then
  if git -C "$REPO_ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
    echo "Pushing ${branch_name} to its upstream..."
    git -C "$REPO_ROOT" push --follow-tags
  else
    echo "Pushing ${branch_name} to origin and setting upstream..."
    git -C "$REPO_ROOT" push --set-upstream origin "$branch_name" --follow-tags
  fi
fi

if [ "$skip_deploy" != "true" ]; then
  echo "Deploying live release..."
  bash "${SCRIPT_DIR}/release_live.sh" "${release_args[@]}"
fi

if [ "$skip_registry_publish" != "true" ]; then
  echo "Publishing to the Official MCP Registry..."
  bash "${SCRIPT_DIR}/publish_registry.sh"
fi

echo "Release ship completed."

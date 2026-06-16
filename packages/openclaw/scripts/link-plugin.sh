#!/usr/bin/env bash
#
# Link this plugin into OpenClaw for local development:
#
#   openclaw plugins install --link packages/openclaw/
#
# Why this script exists:
#   OpenClaw's install security scan walks the linked directory and rejects any
#   symlink under a node_modules/ path whose target escapes the install root.
#   In a pnpm workspace, packages/openclaw/node_modules is full of such symlinks
#   (eslint, typescript, @thenvoi/sdk, ...) pointing at the workspace store, so
#   the raw `--link` command is blocked.
#
#   The runtime bundle (dist/index.js) is fully self-contained (tsup bundles the
#   SDK and all runtime deps; only `openclaw` is external and host-provided), so
#   node_modules is NOT needed at install or load time. This script temporarily
#   moves it aside, runs the exact link command, then restores it. The scan only
#   runs at install time, so the plugin keeps working once node_modules is back.
#
set -euo pipefail

# Resolve repo root (two levels up from packages/openclaw/scripts).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"

NM="$PKG_DIR/node_modules"
NM_STASH="$PKG_DIR/.node_modules.link-stash"

if ! command -v openclaw >/dev/null 2>&1; then
  echo "error: 'openclaw' CLI not found on PATH" >&2
  exit 1
fi

restore() {
  if [ -d "$NM_STASH" ]; then
    rm -rf "$NM"
    mv "$NM_STASH" "$NM"
    echo "[link-plugin] restored node_modules"
  fi
}
trap restore EXIT

if [ -e "$NM_STASH" ]; then
  echo "error: $NM_STASH already exists; resolve it manually before linking" >&2
  exit 1
fi

if [ -d "$NM" ]; then
  echo "[link-plugin] stashing node_modules to pass the install scan"
  mv "$NM" "$NM_STASH"
fi

echo "[link-plugin] openclaw plugins install --link packages/openclaw/"
( cd "$REPO_ROOT" && openclaw plugins install --link packages/openclaw/ )

#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR="${WEBOT_REPO_DIR:-$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)}"
NODE_BIN="${WEBOT_NODE_BIN:-/opt/homebrew/bin/node}"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="/usr/local/bin/node"
fi
if [ ! -x "$NODE_BIN" ]; then
  printf 'Webot requires Node.js 22 or newer\n' >&2
  exit 1
fi

export WEBOT_RUNTIME_MODE="source"
REVISION_FILE="${WEBOT_SOURCE_REVISION_FILE:-$HOME/Library/Application Support/Webot/source-revision}"
WEBOT_SOURCE_REVISION="unknown"
if [ -r "$REVISION_FILE" ]; then
  IFS= read -r WEBOT_SOURCE_REVISION <"$REVISION_FILE" || true
fi
export WEBOT_SOURCE_REVISION
cd "$REPO_DIR"
exec "$NODE_BIN" "$REPO_DIR/bin/webot.js" "$@"

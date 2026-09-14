#!/bin/sh
set -eu

REPO_DIR="${WEBOT_REPO_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
ENV_FILE="${WEBOT_ENV_FILE:-$REPO_DIR/.env}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

NODE="${WEBOT_NODE:-$(command -v node)}"
exec "$NODE" "$REPO_DIR/bin/webot.js"

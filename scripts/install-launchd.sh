#!/bin/sh
set -eu

REPO_DIR="${1:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
cd "$REPO_DIR"
npm run release

VERSION="$(node -p "require('./package.json').version")"
TARGET="$(node -p "process.platform + '-' + process.arch")"
exec "$REPO_DIR/dist/webot-v$VERSION-$TARGET/install.sh"

#!/usr/bin/env bash
# Install Voice HUD into the active Hermes desktop-plugins directory.
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
TARGET="$HERMES_HOME/desktop-plugins/voice-hud"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ ! -f "$SRC_DIR/plugin.js" ]]; then
  echo "install.sh: plugin.js not found next to this script" >&2
  exit 1
fi

mkdir -p "$TARGET"
cp -f "$SRC_DIR/plugin.js" "$TARGET/plugin.js"
# optional readme for local browsing
cp -f "$SRC_DIR/README.md" "$TARGET/README.md" 2>/dev/null || true

echo "Installed Voice HUD → $TARGET/plugin.js"
echo "In Hermes Desktop: ⌘/Ctrl+K → Reload desktop plugins"
echo "Then click the voice-hud status chip or run Voice HUD: Start listening"

#!/usr/bin/env bash
# Install Voice HUD into the active Hermes desktop-plugins directory.
# Works from a git clone OR as: curl -fsSL …/install.sh | bash
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
TARGET="$HERMES_HOME/desktop-plugins/voice-hud"
REPO_RAW="${VOICE_HUD_RAW:-https://raw.githubusercontent.com/PabloTheThinker/hermes-desktop-voice-hud/main}"

mkdir -p "$TARGET"

if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  SRC_DIR=""
fi

if [[ -n "$SRC_DIR" && -f "$SRC_DIR/plugin.js" ]]; then
  cp -f "$SRC_DIR/plugin.js" "$TARGET/plugin.js"
  cp -f "$SRC_DIR/README.md" "$TARGET/README.md" 2>/dev/null || true
  echo "Installed from local clone → $TARGET/plugin.js"
else
  echo "Downloading plugin.js from $REPO_RAW …"
  curl -fsSL "$REPO_RAW/plugin.js" -o "$TARGET/plugin.js"
  curl -fsSL "$REPO_RAW/README.md" -o "$TARGET/README.md" 2>/dev/null || true
  echo "Installed from GitHub → $TARGET/plugin.js"
fi

echo "In Hermes Desktop: ⌘/Ctrl+K → Reload desktop plugins"
echo "Then click the voice-hud status chip or run: Voice HUD: Start listening"

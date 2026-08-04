#!/usr/bin/env bash
# Install Voice HUD into a Hermes desktop-plugins directory.
#
# Preferred (remote Desktop): install ONCE on the backend host. Hermes Desktop
# auto-syncs `$remote_hermes_home/desktop-plugins/*` into the local Electron
# plugin door when it connects — no per-laptop install needed.
#
#   # on the server (parallax / hermes serve host), as the hermes user:
#   HERMES_HOME=/home/ilo/.hermes ./install.sh
#
# Laptop-only (local Desktop, no remote):
#   ./install.sh
#   # or: curl -fsSL …/install.sh | bash
#
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
TARGET="$HERMES_HOME/desktop-plugins/voice-hud"
REPO_RAW="${VOICE_HUD_RAW:-https://raw.githubusercontent.com/PabloTheThinker/hermes-desktop-voice-hud/main}"

mkdir -p "$TARGET"

if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" && -f "$(dirname "${BASH_SOURCE[0]}")/plugin.js" ]]; then
  SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cp -f "$SRC_DIR/plugin.js" "$TARGET/plugin.js"
  cp -f "$SRC_DIR/README.md" "$TARGET/README.md" 2>/dev/null || true
  echo "Installed from local clone → $TARGET/plugin.js"
else
  echo "Downloading plugin.js from $REPO_RAW …"
  curl -fsSL "$REPO_RAW/plugin.js" -o "$TARGET/plugin.js"
  curl -fsSL "$REPO_RAW/README.md" -o "$TARGET/README.md" 2>/dev/null || true
  echo "Installed from GitHub → $TARGET/plugin.js"
fi

echo
echo "Where did you install?"
echo "  • Backend host (remote Desktop mode): reopen Hermes Desktop on any laptop"
echo "    connected to this server — plugins auto-sync from this directory."
echo "  • Laptop only: ⌘/Ctrl+K → Reload desktop plugins"
echo "Then: open a chat → use the Voice HUD mic in the composer (or Mod+Shift+V)."
echo "Disable anytime: Settings → Plugins → Voice HUD."

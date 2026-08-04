# Hermes Desktop Voice HUD

Optional **skin** over Hermes Desktop’s *native* voice conversation — not a second STT engine.

When you enable it and start voice, a Mark II–style strip mounts on the composer (YOU caption + fiber orb + Hermes stream). **End always stops listening.**

> Fan-inspired UI only. Not affiliated with Marvel, Disney, or Iron Man / J.A.R.V.I.S.

## Choice (opt-in)

| Control | What it does |
|---------|----------------|
| **Settings → Plugins → Voice HUD** | Master switch (`defaultEnabled: false`) |
| Composer mic (HUD) / status chip / **Mod+Shift+V** | Start/end **native** Desktop voice |
| Core voice button / Ctrl+B | Same native loop — HUD skins it if plugin is on |
| **End** (HUD or core) | Ends conversation **and** kills local capture |

Disable the plugin anytime — Desktop voice keeps working without the HUD.

## Features

- **Native voice only** — `hermes:composer-voice-toggle` + core End button
- **Hard stop** — End / stop-word / conversation off → analyser + Web Speech abort, no restart
- **`composer.top` strip** — same chrome family as stock VoiceActivity
- **`composer.actions` mic** — sits with send/model
- **YOU / Hermes chips** + film-style fiber orb
- **Optional workshop** floating pane (off by default)
- Palette: toggle, **End (stop listening)**, workshop

## Requirements

- Hermes Desktop
- Mic permission
- STT configured (same as core voice)
- Active chat session

## Install

```bash
git clone https://github.com/PabloTheThinker/hermes-desktop-voice-hud.git
cd hermes-desktop-voice-hud
./install.sh
# → ~/.hermes/desktop-plugins/voice-hud/plugin.js
```

One-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/PabloTheThinker/hermes-desktop-voice-hud/main/install.sh | bash
```

### Activate

1. Open Hermes Desktop  
2. **Settings → Plugins → Voice HUD → ON** (choice)  
3. **⌘/Ctrl+K → Reload desktop plugins**  
4. Open a chat → HUD mic / chip / **Mod+Shift+V**  
5. **End** when done — listening stops with the native conversation  

## Flow

```
Enable plugin (Settings)
   → Start (HUD or core voice)
   → Core: mic · VAD · STT · prompt · TTS · barge-in · stop-word
   → HUD: skins composer · YOU · orb · agent deltas
   → End / stop-word
   → Core ends conversation
   → HUD: stopAllCapture() — no listening leftovers
```

## Stop listening guarantee

1. `captureWanted = false` before tearing down  
2. Web Speech `onend` cleared + `abort()` so it cannot restart  
3. Analyser tracks stopped  
4. Prefer core **End** button (`endConversation`) over toggle desync  
5. DOM poll: when ConversationPill gone → force local teardown  

## License

MIT — see [LICENSE](./LICENSE).

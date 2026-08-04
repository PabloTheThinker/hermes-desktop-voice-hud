# Hermes Desktop Voice HUD

Iron Man–inspired **live speech HUD** plugin for [Hermes Desktop](https://hermes-agent.nousresearch.com/).

**Deep integration:** skins the *native* composer voice conversation (same loop as the AudioLines control / Ctrl+B) — STT, barge-in, TTS, and stop-word stay in core. The HUD is glass on top of the typing dock: **YOU** chip, film-style **fiber orb**, **REC/TCG**, and **AGENT** chip streaming `message.delta`.

> Fan-inspired UI only. Not affiliated with Marvel, Disney, or Iron Man / J.A.R.V.I.S.

## Features

- **Floating HUD pane** (draggable floating card, top-right by default)
- **Live YOU chip** — uppercase streaming caption while listening / after STT
- **Fiber orb** — canvas viz driven by mic RMS
- **REC + TCG** chrome during capture
- **AGENT chip** — live assistant text from `message.delta`
- **Hermes STT** via Desktop `POST /api/audio/transcribe` (same path as core voice)
- **Auto-submit** final utterance with `prompt.submit` on the active session
- **Continuous listen** — re-arms after silence / after the agent turn completes
- **Stop word** — say `stop` alone to end the HUD
- **Status bar chip** + **⌘/Ctrl+K** commands + **⌘/Ctrl+Shift+V** keybind
- Optional browser **Web Speech API** for interim captions when the runtime supports it (Hermes STT remains source of truth for submit)

## Requirements

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) with **Hermes Desktop**
- Working mic permission in the Desktop app
- STT configured (`stt.enabled`, local faster-whisper or a cloud provider) — same as core voice mode
- An **active chat session** before listening (HUD submits into the focused chat)

## Install

### Clone + install script

```bash
git clone https://github.com/PabloTheThinker/hermes-desktop-voice-hud.git
cd hermes-desktop-voice-hud
./install.sh
# → ~/.hermes/desktop-plugins/voice-hud/plugin.js
```

Or one-liner (default profile):

```bash
curl -fsSL https://raw.githubusercontent.com/PabloTheThinker/hermes-desktop-voice-hud/main/install.sh | bash
```

Manual copy (folder name **must** be `voice-hud`):

```bash
mkdir -p ~/.hermes/desktop-plugins/voice-hud
cp plugin.js ~/.hermes/desktop-plugins/voice-hud/
```

### Named Hermes profile

```bash
mkdir -p ~/.hermes/profiles/<name>/desktop-plugins/voice-hud
cp plugin.js ~/.hermes/profiles/<name>/desktop-plugins/voice-hud/
```

### Activate

1. Open Hermes Desktop  
2. **⌘/Ctrl+K → “Reload desktop plugins”** (or wait a few seconds for the watcher)  
3. Confirm **Settings → Plugins → Voice HUD (live speech)** is enabled  
4. Click the **voice-hud** status chip, press **⌘/Ctrl+Shift+V**, or run **Voice HUD: Start listening**

## Usage

| Action | How |
|--------|-----|
| Start / end | Status chip, HUD **Listen/End**, palette, `Mod+Shift+V`, or core voice button |
| Speak / send | Native conversation rules (silence end, barge-in, stop-word) |
| See captions | YOU chip above the composer (and optional floating card) |
| See agent | AGENT chip streams while the reply generates |

### Flow

```
Listen / Mod+Shift+V
   → dispatch hermes:composer-voice-toggle  (native voice conversation)
   → core: mic · VAD · STT · prompt · TTS · barge-in
   → HUD: YOU chip + fiber orb + REC/TCG
   → AGENT chip streams message.delta
   → End → toggle native voice off
```

## Layout

The pane registers as `placement: 'floating'` so it does **not** steal layout width. Drag it anywhere. Hide via the pane UI; prefs persist in plugin storage.

## Privacy

- Audio is sent only to **your** Hermes Desktop backend STT endpoint (local Whisper by default if configured).
- No third-party servers are contacted by this plugin.
- Interim Web Speech (when present) stays in the Chromium/Electron speech stack.

## Development

```bash
# live: Desktop watches desktop-plugins/ and hot-reloads on save
cp plugin.js ~/.hermes/desktop-plugins/voice-hud/plugin.js
# edit, save, watch the HUD update
```

Single file, no build step. Only imports:

- `@hermes/plugin-sdk`
- `react` / `react/jsx-runtime`

Authoring reference: [Desktop Plugin SDK](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk).

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Plugin missing | Folder name `voice-hud`, file `plugin.js`, Reload desktop plugins |
| Load toast error | Open DevTools console; usually a bad import or syntax error |
| Mic failed | OS permission for Hermes Desktop; close other exclusive mic apps |
| Empty transcripts | `hermes doctor` STT section; try core Desktop voice once |
| Submit does nothing | Focus a chat so `activeSessionId` is set |
| No interim words | Normal on many Electron/Linux builds — final STT still works |

## License

MIT — see [LICENSE](./LICENSE).

## Credits

- UI language inspired by the Mark II workshop HUD in *Iron Man* (2008)  
- Built for the [Hermes Agent](https://github.com/NousResearch/hermes-agent) desktop plugin host  

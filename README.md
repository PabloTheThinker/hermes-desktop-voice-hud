# Hermes Desktop Voice HUD

Iron Man–inspired **live speech HUD** plugin for [Hermes Desktop](https://hermes-agent.nousresearch.com/).

**One surface with Desktop:** skins the *native* composer voice loop (AudioLines / Ctrl+B). STT, barge-in, TTS, stop-word stay in core. The HUD uses the same chrome language as the built-in voice pill (`rounded-xl border-border/55 bg-muted/55`) and mounts on `composer.top` + a mic control on `composer.actions` — not a separate app card. Film-style fiber orb + YOU/AGENT captions while you talk.

> Fan-inspired UI only. Not affiliated with Marvel, Disney, or Iron Man / J.A.R.V.I.S.

## Features

- **Composer-native** — `composer.top` HUD + `composer.actions` mic control (with send/model)
- **Same voice engine as Desktop** — toggles core conversation via `hermes:composer-voice-toggle`
- **Hermes design tokens** — matches stock VoiceActivity strip (flat, no nested product chrome)
- **Hides stock pill while live** — one voice chrome, not two stacked bars
- **YOU caption** — film STT chip (interim Web Speech when available)
- **Fiber orb** — dense toroidal strand sphere (blue core → green/yellow rim)
- **AGENT line** — `message.delta` stream under the caption
- **Workshop pane optional** — floating canvas OFF by default (`Voice: Toggle workshop`)
- Status chip + palette + **Mod+Shift+V**

## Requirements

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) with **Hermes Desktop**
- Working mic permission in the Desktop app
- STT configured (`stt.enabled`, local faster-whisper or a cloud provider) — same as core voice mode
- An **active chat session** before starting native voice

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
3. Confirm **Settings → Plugins → Voice HUD (native voice skin)** is enabled  
4. Click the **voice-hud** status chip, press **⌘/Ctrl+Shift+V**, hit **Listen**, or use the core voice button — same conversation loop

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

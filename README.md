# Hermes Desktop Voice HUD

Optional **skin** over Hermes Desktop’s native voice conversation — not a second STT engine.

When enabled, a Mark II–style strip mounts on the composer (YOU caption + fiber orb + Hermes stream). **End always stops listening.**

> Fan-inspired UI only. Not affiliated with Marvel, Disney, or Iron Man / J.A.R.V.I.S.

## Server-first install (recommended)

If Hermes Desktop connects **remotely** to a shared backend (e.g. parallax), install the plugin **once on that server**. Every Desktop client pulls it automatically on connect — **no laptop install**.

```bash
# on the machine that runs `hermes serve` (as the hermes home user)
curl -fsSL https://raw.githubusercontent.com/PabloTheThinker/hermes-desktop-voice-hud/main/install.sh \
  | HERMES_HOME=/home/ilo/.hermes bash
# → $HERMES_HOME/desktop-plugins/voice-hud/plugin.js
```

Then reopen Hermes Desktop (or wait for the next reconnect). It mirrors  
`$remote_hermes_home/desktop-plugins/*/plugin.js` into the local Electron plugin door.

## Laptop-only install

Only needed when Desktop runs **locally** against a local backend (or you want a local override):

```bash
curl -fsSL https://raw.githubusercontent.com/PabloTheThinker/hermes-desktop-voice-hud/main/install.sh | bash
# → ~/.hermes/desktop-plugins/voice-hud/plugin.js
```

In Desktop: **⌘/Ctrl+K → Reload desktop plugins**.

## Activate

1. Open a chat  
2. Use the **Voice HUD mic** in the composer actions (or **Mod+Shift+V**)  
3. **End** when done — listening stops with the native conversation  

Optional: Settings → Plugins → Voice HUD (on by default after install; can disable).

Status bar chip only appears if the status bar is shown (**Toggle status bar** in the palette).

## Features

- **Native voice only** — same STT/VAD/submit as core Desktop voice  
- **Composer strip** + action mic  
- **Hard stop** — End / stop-word kills local capture  
- Optional floating workshop pane (palette: Voice HUD: Toggle workshop)

## Requirements

- Hermes Desktop (with remote plugin sync if using server install)  
- Mic permission  
- STT configured on the backend  
- Active chat session  

## License

MIT — see LICENSE.

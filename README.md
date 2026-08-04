# Hermes Desktop Voice HUD

Optional **in-composer** live layer for Hermes Desktop’s native voice conversation.

Sits in the same dock as the typing bar: real-time transcript, mini orb, image chips, End. Uses the **existing** Desktop voice controls (no second mic).

> Fan-inspired UI only. Not affiliated with Marvel / Disney / J.A.R.V.I.S.

## Choice

`defaultEnabled: false` — turn on in **Settings → Plugins → Voice HUD**.

## What you get

| Piece | Role |
|--------|------|
| **Live strip** (`composer.top`) | Real-time caption, phase, levels, mini orb, End |
| **Images** | Thumbnails of staged composer attachments; middleware attaches them to voice turns when possible |
| **Native voice** | Start with Desktop’s voice control (or status chip / Mod+Shift+V) |
| **Hard stop** | End / stop-word → listening fully stops |

No extra mic in the action row — stays clean with model · mic · wake · voice.

## Install

```bash
git clone https://github.com/PabloTheThinker/hermes-desktop-voice-hud.git
cd hermes-desktop-voice-hud
./install.sh
```

1. Settings → Plugins → **Voice HUD** ON  
2. Reload desktop plugins  
3. Attach images with **+** if needed  
4. Start Desktop voice  
5. Speak — live line updates in real time  
6. **End** stops listening  

## License

MIT

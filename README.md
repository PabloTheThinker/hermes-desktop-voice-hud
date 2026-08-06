# Hermes Desktop Voice HUD

Optional **skin** over Hermes Desktop native voice — continuous conversation chrome in the composer dock.

## Critical rule

**Never opens the microphone.** Desktop already owns mic for:

`listen → silence → STT → think → speak → listen again`

A second `getUserMedia` / Web Speech capture was ending the session after turn 1 (`onFatalError`). This plugin only observes and paints.

## Enable

Settings → Plugins → **Voice HUD** ON → Reload desktop plugins.

## Use

1. Start voice with Desktop’s voice control (or status `hud` / Mod+Shift+V)
2. Speak → pause → reply → **speak again** (continuous)
3. **End** stops listening

## License

MIT

# Orb-first voice UX research (2026-08)

## Products studied
- **ChatGPT Advanced Voice**: classic full-screen reactive orb (listen / think / speak). Later moved into the chat window with visible transcripts — users wanted words *and* continuity; classic orb still prioritizes **motion as the voice**.
- **Grok Voice**: speech-forward experience; voice orbs/colors per voice character; speech-to-speech feel where the UI is the speaking agent, not a log.
- **AI UX pattern “Voice visualizer”**: real-time waveform/orb motion across listen → think → speak states.

## Design principles applied to Voice HUD
1. **Orb is primary** — AI “speaks through” the orb (size/energy up on speaking).
2. **Words are ephemeral** — captions appear briefly then fade (hold ~1.4s, fade ~0.9s); no chat replay.
3. **Phase personality** — listening (teal/calm), thinking (amber pulse), speaking (blue/violet energy).
4. **Native stack only** — still `hermes:voice-bus` + Desktop Whisper; no second mic.
5. **Stop stays Stop** — no End self-click loop.

## Sources
- PCMag: ChatGPT voice into chat / orb history
- AI UX Playground: Voice visualizer pattern
- FuseLab VUI 2026 guide
- xAI / Grok Voice Think Fast 2.0 + voice product notes

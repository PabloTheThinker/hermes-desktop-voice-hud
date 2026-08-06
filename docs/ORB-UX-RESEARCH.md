# ChatGPT Live voice UX → Hermes Voice HUD (2026-08-06)

## Reference
OpenAI product shot (Live / GPT-Live): three Android panels —
1. Chat + small bottom orb while Live runs in-thread  
2. **Full Live stage**: white canvas, soft blue–white sphere, concentric ripple rings, top “Live”, bottom Ask bar + End  
3. Voice settings (Maple, Live/Advanced/Standard) — settings surface, not the stage  

X: OpenAI GPT-Live announcements; ChatGPT Voice docs (Chat / Work / Codex).

## Locked visual system
| Element | Spec |
|---------|------|
| Stage | Light `#f8fafc` wash, soft blue radial glow |
| Orb | White core → periwinkle rim, soft bloom |
| Motion | Expanding concentric rings + gentle breathe |
| Phase | Listen green dot · Think amber · Speak blue pulse |
| Words | Ephemeral ghost under orb (fade), not a log |
| Chrome | Top pill “Live” + End only |
| Cover | Full session over chat (thread dimmed) |

## Native contract (unchanged)
`hermes:voice-bus` + Desktop Whisper. No second mic / Web Speech.

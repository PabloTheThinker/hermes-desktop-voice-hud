# Voice orb UX research → redesign (2026-08-06)

## Sources
- X: @tonbistudio Hermes Desktop browser post (context); Grok iOS voice **colored orbs** (@testingcatalog / @n5waha)
- grok.com — voice mode on desktop (signed-in surface); soft sphere aesthetic on product/console
- ChatGPT Voice (GPT-Live): voice in Chat / Work / **Codex** desktop app — conversation stays covered, controls = mic mute / speaker mute / end
- OpenAI learn docs: ChatGPT Voice coordinates tasks without leaving the app mode

## Product patterns locked
| Pattern | Grok | ChatGPT / Codex voice |
|---------|------|------------------------|
| Visual | Soft **colored orb** per voice | Soft liquid sphere / in-chat voice stage |
| Space | Full voice stage | Covers conversation mode (not a side chrome strip) |
| Words | Secondary | Transcript optional; voice is primary |
| Controls | Minimal | Mute mic, mute speakers, End |

## What we rejected
- Dense Iron Man fiber/torus orb (previous HUD) — too busy, not Grok/ChatGPT
- Dock-only strip — does not “cover the conversation”

## What we shipped
- Full-session dark glass stage over the chat
- **One soft luminous sphere** + halo + subtle liquid shimmer (no fiber mesh)
- Phase colors: listen teal, think amber, speak blue/violet
- Ephemeral ghost words that fade
- Top pill: phase · timer · End (Stop stays HUD-safe)

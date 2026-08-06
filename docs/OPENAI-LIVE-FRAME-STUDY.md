# OpenAI ChatGPT Voice desktop promo — frame study

Source: https://x.com/OpenAI/status/2080378182469857576 (~69s)
Local: `docs/openai-live-ref.mp4` + `docs/openai-live-frames/`

## What the video actually shows

This is a **lifestyle / product story** (Jason Liu, Guinness Chen) more than a pure UI walkthrough. UI appears mainly on **laptop screens and wall projection**.

### Chronology (approx.)
| Time | Scene | UI takeaway |
|------|--------|-------------|
| 0–8s | “Hey, Chat.” cold open | Wake-by-voice, no chrome |
| ~10–25s | Team preparing Voice launch | Work happens while talking |
| ~20s | Projected desktop: **“New Realtime Voice Chat”** title bar; transcript of draft launch post (“Meet Voice in the desktop…”) | Voice session = **named chat**, transcript remains readable |
| ~30s | Projected workspace with **small soft blue–white orb** bottom-right of canvas | Orb is **not always full-bleed**; sits in workspace ambient |
| ~40–55s | Codex / feature-flag dialogue while soft orb glows on projection | Voice **coordinates Work/Codex**; orb is ambient presence |
| End | “Building with voice” | Product message: voice steers multi-agent desktop work |

### UI patterns locked from video + Android Live shot (user image)
1. **Soft sphere** white→periwinkle, gentle breathe — never mesh/fiber  
2. **Concentric soft rings** (Android Live full stage)  
3. **Two scales:** small ambient orb in workspace **or** full light Live stage  
4. **Transcript can stay** (desktop promo) — words not only ghost; dual mode OK  
5. **Minimal chrome:** Live label · End; pastel blue/pink ambient wash  
6. **Conversation continuity:** same session, voice steers Work/Codex  

### Why Hermes HUD was broken
1. **Syntax corruption:** `function setLiveAttrfunction setLiveAttr` after a bad CSS patch → plugin failed to load  
2. **`defaultEnabled: false`** → off unless Settings toggle  
3. **Full-screen stage registered in `composer.top`** → parent stacking/clipping hid the overlay  

### Fix
- Repair `setLiveAttr`  
- `defaultEnabled: true`  
- Mount Live stage on **`document.body` portal** (`#voice-hud-live-portal`, z-index max)  
- Status chip **Live** starts / ends session  

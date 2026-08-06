# Voice HUD — Assessment (2026-08-06)

## What you asked for
1. Iron Man–style HUD integrated in the Desktop composer
2. Continuous multi-turn native voice (not one-shot)
3. Real-time display of **what you are saying** while speaking
4. **Not** a second chat transcript / replay inside the dock
5. Clean End/Stop (no open–close loop)
6. Work alongside images / normal composer chrome

## Architecture (as built)

```
Desktop core (source of truth)
  voiceConversationActive
    → exclusive mic + VAD (silence ~1.25s)
    → Whisper STT → submit → think → speak
    → re-arm listen…

Voice HUD plugin (skin only)
  composer.top strip
    → phase / levels (from core End pill bars)
    → YOU live caption (Web Speech interim, listening-only)
    → HERMES one-line stream (message.delta)
    → Stop → clicks core End only
```

Plugin path: `~/.hermes/desktop-plugins/voice-hud/plugin.js`  
Repo: https://github.com/PabloTheThinker/hermes-desktop-voice-hud

## Bugs found and fixed

| # | Symptom | Root cause | Fix |
|---|---------|------------|-----|
| 1 | Stops after first turn | Plugin second mic (`getUserMedia` / held Web Speech) → core `startListening` fails → `onFatalError` ends session | No MediaRecorder/getUserMedia; Web Speech only while `listening`, hard-abort on leave; delayed start 350ms |
| 2 | Continuous re-arm dies | Core cleared `pendingStart` then early-returned while busy/barge | Desktop patch: requeue + soft-retry; `listenGenerationRef` cancels retries on End |
| 3 | End opens/closes in a loop | HUD `aria-label*="End …"` matched `findEndButton` → `clickCoreEnd` clicked ourselves | `findCoreEndButton` only core “End voice conversation”; HUD control is **Stop** + `data-voice-hud-end` |
| 4 | End “restarts” voice | `endVoice` did `dispatchVoiceToggle` when pill gone → toggle **starts** | End never toggles; only clicks core End |
| 5 | “You Dot life…” copy | UI used “You · live” (dot read aloud) | Label is plain `YOU` + `live` (no middle-dot) |
| 6 | Chat replay in dock | Multi-turn YOU/HERMES ribbon scraped bubbles | Single caption line only; no history stack |

## Real-time caption — honest limits

Desktop **does not** stream interim Whisper text during conversation mode. Final STT runs **after** silence.

Live words therefore use **Web Speech API** (browser):
- Armed only in `listening`
- Aborted before STT / think / speak so continuous re-arm keeps the mic
- If Electron has no `SpeechRecognition` or mic policy blocks it, strip shows  
  `Listening (live words unavailable…)` and Desktop STT still works  
- After STT, caption can fill from the committed user bubble (one line, not a log)

**If you still only see “Listening…” while speaking:** Web Speech is unavailable in this Desktop build — continuous voice is preferred over a second mic. True core-side interim would need a Desktop feature (streaming STT / shared caption bus).

## Continuous conversation checklist

- [x] Core owns mic for VAD/STT  
- [x] HUD does not hold capture across turns  
- [x] Soft-retry re-arm in packaged Desktop (rebuild 2026-08-06)  
- [x] Stop does not restart session  
- [ ] **You must fully quit + relaunch Desktop** once so packaged re-arm build loads  
- [ ] Reload plugins after each `plugin.js` push  

## Images

HUD no longer injects incomplete attachment middleware (that could stick `busy` and kill re-listen).  
Staged `+` images stay in the composer; typed sends include them. Voice turns still follow core (text submit path).

## How to verify (dogfood)

1. Fully quit Hermes Desktop → relaunch  
2. Settings → Plugins → **Voice HUD** ON → Reload plugins  
3. Start **Desktop** voice (waveform control)  
4. Speak slowly: caption line should fill with words (if Web Speech works)  
5. Pause → Got it / Thinking / reply  
6. Speak again **without** Stop — session should stay live  
7. Press **Stop** once — must stay off (no flap)  

## Residual risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Web Speech unavailable in Electron | Medium for “live words” | Fallback copy + STT bubble fill; future: core interim bus |
| Web Speech still contests mic on some OS | Medium | 350ms delay + hard abort; if turn-2 dies again, disable caption engine |
| Desktop not relaunched after re-arm patch | High | User quit/relaunch |
| Cursor Blue Team quota exhausted | Low | ILO audited + patched |

## Status summary

| Goal | Status |
|------|--------|
| Composer-integrated HUD | Done |
| Continuous native voice | Fixed in core + plugin (relaunch required) |
| End loop | Fixed |
| No chat replay | Done |
| Live words while speaking | Implemented via listening-only Web Speech; OS-dependent |
| Images safe | Middleware removed |
| Assessment | This document |

---
*Written by ILO · Vektra / Parallax house · 2026-08-06*

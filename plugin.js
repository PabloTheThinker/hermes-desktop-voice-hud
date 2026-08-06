/**
 * voice-hud — ChatGPT-style voice integrated in the conversation session.
 *
 * Layout target (OpenAI desktop Voice shot):
 *  • Transcript stays the page — fully readable
 *  • Soft blue–white orb floats IN the message area (lower center)
 *  • No card / glass panel chrome around the orb
 *  • Mic · Speaker · End under the orb only
 *  • Composer remains at the bottom
 *
 * Native: hermes:voice-bus. No second mic.
 * defaultEnabled: true. Imports: @hermes/plugin-sdk + react* only.
 */
import {
  Badge,
  COMPOSER_AREAS,
  KEYBINDS_AREA,
  PALETTE_AREA,
  STATUSBAR_AREAS,
  Tip,
  atom,
  haptic,
  host,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect } from 'react'
import { jsx } from 'react/jsx-runtime'

const PLUGIN_ID = 'voice-hud'
const VOICE_TOGGLE_EVENT = 'hermes:composer-voice-toggle'
const VOICE_BUS_EVENT = 'hermes:voice-bus'
const STYLE_ID = 'voice-hud-css'
const ROOT_ID = 'voice-hud-session-root'
const END_MISS_TOLERANCE = 12
const CORE_END_RE = /end voice conversation/i
const WORD_HOLD_MS = 5500
const WORD_FADE_MS = 1200
const SESSION_HOLD_MS = 2500

/** @typedef {'idle' | 'listening' | 'recording' | 'transcribing' | 'thinking' | 'speaking'} Phase */

const $nativeActive = atom(false)
const $phase = atom(/** @type {Phase} */ ('idle'))
const $level = atom(0)
const $caption = atom('')
const $agentLine = atom('')
const $elapsed = atom(0)
const $error = atom('')
const $mode = atom(/** @type {'off' | 'dictation' | 'conversation'} */ ('off'))
const $busOk = atom(false)
const $ghostText = atom('')
const $ghostRole = atom(/** @type {'you' | 'agent' | ''} */ (''))
const $ghostOpacity = atom(0)
const $micMuted = atom(false)
const $speakerMuted = atom(false)

let pollTimer = 0
let endWatch = 0
let elapsedTimer = 0
let fadeTimer = 0
let fadeRaf = 0
let layoutTimer = 0
let orbRaf = 0
let startedAt = 0
let endMisses = 0
let ending = false
/** @type {null | ((e: Event) => void)} */
let busListener = null
let lastGhostKey = ''
/** @type {HTMLCanvasElement | null} */
let orbCanvas = null
let orbT0 = 0

function formatElapsed(sec) {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function phaseLabel(p) {
  if (p === 'listening' || p === 'recording') return 'Listening'
  if (p === 'transcribing') return 'Got it'
  if (p === 'thinking') return 'Thinking'
  if (p === 'speaking') return 'Speaking'
  return 'Voice'
}

function isHudNode(el) {
  return Boolean(
    el?.closest?.('[data-voice-hud="1"]') ||
      el?.getAttribute?.('data-voice-hud-end') === '1' ||
      el?.id === ROOT_ID
  )
}

function dispatchVoiceToggle() {
  try {
    window.dispatchEvent(new CustomEvent(VOICE_TOGGLE_EVENT, { detail: { target: 'main' } }))
    return true
  } catch (err) {
    $error.set(err instanceof Error ? err.message : String(err))
    return false
  }
}

function findCoreEndButton() {
  if (typeof document === 'undefined') return null
  const roots = document.querySelectorAll(
    '[data-slot="composer-root"], [data-slot="composer-dock"], [data-slot="composer-fade"]'
  )
  const scopes = roots.length ? Array.from(roots) : [document]
  for (const root of scopes) {
    for (const btn of root.querySelectorAll?.('button') || []) {
      if (isHudNode(btn)) continue
      if (CORE_END_RE.test((btn.getAttribute('aria-label') || '').trim())) return btn
    }
  }
  for (const root of scopes) {
    for (const btn of root.querySelectorAll?.('button') || []) {
      if (isHudNode(btn)) continue
      const text = (btn.textContent || '').replace(/\s+/g, ' ').trim()
      if (!/^end$/i.test(text)) continue
      if (btn.querySelector('span.w-0\\.5, span[class*="w-0.5"]')) return btn
    }
  }
  return null
}

function findCoreStartButton() {
  if (typeof document === 'undefined') return null
  for (const btn of document.querySelectorAll(
    '[data-slot="composer-root"] button, [data-slot="composer-dock"] button'
  )) {
    if (isHudNode(btn)) continue
    const label = (btn.getAttribute('aria-label') || '').toLowerCase()
    if (label.includes('start voice') || label.includes('voice conversation')) return btn
  }
  return null
}

function clickCoreEnd() {
  const btn = findCoreEndButton()
  if (btn?.click) {
    btn.click()
    return true
  }
  return false
}

function clickCoreStart() {
  const btn = findCoreStartButton()
  if (btn?.click) {
    btn.click()
    return true
  }
  return false
}

function clearFadeTimers() {
  if (fadeTimer) {
    clearTimeout(fadeTimer)
    fadeTimer = 0
  }
  if (fadeRaf) {
    cancelAnimationFrame(fadeRaf)
    fadeRaf = 0
  }
}

function clearTimersSoft() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = 0
  }
  if (endWatch) {
    clearTimeout(endWatch)
    endWatch = 0
  }
  if (layoutTimer) {
    clearInterval(layoutTimer)
    layoutTimer = 0
  }
  clearFadeTimers()
}

function clearGhost() {
  clearFadeTimers()
  $ghostText.set('')
  $ghostRole.set('')
  $ghostOpacity.set(0)
  lastGhostKey = ''
}

/**
 * @param {string} text
 * @param {'you' | 'agent'} role
 * @param {{ sticky?: boolean }} [opts]
 */
function showGhostWords(text, role, opts = {}) {
  const t = (text || '').trim()
  if (!t) return
  const key = `${role}:${t}`
  const sticky = Boolean(opts.sticky)
  if (key === lastGhostKey && sticky) {
    $ghostOpacity.set(1)
    scheduleFade(true)
    paintHud()
    return
  }
  lastGhostKey = key
  $ghostText.set(t)
  $ghostRole.set(role)
  $ghostOpacity.set(1)
  scheduleFade(sticky)
  paintHud()
}

function scheduleFade(extendOnly) {
  clearFadeTimers()
  const hold = extendOnly ? WORD_HOLD_MS + 1000 : WORD_HOLD_MS
  fadeTimer = window.setTimeout(() => {
    fadeTimer = 0
    const start = performance.now()
    const from = $ghostOpacity.get()
    const tick = now => {
      const u = Math.min(1, (now - start) / WORD_FADE_MS)
      $ghostOpacity.set(from * (1 - u))
      paintHud()
      if (u < 1 && lastGhostKey) fadeRaf = requestAnimationFrame(tick)
      else {
        fadeRaf = 0
        if (u >= 1) {
          $ghostText.set('')
          $ghostRole.set('')
          $ghostOpacity.set(0)
          lastGhostKey = ''
          paintHud()
        }
      }
    }
    fadeRaf = requestAnimationFrame(tick)
  }, hold)
}

function killLegacy() {
  document.getElementById('voice-hud-live-portal')?.remove()
  document.getElementById('voice-hud-mac-panel')?.remove()
  document.documentElement.removeAttribute('data-voice-hud-live')
}

function setLiveAttr(on) {
  if (typeof document === 'undefined') return
  document.querySelectorAll('[data-slot="composer-root"], [data-slot="composer-dock"]').forEach(n => {
    if (on) n.setAttribute('data-voice-hud-live', '1')
    else n.removeAttribute('data-voice-hud-live')
  })
  killLegacy()
  ensureCss()
  if (on) mountHud()
  else unmountHud()
}

function resetSessionUi() {
  $phase.set('idle')
  $level.set(0)
  $elapsed.set(0)
  $caption.set('')
  $agentLine.set('')
  $mode.set('off')
  $micMuted.set(false)
  $speakerMuted.set(false)
  clearGhost()
  endMisses = 0
  ending = false
  setLiveAttr(false)
  clearTimersSoft()
}

function startElapsed() {
  startedAt = performance.now()
  $elapsed.set(0)
  if (elapsedTimer) clearInterval(elapsedTimer)
  elapsedTimer = window.setInterval(() => {
    if (!$nativeActive.get()) {
      clearInterval(elapsedTimer)
      elapsedTimer = 0
      return
    }
    $elapsed.set(performance.now() - startedAt)
    paintHud()
  }, 250)
}

function endVoice() {
  if (ending) return
  ending = true
  haptic('close')
  $error.set('')
  if (findCoreEndButton()) clickCoreEnd()
  $nativeActive.set(false)
  resetSessionUi()
  endWatch = window.setTimeout(() => {
    endWatch = 0
    ending = false
    if (findCoreEndButton()) clickCoreEnd()
  }, 300)
}

function startVoice() {
  if (ending) return
  $error.set('')
  if (findCoreEndButton() || $nativeActive.get()) return
  haptic('open')
  $caption.set('')
  $agentLine.set('')
  clearGhost()
  if (!clickCoreStart()) dispatchVoiceToggle()
}

function toggleVoice() {
  if (ending) return
  if (findCoreEndButton()) endVoice()
  else if ($nativeActive.get()) {
    $nativeActive.set(false)
    resetSessionUi()
  } else startVoice()
}

function toggleMicMute() {
  $micMuted.set(!$micMuted.get())
  haptic('tap')
  paintHud()
  try {
    const btn = [...document.querySelectorAll('[data-slot="composer-root"] button, [data-slot="composer-dock"] button')].find(
      b => /mute|unmute/i.test(b.getAttribute('aria-label') || '') && !isHudNode(b)
    )
    if (btn) btn.click()
  } catch {
    /* ignore */
  }
}

function toggleSpeakerMute() {
  $speakerMuted.set(!$speakerMuted.get())
  haptic('tap')
  paintHud()
  try {
    if ($speakerMuted.get()) {
      document.querySelectorAll('audio, video').forEach(el => {
        try {
          el.pause?.()
        } catch {
          /* ignore */
        }
      })
    }
  } catch {
    /* ignore */
  }
}

// --- Bus --------------------------------------------------------------------

function onVoiceBus(ev) {
  const d = ev?.detail
  if (!d || typeof d !== 'object') return
  $busOk.set(true)

  const mode = d.mode || 'off'
  const phase = d.phase || 'idle'
  const active = Boolean(d.active && mode !== 'off')
  $mode.set(mode === 'dictation' || mode === 'conversation' ? mode : 'off')

  if (typeof d.level === 'number' && Number.isFinite(d.level)) {
    $level.set(Math.max(0, Math.min(1, d.level)))
  }

  if (typeof d.caption === 'string' && d.caption.trim()) {
    const cap = d.caption.trim()
    $caption.set(cap)
    showGhostWords(cap, 'you', {
      sticky: Boolean(d.partial) || phase === 'listening' || phase === 'recording'
    })
  }

  if (active && !$nativeActive.get()) {
    $nativeActive.set(true)
    $error.set('')
    startElapsed()
    setLiveAttr(true)
  }
  if (!active && $nativeActive.get() && !findCoreEndButton()) return

  if (active) {
    $nativeActive.set(true)
    setLiveAttr(true)
    if (phase === 'recording') $phase.set('listening')
    else if (
      phase === 'listening' ||
      phase === 'transcribing' ||
      phase === 'thinking' ||
      phase === 'speaking' ||
      phase === 'idle'
    ) {
      $phase.set(phase === 'idle' ? 'listening' : phase)
    }
    paintHud()
  }
}

function wireVoiceBus() {
  if (typeof window === 'undefined' || busListener) return
  busListener = onVoiceBus
  window.addEventListener(VOICE_BUS_EVENT, busListener)
}

function unwireVoiceBus() {
  if (typeof window === 'undefined' || !busListener) return
  window.removeEventListener(VOICE_BUS_EVENT, busListener)
  busListener = null
}

function wireDomFallback() {
  if (pollTimer) return
  let lastSeenLive = 0
  pollTimer = window.setInterval(() => {
    if (ending) return
    const endBtn = findCoreEndButton()
    const busAlive = $busOk.get() && $mode.get() !== 'off'
    if (endBtn || busAlive) {
      endMisses = 0
      lastSeenLive = Date.now()
      if (!$nativeActive.get()) {
        $nativeActive.set(true)
        startElapsed()
        setLiveAttr(true)
        if (!$busOk.get()) {
          $phase.set('listening')
          $error.set('')
        }
      }
      if (endBtn && !$busOk.get()) {
        const bars = endBtn.querySelectorAll('span.w-0\\.5, span[class*="w-0.5"]')
        if (bars.length) {
          const mid = bars[Math.floor(bars.length / 2)]
          const h = parseFloat(mid.style?.height || '')
          if (Number.isFinite(h) && h > 0) {
            $level.set(Math.max(0, Math.min(1, (h / 100 - 0.3) / 0.7)))
          }
        }
      }
      paintHud()
    } else if ($nativeActive.get()) {
      endMisses += 1
      if (
        endMisses >= END_MISS_TOLERANCE &&
        Date.now() - lastSeenLive > SESSION_HOLD_MS &&
        $mode.get() !== 'dictation'
      ) {
        $nativeActive.set(false)
        resetSessionUi()
      }
    }
  }, 100)
}

function stopDomFallback() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = 0
}

function wireGateway() {
  return host.onEvent('*', event => {
    if (!event || typeof event !== 'object') return
    if (!$nativeActive.get() && !findCoreEndButton()) return
    const type = event.type
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
    const sid = event.session_id || payload.session_id
    const activeSid = host.state.activeSessionId.get()
    if (sid && activeSid && sid !== activeSid) return

    if (type === 'message.start') {
      $agentLine.set('')
      $phase.set('thinking')
      paintHud()
    } else if (type === 'message.delta') {
      const chunk = String(payload.text || payload.delta || '')
      if (!chunk) return
      const next = ($agentLine.get() + chunk).slice(-420)
      $agentLine.set(next)
      $phase.set('speaking')
    } else if (type === 'message.complete') {
      $agentLine.set('')
      if (findCoreEndButton() || $nativeActive.get()) $phase.set('listening')
      paintHud()
    }
  })
}

// --- In-conversation HUD (no panel) -----------------------------------------

function ensureCss() {
  if (typeof document === 'undefined') return
  let el = document.getElementById(STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = `
/* Hide stock voice status strip (we own the voice chrome) */
[data-voice-hud-live="1"] [data-slot="composer-fade"] > [aria-live="polite"][role="status"].h-8:not([data-voice-hud]) {
  display: none !important;
}
/* Chat stays fully readable — no dim */
[data-voice-hud-live="1"] [data-slot="messages"],
[data-voice-hud-live="1"] [data-slot="thread"],
[data-voice-hud-live="1"] [data-slot="chat-scroll"] {
  opacity: 1 !important;
  filter: none !important;
  pointer-events: auto !important;
}
/* Soft bottom fade so messages don't collide with the voice dock */
[data-voice-hud-live="1"] [data-slot="composer-root"],
[data-voice-hud-live="1"] [data-slot="composer-dock"] {
  position: relative;
  z-index: 5;
}

/* ChatGPT-style voice dock: sits ABOVE composer only — never over message bubbles */
#${ROOT_ID} {
  position: fixed;
  z-index: 60;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  pointer-events: none;
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0 12px 4px;
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
#${ROOT_ID} > * { pointer-events: auto; }

/* Tiny phase chip — not a transcript overlay */
#${ROOT_ID} .vh-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(12, 14, 20, 0.45);
  border: 1px solid rgba(255,255,255,0.08);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: rgba(226, 232, 240, 0.88);
}
#${ROOT_ID} .vh-dot {
  width: 6px;
  height: 6px;
  border-radius: 99px;
  background: #34c759;
  box-shadow: 0 0 0 3px rgba(52,199,89,0.16);
}
#${ROOT_ID} .vh-dot[data-on="speak"] {
  background: #0a84ff;
  box-shadow: 0 0 0 3px rgba(10,132,255,0.18);
}
#${ROOT_ID} .vh-dot[data-on="think"] {
  background: #ff9f0a;
  box-shadow: 0 0 0 3px rgba(255,159,10,0.16);
}
#${ROOT_ID} .vh-chip .vh-time {
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: rgba(148, 163, 184, 0.95);
}

#${ROOT_ID} .vh-orb-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
}

/* Control row — ChatGPT: mic · speaker · end */
#${ROOT_ID} .vh-ctrls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 2px 0 0;
}
#${ROOT_ID} .vh-btn {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  border: none;
  background: rgba(15, 18, 28, 0.35);
  color: rgba(241, 245, 249, 0.92);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  transition: background 140ms ease, opacity 140ms ease, transform 140ms ease;
}
#${ROOT_ID} .vh-btn:hover { background: rgba(15, 18, 28, 0.55); }
#${ROOT_ID} .vh-btn:active { transform: scale(0.96); }
#${ROOT_ID} .vh-btn[data-on="1"] { opacity: 0.4; }
#${ROOT_ID} .vh-btn.vh-end { color: rgba(252, 165, 165, 0.95); }

/* NO big caption over chat — legacy nodes hidden */
#${ROOT_ID} .vh-caption { display: none !important; }

#voice-hud-live-portal,
#voice-hud-mac-panel { display: none !important; }
`
}

function getComposerRect() {
  const el = document.querySelector('[data-slot="composer-root"], [data-slot="composer-dock"]')
  if (el) {
    const r = el.getBoundingClientRect()
    if (r.width > 120) return r
  }
  return null
}

function getWorkspaceWidthRect() {
  const sels = [
    '[data-slot="chat-scroll"]',
    '[data-slot="messages"]',
    '[data-slot="workspace"]',
    'main'
  ]
  for (const s of sels) {
    const el = document.querySelector(s)
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.width > 200) return r
  }
  return null
}

/**
 * Dock the voice chrome tightly ABOVE the composer — ChatGPT desktop pattern.
 * Never center mid-transcript (that caused caption/orb collision with bubbles).
 */
function layoutHud() {
  const root = document.getElementById(ROOT_ID)
  if (!root || !$nativeActive.get()) return

  const composer = getComposerRect()
  const workspace = getWorkspaceWidthRect()

  const width = Math.min(
    360,
    (workspace?.width || composer?.width || window.innerWidth * 0.55) * 0.92
  )
  const leftBase = workspace?.left ?? composer?.left ?? window.innerWidth * 0.22
  const fullW = workspace?.width ?? composer?.width ?? window.innerWidth * 0.56
  const left = leftBase + (fullW - width) / 2

  // Height of dock stack: chip + orb + controls ≈ 130px
  const dockH = 132
  const gap = 10
  let top
  if (composer) {
    top = composer.top - dockH - gap
  } else {
    top = window.innerHeight - dockH - 96
  }
  top = Math.max(56, Math.min(top, window.innerHeight - dockH - 24))

  root.style.width = `${Math.round(width)}px`
  root.style.left = `${Math.round(Math.max(12, left))}px`
  root.style.top = `${Math.round(top)}px`
  root.style.height = `${dockH}px`
}

function svgMic(muted) {
  return muted
    ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 9v3a3 3 0 005.1 2.1"/><path d="M15 9.3V5a3 3 0 00-5.8-1"/><path d="M5 10v2a7 7 0 0011 5.7"/><line x1="2" y1="2" x2="22" y2="22"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10v2a7 7 0 0014 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`
}

function svgSpeaker(muted) {
  return muted
    ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 010 7"/><path d="M18.5 5.5a9 9 0 010 13"/></svg>`
}

function svgClose() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function paintHud() {
  const root = document.getElementById(ROOT_ID)
  if (!root || !$nativeActive.get()) return

  const phase = $phase.get()
  const listening = phase === 'listening' || phase === 'recording'
  const speaking = phase === 'speaking'
  const thinking = phase === 'thinking' || phase === 'transcribing'
  const dot = speaking ? 'speak' : thinking ? 'think' : 'listen'

  const chip = root.querySelector('[data-vh-chip]')
  if (chip) {
    chip.innerHTML =
      `<span class="vh-dot" data-on="${dot}"></span>` +
      `<span>${phaseLabel(phase)}</span>` +
      `<span class="vh-time">${formatElapsed($elapsed.get() / 1000)}</span>`
  }

  const mic = root.querySelector('[data-vh-mic]')
  const spk = root.querySelector('[data-vh-spk]')
  if (mic) {
    mic.setAttribute('data-on', $micMuted.get() ? '1' : '0')
    mic.innerHTML = svgMic($micMuted.get())
  }
  if (spk) {
    spk.setAttribute('data-on', $speakerMuted.get() ? '1' : '0')
    spk.innerHTML = svgSpeaker($speakerMuted.get())
  }
}

function startOrbLoop() {
  if (orbRaf) cancelAnimationFrame(orbRaf)
  orbT0 = performance.now()
  const draw = now => {
    const c = orbCanvas
    const root = document.getElementById(ROOT_ID)
    if (!c || !root || !$nativeActive.get()) {
      orbRaf = 0
      return
    }
    const ctx = c.getContext('2d')
    if (!ctx) {
      orbRaf = requestAnimationFrame(draw)
      return
    }

    const phase = $phase.get()
    const lv = Math.max(0, Math.min(1, $level.get()))
    const speaking = phase === 'speaking'
    const listening = phase === 'listening' || phase === 'recording'
    // ChatGPT desktop scale — modest sphere in the conversation
    const size = speaking ? 64 : listening ? 60 : 56
    const pad = Math.round(size * 0.48)
    const W = size + pad * 2
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
    if (c.width !== Math.round(W * dpr)) {
      c.width = Math.round(W * dpr)
      c.height = Math.round(W * dpr)
      c.style.width = W + 'px'
      c.style.height = W + 'px'
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const t = (now - orbT0) / 1000
    const cx = W / 2
    const cy = W / 2
    let energy = 0.2
    let speed = 1.0
    if (listening) {
      energy = 0.34 + lv * 0.5
      speed = 1.08
    } else if (phase === 'thinking' || phase === 'transcribing') {
      energy = 0.28
      speed = 1.38
    } else if (speaking) {
      energy = 0.48 + lv * 0.36
      speed = 1.18
    }

    const breathe = 1 + Math.sin(t * 2.0 * speed) * (0.028 + energy * 0.02)
    const R = size * 0.5 * breathe
    ctx.clearRect(0, 0, W, W)

    // Soft ambient glow only — no panel
    const wash = ctx.createRadialGradient(cx, cy, R * 0.12, cx, cy, R * 1.75)
    wash.addColorStop(0, `rgba(170, 205, 255, ${0.28 + energy * 0.18})`)
    wash.addColorStop(0.5, `rgba(130, 175, 250, ${0.1 + energy * 0.08})`)
    wash.addColorStop(1, 'rgba(80, 120, 200, 0)')
    ctx.fillStyle = wash
    ctx.beginPath()
    ctx.arc(cx, cy, R * 1.75, 0, Math.PI * 2)
    ctx.fill()

    // Soft sphere (product shot)
    const body = ctx.createRadialGradient(cx - R * 0.22, cy - R * 0.3, R * 0.04, cx, cy + R * 0.08, R)
    body.addColorStop(0, 'rgba(255,255,255,1)')
    body.addColorStop(0.28, 'rgba(235,242,255,0.98)')
    body.addColorStop(0.55, 'rgba(180,210,255,0.95)')
    body.addColorStop(0.82, `rgba(130,175,250,${0.9 + energy * 0.05})`)
    body.addColorStop(1, `rgba(95,145,235,${0.55 + energy * 0.12})`)
    ctx.fillStyle = body
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.beginPath()
    ctx.ellipse(cx - R * 0.2, cy - R * 0.26, R * 0.14, R * 0.09, -0.5, 0, Math.PI * 2)
    ctx.fill()

    orbRaf = requestAnimationFrame(draw)
  }
  orbRaf = requestAnimationFrame(draw)
}

function mountHud() {
  if (typeof document === 'undefined') return
  ensureCss()
  killLegacy()

  let root = document.getElementById(ROOT_ID)
  if (!root) {
    root = document.createElement('div')
    root.id = ROOT_ID
    root.setAttribute('data-voice-hud', '1')
    root.setAttribute('role', 'status')
    root.setAttribute('aria-live', 'polite')
    root.innerHTML = `
      <div class="vh-chip" data-vh-chip></div>
      <div class="vh-orb-wrap" data-vh-orb></div>
      <div class="vh-ctrls">
        <button type="button" class="vh-btn" data-vh-mic aria-label="Mute microphone" title="Mute mic"></button>
        <button type="button" class="vh-btn" data-vh-spk aria-label="Mute speaker" title="Mute speaker"></button>
        <button type="button" class="vh-btn vh-end" data-voice-hud-end="1" data-vh-end aria-label="End voice" title="End"></button>
      </div>
    `
    document.body.appendChild(root)

    root.querySelector('[data-vh-mic]')?.addEventListener('click', e => {
      e.preventDefault()
      e.stopPropagation()
      toggleMicMute()
    })
    root.querySelector('[data-vh-spk]')?.addEventListener('click', e => {
      e.preventDefault()
      e.stopPropagation()
      toggleSpeakerMute()
    })
    root.querySelector('[data-vh-end]')?.addEventListener('click', e => {
      e.preventDefault()
      e.stopPropagation()
      endVoice()
    })
  }

  const wrap = root.querySelector('[data-vh-orb]')
  if (wrap && !orbCanvas) {
    const c = document.createElement('canvas')
    c.setAttribute('aria-hidden', 'true')
    c.style.filter = 'drop-shadow(0 10px 30px rgba(90,150,255,0.28))'
    wrap.innerHTML = ''
    wrap.appendChild(c)
    orbCanvas = c
    startOrbLoop()
  } else if (orbCanvas && !orbRaf) {
    startOrbLoop()
  }

  layoutHud()
  paintHud()
  if (!layoutTimer) {
    layoutTimer = window.setInterval(() => {
      if ($nativeActive.get()) layoutHud()
    }, 350)
  }
  window.addEventListener('resize', layoutHud)
}

function unmountHud() {
  if (orbRaf) {
    cancelAnimationFrame(orbRaf)
    orbRaf = 0
  }
  orbCanvas = null
  if (layoutTimer) {
    clearInterval(layoutTimer)
    layoutTimer = 0
  }
  window.removeEventListener('resize', layoutHud)
  document.getElementById(ROOT_ID)?.remove()
  killLegacy()
}

// Composer slot stays empty — HUD lives in the conversation surface
function LiveStrip() {
  const active = useValue($nativeActive)
  const error = useValue($error)

  useEffect(() => {
    if (active) mountHud()
    else unmountHud()
  }, [active])

  if (!active && error) {
    return jsx('div', {
      className:
        'mb-1 rounded-lg border border-destructive/30 bg-destructive/10 px-2 py-1 text-[0.7rem] text-destructive',
      children: error
    })
  }
  return null
}

function StatusChip() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  return jsx(Tip, {
    content: active ? 'Voice in session — click to End' : 'Start voice in this conversation',
    children: jsx('button', {
      type: 'button',
      className: 'inline-flex',
      onClick: () => (active ? endVoice() : toggleVoice()),
      children: jsx(Badge, {
        variant: active ? 'default' : 'outline',
        className: 'cursor-pointer gap-1 font-normal',
        children: active ? `Voice · ${phase}` : 'Voice'
      })
    })
  })
}

export default {
  id: PLUGIN_ID,
  name: 'Voice HUD',
  defaultEnabled: true,
  register(ctx) {
    ensureCss()
    unmountHud()
    wireVoiceBus()
    wireDomFallback()
    const offGw = wireGateway()

    const disposeRegs = ctx.registerMany([
      {
        id: 'live-strip',
        area: COMPOSER_AREAS.top,
        order: 1,
        render: () => jsx(LiveStrip, {})
      },
      {
        id: 'chip',
        area: STATUSBAR_AREAS.right,
        order: 125,
        render: () => jsx(StatusChip, {})
      },
      {
        id: 'toggle',
        area: PALETTE_AREA,
        data: {
          id: 'voice-hud.toggle',
          action: 'voice-hud.toggle',
          label: 'Voice HUD: Toggle (in conversation)',
          keywords: ['voice', 'hud', 'live', 'orb', 'chatgpt'],
          run: () => toggleVoice()
        }
      },
      {
        id: 'end',
        area: PALETTE_AREA,
        data: {
          id: 'voice-hud.end',
          label: 'Voice HUD: End',
          keywords: ['voice', 'end', 'stop'],
          run: () => endVoice()
        }
      },
      {
        id: 'bind',
        area: KEYBINDS_AREA,
        data: {
          id: 'voice-hud.toggle',
          label: 'Voice HUD: Toggle',
          category: 'Voice',
          defaults: ['mod+shift+v'],
          run: () => toggleVoice()
        }
      }
    ])

    const cleanup = () => {
      try {
        offGw()
      } catch {
        /* ignore */
      }
      unwireVoiceBus()
      stopDomFallback()
      resetSessionUi()
      unmountHud()
      document.getElementById(STYLE_ID)?.remove()
      try {
        disposeRegs?.()
      } catch {
        /* ignore */
      }
    }
    if (typeof ctx.onDispose === 'function') ctx.onDispose(cleanup)
    if (typeof ctx.onUnload === 'function') ctx.onUnload(cleanup)
  }
}

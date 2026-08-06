/**
 * voice-hud — ChatGPT desktop Voice layout (in-session).
 *
 * Reference (OpenAI desktop Voice / user shot):
 *  • Chat transcript stays fully visible (no full-desktop cover)
 *  • Soft blue–white orb floats above the composer
 *  • Minimal controls under orb: mic · speaker · End
 *  • Words optional / light — conversation is the page
 *
 * Native: hermes:voice-bus only. No second mic.
 * defaultEnabled: true. Imports: @hermes/plugin-sdk + react* only.
 */
import {
  Badge,
  Button,
  COMPOSER_AREAS,
  KEYBINDS_AREA,
  PALETTE_AREA,
  STATUSBAR_AREAS,
  Tip,
  atom,
  cn,
  haptic,
  host,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useRef } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'voice-hud'
const VOICE_TOGGLE_EVENT = 'hermes:composer-voice-toggle'
const VOICE_BUS_EVENT = 'hermes:voice-bus'
const STYLE_ID = 'voice-hud-css'
const END_MISS_TOLERANCE = 12
const CORE_END_RE = /end voice conversation/i
const WORD_HOLD_MS = 5500
const WORD_FADE_MS = 1200
const SESSION_HOLD_MS = 2500
const LEGACY_PORTAL_ID = 'voice-hud-live-portal'

/** @typedef {'idle' | 'listening' | 'recording' | 'transcribing' | 'thinking' | 'speaking'} Phase */

const $nativeActive = atom(false)
const $phase = atom(/** @type {Phase} */ ('idle'))
const $level = atom(0)
const $caption = atom('')
const $captionPartial = atom(false)
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
let startedAt = 0
let endMisses = 0
let ending = false
/** @type {null | ((e: Event) => void)} */
let busListener = null
let lastGhostKey = ''

function formatElapsed(sec) {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function phaseLabel(p) {
  if (p === 'listening' || p === 'recording') return 'Listening'
  if (p === 'transcribing') return 'Got it'
  if (p === 'thinking') return 'Thinking'
  if (p === 'speaking') return 'Speaking'
  return 'Live'
}

function isHudNode(el) {
  return Boolean(
    el?.closest?.('[data-voice-hud="1"]') || el?.getAttribute?.('data-voice-hud-end') === '1'
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
    return
  }
  if (key === lastGhostKey && !sticky && $ghostOpacity.get() > 0.5) {
    scheduleFade(false)
    return
  }

  lastGhostKey = key
  $ghostText.set(t)
  $ghostRole.set(role)
  $ghostOpacity.set(1)
  scheduleFade(sticky)
}

function scheduleFade(extendOnly) {
  clearFadeTimers()
  const hold = extendOnly ? WORD_HOLD_MS + 1200 : WORD_HOLD_MS
  fadeTimer = window.setTimeout(() => {
    fadeTimer = 0
    const start = performance.now()
    const from = $ghostOpacity.get()
    const tick = now => {
      const u = Math.min(1, (now - start) / WORD_FADE_MS)
      $ghostOpacity.set(from * (1 - u))
      if (u < 1 && lastGhostKey) {
        fadeRaf = requestAnimationFrame(tick)
      } else {
        fadeRaf = 0
        if (u >= 1) {
          $ghostText.set('')
          $ghostRole.set('')
          $ghostOpacity.set(0)
          lastGhostKey = ''
        }
      }
    }
    fadeRaf = requestAnimationFrame(tick)
  }, hold)
}

function killLegacyPortal() {
  if (typeof document === 'undefined') return
  document.getElementById(LEGACY_PORTAL_ID)?.remove()
  document.documentElement.removeAttribute('data-voice-hud-live')
}

function setLiveAttr(on) {
  if (typeof document === 'undefined') return
  document.querySelectorAll('[data-slot="composer-root"], [data-slot="composer-dock"]').forEach(n => {
    if (on) n.setAttribute('data-voice-hud-live', '1')
    else n.removeAttribute('data-voice-hud-live')
  })
  killLegacyPortal()
  ensureCss()
}

function resetSessionUi() {
  $phase.set('idle')
  $level.set(0)
  $elapsed.set(0)
  $caption.set('')
  $captionPartial.set(false)
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
  }, 200)
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
  const next = !$micMuted.get()
  $micMuted.set(next)
  haptic('tap')
  // Best-effort: click core mute if present
  try {
    const btn = [...document.querySelectorAll('[data-slot="composer-root"] button, [data-slot="composer-dock"] button')].find(
      b => /mute|unmute/i.test(b.getAttribute('aria-label') || '')
    )
    if (btn && !isHudNode(btn)) btn.click()
  } catch {
    /* ignore */
  }
}

function toggleSpeakerMute() {
  $speakerMuted.set(!$speakerMuted.get())
  haptic('tap')
  // Pause any playing media elements as a soft mute fallback
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
    $captionPartial.set(Boolean(d.partial))
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
    killLegacyPortal()
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

function ensureCss() {
  if (typeof document === 'undefined') return
  let el = document.getElementById(STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = `
/* Hide stock voice status strip only */
[data-voice-hud-live="1"] [data-slot="composer-fade"] > [aria-live="polite"][role="status"].h-8:not([data-voice-hud]) {
  display: none !important;
}
/* Transcript stays primary — no dim, no blur, no full cover */
[data-voice-hud-live="1"] [data-slot="messages"],
[data-voice-hud-live="1"] [data-slot="thread"],
[data-voice-hud-live="1"] [data-slot="chat-scroll"] {
  opacity: 1 !important;
  filter: none !important;
  pointer-events: auto !important;
}
/* Floating orb dock above composer — ChatGPT desktop Voice pattern */
[data-voice-hud="1"].vh-float {
  position: relative;
  z-index: 6;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  margin: 0 0 0.35rem 0;
  padding: 0.35rem 0.5rem 0.55rem;
  border: none;
  background: transparent;
  pointer-events: none;
}
[data-voice-hud="1"].vh-float > * {
  pointer-events: auto;
}
[data-voice-hud="1"] .vh-caption {
  max-width: min(36rem, 92%);
  margin: 0 auto 0.35rem;
  text-align: center;
  min-height: 1.4rem;
  transition: opacity 0.35s ease;
}
[data-voice-hud="1"] .vh-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.85rem;
  margin-top: 0.15rem;
}
[data-voice-hud="1"] .vh-ctrl {
  width: 2.35rem;
  height: 2.35rem;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(15, 18, 28, 0.55);
  color: rgba(226, 232, 240, 0.92);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
}
[data-voice-hud="1"] .vh-ctrl:hover {
  background: rgba(30, 41, 59, 0.75);
  border-color: rgba(148, 163, 184, 0.28);
}
[data-voice-hud="1"] .vh-ctrl[data-on="1"] {
  opacity: 0.45;
  border-color: rgba(248, 113, 113, 0.35);
}
[data-voice-hud="1"] .vh-ctrl.vh-end {
  color: rgba(252, 165, 165, 0.95);
}
#${LEGACY_PORTAL_ID} {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
`
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
    } else if (type === 'message.delta') {
      const chunk = String(payload.text || payload.delta || '')
      if (!chunk) return
      const next = ($agentLine.get() + chunk).slice(-420)
      $agentLine.set(next)
      $phase.set('speaking')
      showGhostWords(next.slice(-240), 'agent', { sticky: true })
    } else if (type === 'message.complete') {
      if ($agentLine.get()) showGhostWords($agentLine.get().slice(-240), 'agent', { sticky: false })
      $agentLine.set('')
      if (findCoreEndButton() || $nativeActive.get()) $phase.set('listening')
    }
  })
}

// --- Soft orb (ChatGPT desktop scale) ---------------------------------------

function VoiceOrb({ size = 72 }) {
  const ref = useRef(null)
  const level = useValue($level)
  const phase = useValue($phase)
  const lr = useRef(level)
  const pr = useRef(phase)
  lr.current = level
  pr.current = phase

  useEffect(() => {
    const c = ref.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    let raf = 0
    const t0 = performance.now()
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
    const pad = Math.round(size * 0.42)
    const W = size + pad * 2
    c.width = Math.round(W * dpr)
    c.height = Math.round(W * dpr)
    c.style.width = W + 'px'
    c.style.height = W + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const draw = now => {
      const t = (now - t0) / 1000
      const cx = W / 2
      const cy = W / 2
      const ph = pr.current
      const lv = Math.max(0, Math.min(1, lr.current))

      let energy = 0.2
      let speed = 1.0
      if (ph === 'listening' || ph === 'recording') {
        energy = 0.34 + lv * 0.5
        speed = 1.1
      } else if (ph === 'transcribing' || ph === 'thinking') {
        energy = 0.28
        speed = 1.4
      } else if (ph === 'speaking') {
        energy = 0.5 + lv * 0.35
        speed = 1.2
      }

      const breathe = 1 + Math.sin(t * 2.05 * speed) * (0.028 + energy * 0.022)
      const R = size * 0.5 * breathe
      ctx.clearRect(0, 0, W, W)

      // Soft outer wash (like the product shot glow)
      const wash = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.7)
      wash.addColorStop(0, `rgba(180, 210, 255, ${0.22 + energy * 0.18})`)
      wash.addColorStop(0.55, `rgba(140, 180, 255, ${0.08 + energy * 0.08})`)
      wash.addColorStop(1, 'rgba(100, 140, 220, 0)')
      ctx.fillStyle = wash
      ctx.beginPath()
      ctx.arc(cx, cy, R * 1.7, 0, Math.PI * 2)
      ctx.fill()

      // Sphere — white → soft blue (ChatGPT Live)
      const body = ctx.createRadialGradient(
        cx - R * 0.22,
        cy - R * 0.3,
        R * 0.04,
        cx + R * 0.05,
        cy + R * 0.1,
        R
      )
      body.addColorStop(0, 'rgba(255, 255, 255, 1)')
      body.addColorStop(0.32, 'rgba(230, 240, 255, 0.98)')
      body.addColorStop(0.62, 'rgba(170, 200, 255, 0.94)')
      body.addColorStop(0.88, `rgba(120, 165, 245, ${0.9 + energy * 0.05})`)
      body.addColorStop(1, `rgba(90, 140, 230, ${0.55 + energy * 0.12})`)
      ctx.fillStyle = body
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, Math.PI * 2)
      ctx.fill()

      // Specular
      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      ctx.beginPath()
      ctx.ellipse(cx - R * 0.2, cy - R * 0.26, R * 0.15, R * 0.09, -0.5, 0, Math.PI * 2)
      ctx.fill()

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size])

  return jsx('canvas', {
    ref,
    'aria-hidden': true,
    className: 'block',
    style: { filter: 'drop-shadow(0 8px 24px rgba(100,150,255,0.25))' }
  })
}

function IconMic({ muted }) {
  // Simple geometric icons (no external icon packs)
  return jsx('svg', {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.8,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    children: muted
      ? [
          jsx('path', { d: 'M9 9v3a3 3 0 0 0 5.1 2.1', key: 'a' }),
          jsx('path', { d: 'M15 9.3V5a3 3 0 0 0-5.8-1', key: 'b' }),
          jsx('path', { d: 'M5 10v2a7 7 0 0 0 11 5.7', key: 'c' }),
          jsx('path', { d: 'M19 10v2c0 .3 0 .7-.1 1', key: 'd' }),
          jsx('line', { x1: 2, y1: 2, x2: 22, y2: 22, key: 'e' }),
          jsx('line', { x1: 12, y1: 19, x2: 12, y2: 22, key: 'f' }),
          jsx('line', { x1: 8, y1: 22, x2: 16, y2: 22, key: 'g' })
        ]
      : [
          jsx('rect', { x: 9, y: 2, width: 6, height: 11, rx: 3, key: 'a' }),
          jsx('path', { d: 'M5 10v2a7 7 0 0 0 14 0v-2', key: 'b' }),
          jsx('line', { x1: 12, y1: 19, x2: 12, y2: 22, key: 'c' }),
          jsx('line', { x1: 8, y1: 22, x2: 16, y2: 22, key: 'd' })
        ]
  })
}

function IconSpeaker({ muted }) {
  return jsx('svg', {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.8,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    children: muted
      ? [
          jsx('polygon', { points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5', key: 'a' }),
          jsx('line', { x1: 23, y1: 9, x2: 17, y2: 15, key: 'b' }),
          jsx('line', { x1: 17, y1: 9, x2: 23, y2: 15, key: 'c' })
        ]
      : [
          jsx('polygon', { points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5', key: 'a' }),
          jsx('path', { d: 'M15.5 8.5a5 5 0 0 1 0 7', key: 'b' }),
          jsx('path', { d: 'M18.5 5.5a9 9 0 0 1 0 13', key: 'c' })
        ]
  })
}

function IconClose() {
  return jsx('svg', {
    width: 15,
    height: 15,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    children: [jsx('line', { x1: 18, y1: 6, x2: 6, y2: 18, key: 'a' }), jsx('line', { x1: 6, y1: 6, x2: 18, y2: 18, key: 'b' })]
  })
}

function LiveStrip() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  const ghostText = useValue($ghostText)
  const ghostRole = useValue($ghostRole)
  const ghostOpacity = useValue($ghostOpacity)
  const caption = useValue($caption)
  const error = useValue($error)
  const busOk = useValue($busOk)
  const elapsed = useValue($elapsed)
  const micMuted = useValue($micMuted)
  const speakerMuted = useValue($speakerMuted)

  useEffect(() => {
    killLegacyPortal()
  }, [active])

  if (!active) {
    if (error) {
      return jsx('div', {
        className:
          'mb-1 rounded-lg border border-destructive/30 bg-destructive/10 px-2 py-1 text-[0.7rem] text-destructive',
        children: error
      })
    }
    return null
  }

  const listening = phase === 'listening' || phase === 'recording'
  const speaking = phase === 'speaking'
  // ChatGPT desktop: modest orb above composer
  const orbSize = speaking ? 78 : listening ? 72 : 68

  const showText = ghostText && ghostOpacity > 0.02 ? ghostText : (caption || '').trim()
  const showRole = ghostText && ghostOpacity > 0.02 ? ghostRole : showText ? 'you' : ''
  const showOp = ghostText && ghostOpacity > 0.02 ? ghostOpacity : showText ? 1 : 0

  return jsxs('div', {
    className: 'vh-float',
    role: 'status',
    'aria-live': 'polite',
    'data-voice-hud': '1',
    'data-vh-phase': phase,
    children: [
      // Light caption above orb (optional; transcript is the main page)
      jsx('div', {
        className: 'vh-caption',
        style: { opacity: showText && showOp > 0.02 ? showOp : 0.55 },
        children:
          showText && showOp > 0.02
            ? jsxs('div', {
                children: [
                  jsx('div', {
                    className: cn(
                      'mb-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.14em]',
                      showRole === 'agent' ? 'text-sky-300/90' : 'text-emerald-300/90'
                    ),
                    children: showRole === 'agent' ? 'ILO' : 'YOU'
                  }),
                  jsx('div', {
                    className: cn(
                      'line-clamp-2 text-[0.92rem] font-medium leading-snug',
                      showRole === 'agent' ? 'text-sky-50/95' : 'text-slate-100/95'
                    ),
                    children: showText
                  })
                ]
              })
            : jsx('div', {
                className: 'text-[0.78rem] text-slate-400/90',
                children: !busOk
                  ? 'Starting…'
                  : `${phaseLabel(phase)} · ${formatElapsed(elapsed / 1000)}`
              })
      }),

      jsx(VoiceOrb, { size: orbSize }),

      // Mic · Speaker · End  (ChatGPT pattern)
      jsxs('div', {
        className: 'vh-controls',
        children: [
          jsx('button', {
            type: 'button',
            className: 'vh-ctrl',
            'data-on': micMuted ? '1' : '0',
            'aria-label': micMuted ? 'Unmute microphone' : 'Mute microphone',
            title: micMuted ? 'Unmute' : 'Mute mic',
            onClick: e => {
              e.preventDefault()
              e.stopPropagation()
              toggleMicMute()
            },
            children: jsx(IconMic, { muted: micMuted })
          }),
          jsx('button', {
            type: 'button',
            className: 'vh-ctrl',
            'data-on': speakerMuted ? '1' : '0',
            'aria-label': speakerMuted ? 'Unmute speaker' : 'Mute speaker',
            title: speakerMuted ? 'Unmute speaker' : 'Mute speaker',
            onClick: e => {
              e.preventDefault()
              e.stopPropagation()
              toggleSpeakerMute()
            },
            children: jsx(IconSpeaker, { muted: speakerMuted })
          }),
          jsx('button', {
            type: 'button',
            className: 'vh-ctrl vh-end',
            'aria-label': 'Stop voice HUD',
            'data-voice-hud-end': '1',
            title: 'End voice',
            onClick: e => {
              e.preventDefault()
              e.stopPropagation()
              endVoice()
            },
            children: jsx(IconClose, {})
          })
        ]
      })
    ]
  })
}

function StatusChip() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  return jsx(Tip, {
    content: active ? 'Voice Live in this chat — click to End' : 'Start Voice Live in this chat',
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
    killLegacyPortal()
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
          label: 'Voice HUD: Toggle Live (in chat)',
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
          label: 'Voice HUD: Toggle Live',
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
      killLegacyPortal()
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

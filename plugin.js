/**
 * voice-hud — ChatGPT Live–style voice stage over Hermes Desktop native voice.
 *
 * Target UX (OpenAI Live / GPT-Live product shots):
 *  • Clean light full-session stage over the conversation
 *  • Soft blue–white luminous sphere (not fiber/torus clutter)
 *  • Concentric ripple rings reacting to mic level / phase
 *  • Minimal top "Live" chrome + End
 *  • Ephemeral words only — no chat replay panel
 *
 * Native stack only: hermes:voice-bus (Desktop Whisper). No second mic.
 * Opt-in: defaultEnabled false. Imports: @hermes/plugin-sdk + react* only.
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
/** How long ephemeral words stay fully visible before fade. */
const WORD_HOLD_MS = 1200
/** Fade duration (CSS matches). */
const WORD_FADE_MS = 800
/** Keep session overlay up while bus/core says active. */
const SESSION_HOLD_MS = 2500

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
/** Ephemeral overlay text (fades). */
const $ghostText = atom('')
const $ghostRole = atom(/** @type {'you' | 'agent' | ''} */ (''))
/** 0–1 visual opacity for ghost text. */
const $ghostOpacity = atom(0)

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
 * Show ephemeral words then fade them away (ChatGPT/Grok orb pattern:
 * speech is felt in the orb; text is temporary).
 * @param {string} text
 * @param {'you' | 'agent'} role
 * @param {{ sticky?: boolean }} [opts] sticky = hold while still streaming (partials)
 */
function showGhostWords(text, role, opts = {}) {
  const t = (text || '').trim()
  if (!t) return
  const key = `${role}:${t}`
  const sticky = Boolean(opts.sticky)

  // Same partial growing — refresh opacity without restarting full hold if already visible
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
  const hold = extendOnly ? WORD_HOLD_MS : WORD_HOLD_MS
  fadeTimer = window.setTimeout(() => {
    fadeTimer = 0
    const start = performance.now()
    const from = $ghostOpacity.get()
    const tick = now => {
      const u = Math.min(1, (now - start) / WORD_FADE_MS)
      const next = from * (1 - u)
      $ghostOpacity.set(next)
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

function resetSessionUi() {
  $phase.set('idle')
  $level.set(0)
  $elapsed.set(0)
  $caption.set('')
  $captionPartial.set(false)
  $agentLine.set('')
  $mode.set('off')
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

// --- Native voice bus --------------------------------------------------------

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
    // YOU words: show while listening/recording/transcribing, then fade
    if (phase === 'listening' || phase === 'recording' || phase === 'transcribing') {
      showGhostWords(cap, 'you', { sticky: Boolean(d.partial) })
    }
  }

  if (active && !$nativeActive.get()) {
    $nativeActive.set(true)
    $error.set('')
    startElapsed()
    setLiveAttr(true)
  }

  if (!active && $nativeActive.get() && !findCoreEndButton()) {
    // Bus off and no core pill — only tear down after a short hold so
    // between-turn idle gaps do not collapse the full-session overlay.
    return
  }

  if (active) {
    $nativeActive.set(true)
    setLiveAttr(true)
    const prev = $phase.get()
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

    // Phase transitions that clear / retarget words
    if (phase === 'speaking' && prev !== 'speaking') {
      // Orb takes over — fade YOU words immediately
      scheduleFade(false)
    }
    if (phase === 'listening' && (prev === 'speaking' || prev === 'thinking')) {
      $caption.set('')
      $agentLine.set('')
      // fresh listen — ghost clear
      clearGhost()
    }
    if (phase === 'thinking' && prev === 'transcribing') {
      // brief hold then fade committed YOU caption
      if ($caption.get()) showGhostWords($caption.get(), 'you', { sticky: false })
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
      // Hold full-session overlay across turn gaps; only collapse after
      // both core End and bus have been gone for a while.
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
/* Hide stock voice strip while Live owns the surface */
[data-voice-hud-live="1"] [data-slot="composer-fade"] > [aria-live="polite"][role="status"].h-8:not([data-voice-hud]) {
  display: none !important;
}
/* Soften thread behind Live stage (ChatGPT keeps context faintly) */
[data-voice-hud-live="1"] [data-slot="messages"],
[data-voice-hud-live="1"] [data-slot="thread"],
[data-voice-hud-live="1"] main [data-session-scroll],
html[data-voice-hud-live="1"] [data-slot="chat-scroll"] {
  opacity: 0.12 !important;
  filter: blur(2px);
  pointer-events: none !important;
  transition: opacity 0.45s ease, filter 0.45s ease;
}
/* Full-session Live stage — light canvas like ChatGPT Live */
[data-voice-hud="1"].vh-session {
  position: fixed !important;
  inset: 0 !important;
  z-index: 80 !important;
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  margin: 0 !important;
  padding: 1.25rem 1rem 6.5rem !important;
  border: none !important;
  border-radius: 0 !important;
  background:
    radial-gradient(circle at 50% 48%, rgba(147, 197, 253, 0.35) 0%, rgba(219, 234, 254, 0.55) 28%, rgba(248, 250, 252, 0.97) 58%, #f8fafc 100%) !important;
  backdrop-filter: none !important;
  box-shadow: none !important;
  color: #0f172a !important;
}
/* Concentric guide rings (static base; canvas draws active ripples) */
[data-voice-hud="1"].vh-session::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 46%;
  width: min(92vmin, 720px);
  height: min(92vmin, 720px);
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background:
    radial-gradient(circle, transparent 18%, rgba(147, 197, 253, 0.07) 18.5%, transparent 19%),
    radial-gradient(circle, transparent 28%, rgba(147, 197, 253, 0.08) 28.5%, transparent 29.5%),
    radial-gradient(circle, transparent 38%, rgba(147, 197, 253, 0.07) 38.5%, transparent 39.5%),
    radial-gradient(circle, transparent 48%, rgba(147, 197, 253, 0.06) 48.5%, transparent 49.5%),
    radial-gradient(circle, transparent 58%, rgba(147, 197, 253, 0.05) 58.5%, transparent 59.5%);
  pointer-events: none;
  z-index: 0;
}
[data-voice-hud="1"] .vh-stage {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}
[data-voice-hud="1"] .vh-topbar {
  position: absolute;
  top: 1rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: min(20rem, calc(100% - 2rem));
  justify-content: space-between;
  padding: 0.35rem 0.5rem 0.35rem 0.85rem;
  border-radius: 999px;
  background: rgba(255,255,255,0.72);
  border: 1px solid rgba(15, 23, 42, 0.06);
  box-shadow: 0 8px 30px rgba(15, 23, 42, 0.06);
  backdrop-filter: blur(12px);
}
[data-voice-hud="1"] .vh-live-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.92rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: #0f172a;
}
[data-voice-hud="1"] .vh-live-dot {
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 999px;
  background: #22c55e;
  box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.15);
}
[data-voice-hud="1"] .vh-live-dot[data-on="speak"] {
  background: #3b82f6;
  box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.18);
  animation: vh-pulse 1.2s ease-in-out infinite;
}
[data-voice-hud="1"] .vh-live-dot[data-on="think"] {
  background: #f59e0b;
  box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.16);
}
@keyframes vh-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.15); opacity: 0.75; }
}
[data-voice-hud="1"] .vh-ghost {
  transition: opacity 0.4s ease, transform 0.45s ease;
  will-change: opacity, transform;
  color: #334155;
}
[data-voice-hud="1"] .vh-orb-shell {
  filter: drop-shadow(0 12px 40px rgba(96, 165, 250, 0.28));
}
[data-voice-hud-live="1"] [data-slot="composer-root"],
[data-voice-hud-live="1"] [data-slot="composer-dock"] {
  position: relative;
  z-index: 90 !important;
}
`
}

function setLiveAttrfunction setLiveAttr(on) {
  if (typeof document === 'undefined') return
  document.querySelectorAll('[data-slot="composer-root"], [data-slot="composer-dock"]').forEach(n => {
    if (on) n.setAttribute('data-voice-hud-live', '1')
    else n.removeAttribute('data-voice-hud-live')
  })
  if (on) document.documentElement.setAttribute('data-voice-hud-live', '1')
  else document.documentElement.removeAttribute('data-voice-hud-live')
  ensureCss()
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
      // thinking: orb only — fade residual YOU text
      scheduleFade(false)
    } else if (type === 'message.delta') {
      const chunk = String(payload.text || payload.delta || '')
      if (!chunk) return
      const next = ($agentLine.get() + chunk).slice(-320)
      $agentLine.set(next)
      $phase.set('speaking')
      // Brief ghost of agent words then they disappear — orb is the voice
      showGhostWords(next.slice(-160), 'agent', { sticky: true })
    } else if (type === 'message.complete') {
      $agentLine.set('')
      // Final fade-out of agent words
      scheduleFade(false)
      if (findCoreEndButton() || $nativeActive.get()) {
        $phase.set('listening')
        $caption.set('')
        $captionPartial.set(false)
        // After a beat, clear ghost fully for clean listen
        window.setTimeout(() => {
          if ($phase.get() === 'listening') clearGhost()
        }, WORD_HOLD_MS + WORD_FADE_MS)
      }
    }
  })
}

// --- Orb (primary UI — AI “speaks through” this) -----------------------------

function VoiceOrb({ size = 180 }) {
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
    // Extra room for expanding ripples (ChatGPT Live rings)
    const pad = Math.round(size * 0.85)
    const W = size + pad * 2
    c.width = Math.round(W * dpr)
    c.height = Math.round(W * dpr)
    c.style.width = W + 'px'
    c.style.height = W + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    /**
     * ChatGPT Live orb: soft blue–white sphere + concentric ripples.
     * Reference: OpenAI Live product UI (center phone in marketing shot).
     */
    const draw = now => {
      const t = (now - t0) / 1000
      const cx = W / 2
      const cy = W / 2
      const ph = pr.current
      const lv = Math.max(0, Math.min(1, lr.current))

      let energy = 0.2
      let speed = 1.0
      // Soft blue family (screenshot): periwinkle → white
      if (ph === 'listening' || ph === 'recording') {
        energy = 0.35 + lv * 0.55
        speed = 1.15
      } else if (ph === 'transcribing' || ph === 'thinking') {
        energy = 0.28
        speed = 1.5
      } else if (ph === 'speaking') {
        energy = 0.55 + lv * 0.4
        speed = 1.25
      }

      const breathe = 1 + Math.sin(t * 2.0 * speed) * (0.03 + energy * 0.025)
      const R = size * 0.5 * breathe

      ctx.clearRect(0, 0, W, W)

      // Concentric ripples (ChatGPT Live signature)
      const ringCount = 5
      for (let i = 0; i < ringCount; i++) {
        const phaseOff = (t * speed * 0.35 + i / ringCount) % 1
        const rr = R * (1.15 + phaseOff * (1.9 + energy * 0.6))
        const alpha = (1 - phaseOff) * (0.1 + energy * 0.16)
        ctx.beginPath()
        ctx.arc(cx, cy, rr, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(147, 197, 253, ${alpha})`
        ctx.lineWidth = 1.25 + (1 - phaseOff) * 1.5
        ctx.stroke()
      }

      // Soft outer bloom
      const bloom = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, R * 1.55)
      bloom.addColorStop(0, `rgba(191, 219, 254, ${0.35 + energy * 0.25})`)
      bloom.addColorStop(0.55, `rgba(191, 219, 254, ${0.12 + energy * 0.1})`)
      bloom.addColorStop(1, 'rgba(191, 219, 254, 0)')
      ctx.fillStyle = bloom
      ctx.beginPath()
      ctx.arc(cx, cy, R * 1.55, 0, Math.PI * 2)
      ctx.fill()

      // Main soft sphere — white core → soft blue edge (exact Live look)
      const body = ctx.createRadialGradient(
        cx - R * 0.2,
        cy - R * 0.25,
        R * 0.05,
        cx + R * 0.05,
        cy + R * 0.1,
        R
      )
      body.addColorStop(0, 'rgba(255, 255, 255, 1)')
      body.addColorStop(0.28, 'rgba(239, 246, 255, 0.98)')
      body.addColorStop(0.55, `rgba(191, 219, 254, ${0.95})`)
      body.addColorStop(0.82, `rgba(147, 197, 253, ${0.9 + energy * 0.05})`)
      body.addColorStop(1, `rgba(96, 165, 250, ${0.55 + energy * 0.15})`)
      ctx.fillStyle = body
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, Math.PI * 2)
      ctx.fill()

      // Inner soft caustic (very subtle motion)
      ctx.save()
      ctx.beginPath()
      ctx.arc(cx, cy, R * 0.95, 0, Math.PI * 2)
      ctx.clip()
      const ox = Math.cos(t * 0.7) * R * 0.12
      const oy = Math.sin(t * 0.9) * R * 0.1
      const inner = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, R * 0.7)
      inner.addColorStop(0, `rgba(255,255,255,${0.55 + energy * 0.15})`)
      inner.addColorStop(0.4, 'rgba(219, 234, 254, 0.25)')
      inner.addColorStop(1, 'rgba(147, 197, 253, 0)')
      ctx.fillStyle = inner
      ctx.beginPath()
      ctx.arc(cx + ox, cy + oy, R * 0.7, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      // Tiny specular
      ctx.fillStyle = 'rgba(255,255,255,0.65)'
      ctx.beginPath()
      ctx.ellipse(cx - R * 0.22, cy - R * 0.28, R * 0.18, R * 0.11, -0.5, 0, Math.PI * 2)
      ctx.fill()

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size])

  return jsx('canvas', {
    ref,
    'aria-hidden': true,
    className: 'vh-orb-shell block mx-auto'
  })
}

function phaseLabel(p) {
  if (p === 'listening' || p === 'recording') return 'Listening'
  if (p === 'transcribing') return 'Got it'
  if (p === 'thinking') return 'Thinking'
  if (p === 'speaking') return 'Speaking'
  return 'Live'
}

function LiveStrip() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  const ghostText = useValue($ghostText)
  const ghostRole = useValue($ghostRole)
  const ghostOpacity = useValue($ghostOpacity)
  const error = useValue($error)
  const busOk = useValue($busOk)

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
  const thinking = phase === 'thinking' || phase === 'transcribing'
  // ChatGPT Live center orb scale
  const orbSize = speaking ? 168 : listening ? 156 : 148
  const showGhost = Boolean(ghostText) && ghostOpacity > 0.02
  const dotOn = speaking ? 'speak' : thinking ? 'think' : 'listen'

  return jsxs('div', {
    className: 'vh-session',
    role: 'status',
    'aria-live': 'polite',
    'data-voice-hud': '1',
    'data-vh-phase': phase,
    children: [
      jsxs('div', {
        className: 'vh-stage',
        children: [
          jsxs('div', {
            className: 'vh-topbar',
            children: [
              jsxs('div', {
                className: 'vh-live-pill',
                children: [
                  jsx('span', {
                    className: 'vh-live-dot',
                    'data-on': dotOn
                  }),
                  jsx('span', { children: 'Live' }),
                  jsx('span', {
                    className: 'text-[0.72rem] font-normal text-slate-500',
                    children: phaseLabel(phase)
                  })
                ]
              }),
              jsx(Button, {
                type: 'button',
                size: 'sm',
                variant: 'ghost',
                className:
                  'h-8 rounded-full px-3.5 text-[0.8rem] font-medium text-slate-700 hover:bg-slate-900/5',
                'aria-label': 'Stop voice HUD',
                'data-voice-hud-end': '1',
                onClick: e => {
                  e.preventDefault()
                  e.stopPropagation()
                  endVoice()
                },
                children: 'End'
              })
            ]
          }),

          jsx('div', {
            className: 'flex flex-1 items-center justify-center',
            children: jsx(VoiceOrb, { size: orbSize })
          }),

          jsx('div', {
            className: 'vh-ghost flex min-h-[3.25rem] w-full max-w-md flex-col items-center px-6',
            style: {
              opacity: showGhost ? ghostOpacity : 0,
              transform: showGhost ? `translateY(${(1 - ghostOpacity) * 8}px)` : 'translateY(6px)'
            },
            'aria-hidden': !showGhost,
            children: showGhost
              ? jsxs('div', {
                  className: 'text-center',
                  children: [
                    jsx('div', {
                      className:
                        'mb-1 text-[0.65rem] font-medium uppercase tracking-[0.16em] text-slate-400',
                      children: ghostRole === 'agent' ? 'ILO' : 'YOU'
                    }),
                    jsx('div', {
                      className: 'line-clamp-3 text-[1.05rem] leading-snug text-slate-700',
                      children: ghostText
                    })
                  ]
                })
              : jsx('div', {
                  className: 'text-[0.85rem] text-slate-400',
                  children: !busOk ? 'Starting Live…' : listening ? '' : phaseLabel(phase)
                })
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
    label: active
      ? 'ChatGPT Live–style voice — End stops session'
      : 'Voice HUD: ChatGPT Live stage. Settings → Plugins.',
    children: jsx('button', {
      type: 'button',
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      onClick: () => {
        haptic('tap')
        toggleVoice()
      },
      children: jsx(Badge, {
        variant: active ? 'default' : 'muted',
        children: active ? `live ${phase}` : 'live'
      })
    })
  })
}

export default {
  id: PLUGIN_ID,
  name: 'Voice HUD',
  defaultEnabled: false,
  register(ctx) {
    ensureCss()
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
          label: 'Voice HUD: Toggle Live voice',
          keywords: ['voice', 'hud', 'orb', 'chatgpt', 'grok'],
          run: () => toggleVoice()
        }
      },
      {
        id: 'end',
        area: PALETTE_AREA,
        data: {
          id: 'voice-hud.end',
          label: 'Voice HUD: Stop',
          keywords: ['voice', 'end', 'stop'],
          run: () => endVoice()
        }
      },
      {
        id: 'bind',
        area: KEYBINDS_AREA,
        data: {
          id: 'voice-hud.toggle',
          label: 'Voice HUD: Toggle Live voice',
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

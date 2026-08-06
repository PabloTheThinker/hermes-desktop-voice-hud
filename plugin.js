/**
 * voice-hud — Grok/ChatGPT-style orb-first skin over Desktop native voice.
 *
 * Research (2026): ChatGPT Advanced Voice used a full-screen reactive orb
 * (listen/think/speak). Later ChatGPT folded voice into chat with transcripts;
 * classic orb UX still prioritizes motion over persistent text. Grok voice
 * uses colored orbs / speech-forward visuals. AI UX pattern: voice visualizer
 * = phase-reactive motion; words are ephemeral.
 *
 * This skin:
 *  • Large center orb is the “speaker” — energy follows bus level + phase
 *  • Captions appear briefly then fade (words disappear)
 *  • No chat-history replay; native hermes:voice-bus only (no second mic)
 *  • Stop never self-clicks core End
 *
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
/* Hide stock voice strip while orb session owns the surface */
[data-voice-hud-live="1"] [data-slot="composer-fade"] > [aria-live="polite"][role="status"].h-8:not([data-voice-hud]) {
  display: none !important;
}
/* Soften message list so the session feels like Advanced Voice, not a log */
[data-voice-hud-live="1"] [data-slot="messages"],
[data-voice-hud-live="1"] [data-slot="thread"],
[data-voice-hud-live="1"] main [data-session-scroll],
html[data-voice-hud-live="1"] [data-slot="chat-scroll"] {
  opacity: 0.22 !important;
  filter: blur(0.5px);
  pointer-events: none !important;
  transition: opacity 0.4s ease, filter 0.4s ease;
}
[data-voice-hud="1"].vh-session {
  position: fixed !important;
  inset: 0 !important;
  z-index: 80 !important;
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  margin: 0 !important;
  padding: 1.5rem 1rem 5.5rem !important;
  border: none !important;
  border-radius: 0 !important;
  /* ChatGPT/Grok: deep void + single soft light behind orb */
  background:
    radial-gradient(ellipse 55% 48% at 50% 46%, rgba(56, 120, 220, 0.16), transparent 68%),
    radial-gradient(ellipse 80% 70% at 50% 100%, rgba(0,0,0,0.65), transparent 50%),
    rgba(4, 6, 12, 0.88) !important;
  backdrop-filter: blur(22px) saturate(1.05) !important;
  -webkit-backdrop-filter: blur(22px) saturate(1.05) !important;
  box-shadow: none !important;
}
[data-voice-hud="1"] .vh-ghost {
  transition: opacity 0.35s ease, transform 0.45s ease;
  will-change: opacity, transform;
}
[data-voice-hud="1"] .vh-orb-shell {
  filter: drop-shadow(0 0 40px rgba(80, 140, 255, 0.25));
}
[data-voice-hud="1"][data-vh-phase="speaking"] .vh-orb-shell {
  filter: drop-shadow(0 0 56px rgba(100, 150, 255, 0.45));
}
[data-voice-hud="1"][data-vh-phase="listening"] .vh-orb-shell {
  filter: drop-shadow(0 0 48px rgba(60, 220, 180, 0.32));
}
[data-voice-hud="1"][data-vh-phase="thinking"] .vh-orb-shell {
  filter: drop-shadow(0 0 44px rgba(240, 180, 70, 0.28));
}
/* Keep composer dock usable above the overlay for Stop/core End */
[data-voice-hud-live="1"] [data-slot="composer-root"],
[data-voice-hud-live="1"] [data-slot="composer-dock"] {
  position: relative;
  z-index: 90 !important;
}
`
}

function setLiveAttr(on) {
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

function VoiceOrb({ size = 160 }) {
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
    const pad = Math.round(size * 0.22)
    const W = size + pad * 2
    c.width = Math.round(W * dpr)
    c.height = Math.round(W * dpr)
    c.style.width = W + 'px'
    c.style.height = W + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    /**
     * Grok / ChatGPT-style soft voice orb:
     * one luminous sphere + soft halo, phase color, mic-driven breathe.
     * No fiber/torus clutter.
     */
    const draw = now => {
      const t = (now - t0) / 1000
      const cx = W / 2
      const cy = W / 2
      const ph = pr.current
      const lv = Math.max(0, Math.min(1, lr.current))

      // Soft palette (Grok-colored orb / ChatGPT liquid sphere)
      let c0 = [120, 200, 255] // core
      let c1 = [56, 120, 220] // mid
      let c2 = [20, 40, 90] // rim
      let pulse = 0.035
      let energy = 0.22
      if (ph === 'listening' || ph === 'recording') {
        c0 = [160, 255, 220]
        c1 = [40, 200, 160]
        c2 = [10, 60, 55]
        pulse = 0.05
        energy = 0.38 + lv * 0.45
      } else if (ph === 'transcribing' || ph === 'thinking') {
        c0 = [255, 230, 170]
        c1 = [220, 160, 60]
        c2 = [70, 45, 15]
        pulse = 0.06
        energy = 0.3
      } else if (ph === 'speaking') {
        c0 = [200, 220, 255]
        c1 = [90, 140, 255]
        c2 = [30, 40, 120]
        pulse = 0.07
        energy = 0.5 + lv * 0.4
      }

      const breathe = 1 + Math.sin(t * (ph === 'thinking' ? 3.2 : 2.1)) * pulse * (1 + energy)
      const R = (size * 0.34) * breathe * (1 + energy * 0.08)

      ctx.clearRect(0, 0, W, W)

      // Far halo (atmosphere)
      const halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 2.1)
      halo.addColorStop(0, `rgba(${c1[0]},${c1[1]},${c1[2]},${0.22 + energy * 0.2})`)
      halo.addColorStop(0.45, `rgba(${c1[0]},${c1[1]},${c1[2]},${0.08 + energy * 0.08})`)
      halo.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = halo
      ctx.beginPath()
      ctx.arc(cx, cy, R * 2.1, 0, Math.PI * 2)
      ctx.fill()

      // Soft ring pulse (speaking/listening)
      if (ph === 'speaking' || ph === 'listening' || ph === 'recording') {
        const ring = 0.55 + 0.45 * Math.sin(t * 2.4 + energy)
        ctx.beginPath()
        ctx.arc(cx, cy, R * (1.35 + ring * 0.12 * energy), 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${c0[0]},${c0[1]},${c0[2]},${0.12 + energy * 0.18})`
        ctx.lineWidth = 2 + energy * 2
        ctx.stroke()
      }

      // Main sphere body
      const body = ctx.createRadialGradient(
        cx - R * 0.28,
        cy - R * 0.32,
        R * 0.05,
        cx,
        cy + R * 0.1,
        R
      )
      body.addColorStop(0, `rgba(${c0[0]},${c0[1]},${c0[2]},0.98)`)
      body.addColorStop(0.35, `rgba(${c1[0]},${c1[1]},${c1[2]},0.92)`)
      body.addColorStop(0.78, `rgba(${c2[0]},${c2[1]},${c2[2]},0.88)`)
      body.addColorStop(1, `rgba(${c2[0]},${c2[1]},${c2[2]},0.2)`)
      ctx.fillStyle = body
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, Math.PI * 2)
      ctx.fill()

      // Inner liquid shimmer (very subtle — not fibers)
      ctx.save()
      ctx.beginPath()
      ctx.arc(cx, cy, R * 0.92, 0, Math.PI * 2)
      ctx.clip()
      for (let i = 0; i < 5; i++) {
        const a = t * (0.6 + i * 0.15) + i
        const ox = Math.cos(a) * R * 0.25
        const oy = Math.sin(a * 1.3) * R * 0.2
        const g = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, R * 0.55)
        g.addColorStop(0, `rgba(255,255,255,${0.07 + energy * 0.06})`)
        g.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(cx + ox, cy + oy, R * 0.55, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()

      // Specular highlight
      const hi = ctx.createRadialGradient(
        cx - R * 0.3,
        cy - R * 0.35,
        0,
        cx - R * 0.3,
        cy - R * 0.35,
        R * 0.45
      )
      hi.addColorStop(0, 'rgba(255,255,255,0.55)')
      hi.addColorStop(0.35, 'rgba(255,255,255,0.12)')
      hi.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = hi
      ctx.beginPath()
      ctx.ellipse(cx - R * 0.22, cy - R * 0.28, R * 0.32, R * 0.2, -0.5, 0, Math.PI * 2)
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
  return 'Voice'
}

function LiveStrip() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  const ghostText = useValue($ghostText)
  const ghostRole = useValue($ghostRole)
  const ghostOpacity = useValue($ghostOpacity)
  const elapsed = useValue($elapsed)
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
  // Large soft orb — Grok/ChatGPT scale, full conversation cover
  const orbSize = speaking ? 200 : listening ? 184 : 168
  const showGhost = Boolean(ghostText) && ghostOpacity > 0.02

  return jsxs('div', {
    className: 'vh-session flex flex-col items-center justify-center gap-6 text-white/80',
    role: 'status',
    'aria-live': 'polite',
    'data-voice-hud': '1',
    'data-vh-phase': phase,
    children: [
      // Minimal floating controls (ChatGPT Voice: mute/end style bar)
      jsxs('div', {
        className:
          'absolute top-5 left-1/2 z-[2] flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/10 bg-black/40 px-4 py-2 backdrop-blur-xl',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-2 text-[0.72rem] text-white/65',
            children: [
              jsx('span', {
                className: cn(
                  'size-1.5 rounded-full',
                  listening
                    ? 'animate-pulse bg-emerald-400'
                    : speaking
                      ? 'animate-pulse bg-sky-400'
                      : 'bg-amber-300/90'
                )
              }),
              jsx('span', {
                className: 'font-medium tracking-wide text-white/85',
                children: phaseLabel(phase)
              }),
              jsx('span', {
                className: 'font-mono tabular-nums text-white/40',
                children: formatElapsed(elapsed / 1000)
              })
            ]
          }),
          jsx('span', { className: 'h-3 w-px bg-white/15', 'aria-hidden': true }),
          jsx(Button, {
            type: 'button',
            size: 'sm',
            variant: 'ghost',
            className:
              'h-7 rounded-full px-3.5 text-[0.72rem] text-white/90 hover:bg-white/10 hover:text-white',
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

      // Soft orb center stage
      jsx('div', {
        className: cn(
          'flex flex-1 items-center justify-center pt-10 transition-transform duration-500 ease-out',
          speaking ? 'scale-[1.04]' : 'scale-100'
        ),
        children: jsx(VoiceOrb, { size: orbSize })
      }),

      // Ephemeral caption — words appear then dissolve (not a transcript panel)
      jsx('div', {
        className: 'vh-ghost flex min-h-[4rem] w-full max-w-lg flex-col items-center px-6 pb-8',
        style: {
          opacity: showGhost ? ghostOpacity : 0,
          transform: showGhost ? `translateY(${(1 - ghostOpacity) * 10}px)` : 'translateY(8px)'
        },
        'aria-hidden': !showGhost,
        children: showGhost
          ? jsxs('div', {
              className: 'text-center',
              children: [
                jsx('div', {
                  className: 'mb-1.5 text-[0.6rem] font-medium uppercase tracking-[0.2em] text-white/35',
                  children: ghostRole === 'agent' ? 'ILO' : 'YOU'
                }),
                jsx('div', {
                  className: cn(
                    'line-clamp-3 text-[1.1rem] font-normal leading-relaxed tracking-tight',
                    ghostRole === 'agent' ? 'text-sky-50/90' : 'text-white/88'
                  ),
                  children: ghostText
                })
              ]
            })
          : jsx('div', {
              className: 'text-center text-[0.8rem] tracking-wide text-white/30',
              children: !busOk
                ? 'Connecting voice…'
                : speaking
                  ? ''
                  : listening
                    ? 'Listening'
                    : phaseLabel(phase)
            })
      })
    ]
  })
}

function StatusChip() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  return jsx(Tip, {
    label: active
      ? 'Orb voice skin — Stop ends session'
      : 'Voice HUD: ChatGPT/Grok-style orb. Settings → Plugins.',
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
        children: active ? `orb ${phase}` : 'orb'
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
          label: 'Voice HUD: Toggle orb voice',
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
          label: 'Voice HUD: Toggle orb voice',
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

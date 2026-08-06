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
  opacity: 0.14 !important;
  filter: blur(1px);
  pointer-events: none !important;
  transition: opacity 0.35s ease, filter 0.35s ease;
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
  padding: 2rem 1.25rem 6.5rem !important;
  border: none !important;
  border-radius: 0 !important;
  background:
    radial-gradient(ellipse 70% 55% at 50% 42%, rgba(14, 165, 233, 0.14), transparent 70%),
    radial-gradient(ellipse 90% 80% at 50% 100%, rgba(0,0,0,0.55), transparent 55%),
    rgba(6, 10, 18, 0.78) !important;
  backdrop-filter: blur(18px) saturate(1.15) !important;
  -webkit-backdrop-filter: blur(18px) saturate(1.15) !important;
  box-shadow: none !important;
}
[data-voice-hud="1"] .vh-ghost {
  transition: opacity 0.35s ease, transform 0.45s ease;
  will-change: opacity, transform;
}
[data-voice-hud="1"] .vh-orb-shell {
  filter: drop-shadow(0 0 28px rgba(56, 189, 248, 0.28));
}
[data-voice-hud="1"][data-vh-phase="speaking"] .vh-orb-shell {
  filter: drop-shadow(0 0 42px rgba(96, 165, 250, 0.55));
}
[data-voice-hud="1"][data-vh-phase="listening"] .vh-orb-shell {
  filter: drop-shadow(0 0 32px rgba(52, 211, 153, 0.35));
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

function VoiceOrb({ size = 88 }) {
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
    c.width = Math.round(size * dpr)
    c.height = Math.round(size * dpr)
    c.style.width = size + 'px'
    c.style.height = size + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const FIBERS = 42

    const draw = now => {
      const t = (now - t0) / 1000
      const cx = size / 2
      const cy = size / 2
      const ph = pr.current
      const lv = lr.current

      // Phase personality (ChatGPT/Grok-like state motion)
      let base = 0.22
      let speed = 0.55
      let hueA = 200
      let hueB = 260
      if (ph === 'listening' || ph === 'recording') {
        // Always-alive listen motion so turn-2 feedback is obvious even
        // before bus levels arrive.
        base = 0.48
        speed = 1.05
        hueA = 160
        hueB = 200
      } else if (ph === 'transcribing' || ph === 'thinking') {
        base = 0.32
        speed = 1.45
        hueA = 45
        hueB = 200
      } else if (ph === 'speaking') {
        base = 0.58
        speed = 1.2
        hueA = 210
        hueB = 280
      }
      const amp = base + Math.max(lv, ph === 'listening' || ph === 'recording' ? 0.18 : 0) * 0.62
      const breathe = 1 + Math.sin(t * speed * 2.2) * 0.04 * (ph === 'speaking' ? 1.4 : 1)

      ctx.clearRect(0, 0, size, size)

      // Soft outer glow
      const glowR = size * 0.48 * breathe
      const glow = ctx.createRadialGradient(cx, cy, size * 0.08, cx, cy, glowR)
      glow.addColorStop(0, `hsla(${hueA},95%,62%,${0.55 + amp * 0.35})`)
      glow.addColorStop(0.45, `hsla(${(hueA + hueB) / 2},90%,50%,${0.22 + amp * 0.2})`)
      glow.addColorStop(1, `hsla(${hueB},80%,40%,0)`)
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(cx, cy, glowR, 0, Math.PI * 2)
      ctx.fill()

      // Core sphere
      const coreR = size * (0.22 + amp * 0.06) * breathe
      const core = ctx.createRadialGradient(cx - coreR * 0.25, cy - coreR * 0.3, 1, cx, cy, coreR)
      core.addColorStop(0, `hsla(${hueA},100%,88%,${0.95})`)
      core.addColorStop(0.45, `hsla(${hueA},90%,58%,${0.75})`)
      core.addColorStop(1, `hsla(${hueB},85%,35%,${0.35})`)
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
      ctx.fill()

      // Torus fibers (Iron Man / advanced voice texture)
      for (let i = 0; i < FIBERS; i++) {
        const hue = hueA + (i / FIBERS) * (hueB - hueA) + t * 40
        const a0 = (i / FIBERS) * Math.PI * 2 + t * speed * 0.7
        ctx.beginPath()
        for (let s = 0; s <= 14; s++) {
          const u = s / 14
          const r =
            size * (0.14 + u * 0.28) * breathe +
            Math.sin(t * 3.2 * speed + i * 0.4 + u * 6) * size * 0.04 * amp
          const a = a0 + u * 1.7 + Math.sin(t + i) * 0.08 * amp
          const x = cx + Math.cos(a) * r
          const y = cy + Math.sin(a) * r * (0.92 + amp * 0.08)
          if (s === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = `hsla(${hue % 360},92%,62%,${0.14 + amp * 0.42})`
        ctx.lineWidth = 0.85 + amp * 0.5
        ctx.stroke()
      }

      // Specular highlight
      ctx.fillStyle = `hsla(0,0%,100%,${0.18 + amp * 0.12})`
      ctx.beginPath()
      ctx.ellipse(cx - coreR * 0.28, cy - coreR * 0.32, coreR * 0.22, coreR * 0.14, -0.5, 0, Math.PI * 2)
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
  // Full-session orb — larger when AI speaks (ChatGPT/Grok pattern)
  const orbSize = speaking ? 168 : listening ? 148 : 128

  const showGhost = Boolean(ghostText) && ghostOpacity > 0.02

  return jsxs('div', {
    className: cn(
      'vh-session flex flex-col items-center gap-4',
      'text-muted-foreground'
    ),
    role: 'status',
    'aria-live': 'polite',
    'data-voice-hud': '1',
    'data-vh-phase': phase,
    children: [
      // Top chrome: minimal floating bar
      jsxs('div', {
        className:
          'absolute top-4 left-1/2 z-[1] flex w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 items-center justify-between gap-2 rounded-full border border-white/10 bg-black/35 px-3 py-1.5 backdrop-blur-md',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-1.5 text-[0.7rem] text-white/70',
            children: [
              jsx('span', {
                className: cn(
                  'size-1.5 rounded-full',
                  listening
                    ? 'animate-pulse bg-emerald-400'
                    : speaking
                      ? 'animate-pulse bg-sky-400'
                      : 'bg-amber-400/90'
                )
              }),
              jsx('span', {
                className: 'font-medium tracking-wide text-white/85',
                children: phaseLabel(phase)
              }),
              jsx('span', {
                className: 'font-mono tabular-nums opacity-60',
                children: formatElapsed(elapsed / 1000)
              }),
              jsx('span', {
                className: 'hidden text-[0.62rem] text-white/40 sm:inline',
                children: busOk ? 'session' : 'arming…'
              })
            ]
          }),
          jsx(Button, {
            type: 'button',
            size: 'sm',
            variant: 'ghost',
            className: 'h-7 shrink-0 rounded-full px-3 text-[0.72rem] text-white/85 hover:bg-white/10',
            'aria-label': 'Stop voice HUD',
            'data-voice-hud-end': '1',
            onClick: e => {
              e.preventDefault()
              e.stopPropagation()
              endVoice()
            },
            children: 'Stop'
          })
        ]
      }),

      // THE ORB — fills the session stage
      jsx('div', {
        className: cn(
          'flex flex-1 items-center justify-center transition-transform duration-500',
          speaking ? 'scale-105' : 'scale-100'
        ),
        children: jsx(VoiceOrb, { size: orbSize })
      }),

      // Ephemeral words — appear then disappear
      jsx('div', {
        className:
          'vh-ghost flex min-h-[3.5rem] w-full max-w-xl flex-col items-center justify-center px-4 pb-2',
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
                    'mb-1 text-[0.58rem] font-medium uppercase tracking-[0.18em] text-white/40',
                  children: ghostRole === 'agent' ? 'ILO' : 'YOU'
                }),
                jsx('div', {
                  className: cn(
                    'line-clamp-3 text-[1.05rem] leading-snug',
                    ghostRole === 'agent' ? 'text-sky-100/90' : 'text-white/90'
                  ),
                  children: ghostText
                })
              ]
            })
          : jsx('div', {
              className: 'text-center text-[0.78rem] text-white/35',
              children: !busOk
                ? 'Full session · waiting for Desktop voice bus'
                : speaking
                  ? ''
                  : listening
                    ? 'Speak anytime — continuous session'
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

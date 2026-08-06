/**
 * voice-hud — ChatGPT Live–style voice **inside the chat session**.
 *
 * - Soft orb + ripples (not fiber clutter)
 * - Dark glass card in composer.top — does NOT cover whole Desktop
 * - YOU / ILO words stay readable (long hold)
 * - Native hermes:voice-bus only (Desktop Whisper). No second mic.
 *
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
const WORD_HOLD_MS = 5000
const WORD_FADE_MS = 1400
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
  // sticky partials: long hold; committed: still long enough to read
  const hold = extendOnly ? WORD_HOLD_MS + 1500 : WORD_HOLD_MS
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
  const el = document.getElementById(LEGACY_PORTAL_ID)
  if (el) el.remove()
}

function setLiveAttr(on) {
  if (typeof document === 'undefined') return
  // Session-local only — never mark whole Desktop / documentElement
  document.querySelectorAll('[data-slot="composer-root"], [data-slot="composer-dock"]').forEach(n => {
    if (on) n.setAttribute('data-voice-hud-live', '1')
    else n.removeAttribute('data-voice-hud-live')
  })
  document.documentElement.removeAttribute('data-voice-hud-live')
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
    // Always surface YOU words when bus has a caption
    showGhostWords(cap, 'you', { sticky: Boolean(d.partial) || phase === 'listening' || phase === 'recording' })
  }

  if (active && !$nativeActive.get()) {
    $nativeActive.set(true)
    $error.set('')
    startElapsed()
    setLiveAttr(true)
  }

  if (!active && $nativeActive.get() && !findCoreEndButton()) {
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

    if (phase === 'thinking' && prev === 'transcribing') {
      if ($caption.get()) showGhostWords($caption.get(), 'you', { sticky: false })
    }
    // Do not wipe words the instant listening restarts — let hold/fade handle it
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
/* Hide stock voice strip while in-chat Live is up */
[data-voice-hud-live="1"] [data-slot="composer-fade"] > [aria-live="polite"][role="status"].h-8:not([data-voice-hud]) {
  display: none !important;
}
/* Keep chat readable — no full-desktop dim */
[data-voice-hud-live="1"] [data-slot="messages"],
[data-voice-hud-live="1"] [data-slot="thread"],
[data-voice-hud-live="1"] [data-slot="chat-scroll"] {
  opacity: 1 !important;
  filter: none !important;
  pointer-events: auto !important;
}
/* In-chat Live card (composer.top) */
[data-voice-hud="1"].vh-inchat {
  position: relative;
  z-index: 5;
  width: 100%;
  margin: 0 0 0.45rem 0;
  padding: 0.75rem 0.9rem 0.9rem;
  border-radius: 1rem;
  border: 1px solid rgba(148, 163, 184, 0.14);
  background:
    radial-gradient(ellipse 80% 90% at 50% 35%, rgba(56, 120, 220, 0.14), transparent 62%),
    rgba(10, 14, 22, 0.94);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), 0 6px 22px rgba(0,0,0,0.22);
  color: #e2e8f0;
  overflow: hidden;
}
[data-voice-hud="1"].vh-inchat .vh-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.15rem;
}
[data-voice-hud="1"].vh-inchat .vh-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  font-weight: 600;
  color: #f1f5f9;
}
[data-voice-hud="1"].vh-inchat .vh-dot {
  width: 0.42rem;
  height: 0.42rem;
  border-radius: 999px;
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.16);
}
[data-voice-hud="1"].vh-inchat .vh-dot[data-on="speak"] {
  background: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.18);
}
[data-voice-hud="1"].vh-inchat .vh-dot[data-on="think"] {
  background: #f59e0b;
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.16);
}
[data-voice-hud="1"].vh-inchat .vh-words {
  min-height: 2.6rem;
  text-align: center;
  transition: opacity 0.35s ease;
}
/* Kill legacy full-desktop portal if hot-reload left one */
#${LEGACY_PORTAL_ID} { display: none !important; visibility: hidden !important; pointer-events: none !important; }
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
      if (findCoreEndButton() || $nativeActive.get()) {
        $phase.set('listening')
      }
    }
  })
}

// --- Soft Live orb (in-chat scale) -------------------------------------------

function VoiceOrb({ size = 96 }) {
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
    const pad = Math.round(size * 0.5)
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

      let energy = 0.22
      let speed = 1.0
      if (ph === 'listening' || ph === 'recording') {
        energy = 0.38 + lv * 0.5
        speed = 1.12
      } else if (ph === 'transcribing' || ph === 'thinking') {
        energy = 0.3
        speed = 1.45
      } else if (ph === 'speaking') {
        energy = 0.52 + lv * 0.38
        speed = 1.22
      }

      const breathe = 1 + Math.sin(t * 2.0 * speed) * (0.03 + energy * 0.025)
      const R = size * 0.5 * breathe
      ctx.clearRect(0, 0, W, W)

      for (let i = 0; i < 4; i++) {
        const phaseOff = (t * speed * 0.35 + i / 4) % 1
        const rr = R * (1.12 + phaseOff * (1.55 + energy * 0.45))
        const alpha = (1 - phaseOff) * (0.1 + energy * 0.14)
        ctx.beginPath()
        ctx.arc(cx, cy, rr, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(125, 180, 255, ${alpha})`
        ctx.lineWidth = 1.2 + (1 - phaseOff) * 1.2
        ctx.stroke()
      }

      const bloom = ctx.createRadialGradient(cx, cy, R * 0.25, cx, cy, R * 1.45)
      bloom.addColorStop(0, `rgba(120, 170, 255, ${0.28 + energy * 0.2})`)
      bloom.addColorStop(0.55, `rgba(80, 130, 220, ${0.1 + energy * 0.08})`)
      bloom.addColorStop(1, 'rgba(40, 80, 160, 0)')
      ctx.fillStyle = bloom
      ctx.beginPath()
      ctx.arc(cx, cy, R * 1.45, 0, Math.PI * 2)
      ctx.fill()

      const body = ctx.createRadialGradient(
        cx - R * 0.22,
        cy - R * 0.28,
        R * 0.05,
        cx,
        cy + R * 0.08,
        R
      )
      body.addColorStop(0, 'rgba(240, 248, 255, 0.98)')
      body.addColorStop(0.35, 'rgba(180, 210, 255, 0.92)')
      body.addColorStop(0.72, `rgba(90, 140, 230, ${0.88 + energy * 0.05})`)
      body.addColorStop(1, `rgba(40, 80, 160, ${0.55 + energy * 0.12})`)
      ctx.fillStyle = body
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      ctx.beginPath()
      ctx.ellipse(cx - R * 0.22, cy - R * 0.28, R * 0.16, R * 0.1, -0.5, 0, Math.PI * 2)
      ctx.fill()

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size])

  return jsx('canvas', {
    ref,
    'aria-hidden': true,
    className: 'block mx-auto',
    style: { filter: 'drop-shadow(0 6px 20px rgba(80,140,255,0.28))' }
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
  const thinking = phase === 'thinking' || phase === 'transcribing'
  const orbSize = speaking ? 104 : listening ? 96 : 90

  const showText = ghostText && ghostOpacity > 0.02 ? ghostText : (caption || '').trim()
  const showRole = ghostText && ghostOpacity > 0.02 ? ghostRole : showText ? 'you' : ''
  const showOp = ghostText && ghostOpacity > 0.02 ? ghostOpacity : showText ? 1 : 0
  const dotOn = speaking ? 'speak' : thinking ? 'think' : 'listen'

  return jsxs('div', {
    className: 'vh-inchat',
    role: 'status',
    'aria-live': 'polite',
    'data-voice-hud': '1',
    'data-vh-phase': phase,
    children: [
      jsxs('div', {
        className: 'vh-top',
        children: [
          jsxs('div', {
            className: 'vh-pill',
            children: [
              jsx('span', { className: 'vh-dot', 'data-on': dotOn }),
              jsx('span', { children: 'Live' }),
              jsx('span', {
                className: 'text-[0.72rem] font-normal text-slate-400',
                children: phaseLabel(phase)
              }),
              jsx('span', {
                className: 'font-mono text-[0.68rem] tabular-nums text-slate-500',
                children: formatElapsed(elapsed / 1000)
              })
            ]
          }),
          jsx(Button, {
            type: 'button',
            size: 'sm',
            variant: 'ghost',
            className:
              'h-7 shrink-0 rounded-full border border-white/10 px-3 text-[0.75rem] text-slate-200 hover:bg-white/10',
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
        className: 'flex justify-center py-0.5',
        children: jsx(VoiceOrb, { size: orbSize })
      }),
      jsx('div', {
        className: 'vh-words',
        style: { opacity: showText && showOp > 0.02 ? showOp : listening ? 0.92 : 0.7 },
        children:
          showText && showOp > 0.02
            ? jsxs('div', {
                children: [
                  jsx('div', {
                    className: cn(
                      'mb-1 text-[0.68rem] font-bold uppercase tracking-[0.16em]',
                      showRole === 'agent' ? 'text-sky-300' : 'text-emerald-300'
                    ),
                    children: showRole === 'agent' ? 'ILO' : 'YOU'
                  }),
                  jsx('div', {
                    className: cn(
                      'line-clamp-3 text-[1.08rem] font-medium leading-snug',
                      showRole === 'agent' ? 'text-sky-50' : 'text-slate-50'
                    ),
                    children: showText
                  })
                ]
              })
            : jsx('div', {
                className: 'text-[0.92rem] font-medium text-slate-400',
                children: !busOk
                  ? 'Starting Live…'
                  : listening
                    ? 'Listening — speak anytime'
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
    content: active ? 'Live voice (in chat) — click to End' : 'Start Live voice in this chat',
    children: jsx('button', {
      type: 'button',
      className: 'inline-flex',
      onClick: () => (active ? endVoice() : toggleVoice()),
      children: jsx(Badge, {
        variant: active ? 'default' : 'outline',
        className: 'cursor-pointer gap-1 font-normal',
        children: active ? `Live · ${phase}` : 'Live'
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
          keywords: ['voice', 'hud', 'live', 'orb'],
          run: () => toggleVoice()
        }
      },
      {
        id: 'end',
        area: PALETTE_AREA,
        data: {
          id: 'voice-hud.end',
          label: 'Voice HUD: End Live',
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

/**
 * voice-hud — live caption skin over Hermes Desktop native voice.
 *
 * Goals:
 *  • Real-time YOU caption while speaking (Web Speech interim)
 *  • Continuous native conversation (core owns VAD/STT/loop)
 *  • No chat-history replay in the dock
 *  • End/Stop never self-clicks into an open/close loop
 *
 * Mic contract:
 *  • Never getUserMedia / MediaRecorder (core exclusive for VAD)
 *  • Web Speech ONLY in phase === 'listening'
 *  • Delayed start (~350ms) so core opens the mic first
 *  • Hard-abort the instant phase leaves listening (before core STT/re-arm)
 *  • Generation token so aborted sessions cannot write captions
 *
 * End contract:
 *  • findCoreEndButton matches ONLY core "End voice conversation"
 *  • Never matches HUD Stop (data-voice-hud / data-voice-hud-end)
 *  • endVoice never dispatchVoiceToggle (toggle would START a new session)
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
const STYLE_ID = 'voice-hud-css'
const END_MISS_TOLERANCE = 5
const CORE_END_RE = /end voice conversation/i
/** Let core claim the mic before Web Speech attaches. */
const CAPTION_START_DELAY_MS = 350

/** @typedef {'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'} Phase */

const $nativeActive = atom(false)
const $phase = atom(/** @type {Phase} */ ('idle'))
const $level = atom(0)
/** Live interim words while you speak. */
const $liveCaption = atom('')
/** Fallback: last committed user bubble after Desktop STT (one line). */
const $lastSaid = atom('')
const $agentLine = atom('')
const $elapsed = atom(0)
const $error = atom('')
/** live | unavailable | off */
const $captionMode = atom(/** @type {'live' | 'unavailable' | 'off'} */ ('off'))

let pollTimer = 0
let endWatch = 0
let elapsedTimer = 0
let captionStartTimer = 0
let startedAt = 0
let endMisses = 0
let lastBubbleSeen = ''
let ending = false
let speechWanted = false
let speechGen = 0
/** @type {null | { abort: () => void, gen: number }} */
let speechHandle = null
let committedFinals = ''

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

/** ONLY core ConversationPill End — never HUD Stop. */
function findCoreEndButton() {
  if (typeof document === 'undefined') return null
  const roots = document.querySelectorAll(
    '[data-slot="composer-root"], [data-slot="composer-dock"], [data-slot="composer-fade"]'
  )
  const scopes = roots.length ? Array.from(roots) : [document]

  for (const root of scopes) {
    const buttons = root.querySelectorAll?.('button') || []
    for (const btn of buttons) {
      if (isHudNode(btn)) continue
      const label = (btn.getAttribute('aria-label') || '').trim()
      if (CORE_END_RE.test(label)) return btn
    }
  }

  // Fallback: primary pill with level bars + End text (outside HUD)
  for (const root of scopes) {
    const buttons = root.querySelectorAll?.('button') || []
    for (const btn of buttons) {
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
  const buttons = document.querySelectorAll(
    '[data-slot="composer-root"] button, [data-slot="composer-dock"] button'
  )
  for (const btn of buttons) {
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

function clearTimersSoft() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = 0
  }
  if (endWatch) {
    clearTimeout(endWatch)
    endWatch = 0
  }
  if (captionStartTimer) {
    clearTimeout(captionStartTimer)
    captionStartTimer = 0
  }
}

function stopLiveCaption(opts = {}) {
  const keepText = Boolean(opts.keepText)
  speechWanted = false
  speechGen += 1
  if (captionStartTimer) {
    clearTimeout(captionStartTimer)
    captionStartTimer = 0
  }
  const h = speechHandle
  speechHandle = null
  if (h) {
    try {
      h.abort()
    } catch {
      /* ignore */
    }
  }
  committedFinals = ''
  if (!keepText) {
    // leave $liveCaption for freeze-after-take when keepText true
  }
}

function resetSessionUi() {
  stopLiveCaption()
  $phase.set('idle')
  $level.set(0)
  $elapsed.set(0)
  $liveCaption.set('')
  $lastSaid.set('')
  $agentLine.set('')
  $captionMode.set('off')
  lastBubbleSeen = ''
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
  stopLiveCaption()
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
  $liveCaption.set('')
  $lastSaid.set('')
  $agentLine.set('')
  lastBubbleSeen = ''
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

// --- Live caption (Web Speech, listening-only) --------------------------------

function speechApiAvailable() {
  return Boolean(
    typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)
  )
}

function startLiveCaptionEngine() {
  if (speechHandle || typeof window === 'undefined') return
  if ($phase.get() !== 'listening' || !$nativeActive.get() || ending) return

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) {
    $captionMode.set('unavailable')
    return
  }

  const gen = speechGen
  speechWanted = true
  committedFinals = ''
  $captionMode.set('live')

  try {
    const rec = new SR()
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    try {
      rec.lang = navigator.language || 'en-US'
    } catch {
      /* ignore */
    }

    rec.onresult = event => {
      if (gen !== speechGen || !speechWanted) return
      if ($phase.get() !== 'listening') return
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        const t = (r[0]?.transcript || '').trim()
        if (!t) continue
        if (r.isFinal) committedFinals = (committedFinals + ' ' + t).trim()
        else interim = interim ? `${interim} ${t}` : t
      }
      const live = `${committedFinals}${interim ? (committedFinals ? ' ' : '') + interim : ''}`.trim()
      if (live) $liveCaption.set(live)
    }

    rec.onerror = e => {
      if (gen !== speechGen) return
      const code = e?.error || ''
      // no-speech / aborted are normal; not-allowed / service-not-allowed = unavailable
      if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'network') {
        $captionMode.set('unavailable')
        speechWanted = false
      }
    }

    rec.onend = () => {
      if (speechHandle && speechHandle.gen === gen) speechHandle = null
      // Soft restart ONLY while still listening (browsers stop continuous rec periodically)
      if (
        gen === speechGen &&
        speechWanted &&
        $phase.get() === 'listening' &&
        $nativeActive.get() &&
        !ending
      ) {
        window.setTimeout(() => {
          if (
            gen === speechGen &&
            speechWanted &&
            $phase.get() === 'listening' &&
            !speechHandle &&
            !ending
          ) {
            startLiveCaptionEngine()
          }
        }, 100)
      }
    }

    speechHandle = {
      gen,
      abort: () => {
        try {
          rec.onresult = null
          rec.onerror = null
          rec.onend = null
          rec.abort?.()
          rec.stop?.()
        } catch {
          /* ignore */
        }
      }
    }
    rec.start()
  } catch {
    speechHandle = null
    $captionMode.set('unavailable')
  }
}

/** Arm caption when entering listening; hard-stop when leaving. */
function syncCaptionToPhase(phase, prev) {
  if (captionStartTimer) {
    clearTimeout(captionStartTimer)
    captionStartTimer = 0
  }

  if (phase === 'listening') {
    // Fresh listen cycle
    if (prev && prev !== 'listening') {
      $liveCaption.set('')
      committedFinals = ''
    }
    if (!speechApiAvailable()) {
      $captionMode.set('unavailable')
      return
    }
    // Delay so core getUserMedia wins the device first
    if (!speechHandle) {
      speechWanted = true
      captionStartTimer = window.setTimeout(() => {
        captionStartTimer = 0
        if ($phase.get() === 'listening' && $nativeActive.get() && !ending) {
          startLiveCaptionEngine()
        }
      }, CAPTION_START_DELAY_MS)
    }
  } else {
    // Freeze last live words for "Got it" view; release mic path immediately
    const freeze = $liveCaption.get()
    stopLiveCaption({ keepText: true })
    if (freeze) $liveCaption.set(freeze)
  }
}

// --- Observe core ------------------------------------------------------------

function scrapeCoreLevel(endBtn) {
  if (!endBtn) return null
  const bars = endBtn.querySelectorAll('span.w-0\\.5, span[class*="w-0.5"]')
  if (!bars.length) return null
  const mid = bars[Math.floor(bars.length / 2)] || bars[0]
  const h = parseFloat(/** @type {HTMLElement} */ (mid).style?.height || '')
  if (!Number.isFinite(h) || h <= 0) return null
  return Math.max(0, Math.min(1, (h / 100 - 0.3) / 0.7))
}

function scrapePhaseFromDom(endBtn) {
  if (endBtn?.querySelector('svg.animate-spin, .animate-spin')) {
    return /** @type {Phase} */ ('speaking')
  }
  let hit = ''
  for (const el of document.querySelectorAll(
    '[data-slot="composer-root"] [role="status"], [data-slot="composer-dock"] [role="status"]'
  )) {
    if (isHudNode(el) || el.getAttribute('data-voice-hud') === '1') continue
    const t = (el.textContent || '').trim().toLowerCase()
    if (!t) continue
    if (t.includes('listen')) hit = 'listening'
    else if (t.includes('transcrib') || t.includes('dictat')) hit = 'transcribing'
    else if (t.includes('think')) hit = 'thinking'
    else if (t.includes('speak') || t.includes('reading') || t.includes('preparing')) hit = 'speaking'
    else if (t.includes('mut')) hit = 'listening'
    if (hit) break
  }
  if (!hit) {
    for (const el of document.querySelectorAll('[aria-live="polite"]')) {
      if (isHudNode(el) || el.getAttribute('data-voice-hud') === '1') continue
      const t = (el.textContent || '').toLowerCase()
      if (t.includes('dictat') || t.includes('recording')) {
        hit = 'listening'
        break
      }
      if (t.includes('transcrib')) {
        hit = 'transcribing'
        break
      }
      if (t.includes('speaking') || t.includes('preparing') || t.includes('reading')) {
        hit = 'speaking'
        break
      }
    }
  }
  if (!hit) hit = 'listening'
  return /** @type {Phase} */ (hit)
}

function detectNative() {
  if (typeof document === 'undefined') {
    return { active: false, phase: /** @type {Phase} */ ('idle'), level: 0 }
  }
  const endBtn = findCoreEndButton()
  let active = Boolean(endBtn)
  if (!active) {
    endMisses += 1
    if (endMisses < END_MISS_TOLERANCE && $nativeActive.get() && !ending) active = true
  } else endMisses = 0

  if (!active) return { active: false, phase: /** @type {Phase} */ ('idle'), level: 0 }

  const phase = scrapePhaseFromDom(endBtn)
  const coreLevel = scrapeCoreLevel(endBtn)
  const level =
    coreLevel != null
      ? coreLevel
      : phase === 'listening'
        ? 0.3
        : phase === 'speaking'
          ? 0.45
          : 0.15
  return { active: true, phase, level }
}

function scrapeLastUserBubble() {
  const nodes = document.querySelectorAll(
    '[data-role="user"], [data-message-role="user"], [data-slot*="user-message"]'
  )
  if (!nodes.length) return ''
  return (nodes[nodes.length - 1].textContent || '').trim().slice(0, 400)
}

function maybeUpdateLastSaid() {
  const bubble = scrapeLastUserBubble()
  if (!bubble || bubble === lastBubbleSeen) return
  lastBubbleSeen = bubble
  $lastSaid.set(bubble)
  // If live caption empty, fill from committed STT
  if (!$liveCaption.get()) $liveCaption.set(bubble)
}

function wireDomObserver() {
  if (pollTimer) return
  pollTimer = window.setInterval(() => {
    if (ending) return
    const { active, phase, level } = detectNative()
    const was = $nativeActive.get()
    $level.set(level)

    if (active && !was) {
      $nativeActive.set(true)
      $error.set('')
      $agentLine.set('')
      $liveCaption.set('')
      startElapsed()
      setLiveAttr(true)
      $phase.set(phase)
      syncCaptionToPhase(phase, 'idle')
    } else if (!active && was) {
      $nativeActive.set(false)
      resetSessionUi()
    } else {
      $nativeActive.set(active)
    }

    if (!active) return

    const prev = $phase.get()
    if (phase !== prev) {
      $phase.set(phase)
      syncCaptionToPhase(phase, prev)
      if (phase === 'listening' && prev !== 'idle') {
        $agentLine.set('')
      }
    } else if (phase === 'listening' && !speechHandle && speechWanted && !captionStartTimer) {
      // Ensure engine stays up across soft stops
      syncCaptionToPhase('listening', 'listening')
    }

    if (phase === 'transcribing' || phase === 'thinking' || phase === 'speaking') {
      maybeUpdateLastSaid()
    }

    setLiveAttr(true)
  }, 80)
}

function stopDomObserver() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = 0
  stopLiveCaption()
  clearTimersSoft()
  setLiveAttr(false)
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
[data-voice-hud-live="1"] [data-slot="composer-fade"] > [aria-live="polite"][role="status"].h-8:not([data-voice-hud]) {
  display: none !important;
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
      maybeUpdateLastSaid()
      $phase.set('thinking')
      stopLiveCaption({ keepText: true })
    } else if (type === 'message.delta') {
      const chunk = String(payload.text || payload.delta || '')
      if (!chunk) return
      $agentLine.set(($agentLine.get() + chunk).slice(-280))
      $phase.set('speaking')
      stopLiveCaption({ keepText: true })
    } else if (type === 'message.complete') {
      $agentLine.set('')
      if (findCoreEndButton() || $nativeActive.get()) {
        $phase.set('listening')
        syncCaptionToPhase('listening', 'speaking')
      }
    }
  })
}

// --- UI ----------------------------------------------------------------------

function MiniOrb({ size = 26 }) {
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
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    c.width = Math.round(size * dpr)
    c.height = Math.round(size * dpr)
    c.style.width = size + 'px'
    c.style.height = size + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const N = 28
    const draw = now => {
      const t = (now - t0) / 1000
      const cx = size / 2
      const cy = size / 2
      const ph = pr.current
      const lv = lr.current
      const base = ph === 'listening' ? 0.42 : ph === 'speaking' ? 0.5 : 0.2
      const amp = base + lv * 0.55
      ctx.clearRect(0, 0, size, size)
      const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, size * 0.48)
      g.addColorStop(0, `hsla(200,100%,58%,${0.35 + amp * 0.35})`)
      g.addColorStop(0.55, `hsla(145,90%,48%,${0.16 + amp * 0.18})`)
      g.addColorStop(1, 'hsla(48,90%,55%,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(cx, cy, size * 0.48, 0, Math.PI * 2)
      ctx.fill()
      for (let i = 0; i < N; i++) {
        const hue = 188 + (i / N) * 150 + t * 48
        const a0 = (i / N) * Math.PI * 2 + t * 0.8
        ctx.beginPath()
        for (let s = 0; s <= 10; s++) {
          const u = s / 10
          const r =
            size * (0.1 + u * 0.22) + Math.sin(t * 3.8 + i + u * 5) * size * 0.035 * amp
          const a = a0 + u * 1.55
          const x = cx + Math.cos(a) * r
          const y = cy + Math.sin(a) * r
          if (s === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = `hsla(${hue % 360},90%,58%,${0.18 + amp * 0.38})`
        ctx.lineWidth = 0.7
        ctx.stroke()
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size])

  return jsx('canvas', { ref, 'aria-hidden': true, className: 'block shrink-0' })
}

function phaseLabel(p) {
  if (p === 'listening') return 'Listening'
  if (p === 'transcribing') return 'Got it'
  if (p === 'thinking') return 'Thinking'
  if (p === 'speaking') return 'Speaking'
  return 'Voice'
}

function LiveStrip() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  const liveCaption = useValue($liveCaption)
  const lastSaid = useValue($lastSaid)
  const agentLine = useValue($agentLine)
  const elapsed = useValue($elapsed)
  const error = useValue($error)
  const level = useValue($level)
  const captionMode = useValue($captionMode)

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

  const listening = phase === 'listening'
  const showAgent = phase === 'speaking' && agentLine

  // Prefer live caption; else last STT line; never a multi-turn chat log
  let mainLabel = 'YOU'
  let mainText = ''
  let mainLive = false

  if (listening) {
    mainLabel = 'YOU'
    if (liveCaption) {
      mainText = liveCaption
      mainLive = true
    } else if (captionMode === 'unavailable') {
      mainText = 'Listening (live words unavailable here — Desktop STT still hears you)'
      mainLive = true
    } else {
      mainText = 'Listening…'
      mainLive = true
    }
  } else if (phase === 'transcribing' || phase === 'thinking') {
    mainLabel = 'YOU'
    mainText = liveCaption || lastSaid || '…'
    mainLive = false
  } else if (showAgent) {
    mainLabel = 'HERMES'
    mainText = agentLine
    mainLive = true
  } else {
    mainText = liveCaption || lastSaid || phaseLabel(phase)
  }

  return jsxs('div', {
    className: cn(
      'mb-0.5 flex flex-col gap-1.5 rounded-xl border px-2.5 py-2',
      'border-border/50 bg-muted/35 text-muted-foreground',
      'shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] backdrop-blur-sm',
      phase === 'speaking' && 'border-primary/20 bg-primary/6'
    ),
    role: 'status',
    'aria-live': 'polite',
    'data-voice-hud': '1',
    children: [
      jsxs('div', {
        className: 'flex h-7 items-center gap-2',
        children: [
          jsx('span', {
            className: cn(
              'size-1.5 shrink-0 rounded-full',
              listening
                ? 'animate-pulse bg-green-400'
                : phase === 'speaking'
                  ? 'animate-pulse bg-primary'
                  : 'bg-amber-400'
            )
          }),
          jsx('span', {
            className: 'shrink-0 text-[0.7rem] font-medium text-foreground/90',
            children: phaseLabel(phase)
          }),
          jsx('span', {
            className: 'font-mono text-[0.62rem] tabular-nums text-muted-foreground/75',
            children: formatElapsed(elapsed / 1000)
          }),
          jsxs('span', {
            'aria-hidden': true,
            className: 'flex h-3 items-end gap-0.5',
            children: [0.2, 0.4, 0.6, 0.8, 1].map((th, i) =>
              jsx(
                'span',
                {
                  className: cn(
                    'w-0.5 rounded-full transition-[height] duration-75',
                    level >= th * 0.45 ? 'bg-primary' : 'bg-muted-foreground/25'
                  ),
                  style: { height: `${26 + th * 74}%` }
                },
                i
              )
            )
          }),
          jsx('span', {
            className: 'min-w-0 flex-1 truncate text-[0.62rem] text-muted-foreground/55',
            children: listening
              ? captionMode === 'live'
                ? 'Live caption'
                : captionMode === 'unavailable'
                  ? 'Levels only'
                  : 'Arming caption…'
              : phase === 'speaking'
                ? 'Reply'
                : 'Native voice'
          }),
          jsx(MiniOrb, { size: 26 }),
          jsx(Button, {
            type: 'button',
            size: 'sm',
            variant: 'ghost',
            className: 'h-6 shrink-0 rounded-full px-2.5 text-[0.68rem]',
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

      jsxs('div', {
        className: cn(
          'min-h-[2.25rem] rounded-lg border px-2.5 py-1.5',
          mainLabel === 'YOU'
            ? 'border-(--ui-stroke-tertiary) bg-background/40'
            : 'border-primary/15 bg-primary/5'
        ),
        children: [
          jsxs('div', {
            className:
              'mb-0.5 flex items-center gap-1.5 text-[0.55rem] font-medium uppercase tracking-[0.14em] text-(--ui-text-quaternary)',
            children: [
              mainLabel,
              mainLive
                ? jsx('span', {
                    className: 'normal-case tracking-normal text-primary',
                    children: 'live'
                  })
                : null
            ]
          }),
          jsx('div', {
            className: cn(
              'text-[0.9rem] leading-snug text-foreground',
              mainLive && liveCaption && 'font-medium',
              listening && !liveCaption && 'text-muted-foreground/70'
            ),
            children: mainText
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
      ? 'Native voice + live caption — click Stop (will not restart)'
      : 'Voice HUD: live caption while you speak. Settings → Plugins.',
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
        children: active ? `hud ${phase}` : 'hud'
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
    wireDomObserver()
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
          label: 'Voice HUD: Toggle native voice',
          keywords: ['voice', 'hud', 'caption', 'live'],
          run: () => toggleVoice()
        }
      },
      {
        id: 'end',
        area: PALETTE_AREA,
        data: {
          id: 'voice-hud.end',
          label: 'Voice HUD: Stop (no restart)',
          keywords: ['voice', 'end', 'stop'],
          run: () => endVoice()
        }
      },
      {
        id: 'bind',
        area: KEYBINDS_AREA,
        data: {
          id: 'voice-hud.toggle',
          label: 'Voice HUD: Toggle native voice',
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
      stopDomObserver()
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

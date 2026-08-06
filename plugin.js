/**
 * voice-hud — live caption skin over Hermes Desktop native voice.
 *
 * Shows what YOU are saying in real time (Web Speech interim) while core
 * owns the conversation loop. Does NOT replay chat history in the dock.
 *
 * Mic safety:
 *   • Never getUserMedia / MediaRecorder (core holds exclusive mic for VAD)
 *   • Web Speech ONLY while phase === 'listening', hard-aborted otherwise
 *   • No auto-restart after abort (prevents turn-2 mic steal)
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
const END_MISS_TOLERANCE = 4

/** @typedef {'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'} Phase */

const $nativeActive = atom(false)
const $phase = atom(/** @type {Phase} */ ('idle'))
const $level = atom(0)
/** Live words while you speak (interim). Cleared each new listen cycle. */
const $liveCaption = atom('')
/** Thin one-line agent stream (current reply only — not chat history). */
const $agentLine = atom('')
const $elapsed = atom(0)
const $error = atom('')
const $captionSource = atom(/** @type {'live' | 'none'} */ ('none'))

let pollTimer = 0
let endWatch = 0
let elapsedTimer = 0
let startedAt = 0
let endMisses = 0
/** @type {null | { abort: () => void }} */
let speechHandle = null
let speechWanted = false
let committedFinals = ''

function formatElapsed(sec) {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// --- Core voice bus ----------------------------------------------------------

function dispatchVoiceToggle() {
  try {
    window.dispatchEvent(new CustomEvent(VOICE_TOGGLE_EVENT, { detail: { target: 'main' } }))
    return true
  } catch (err) {
    $error.set(err instanceof Error ? err.message : String(err))
    return false
  }
}

function findEndButton() {
  if (typeof document === 'undefined') return null
  return (
    document.querySelector(
      '[data-slot="composer-root"] button[aria-label*="End conversation" i], [data-slot="composer-dock"] button[aria-label*="End conversation" i]'
    ) ||
    document.querySelector(
      '[data-slot="composer-root"] button[aria-label*="End" i], [data-slot="composer-dock"] button[aria-label*="End" i]'
    )
  )
}

function findStartButton() {
  if (typeof document === 'undefined') return null
  return (
    document.querySelector(
      '[data-slot="composer-root"] button[aria-label*="Start voice" i], [data-slot="composer-dock"] button[aria-label*="Start voice" i]'
    ) ||
    document.querySelector('[data-slot="composer-root"] button[aria-label*="voice conversation" i]')
  )
}

function clickCoreEnd() {
  const btn = findEndButton()
  if (btn?.click) {
    btn.click()
    return true
  }
  return false
}

function clickCoreStart() {
  const btn = findStartButton()
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
}

function resetSessionUi() {
  stopLiveCaption()
  $phase.set('idle')
  $level.set(0)
  $elapsed.set(0)
  $liveCaption.set('')
  $agentLine.set('')
  $captionSource.set('none')
  endMisses = 0
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

/** End only — never toggle-start. */
function endVoice() {
  haptic('close')
  $error.set('')
  stopLiveCaption()
  if (findEndButton()) clickCoreEnd()
  $nativeActive.set(false)
  resetSessionUi()
  if (endWatch) clearTimeout(endWatch)
  endWatch = window.setTimeout(() => {
    endWatch = 0
    if (findEndButton()) clickCoreEnd()
  }, 250)
}

function startVoice() {
  $error.set('')
  if ($nativeActive.get() || findEndButton()) return
  haptic('open')
  $liveCaption.set('')
  $agentLine.set('')
  if (!clickCoreStart()) dispatchVoiceToggle()
}

function toggleVoice() {
  if (findEndButton()) endVoice()
  else if ($nativeActive.get()) {
    $nativeActive.set(false)
    resetSessionUi()
  } else startVoice()
}

// --- Live caption (Web Speech, listening-only) --------------------------------

function stopLiveCaption() {
  speechWanted = false
  committedFinals = ''
  const h = speechHandle
  speechHandle = null
  if (!h) return
  try {
    h.abort()
  } catch {
    /* ignore */
  }
}

/**
 * Start interim captions only while Desktop is listening.
 * Hard-abort when leaving listening so we never hold the mic into STT/re-arm.
 */
function startLiveCaption() {
  if (speechHandle || typeof window === 'undefined') return
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) {
    $captionSource.set('none')
    return
  }

  speechWanted = true
  committedFinals = ''
  $liveCaption.set('')
  $captionSource.set('live')

  try {
    const rec = new SR()
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.lang = navigator.language || 'en-US'

    rec.onresult = event => {
      if (!speechWanted || $phase.get() !== 'listening') return
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        const t = (r[0]?.transcript || '').trim()
        if (!t) continue
        if (r.isFinal) committedFinals = (committedFinals + ' ' + t).trim()
        else interim = interim ? interim + ' ' + t : t
      }
      const live = (committedFinals + (interim ? (committedFinals ? ' ' : '') + interim : '')).trim()
      if (live) $liveCaption.set(live)
    }

    rec.onerror = e => {
      // no-speech / aborted normal; not-allowed → tell user captions unavailable
      if (e?.error === 'not-allowed') {
        $captionSource.set('none')
        $error.set('Live captions need mic permission (Desktop still works)')
      }
    }

    // Do NOT auto-restart on end — only parent starts on listen phase.
    rec.onend = () => {
      if (speechHandle && speechHandle.rec === rec) speechHandle = null
      // If still listening and still wanted, one soft restart (browser stops rec periodically)
      if (speechWanted && $phase.get() === 'listening' && $nativeActive.get()) {
        window.setTimeout(() => {
          if (speechWanted && $phase.get() === 'listening' && !speechHandle) {
            startLiveCaption()
          }
        }, 120)
      }
    }

    speechHandle = {
      rec,
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
    $captionSource.set('none')
  }
}

function syncCaptionToPhase(phase) {
  if (phase === 'listening') {
    // Fresh listen cycle — always (re)arm live caption engine
    if (!speechHandle) {
      committedFinals = ''
      $liveCaption.set('')
      startLiveCaption()
    }
  } else {
    // Leave listening → release Web Speech immediately so core STT/re-arm owns mic
    stopLiveCaption()
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
    if (el.getAttribute('data-voice-hud') === '1') continue
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
      if (el.getAttribute('data-voice-hud') === '1') continue
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
  const endBtn = findEndButton()
  let active = Boolean(endBtn)
  if (!active) {
    endMisses += 1
    if (endMisses < END_MISS_TOLERANCE && $nativeActive.get()) active = true
  } else endMisses = 0

  if (!active) return { active: false, phase: /** @type {Phase} */ ('idle'), level: 0 }

  const phase = scrapePhaseFromDom(endBtn)
  const coreLevel = scrapeCoreLevel(endBtn)
  const level =
    coreLevel != null
      ? coreLevel
      : phase === 'listening'
        ? 0.28
        : phase === 'speaking'
          ? 0.42
          : 0.15
  return { active: true, phase, level }
}

function wireDomObserver() {
  if (pollTimer) return
  pollTimer = window.setInterval(() => {
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
      syncCaptionToPhase(phase)
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
      syncCaptionToPhase(phase)
      if (phase === 'listening') {
        $agentLine.set('')
      }
    } else {
      // Stay in listening — ensure caption engine is up
      if (phase === 'listening' && !speechHandle) syncCaptionToPhase('listening')
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
    if (!$nativeActive.get() && !findEndButton()) return
    const type = event.type
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
    const sid = event.session_id || payload.session_id
    const activeSid = host.state.activeSessionId.get()
    if (sid && activeSid && sid !== activeSid) return

    if (type === 'message.start') {
      $agentLine.set('')
      $phase.set('thinking')
      stopLiveCaption()
    } else if (type === 'message.delta') {
      const chunk = String(payload.text || payload.delta || '')
      if (!chunk) return
      // Single live line only — truncate, no history stack
      $agentLine.set(($agentLine.get() + chunk).slice(-280))
      $phase.set('speaking')
      stopLiveCaption()
    } else if (type === 'message.complete') {
      $agentLine.set('')
      if (findEndButton() || $nativeActive.get()) {
        $phase.set('listening')
        syncCaptionToPhase('listening')
      }
    }
  })
}

// --- UI: live caption only (no chat replay) ----------------------------------

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
      const base = ph === 'listening' ? 0.4 : ph === 'speaking' ? 0.48 : 0.2
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
  const agentLine = useValue($agentLine)
  const elapsed = useValue($elapsed)
  const error = useValue($error)
  const level = useValue($level)
  const captionSource = useValue($captionSource)

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

  // Primary line: live you-caption while listening; freeze last caption after take;
  // agent line only while speaking (current stream, not history).
  let mainLabel = 'You'
  let mainText = liveCaption
  let mainLive = listening && Boolean(liveCaption)
  if (listening && !liveCaption) {
    mainText =
      captionSource === 'live'
        ? 'Listening…'
        : 'Listening… (live captions unavailable — Desktop STT still runs)'
    mainLive = true
  } else if (phase === 'transcribing' || phase === 'thinking') {
    mainLabel = 'You'
    mainText = liveCaption || '…'
    mainLive = false
  } else if (showAgent) {
    mainLabel = 'Hermes'
    mainText = agentLine
    mainLive = true
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
      // Status row
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
              ? 'Live caption'
              : phase === 'speaking'
                ? 'Reply stream'
                : 'Desktop voice'
          }),
          jsx(MiniOrb, { size: 26 }),
          jsx(Button, {
            type: 'button',
            size: 'sm',
            variant: 'ghost',
            className: 'h-6 shrink-0 rounded-full px-2.5 text-[0.68rem]',
            'aria-label': 'End voice HUD session',
            onClick: () => endVoice(),
            children: 'End'
          })
        ]
      }),

      // Single live line — NOT a chat transcript
      jsxs('div', {
        className: cn(
          'min-h-[2.25rem] rounded-lg border px-2.5 py-1.5',
          mainLabel === 'You'
            ? 'border-(--ui-stroke-tertiary) bg-background/40'
            : 'border-primary/15 bg-primary/5'
        ),
        children: [
          jsxs('div', {
            className:
              'mb-0.5 flex items-center gap-1.5 text-[0.55rem] font-medium uppercase tracking-[0.12em] text-(--ui-text-quaternary)',
            children: [
              mainLabel,
              mainLive
                ? jsx('span', {
                    className: 'normal-case tracking-normal text-primary',
                    children: '· live'
                  })
                : null
            ]
          }),
          jsx('div', {
            className: cn(
              'text-[0.85rem] leading-snug text-foreground',
              mainLive && mainLabel === 'You' && liveCaption && 'font-medium',
              !liveCaption && listening && 'text-muted-foreground/60'
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
      ? 'Native voice + live caption — click to End'
      : 'Voice HUD: live caption while you speak (no chat replay). Enable in Settings → Plugins.',
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
        children: active ? `hud · ${phase}` : 'hud'
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
          label: 'Voice HUD: Toggle native voice + live caption',
          keywords: ['voice', 'hud', 'caption', 'transcript', 'live'],
          run: () => toggleVoice()
        }
      },
      {
        id: 'end',
        area: PALETTE_AREA,
        data: {
          id: 'voice-hud.end',
          label: 'Voice HUD: End (stop listening)',
          keywords: ['voice', 'end', 'stop'],
          run: () => endVoice()
        }
      },
      {
        id: 'bind',
        area: KEYBINDS_AREA,
        data: {
          id: 'voice-hud.toggle',
          label: 'Voice HUD: Toggle native voice + live caption',
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

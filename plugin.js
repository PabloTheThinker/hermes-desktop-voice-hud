/**
 * voice-hud — optional skin over Hermes Desktop *native* voice conversation.
 *
 * Contract (plugin system):
 *  - Only imports @hermes/plugin-sdk + react*
 *  - defaultEnabled: true → works after server sync; disable in Settings ▸ Plugins
 *  - Skins composer.top when native voice is live; mic control in composer.actions
 *  - Never owns STT/submit — only toggles core via hermes:composer-voice-toggle
 *    or the core End button
 *  - When conversation ends (End / stop-word / core stop), ALL local capture
 *    (analyser, Web Speech) stops hard and does not restart
 *
 * Install: $HERMES_HOME/desktop-plugins/voice-hud/plugin.js
 * Activate: Settings ▸ Plugins ▸ Voice HUD ON → Reload desktop plugins
 */
import {
  Badge,
  Button,
  COMPOSER_AREAS,
  Codicon,
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

/** @typedef {'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'} Phase */

const $nativeActive = atom(false)
const $phase = atom(/** @type {Phase} */ ('idle'))
const $level = atom(0)
const $userText = atom('')
const $agentText = atom('')
const $elapsed = atom(0)
const $error = atom('')
/** Optional floating workshop — off by default. */
const $workshop = atom(false)
/** Hide stock voice pill while our strip is live (one chrome). */
const $suppressStockPill = atom(true)

/**
 * Capture gate — when false, Web Speech onend MUST NOT restart and meter
 * must stay down. This is the fix for “stopped speaking but still listening”.
 */
let captureWanted = false
/** True only after *we* successfully asked core to start (or mirrored start). */
let sessionWanted = false

const meter = {
  stream: null,
  ctx: null,
  analyser: null,
  raf: 0,
  timer: 0,
  startedAt: 0,
  speechRec: null,
  poll: 0,
  endWatch: 0
}

function formatTcg(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  const f = Math.floor((ms % 1000) / (1000 / 24))
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(m)}:${pad(s)}.${pad(f)}`
}

function formatElapsed(sec) {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// --- Core voice bus ----------------------------------------------------------

function dispatchVoiceToggle() {
  try {
    window.dispatchEvent(
      new CustomEvent(VOICE_TOGGLE_EVENT, { detail: { target: 'main' } })
    )
    return true
  } catch (err) {
    $error.set(err instanceof Error ? err.message : String(err))
    return false
  }
}

/** Prefer clicking the live End control — calls endConversation() directly. */
function clickCoreEnd() {
  if (typeof document === 'undefined') return false
  const btn =
    document.querySelector(
      '[data-slot="composer-root"] button[aria-label*="End" i], [data-slot="composer-dock"] button[aria-label*="End" i]'
    ) ||
    document.querySelector(
      'button[aria-label*="End conversation" i], button[aria-label*="End voice" i]'
    )
  if (btn && typeof btn.click === 'function') {
    btn.click()
    return true
  }
  return false
}

function clickCoreStart() {
  if (typeof document === 'undefined') return false
  const btn =
    document.querySelector(
      '[data-slot="composer-root"] button[aria-label*="Start voice" i], [data-slot="composer-dock"] button[aria-label*="Start voice" i]'
    ) ||
    document.querySelector(
      'button[aria-label*="voice conversation" i]:not([aria-pressed="true"])'
    )
  if (btn && typeof btn.click === 'function') {
    btn.click()
    return true
  }
  return false
}

// --- HARD STOP — no restart --------------------------------------------------

function stopSpeechSoft() {
  const rec = meter.speechRec
  meter.speechRec = null
  if (!rec) return
  try {
    rec.onresult = null
    rec.onerror = null
    rec.onend = null // critical: block auto-restart
    rec.abort?.()
    rec.stop?.()
  } catch {
    /* ignore */
  }
}

function stopMeter() {
  if (meter.raf) {
    cancelAnimationFrame(meter.raf)
    meter.raf = 0
  }
  if (meter.timer) {
    clearInterval(meter.timer)
    meter.timer = 0
  }
  try {
    meter.ctx?.close()
  } catch {
    /* ignore */
  }
  meter.ctx = null
  meter.analyser = null
  if (meter.stream) {
    try {
      meter.stream.getTracks().forEach(t => {
        try {
          t.stop()
        } catch {
          /* ignore */
        }
      })
    } catch {
      /* ignore */
    }
  }
  meter.stream = null
  $level.set(0)
}

/** Full local teardown. Safe to call repeatedly. Does not touch core voice. */
function stopAllCapture(reason) {
  captureWanted = false
  stopSpeechSoft()
  stopMeter()
  $level.set(0)
  if (reason) {
    // keep last texts for a beat; phase goes idle
  }
  $phase.set('idle')
  $elapsed.set(0)
  setLiveAttr(false)
}

/** End native conversation + local capture. Idempotent. */
function endVoice() {
  haptic('close')
  sessionWanted = false
  stopAllCapture('end')
  $error.set('')

  // Prefer End button (always ends) over toggle (could desync and start).
  const clicked = clickCoreEnd()
  if (!clicked && $nativeActive.get()) {
    dispatchVoiceToggle()
  }

  // If DOM still shows active shortly after, force toggle once more.
  if (meter.endWatch) clearTimeout(meter.endWatch)
  meter.endWatch = window.setTimeout(() => {
    meter.endWatch = 0
    const still = detectNative().active
    if (still) {
      if (!clickCoreEnd()) dispatchVoiceToggle()
    }
    stopAllCapture('end-watch')
    $nativeActive.set(false)
    $phase.set('idle')
  }, 350)
}

function startVoice() {
  $error.set('')
  if ($nativeActive.get()) return
  haptic('open')
  sessionWanted = true
  // Start core first; capture arms only after we observe active.
  if (!clickCoreStart()) {
    dispatchVoiceToggle()
  }
}

function toggleVoice() {
  if ($nativeActive.get() || sessionWanted) endVoice()
  else startVoice()
}

// --- Soft captions (never owns submit; killed on stop) -----------------------

function startSpeechSoft() {
  if (!captureWanted) return
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR || meter.speechRec) return
  try {
    const rec = new SR()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = navigator.language || 'en-US'
    rec.onresult = event => {
      if (!captureWanted) return
      let interim = ''
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        const t = r[0]?.transcript || ''
        if (r.isFinal) final += t
        else interim += t
      }
      const text = (final || interim).trim()
      if (text) $userText.set(text)
    }
    rec.onerror = () => {
      /* swallow — core STT is source of truth */
    }
    rec.onend = () => {
      // ONLY restart if capture still wanted AND native still live
      if (
        meter.speechRec === rec &&
        captureWanted &&
        $nativeActive.get() &&
        $phase.get() === 'listening'
      ) {
        try {
          rec.start()
        } catch {
          /* ignore */
        }
      }
    }
    rec.start()
    meter.speechRec = rec
  } catch {
    /* Electron often lacks Web Speech */
  }
}

function rmsFromTimeDomain(data) {
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128
    sum += v * v
  }
  return Math.sqrt(sum / Math.max(1, data.length))
}

/**
 * Optional level meter. May fail if core holds the mic exclusively — fine.
 * Never blocks stop; tracks always torn down in stopMeter.
 */
async function startMeter() {
  if (!captureWanted || meter.analyser) return
  if (!navigator.mediaDevices?.getUserMedia) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    // Race: conversation may have ended while permission dialog was open
    if (!captureWanted) {
      stream.getTracks().forEach(t => t.stop())
      return
    }
    meter.stream = stream
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) {
      stream.getTracks().forEach(t => t.stop())
      return
    }
    const ctx = new AC()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.7
    source.connect(analyser)
    meter.ctx = ctx
    meter.analyser = analyser
    void ctx.resume()
    const data = new Uint8Array(analyser.fftSize)
    const tick = () => {
      if (!meter.analyser || !captureWanted) return
      meter.analyser.getByteTimeDomainData(data)
      $level.set(Math.min(1, rmsFromTimeDomain(data) * 7.5))
      meter.raf = requestAnimationFrame(tick)
    }
    meter.raf = requestAnimationFrame(tick)
  } catch {
    /* core holds mic — phase-driven orb only */
  }
}

function startElapsed() {
  meter.startedAt = performance.now()
  $elapsed.set(0)
  if (meter.timer) clearInterval(meter.timer)
  meter.timer = window.setInterval(() => {
    if (!captureWanted) {
      clearInterval(meter.timer)
      meter.timer = 0
      return
    }
    $elapsed.set(performance.now() - meter.startedAt)
  }, 100)
}

function armCapture() {
  if (captureWanted) return
  captureWanted = true
  $userText.set('')
  $agentText.set('')
  startElapsed()
  void startMeter()
  startSpeechSoft()
}

// --- DOM observe native conversation ----------------------------------------

function detectNative() {
  if (typeof document === 'undefined') {
    return { active: false, phase: /** @type {Phase} */ ('idle') }
  }

  let hit = ''
  const scopes = document.querySelectorAll(
    '[data-slot="composer-root"], [data-slot="composer-dock"], [data-slot="composer-surface"]'
  )
  for (const scope of scopes) {
    for (const el of scope.querySelectorAll('[role="status"]')) {
      // Skip our own HUD status
      if (el.getAttribute('data-voice-hud') === '1') continue
      const t = (el.textContent || '').trim().toLowerCase()
      if (!t) continue
      if (t.includes('listen')) hit = 'listening'
      else if (t.includes('transcrib') || t.includes('dictat')) hit = 'transcribing'
      else if (t.includes('think')) hit = 'thinking'
      else if (t.includes('speak') || t.includes('reading') || t.includes('preparing')) {
        hit = 'speaking'
      } else if (t.includes('mut')) hit = 'listening'
      if (hit) break
    }
    if (hit) break
  }

  const endBtn = document.querySelector(
    '[data-slot="composer-root"] button[aria-label*="End" i], [data-slot="composer-dock"] button[aria-label*="End" i]'
  )
  // ConversationPill only mounts while voiceConversationActive
  const active = Boolean(endBtn) || Boolean(hit && hit !== 'idle')

  if (!hit && active) {
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
      if (t.includes('speaking') || t.includes('reading') || t.includes('preparing')) {
        hit = 'speaking'
        break
      }
    }
  }

  return {
    active,
    phase: /** @type {Phase} */ (active ? hit || 'listening' : 'idle')
  }
}

function scrapeLastUserBubble() {
  const nodes = document.querySelectorAll(
    '[data-role="user"], [data-message-role="user"], [data-slot*="user-message"]'
  )
  if (!nodes.length) return ''
  return (nodes[nodes.length - 1].textContent || '').trim().slice(0, 420)
}

function onNativeBecameActive() {
  sessionWanted = true
  armCapture()
  setLiveAttr(true)
}

function onNativeBecameInactive() {
  sessionWanted = false
  stopAllCapture('native-off')
  $nativeActive.set(false)
  $phase.set('idle')
}

function wireDomObserver() {
  if (meter.poll) return
  meter.poll = window.setInterval(() => {
    const { active, phase } = detectNative()
    const was = $nativeActive.get()

    if (active !== was) {
      $nativeActive.set(active)
      if (active) onNativeBecameActive()
      else onNativeBecameInactive()
    } else {
      $nativeActive.set(active)
    }

    if (active) {
      $phase.set(phase)
      setLiveAttr(true)
      // If capture was killed somehow while still active, re-arm once
      if (!captureWanted && sessionWanted) armCapture()
      if (phase === 'thinking' || phase === 'speaking' || phase === 'transcribing') {
        const bubble = scrapeLastUserBubble()
        if (bubble && bubble.length >= ($userText.get() || '').length) {
          $userText.set(bubble)
        }
      }
      // While agent speaks, pause soft-speech restart noise (still ok to keep)
      if (phase === 'speaking' || phase === 'thinking') {
        // keep captureWanted true for session, but don't force speech rec
      }
    } else if (captureWanted || sessionWanted) {
      // belt-and-suspenders: inactive must kill listening
      onNativeBecameInactive()
    }
  }, 160)
}

function stopDomObserver() {
  if (meter.poll) {
    clearInterval(meter.poll)
    meter.poll = 0
  }
  if (meter.endWatch) {
    clearTimeout(meter.endWatch)
    meter.endWatch = 0
  }
  setLiveAttr(false)
}

// --- CSS: one chrome with composer ------------------------------------------

function ensureIntegratedCss() {
  if (typeof document === 'undefined') return
  let el = document.getElementById(STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = $suppressStockPill.get()
    ? `
/* voice-hud: collapse stock VoiceActivity pill while our strip owns the dock */
[data-voice-hud-live="1"] [data-slot="composer-root"] [aria-live="polite"][role="status"].h-8:not([data-voice-hud]),
[data-voice-hud-live="1"] [data-slot="composer-surface"] [aria-live="polite"][role="status"].h-8:not([data-voice-hud]) {
  display: none !important;
}
`
    : ''
}

function setLiveAttr(on) {
  if (typeof document === 'undefined') return
  document
    .querySelectorAll('[data-slot="composer-root"], [data-slot="composer-dock"]')
    .forEach(n => {
      if (on) n.setAttribute('data-voice-hud-live', '1')
      else n.removeAttribute('data-voice-hud-live')
    })
  if (on) document.documentElement.setAttribute('data-voice-hud-live', '1')
  else document.documentElement.removeAttribute('data-voice-hud-live')
  ensureIntegratedCss()
}

// --- Gateway agent chip ------------------------------------------------------

function wireGateway() {
  return host.onEvent('*', event => {
    if (!event || typeof event !== 'object') return
    if (!$nativeActive.get() && !sessionWanted) return
    const type = event.type
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
    const sid = event.session_id || payload.session_id
    const activeSid = host.state.activeSessionId.get()
    if (sid && activeSid && sid !== activeSid) return

    if (type === 'message.start') {
      $agentText.set('')
      if ($nativeActive.get()) $phase.set('thinking')
    } else if (type === 'message.delta') {
      const chunk = String(payload.text || payload.delta || '')
      if (chunk) {
        $agentText.set(($agentText.get() + chunk).slice(-900))
        if ($nativeActive.get()) $phase.set('speaking')
      }
    } else if (type === 'message.complete') {
      // Core returns to listening for the next turn — we stay armed until End
      if ($nativeActive.get()) $phase.set('listening')
    }
  })
}

// --- Fiber orb ---------------------------------------------------------------

function FiberOrb({ size = 88 }) {
  const ref = useRef(null)
  const level = useValue($level)
  const phase = useValue($phase)
  const levelRef = useRef(level)
  const phaseRef = useRef(phase)
  levelRef.current = level
  phaseRef.current = phase

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    const t0 = performance.now()
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const S = size
    canvas.width = Math.round(S * dpr)
    canvas.height = Math.round(S * dpr)
    canvas.style.width = `${S}px`
    canvas.style.height = `${S}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const STRANDS = 120
    const draw = now => {
      const t = (now - t0) / 1000
      const cx = S / 2
      const cy = S / 2
      const ph = phaseRef.current
      const lv = levelRef.current
      const live = ph === 'listening' || ph === 'speaking' || ph === 'transcribing'
      const base =
        ph === 'speaking' ? 0.5 : ph === 'listening' ? 0.38 : ph === 'thinking' ? 0.26 : 0.1
      const amp = base + lv * (ph === 'speaking' ? 0.5 : 0.95)

      ctx.clearRect(0, 0, S, S)
      ctx.fillStyle = 'hsla(210, 55%, 8%, 0.92)'
      ctx.beginPath()
      roundRect(ctx, 0.5, 0.5, S - 1, S - 1, 4)
      ctx.fill()
      ctx.strokeStyle = 'hsla(200, 40%, 40%, 0.35)'
      ctx.lineWidth = 1
      ctx.stroke()

      const core = ctx.createRadialGradient(cx, cy, 1, cx, cy, S * 0.42)
      core.addColorStop(0, `hsla(205, 100%, 55%, ${0.55 + amp * 0.25})`)
      core.addColorStop(0.25, `hsla(185, 95%, 50%, ${0.35 + amp * 0.2})`)
      core.addColorStop(0.55, `hsla(130, 90%, 48%, ${0.18 + amp * 0.12})`)
      core.addColorStop(0.8, `hsla(55, 95%, 52%, ${0.1 + amp * 0.08})`)
      core.addColorStop(1, 'hsla(300, 80%, 55%, 0)')
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(cx, cy, S * 0.42, 0, Math.PI * 2)
      ctx.fill()

      for (let i = 0; i < STRANDS; i++) {
        const hue = 190 + (i / STRANDS) * 170 + t * 40
        const a0 = (i / STRANDS) * Math.PI * 2 + t * (0.5 + (i % 5) * 0.03)
        const ring = S * (0.16 + (i % 9) * 0.008)
        ctx.beginPath()
        const segs = 26
        for (let s = 0; s <= segs; s++) {
          const u = s / segs
          const wobble = Math.sin(t * 3.2 + i * 0.4 + u * 10) * S * 0.028 * amp
          const tube = Math.sin(t * 5 + i + u * 4) * S * 0.018 * (0.5 + amp)
          const r = ring + wobble + tube + u * S * 0.04 * amp
          const a = a0 + u * (2.2 + Math.sin(i * 0.3) * 0.5)
          const x = cx + Math.cos(a) * r
          const y = cy + Math.sin(a) * r * 0.96
          if (s === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        const alpha = 0.14 + amp * 0.38 + (live ? 0.06 : 0)
        ctx.strokeStyle = `hsla(${hue % 360}, 92%, ${52 + amp * 14}%, ${alpha})`
        ctx.lineWidth = 0.7 + (i % 4) * 0.2
        ctx.stroke()
      }

      ctx.beginPath()
      ctx.arc(cx, cy, S * (0.14 + amp * 0.04), 0, Math.PI * 2)
      ctx.strokeStyle = `hsla(195, 100%, 70%, ${0.35 + amp * 0.4})`
      ctx.lineWidth = 1.4
      ctx.stroke()

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size])

  return jsx('canvas', { ref, 'aria-hidden': true, className: 'block shrink-0' })
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function LevelBars({ level, active }) {
  const bars = [0.45, 0.7, 1, 0.7, 0.45]
  const n = Math.max(0, Math.min(level, 1))
  return jsxs('div', {
    'aria-hidden': true,
    className: 'flex h-3.5 items-center gap-0.5',
    children: bars.map((w, i) =>
      jsx(
        'span',
        {
          className: cn(
            'w-0.5 rounded-full bg-current transition-[height,opacity] duration-100',
            active ? 'opacity-80' : 'opacity-40'
          ),
          style: {
            height: `${(active ? 0.28 + Math.min(0.72, n * w) : 0.28) * 100}%`
          }
        },
        i
      )
    )
  })
}

function PulseDot({ live }) {
  return jsx('span', {
    'aria-hidden': true,
    className: cn(
      'h-2 w-2 shrink-0 rounded-full',
      live
        ? 'animate-pulse bg-green-400 shadow-[0_0_6px_theme(colors.green.400)]'
        : 'bg-(--ui-text-tertiary) opacity-50'
    )
  })
}

function phaseLabel(phase) {
  if (phase === 'listening') return 'Listening'
  if (phase === 'transcribing') return 'Transcribing'
  if (phase === 'thinking') return 'Thinking'
  if (phase === 'speaking') return 'Speaking'
  return 'Voice'
}

// --- UI ----------------------------------------------------------------------

function ComposerIntegratedHud() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  const level = useValue($level)
  const userText = useValue($userText)
  const agentText = useValue($agentText)
  const elapsed = useValue($elapsed)
  const error = useValue($error)

  if (!active) {
    if (error) {
      return jsx('div', {
        className:
          'mb-1 flex h-8 items-center gap-2 rounded-xl border border-destructive/35 bg-destructive/10 px-2.5 text-xs text-destructive',
        children: error
      })
    }
    return null
  }

  const you =
    phase === 'listening' && !userText
      ? '…'
      : phase === 'transcribing' && !userText
        ? 'Transcribing…'
        : userText || '…'

  return jsxs('div', {
    className: cn(
      'mb-1 flex flex-col gap-1.5 rounded-xl border px-2.5 py-2 text-xs',
      'border-border/55 bg-muted/55 text-muted-foreground',
      'shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] backdrop-blur-sm',
      phase === 'speaking' && 'border-primary/20 bg-primary/10 text-primary'
    ),
    'aria-live': 'polite',
    role: 'status',
    'data-voice-hud': '1',
    children: [
      jsxs('div', {
        className: 'flex h-7 items-center gap-2',
        children: [
          jsx(PulseDot, { live: phase === 'listening' || phase === 'speaking' }),
          jsx('span', {
            className: 'shrink-0 font-medium text-foreground/85',
            children: phaseLabel(phase)
          }),
          jsx('span', {
            className: 'font-mono text-[0.6875rem] text-muted-foreground/85',
            children: formatElapsed(elapsed / 1000)
          }),
          jsx(LevelBars, {
            level,
            active: phase === 'listening' || phase === 'speaking'
          }),
          jsx('span', {
            className:
              'ml-auto font-mono text-[0.625rem] tabular-nums text-(--ui-text-quaternary)',
            children: 'TCG ' + formatTcg(elapsed)
          }),
          jsx(Button, {
            size: 'sm',
            type: 'button',
            variant: 'ghost',
            className: 'h-6 shrink-0 rounded-full px-2 text-[0.6875rem]',
            onClick: () => endVoice(),
            children: 'End'
          })
        ]
      }),
      jsxs('div', {
        className: 'flex items-stretch gap-2',
        children: [
          jsxs('div', {
            className: 'flex min-w-0 flex-1 flex-col gap-1.5',
            children: [
              jsxs('div', {
                className: cn(
                  'min-h-[2rem] rounded-lg border px-2.5 py-1.5',
                  'border-(--ui-stroke-tertiary) bg-(--ui-widget-surface-background,var(--ui-bg-quaternary))'
                ),
                children: [
                  jsx('div', {
                    className:
                      'mb-0.5 text-[0.5625rem] font-medium uppercase tracking-[0.14em] text-(--ui-text-quaternary)',
                    children: 'You'
                  }),
                  jsx('div', {
                    className: cn(
                      'truncate text-[0.8125rem] leading-snug tracking-wide text-foreground',
                      userText && 'font-semibold uppercase'
                    ),
                    title: you,
                    children: you
                  })
                ]
              }),
              agentText
                ? jsxs('div', {
                    className: cn(
                      'min-h-[1.75rem] rounded-lg border px-2.5 py-1.5',
                      'border-primary/20 bg-primary/5'
                    ),
                    children: [
                      jsx('div', {
                        className:
                          'mb-0.5 text-[0.5625rem] font-medium uppercase tracking-[0.14em] text-(--ui-text-quaternary)',
                        children: 'Hermes'
                      }),
                      jsx('div', {
                        className:
                          'line-clamp-2 text-[0.75rem] leading-snug text-foreground/90',
                        title: agentText,
                        children: agentText
                      })
                    ]
                  })
                : null
            ]
          }),
          jsx(FiberOrb, { size: 88 })
        ]
      })
    ]
  })
}

function ComposerActionControl() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  return jsx(Tip, {
    label: active
      ? 'End native voice conversation (stops listening)'
      : 'Start native voice conversation — HUD skins the Desktop loop',
    children: jsx(Button, {
      type: 'button',
      size: 'icon-sm',
      variant: active ? 'secondary' : 'ghost',
      'aria-pressed': active,
      'aria-label': active ? 'End voice conversation' : 'Start voice conversation',
      onClick: () => {
        haptic(active ? 'close' : 'open')
        toggleVoice()
      },
      children: active
        ? jsx(PulseDot, { live: phase === 'listening' || phase === 'speaking' })
        : jsx(Codicon, { name: 'mic', size: '0.875rem' })
    })
  })
}

function StatusChip() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  const level = useValue($level)
  const label = !active
    ? 'voice hud'
    : phase === 'listening'
      ? `hud · ${Math.round(level * 100)}%`
      : `hud · ${phase}`

  return jsx(Tip, {
    label:
      'Voice HUD (optional). Skins Desktop native voice. Click to start/end. Disable anytime in Settings → Plugins.',
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
        children: label
      })
    })
  })
}

function WorkshopPane() {
  const on = useValue($workshop)
  const active = useValue($nativeActive)
  if (!on) {
    return jsxs('div', {
      className:
        'flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm',
      children: [
        jsx('p', {
          className: 'max-w-[14rem] text-(--ui-text-tertiary)',
          children:
            'Optional workshop canvas. Main HUD lives in the composer with native Desktop voice.'
        }),
        jsx(Button, {
          type: 'button',
          size: 'sm',
          variant: 'secondary',
          onClick: () => $workshop.set(true),
          children: 'Show workshop'
        })
      ]
    })
  }
  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 p-3',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2',
        children: [
          jsx('span', {
            className: 'text-xs font-medium text-(--ui-text-secondary)',
            children: 'Voice workshop'
          }),
          jsx(Button, {
            type: 'button',
            size: 'sm',
            variant: 'text',
            onClick: () => $workshop.set(false),
            children: 'Hide'
          })
        ]
      }),
      jsx('div', { className: 'h-px bg-(--ui-stroke-tertiary)' }),
      jsx(ComposerIntegratedHud, {}),
      !active
        ? jsx(Button, {
            type: 'button',
            className: 'mt-auto',
            onClick: () => startVoice(),
            children: 'Start native voice'
          })
        : jsx(Button, {
            type: 'button',
            className: 'mt-auto',
            variant: 'destructive',
            onClick: () => endVoice(),
            children: 'End voice (stop listening)'
          }),
      jsx('p', {
        className: 'text-[0.625rem] leading-relaxed text-(--ui-text-quaternary)',
        children:
          'Same native conversation as the composer voice button. End always stops listening.'
      })
    ]
  })
}

export default {
  id: PLUGIN_ID,
  name: 'Voice HUD',
  /** On by default once installed/synced; disable anytime in Settings ▸ Plugins. */
  defaultEnabled: true,
  register(ctx) {
    $workshop.set(ctx.storage.get('workshop', false))
    $suppressStockPill.set(ctx.storage.get('suppressStockPill', true))
    $workshop.listen(v => ctx.storage.set('workshop', v))
    $suppressStockPill.listen(v => {
      ctx.storage.set('suppressStockPill', v)
      ensureIntegratedCss()
    })

    ensureIntegratedCss()
    wireDomObserver()
    const offGw = wireGateway()

    const disposeRegs = ctx.registerMany([
      {
        id: 'composer-top',
        area: COMPOSER_AREAS.top,
        order: 5,
        render: () => jsx(ComposerIntegratedHud, {})
      },
      {
        id: 'composer-action',
        area: COMPOSER_AREAS.actions,
        order: 40,
        render: () => jsx(ComposerActionControl, {})
      },
      {
        id: 'chip',
        area: STATUSBAR_AREAS.right,
        order: 125,
        render: () => jsx(StatusChip, {})
      },
      {
        id: 'workshop',
        area: 'panes',
        title: 'voice',
        when: () => $workshop.get(),
        data: {
          placement: 'floating',
          anchor: 'top-right',
          width: '340px',
          height: '420px',
          uncloseable: true
        },
        render: () => jsx(WorkshopPane, {})
      },
      {
        id: 'toggle',
        area: PALETTE_AREA,
        data: {
          id: 'voice-hud.toggle',
          action: 'voice-hud.toggle',
          label: 'Voice HUD: Toggle native conversation',
          keywords: ['voice', 'hud', 'mic', 'listen', 'speech', 'end'],
          run: () => toggleVoice()
        }
      },
      {
        id: 'end',
        area: PALETTE_AREA,
        data: {
          id: 'voice-hud.end',
          label: 'Voice HUD: End conversation (stop listening)',
          keywords: ['voice', 'end', 'stop', 'listening'],
          run: () => endVoice()
        }
      },
      {
        id: 'workshop-toggle',
        area: PALETTE_AREA,
        data: {
          id: 'voice-hud.workshop',
          label: 'Voice HUD: Toggle workshop pane',
          keywords: ['voice', 'workshop', 'floating'],
          run: () => {
            $workshop.set(!$workshop.get())
            haptic('selection')
          }
        }
      },
      {
        id: 'toggle-bind',
        area: KEYBINDS_AREA,
        data: {
          id: 'voice-hud.toggle',
          label: 'Voice HUD: Toggle native conversation',
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
      stopAllCapture('unload')
      sessionWanted = false
      document.getElementById(STYLE_ID)?.remove()
      setLiveAttr(false)
      try {
        disposeRegs?.()
      } catch {
        /* ignore */
      }
    }

    // Preferred API
    if (typeof ctx.onDispose === 'function') ctx.onDispose(cleanup)
    // Older builds
    if (typeof ctx.onUnload === 'function') ctx.onUnload(cleanup)
  }
}

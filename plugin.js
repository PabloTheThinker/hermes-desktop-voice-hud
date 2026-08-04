/**
 * voice-hud — native-integrated speech layer for Hermes Desktop.
 *
 * Design goals (Pablo):
 *  1. Deep-link the *core* composer voice conversation (not a second STT path).
 *  2. Feel like one surface with the typing dock — Hermes tokens, flat chrome.
 *  3. Mark II workshop orb + YOU caption (film still), without a separate “app”.
 *
 * Surfaces:
 *   composer.top     — primary HUD (expands only while voice is live)
 *   composer.actions — quiet Listen control next to model / send
 *   statusBar chip   — phase glance
 *   floating pane    — optional workshop view (OFF by default)
 *
 * Install: $HERMES_HOME/desktop-plugins/voice-hud/plugin.js
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
const STYLE_ID = 'voice-hud-integrated-css'

/** @typedef {'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'} Phase */

const $nativeActive = atom(false)
const $phase = atom(/** @type {Phase} */ ('idle'))
const $level = atom(0)
const $userText = atom('')
const $agentText = atom('')
const $elapsed = atom(0)
const $error = atom('')
/** Workshop floating card — off by default so the composer path is “the” UI. */
const $workshop = atom(false)
/** When live, soften/hide the stock 32px voice-activity pill so we don’t double chrome. */
const $suppressStockPill = atom(true)

const meter = {
  stream: null,
  ctx: null,
  analyser: null,
  raf: 0,
  timer: 0,
  startedAt: 0,
  speechRec: null,
  poll: 0
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

function toggleNativeVoice() {
  try {
    window.dispatchEvent(new CustomEvent(VOICE_TOGGLE_EVENT, { detail: { target: 'main' } }))
    return true
  } catch (err) {
    $error.set(err instanceof Error ? err.message : String(err))
    return false
  }
}

function startVoice() {
  $error.set('')
  if (!$nativeActive.get()) {
    haptic('open')
    toggleNativeVoice()
  }
}

function endVoice() {
  if ($nativeActive.get()) {
    haptic('close')
    toggleNativeVoice()
  }
}

function toggleVoice() {
  if ($nativeActive.get()) endVoice()
  else startVoice()
}

// --- Integrated CSS: match composer chrome, hide stock pill when we own the strip ---
function ensureIntegratedCss() {
  if (typeof document === 'undefined') return
  let el = document.getElementById(STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  // Stock VoiceActivity is the h-8 strip with aria-live polite above the input.
  // When our HUD is live we collapse it so the dock reads as one layer.
  el.textContent = $suppressStockPill.get()
    ? `
/* voice-hud: one chrome with the composer while native voice is live */
[data-voice-hud-live="1"] [data-slot="composer-root"] > div > div > [aria-live="polite"][role="status"].flex.h-8,
[data-voice-hud-live="1"] [data-slot="composer-surface"] [aria-live="polite"][role="status"].h-8 {
  display: none !important;
}
`
    : ''
}

function setLiveAttr(on) {
  if (typeof document === 'undefined') return
  const roots = document.querySelectorAll('[data-slot="composer-root"], [data-slot="composer-dock"]')
  roots.forEach(n => {
    if (on) n.setAttribute('data-voice-hud-live', '1')
    else n.removeAttribute('data-voice-hud-live')
  })
  // also mark body for any portal’d bits
  if (on) document.documentElement.setAttribute('data-voice-hud-live', '1')
  else document.documentElement.removeAttribute('data-voice-hud-live')
  ensureIntegratedCss()
}

// --- Soft interim captions (core still submits) ---
function startSpeechSoft() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR || meter.speechRec) return
  try {
    const rec = new SR()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = navigator.language || 'en-US'
    rec.onresult = event => {
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
    rec.onerror = () => {}
    rec.onend = () => {
      if (meter.speechRec === rec && $nativeActive.get() && $phase.get() === 'listening') {
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
    /* no Web Speech in this Electron — OK */
  }
}

function stopSpeechSoft() {
  if (!meter.speechRec) return
  try {
    meter.speechRec.onresult = null
    meter.speechRec.onend = null
    meter.speechRec.stop()
  } catch {
    /* ignore */
  }
  meter.speechRec = null
}

function rmsFromTimeDomain(data) {
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128
    sum += v * v
  }
  return Math.sqrt(sum / Math.max(1, data.length))
}

async function startMeter() {
  if (meter.analyser || !navigator.mediaDevices?.getUserMedia) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    meter.stream = stream
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
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
      if (!meter.analyser) return
      meter.analyser.getByteTimeDomainData(data)
      $level.set(Math.min(1, rmsFromTimeDomain(data) * 7.5))
      meter.raf = requestAnimationFrame(tick)
    }
    meter.raf = requestAnimationFrame(tick)
  } catch {
    /* mic held exclusively by core — phase-driven orb still works */
  }
}

function stopMeter() {
  if (meter.raf) cancelAnimationFrame(meter.raf)
  meter.raf = 0
  if (meter.timer) clearInterval(meter.timer)
  meter.timer = 0
  try {
    meter.ctx?.close()
  } catch {
    /* ignore */
  }
  meter.ctx = null
  meter.analyser = null
  meter.stream?.getTracks().forEach(t => t.stop())
  meter.stream = null
  $level.set(0)
}

function startElapsed() {
  meter.startedAt = performance.now()
  $elapsed.set(0)
  if (meter.timer) clearInterval(meter.timer)
  meter.timer = window.setInterval(() => {
    $elapsed.set(performance.now() - meter.startedAt)
  }, 100)
}

function detectNativePhase() {
  const scopes = document.querySelectorAll(
    '[data-slot="composer-root"], [data-slot="composer-dock"], [data-slot="composer-surface"]'
  )
  let hit = ''
  for (const scope of scopes) {
    for (const el of scope.querySelectorAll('[role="status"]')) {
      const t = (el.textContent || '').trim().toLowerCase()
      if (!t) continue
      if (t.includes('listen')) hit = 'listening'
      else if (t.includes('transcrib') || t.includes('dictat')) hit = 'transcribing'
      else if (t.includes('think')) hit = 'thinking'
      else if (t.includes('speak') || t.includes('reading') || t.includes('preparing')) hit = 'speaking'
      else if (t.includes('mut')) hit = 'listening'
      if (hit) break
    }
    if (hit) break
  }

  const endBtn = document.querySelector(
    '[data-slot="composer-root"] button[aria-label*="End" i], [data-slot="composer-dock"] button[aria-label*="End" i]'
  )
  const active = Boolean(endBtn) || Boolean(hit)

  if (!hit && active) {
    for (const el of document.querySelectorAll('[aria-live="polite"]')) {
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

  return { active, phase: /** @type {Phase} */ (active ? hit || 'listening' : 'idle') }
}

function scrapeLastUserBubble() {
  const nodes = document.querySelectorAll(
    '[data-role="user"], [data-message-role="user"], [data-slot*="user-message"]'
  )
  if (!nodes.length) return ''
  return (nodes[nodes.length - 1].textContent || '').trim().slice(0, 420)
}

function wireDomObserver() {
  if (meter.poll) return
  meter.poll = window.setInterval(() => {
    const { active, phase } = detectNativePhase()
    const was = $nativeActive.get()
    $nativeActive.set(active)
    setLiveAttr(active)

    if (active && !was) {
      $userText.set('')
      $agentText.set('')
      startElapsed()
      startMeter()
      startSpeechSoft()
    } else if (!active && was) {
      stopMeter()
      stopSpeechSoft()
      $phase.set('idle')
      $elapsed.set(0)
    }

    if (active) {
      $phase.set(phase)
      if (phase === 'thinking' || phase === 'speaking' || phase === 'transcribing') {
        const bubble = scrapeLastUserBubble()
        if (bubble && bubble.length >= ($userText.get() || '').length) $userText.set(bubble)
      }
    }
  }, 180)
}

function stopDomObserver() {
  if (meter.poll) clearInterval(meter.poll)
  meter.poll = 0
  setLiveAttr(false)
}

function wireGateway() {
  return host.onEvent('*', event => {
    if (!event || typeof event !== 'object') return
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
      if ($nativeActive.get()) $phase.set('listening')
    }
  })
}

/**
 * Film still orb: dense toroidal fiber ball.
 * Blue/cyan core → green equator → yellow/magenta rim. Nested in CAD tile chrome.
 */
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

    const STRANDS = 140
    const draw = now => {
      const t = (now - t0) / 1000
      const cx = S / 2
      const cy = S / 2
      const ph = phaseRef.current
      const lv = levelRef.current
      const live = ph === 'listening' || ph === 'speaking' || ph === 'transcribing'
      const base = ph === 'speaking' ? 0.5 : ph === 'listening' ? 0.38 : ph === 'thinking' ? 0.26 : 0.12
      const amp = base + lv * (ph === 'speaking' ? 0.5 : 0.95)

      ctx.clearRect(0, 0, S, S)

      // CAD tile fill (film: dark navy well)
      ctx.fillStyle = 'hsla(210, 55%, 8%, 0.92)'
      ctx.beginPath()
      roundRect(ctx, 0.5, 0.5, S - 1, S - 1, 4)
      ctx.fill()
      ctx.strokeStyle = 'hsla(200, 40%, 40%, 0.35)'
      ctx.lineWidth = 1
      ctx.stroke()

      // Soft core glow — blue center like the still
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

      // Dense tangled fibers (film: high density, short arcs around a ring)
      for (let i = 0; i < STRANDS; i++) {
        // hue walk: blue → cyan → green → yellow → magenta around the torus
        const hue = 190 + (i / STRANDS) * 170 + t * 40
        const a0 = (i / STRANDS) * Math.PI * 2 + t * (0.5 + (i % 5) * 0.03)
        // ring radius — toroidal, not filled ball
        const ring = S * (0.16 + (i % 9) * 0.008)
        ctx.beginPath()
        const segs = 28
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

      // Hollow bright ring (still has clear donut hole edge)
      ctx.beginPath()
      ctx.arc(cx, cy, S * (0.14 + amp * 0.04), 0, Math.PI * 2)
      ctx.strokeStyle = `hsla(195, 100%, 70%, ${0.35 + amp * 0.4})`
      ctx.lineWidth = 1.4
      ctx.stroke()

      // Tiny CAD chrome dots (film window has micro chrome)
      ctx.fillStyle = 'hsla(200, 30%, 70%, 0.35)'
      ctx.beginPath()
      ctx.arc(S - 7, 6, 1.2, 0, Math.PI * 2)
      ctx.fill()

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
          style: { height: `${(active ? 0.28 + Math.min(0.72, n * w) : 0.28) * 100}%` }
        },
        i
      )
    )
  })
}

function phaseTone(phase) {
  if (phase === 'speaking') return 'good'
  if (phase === 'listening' || phase === 'transcribing') return 'good'
  if (phase === 'thinking') return 'warn'
  return 'muted'
}

/** Inline pulse dot matching the core StatusDot color tokens (not a plugin-sdk export). */
function PulseDot({ tone }) {
  const cls =
    tone === 'good'
      ? 'bg-green-400 shadow-[0_0_6px_theme(colors.green.400)] animate-pulse-dot'
      : tone === 'warn'
        ? 'bg-amber-400 shadow-[0_0_6px_theme(colors.amber.400)]'
        : 'bg-(--ui-text-tertiary)'
  return jsx('span', {
    'aria-hidden': true,
    className: cn('h-2 w-2 shrink-0 rounded-full', cls)
  })
}

function phaseLabel(phase) {
  if (phase === 'listening') return 'Listening'
  if (phase === 'transcribing') return 'Transcribing'
  if (phase === 'thinking') return 'Thinking'
  if (phase === 'speaking') return 'Speaking'
  return 'Voice'
}

/**
 * Primary HUD — same visual family as core VoiceActivity (h-8 strip language),
 * expanded into a single flat dock row: status · YOU caption · orb · AGENT.
 * No nested cards. Tokens only.
 */
function ComposerIntegratedHud() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  const level = useValue($level)
  const userText = useValue($userText)
  const agentText = useValue($agentText)
  const elapsed = useValue($elapsed)
  const error = useValue($error)

  // Idle: render nothing — the actions control is the quiet affordance.
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
      // Match VoiceActivity / VoicePlaybackActivity primitives exactly
      'mb-1 flex flex-col gap-1.5 rounded-xl border px-2.5 py-2 text-xs',
      'border-border/55 bg-muted/55 text-muted-foreground',
      'shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] backdrop-blur-sm',
      phase === 'speaking' && 'border-primary/20 bg-primary/10 text-primary'
    ),
    'aria-live': 'polite',
    role: 'status',
    children: [
      // Row 1 — same height language as stock pill
      jsxs('div', {
        className: 'flex h-7 items-center gap-2',
        children: [
          jsx(PulseDot, { tone: phaseTone(phase) }),
          jsx('span', {
            className: 'shrink-0 font-medium text-foreground/85',
            children: phaseLabel(phase)
          }),
          jsx('span', {
            className: 'font-mono text-[0.6875rem] text-muted-foreground/85',
            children: formatElapsed(elapsed / 1000)
          }),
          jsx(LevelBars, { level, active: phase === 'listening' || phase === 'speaking' }),
          jsx('span', {
            className: 'ml-auto font-mono text-[0.625rem] tabular-nums text-(--ui-text-quaternary)',
            children: 'TCG ' + formatTcg(elapsed)
          }),
          jsx(Button, {
            size: 'sm',
            type: 'button',
            variant: 'ghost',
            className: 'h-6 shrink-0 rounded-full px-2 text-[0.6875rem]',
            onClick: () => {
              haptic('close')
              endVoice()
            },
            children: 'End'
          })
        ]
      }),

      // Row 2 — film layout: caption chip + orb tile (flat, one hairline)
      jsxs('div', {
        className: 'flex items-stretch gap-2',
        children: [
          jsxs('div', {
            className: 'flex min-w-0 flex-1 flex-col gap-1.5',
            children: [
              // YOU — film STT chip
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
              // AGENT — only when there is stream text (keeps flat when idle listen)
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
                        className: 'line-clamp-2 text-[0.75rem] leading-snug text-foreground/90',
                        title: agentText,
                        children: agentText
                      })
                    ]
                  })
                : null
            ]
          }),
          // Orb CAD tile — film proportions (smaller than caption width)
          jsx(FiberOrb, { size: 88 })
        ]
      })
    ]
  })
}

/** Quiet control in the composer action row — sits with send / model. */
function ComposerActionControl() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  return jsx(Tip, {
    label: active
      ? 'End voice conversation (native Desktop voice)'
      : 'Start voice conversation — Voice HUD skins the native loop',
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
        ? jsx(PulseDot, { tone: phaseTone(phase) })
        : jsx(Codicon, { name: 'mic', size: '0.875rem' })
    })
  })
}

function StatusChip() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  const level = useValue($level)
  const label = !active
    ? 'voice'
    : phase === 'listening'
      ? `voice · ${Math.round(level * 100)}%`
      : `voice · ${phase}`

  return jsx(Tip, {
    label: 'Native voice + integrated HUD (composer). Click to toggle.',
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
      children: jsx(Badge, { variant: active ? 'default' : 'muted', children: label })
    })
  })
}

/** Optional workshop floating — deliberately secondary. */
function WorkshopPane() {
  const on = useValue($workshop)
  const active = useValue($nativeActive)
  if (!on) {
    return jsxs('div', {
      className: 'flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm',
      children: [
        jsx('p', {
          className: 'max-w-[14rem] text-(--ui-text-tertiary)',
          children:
            'Workshop view is optional. The main HUD lives in the composer — same chrome as Desktop voice.'
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
      jsx(Separator, {}),
      jsx(ComposerIntegratedHud, {}),
      !active
        ? jsx(Button, {
            type: 'button',
            className: 'mt-auto',
            onClick: () => startVoice(),
            children: 'Start native voice'
          })
        : null,
      jsx('p', {
        className: 'text-[0.625rem] leading-relaxed text-(--ui-text-quaternary)',
        children:
          'Same native conversation as the composer button. This pane is only a larger canvas — not a second voice engine.'
      })
    ]
  })
}

export default {
  id: PLUGIN_ID,
  name: 'Voice HUD',
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

    ctx.registerMany([
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
        // Not shown until user enables workshop — still registered so palette can open it.
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
          label: 'Voice: Toggle native conversation + HUD',
          keywords: ['voice', 'hud', 'mic', 'listen', 'speech', 'jarvis'],
          run: () => toggleVoice()
        }
      },
      {
        id: 'workshop-toggle',
        area: PALETTE_AREA,
        data: {
          id: 'voice-hud.workshop',
          label: 'Voice: Toggle workshop floating pane',
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
          label: 'Voice: Toggle native conversation + HUD',
          category: 'Voice',
          defaults: ['mod+shift+v'],
          run: () => toggleVoice()
        }
      }
    ])

    if (typeof ctx.onUnload === 'function') {
      ctx.onUnload(() => {
        offGw()
        stopDomObserver()
        stopMeter()
        stopSpeechSoft()
        document.getElementById(STYLE_ID)?.remove()
        setLiveAttr(false)
      })
    }
  }
}

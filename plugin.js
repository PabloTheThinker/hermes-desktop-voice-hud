/**
 * voice-hud — Iron Man–inspired live speech HUD for Hermes Desktop.
 *
 * Deep mode (default): skins the *native* composer voice conversation
 * (same loop as the AudioLines / Ctrl+B control). No second STT pipeline,
 * no double mic fight — we toggle core voice and paint the HUD from live
 * phase + gateway deltas + a film-style fiber orb.
 *
 * Surfaces:
 *   - composer.top  — HUD sits above the typing / voice dock
 *   - floating pane — optional wide card (uncloseable)
 *   - statusBar chip + palette + Mod+Shift+V
 *
 * Install: $HERMES_HOME/desktop-plugins/voice-hud/plugin.js
 * Reload: ⌘/Ctrl+K → "Reload desktop plugins"
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

/** @typedef {'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'} Phase */

const $hudOn = atom(true)
const $nativeActive = atom(false)
const $phase = atom(/** @type {Phase} */ ('idle'))
const $level = atom(0)
const $userText = atom('')
const $agentText = atom('')
const $elapsed = atom(0)
const $floating = atom(true)
const $error = atom('')

const meter = {
  stream: null,
  ctx: null,
  analyser: null,
  raf: 0,
  timer: 0,
  startedAt: 0,
  speechRec: null,
  mo: null,
  poll: 0
}

function formatTcg(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const f = Math.floor((ms % 1000) / (1000 / 24))
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(f)}`
}

function toggleNativeVoice() {
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

function startHudSession() {
  $hudOn.set(true)
  $error.set('')
  $agentText.set('')
  if (!$nativeActive.get()) {
    haptic('open')
    toggleNativeVoice()
  }
}

function stopHudSession() {
  if ($nativeActive.get()) {
    haptic('close')
    toggleNativeVoice()
  }
  $hudOn.set(false)
  stopMeter()
  stopSpeechSoft()
  $phase.set('idle')
  $level.set(0)
}

function toggleHud() {
  if ($nativeActive.get() || ($hudOn.get() && $phase.get() !== 'idle')) {
    stopHudSession()
  } else {
    startHudSession()
  }
}

// --- Soft Web Speech (interim YOU chip only; core still owns submit) ---
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
    /* Electron often lacks Web Speech — fine */
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

// --- Level meter (shared-mic best-effort; never submits audio) ---
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
    analyser.smoothingTimeConstant = 0.72
    source.connect(analyser)
    meter.ctx = ctx
    meter.analyser = analyser
    void ctx.resume()
    const data = new Uint8Array(analyser.fftSize)
    const tick = () => {
      if (!meter.analyser) return
      meter.analyser.getByteTimeDomainData(data)
      const rms = rmsFromTimeDomain(data)
      $level.set(Math.min(1, rms * 7))
      meter.raf = requestAnimationFrame(tick)
    }
    meter.raf = requestAnimationFrame(tick)
  } catch {
    // Mic exclusive to core — animate from phase only
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

// --- Detect native voice UI state via DOM (composer ConversationPill) ---
function detectNativePhase() {
  // Core paints sr-only role=status with listening / speaking / … labels
  const statuses = document.querySelectorAll('[data-slot="composer-root"] [role="status"], [data-slot="composer-dock"] [role="status"]')
  let hit = ''
  for (const el of statuses) {
    const t = (el.textContent || '').trim().toLowerCase()
    if (!t) continue
    if (t.includes('listen')) hit = 'listening'
    else if (t.includes('transcrib') || t.includes('dictat')) hit = 'transcribing'
    else if (t.includes('think')) hit = 'thinking'
    else if (t.includes('speak') || t.includes('reading')) hit = 'speaking'
    else if (t.includes('mut')) hit = 'listening'
    if (hit) break
  }

  // End / conversation pill visible ⇒ voice conversation active
  const endBtn = document.querySelector(
    '[data-slot="composer-root"] button[aria-label*="End" i], [data-slot="composer-dock"] button[aria-label*="End" i]'
  )
  const startBtn = document.querySelector(
    '[data-slot="composer-root"] button[aria-label*="Start voice" i], [data-slot="composer-dock"] button[aria-label*="voice conversation" i]'
  )
  const active = Boolean(endBtn) || (hit && hit !== 'idle')

  // Playback activity strip
  if (!hit) {
    const body = document.body?.innerText || ''
    // light fallback only near composer
  }

  // VoiceActivity strip text
  if (!hit) {
    const strips = document.querySelectorAll('[data-slot="composer-root"] [aria-live="polite"]')
    for (const el of strips) {
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
  // assistant-ui user messages — best-effort
  const nodes = document.querySelectorAll(
    '[data-role="user"], [data-message-role="user"], [data-slot*="user-message"]'
  )
  if (!nodes.length) return ''
  const last = nodes[nodes.length - 1]
  const text = (last.textContent || '').trim()
  return text.slice(0, 400)
}

function wireDomObserver() {
  if (meter.poll) return
  let lastActive = false
  meter.poll = window.setInterval(() => {
    const { active, phase } = detectNativePhase()
    const was = $nativeActive.get()
    $nativeActive.set(active)

    if (active && !was) {
      $hudOn.set(true)
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
        if (bubble && bubble.length > ($userText.get() || '').length) {
          $userText.set(bubble)
        }
      }
      if (!meter.timer && active) startElapsed()
    }

    lastActive = active
  }, 200)
}

function stopDomObserver() {
  if (meter.poll) clearInterval(meter.poll)
  meter.poll = 0
}

// --- Gateway agent chip ---
function wireGateway() {
  return host.onEvent('*', event => {
    if (!event || typeof event !== 'object') return
    const type = event.type
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
    const sid = event.session_id || payload.session_id
    const active = host.state.activeSessionId.get()
    if (sid && active && sid !== active) return

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
      // native loop returns to listening
      if ($nativeActive.get()) $phase.set('listening')
    }
  })
}

// --- Film-accurate fiber orb (Mark II workshop) ---
function FiberOrb({ size = 132 }) {
  const canvasRef = useRef(null)
  const level = useValue($level)
  const phase = useValue($phase)
  const levelRef = useRef(level)
  const phaseRef = useRef(phase)
  levelRef.current = level
  phaseRef.current = phase

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    const t0 = performance.now()
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const S = size

    canvas.width = Math.round(S * dpr)
    canvas.height = Math.round(S * dpr)
    canvas.style.width = S + 'px'
    canvas.style.height = S + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const STRANDS = 96
    const draw = now => {
      const t = (now - t0) / 1000
      const cx = S / 2
      const cy = S / 2
      const ph = phaseRef.current
      const live = ph === 'listening' || ph === 'speaking' || ph === 'transcribing'
      const base = ph === 'speaking' ? 0.55 : ph === 'listening' ? 0.4 : ph === 'thinking' ? 0.28 : 0.14
      const amp = base + levelRef.current * (ph === 'speaking' ? 0.55 : 0.95)

      ctx.clearRect(0, 0, S, S)

      // Dark well
      const well = ctx.createRadialGradient(cx, cy, 2, cx, cy, S * 0.48)
      well.addColorStop(0, 'hsla(210, 40%, 8%, 0.9)')
      well.addColorStop(0.55, 'hsla(210, 50%, 12%, 0.35)')
      well.addColorStop(1, 'hsla(210, 40%, 10%, 0)')
      ctx.fillStyle = well
      ctx.beginPath()
      ctx.arc(cx, cy, S * 0.48, 0, Math.PI * 2)
      ctx.fill()

      // Outer halo (cyan → green → magenta)
      const halo = ctx.createRadialGradient(cx, cy, S * 0.12, cx, cy, S * 0.5)
      halo.addColorStop(0, `hsla(185, 95%, 60%, ${0.22 + amp * 0.25})`)
      halo.addColorStop(0.35, `hsla(140, 90%, 55%, ${0.12 + amp * 0.15})`)
      halo.addColorStop(0.7, `hsla(50, 95%, 55%, ${0.08 + amp * 0.1})`)
      halo.addColorStop(1, `hsla(300, 85%, 60%, 0)`)
      ctx.fillStyle = halo
      ctx.beginPath()
      ctx.arc(cx, cy, S * 0.5, 0, Math.PI * 2)
      ctx.fill()

      // Tangled fiber strands — film still language
      for (let i = 0; i < STRANDS; i++) {
        const hue = (i / STRANDS) * 320 + t * 55 + (live ? levelRef.current * 40 : 0)
        const a0 = (i / STRANDS) * Math.PI * 2 + t * (0.35 + (i % 7) * 0.04)
        const r0 = S * 0.1 + (i % 11) * (S * 0.012)
        ctx.beginPath()
        const segs = 36
        for (let s = 0; s <= segs; s++) {
          const u = s / segs
          const twist = Math.sin(t * 2.8 + i * 0.35 + u * 8) * S * 0.035 * amp
          const pulse = Math.sin(t * 4.2 + i + u * 3) * S * 0.02 * amp
          const r = r0 + u * S * (0.28 + amp * 0.14) + twist + pulse
          const a = a0 + u * (1.9 + Math.sin(i) * 0.35) + Math.cos(t + i * 0.2) * 0.12 * amp
          const x = cx + Math.cos(a) * r
          const y = cy + Math.sin(a) * r * 0.94
          if (s === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = `hsla(${hue % 360}, 92%, ${58 + amp * 12}%, ${0.18 + amp * 0.42})`
        ctx.lineWidth = 0.85 + (i % 3) * 0.25
        ctx.stroke()
      }

      // Bright inner ring
      ctx.beginPath()
      ctx.arc(cx, cy, S * (0.09 + amp * 0.06), 0, Math.PI * 2)
      ctx.strokeStyle = `hsla(190, 100%, 75%, ${0.4 + amp * 0.45})`
      ctx.lineWidth = 1.6
      ctx.stroke()

      // Core spark
      ctx.beginPath()
      ctx.arc(cx, cy, 2.2 + amp * 3, 0, Math.PI * 2)
      ctx.fillStyle = `hsla(180, 100%, 90%, ${0.5 + amp * 0.5})`
      ctx.fill()

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size])

  return jsx('canvas', {
    ref: canvasRef,
    'aria-hidden': true,
    className: 'block mx-auto rounded-md'
  })
}

function SpeechChip({ label, text, tone, caps }) {
  const empty = !text
  return jsxs('div', {
    className: cn(
      'relative w-full overflow-hidden rounded-md border px-2.5 py-2',
      'bg-[color-mix(in_oklab,var(--background)_70%,transparent)]',
      'border-[color-mix(in_oklab,var(--ui-accent)_42%,var(--ui-stroke-secondary))]',
      'shadow-[inset_0_1px_0_color-mix(in_oklab,white_14%,transparent)]',
      'backdrop-blur-md'
    ),
    children: [
      jsxs('div', {
        className: 'mb-1 flex items-center justify-between gap-2',
        children: [
          jsx('span', {
            className:
              'text-[0.625rem] font-medium uppercase tracking-[0.16em] text-(--ui-text-tertiary)',
            children: label
          }),
          tone
            ? jsx(Badge, {
                variant: tone === 'live' ? 'default' : tone === 'err' ? 'destructive' : 'muted',
                children: tone === 'live' ? 'LIVE' : tone === 'err' ? 'ERR' : tone
              })
            : null
        ]
      }),
      jsx('div', {
        className: cn(
          'min-h-[1.15rem] text-[0.8125rem] leading-snug tracking-wide',
          empty ? 'text-(--ui-text-quaternary)' : 'text-foreground',
          !empty && caps && 'font-semibold uppercase'
        ),
        children: empty ? '…' : text
      })
    ]
  })
}

function RecChrome() {
  const phase = useValue($phase)
  const elapsed = useValue($elapsed)
  const level = useValue($level)
  const live = phase === 'listening'
  const bars = 10
  return jsxs('div', {
    className:
      'flex items-center justify-between gap-2 text-[0.625rem] tabular-nums text-(--ui-text-tertiary)',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx('span', {
            className: cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-semibold tracking-wider',
              live ? 'bg-destructive/15 text-destructive' : 'bg-muted text-(--ui-text-tertiary)'
            ),
            children: live ? '● REC' : phase === 'idle' ? '○ STBY' : '● ' + phase.toUpperCase()
          }),
          jsx('span', { className: 'font-mono', children: 'TCG ' + formatTcg(elapsed) })
        ]
      }),
      jsxs('div', {
        className: 'flex h-3 items-end gap-0.5',
        'aria-hidden': true,
        children: Array.from({ length: bars }, (_, i) => {
          const thresh = (i + 1) / bars
          const on = level >= thresh * 0.8
          return jsx(
            'span',
            {
              className: cn(
                'w-0.5 rounded-full transition-all duration-75',
                on
                  ? 'bg-[color-mix(in_oklab,var(--ui-accent)_90%,white)]'
                  : 'bg-(--ui-stroke-secondary)'
              ),
              style: { height: `${28 + thresh * 72}%`, opacity: on ? 1 : 0.4 }
            },
            i
          )
        })
      })
    ]
  })
}

function HudBody({ compact }) {
  const native = useValue($nativeActive)
  const phase = useValue($phase)
  const userText = useValue($userText)
  const agentText = useValue($agentText)
  const error = useValue($error)
  const hudOn = useValue($hudOn)

  const userTone =
    phase === 'listening' || phase === 'transcribing'
      ? 'live'
      : phase === 'idle'
        ? ''
        : 'live'

  const youDisplay =
    phase === 'listening' && !userText
      ? 'LISTENING…'
      : phase === 'transcribing' && !userText
        ? 'TRANSCRIBING…'
        : userText

  return jsxs('div', {
    className: cn('flex flex-col gap-2 text-sm', compact ? 'p-2' : 'p-2.5 h-full'),
    children: [
      jsxs('div', {
        className: 'flex items-start justify-between gap-2',
        children: [
          jsxs('div', {
            children: [
              jsx('div', {
                className:
                  'text-[0.6875rem] font-semibold tracking-[0.18em] text-(--ui-text-secondary)',
                children: 'VOICE HUD'
              }),
              jsx('div', {
                className: 'text-[0.625rem] text-(--ui-text-quaternary)',
                children: native
                  ? 'native voice · ' + phase
                  : hudOn
                    ? 'ready — start native voice'
                    : 'standby'
              })
            ]
          }),
          jsx(Button, {
            size: 'sm',
            type: 'button',
            variant: native ? 'destructive' : 'default',
            onClick: () => {
              haptic('tap')
              toggleHud()
            },
            children: native ? 'End' : 'Listen'
          })
        ]
      }),

      jsx(RecChrome, {}),

      jsxs('div', {
        className: cn('grid gap-2', compact ? 'grid-cols-[1fr_auto]' : 'grid-cols-1'),
        children: [
          jsxs('div', {
            className: 'flex min-w-0 flex-col gap-2',
            children: [
              jsx(SpeechChip, {
                label: 'YOU',
                text: youDisplay,
                tone: userTone,
                caps: true
              }),
              jsx(SpeechChip, {
                label: 'AGENT',
                text: agentText,
                tone: agentText ? 'live' : '',
                caps: false
              })
            ]
          }),
          jsxs('div', {
            className: cn(
              'flex flex-col items-center justify-center rounded-md border p-1.5',
              'border-[color-mix(in_oklab,var(--ui-accent)_30%,var(--ui-stroke-secondary))]',
              'bg-[color-mix(in_oklab,var(--background)_60%,transparent)]'
            ),
            children: [
              jsx(FiberOrb, { size: compact ? 100 : 132 }),
              jsx('div', {
                className:
                  'mt-0.5 text-[0.5625rem] uppercase tracking-[0.14em] text-(--ui-text-quaternary)',
                children: phase
              })
            ]
          })
        ]
      }),

      error
        ? jsx('div', {
            className:
              'rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive',
            children: error
          })
        : null,

      jsx('p', {
        className: 'text-[0.625rem] leading-relaxed text-(--ui-text-quaternary)',
        children: compact
          ? 'Skins Desktop native voice (same as the voice button / Ctrl+B). YOU = live caption · AGENT = reply stream · orb = mic/phase.'
          : 'Deep-linked to the composer voice conversation — STT, barge-in, TTS, and stop-word stay core. This HUD is the Mark II glass layer on top.'
      })
    ]
  })
}

function ComposerHud() {
  const hudOn = useValue($hudOn)
  const native = useValue($nativeActive)
  // Always reserve a slim strip when on or active so it feels attached to the dock
  if (!hudOn && !native) return null
  return jsx('div', {
    className: cn(
      'mb-1 overflow-hidden rounded-xl border',
      'border-[color-mix(in_oklab,var(--ui-accent)_28%,var(--ui-stroke-secondary))]',
      'bg-[color-mix(in_oklab,var(--background)_78%,transparent)]',
      'shadow-[0_8px_28px_color-mix(in_oklab,black_22%,transparent)]'
    ),
    children: jsx(HudBody, { compact: true })
  })
}

function FloatingHud() {
  const show = useValue($floating)
  if (!show) {
    return jsxs('div', {
      className: 'flex h-full items-center justify-center p-3 text-sm text-(--ui-text-tertiary)',
      children: [
        'Floating HUD hidden · ',
        jsx('button', {
          type: 'button',
          className: 'underline',
          onClick: () => $floating.set(true),
          children: 'show'
        })
      ]
    })
  }
  return jsx(HudBody, { compact: false })
}

function StatusChip() {
  const native = useValue($nativeActive)
  const phase = useValue($phase)
  const level = useValue($level)
  const label = !native
    ? 'voice-hud'
    : phase === 'listening'
      ? `hud · ${Math.round(level * 100)}%`
      : `hud · ${phase}`

  return jsx(Tip, {
    label:
      'Voice HUD — skins native Desktop voice conversation (composer). Click to start/end the same loop as the voice button.',
    children: jsx('button', {
      type: 'button',
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      onClick: () => {
        haptic('tap')
        toggleHud()
      },
      children: jsx(Badge, {
        variant: native ? 'default' : 'muted',
        children: label
      })
    })
  })
}

export default {
  id: PLUGIN_ID,
  name: 'Voice HUD (native voice skin)',
  defaultEnabled: true,
  register(ctx) {
    $floating.set(ctx.storage.get('floating', true))
    $hudOn.set(ctx.storage.get('hudOn', true))
    $floating.listen(v => ctx.storage.set('floating', v))
    $hudOn.listen(v => ctx.storage.set('hudOn', v))

    wireDomObserver()
    const offGw = wireGateway()

    ctx.registerMany([
      {
        id: 'composer-hud',
        area: COMPOSER_AREAS.top,
        order: 10,
        render: () => jsx(ComposerHud, {})
      },
      {
        id: 'pane',
        area: 'panes',
        title: 'voice hud',
        data: {
          placement: 'floating',
          anchor: 'top-right',
          width: '320px',
          height: '560px',
          uncloseable: true
        },
        render: () => jsx(FloatingHud, {})
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
          label: 'Voice HUD: Toggle native voice + HUD',
          keywords: ['voice', 'hud', 'jarvis', 'speech', 'stt', 'mic', 'listen', 'conversation'],
          run: () => toggleHud()
        }
      },
      {
        id: 'start',
        area: PALETTE_AREA,
        data: {
          id: 'voice-hud.start',
          label: 'Voice HUD: Start native voice',
          keywords: ['voice', 'start'],
          run: () => startHudSession()
        }
      },
      {
        id: 'stop',
        area: PALETTE_AREA,
        data: {
          id: 'voice-hud.stop',
          label: 'Voice HUD: End native voice',
          keywords: ['voice', 'stop', 'end'],
          run: () => stopHudSession()
        }
      },
      {
        id: 'toggle-bind',
        area: KEYBINDS_AREA,
        data: {
          id: 'voice-hud.toggle',
          label: 'Voice HUD: Toggle native voice + HUD',
          category: 'Voice HUD',
          defaults: ['mod+shift+v'],
          run: () => toggleHud()
        }
      }
    ])

    ctx.storage.set('_loadedAt', Date.now())
    if (typeof ctx.onUnload === 'function') {
      ctx.onUnload(() => {
        offGw()
        stopDomObserver()
        stopMeter()
        stopSpeechSoft()
      })
    }
  }
}

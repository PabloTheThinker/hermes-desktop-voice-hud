/**
 * voice-hud — Iron Man–inspired live speech HUD for Hermes Desktop.
 *
 * Floating glass chip shows what YOU are saying (live STT) + a fiber orb
 * while the mic is open; a second chip streams the agent's reply from
 * gateway message.delta events. Final user utterances submit via
 * prompt.submit on the active session.
 *
 * Install: copy this folder to $HERMES_HOME/desktop-plugins/voice-hud/
 * then ⌘/Ctrl+K → "Reload desktop plugins".
 *
 * Plain ESM, uncompiled — jsx() only. Imports: @hermes/plugin-sdk, react*.
 */
import {
  Badge,
  Button,
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
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'

const PLUGIN_ID = 'voice-hud'

/** @typedef {'idle' | 'listening' | 'transcribing' | 'submitting' | 'error'} HudPhase */

const $enabled = atom(false)
const $phase = atom(/** @type {HudPhase} */ ('idle'))
const $userText = atom('')
const $agentText = atom('')
const $level = atom(0)
const $elapsed = atom(0)
const $error = atom('')
const $autoSubmit = atom(true)
const $continuous = atom(true)
const $hudVisible = atom(true)

// Imperative session for mic / loops (not React state — avoids stale closures).
const runtime = {
  stream: null,
  recorder: null,
  chunks: [],
  audioCtx: null,
  analyser: null,
  raf: 0,
  timer: 0,
  startedAt: 0,
  heardSpeech: false,
  silenceAt: null,
  loop: false,
  busyAgent: false,
  speechRec: null,
  disposed: false
}

const SILENCE_RMS = 0.018
const SILENCE_END_MS = 1400
const MIN_SPEECH_MS = 450
const MAX_UTTERANCE_MS = 45_000
const IDLE_TIMEOUT_MS = 18_000

function desktopApi() {
  return typeof window !== 'undefined' ? window.hermesDesktop : null
}

function profileBody() {
  const profile = host.state.profile.get()
  return profile ? { profile } : {}
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  if (typeof MediaRecorder === 'undefined') return ''
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return ''
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

function rmsFromTimeDomain(data) {
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128
    sum += v * v
  }
  return Math.sqrt(sum / Math.max(1, data.length))
}

function stopTracks() {
  if (runtime.raf) {
    cancelAnimationFrame(runtime.raf)
    runtime.raf = 0
  }
  if (runtime.timer) {
    clearInterval(runtime.timer)
    runtime.timer = 0
  }
  try {
    runtime.recorder?.state === 'recording' && runtime.recorder.stop()
  } catch {
    /* ignore */
  }
  runtime.recorder = null
  runtime.stream?.getTracks().forEach(t => t.stop())
  runtime.stream = null
  try {
    runtime.audioCtx?.close()
  } catch {
    /* ignore */
  }
  runtime.audioCtx = null
  runtime.analyser = null
  if (runtime.speechRec) {
    try {
      runtime.speechRec.onresult = null
      runtime.speechRec.onerror = null
      runtime.speechRec.onend = null
      runtime.speechRec.stop()
    } catch {
      /* ignore */
    }
    runtime.speechRec = null
  }
  $level.set(0)
}

function setPhase(p) {
  $phase.set(p)
}

function startSpeechRecognitionSoft() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) return
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
    rec.onerror = () => {
      /* optional path — Hermes STT is primary */
    }
    rec.onend = () => {
      if (runtime.loop && $enabled.get() && runtime.speechRec === rec) {
        try {
          rec.start()
        } catch {
          /* ignore */
        }
      }
    }
    rec.start()
    runtime.speechRec = rec
  } catch {
    /* Web Speech unavailable in this Electron build */
  }
}

async function openMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone API unavailable')
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })
  runtime.stream = stream

  const AC = window.AudioContext || window.webkitAudioContext
  if (AC) {
    const ctx = new AC()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.75
    source.connect(analyser)
    runtime.audioCtx = ctx
    runtime.analyser = analyser
    void ctx.resume()

    const data = new Uint8Array(analyser.fftSize)
    const tick = () => {
      if (!runtime.analyser) return
      runtime.analyser.getByteTimeDomainData(data)
      const rms = rmsFromTimeDomain(data)
      const level = Math.min(1, rms * 6)
      $level.set(level)

      const now = performance.now()
      if (rms >= SILENCE_RMS) {
        runtime.heardSpeech = true
        runtime.silenceAt = null
      } else if (runtime.heardSpeech) {
        if (runtime.silenceAt == null) runtime.silenceAt = now
        else if (now - runtime.silenceAt >= SILENCE_END_MS) {
          void endUtterance('silence')
          return
        }
      } else if (now - runtime.startedAt >= IDLE_TIMEOUT_MS) {
        void endUtterance('idle')
        return
      }

      if (now - runtime.startedAt >= MAX_UTTERANCE_MS) {
        void endUtterance('max')
        return
      }

      runtime.raf = requestAnimationFrame(tick)
    }
    runtime.raf = requestAnimationFrame(tick)
  }

  runtime.chunks = []
  runtime.heardSpeech = false
  runtime.silenceAt = null
  runtime.startedAt = performance.now()
  $elapsed.set(0)
  runtime.timer = window.setInterval(() => {
    $elapsed.set(performance.now() - runtime.startedAt)
  }, 100)

  const mime = pickMime()
  const recorder = mime
    ? new MediaRecorder(stream, { mimeType: mime })
    : new MediaRecorder(stream)
  runtime.recorder = recorder
  recorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) runtime.chunks.push(e.data)
  }
  recorder.start(250)
  startSpeechRecognitionSoft()
  setPhase('listening')
  if (!$userText.get()) $userText.set('')
}

async function endUtterance(reason) {
  if (!$enabled.get() && reason !== 'stop') return
  if ($phase.get() !== 'listening') return

  const minOk = performance.now() - runtime.startedAt >= MIN_SPEECH_MS
  const heard = runtime.heardSpeech && minOk
  const recorder = runtime.recorder
  const chunks = runtime.chunks

  if (runtime.raf) {
    cancelAnimationFrame(runtime.raf)
    runtime.raf = 0
  }
  if (runtime.timer) {
    clearInterval(runtime.timer)
    runtime.timer = 0
  }

  const blob = await new Promise(resolve => {
    if (!recorder || recorder.state === 'inactive') {
      resolve(chunks.length ? new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' }) : null)
      return
    }
    recorder.onstop = () => {
      resolve(chunks.length ? new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }) : null)
    }
    try {
      recorder.stop()
    } catch {
      resolve(null)
    }
  })

  // Keep stream only if continuous; release analyser between turns to save CPU.
  try {
    runtime.audioCtx?.close()
  } catch {
    /* ignore */
  }
  runtime.audioCtx = null
  runtime.analyser = null
  runtime.recorder = null
  $level.set(0)

  if (!heard || !blob || blob.size < 256) {
    if ($enabled.get() && $continuous.get() && reason !== 'stop') {
      // Release and re-open for a clean next turn.
      runtime.stream?.getTracks().forEach(t => t.stop())
      runtime.stream = null
      try {
        await openMic()
      } catch (err) {
        fail(err)
      }
      return
    }
    stopTracks()
    setPhase('idle')
    return
  }

  setPhase('transcribing')
  $error.set('')

  try {
    const api = desktopApi()
    if (!api?.api) throw new Error('Desktop audio bridge unavailable (hermesDesktop.api)')

    const dataUrl = await blobToDataUrl(blob)
    const res = await api.api({
      path: '/api/audio/transcribe',
      method: 'POST',
      ...profileBody(),
      body: { data_url: dataUrl, mime_type: blob.type || 'audio/webm' },
      timeoutMs: Math.min(120_000, 15_000 + Math.floor(dataUrl.length / 40))
    })

    const text = String(res?.transcript || res?.text || '').trim()
    if (!text) {
      if ($enabled.get() && $continuous.get()) {
        runtime.stream?.getTracks().forEach(t => t.stop())
        runtime.stream = null
        await openMic()
        return
      }
      setPhase('idle')
      return
    }

    $userText.set(text)

    // Stop-word (simple): bare "stop" ends HUD without submitting.
    if (/^stop[.!?]?$/i.test(text)) {
      await stopHud({ notify: true, message: 'Voice HUD stopped' })
      return
    }

    if ($autoSubmit.get()) {
      await submitPrompt(text)
    } else {
      setPhase('idle')
      host.notify({ kind: 'info', message: 'Captured (auto-submit off): ' + text.slice(0, 80) })
    }

    if ($enabled.get() && $continuous.get()) {
      // Wait for agent turn to finish before re-arming mic (barge is core app).
      if (runtime.busyAgent) {
        setPhase('idle')
        return
      }
      runtime.stream?.getTracks().forEach(t => t.stop())
      runtime.stream = null
      await openMic()
    } else {
      stopTracks()
      setPhase('idle')
      $enabled.set(false)
    }
  } catch (err) {
    fail(err)
  }
}

async function submitPrompt(text) {
  const sessionId = host.state.activeSessionId.get()
  if (!sessionId) {
    throw new Error('No active chat session — open a chat first')
  }
  setPhase('submitting')
  runtime.busyAgent = true
  $agentText.set('')
  await host.request('prompt.submit', { session_id: sessionId, text })
}

function fail(err) {
  const msg = err instanceof Error ? err.message : String(err)
  $error.set(msg)
  setPhase('error')
  stopTracks()
  $enabled.set(false)
  host.notify({ kind: 'error', message: 'Voice HUD: ' + msg })
}

async function startHud() {
  if ($enabled.get()) return
  $error.set('')
  $userText.set('')
  $agentText.set('')
  $hudVisible.set(true)
  $enabled.set(true)
  runtime.loop = true
  runtime.busyAgent = false
  try {
    await openMic()
    haptic('tap')
    host.notify({ kind: 'info', message: 'Voice HUD listening — speak, pause to send' })
  } catch (err) {
    fail(err)
  }
}

async function stopHud(opts = {}) {
  runtime.loop = false
  $enabled.set(false)
  stopTracks()
  setPhase('idle')
  if (opts.notify) {
    host.notify({ kind: 'info', message: opts.message || 'Voice HUD stopped' })
  }
}

function toggleHud() {
  if ($enabled.get()) void stopHud({ notify: true })
  else void startHud()
}

// --- Gateway: agent speech chip + re-arm after turn ---
function wireGateway() {
  return host.onEvent('*', event => {
    if (!event || typeof event !== 'object') return
    const type = event.type
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
    const sid = event.session_id || payload.session_id
    const active = host.state.activeSessionId.get()
    if (sid && active && sid !== active) return

    if (type === 'message.start') {
      runtime.busyAgent = true
      $agentText.set('')
    } else if (type === 'message.delta') {
      const chunk = String(payload.text || payload.delta || '')
      if (chunk) $agentText.set(($agentText.get() + chunk).slice(-800))
    } else if (type === 'message.complete' || type === 'error') {
      runtime.busyAgent = false
      // Re-arm continuous listen after agent finishes.
      if ($enabled.get() && $continuous.get() && $phase.get() === 'idle') {
        void openMic().catch(fail)
      }
    }
  })
}

// --- UI -----------------------------------------------------------------

function FiberOrb() {
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
    let t0 = performance.now()
    const dpr = Math.max(1, window.devicePixelRatio || 1)

    const resize = () => {
      const size = 120
      canvas.width = Math.round(size * dpr)
      canvas.height = Math.round(size * dpr)
      canvas.style.width = size + 'px'
      canvas.style.height = size + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    const strands = 48
    const draw = now => {
      const t = (now - t0) / 1000
      const size = 120
      const cx = size / 2
      const cy = size / 2
      const live = phaseRef.current === 'listening'
      const amp = live ? 0.35 + levelRef.current * 0.9 : 0.22

      ctx.clearRect(0, 0, size, size)

      // Soft core glow
      const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, 52)
      g.addColorStop(0, 'hsla(190, 90%, 60%, 0.35)')
      g.addColorStop(0.45, 'hsla(140, 80%, 50%, 0.12)')
      g.addColorStop(1, 'hsla(280, 70%, 50%, 0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(cx, cy, 52, 0, Math.PI * 2)
      ctx.fill()

      for (let i = 0; i < strands; i++) {
        const hue = (i / strands) * 300 + t * 40
        const a0 = (i / strands) * Math.PI * 2 + t * (0.6 + (i % 5) * 0.05)
        const rBase = 18 + (i % 7) * 2.2
        ctx.beginPath()
        for (let s = 0; s <= 28; s++) {
          const u = s / 28
          const wobble = Math.sin(t * 3 + i + u * 6) * 6 * amp
          const r = rBase + u * 22 * amp + wobble
          const a = a0 + u * 1.7 + Math.sin(t + i) * 0.15
          const x = cx + Math.cos(a) * r
          const y = cy + Math.sin(a) * r * 0.92
          if (s === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = `hsla(${hue % 360}, 85%, 62%, ${0.25 + amp * 0.45})`
        ctx.lineWidth = 1.1
        ctx.stroke()
      }

      // Inner ring
      ctx.beginPath()
      ctx.arc(cx, cy, 14 + amp * 10, 0, Math.PI * 2)
      ctx.strokeStyle = `hsla(190, 90%, 70%, ${0.35 + amp * 0.4})`
      ctx.lineWidth = 1.5
      ctx.stroke()

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    return () => cancelAnimationFrame(raf)
  }, [])

  return jsx('canvas', {
    ref: canvasRef,
    'aria-hidden': true,
    className: 'block rounded-md'
  })
}

function SpeechChip({ label, text, tone }) {
  const empty = !text
  return jsxs('div', {
    className: cn(
      'relative w-full overflow-hidden rounded-md border px-2.5 py-2',
      'bg-[color-mix(in_oklab,var(--background)_72%,transparent)]',
      'border-[color-mix(in_oklab,var(--ui-accent)_40%,var(--ui-stroke-secondary))]',
      'shadow-[inset_0_1px_0_color-mix(in_oklab,white_12%,transparent)]',
      'backdrop-blur-md'
    ),
    children: [
      jsxs('div', {
        className: 'mb-1 flex items-center justify-between gap-2',
        children: [
          jsx('span', {
            className: 'text-[0.625rem] font-medium uppercase tracking-[0.14em] text-(--ui-text-tertiary)',
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
          'min-h-[1.25rem] text-[0.8125rem] leading-snug tracking-wide',
          empty ? 'text-(--ui-text-quaternary)' : 'text-foreground',
          !empty && label === 'YOU' && 'font-semibold uppercase'
        ),
        children: empty ? (label === 'YOU' ? '…' : '—') : text
      })
    ]
  })
}

function RecChrome() {
  const phase = useValue($phase)
  const elapsed = useValue($elapsed)
  const live = phase === 'listening'
  return jsxs('div', {
    className: 'flex items-center justify-between gap-2 text-[0.625rem] tabular-nums text-(--ui-text-tertiary)',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx('span', {
            className: cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-semibold tracking-wider',
              live
                ? 'bg-destructive/15 text-destructive'
                : 'bg-muted text-(--ui-text-tertiary)'
            ),
            children: live ? '● REC' : '○ STBY'
          }),
          jsx('span', {
            className: 'font-mono',
            children: 'TCG ' + formatTcg(elapsed)
          })
        ]
      }),
      jsx(LevelMeter, {})
    ]
  })
}

function LevelMeter() {
  const level = useValue($level)
  const bars = 8
  return jsxs('div', {
    className: 'flex h-3 items-end gap-0.5',
    'aria-hidden': true,
    children: Array.from({ length: bars }, (_, i) => {
      const thresh = (i + 1) / bars
      const on = level >= thresh * 0.85
      return jsx('span', {
        className: cn(
          'w-0.5 rounded-full transition-all duration-75',
          on ? 'bg-[color-mix(in_oklab,var(--ui-accent)_90%,white)]' : 'bg-(--ui-stroke-secondary)'
        ),
        style: { height: `${30 + thresh * 70}%`, opacity: on ? 1 : 0.45 }
      }, i)
    })
  })
}

function HudPane() {
  const enabled = useValue($enabled)
  const phase = useValue($phase)
  const userText = useValue($userText)
  const agentText = useValue($agentText)
  const error = useValue($error)
  const autoSubmit = useValue($autoSubmit)
  const continuous = useValue($continuous)
  const visible = useValue($hudVisible)

  if (!visible && !enabled) {
    return jsxs('div', {
      className: 'flex h-full flex-col items-center justify-center gap-2 p-3 text-center text-sm',
      children: [
        jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'Voice HUD hidden' }),
        jsx(Button, {
          size: 'sm',
          variant: 'secondary',
          type: 'button',
          onClick: () => $hudVisible.set(true),
          children: 'Show'
        })
      ]
    })
  }

  const userTone =
    phase === 'listening' || phase === 'transcribing' || phase === 'submitting'
      ? 'live'
      : phase === 'error'
        ? 'err'
        : ''

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2.5 p-2.5 text-sm',
    children: [
      jsxs('div', {
        className: 'flex items-start justify-between gap-2',
        children: [
          jsxs('div', {
            children: [
              jsx('div', {
                className: 'text-[0.6875rem] font-semibold tracking-[0.16em] text-(--ui-text-secondary)',
                children: 'VOICE HUD'
              }),
              jsx('div', {
                className: 'text-[0.625rem] text-(--ui-text-quaternary)',
                children: phase === 'idle' ? 'standby' : phase
              })
            ]
          }),
          jsx(Button, {
            size: 'sm',
            type: 'button',
            variant: enabled ? 'destructive' : 'default',
            onClick: () => {
              haptic('tap')
              toggleHud()
            },
            children: enabled ? 'Stop' : 'Listen'
          })
        ]
      }),

      jsx(RecChrome, {}),

      jsx(SpeechChip, {
        label: 'YOU',
        text:
          phase === 'transcribing' && !userText
            ? 'TRANSCRIBING…'
            : phase === 'listening' && !userText
              ? 'LISTENING…'
              : userText,
        tone: userTone
      }),

      jsxs('div', {
        className: cn(
          'flex flex-col items-center justify-center rounded-md border p-2',
          'border-[color-mix(in_oklab,var(--ui-accent)_28%,var(--ui-stroke-secondary))]',
          'bg-[color-mix(in_oklab,var(--background)_65%,transparent)]'
        ),
        children: [
          jsx(FiberOrb, {}),
          jsx('div', {
            className: 'mt-1 text-[0.625rem] uppercase tracking-[0.12em] text-(--ui-text-quaternary)',
            children: enabled ? 'mic open' : 'mic closed'
          })
        ]
      }),

      jsx(SpeechChip, {
        label: 'AGENT',
        text: agentText,
        tone: agentText ? 'live' : ''
      }),

      error
        ? jsx('div', {
            className: 'rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive',
            children: error
          })
        : null,

      jsxs('div', {
        className: 'mt-auto flex flex-wrap items-center gap-2 border-t border-(--ui-stroke-secondary) pt-2',
        children: [
          jsx(Toggle, {
            label: 'Auto-send',
            on: autoSubmit,
            onClick: () => {
              $autoSubmit.set(!$autoSubmit.get())
              haptic('selection')
            }
          }),
          jsx(Toggle, {
            label: 'Continuous',
            on: continuous,
            onClick: () => {
              $continuous.set(!$continuous.get())
              haptic('selection')
            }
          })
        ]
      }),

      jsx('p', {
        className: 'text-[0.625rem] leading-relaxed text-(--ui-text-quaternary)',
        children:
          'Speak → pause ~1.4s → Hermes STT → active chat. Say “stop” alone to end. Uses Desktop /api/audio/transcribe + prompt.submit.'
      })
    ]
  })
}

function Toggle({ label, on, onClick }) {
  return jsx('button', {
    type: 'button',
    onClick,
    className: cn(
      'rounded-full border px-2 py-0.5 text-[0.625rem] transition-colors',
      on
        ? 'border-[color-mix(in_oklab,var(--ui-accent)_50%,transparent)] text-foreground'
        : 'border-(--ui-stroke-secondary) text-(--ui-text-tertiary)'
    ),
    children: label + (on ? ' · on' : ' · off')
  })
}

function StatusChip() {
  const enabled = useValue($enabled)
  const phase = useValue($phase)
  const level = useValue($level)

  const label = !enabled
    ? 'voice-hud'
    : phase === 'listening'
      ? `hud · ${Math.round(level * 100)}%`
      : `hud · ${phase}`

  return jsx(Tip, {
    label: 'Voice HUD — Iron Man–style live STT chip + fiber orb. Click to toggle listening.',
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
        variant: enabled ? (phase === 'error' ? 'destructive' : 'default') : 'muted',
        children: label
      })
    })
  })
}

export default {
  id: PLUGIN_ID,
  name: 'Voice HUD (live speech)',
  defaultEnabled: true,
  register(ctx) {
    // Persist prefs
    $autoSubmit.set(ctx.storage.get('autoSubmit', true))
    $continuous.set(ctx.storage.get('continuous', true))
    $hudVisible.set(ctx.storage.get('hudVisible', true))
    $autoSubmit.listen(v => ctx.storage.set('autoSubmit', v))
    $continuous.listen(v => ctx.storage.set('continuous', v))
    $hudVisible.listen(v => ctx.storage.set('hudVisible', v))

    const offEvents = wireGateway()

    ctx.registerMany([
      {
        id: 'pane',
        area: 'panes',
        title: 'voice hud',
        data: {
          placement: 'floating',
          anchor: 'top-right',
          width: '300px',
          height: '520px'
        },
        render: () => jsx(HudPane, {})
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
          label: 'Voice HUD: Toggle listening',
          keywords: ['voice', 'hud', 'jarvis', 'speech', 'stt', 'mic', 'listen'],
          run: () => toggleHud()
        }
      },
      {
        id: 'start',
        area: PALETTE_AREA,
        data: {
          id: 'voice-hud.start',
          label: 'Voice HUD: Start listening',
          keywords: ['voice', 'start', 'listen'],
          run: () => void startHud()
        }
      },
      {
        id: 'stop',
        area: PALETTE_AREA,
        data: {
          id: 'voice-hud.stop',
          label: 'Voice HUD: Stop',
          keywords: ['voice', 'stop'],
          run: () => void stopHud({ notify: true })
        }
      },
      {
        id: 'toggle-bind',
        area: KEYBINDS_AREA,
        data: {
          id: 'voice-hud.toggle',
          label: 'Voice HUD: Toggle listening',
          category: 'Voice HUD',
          defaults: ['mod+shift+v'],
          run: () => toggleHud()
        }
      }
    ])

    // Best-effort cleanup if the plugin host supports dispose hooks later.
    ctx.storage.set('_loadedAt', Date.now())
    if (typeof ctx.onUnload === 'function') {
      ctx.onUnload(() => {
        offEvents()
        void stopHud()
      })
    }
  }
}

/**
 * voice-hud — in-composer live layer for Hermes Desktop native voice.
 *
 * Sits in the same dock as the typing bar (screenshot space):
 *  - composer.top  → real-time transcript strip + image chips + mini orb
 *  - NO extra mic in actions (core already has voice / dictate / wake)
 *  - middleware    → voice text turns pick up staged composer images
 *
 * Choice: defaultEnabled false → Settings ▸ Plugins.
 * Hard-stop: End / stop-word / pill gone → captureWanted=false, no restart.
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

/** @typedef {'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'} Phase */

const $nativeActive = atom(false)
const $phase = atom(/** @type {Phase} */ ('idle'))
const $level = atom(0)
/** Live interim + final caption (real-time). */
const $liveText = atom('')
const $agentText = atom('')
const $elapsed = atom(0)
const $error = atom('')
/** @type {import('nanostores').WritableAtom<ScrapedAtt[]>} */
const $images = atom(/** @type {ScrapedAtt[]} */ ([]))

/**
 * @typedef {{ id: string, kind: 'image'|'file', label: string, previewUrl?: string, path?: string, detail?: string, refText?: string }} ScrapedAtt
 */

let captureWanted = false
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

function formatElapsed(sec) {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// --- Core voice --------------------------------------------------------------

function dispatchVoiceToggle() {
  try {
    window.dispatchEvent(new CustomEvent(VOICE_TOGGLE_EVENT, { detail: { target: 'main' } }))
    return true
  } catch (err) {
    $error.set(err instanceof Error ? err.message : String(err))
    return false
  }
}

function clickCoreEnd() {
  if (typeof document === 'undefined') return false
  const btn =
    document.querySelector(
      '[data-slot="composer-root"] button[aria-label*="End" i], [data-slot="composer-dock"] button[aria-label*="End" i]'
    ) || document.querySelector('button[aria-label*="End conversation" i]')
  if (btn?.click) {
    btn.click()
    return true
  }
  return false
}

function clickCoreStart() {
  if (typeof document === 'undefined') return false
  // Prefer the waveform / start-voice control already in the composer actions
  const btn =
    document.querySelector(
      '[data-slot="composer-root"] button[aria-label*="Start voice" i], [data-slot="composer-dock"] button[aria-label*="Start voice" i]'
    ) ||
    document.querySelector(
      '[data-slot="composer-root"] button[aria-label*="voice conversation" i]'
    )
  if (btn?.click) {
    btn.click()
    return true
  }
  return false
}

function stopSpeechSoft() {
  const rec = meter.speechRec
  meter.speechRec = null
  if (!rec) return
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
  meter.stream?.getTracks().forEach(t => {
    try {
      t.stop()
    } catch {
      /* ignore */
    }
  })
  meter.stream = null
  $level.set(0)
}

function stopAllCapture() {
  captureWanted = false
  stopSpeechSoft()
  stopMeter()
  $phase.set('idle')
  $elapsed.set(0)
  $level.set(0)
  setLiveAttr(false)
}

function endVoice() {
  haptic('close')
  sessionWanted = false
  stopAllCapture()
  $error.set('')
  const clicked = clickCoreEnd()
  if (!clicked && $nativeActive.get()) dispatchVoiceToggle()
  if (meter.endWatch) clearTimeout(meter.endWatch)
  meter.endWatch = window.setTimeout(() => {
    meter.endWatch = 0
    if (detectNative().active) {
      if (!clickCoreEnd()) dispatchVoiceToggle()
    }
    stopAllCapture()
    $nativeActive.set(false)
  }, 320)
}

function startVoice() {
  $error.set('')
  if ($nativeActive.get()) return
  haptic('open')
  sessionWanted = true
  $liveText.set('')
  $agentText.set('')
  if (!clickCoreStart()) dispatchVoiceToggle()
}

function toggleVoice() {
  if ($nativeActive.get() || sessionWanted) endVoice()
  else startVoice()
}

// --- Real-time transcription (Web Speech interim) ----------------------------

function startSpeechSoft() {
  if (!captureWanted) return
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR || meter.speechRec) return
  try {
    const rec = new SR()
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.lang = navigator.language || 'en-US'
    let committed = ''
    rec.onresult = event => {
      if (!captureWanted) return
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        const t = (r[0]?.transcript || '').trim()
        if (!t) continue
        if (r.isFinal) {
          committed = (committed + ' ' + t).trim()
        } else {
          interim += (interim ? ' ' : '') + t
        }
      }
      const live = (committed + (interim ? (committed ? ' ' : '') + interim : '')).trim()
      if (live) $liveText.set(live)
    }
    rec.onerror = e => {
      // no-speech / aborted are normal
      if (e?.error === 'not-allowed') {
        $error.set('Microphone blocked for live captions')
      }
    }
    rec.onend = () => {
      if (
        meter.speechRec === rec &&
        captureWanted &&
        $nativeActive.get() &&
        ($phase.get() === 'listening' || $phase.get() === 'idle')
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
    /* no Web Speech — core STT still works; live line fills from last bubble */
  }
}

function rms(data) {
  let s = 0
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128
    s += v * v
  }
  return Math.sqrt(s / Math.max(1, data.length))
}

async function startMeter() {
  if (!captureWanted || meter.analyser || !navigator.mediaDevices?.getUserMedia) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
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
    const src = ctx.createMediaStreamSource(stream)
    const an = ctx.createAnalyser()
    an.fftSize = 512
    an.smoothingTimeConstant = 0.72
    src.connect(an)
    meter.ctx = ctx
    meter.analyser = an
    void ctx.resume()
    const data = new Uint8Array(an.fftSize)
    const tick = () => {
      if (!meter.analyser || !captureWanted) return
      meter.analyser.getByteTimeDomainData(data)
      $level.set(Math.min(1, rms(data) * 7.5))
      meter.raf = requestAnimationFrame(tick)
    }
    meter.raf = requestAnimationFrame(tick)
  } catch {
    /* core holds mic */
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
  startElapsed()
  void startMeter()
  startSpeechSoft()
}

// --- Images in composer ------------------------------------------------------

function scrapeComposerAttachments() {
  if (typeof document === 'undefined') return /** @type {ScrapedAtt[]} */ ([])
  const root = document.querySelector('[data-slot="composer-attachments"]')
  if (!root) return []
  /** @type {ScrapedAtt[]} */
  const out = []
  const buttons = root.querySelectorAll('button[type="button"]')
  let i = 0
  for (const btn of buttons) {
    // skip remove (×) buttons
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase()
    if (aria.startsWith('remove') || btn.className.includes('absolute')) continue
    const img = btn.querySelector('img')
    const labelEl = btn.querySelector('span.truncate, span.block.truncate')
    const label =
      (labelEl?.textContent || '').trim() ||
      img?.getAttribute('alt') ||
      (aria.replace(/^preview\s*/i, '').trim() || `attachment-${i}`)
    const tip = btn.closest('[data-state]') || btn.parentElement
    const title = btn.getAttribute('title') || tip?.getAttribute('title') || ''
    const previewUrl = img?.src || undefined
    const pathGuess = title && !title.startsWith('data:') ? title : undefined
    if (img || aria.includes('image') || previewUrl) {
      out.push({
        id: `hud-img-${i}`,
        kind: 'image',
        label,
        previewUrl,
        path: pathGuess,
        detail: pathGuess,
        refText: pathGuess ? `@image:${pathGuess}` : undefined
      })
      i++
    } else if (label) {
      out.push({
        id: `hud-file-${i}`,
        kind: 'file',
        label,
        path: pathGuess,
        detail: pathGuess,
        refText: pathGuess ? `@file:${pathGuess}` : undefined
      })
      i++
    }
  }
  return out
}

/** Middleware: bare voice text picks up staged composer images. */
function attachmentMiddleware(draft) {
  try {
    if (draft.attachments && draft.attachments.length > 0) return draft
    const scraped = scrapeComposerAttachments().filter(a => a.kind === 'image')
    if (!scraped.length) return draft
    // Prefer structured attachments for the submit pipeline
    return {
      text: draft.text,
      attachments: scraped.map(a => ({
        id: a.id,
        kind: 'image',
        label: a.label,
        previewUrl: a.previewUrl,
        path: a.path,
        detail: a.detail,
        refText: a.refText
      }))
    }
  } catch {
    return draft
  }
}

// --- Native detect -----------------------------------------------------------

function detectNative() {
  if (typeof document === 'undefined') {
    return { active: false, phase: /** @type {Phase} */ ('idle') }
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
  const endBtn = document.querySelector(
    '[data-slot="composer-root"] button[aria-label*="End" i], [data-slot="composer-dock"] button[aria-label*="End" i]'
  )
  const active = Boolean(endBtn) || Boolean(hit)
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
      if (t.includes('speaking') || t.includes('preparing') || t.includes('reading')) {
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
  return (nodes[nodes.length - 1].textContent || '').trim().slice(0, 500)
}

function wireDomObserver() {
  if (meter.poll) return
  meter.poll = window.setInterval(() => {
    const { active, phase } = detectNative()
    const was = $nativeActive.get()
    $images.set(scrapeComposerAttachments())

    if (active && !was) {
      $nativeActive.set(true)
      sessionWanted = true
      $liveText.set('')
      $agentText.set('')
      armCapture()
      setLiveAttr(true)
    } else if (!active && was) {
      $nativeActive.set(false)
      sessionWanted = false
      stopAllCapture()
    } else {
      $nativeActive.set(active)
    }

    if (active) {
      $phase.set(phase)
      setLiveAttr(true)
      if (!captureWanted && sessionWanted) armCapture()
      // After core commits a turn, fill caption from bubble if soft STT empty
      if (phase === 'thinking' || phase === 'speaking' || phase === 'transcribing') {
        const bubble = scrapeLastUserBubble()
        if (bubble && bubble.length > ($liveText.get() || '').length) $liveText.set(bubble)
      }
    } else if (captureWanted || sessionWanted) {
      sessionWanted = false
      stopAllCapture()
      $nativeActive.set(false)
    }
  }, 140)
}

function stopDomObserver() {
  if (meter.poll) clearInterval(meter.poll)
  meter.poll = 0
  if (meter.endWatch) clearTimeout(meter.endWatch)
  meter.endWatch = 0
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
  // Hide stock VoiceActivity while our live strip is up — one clean bar
  el.textContent = `
[data-voice-hud-live="1"] [data-slot="composer-root"] [aria-live="polite"][role="status"].h-8:not([data-voice-hud]),
[data-voice-hud-live="1"] [data-slot="composer-surface"] [aria-live="polite"][role="status"].h-8:not([data-voice-hud]) {
  display: none !important;
}
`
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
  ensureCss()
}

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
        $agentText.set(($agentText.get() + chunk).slice(-700))
        if ($nativeActive.get()) $phase.set('speaking')
      }
    } else if (type === 'message.complete') {
      if ($nativeActive.get()) {
        $phase.set('listening')
        // next utterance — clear live line for fresh real-time caption
        $liveText.set('')
      }
    }
  })
}

// --- Mini orb (inline, composer-scale) ---------------------------------------

function MiniOrb({ size = 36 }) {
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
    const N = 48
    const draw = now => {
      const t = (now - t0) / 1000
      const cx = size / 2
      const cy = size / 2
      const ph = pr.current
      const lv = lr.current
      const base = ph === 'speaking' ? 0.55 : ph === 'listening' ? 0.4 : 0.18
      const amp = base + lv * 0.9
      ctx.clearRect(0, 0, size, size)
      const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, size * 0.48)
      g.addColorStop(0, `hsla(200,100%,60%,${0.5 + amp * 0.3})`)
      g.addColorStop(0.45, `hsla(140,90%,50%,${0.25 + amp * 0.2})`)
      g.addColorStop(1, 'hsla(50,90%,55%,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(cx, cy, size * 0.48, 0, Math.PI * 2)
      ctx.fill()
      for (let i = 0; i < N; i++) {
        const hue = 190 + (i / N) * 160 + t * 50
        const a0 = (i / N) * Math.PI * 2 + t * 0.8
        ctx.beginPath()
        for (let s = 0; s <= 16; s++) {
          const u = s / 16
          const r =
            size * (0.12 + u * 0.22) +
            Math.sin(t * 4 + i + u * 6) * size * 0.04 * amp
          const a = a0 + u * 1.8
          const x = cx + Math.cos(a) * r
          const y = cy + Math.sin(a) * r
          if (s === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = `hsla(${hue % 360},90%,60%,${0.25 + amp * 0.4})`
        ctx.lineWidth = 0.8
        ctx.stroke()
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size])

  return jsx('canvas', {
    ref,
    'aria-hidden': true,
    className: 'block shrink-0 rounded-full'
  })
}

function LevelDots({ level, active }) {
  const n = 5
  return jsxs('span', {
    'aria-hidden': true,
    className: 'flex h-3 items-end gap-0.5',
    children: Array.from({ length: n }, (_, i) => {
      const thresh = (i + 1) / n
      const on = active && level >= thresh * 0.55
      return jsx(
        'span',
        {
          className: cn(
            'w-0.5 rounded-full transition-all duration-75',
            on ? 'bg-primary' : 'bg-muted-foreground/30'
          ),
          style: { height: `${30 + thresh * 70}%` }
        },
        i
      )
    })
  })
}

function phaseLabel(p) {
  if (p === 'listening') return 'Listening'
  if (p === 'transcribing') return 'Transcribing'
  if (p === 'thinking') return 'Thinking'
  if (p === 'speaking') return 'Speaking'
  return 'Voice'
}

/**
 * In-composer live strip — same width language as the dock, flat, no Tip spam.
 * Only mounts while native voice is live.
 */
function LiveStrip() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  const level = useValue($level)
  const live = useValue($liveText)
  const agent = useValue($agentText)
  const elapsed = useValue($elapsed)
  const images = useValue($images)
  const error = useValue($error)

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

  const listening = phase === 'listening' || phase === 'transcribing'
  const caption =
    live ||
    (phase === 'listening'
      ? 'Listening…'
      : phase === 'transcribing'
        ? 'Transcribing…'
        : phase === 'thinking'
          ? 'Thinking…'
          : phase === 'speaking'
            ? agent || 'Speaking…'
            : '…')

  const imgAtt = images.filter(a => a.kind === 'image' && a.previewUrl)

  return jsxs('div', {
    className: cn(
      // Match composer surface — sits inside the same padded dock
      'mb-0.5 flex flex-col gap-1.5 rounded-xl border px-2.5 py-2',
      'border-border/55 bg-muted/40 text-muted-foreground',
      'shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] backdrop-blur-sm',
      phase === 'speaking' && 'border-primary/25 bg-primary/8'
    ),
    role: 'status',
    'aria-live': 'polite',
    'data-voice-hud': '1',
    children: [
      // Row 1: status + levels + end — height ~ stock controls
      jsxs('div', {
        className: 'flex h-7 items-center gap-2',
        children: [
          jsx('span', {
            className: cn(
              'size-1.5 shrink-0 rounded-full',
              listening ? 'animate-pulse bg-green-400' : phase === 'speaking' ? 'bg-primary' : 'bg-muted-foreground/50'
            )
          }),
          jsx('span', {
            className: 'shrink-0 text-[0.7rem] font-medium text-foreground/85',
            children: phaseLabel(phase)
          }),
          jsx('span', {
            className: 'font-mono text-[0.65rem] text-muted-foreground/80',
            children: formatElapsed(elapsed / 1000)
          }),
          jsx(LevelDots, { level, active: listening || phase === 'speaking' }),
          imgAtt.length
            ? jsx(Badge, {
                variant: 'muted',
                children: `${imgAtt.length} img`
              })
            : null,
          jsx('div', { className: 'ml-auto' }),
          jsx(MiniOrb, { size: 28 }),
          jsx(Button, {
            type: 'button',
            size: 'sm',
            variant: 'ghost',
            className: 'h-6 rounded-full px-2 text-[0.68rem]',
            onClick: () => endVoice(),
            children: 'End'
          })
        ]
      }),

      // Image thumbs — same row family as AttachmentList
      imgAtt.length
        ? jsxs('div', {
            className: 'flex max-w-full flex-wrap items-center gap-1.5',
            children: [
              ...imgAtt.slice(0, 6).map(a =>
                jsx(
                  'span',
                  {
                    className:
                      'relative size-9 overflow-hidden rounded-lg border border-border/55 bg-muted/35',
                    title: a.label,
                    children: jsx('img', {
                      src: a.previewUrl,
                      alt: a.label,
                      className: 'size-full object-cover',
                      draggable: false
                    })
                  },
                  a.id
                )
              ),
              jsx('span', {
                className: 'text-[0.62rem] text-muted-foreground/70',
                children: 'with voice turn'
              })
            ]
          })
        : null,

      // Real-time transcript — primary line in the dock
      jsxs('div', {
        className: cn(
          'min-h-[1.5rem] rounded-lg border px-2.5 py-1.5',
          'border-(--ui-stroke-tertiary) bg-background/40'
        ),
        children: [
          jsx('div', {
            className:
              'mb-0.5 text-[0.55rem] font-medium uppercase tracking-[0.14em] text-(--ui-text-quaternary)',
            children: listening ? 'Live' : phase === 'speaking' ? 'Hermes' : 'You'
          }),
          jsx('div', {
            className: cn(
              'text-[0.8125rem] leading-snug text-foreground',
              listening && live && 'font-medium',
              !live && 'text-muted-foreground/70'
            ),
            children:
              phase === 'speaking' && agent
                ? agent
                : caption
          })
        ]
      })
    ]
  })
}

/** Quiet status chip only — no second mic in the composer action row. */
function StatusChip() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  return jsx(Tip, {
    label: active
      ? 'Voice HUD live — click to end (stops listening)'
      : 'Voice HUD — skins Desktop voice. Use the composer voice control, or click here to start.',
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
      // Voice turns can include images already staged in the composer (+)
      {
        id: 'attach-mw',
        area: COMPOSER_AREAS.middleware,
        order: 40,
        data: {
          handler: attachmentMiddleware
        }
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
          label: 'Voice HUD: Toggle native conversation',
          keywords: ['voice', 'hud', 'mic', 'listen'],
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
      stopAllCapture()
      sessionWanted = false
      document.getElementById(STYLE_ID)?.remove()
      setLiveAttr(false)
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

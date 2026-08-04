/**
 * voice-hud — continuous real-time skin over Hermes Desktop native voice.
 *
 * Mirrors core loop (use-voice-conversation):
 *   listening → (silence ~1.25s) → transcribing → thinking → speaking → listening…
 *   barge-in during speak; stop-word / End kills session.
 *
 * HUD job: feel like ONE surface with the composer dock —
 *   • Live words while you talk (Web Speech interim, whole session)
 *   • Multi-turn YOU / HERMES ribbon (not one-shot)
 *   • Instant phase chrome (no “dead wait” between turns)
 *   • Hard stop on End; opt-in plugin (defaultEnabled: false)
 *
 * Only @hermes/plugin-sdk + react* imports (no bare nanostores / comments).
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
const MAX_TURNS = 8

/** @typedef {'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'} Phase */
/** @typedef {{ id: string, role: 'you' | 'hermes', text: string, live?: boolean }} Turn */
/** @typedef {{ id: string, kind: 'image'|'file', label: string, previewUrl?: string, path?: string, detail?: string, refText?: string }} ScrapedAtt */

const $nativeActive = atom(false)
const $phase = atom(/** @type {Phase} */ ('idle'))
const $level = atom(0)
/** Current utterance being spoken (real-time interim). */
const $liveYou = atom('')
const $liveAgent = atom('')
/** Settled turns this voice session. */
const $turns = atom(/** @type {Turn[]} */ ([]))
const $elapsed = atom(0)
const $error = atom('')
const $images = atom(/** @type {ScrapedAtt[]} */ ([]))
/** True while core is between silence and next listen — keep ribbon warm. */
const $busyGap = atom(false)

let captureWanted = false
let sessionWanted = false
/** Committed finals within the current open YOU utterance. */
let utteranceCommitted = ''
let lastPhase = /** @type {Phase} */ ('idle')
let turnSeq = 0

const meter = {
  stream: null,
  ctx: null,
  analyser: null,
  raf: 0,
  timer: 0,
  startedAt: 0,
  speechRec: null,
  poll: 0,
  endWatch: 0,
  speechPaused: false
}

function formatElapsed(sec) {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function pushTurn(role, text, live) {
  const t = (text || '').trim()
  if (!t && !live) return
  const list = $turns.get().slice()
  const last = list[list.length - 1]
  if (last && last.role === role && last.live) {
    last.text = t
    last.live = Boolean(live)
    $turns.set(list.slice(-MAX_TURNS))
    return
  }
  if (last && last.role === role && !last.live && !live && last.text === t) return
  list.push({ id: `t-${++turnSeq}`, role, text: t, live: Boolean(live) })
  $turns.set(list.slice(-MAX_TURNS))
}

function settleLiveYou() {
  const text = ($liveYou.get() || utteranceCommitted || '').trim()
  if (text) {
    // finalize any live you turn
    const list = $turns.get().slice()
    const last = list[list.length - 1]
    if (last && last.role === 'you' && last.live) {
      last.text = text
      last.live = false
      $turns.set(list)
    } else {
      pushTurn('you', text, false)
    }
  }
  utteranceCommitted = ''
  $liveYou.set('')
}

function settleLiveAgent() {
  const text = ($liveAgent.get() || '').trim()
  if (text) {
    const list = $turns.get().slice()
    const last = list[list.length - 1]
    if (last && last.role === 'hermes' && last.live) {
      last.text = text
      last.live = false
      $turns.set(list)
    } else {
      pushTurn('hermes', text, false)
    }
  }
  $liveAgent.set('')
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
  const btn =
    document.querySelector(
      '[data-slot="composer-root"] button[aria-label*="Start voice" i], [data-slot="composer-dock"] button[aria-label*="Start voice" i]'
    ) ||
    document.querySelector('[data-slot="composer-root"] button[aria-label*="voice conversation" i]')
  if (btn?.click) {
    btn.click()
    return true
  }
  return false
}

function stopSpeechSoft() {
  const rec = meter.speechRec
  meter.speechRec = null
  meter.speechPaused = false
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
  $busyGap.set(false)
  setLiveAttr(false)
}

function endVoice() {
  haptic('close')
  sessionWanted = false
  settleLiveYou()
  settleLiveAgent()
  stopAllCapture()
  $error.set('')
  if (!clickCoreEnd() && $nativeActive.get()) dispatchVoiceToggle()
  if (meter.endWatch) clearTimeout(meter.endWatch)
  meter.endWatch = window.setTimeout(() => {
    meter.endWatch = 0
    if (detectNative().active) {
      if (!clickCoreEnd()) dispatchVoiceToggle()
    }
    stopAllCapture()
    $nativeActive.set(false)
  }, 300)
}

function startVoice() {
  $error.set('')
  if ($nativeActive.get()) return
  haptic('open')
  sessionWanted = true
  $turns.set([])
  $liveYou.set('')
  $liveAgent.set('')
  utteranceCommitted = ''
  if (!clickCoreStart()) dispatchVoiceToggle()
}

function toggleVoice() {
  if ($nativeActive.get() || sessionWanted) endVoice()
  else startVoice()
}

// --- Continuous real-time captions (session-long Web Speech) -----------------

function setLiveYouText(text) {
  $liveYou.set(text)
  pushTurn('you', text || '…', true)
}

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
    utteranceCommitted = ''

    rec.onresult = event => {
      if (!captureWanted || meter.speechPaused) return
      // Only caption user speech while listening / early transcribe
      const ph = $phase.get()
      if (ph === 'speaking' || ph === 'thinking') return

      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        const t = (r[0]?.transcript || '').trim()
        if (!t) continue
        if (r.isFinal) {
          utteranceCommitted = (utteranceCommitted + ' ' + t).trim()
        } else {
          interim = interim ? interim + ' ' + t : t
        }
      }
      const live = (utteranceCommitted + (interim ? (utteranceCommitted ? ' ' : '') + interim : '')).trim()
      if (live) setLiveYouText(live)
    }

    rec.onerror = e => {
      if (e?.error === 'not-allowed') $error.set('Mic blocked for live captions')
      // no-speech / aborted: normal in continuous mode
    }

    rec.onend = () => {
      // Continuous conversation: always re-arm while session wants capture
      if (meter.speechRec === rec && captureWanted && !meter.speechPaused) {
        try {
          rec.start()
        } catch {
          /* ignore */
        }
      }
    }

    rec.start()
    meter.speechRec = rec
    meter.speechPaused = false
  } catch {
    /* Electron may lack Web Speech — phase/bubble path still works */
  }
}

/** Pause captions while agent TTS plays (avoid echo into YOU line). */
function pauseSpeechSoft(pause) {
  meter.speechPaused = pause
  const rec = meter.speechRec
  if (!rec) return
  if (pause) {
    try {
      rec.stop()
    } catch {
      /* ignore */
    }
  } else if (captureWanted) {
    try {
      rec.start()
    } catch {
      /* ignore */
    }
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
    an.smoothingTimeConstant = 0.65
    src.connect(an)
    meter.ctx = ctx
    meter.analyser = an
    void ctx.resume()
    const data = new Uint8Array(an.fftSize)
    const tick = () => {
      if (!meter.analyser || !captureWanted) return
      meter.analyser.getByteTimeDomainData(data)
      $level.set(Math.min(1, rms(data) * 8))
      meter.raf = requestAnimationFrame(tick)
    }
    meter.raf = requestAnimationFrame(tick)
  } catch {
    /* core often holds exclusive mic — orb uses phase animation */
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

// --- Phase transitions (mirror core continuous loop) -------------------------

function onPhaseChange(prev, next) {
  if (prev === next) return

  // listening → transcribing: you finished a take; lock the live line
  if (next === 'transcribing' || (prev === 'listening' && next === 'thinking')) {
    settleLiveYou()
    $busyGap.set(true)
  }

  // thinking: waiting on model — keep ribbon, show gap state
  if (next === 'thinking') {
    $busyGap.set(true)
    pauseSpeechSoft(true)
  }

  // speaking: agent voice — stream agent line, pause YOU captions
  if (next === 'speaking') {
    $busyGap.set(false)
    pauseSpeechSoft(true)
  }

  // back to listening: continuous re-arm — ready for next utterance immediately
  if (next === 'listening') {
    $busyGap.set(false)
    settleLiveAgent()
    utteranceCommitted = ''
    // don't wipe history; only clear current live you for fresh take
    if (!$liveYou.get()) {
      // show empty live slot so UI says "your turn"
      pushTurn('you', '', true)
    }
    pauseSpeechSoft(false)
  }

  if (next === 'idle' && $nativeActive.get()) {
    // brief idle between settleAfterSpeech and re-listen — keep warm
    $busyGap.set(true)
  }

  lastPhase = next
}

// --- Attachments -------------------------------------------------------------

function scrapeComposerAttachments() {
  if (typeof document === 'undefined') return []
  const root = document.querySelector('[data-slot="composer-attachments"]')
  if (!root) return []
  /** @type {ScrapedAtt[]} */
  const out = []
  let i = 0
  for (const btn of root.querySelectorAll('button[type="button"]')) {
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase()
    if (aria.startsWith('remove')) continue
    const img = btn.querySelector('img')
    const labelEl = btn.querySelector('span.block.truncate, span.truncate')
    const label =
      (labelEl?.textContent || '').trim() ||
      img?.getAttribute('alt') ||
      aria.replace(/^preview\s*/i, '').trim() ||
      `attachment-${i}`
    const title = btn.getAttribute('title') || ''
    const previewUrl = img?.src || undefined
    const pathGuess = title && !title.startsWith('data:') ? title : undefined
    if (img || previewUrl || aria.includes('image')) {
      out.push({
        id: `hud-img-${i++}`,
        kind: 'image',
        label,
        previewUrl,
        path: pathGuess,
        detail: pathGuess,
        refText: pathGuess ? `@image:${pathGuess}` : undefined
      })
    }
  }
  return out
}

function attachmentMiddleware(draft) {
  try {
    if (draft.attachments?.length) return draft
    const scraped = scrapeComposerAttachments().filter(a => a.kind === 'image')
    if (!scraped.length) return draft
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
  // Conversation pill visible but status empty → treat as listening (continuous re-arm idle)
  if (active && !hit) hit = $busyGap.get() ? 'thinking' : 'listening'
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
  // Faster poll = snappier continuous feel (core VAD is ~rAF)
  meter.poll = window.setInterval(() => {
    const { active, phase } = detectNative()
    const was = $nativeActive.get()
    $images.set(scrapeComposerAttachments())

    if (active && !was) {
      $nativeActive.set(true)
      sessionWanted = true
      $turns.set([])
      $liveYou.set('')
      $liveAgent.set('')
      utteranceCommitted = ''
      lastPhase = 'idle'
      armCapture()
      setLiveAttr(true)
      onPhaseChange('idle', phase)
      $phase.set(phase)
    } else if (!active && was) {
      settleLiveYou()
      settleLiveAgent()
      $nativeActive.set(false)
      sessionWanted = false
      stopAllCapture()
    } else {
      $nativeActive.set(active)
    }

    if (active) {
      const prev = $phase.get()
      if (phase !== prev) {
        onPhaseChange(prev, phase)
        $phase.set(phase)
      }
      setLiveAttr(true)
      if (!captureWanted && sessionWanted) armCapture()

      // Fallback caption from committed user bubble if soft STT empty
      if (
        (phase === 'transcribing' || phase === 'thinking' || phase === 'speaking') &&
        !$liveYou.get()
      ) {
        const bubble = scrapeLastUserBubble()
        if (bubble) {
          const list = $turns.get()
          const has = list.some(t => t.role === 'you' && !t.live && t.text === bubble)
          if (!has) pushTurn('you', bubble, false)
        }
      }
    } else if (captureWanted || sessionWanted) {
      sessionWanted = false
      stopAllCapture()
      $nativeActive.set(false)
    }
  }, 90)
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
      $liveAgent.set('')
      if ($nativeActive.get()) {
        const prev = $phase.get()
        onPhaseChange(prev, 'thinking')
        $phase.set('thinking')
      }
    } else if (type === 'message.delta') {
      const chunk = String(payload.text || payload.delta || '')
      if (chunk) {
        const next = ($liveAgent.get() + chunk).slice(-900)
        $liveAgent.set(next)
        pushTurn('hermes', next, true)
        if ($nativeActive.get() && $phase.get() !== 'speaking') {
          onPhaseChange($phase.get(), 'speaking')
          $phase.set('speaking')
        }
      }
    } else if (type === 'message.complete') {
      settleLiveAgent()
      // Core will re-open mic (pendingStart → listening). Stay continuous.
      if ($nativeActive.get()) {
        onPhaseChange($phase.get(), 'listening')
        $phase.set('listening')
      }
    }
  })
}

// --- Mini orb ----------------------------------------------------------------

function MiniOrb({ size = 32 }) {
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
    const N = 40
    const draw = now => {
      const t = (now - t0) / 1000
      const cx = size / 2
      const cy = size / 2
      const ph = pr.current
      const lv = lr.current
      const base =
        ph === 'speaking' ? 0.55 : ph === 'listening' ? 0.42 : ph === 'transcribing' ? 0.35 : 0.2
      const amp = base + lv * 0.85
      ctx.clearRect(0, 0, size, size)
      const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, size * 0.48)
      g.addColorStop(0, `hsla(200,100%,60%,${0.45 + amp * 0.35})`)
      g.addColorStop(0.5, `hsla(140,90%,50%,${0.22 + amp * 0.2})`)
      g.addColorStop(1, 'hsla(50,90%,55%,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(cx, cy, size * 0.48, 0, Math.PI * 2)
      ctx.fill()
      for (let i = 0; i < N; i++) {
        const hue = 190 + (i / N) * 160 + t * 55
        const a0 = (i / N) * Math.PI * 2 + t * 0.9
        ctx.beginPath()
        for (let s = 0; s <= 14; s++) {
          const u = s / 14
          const r =
            size * (0.1 + u * 0.24) + Math.sin(t * 4.2 + i + u * 6) * size * 0.045 * amp
          const a = a0 + u * 1.7
          const x = cx + Math.cos(a) * r
          const y = cy + Math.sin(a) * r
          if (s === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = `hsla(${hue % 360},90%,60%,${0.22 + amp * 0.45})`
        ctx.lineWidth = 0.75
        ctx.stroke()
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size])

  return jsx('canvas', { ref, 'aria-hidden': true, className: 'block shrink-0' })
}

function LevelDots({ level, active }) {
  return jsxs('span', {
    'aria-hidden': true,
    className: 'flex h-3 items-end gap-0.5',
    children: [0.2, 0.4, 0.65, 0.85, 1].map((thresh, i) =>
      jsx(
        'span',
        {
          className: cn(
            'w-0.5 rounded-full transition-all duration-75',
            active && level >= thresh * 0.5 ? 'bg-primary' : 'bg-muted-foreground/25'
          ),
          style: { height: `${28 + thresh * 72}%` }
        },
        i
      )
    )
  })
}

function phaseLabel(p, busyGap) {
  if (p === 'listening') return 'Listening'
  if (p === 'transcribing') return 'Got it…'
  if (p === 'thinking') return 'Thinking'
  if (p === 'speaking') return 'Speaking'
  if (busyGap) return 'Next…'
  return 'Voice'
}

function phaseHint(p) {
  if (p === 'listening') return 'Speak anytime — continuous'
  if (p === 'transcribing') return 'Sending your words'
  if (p === 'thinking') return 'Still in conversation'
  if (p === 'speaking') return 'Talk to barge in'
  return ''
}

// --- Continuous conversation strip -------------------------------------------

function LiveStrip() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  const level = useValue($level)
  const turns = useValue($turns)
  const liveYou = useValue($liveYou)
  const liveAgent = useValue($liveAgent)
  const elapsed = useValue($elapsed)
  const images = useValue($images)
  const error = useValue($error)
  const busyGap = useValue($busyGap)

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
  const imgAtt = images.filter(a => a.kind === 'image' && a.previewUrl)

  // Build display rows: settled turns + current live
  const rows = turns.filter(t => t.text || t.live)

  return jsxs('div', {
    className: cn(
      'mb-0.5 flex flex-col gap-1.5 rounded-xl border px-2.5 py-2',
      'border-border/55 bg-muted/40 text-muted-foreground',
      'shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] backdrop-blur-sm',
      phase === 'speaking' && 'border-primary/25 bg-primary/8',
      listening && 'border-border/60'
    ),
    role: 'status',
    'aria-live': 'polite',
    'data-voice-hud': '1',
    children: [
      // Status row — always present during session (continuous)
      jsxs('div', {
        className: 'flex h-7 items-center gap-2',
        children: [
          jsx('span', {
            className: cn(
              'size-1.5 shrink-0 rounded-full',
              listening
                ? 'animate-pulse bg-green-400'
                : phase === 'speaking'
                  ? 'bg-primary animate-pulse'
                  : phase === 'transcribing' || phase === 'thinking'
                    ? 'bg-amber-400'
                    : 'bg-muted-foreground/50'
            )
          }),
          jsx('span', {
            className: 'shrink-0 text-[0.7rem] font-medium text-foreground/90',
            children: phaseLabel(phase, busyGap)
          }),
          jsx('span', {
            className: 'hidden font-mono text-[0.62rem] text-muted-foreground/75 sm:inline',
            children: formatElapsed(elapsed / 1000)
          }),
          jsx(LevelDots, {
            level,
            active: listening || phase === 'speaking'
          }),
          jsx('span', {
            className: 'min-w-0 flex-1 truncate text-[0.62rem] text-muted-foreground/65',
            children: phaseHint(phase)
          }),
          imgAtt.length
            ? jsx(Badge, { variant: 'muted', children: `${imgAtt.length} img` })
            : null,
          jsx(MiniOrb, { size: 28 }),
          jsx(Button, {
            type: 'button',
            size: 'sm',
            variant: 'ghost',
            className: 'h-6 shrink-0 rounded-full px-2 text-[0.68rem]',
            onClick: () => endVoice(),
            children: 'End'
          })
        ]
      }),

      imgAtt.length
        ? jsxs('div', {
            className: 'flex flex-wrap items-center gap-1.5',
            children: imgAtt.slice(0, 5).map(a =>
              jsx(
                'span',
                {
                  className:
                    'size-8 overflow-hidden rounded-md border border-border/50 bg-muted/30',
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
            )
          })
        : null,

      // Continuous turn ribbon
      jsxs('div', {
        className: 'flex max-h-[9.5rem] flex-col gap-1 overflow-y-auto',
        children: [
          rows.length === 0 && listening
            ? jsx('div', {
                className:
                  'rounded-lg border border-dashed border-border/50 bg-background/30 px-2.5 py-2 text-[0.8rem] text-muted-foreground/70',
                children: 'Listening — words appear here as you speak…'
              })
            : null,
          ...rows.map(t =>
            jsxs(
              'div',
              {
                className: cn(
                  'rounded-lg border px-2.5 py-1.5',
                  t.role === 'you'
                    ? 'border-(--ui-stroke-tertiary) bg-background/45'
                    : 'border-primary/20 bg-primary/5'
                ),
                children: [
                  jsxs('div', {
                    className:
                      'mb-0.5 flex items-center gap-1.5 text-[0.55rem] font-medium uppercase tracking-[0.12em] text-(--ui-text-quaternary)',
                    children: [
                      t.role === 'you' ? 'You' : 'Hermes',
                      t.live
                        ? jsx('span', {
                            className: 'normal-case tracking-normal text-primary',
                            children: ' · live'
                          })
                        : null
                    ]
                  }),
                  jsx('div', {
                    className: cn(
                      'text-[0.8rem] leading-snug text-foreground',
                      t.live && t.role === 'you' && 'font-medium',
                      !t.text && 'text-muted-foreground/60'
                    ),
                    children: t.text || (t.live ? '…' : '')
                  })
                ]
              },
              t.id
            )
          ),
          // Ensure live agent visible even if turns lagged
          phase === 'speaking' && liveAgent && !rows.some(r => r.role === 'hermes' && r.live)
            ? jsxs('div', {
                className: 'rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-1.5',
                children: [
                  jsx('div', {
                    className:
                      'mb-0.5 text-[0.55rem] font-medium uppercase tracking-[0.12em] text-(--ui-text-quaternary)',
                    children: 'Hermes · live'
                  }),
                  jsx('div', {
                    className: 'text-[0.8rem] leading-snug text-foreground',
                    children: liveAgent
                  })
                ]
              })
            : null
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
      ? 'Continuous voice HUD — click End / here to stop listening'
      : 'Voice HUD (continuous). Uses Desktop native voice. Enable in Settings → Plugins.',
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
        id: 'attach-mw',
        area: COMPOSER_AREAS.middleware,
        order: 40,
        data: { handler: attachmentMiddleware }
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
          label: 'Voice HUD: Toggle continuous native voice',
          keywords: ['voice', 'hud', 'continuous', 'listen', 'realtime'],
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
          label: 'Voice HUD: Toggle continuous native voice',
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

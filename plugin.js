/**
 * voice-hud — surgical skin over Hermes Desktop native voice conversation.
 *
 * Desktop loop (source of truth — do not reimplement):
 *   voiceConversationActive
 *     → startListening (exclusive mic, VAD silenceMs 1250)
 *     → handleTurn → STT → onSubmit → thinking → speak → settleAfterSpeech
 *     → pendingStart → startListening again…
 *   onFatalError / mic failure → setVoiceConversationActive(false)  // kills loop
 *
 * NEVER open getUserMedia / SpeechRecognition / MediaRecorder here.
 * A second capture holds the device → startListening fails after turn 1 →
 * onFatalError ends the whole conversation. That was the “stops after first
 * message” bug.
 *
 * This plugin only:
 *   • detects ConversationPill (End button) as session-active
 *   • mirrors phase from core sr-only status + loader
 *   • scrapes real level from ConversationIndicator bar heights
 *   • streams agent text via host.onEvent message.*
 *   • shows YOU turns from committed user bubbles
 *   • End/start via core End button / hermes:composer-voice-toggle
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
const MAX_TURNS = 12
/** Require N consecutive misses of End pill before treating session as dead (React gaps). */
const END_MISS_TOLERANCE = 4

/** @typedef {'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'} Phase */
/** @typedef {{ id: string, role: 'you' | 'hermes', text: string, live?: boolean }} Turn */
/** @typedef {{ id: string, label: string, previewUrl: string }} ImgChip */

const $nativeActive = atom(false)
const $phase = atom(/** @type {Phase} */ ('idle'))
const $level = atom(0)
const $turns = atom(/** @type {Turn[]} */ ([]))
const $liveAgent = atom('')
const $elapsed = atom(0)
const $error = atom('')
const $images = atom(/** @type {ImgChip[]} */ ([]))

let turnSeq = 0
let lastUserBubble = ''
let pollTimer = 0
let endWatch = 0
let elapsedTimer = 0
let startedAt = 0
let endMisses = 0

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

function finalizeRole(role) {
  const list = $turns.get().slice()
  const last = list[list.length - 1]
  if (last && last.role === role && last.live) {
    last.live = false
    if (!String(last.text || '').trim()) list.pop()
    $turns.set(list)
  }
}

// --- Core voice bus (toggle / End only) --------------------------------------

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
      '[data-slot="composer-root"] button[aria-label*="End" i], [data-slot="composer-dock"] button[aria-label*="End" i]'
    ) || document.querySelector('button[aria-label*="End conversation" i]')
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
  if (btn && typeof btn.click === 'function') {
    btn.click()
    return true
  }
  return false
}

function clickCoreStart() {
  const btn = findStartButton()
  if (btn && typeof btn.click === 'function') {
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
  $phase.set('idle')
  $level.set(0)
  $elapsed.set(0)
  $liveAgent.set('')
  lastUserBubble = ''
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

/** User-initiated end only. Never auto-fire except this path. */
function endVoice() {
  haptic('close')
  finalizeRole('you')
  finalizeRole('hermes')
  $error.set('')
  // IMPORTANT: never dispatchVoiceToggle when End is already gone — toggle
  // would START a new conversation and look like an End loop.
  const hadPill = Boolean(findEndButton())
  if (hadPill) {
    clickCoreEnd()
  }
  // Immediate local teardown so chip/strip don't stay "live" and re-fire End.
  $nativeActive.set(false)
  resetSessionUi()
  if (endWatch) clearTimeout(endWatch)
  endWatch = window.setTimeout(() => {
    endWatch = 0
    // Only re-click core End if pill is STILL up (React lag). Never toggle.
    if (findEndButton()) {
      clickCoreEnd()
    }
  }, 250)
}

function startVoice() {
  $error.set('')
  if ($nativeActive.get() || findEndButton()) return
  haptic('open')
  $turns.set([])
  $liveAgent.set('')
  lastUserBubble = ''
  if (!clickCoreStart()) dispatchVoiceToggle()
}

function toggleVoice() {
  // End only when a real ConversationPill is present; debounce-active alone
  // must not call endVoice → blind toggle → restart loop.
  if (findEndButton()) endVoice()
  else if ($nativeActive.get()) {
    $nativeActive.set(false)
    resetSessionUi()
  } else startVoice()
}

// --- Observe core (no capture devices) ---------------------------------------

/**
 * Scrape mic level from ConversationIndicator bars inside the End control.
 * Core formula: height% = (0.3 + min(0.7, level * weight)) * 100 while listening.
 * Center bar weight = 1 → level ≈ (h/100 - 0.3) / 0.7
 */
function scrapeCoreLevel(endBtn) {
  if (!endBtn) return null
  const bars = endBtn.querySelectorAll('span.w-0\\.5, span[class*="w-0.5"]')
  if (!bars.length) return null
  // Middle bar is weight 1
  const mid = bars[Math.floor(bars.length / 2)] || bars[0]
  const h = parseFloat(/** @type {HTMLElement} */ (mid).style?.height || '')
  if (!Number.isFinite(h) || h <= 0) return null
  const level = (h / 100 - 0.3) / 0.7
  return Math.max(0, Math.min(1, level))
}

function scrapePhaseFromDom(endBtn) {
  // Loader in End button = speaking
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

  // End pill present, no label yet → continuous re-arm gap (status idle → listening)
  if (!hit) hit = 'listening'
  return /** @type {Phase} */ (hit)
}

function detectNative() {
  if (typeof document === 'undefined') {
    return { active: false, phase: /** @type {Phase} */ ('idle'), level: 0 }
  }

  const endBtn = findEndButton()
  let active = Boolean(endBtn)

  // Debounce: End can vanish for a frame during control re-render — do not
  // tear down the HUD or think the conversation died.
  if (!active) {
    endMisses += 1
    if (endMisses < END_MISS_TOLERANCE && $nativeActive.get()) {
      active = true
    }
  } else {
    endMisses = 0
  }

  if (!active) {
    return { active: false, phase: /** @type {Phase} */ ('idle'), level: 0 }
  }

  const phase = scrapePhaseFromDom(endBtn)
  const coreLevel = scrapeCoreLevel(endBtn)
  const level =
    coreLevel != null
      ? coreLevel
      : phase === 'listening'
        ? 0.25
        : phase === 'speaking'
          ? 0.45
          : phase === 'transcribing'
            ? 0.2
            : 0.12

  return { active: true, phase, level }
}

function scrapeLastUserBubble() {
  const nodes = document.querySelectorAll(
    '[data-role="user"], [data-message-role="user"], [data-slot*="user-message"]'
  )
  if (!nodes.length) return ''
  return (nodes[nodes.length - 1].textContent || '').trim().slice(0, 500)
}

function scrapeImages() {
  if (typeof document === 'undefined') return []
  const root = document.querySelector('[data-slot="composer-attachments"]')
  if (!root) return []
  /** @type {ImgChip[]} */
  const out = []
  let i = 0
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') || ''
    if (!src) continue
    out.push({
      id: `img-${i++}`,
      label: img.getAttribute('alt') || 'image',
      previewUrl: src
    })
  }
  return out
}

function ingestUserBubble() {
  const bubble = scrapeLastUserBubble()
  if (!bubble || bubble === lastUserBubble) return
  lastUserBubble = bubble
  const list = $turns.get().slice()
  const lastYou = [...list].reverse().find(t => t.role === 'you')
  if (lastYou && (lastYou.live || lastYou.text.length <= bubble.length)) {
    lastYou.text = bubble
    lastYou.live = false
    $turns.set(list)
  } else if (!list.some(t => t.role === 'you' && t.text === bubble)) {
    pushTurn('you', bubble, false)
  }
}

function wireDomObserver() {
  if (pollTimer) return
  pollTimer = window.setInterval(() => {
    const { active, phase, level } = detectNative()
    const was = $nativeActive.get()
    $images.set(scrapeImages())
    $level.set(level)

    if (active && !was) {
      $nativeActive.set(true)
      $error.set('')
      startElapsed()
      setLiveAttr(true)
      $phase.set(phase)
      // Ready line for continuous listen
      pushTurn('you', '', true)
    } else if (!active && was) {
      // Core ended conversation — follow only, never call End ourselves here
      $nativeActive.set(false)
      finalizeRole('you')
      finalizeRole('hermes')
      resetSessionUi()
    } else {
      $nativeActive.set(active)
    }

    if (!active) return

    const prev = $phase.get()
    if (phase !== prev) {
      if (phase === 'listening' && (prev === 'speaking' || prev === 'thinking' || prev === 'transcribing')) {
        finalizeRole('hermes')
        $liveAgent.set('')
        // New listen cycle — open fresh YOU slot
        const list = $turns.get()
        const last = list[list.length - 1]
        if (!last || last.role !== 'you' || !last.live) pushTurn('you', '', true)
      }
      if (prev === 'listening' && phase !== 'listening') {
        // Leaving listen — user take finished; bubble may arrive shortly
      }
      $phase.set(phase)
    }

    setLiveAttr(true)
    ingestUserBubble()
  }, 80)
}

function stopDomObserver() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = 0
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
  // Hide only stock VoiceActivity h-8 strip — keep ConversationPill status
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
    // Only paint while ConversationPill is up (or briefly debounced)
    if (!$nativeActive.get() && !findEndButton()) return

    const type = event.type
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
    const sid = event.session_id || payload.session_id
    const activeSid = host.state.activeSessionId.get()
    if (sid && activeSid && sid !== activeSid) return

    if (type === 'message.start') {
      $liveAgent.set('')
      finalizeRole('you')
      ingestUserBubble()
      $phase.set('thinking')
    } else if (type === 'message.delta') {
      const chunk = String(payload.text || payload.delta || '')
      if (!chunk) return
      const next = ($liveAgent.get() + chunk).slice(-900)
      $liveAgent.set(next)
      pushTurn('hermes', next, true)
      $phase.set('speaking')
    } else if (type === 'message.complete') {
      finalizeRole('hermes')
      $liveAgent.set('')
      // Core settles → idle → startListening. Reflect listening when pill still up.
      if (findEndButton() || $nativeActive.get()) {
        $phase.set('listening')
        pushTurn('you', '', true)
      }
    }
  })
}

// --- UI ----------------------------------------------------------------------

function MiniOrb({ size = 28 }) {
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
    const N = 32
    const draw = now => {
      const t = (now - t0) / 1000
      const cx = size / 2
      const cy = size / 2
      const ph = pr.current
      const lv = lr.current
      const base =
        ph === 'speaking' ? 0.5 : ph === 'listening' ? 0.38 : ph === 'transcribing' ? 0.28 : 0.16
      const amp = base + lv * 0.55
      ctx.clearRect(0, 0, size, size)
      const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, size * 0.48)
      g.addColorStop(0, `hsla(200,100%,58%,${0.35 + amp * 0.35})`)
      g.addColorStop(0.55, `hsla(145,90%,48%,${0.18 + amp * 0.18})`)
      g.addColorStop(1, 'hsla(48,90%,55%,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(cx, cy, size * 0.48, 0, Math.PI * 2)
      ctx.fill()
      for (let i = 0; i < N; i++) {
        const hue = 188 + (i / N) * 150 + t * 48
        const a0 = (i / N) * Math.PI * 2 + t * 0.8
        ctx.beginPath()
        for (let s = 0; s <= 12; s++) {
          const u = s / 12
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

function phaseHint(p) {
  if (p === 'listening') return 'Speak again anytime'
  if (p === 'transcribing') return 'Desktop STT'
  if (p === 'thinking') return 'Conversation stays live'
  if (p === 'speaking') return 'Barge in anytime'
  return ''
}

function LiveStrip() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  const turns = useValue($turns)
  const liveAgent = useValue($liveAgent)
  const elapsed = useValue($elapsed)
  const images = useValue($images)
  const error = useValue($error)
  const level = useValue($level)

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
  const rows = turns.filter(t => t.text || t.live)

  return jsxs('div', {
    className: cn(
      // Match composer dock chrome — one surface with the typing bar
      'mb-0.5 flex flex-col gap-1.5 rounded-xl border px-2.5 py-2',
      'border-border/50 bg-muted/35 text-muted-foreground',
      'shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] backdrop-blur-sm',
      phase === 'speaking' && 'border-primary/20 bg-primary/6',
      listening && 'border-border/55'
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
                  : phase === 'transcribing' || phase === 'thinking'
                    ? 'bg-amber-400'
                    : 'bg-muted-foreground/45'
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
                    'w-0.5 rounded-full transition-[height,opacity] duration-75',
                    level >= th * 0.45 ? 'bg-primary opacity-90' : 'bg-muted-foreground/25'
                  ),
                  style: { height: `${26 + th * 74}%` }
                },
                i
              )
            )
          }),
          jsx('span', {
            className: 'min-w-0 flex-1 truncate text-[0.62rem] text-muted-foreground/60',
            children: phaseHint(phase)
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

      images.length
        ? jsxs('div', {
            className: 'flex flex-wrap items-center gap-1.5',
            children: [
              ...images.slice(0, 5).map(a =>
                jsx(
                  'span',
                  {
                    className:
                      'size-7 overflow-hidden rounded-md border border-border/50 bg-muted/30',
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
                className: 'text-[0.6rem] text-muted-foreground/60',
                children: 'in composer'
              })
            ]
          })
        : null,

      jsxs('div', {
        className: 'flex max-h-[9.5rem] flex-col gap-1 overflow-y-auto',
        children: [
          rows.length === 0
            ? jsx('div', {
                className:
                  'rounded-lg border border-dashed border-border/45 bg-background/25 px-2.5 py-1.5 text-[0.78rem] text-muted-foreground/65',
                children: 'Listening with Desktop… pause to send, then speak again.'
              })
            : null,
          ...rows.map(t =>
            jsxs(
              'div',
              {
                className: cn(
                  'rounded-lg border px-2.5 py-1.5',
                  t.role === 'you'
                    ? 'border-(--ui-stroke-tertiary) bg-background/40'
                    : 'border-primary/15 bg-primary/5'
                ),
                children: [
                  jsxs('div', {
                    className:
                      'mb-0.5 flex items-center gap-1 text-[0.55rem] font-medium uppercase tracking-[0.12em] text-(--ui-text-quaternary)',
                    children: [
                      t.role === 'you' ? 'You' : 'Hermes',
                      t.live
                        ? jsx('span', {
                            className: 'normal-case tracking-normal text-primary/90',
                            children: t.role === 'you' ? '· ready' : '· live'
                          })
                        : null
                    ]
                  }),
                  jsx('div', {
                    className: cn(
                      'text-[0.8rem] leading-snug text-foreground',
                      !t.text && 'text-muted-foreground/55'
                    ),
                    children:
                      t.text ||
                      (t.live && t.role === 'you' ? '…' : t.live ? '…' : '')
                  })
                ]
              },
              t.id
            )
          ),
          phase === 'speaking' &&
          liveAgent &&
          !rows.some(r => r.role === 'hermes' && r.live)
            ? jsxs('div', {
                className: 'rounded-lg border border-primary/15 bg-primary/5 px-2.5 py-1.5',
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
      ? 'Native voice session live — click to End'
      : 'Voice HUD (skin only, no second mic). Settings → Plugins to enable.',
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

    // NO composer.middleware — incomplete image attachment injects can keep
    // busy=true and block startListening after turn 1.

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
          keywords: ['voice', 'hud', 'continuous', 'listen'],
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

/**
 * voice-hud — skin over Hermes Desktop *native* voice (dictation + conversation).
 *
 * Does NOT run Web Speech / getUserMedia / MediaRecorder.
 * Captions + levels come from Desktop's voice bus:
 *   window CustomEvent "hermes:voice-bus"
 * published by use-voice-conversation / use-voice-recorder using the same
 * Whisper STT path as dictation (progressive chunk STT + final).
 *
 * End/Stop never matches HUD controls (no open/close loop).
 * No chat-history replay — one caption line only.
 *
 * Requires Desktop build that includes lib/voice-bus.ts.
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
const VOICE_BUS_EVENT = 'hermes:voice-bus'
const STYLE_ID = 'voice-hud-css'
const END_MISS_TOLERANCE = 5
const CORE_END_RE = /end voice conversation/i

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

let pollTimer = 0
let endWatch = 0
let elapsedTimer = 0
let startedAt = 0
let endMisses = 0
let ending = false
/** @type {null | ((e: Event) => void)} */
let busListener = null

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
  $caption.set('')
  $captionPartial.set(false)
  $agentLine.set('')
  $mode.set('off')
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

// --- Native voice bus (Desktop Whisper / same as dictation) ------------------

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
    $caption.set(d.caption.trim())
    $captionPartial.set(Boolean(d.partial))
  }

  if (active && !$nativeActive.get()) {
    $nativeActive.set(true)
    $error.set('')
    startElapsed()
    setLiveAttr(true)
  }

  if (!active && $nativeActive.get() && !findCoreEndButton()) {
    // Bus says off and core pill gone
    $nativeActive.set(false)
    resetSessionUi()
    return
  }

  if (active) {
    $nativeActive.set(true)
    setLiveAttr(true)
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
    if (phase === 'listening' || phase === 'recording') {
      // keep caption growing from partials; clear only on fresh listen with empty caption
      if (d.caption === '' || d.caption === undefined) {
        /* leave existing partials */
      }
    }
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

// Fallback DOM detect if older Desktop without bus (session active only)
function findCoreEndFallback() {
  return findCoreEndButton()
}

function wireDomFallback() {
  if (pollTimer) return
  pollTimer = window.setInterval(() => {
    if (ending) return
    // Prefer bus; DOM only keeps session alive / detects End
    const endBtn = findCoreEndFallback()
    if (endBtn) {
      endMisses = 0
      if (!$nativeActive.get()) {
        $nativeActive.set(true)
        startElapsed()
        setLiveAttr(true)
        if (!$busOk.get()) {
          $phase.set('listening')
          $error.set('')
        }
      }
      // scrape level bars if bus not sending levels
      if (!$busOk.get()) {
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
      if (endMisses >= END_MISS_TOLERANCE && $mode.get() !== 'dictation') {
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
      $phase.set('thinking')
    } else if (type === 'message.delta') {
      const chunk = String(payload.text || payload.delta || '')
      if (!chunk) return
      $agentLine.set(($agentLine.get() + chunk).slice(-280))
      $phase.set('speaking')
    } else if (type === 'message.complete') {
      $agentLine.set('')
      if (findCoreEndButton() || $nativeActive.get()) {
        $phase.set('listening')
        $caption.set('')
        $captionPartial.set(false)
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
      const base = ph === 'listening' ? 0.42 : ph === 'speaking' ? 0.5 : 0.22
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
  if (p === 'recording') return 'Dictating'
  if (p === 'transcribing') return 'Got it'
  if (p === 'thinking') return 'Thinking'
  if (p === 'speaking') return 'Speaking'
  return 'Voice'
}

function LiveStrip() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  const caption = useValue($caption)
  const captionPartial = useValue($captionPartial)
  const agentLine = useValue($agentLine)
  const elapsed = useValue($elapsed)
  const error = useValue($error)
  const level = useValue($level)
  const busOk = useValue($busOk)
  const mode = useValue($mode)

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
  const showAgent = phase === 'speaking' && agentLine

  let mainLabel = 'YOU'
  let mainText = ''
  let mainLive = false

  if (listening) {
    mainLabel = 'YOU'
    if (caption) {
      mainText = caption
      mainLive = captionPartial || true
    } else if (!busOk) {
      mainText = 'Listening… (reload Desktop for native live captions)'
      mainLive = true
    } else {
      mainText = 'Listening…'
      mainLive = true
    }
  } else if (phase === 'transcribing' || phase === 'thinking') {
    mainLabel = 'YOU'
    mainText = caption || '…'
    mainLive = false
  } else if (showAgent) {
    mainLabel = 'HERMES'
    mainText = agentLine
    mainLive = true
  } else {
    mainText = caption || phaseLabel(phase)
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
            children: busOk
              ? mode === 'dictation'
                ? 'Native dictate STT'
                : 'Native voice STT'
              : 'Waiting for Desktop voice bus'
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
                    children: captionPartial ? 'live' : 'live'
                  })
                : null
            ]
          }),
          jsx('div', {
            className: cn(
              'text-[0.9rem] leading-snug text-foreground',
              caption && 'font-medium',
              listening && !caption && 'text-muted-foreground/70'
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
      ? 'Native Desktop voice captions — Stop ends session'
      : 'Voice HUD skins Desktop dictation/conversation STT. Settings → Plugins.',
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
          label: 'Voice HUD: Toggle native voice',
          keywords: ['voice', 'hud', 'dictation', 'caption'],
          run: () => toggleVoice()
        }
      },
      {
        id: 'end',
        area: PALETTE_AREA,
        data: {
          id: 'voice-hud.end',
          label: 'Voice HUD: Stop',
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
      unwireVoiceBus()
      stopDomFallback()
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

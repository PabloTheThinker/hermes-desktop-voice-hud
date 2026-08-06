/**
 * voice-hud — ChatGPT Live–style voice stage over Hermes Desktop native voice.
 *
 * Target UX (OpenAI Live / GPT-Live product shots):
 *  • Clean light full-session stage over the conversation
 *  • Soft blue–white luminous sphere (not fiber/torus clutter)
 *  • Concentric ripple rings reacting to mic level / phase
 *  • Minimal top "Live" chrome + End
 *  • Ephemeral words only — no chat replay panel
 *
 * Native stack only: hermes:voice-bus (Desktop Whisper). No second mic.
 * Enabled by default (Live stage). Imports: @hermes/plugin-sdk + react* only.
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
const END_MISS_TOLERANCE = 12
const CORE_END_RE = /end voice conversation/i
/** How long ephemeral words stay fully visible before fade. */
const WORD_HOLD_MS = 4500
/** Fade duration (CSS matches). */
const WORD_FADE_MS = 1200
/** Keep session overlay up while bus/core says active. */
const SESSION_HOLD_MS = 2500

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
/** Ephemeral overlay text (fades). */
const $ghostText = atom('')
const $ghostRole = atom(/** @type {'you' | 'agent' | ''} */ (''))
/** 0–1 visual opacity for ghost text. */
const $ghostOpacity = atom(0)

let pollTimer = 0
let endWatch = 0
let elapsedTimer = 0
let fadeTimer = 0
let fadeRaf = 0
let startedAt = 0
let endMisses = 0
let ending = false
/** @type {null | ((e: Event) => void)} */
let busListener = null
let lastGhostKey = ''

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

function clearFadeTimers() {
  if (fadeTimer) {
    clearTimeout(fadeTimer)
    fadeTimer = 0
  }
  if (fadeRaf) {
    cancelAnimationFrame(fadeRaf)
    fadeRaf = 0
  }
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
  clearFadeTimers()
}

function clearGhost() {
  clearFadeTimers()
  $ghostText.set('')
  $ghostRole.set('')
  $ghostOpacity.set(0)
  lastGhostKey = ''
}

/**
 * Show ephemeral words then fade them away (ChatGPT/Grok orb pattern:
 * speech is felt in the orb; text is temporary).
 * @param {string} text
 * @param {'you' | 'agent'} role
 * @param {{ sticky?: boolean }} [opts] sticky = hold while still streaming (partials)
 */
function showGhostWords(text, role, opts = {}) {
  const t = (text || '').trim()
  if (!t) return
  const key = `${role}:${t}`
  const sticky = Boolean(opts.sticky)

  // Same partial growing — refresh opacity without restarting full hold if already visible
  if (key === lastGhostKey && sticky) {
    $ghostOpacity.set(1)
    scheduleFade(true)
    return
  }
  if (key === lastGhostKey && !sticky && $ghostOpacity.get() > 0.5) {
    scheduleFade(false)
    return
  }

  lastGhostKey = key
  $ghostText.set(t)
  $ghostRole.set(role)
  $ghostOpacity.set(1)
  scheduleFade(sticky)
}

function scheduleFade(extendOnly) {
  clearFadeTimers()
  const hold = extendOnly ? WORD_HOLD_MS : WORD_HOLD_MS
  fadeTimer = window.setTimeout(() => {
    fadeTimer = 0
    const start = performance.now()
    const from = $ghostOpacity.get()
    const tick = now => {
      const u = Math.min(1, (now - start) / WORD_FADE_MS)
      const next = from * (1 - u)
      $ghostOpacity.set(next)
      if (u < 1 && lastGhostKey) {
        fadeRaf = requestAnimationFrame(tick)
      } else {
        fadeRaf = 0
        if (u >= 1) {
          $ghostText.set('')
          $ghostRole.set('')
          $ghostOpacity.set(0)
          lastGhostKey = ''
        }
      }
    }
    fadeRaf = requestAnimationFrame(tick)
  }, hold)
}

function resetSessionUi() {
  $phase.set('idle')
  $level.set(0)
  $elapsed.set(0)
  $caption.set('')
  $captionPartial.set(false)
  $agentLine.set('')
  $mode.set('off')
  clearGhost()
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
  clearGhost()
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

// --- Native voice bus --------------------------------------------------------

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
    const cap = d.caption.trim()
    $caption.set(cap)
    $captionPartial.set(Boolean(d.partial))
    // YOU words: show while listening/recording/transcribing, then fade
    if (phase === 'listening' || phase === 'recording' || phase === 'transcribing') {
      showGhostWords(cap, 'you', { sticky: Boolean(d.partial) })
    }
  }

  if (active && !$nativeActive.get()) {
    $nativeActive.set(true)
    $error.set('')
    startElapsed()
    setLiveAttr(true)
  }

  if (!active && $nativeActive.get() && !findCoreEndButton()) {
    // Bus off and no core pill — only tear down after a short hold so
    // between-turn idle gaps do not collapse the full-session overlay.
    return
  }

  if (active) {
    $nativeActive.set(true)
    setLiveAttr(true)
    const prev = $phase.get()
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

    // Phase transitions that clear / retarget words
    if (phase === 'speaking' && prev !== 'speaking') {
      // Orb takes over — fade YOU words immediately
      scheduleFade(false)
    }
    if (phase === 'listening' && (prev === 'speaking' || prev === 'thinking')) {
      $caption.set('')
      $agentLine.set('')
      // fresh listen — ghost clear
      clearGhost()
    }
    if (phase === 'thinking' && prev === 'transcribing') {
      // brief hold then fade committed YOU caption
      if ($caption.get()) showGhostWords($caption.get(), 'you', { sticky: false })
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

function wireDomFallback() {
  if (pollTimer) return
  let lastSeenLive = 0
  pollTimer = window.setInterval(() => {
    if (ending) return
    const endBtn = findCoreEndButton()
    const busAlive = $busOk.get() && $mode.get() !== 'off'
    if (endBtn || busAlive) {
      endMisses = 0
      lastSeenLive = Date.now()
      if (!$nativeActive.get()) {
        $nativeActive.set(true)
        startElapsed()
        setLiveAttr(true)
        if (!$busOk.get()) {
          $phase.set('listening')
          $error.set('')
        }
      }
      if (endBtn && !$busOk.get()) {
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
      // Hold full-session overlay across turn gaps; only collapse after
      // both core End and bus have been gone for a while.
      if (
        endMisses >= END_MISS_TOLERANCE &&
        Date.now() - lastSeenLive > SESSION_HOLD_MS &&
        $mode.get() !== 'dictation'
      ) {
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
/* Hide stock voice strip while Live owns the surface */
[data-voice-hud-live="1"] [data-slot="composer-fade"] > [aria-live="polite"][role="status"].h-8:not([data-voice-hud]) {
  display: none !important;
}
/* Soften thread behind Live stage (ChatGPT keeps context faintly) */
[data-voice-hud-live="1"] [data-slot="messages"],
[data-voice-hud-live="1"] [data-slot="thread"],
[data-voice-hud-live="1"] main [data-session-scroll],
html[data-voice-hud-live="1"] [data-slot="chat-scroll"] {
  opacity: 0.2 !important;
  filter: blur(1px);
  pointer-events: none !important;
  transition: opacity 0.45s ease, filter 0.45s ease;
}
/* Full-session Live stage — light canvas like ChatGPT Live */
[data-voice-hud="1"].vh-session {
  position: fixed !important;
  inset: 0 !important;
  z-index: 80 !important;
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  margin: 0 !important;
  padding: 1.25rem 1rem 6.5rem !important;
  border: none !important;
  border-radius: 0 !important;
  /* Dark Live stage — Hermes night, soft blue orb glow (not blinding white) */
  background:
    radial-gradient(circle at 50% 46%, rgba(56, 120, 220, 0.18) 0%, rgba(15, 23, 42, 0.55) 42%, rgba(6, 8, 14, 0.94) 72%, #05070c 100%) !important;
  backdrop-filter: blur(18px) saturate(1.05) !important;
  -webkit-backdrop-filter: blur(18px) saturate(1.05) !important;
  box-shadow: none !important;
  color: #e2e8f0 !important;
}
/* Concentric guide rings (static base; canvas draws active ripples) */
[data-voice-hud="1"].vh-session::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 46%;
  width: min(92vmin, 720px);
  height: min(92vmin, 720px);
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background:
    radial-gradient(circle, transparent 18%, rgba(96, 165, 250, 0.12) 18.5%, transparent 19%),
    radial-gradient(circle, transparent 28%, rgba(96, 165, 250, 0.10) 28.5%, transparent 29.5%),
    radial-gradient(circle, transparent 38%, rgba(96, 165, 250, 0.12) 38.5%, transparent 39.5%),
    radial-gradient(circle, transparent 48%, rgba(96, 165, 250, 0.08) 48.5%, transparent 49.5%),
    radial-gradient(circle, transparent 58%, rgba(96, 165, 250, 0.06) 58.5%, transparent 59.5%);
  pointer-events: none;
  z-index: 0;
}
[data-voice-hud="1"] .vh-stage {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}
[data-voice-hud="1"] .vh-topbar {
  position: absolute;
  top: 1rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: min(20rem, calc(100% - 2rem));
  justify-content: space-between;
  padding: 0.35rem 0.5rem 0.35rem 0.85rem;
  border-radius: 999px;
  background: rgba(8, 12, 22, 0.72);
  border: 1px solid rgba(148, 163, 184, 0.14);
  box-shadow: 0 10px 36px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(14px);
}
[data-voice-hud="1"] .vh-live-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.92rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: #f1f5f9;
}
[data-voice-hud="1"] .vh-live-dot {
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 999px;
  background: #22c55e;
  box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.15);
}
[data-voice-hud="1"] .vh-live-dot[data-on="speak"] {
  background: #3b82f6;
  box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.18);
  animation: vh-pulse 1.2s ease-in-out infinite;
}
[data-voice-hud="1"] .vh-live-dot[data-on="think"] {
  background: #f59e0b;
  box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.16);
}
@keyframes vh-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.15); opacity: 0.75; }
}
[data-voice-hud="1"] .vh-ghost {
  transition: opacity 0.4s ease, transform 0.45s ease;
  will-change: opacity, transform;
  color: #e2e8f0;
}
[data-voice-hud="1"] .vh-orb-shell {
  filter: drop-shadow(0 12px 40px rgba(96, 165, 250, 0.28));
}
[data-voice-hud-live="1"] [data-slot="composer-root"],
[data-voice-hud="1"] .vh-end-btn {
  height: 2rem;
  border: none;
  border-radius: 999px;
  padding: 0 0.9rem;
  background: transparent;
  color: #e2e8f0;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}
[data-voice-hud="1"] .vh-end-btn:hover {
  background: rgba(148, 163, 184, 0.12);
}
[data-voice-hud="1"] .vh-orb-wrap {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 220px;
}
[data-voice-hud="1"] .vh-ghost {
  min-height: 3.25rem;
  width: min(28rem, 100%);
  padding: 0 1.5rem;
  transition: opacity 0.4s ease, transform 0.45s ease;
}
#voice-hud-live-portal {
  /* beat any app stacking context */
  z-index: 2147483000 !important;
}
[data-voice-hud-live="1"] [data-slot="composer-dock"] {
  position: relative;
  z-index: 90 !important;
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
  // CRITICAL: paint full Live stage on document.body — composer.top clips fixed overlays
  if (on) mountLivePortal()
  else unmountLivePortal()
}

const PORTAL_ID = 'voice-hud-live-portal'
let portalRaf = 0
let portalCanvas = null
let portalT0 = 0

function unmountLivePortal() {
  if (portalRaf) {
    cancelAnimationFrame(portalRaf)
    portalRaf = 0
  }
  portalCanvas = null
  document.getElementById(PORTAL_ID)?.remove()
}

function mountLivePortal() {
  if (typeof document === 'undefined') return
  let root = document.getElementById(PORTAL_ID)
  if (!root) {
    root = document.createElement('div')
    root.id = PORTAL_ID
    root.setAttribute('data-voice-hud', '1')
    root.setAttribute('data-voice-hud-portal', '1')
    root.className = 'vh-session'
    root.innerHTML = `
      <div class="vh-stage">
        <div class="vh-topbar">
          <div class="vh-live-pill">
            <span class="vh-live-dot" data-on="listen" data-vh-dot></span>
            <span>Live</span>
            <span class="vh-phase" data-vh-phase-label style="font-size:0.72rem;font-weight:400;color:#94a3b8"></span>
          </div>
          <button type="button" class="vh-end-btn" data-voice-hud-end="1" aria-label="Stop voice HUD">End</button>
        </div>
        <div class="vh-orb-wrap" data-vh-orb-wrap></div>
        <div class="vh-ghost" data-vh-ghost aria-hidden="true"></div>
      </div>
    `
    // Inline critical styles so stage works even if CSS inject lags
    root.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483000',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'padding:1.25rem 1rem 6.5rem',
      'margin:0',
      'border:none',
      'pointer-events:auto',
      'background:radial-gradient(circle at 50% 46%, rgba(56,120,220,0.2) 0%, rgba(15,23,42,0.62) 42%, rgba(6,8,14,0.95) 72%, #05070c 100%)'
    ].join(';')
    document.body.appendChild(root)

    root.querySelector('[data-voice-hud-end]')?.addEventListener('click', e => {
      e.preventDefault()
      e.stopPropagation()
      endVoice()
    })
  }

  // Canvas orb
  const wrap = root.querySelector('[data-vh-orb-wrap]')
  if (wrap && !portalCanvas) {
    const c = document.createElement('canvas')
    c.className = 'vh-orb-shell'
    c.setAttribute('aria-hidden', 'true')
    wrap.innerHTML = ''
    wrap.appendChild(c)
    portalCanvas = c
    portalT0 = performance.now()
    startPortalOrbLoop()
  }

  paintLivePortalChrome()
}

function paintLivePortalChrome() {
  const root = document.getElementById(PORTAL_ID)
  if (!root) return
  const phase = $phase.get()
  const listening = phase === 'listening' || phase === 'recording'
  const speaking = phase === 'speaking'
  const thinking = phase === 'thinking' || phase === 'transcribing'
  const label = root.querySelector('[data-vh-phase-label]')
  if (label) {
    label.textContent =
      listening ? 'Listening' : speaking ? 'Speaking' : thinking ? (phase === 'transcribing' ? 'Got it' : 'Thinking') : 'Live'
  }
  const dot = root.querySelector('[data-vh-dot]')
  if (dot) dot.setAttribute('data-on', speaking ? 'speak' : thinking ? 'think' : 'listen')

  const ghost = root.querySelector('[data-vh-ghost]')
  if (ghost) {
    const text = $ghostText.get()
    const op = $ghostOpacity.get()
    const role = $ghostRole.get()
    // Prefer live caption from bus if ghost empty (YOU words)
    const caption = ($caption.get() || '').trim()
    const showText = (text && op > 0.02) ? text : caption
    const showRole = (text && op > 0.02) ? role : caption ? 'you' : ''
    const showOp = (text && op > 0.02) ? op : caption ? 1 : 0

    if (showText && showOp > 0.02) {
      ghost.style.opacity = String(showOp)
      ghost.style.transform = `translateY(${(1 - showOp) * 6}px)`
      ghost.setAttribute('aria-hidden', 'false')
      const roleColor = showRole === 'agent' ? '#7dd3fc' : '#86efac'
      const bodyColor = showRole === 'agent' ? '#e0f2fe' : '#f8fafc'
      ghost.innerHTML =
        `<div style="text-align:center;max-width:36rem;margin:0 auto;padding:0.5rem 1rem">` +
        `<div style="margin-bottom:0.4rem;font-size:0.7rem;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${roleColor}">${
          showRole === 'agent' ? 'ILO' : 'YOU'
        }</div>` +
        `<div style="display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;font-size:1.2rem;font-weight:500;line-height:1.4;letter-spacing:-0.01em;color:${bodyColor};text-shadow:0 1px 18px rgba(0,0,0,0.55)">${escapeHtml(
          showText
        )}</div></div>`
    } else {
      ghost.style.opacity = listening ? '0.85' : '0.55'
      ghost.setAttribute('aria-hidden', 'false')
      ghost.innerHTML = listening
        ? `<div style="text-align:center;color:#94a3b8;font-size:0.95rem;font-weight:500">Listening — speak anytime</div>`
        : `<div style="text-align:center;color:#64748b;font-size:0.9rem">${$busOk.get() ? phaseLabelSafe(phase) : 'Starting Live…'}</div>`
    }
  }
}

function phaseLabelSafe(p) {
  if (p === 'listening' || p === 'recording') return 'Listening'
  if (p === 'transcribing') return 'Got it'
  if (p === 'thinking') return 'Thinking'
  if (p === 'speaking') return 'Speaking'
  return 'Live'
}


function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function startPortalOrbLoop() {
  if (portalRaf) cancelAnimationFrame(portalRaf)
  const draw = now => {
    const c = portalCanvas
    const root = document.getElementById(PORTAL_ID)
    if (!c || !root || !$nativeActive.get()) {
      portalRaf = 0
      return
    }
    const ctx = c.getContext('2d')
    if (!ctx) {
      portalRaf = requestAnimationFrame(draw)
      return
    }

    const phase = $phase.get()
    const lv = Math.max(0, Math.min(1, $level.get()))
    const speaking = phase === 'speaking'
    const listening = phase === 'listening' || phase === 'recording'
    const size = speaking ? 168 : listening ? 156 : 148
    const pad = Math.round(size * 0.85)
    const W = size + pad * 2
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
    if (c.width !== Math.round(W * dpr)) {
      c.width = Math.round(W * dpr)
      c.height = Math.round(W * dpr)
      c.style.width = W + 'px'
      c.style.height = W + 'px'
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const t = (now - portalT0) / 1000
    const cx = W / 2
    const cy = W / 2
    let energy = 0.2
    let speed = 1.0
    if (listening) {
      energy = 0.35 + lv * 0.55
      speed = 1.15
    } else if (phase === 'thinking' || phase === 'transcribing') {
      energy = 0.28
      speed = 1.5
    } else if (speaking) {
      energy = 0.55 + lv * 0.4
      speed = 1.25
    }
    const breathe = 1 + Math.sin(t * 2.0 * speed) * (0.03 + energy * 0.025)
    const R = size * 0.5 * breathe
    ctx.clearRect(0, 0, W, W)

    // Concentric ripples — ChatGPT Live signature
    for (let i = 0; i < 5; i++) {
      const phaseOff = (t * speed * 0.35 + i / 5) % 1
      const rr = R * (1.15 + phaseOff * (1.9 + energy * 0.6))
      const alpha = (1 - phaseOff) * (0.1 + energy * 0.16)
      ctx.beginPath()
      ctx.arc(cx, cy, rr, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(147, 197, 253, ${alpha})`
      ctx.lineWidth = 1.25 + (1 - phaseOff) * 1.5
      ctx.stroke()
    }

    const bloom = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, R * 1.55)
    bloom.addColorStop(0, `rgba(191, 219, 254, ${0.35 + energy * 0.25})`)
    bloom.addColorStop(0.55, `rgba(191, 219, 254, ${0.12 + energy * 0.1})`)
    bloom.addColorStop(1, 'rgba(191, 219, 254, 0)')
    ctx.fillStyle = bloom
    ctx.beginPath()
    ctx.arc(cx, cy, R * 1.55, 0, Math.PI * 2)
    ctx.fill()

    const body = ctx.createRadialGradient(cx - R * 0.2, cy - R * 0.25, R * 0.05, cx + R * 0.05, cy + R * 0.1, R)
    body.addColorStop(0, 'rgba(255,255,255,1)')
    body.addColorStop(0.28, 'rgba(239,246,255,0.98)')
    body.addColorStop(0.55, 'rgba(191,219,254,0.95)')
    body.addColorStop(0.82, `rgba(147,197,253,${0.9 + energy * 0.05})`)
    body.addColorStop(1, `rgba(96,165,250,${0.55 + energy * 0.15})`)
    ctx.fillStyle = body
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.fill()

    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, R * 0.95, 0, Math.PI * 2)
    ctx.clip()
    const ox = Math.cos(t * 0.7) * R * 0.12
    const oy = Math.sin(t * 0.9) * R * 0.1
    const inner = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, R * 0.7)
    inner.addColorStop(0, `rgba(255,255,255,${0.55 + energy * 0.15})`)
    inner.addColorStop(0.4, 'rgba(219,234,254,0.25)')
    inner.addColorStop(1, 'rgba(147,197,253,0)')
    ctx.fillStyle = inner
    ctx.beginPath()
    ctx.arc(cx + ox, cy + oy, R * 0.7, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    ctx.fillStyle = 'rgba(255,255,255,0.65)'
    ctx.beginPath()
    ctx.ellipse(cx - R * 0.22, cy - R * 0.28, R * 0.18, R * 0.11, -0.5, 0, Math.PI * 2)
    ctx.fill()

    paintLivePortalChrome()
    portalRaf = requestAnimationFrame(draw)
  }
  portalRaf = requestAnimationFrame(draw)
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
      // thinking: orb only — fade residual YOU text
      scheduleFade(false)
    } else if (type === 'message.delta') {
      const chunk = String(payload.text || payload.delta || '')
      if (!chunk) return
      const next = ($agentLine.get() + chunk).slice(-320)
      $agentLine.set(next)
      $phase.set('speaking')
      // Brief ghost of agent words then they disappear — orb is the voice
      showGhostWords(next.slice(-160), 'agent', { sticky: true })
    } else if (type === 'message.complete') {
      $agentLine.set('')
      // Final fade-out of agent words
      scheduleFade(false)
      if (findCoreEndButton() || $nativeActive.get()) {
        $phase.set('listening')
        $caption.set('')
        $captionPartial.set(false)
        // After a beat, clear ghost fully for clean listen
        window.setTimeout(() => {
          if ($phase.get() === 'listening') clearGhost()
        }, WORD_HOLD_MS + WORD_FADE_MS)
      }
    }
  })
}

// --- Orb (primary UI — AI “speaks through” this) -----------------------------

function VoiceOrb({ size = 180 }) {
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
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
    // Extra room for expanding ripples (ChatGPT Live rings)
    const pad = Math.round(size * 0.85)
    const W = size + pad * 2
    c.width = Math.round(W * dpr)
    c.height = Math.round(W * dpr)
    c.style.width = W + 'px'
    c.style.height = W + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    /**
     * ChatGPT Live orb: soft blue–white sphere + concentric ripples.
     * Reference: OpenAI Live product UI (center phone in marketing shot).
     */
    const draw = now => {
      const t = (now - t0) / 1000
      const cx = W / 2
      const cy = W / 2
      const ph = pr.current
      const lv = Math.max(0, Math.min(1, lr.current))

      let energy = 0.2
      let speed = 1.0
      // Soft blue family (screenshot): periwinkle → white
      if (ph === 'listening' || ph === 'recording') {
        energy = 0.35 + lv * 0.55
        speed = 1.15
      } else if (ph === 'transcribing' || ph === 'thinking') {
        energy = 0.28
        speed = 1.5
      } else if (ph === 'speaking') {
        energy = 0.55 + lv * 0.4
        speed = 1.25
      }

      const breathe = 1 + Math.sin(t * 2.0 * speed) * (0.03 + energy * 0.025)
      const R = size * 0.5 * breathe

      ctx.clearRect(0, 0, W, W)

      // Concentric ripples (ChatGPT Live signature)
      const ringCount = 5
      for (let i = 0; i < ringCount; i++) {
        const phaseOff = (t * speed * 0.35 + i / ringCount) % 1
        const rr = R * (1.15 + phaseOff * (1.9 + energy * 0.6))
        const alpha = (1 - phaseOff) * (0.1 + energy * 0.16)
        ctx.beginPath()
        ctx.arc(cx, cy, rr, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(147, 197, 253, ${alpha})`
        ctx.lineWidth = 1.25 + (1 - phaseOff) * 1.5
        ctx.stroke()
      }

      // Soft outer bloom
      const bloom = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, R * 1.55)
      bloom.addColorStop(0, `rgba(191, 219, 254, ${0.35 + energy * 0.25})`)
      bloom.addColorStop(0.55, `rgba(191, 219, 254, ${0.12 + energy * 0.1})`)
      bloom.addColorStop(1, 'rgba(191, 219, 254, 0)')
      ctx.fillStyle = bloom
      ctx.beginPath()
      ctx.arc(cx, cy, R * 1.55, 0, Math.PI * 2)
      ctx.fill()

      // Main soft sphere — white core → soft blue edge (exact Live look)
      const body = ctx.createRadialGradient(
        cx - R * 0.2,
        cy - R * 0.25,
        R * 0.05,
        cx + R * 0.05,
        cy + R * 0.1,
        R
      )
      body.addColorStop(0, 'rgba(255, 255, 255, 1)')
      body.addColorStop(0.28, 'rgba(239, 246, 255, 0.98)')
      body.addColorStop(0.55, `rgba(191, 219, 254, ${0.95})`)
      body.addColorStop(0.82, `rgba(147, 197, 253, ${0.9 + energy * 0.05})`)
      body.addColorStop(1, `rgba(96, 165, 250, ${0.55 + energy * 0.15})`)
      ctx.fillStyle = body
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, Math.PI * 2)
      ctx.fill()

      // Inner soft caustic (very subtle motion)
      ctx.save()
      ctx.beginPath()
      ctx.arc(cx, cy, R * 0.95, 0, Math.PI * 2)
      ctx.clip()
      const ox = Math.cos(t * 0.7) * R * 0.12
      const oy = Math.sin(t * 0.9) * R * 0.1
      const inner = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, R * 0.7)
      inner.addColorStop(0, `rgba(255,255,255,${0.55 + energy * 0.15})`)
      inner.addColorStop(0.4, 'rgba(219, 234, 254, 0.25)')
      inner.addColorStop(1, 'rgba(147, 197, 253, 0)')
      ctx.fillStyle = inner
      ctx.beginPath()
      ctx.arc(cx + ox, cy + oy, R * 0.7, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      // Tiny specular
      ctx.fillStyle = 'rgba(255,255,255,0.65)'
      ctx.beginPath()
      ctx.ellipse(cx - R * 0.22, cy - R * 0.28, R * 0.18, R * 0.11, -0.5, 0, Math.PI * 2)
      ctx.fill()

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size])

  return jsx('canvas', {
    ref,
    'aria-hidden': true,
    className: 'vh-orb-shell block mx-auto'
  })
}

function phaseLabel(p) {
  if (p === 'listening' || p === 'recording') return 'Listening'
  if (p === 'transcribing') return 'Got it'
  if (p === 'thinking') return 'Thinking'
  if (p === 'speaking') return 'Speaking'
  return 'Live'
}

function LiveStrip() {
  const active = useValue($nativeActive)
  const error = useValue($error)

  // Body portal owns the Live stage (composer.top would clip full-screen).
  useEffect(() => {
    if (active) mountLivePortal()
    else unmountLivePortal()
  }, [active])

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

  // Invisible anchor — keeps React tree alive while portal paints
  return jsx('div', {
    'data-voice-hud': '1',
    'data-voice-hud-anchor': '1',
    style: { display: 'none' },
    'aria-hidden': true
  })
}

function StatusChip() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  return jsx(Tip, {
    content: active
      ? 'Live voice active — click to End'
      : 'Start ChatGPT Live–style voice stage',
    children: jsx('button', {
      type: 'button',
      className: 'inline-flex',
      onClick: () => (active ? endVoice() : toggleVoice()),
      children: jsx(Badge, {
        variant: active ? 'default' : 'outline',
        className: 'cursor-pointer gap-1 font-normal',
        children: active ? `Live · ${phase}` : 'Live'
      })
    })
  })
}

export default {
  id: PLUGIN_ID,
  name: 'Voice HUD',
  defaultEnabled: true,
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
          label: 'Voice HUD: Toggle Live voice',
          keywords: ['voice', 'hud', 'orb', 'chatgpt', 'grok'],
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
          label: 'Voice HUD: Toggle Live voice',
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
      unmountLivePortal()
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

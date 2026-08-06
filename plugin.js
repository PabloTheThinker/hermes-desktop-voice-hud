/**
 * voice-hud — clean Mac-style floating voice panel for Hermes Desktop.
 *
 * UX goals:
 *  • Not glued into the chat composer strip
 *  • Not a full-desktop takeover
 *  • Polished floating sheet over the session workspace (macOS glass)
 *  • Soft orb + mic / speaker / End
 *  • Readable captions when present
 *
 * Native: hermes:voice-bus. No second mic.
 * defaultEnabled: true. Imports: @hermes/plugin-sdk + react* only.
 */
import {
  Badge,
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
const PANEL_ID = 'voice-hud-mac-panel'
const END_MISS_TOLERANCE = 12
const CORE_END_RE = /end voice conversation/i
const WORD_HOLD_MS = 5500
const WORD_FADE_MS = 1200
const SESSION_HOLD_MS = 2500

/** @typedef {'idle' | 'listening' | 'recording' | 'transcribing' | 'thinking' | 'speaking'} Phase */

const $nativeActive = atom(false)
const $phase = atom(/** @type {Phase} */ ('idle'))
const $level = atom(0)
const $caption = atom('')
const $agentLine = atom('')
const $elapsed = atom(0)
const $error = atom('')
const $mode = atom(/** @type {'off' | 'dictation' | 'conversation'} */ ('off'))
const $busOk = atom(false)
const $ghostText = atom('')
const $ghostRole = atom(/** @type {'you' | 'agent' | ''} */ (''))
const $ghostOpacity = atom(0)
const $micMuted = atom(false)
const $speakerMuted = atom(false)

let pollTimer = 0
let endWatch = 0
let elapsedTimer = 0
let fadeTimer = 0
let fadeRaf = 0
let layoutTimer = 0
let orbRaf = 0
let startedAt = 0
let endMisses = 0
let ending = false
/** @type {null | ((e: Event) => void)} */
let busListener = null
let lastGhostKey = ''
/** @type {HTMLCanvasElement | null} */
let orbCanvas = null
let orbT0 = 0

function formatElapsed(sec) {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function phaseLabel(p) {
  if (p === 'listening' || p === 'recording') return 'Listening'
  if (p === 'transcribing') return 'Got it'
  if (p === 'thinking') return 'Thinking'
  if (p === 'speaking') return 'Speaking'
  return 'Voice'
}

function isHudNode(el) {
  return Boolean(
    el?.closest?.('[data-voice-hud="1"]') ||
      el?.getAttribute?.('data-voice-hud-end') === '1' ||
      el?.id === PANEL_ID
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
  if (layoutTimer) {
    clearInterval(layoutTimer)
    layoutTimer = 0
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
 * @param {string} text
 * @param {'you' | 'agent'} role
 * @param {{ sticky?: boolean }} [opts]
 */
function showGhostWords(text, role, opts = {}) {
  const t = (text || '').trim()
  if (!t) return
  const key = `${role}:${t}`
  const sticky = Boolean(opts.sticky)
  if (key === lastGhostKey && sticky) {
    $ghostOpacity.set(1)
    scheduleFade(true)
    paintPanel()
    return
  }
  lastGhostKey = key
  $ghostText.set(t)
  $ghostRole.set(role)
  $ghostOpacity.set(1)
  scheduleFade(sticky)
  paintPanel()
}

function scheduleFade(extendOnly) {
  clearFadeTimers()
  const hold = extendOnly ? WORD_HOLD_MS + 1200 : WORD_HOLD_MS
  fadeTimer = window.setTimeout(() => {
    fadeTimer = 0
    const start = performance.now()
    const from = $ghostOpacity.get()
    const tick = now => {
      const u = Math.min(1, (now - start) / WORD_FADE_MS)
      $ghostOpacity.set(from * (1 - u))
      paintPanel()
      if (u < 1 && lastGhostKey) fadeRaf = requestAnimationFrame(tick)
      else {
        fadeRaf = 0
        if (u >= 1) {
          $ghostText.set('')
          $ghostRole.set('')
          $ghostOpacity.set(0)
          lastGhostKey = ''
          paintPanel()
        }
      }
    }
    fadeRaf = requestAnimationFrame(tick)
  }, hold)
}

function setLiveAttr(on) {
  if (typeof document === 'undefined') return
  document.querySelectorAll('[data-slot="composer-root"], [data-slot="composer-dock"]').forEach(n => {
    if (on) n.setAttribute('data-voice-hud-live', '1')
    else n.removeAttribute('data-voice-hud-live')
  })
  document.documentElement.removeAttribute('data-voice-hud-live')
  // Remove any old full-screen portal ids
  document.getElementById('voice-hud-live-portal')?.remove()
  ensureCss()
  if (on) mountPanel()
  else unmountPanel()
}

function resetSessionUi() {
  $phase.set('idle')
  $level.set(0)
  $elapsed.set(0)
  $caption.set('')
  $agentLine.set('')
  $mode.set('off')
  $micMuted.set(false)
  $speakerMuted.set(false)
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
    paintPanel()
  }, 250)
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

function toggleMicMute() {
  $micMuted.set(!$micMuted.get())
  haptic('tap')
  paintPanel()
  try {
    const btn = [...document.querySelectorAll('[data-slot="composer-root"] button, [data-slot="composer-dock"] button')].find(
      b => /mute|unmute/i.test(b.getAttribute('aria-label') || '') && !isHudNode(b)
    )
    if (btn) btn.click()
  } catch {
    /* ignore */
  }
}

function toggleSpeakerMute() {
  $speakerMuted.set(!$speakerMuted.get())
  haptic('tap')
  paintPanel()
  try {
    if ($speakerMuted.get()) {
      document.querySelectorAll('audio, video').forEach(el => {
        try {
          el.pause?.()
        } catch {
          /* ignore */
        }
      })
    }
  } catch {
    /* ignore */
  }
}

// --- Bus --------------------------------------------------------------------

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
    showGhostWords(cap, 'you', {
      sticky: Boolean(d.partial) || phase === 'listening' || phase === 'recording'
    })
  }

  if (active && !$nativeActive.get()) {
    $nativeActive.set(true)
    $error.set('')
    startElapsed()
    setLiveAttr(true)
  }
  if (!active && $nativeActive.get() && !findCoreEndButton()) return

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
    paintPanel()
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
      paintPanel()
    } else if ($nativeActive.get()) {
      endMisses += 1
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
      paintPanel()
    } else if (type === 'message.delta') {
      const chunk = String(payload.text || payload.delta || '')
      if (!chunk) return
      const next = ($agentLine.get() + chunk).slice(-420)
      $agentLine.set(next)
      $phase.set('speaking')
      showGhostWords(next.slice(-240), 'agent', { sticky: true })
    } else if (type === 'message.complete') {
      if ($agentLine.get()) showGhostWords($agentLine.get().slice(-240), 'agent', { sticky: false })
      $agentLine.set('')
      if (findCoreEndButton() || $nativeActive.get()) $phase.set('listening')
      paintPanel()
    }
  })
}

// --- Mac floating panel -----------------------------------------------------

function ensureCss() {
  if (typeof document === 'undefined') return
  let el = document.getElementById(STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = `
/* Hide only the stock voice status strip */
[data-voice-hud-live="1"] [data-slot="composer-fade"] > [aria-live="polite"][role="status"].h-8:not([data-voice-hud]) {
  display: none !important;
}
/* Leave chat fully readable */
[data-voice-hud-live="1"] [data-slot="messages"],
[data-voice-hud-live="1"] [data-slot="thread"],
[data-voice-hud-live="1"] [data-slot="chat-scroll"] {
  opacity: 1 !important;
  filter: none !important;
  pointer-events: auto !important;
}

/* macOS-style floating voice sheet */
#${PANEL_ID} {
  position: fixed;
  z-index: 80;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: min(320px, calc(100vw - 48px));
  padding: 18px 20px 16px;
  border-radius: 22px;
  border: 1px solid rgba(255,255,255,0.10);
  background:
    linear-gradient(180deg, rgba(40,44,54,0.72) 0%, rgba(22,24,30,0.78) 100%);
  backdrop-filter: blur(28px) saturate(1.35);
  -webkit-backdrop-filter: blur(28px) saturate(1.35);
  box-shadow:
    0 0 0 0.5px rgba(0,0,0,0.35),
    0 18px 50px rgba(0,0,0,0.38),
    0 2px 0 rgba(255,255,255,0.06) inset;
  color: rgba(245,246,248,0.96);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  pointer-events: auto;
  user-select: none;
  animation: vh-mac-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes vh-mac-in {
  from { opacity: 0; transform: translateY(10px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
#${PANEL_ID} .vh-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: rgba(235,238,245,0.88);
}
#${PANEL_ID} .vh-dot {
  width: 7px;
  height: 7px;
  border-radius: 99px;
  background: #34c759;
  box-shadow: 0 0 0 3px rgba(52,199,89,0.18);
}
#${PANEL_ID} .vh-dot[data-on="speak"] {
  background: #0a84ff;
  box-shadow: 0 0 0 3px rgba(10,132,255,0.2);
}
#${PANEL_ID} .vh-dot[data-on="think"] {
  background: #ff9f0a;
  box-shadow: 0 0 0 3px rgba(255,159,10,0.18);
}
#${PANEL_ID} .vh-sub {
  font-size: 11px;
  font-weight: 500;
  color: rgba(174,178,188,0.9);
  font-variant-numeric: tabular-nums;
}
#${PANEL_ID} .vh-orb-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 108px;
}
#${PANEL_ID} .vh-caption {
  min-height: 2.4rem;
  max-width: 100%;
  text-align: center;
  padding: 0 4px;
}
#${PANEL_ID} .vh-role {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  margin-bottom: 4px;
}
#${PANEL_ID} .vh-role.you { color: rgba(48, 209, 88, 0.95); }
#${PANEL_ID} .vh-role.agent { color: rgba(100, 210, 255, 0.95); }
#${PANEL_ID} .vh-text {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.35;
  letter-spacing: -0.015em;
  color: rgba(245,246,248,0.96);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
#${PANEL_ID} .vh-hint {
  font-size: 12px;
  font-weight: 500;
  color: rgba(160,165,178,0.92);
}
#${PANEL_ID} .vh-ctrls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 2px;
}
#${PANEL_ID} .vh-btn {
  width: 40px;
  height: 40px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.10);
  background: rgba(255,255,255,0.07);
  color: rgba(245,246,248,0.94);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 140ms ease, transform 140ms ease, border-color 140ms ease, opacity 140ms ease;
}
#${PANEL_ID} .vh-btn:hover {
  background: rgba(255,255,255,0.12);
  border-color: rgba(255,255,255,0.16);
}
#${PANEL_ID} .vh-btn:active { transform: scale(0.96); }
#${PANEL_ID} .vh-btn[data-on="1"] {
  opacity: 0.45;
  border-color: rgba(255,69,58,0.35);
}
#${PANEL_ID} .vh-btn.vh-end {
  color: rgba(255,105,97,0.98);
}
/* Hide legacy portals */
#voice-hud-live-portal { display: none !important; }
`
}

function getWorkspaceRect() {
  const sels = [
    '[data-slot="workspace"]',
    '[data-slot="chat-scroll"]',
    '[data-slot="messages"]',
    'main',
    '[data-slot="composer-root"]'
  ]
  for (const s of sels) {
    const el = document.querySelector(s)
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.width > 180 && r.height > 120) return r
  }
  return {
    left: window.innerWidth * 0.2,
    top: 0,
    width: window.innerWidth * 0.6,
    height: window.innerHeight,
    right: window.innerWidth * 0.8,
    bottom: window.innerHeight
  }
}

function layoutPanel() {
  const panel = document.getElementById(PANEL_ID)
  if (!panel || !$nativeActive.get()) return
  const r = getWorkspaceRect()
  const pw = Math.min(320, Math.max(260, r.width * 0.42))
  // Float lower-center of workspace (ChatGPT-like), Mac card polish
  const left = r.left + (r.width - pw) / 2
  const top = r.top + r.height * 0.58
  panel.style.width = `${pw}px`
  panel.style.left = `${Math.max(16, left)}px`
  panel.style.top = `${Math.min(window.innerHeight - 220, Math.max(72, top))}px`
}

function svgMic(muted) {
  if (muted) {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 9v3a3 3 0 005.1 2.1"/><path d="M15 9.3V5a3 3 0 00-5.8-1"/><path d="M5 10v2a7 7 0 0011 5.7"/><path d="M19 10v2c0 .3 0 .7-.1 1"/><line x1="2" y1="2" x2="22" y2="22"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`
  }
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10v2a7 7 0 0014 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`
}

function svgSpeaker(muted) {
  if (muted) {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`
  }
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 010 7"/><path d="M18.5 5.5a9 9 0 010 13"/></svg>`
}

function svgClose() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function paintPanel() {
  const panel = document.getElementById(PANEL_ID)
  if (!panel || !$nativeActive.get()) return

  const phase = $phase.get()
  const listening = phase === 'listening' || phase === 'recording'
  const speaking = phase === 'speaking'
  const thinking = phase === 'thinking' || phase === 'transcribing'
  const dot = speaking ? 'speak' : thinking ? 'think' : 'listen'

  const title = panel.querySelector('[data-vh-title]')
  if (title) {
    title.innerHTML = `<span class="vh-dot" data-on="${dot}"></span><span>Voice</span><span class="vh-sub">${phaseLabel(phase)} · ${formatElapsed($elapsed.get() / 1000)}</span>`
  }

  const cap = panel.querySelector('[data-vh-caption]')
  if (cap) {
    const text = ($ghostText.get() || $caption.get() || '').trim()
    const op = $ghostText.get() ? $ghostOpacity.get() : text ? 1 : 0
    const role = $ghostText.get() ? $ghostRole.get() : text ? 'you' : ''
    if (text && op > 0.05) {
      cap.style.opacity = String(op)
      cap.innerHTML = `<div class="vh-role ${role === 'agent' ? 'agent' : 'you'}">${role === 'agent' ? 'ILO' : 'YOU'}</div><div class="vh-text">${escapeHtml(text)}</div>`
    } else {
      cap.style.opacity = '0.9'
      cap.innerHTML = `<div class="vh-hint">${
        !$busOk.get() ? 'Starting…' : listening ? 'Listening — speak anytime' : phaseLabel(phase)
      }</div>`
    }
  }

  const mic = panel.querySelector('[data-vh-mic]')
  const spk = panel.querySelector('[data-vh-spk]')
  if (mic) {
    mic.setAttribute('data-on', $micMuted.get() ? '1' : '0')
    mic.innerHTML = svgMic($micMuted.get())
  }
  if (spk) {
    spk.setAttribute('data-on', $speakerMuted.get() ? '1' : '0')
    spk.innerHTML = svgSpeaker($speakerMuted.get())
  }
}

function startOrbLoop() {
  if (orbRaf) cancelAnimationFrame(orbRaf)
  orbT0 = performance.now()
  const draw = now => {
    const c = orbCanvas
    const panel = document.getElementById(PANEL_ID)
    if (!c || !panel || !$nativeActive.get()) {
      orbRaf = 0
      return
    }
    const ctx = c.getContext('2d')
    if (!ctx) {
      orbRaf = requestAnimationFrame(draw)
      return
    }

    const phase = $phase.get()
    const lv = Math.max(0, Math.min(1, $level.get()))
    const speaking = phase === 'speaking'
    const listening = phase === 'listening' || phase === 'recording'
    const size = speaking ? 86 : listening ? 80 : 76
    const pad = Math.round(size * 0.45)
    const W = size + pad * 2
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
    if (c.width !== Math.round(W * dpr)) {
      c.width = Math.round(W * dpr)
      c.height = Math.round(W * dpr)
      c.style.width = W + 'px'
      c.style.height = W + 'px'
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const t = (now - orbT0) / 1000
    const cx = W / 2
    const cy = W / 2
    let energy = 0.22
    let speed = 1.0
    if (listening) {
      energy = 0.36 + lv * 0.48
      speed = 1.08
    } else if (phase === 'thinking' || phase === 'transcribing') {
      energy = 0.28
      speed = 1.4
    } else if (speaking) {
      energy = 0.5 + lv * 0.35
      speed = 1.18
    }

    const breathe = 1 + Math.sin(t * 2.0 * speed) * (0.028 + energy * 0.02)
    const R = size * 0.5 * breathe
    ctx.clearRect(0, 0, W, W)

    const wash = ctx.createRadialGradient(cx, cy, R * 0.15, cx, cy, R * 1.65)
    wash.addColorStop(0, `rgba(160, 200, 255, ${0.24 + energy * 0.16})`)
    wash.addColorStop(0.55, `rgba(100, 150, 240, ${0.08 + energy * 0.08})`)
    wash.addColorStop(1, 'rgba(40, 80, 160, 0)')
    ctx.fillStyle = wash
    ctx.beginPath()
    ctx.arc(cx, cy, R * 1.65, 0, Math.PI * 2)
    ctx.fill()

    const body = ctx.createRadialGradient(cx - R * 0.22, cy - R * 0.3, R * 0.04, cx, cy + R * 0.08, R)
    body.addColorStop(0, 'rgba(255,255,255,1)')
    body.addColorStop(0.3, 'rgba(230,240,255,0.98)')
    body.addColorStop(0.6, 'rgba(165,200,255,0.94)')
    body.addColorStop(0.88, `rgba(110,160,245,${0.9 + energy * 0.05})`)
    body.addColorStop(1, `rgba(70,120,220,${0.55 + energy * 0.12})`)
    ctx.fillStyle = body
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.beginPath()
    ctx.ellipse(cx - R * 0.2, cy - R * 0.26, R * 0.14, R * 0.09, -0.5, 0, Math.PI * 2)
    ctx.fill()

    orbRaf = requestAnimationFrame(draw)
  }
  orbRaf = requestAnimationFrame(draw)
}

function mountPanel() {
  if (typeof document === 'undefined') return
  ensureCss()
  let panel = document.getElementById(PANEL_ID)
  if (!panel) {
    panel = document.createElement('div')
    panel.id = PANEL_ID
    panel.setAttribute('data-voice-hud', '1')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'Voice')
    panel.innerHTML = `
      <div class="vh-title" data-vh-title></div>
      <div class="vh-orb-wrap" data-vh-orb></div>
      <div class="vh-caption" data-vh-caption></div>
      <div class="vh-ctrls">
        <button type="button" class="vh-btn" data-vh-mic aria-label="Mute microphone" title="Mute mic"></button>
        <button type="button" class="vh-btn" data-vh-spk aria-label="Mute speaker" title="Mute speaker"></button>
        <button type="button" class="vh-btn vh-end" data-voice-hud-end="1" data-vh-end aria-label="End voice" title="End"></button>
      </div>
    `
    document.body.appendChild(panel)

    panel.querySelector('[data-vh-mic]')?.addEventListener('click', e => {
      e.preventDefault()
      e.stopPropagation()
      toggleMicMute()
    })
    panel.querySelector('[data-vh-spk]')?.addEventListener('click', e => {
      e.preventDefault()
      e.stopPropagation()
      toggleSpeakerMute()
    })
    panel.querySelector('[data-vh-end]')?.addEventListener('click', e => {
      e.preventDefault()
      e.stopPropagation()
      endVoice()
    })
  }

  const wrap = panel.querySelector('[data-vh-orb]')
  if (wrap && !orbCanvas) {
    const c = document.createElement('canvas')
    c.setAttribute('aria-hidden', 'true')
    c.style.filter = 'drop-shadow(0 10px 28px rgba(80,140,255,0.28))'
    wrap.innerHTML = ''
    wrap.appendChild(c)
    orbCanvas = c
    startOrbLoop()
  } else if (orbCanvas && !orbRaf) {
    startOrbLoop()
  }

  layoutPanel()
  paintPanel()
  if (!layoutTimer) {
    layoutTimer = window.setInterval(() => {
      if ($nativeActive.get()) layoutPanel()
    }, 400)
  }
  window.addEventListener('resize', layoutPanel)
}

function unmountPanel() {
  if (orbRaf) {
    cancelAnimationFrame(orbRaf)
    orbRaf = 0
  }
  orbCanvas = null
  if (layoutTimer) {
    clearInterval(layoutTimer)
    layoutTimer = 0
  }
  window.removeEventListener('resize', layoutPanel)
  document.getElementById(PANEL_ID)?.remove()
  document.getElementById('voice-hud-live-portal')?.remove()
}

// Composer registration is a no-op strip so plugin stays loaded; UI is the Mac panel.
function LiveStrip() {
  const active = useValue($nativeActive)
  const error = useValue($error)

  useEffect(() => {
    if (active) mountPanel()
    else unmountPanel()
  }, [active])

  if (!active && error) {
    return jsx('div', {
      className:
        'mb-1 rounded-lg border border-destructive/30 bg-destructive/10 px-2 py-1 text-[0.7rem] text-destructive',
      children: error
    })
  }
  // Nothing in the chat chrome — panel floats cleanly over the workspace
  return null
}

function StatusChip() {
  const active = useValue($nativeActive)
  const phase = useValue($phase)
  return jsx(Tip, {
    content: active ? 'Voice panel active — click to End' : 'Start polished Voice panel',
    children: jsx('button', {
      type: 'button',
      className: 'inline-flex',
      onClick: () => (active ? endVoice() : toggleVoice()),
      children: jsx(Badge, {
        variant: active ? 'default' : 'outline',
        className: 'cursor-pointer gap-1 font-normal',
        children: active ? `Voice · ${phase}` : 'Voice'
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
    unmountPanel()
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
          label: 'Voice HUD: Toggle Mac panel',
          keywords: ['voice', 'hud', 'live', 'mac', 'orb'],
          run: () => toggleVoice()
        }
      },
      {
        id: 'end',
        area: PALETTE_AREA,
        data: {
          id: 'voice-hud.end',
          label: 'Voice HUD: End',
          keywords: ['voice', 'end', 'stop'],
          run: () => endVoice()
        }
      },
      {
        id: 'bind',
        area: KEYBINDS_AREA,
        data: {
          id: 'voice-hud.toggle',
          label: 'Voice HUD: Toggle',
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
      unmountPanel()
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

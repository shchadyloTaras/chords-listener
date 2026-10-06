import { useEffect, useRef } from 'react'
import { useApp } from '../store'

/** Playback speeds offered in the UI and stepped through with "," / ".". */
export const SPEEDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5] as const

export const SEEK_STEP = 5

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'color', 'file', 'image'])

/** True when keyboard input belongs to a text field (or a range slider that uses arrows). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((target as HTMLInputElement).type)
  return false
}

/** Another dialog is open (ours or the chord editor's) — global shortcuts stay quiet. */
export function modalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null
}

export function stepSpeed(dir: 1 | -1) {
  const { playbackRate, setSetting } = useApp.getState()
  let idx = SPEEDS.findIndex((s) => Math.abs(s - playbackRate) < 0.001)
  if (idx < 0) {
    // Off-grid rate: step to the nearest listed speed in the requested direction.
    const above = SPEEDS.findIndex((s) => s > playbackRate)
    const firstAbove = above < 0 ? SPEEDS.length : above
    idx = dir > 0 ? firstAbove - 1 : firstAbove
  }
  const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, idx + dir))]
  setSetting('playbackRate', next)
}

export function seekBy(delta: number) {
  const { currentTime, seek } = useApp.getState()
  seek(currentTime + delta)
}

/** Jump to the previous / next chord change. "Previous" restarts the current chord first. */
export function jumpChord(dir: 1 | -1) {
  const { track, currentTime, seek } = useApp.getState()
  const chords = track?.chords
  if (!chords?.length) return
  const eps = 0.05
  if (dir > 0) {
    const next = chords.find((c) => c.start > currentTime + eps)
    if (next) seek(next.start)
    return
  }
  let idx = -1
  for (let i = 0; i < chords.length; i++) {
    if (chords[i].start <= currentTime + eps) idx = i
    else break
  }
  if (idx < 0) return seek(0)
  const cur = chords[idx]
  if (idx === 0 || currentTime - cur.start > 0.75) seek(cur.start)
  else seek(chords[idx - 1].start)
}

interface HotkeyHandlers {
  onHelp(): void
}

/**
 * Shell-owned global shortcuts (see SPEC): Space · ←/→ · Shift+←/→ · , . · M · ? · Esc.
 * Ignored while typing or when a modal dialog is open.
 */
export function useGlobalHotkeys(handlers: HotkeyHandlers) {
  const ref = useRef(handlers)
  useEffect(() => {
    ref.current = handlers
  })

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      if (modalOpen()) return

      const s = useApp.getState()
      const canPlay = Boolean(s.track && s.controller)
      const key = e.key
      const code = e.code

      if (key === '?') {
        e.preventDefault()
        ref.current.onHelp()
        return
      }
      if (key === 'Escape') {
        if (s.loop) {
          e.preventDefault()
          s.setLoop(null)
        }
        return
      }
      if (!canPlay) return

      if (code === 'Space' || key === ' ') {
        if (e.repeat) return e.preventDefault()
        e.preventDefault()
        s.toggle()
        return
      }
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        e.preventDefault()
        const dir = key === 'ArrowRight' ? 1 : -1
        if (e.shiftKey) jumpChord(dir)
        else seekBy(dir * SEEK_STEP)
        return
      }
      // "," / "." by character first (works for any layout that has them), then by physical key.
      const speedDir = key === ',' ? -1 : key === '.' ? 1 : code === 'Comma' ? -1 : code === 'Period' ? 1 : 0
      if (speedDir && !e.shiftKey) {
        e.preventDefault()
        stepSpeed(speedDir)
        return
      }
      if (code === 'KeyM' && !e.shiftKey) {
        e.preventDefault()
        s.setSetting('muted', !s.muted)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

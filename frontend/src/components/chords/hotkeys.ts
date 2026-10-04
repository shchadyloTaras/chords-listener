// Chord-workspace keyboard shortcuts (see docs/SPEC.md). Uses `event.code` so they work on any
// keyboard layout (Ukrainian included). Ignored while typing and with Ctrl/⌘/Alt held.

import { useEffect, useLayoutEffect, useRef } from 'react'
import { t } from '../../i18n'
import { barIndexAt } from '../../lib/music/bars'
import { playHotkeyChord } from '../../lib/sound'
import { useApp, type Instrument } from '../../store'
import { getClockTime } from './clock'
import type { ChordModel } from './model'
import { selectionRange, useChordUi } from './uiStore'
import { copyAll } from './useCopy'

const INSTRUMENTS: Instrument[] = ['guitar', 'ukulele', 'piano', 'handpan']

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/** Loop the selected bars, else the current bar; pressing again on the same loop clears it. */
export function toggleLoop(model: ChordModel): void {
  const app = useApp.getState()
  const range = selectionRange(useChordUi.getState().selection)
  let from: number
  let to: number
  if (range) [from, to] = range
  else {
    const i = barIndexAt(model.bars, getClockTime())
    if (i < 0) return
    from = to = i
  }
  const a = model.bars[from]
  const b = model.bars[to]
  if (!a || !b) return
  const same = app.loop && Math.abs(app.loop.start - a.start) < 0.01 && Math.abs(app.loop.end - b.end) < 0.01
  if (same) {
    app.setLoop(null)
    app.toast(t('chords.loop.cleared'), 'info')
    return
  }
  app.setLoop({ start: a.start, end: b.end })
  app.toast(from === to ? t('chords.loop.setOne', { n: from + 1 }) : t('chords.loop.set', { from: from + 1, to: to + 1 }), 'info')
}

export function useChordHotkeys(model: ChordModel): void {
  const ref = useRef(model)
  useLayoutEffect(() => {
    ref.current = model
  }, [model])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      if (isTypingTarget(e.target)) return
      // A modal dialog (e.g. the shortcuts help) owns the keyboard, like the Shell's shortcuts.
      if (document.querySelector('[aria-modal="true"]')) return
      if (e.key === 'Escape') {
        // The Shell also handles Esc (modal / loop); just drop our selection alongside.
        useChordUi.getState().clearSelection()
        return
      }
      const app = useApp.getState()
      const shiftOk = e.code === 'Equal' || e.code === 'NumpadAdd'
      if (e.shiftKey && !shiftOk) return
      switch (e.code) {
        case 'Minus':
        case 'NumpadSubtract':
        case 'BracketLeft':
          app.setTranspose(app.transpose - 1)
          break
        case 'Equal':
        case 'NumpadAdd':
        case 'BracketRight':
          app.setTranspose(app.transpose + 1)
          break
        case 'Digit0':
        case 'Numpad0':
          app.setTranspose(0)
          break
        case 'KeyS': {
          const v = !app.simplify
          app.setSetting('simplify', v)
          app.toast(t(v ? 'chords.simplify.on' : 'chords.simplify.off'), 'info')
          break
        }
        case 'KeyV':
          app.setSetting('view', app.view === 'sheet' ? 'timeline' : 'sheet')
          break
        case 'KeyC':
          void copyAll(ref.current)
          break
        case 'KeyF': {
          const v = !app.follow
          app.setSetting('follow', v)
          useChordUi.getState().setFollowPaused(false)
          app.toast(t(v ? 'chords.follow.on' : 'chords.follow.off'), 'info')
          break
        }
        case 'KeyL':
          toggleLoop(ref.current)
          break
        case 'KeyI': {
          const next = INSTRUMENTS[(INSTRUMENTS.indexOf(app.instrument) + 1) % INSTRUMENTS.length]
          app.setSetting('instrument', next)
          app.toast(t(`chords.instrument.${next}`), 'info')
          break
        }
        case 'KeyP':
          // hear the current chord (else the selected / next one) on the selected instrument
          playHotkeyChord(ref.current, getClockTime())
          break
        default:
          return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

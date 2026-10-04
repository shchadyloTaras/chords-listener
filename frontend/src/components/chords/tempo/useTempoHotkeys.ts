// Tempo shortcuts: T = tap tempo, K = metronome on/off. Physical keys (`event.code`), so they
// work with the Ukrainian layout too; ignored while typing, with modifiers, or under a modal.

import { useEffect } from 'react'
import { t } from '../../../i18n'
import { useApp } from '../../../store'
import { isTypingTarget } from '../hotkeys'
import { toggleMetronome } from './metronome'
import { useTap } from './tapStore'

export function useTempoHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (e.code !== 'KeyT' && e.code !== 'KeyK') return
      if (isTypingTarget(e.target)) return
      if (document.querySelector('[aria-modal="true"]')) return
      e.preventDefault()
      if (e.code === 'KeyT') {
        // Holding the key must not machine-gun taps.
        if (!e.repeat) useTap.getState().tap()
        return
      }
      if (e.repeat) return
      const on = toggleMetronome()
      const app = useApp.getState()
      app.toast(t(on ? (app.muted ? 'tempo.metronome.onMuted' : 'tempo.metronome.on') : 'tempo.metronome.off'), 'info')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

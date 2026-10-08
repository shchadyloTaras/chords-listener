// The harmonium's drone (its drone stops): a toggle in the hero that holds the song's tonic while
// the song plays, and the hook that starts / stops it, mounted with the chord workspace.

import { memo, useEffect } from 'react'
import clsx from 'clsx'
import { AudioLines } from 'lucide-react'
import { useT } from '../../i18n'
import { pcToName } from '../../lib/music/notes'
import { droneMidi, playDronePreview, soundEngine } from '../../lib/sound'
import { useApp } from '../../store'
import type { KeyInfo } from '../../types'
import { useChordModel } from './model'

/** Holds the drone while the harmonium is chosen, the drone is on and the song plays. */
export function useHarmoniumDrone(key: KeyInfo | null | undefined, transpose: number): void {
  const enabled = useApp((s) => s.instrument === 'harmonium' && s.harmoniumDrone)
  const playing = useApp((s) => s.isPlaying)
  const midi = droneMidi(key, transpose)
  const want = enabled && playing && midi != null

  useEffect(() => {
    void soundEngine.setDrone(want ? midi : null)
  }, [want, midi])
  useEffect(() => () => void soundEngine.setDrone(null), [])

  // Audio may only start inside a user gesture: while the drone is on, every click / key press wakes
  // the audio up, so it already runs when that press starts the song.
  useEffect(() => {
    if (!enabled || midi == null) return
    const wake = () => void soundEngine.unlock()
    window.addEventListener('click', wake, { capture: true })
    window.addEventListener('keydown', wake, { capture: true })
    return () => {
      window.removeEventListener('click', wake, { capture: true })
      window.removeEventListener('keydown', wake, { capture: true })
    }
  }, [enabled, midi])
}

/** «Дрон A»: switches the drone on / off; sounds a moment of it when switched on while paused. */
export const HarmoniumDroneToggle = memo(function HarmoniumDroneToggle() {
  const t = useT()
  const { track, transpose, spelling } = useChordModel()
  const on = useApp((s) => s.harmoniumDrone)
  const midi = droneMidi(track.key, transpose)
  const note = midi == null ? null : pcToName(midi, spelling)
  const title = note == null ? t('chords.drone.noKey') : t(on ? 'chords.drone.on' : 'chords.drone.off', { note })

  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={midi == null}
      title={title}
      aria-label={note == null ? `${t('chords.drone')}: ${title}` : title}
      onClick={() => {
        const next = !on
        useApp.getState().setSetting('harmoniumDrone', next)
        if (!next || midi == null) return
        if (useApp.getState().isPlaying) soundEngine.unlock()
        else playDronePreview(midi)
      }}
      className={clsx(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        on ? 'border-transparent bg-accent-soft text-accent' : 'border-border text-muted hover:text-text',
      )}
    >
      <AudioLines size={13} aria-hidden />
      {t('chords.drone')}
      {note && <span className="font-display text-sm font-semibold">{note}</span>}
    </button>
  )
})

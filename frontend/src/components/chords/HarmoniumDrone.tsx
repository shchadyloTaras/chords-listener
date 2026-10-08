// The harmonium's drone (its drone stops): a toggle in the hero that holds the song's tonic while
// the song plays (./useHarmoniumDrone starts / stops it).

import { memo } from 'react'
import clsx from 'clsx'
import { AudioLines } from 'lucide-react'
import { useT } from '../../i18n'
import { pcToName } from '../../lib/music/notes'
import { droneMidi, playDronePreview, soundEngine } from '../../lib/sound'
import { useApp } from '../../store'
import { useChordModel } from './model'

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

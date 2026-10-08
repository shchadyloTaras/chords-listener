// Sopilka / flute diagram for one chord: the fingering of every note of its arpeggio, and (in the
// popover and the hero) what the marks mean.

import { memo } from 'react'
import clsx from 'clsx'
import { useT } from '../../../i18n'
import { parseChord } from '../../../lib/music/chord'
import { chordTone } from '../../../lib/music/color'
import { WIND_SPECS, windChord, type WindInstrument } from '../../../lib/wind'
import { windAspect } from './layout'
import { WindChart } from './WindChart'

export type WindDiagramSize = 'sm' | 'md' | 'lg'

export const WindDiagram = memo(function WindDiagram({
  instrument,
  label,
  width,
  size,
  className,
  sounding,
  onPlay,
  onNote,
}: {
  instrument: WindInstrument
  label: string
  width: number
  size: WindDiagramSize
  className?: string
  /** arpeggio notes the chord sound is playing right now */
  sounding?: ReadonlySet<number>
  /** click beside the fingerings: play the arpeggio */
  onPlay?(e: React.MouseEvent<HTMLElement>): void
  /** click on a fingering: play that note */
  onNote?(index: number): void
}) {
  const t = useT()
  const spec = WIND_SPECS[instrument]
  const parsed = parseChord(label)
  const notes = parsed ? windChord(instrument, label) : []
  const height = width * windAspect(spec)
  if (!notes.length) {
    return (
      <div
        className={clsx('flex items-center justify-center rounded-lg border border-dashed border-border text-center text-xs text-faint', className)}
        style={{ width, height }}
        aria-hidden={!parsed}
      >
        {parsed ? t('chords.wind.none') : '—'}
      </div>
    )
  }
  const color = chordTone(parsed!.rootPc, parsed!.quality)
  const names = notes.map((n) => `${n.name}${n.octave}`).join(' ')
  const title = t('chords.wind.label', { chord: label, instrument: t(`chords.instrument.${instrument}`), notes: names })
  const back = spec.keys.some((k) => k.back)
  const overblown = notes.some((n) => n.register > 1)

  return (
    <figure
      className={clsx('flex flex-col items-center gap-1', onPlay && 'cursor-pointer', className)}
      onClick={onPlay}
      data-cw-sound={onPlay ? 'always' : undefined}
      title={onPlay ? t('sound.diagram.wind') : undefined}
    >
      <WindChart spec={spec} notes={notes} color={color} width={width} title={title} octaves={size !== 'sm'} sounding={sounding} onNote={onNote} />
      {size !== 'sm' && (
        <figcaption className="text-center text-[10.5px] leading-snug text-faint">
          {t('chords.wind.legend')}
          {overblown && (
            <>
              <br />
              {t('chords.wind.overblow')}
            </>
          )}
          {back && (
            <>
              <br />
              {t('chords.wind.thumb')}
            </>
          )}
        </figcaption>
      )}
    </figure>
  )
})

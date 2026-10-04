import { memo } from 'react'
import clsx from 'clsx'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useT } from '../../../i18n'
import { lookupVoicings, type FretInstrument } from '../../../lib/diagrams/chordsDb'
import { pianoVoicing } from '../../../lib/diagrams/piano'
import { staffChord } from '../../../lib/diagrams/staff'
import { parseChord } from '../../../lib/music/chord'
import { chordTone } from '../../../lib/music/color'
import type { Spelling } from '../../../lib/music/notes'
import type { Instrument } from '../../../store'
import { HandpanDiagram } from '../handpan/HandpanDiagram'
import { useChordUi } from '../uiStore'
import { FretChart } from './FretChart'
import { PianoChart } from './PianoChart'
import { StaffChart } from './StaffChart'
import { useChordDb } from './useChordDb'

const WIDTHS = {
  guitar: { sm: 64, md: 92, lg: 116 },
  ukulele: { sm: 52, md: 76, lg: 96 },
  piano: { sm: 120, md: 168, lg: 210 },
  handpan: { sm: 80, md: 124, lg: 148 },
} as const

/** grand-staff height (px) shown above the piano keyboard */
const STAFF_HEIGHTS = { sm: 72, md: 96, lg: 124 } as const

export type DiagramSize = 'sm' | 'md' | 'lg'

/**
 * Chord diagram for the selected instrument. Guitar / ukulele: chart from chords-db with a
 * voicing switcher (shared choice per chord); piano: 2-octave keyboard; handpan: the selected
 * scale with the chord's tone fields lit.
 */
export const ChordDiagram = memo(function ChordDiagram({
  label,
  instrument,
  size = 'md',
  switcher = false,
  spelling,
  className,
}: {
  label: string
  instrument: Instrument
  size?: DiagramSize
  /** show ‹ › to browse voicings */
  switcher?: boolean
  /** note-name spelling for the handpan caption (defaults to the chord's own accidental) */
  spelling?: Spelling
  className?: string
}) {
  const t = useT()
  const fretted: FretInstrument | null = instrument === 'guitar' || instrument === 'ukulele' ? instrument : null
  const db = useChordDb(fretted)
  const vKey = `${instrument}:${label}`
  const chosen = useChordUi((s) => s.voicings[vKey] ?? 0)
  const setVoicing = useChordUi((s) => s.setVoicing)
  const parsed = parseChord(label)
  const width = WIDTHS[instrument][size]
  const instName = t(`chords.instrument.${instrument}`)

  if (instrument === 'handpan') {
    return <HandpanDiagram label={label} width={width} size={size} spelling={spelling} className={className} />
  }

  if (!parsed) {
    return (
      <div
        className={clsx('flex items-center justify-center rounded-lg border border-dashed border-border text-faint', className)}
        style={{ width, height: instrument === 'piano' ? width * 0.32 : width * 1.18 }}
        aria-hidden
      >
        —
      </div>
    )
  }
  const color = chordTone(parsed.rootPc, parsed.quality)
  const title = `${label} — ${instName}`

  if (!fretted) {
    const v = pianoVoicing(parsed)
    const staff = staffChord(parsed, v)
    const right = staff.treble.map((n) => n.name).join(' ')
    return (
      <figure className={clsx('flex flex-col items-center gap-1.5', className)}>
        <StaffChart
          chord={staff}
          color={color}
          height={STAFF_HEIGHTS[size]}
          title={t('chords.staff.label', { chord: label, notes: right, bass: staff.bass.name })}
        />
        <PianoChart voicing={v} color={color} width={width} title={title} />
        <figcaption className="font-mono text-[11px] tracking-wide text-muted">
          {parsed.bassPc != null && `${staff.bass.name} / `}
          {staff.treble.map((n) => n.name).join('  ')}
        </figcaption>
      </figure>
    )
  }

  if (!db) {
    return <div className={clsx('animate-pulse rounded-lg bg-surface-3/60', className)} style={{ width, height: width * 1.18 }} aria-hidden />
  }

  const found = lookupVoicings(db, fretted, parsed)
  const count = found.voicings.length
  if (!count) {
    return (
      <div className={clsx('flex items-center justify-center text-center text-xs text-faint', className)} style={{ width, height: width * 1.18 }}>
        {t('chords.voicing.none')}
      </div>
    )
  }
  const index = ((chosen % count) + count) % count
  const voicing = found.voicings[index]

  return (
    <figure className={clsx('flex flex-col items-center', className)}>
      <FretChart voicing={voicing} strings={found.strings} color={color} width={width} title={title} />
      {(switcher && count > 1) || !found.exact ? (
        <figcaption className="mt-1 flex items-center gap-0.5 text-[11px] text-muted">
          {switcher && count > 1 && (
            <button
              type="button"
              className="grid size-6 place-items-center rounded-md hover:bg-surface-3 hover:text-text"
              aria-label={t('chords.voicing.prev')}
              title={t('chords.voicing.prev')}
              onClick={(e) => {
                e.stopPropagation()
                setVoicing(vKey, index - 1)
              }}
            >
              <ChevronLeft size={14} />
            </button>
          )}
          {!found.exact ? (
            <span className="px-0.5" title={t('chords.voicing.fallback', { chord: found.shown })}>
              ≈ {found.shown}
            </span>
          ) : (
            switcher &&
            count > 1 && <span className="min-w-9 text-center font-mono tabular-nums">{t('chords.voicing.of', { i: index + 1, n: count })}</span>
          )}
          {switcher && count > 1 && (
            <button
              type="button"
              className="grid size-6 place-items-center rounded-md hover:bg-surface-3 hover:text-text"
              aria-label={t('chords.voicing.next')}
              title={t('chords.voicing.next')}
              onClick={(e) => {
                e.stopPropagation()
                setVoicing(vKey, index + 1)
              }}
            >
              <ChevronRight size={14} />
            </button>
          )}
        </figcaption>
      ) : null}
    </figure>
  )
})

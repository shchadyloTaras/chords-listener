import { memo } from 'react'
import clsx from 'clsx'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useT } from '../../../i18n'
import type { FretInstrument } from '../../../lib/diagrams/chordsDb'
import { fretVoicings } from '../../../lib/diagrams/fretted'
import { harmoniumStaff, harmoniumVoicing } from '../../../lib/diagrams/harmonium'
import { pianoVoicing } from '../../../lib/diagrams/piano'
import { isFretted, isKeyboard } from '../../../lib/instruments'
import { staffChord, type StaffNotes } from '../../../lib/diagrams/staff'
import { parseChord } from '../../../lib/music/chord'
import { chordTone } from '../../../lib/music/color'
import type { Spelling } from '../../../lib/music/notes'
import { playChordSound, playHandpanField, playHarmoniumKey, playPianoKey, useSoundingTargets } from '../../../lib/sound'
import type { Instrument } from '../../../store'
import { HandpanDiagram } from '../handpan/HandpanDiagram'
import { useChordUi } from '../uiStore'
import { FretChart } from './FretChart'
import { HARMONIUM_ASPECT, HarmoniumChart } from './HarmoniumChart'
import { PIANO_ASPECT, PianoChart } from './PianoChart'
import { StaffChart } from './StaffChart'
import { useChordDb } from './useChordDb'

const WIDTHS = {
  guitar: { sm: 64, md: 92, lg: 116 },
  bass: { sm: 56, md: 80, lg: 100 },
  ukulele: { sm: 52, md: 76, lg: 96 },
  // 37 keys (C2–C5, both hands): white keys as wide as the harmonium's
  piano: { sm: 132, md: 240, lg: 264 },
  // 37 keys: ~5.7 px white keys in the legend (a tile as narrow as the piano's, two per row on a 360 px
  // phone), ~10.4 / ~11.5 px in the popover / hero
  harmonium: { sm: 132, md: 240, lg: 264 },
  handpan: { sm: 80, md: 124, lg: 148 },
} as const

/** grand-staff height (px) shown above the piano / harmonium keyboard */
const STAFF_HEIGHTS = { sm: 72, md: 96, lg: 124 } as const

export type DiagramSize = 'sm' | 'md' | 'lg'

/**
 * Chord diagram for the selected instrument. Guitar / ukulele: chart from chords-db, bass: generated
 * shapes (lib/diagrams/bass.ts), each with a voicing switcher (shared choice per chord); piano:
 * 2-octave keyboard, harmonium: the instrument's 37 keys (C3–C6) under its carved panel, both under
 * the grand staff; handpan: the selected scale with the chord's tone fields lit. A click plays the
 * chord (a key / handpan field: just that note); the notes light up while they sound.
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
  const fretted: FretInstrument | null = isFretted(instrument) ? instrument : null
  const db = useChordDb(fretted === 'guitar' || fretted === 'ukulele' ? fretted : null)
  const vKey = `${instrument}:${label}`
  const chosen = useChordUi((s) => s.voicings[vKey] ?? 0)
  const setVoicing = useChordUi((s) => s.setVoicing)
  const parsed = parseChord(label)
  const width = WIDTHS[instrument][size]
  const instName = t(`chords.instrument.${instrument}`)
  const sounding = useSoundingTargets(instrument, label)
  // diagrams always sound (also inside a legend tile, whose own click is stopped here)
  const play = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation()
    playChordSound(label, { instrument })
  }

  if (instrument === 'handpan') {
    return (
      <HandpanDiagram
        label={label}
        width={width}
        size={size}
        spelling={spelling}
        className={className}
        sounding={sounding}
        onPlay={play}
        onField={(i) => playHandpanField(label, i)}
      />
    )
  }

  if (!parsed) {
    return (
      <div
        className={clsx('flex items-center justify-center rounded-lg border border-dashed border-border text-faint', className)}
        style={{ width, height: instrument === 'harmonium' ? width * HARMONIUM_ASPECT : isKeyboard(instrument) ? width * PIANO_ASPECT : width * 1.18 }}
        aria-hidden
      >
        —
      </div>
    )
  }
  const color = chordTone(parsed.rootPc, parsed.quality)
  const title = `${label} — ${instName}`

  if (!fretted) {
    // the harmonium: one hand's shape on the treble staff alone (the left hand pumps the bellows)
    const hv = instrument === 'harmonium' ? harmoniumVoicing(parsed) : null
    const v = pianoVoicing(parsed)
    const staff: StaffNotes = hv ? { treble: harmoniumStaff(parsed, hv) } : staffChord(parsed, v)
    const right = staff.treble.map((n) => n.name).join(' ')
    return (
      <figure
        className={clsx('flex cursor-pointer flex-col items-center gap-1.5', className)}
        onClick={play}
        data-cw-sound="always"
        title={t('sound.diagram.piano')}
      >
        <StaffChart
          chord={staff}
          color={color}
          height={STAFF_HEIGHTS[size]}
          title={
            staff.bass ? t('chords.staff.label', { chord: label, notes: right, bass: staff.bass.name }) : t('chords.staff.label.oneHand', { chord: label, notes: right })
          }
          clefTitles={{ treble: t('chords.staff.treble'), bass: t('chords.staff.bass') }}
        />
        {hv ? (
          <HarmoniumChart
            voicing={hv}
            color={color}
            width={width}
            title={title}
            sounding={sounding}
            onKey={(k) => playHarmoniumKey(label, k)}
          />
        ) : (
          <PianoChart voicing={v} color={color} width={width} title={title} sounding={sounding} onKey={(k) => playPianoKey(label, k)} />
        )}
        <figcaption className="font-mono text-[11px] tracking-wide text-muted">
          {/* the piano: the left hand's bass, then the right hand (which may leave the root to the left) */}
          {staff.bass && `${staff.bass.name} / `}
          {staff.treble.map((n) => n.name).join('  ')}
        </figcaption>
      </figure>
    )
  }

  const found = fretVoicings(fretted, parsed, db)
  if (!found) {
    return <div className={clsx('animate-pulse rounded-lg bg-surface-3/60', className)} style={{ width, height: width * 1.18 }} aria-hidden />
  }
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
    <figure
      className={clsx('flex cursor-pointer flex-col items-center', className)}
      onClick={play}
      data-cw-sound="always"
      title={t('sound.diagram.fret')}
    >
      <FretChart voicing={voicing} strings={found.strings} color={color} width={width} title={title} sounding={sounding} />
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

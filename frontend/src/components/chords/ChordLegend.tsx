// All unique chords of the song (after transpose / simplify) with diagrams and counts.
// Click copies the name; hover highlights occurrences in the sheet / timeline.

import { memo } from 'react'
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { useT } from '../../i18n'
import { chordTone } from '../../lib/music/color'
import type { UniqueChord } from '../../lib/music/display'
import { useApp } from '../../store'
import { ChordName } from './ChordName'
import { ChordDiagram } from './diagrams/ChordDiagram'
import { useChordModel } from './model'
import { useChordUi } from './uiStore'
import { copyChordName, useCopyFeedback } from './useCopy'

export const ChordLegend = memo(function ChordLegend() {
  const t = useT()
  const { unique, spelling } = useChordModel()
  const instrument = useApp((s) => s.instrument)
  const showDiagrams = useApp((s) => s.showDiagrams)
  if (!unique.length) return null
  return (
    <section aria-labelledby="cw-legend" className="flex flex-col gap-3">
      <h2 id="cw-legend" className="flex items-baseline gap-2 text-sm font-medium text-muted">
        {t('chords.legend.title')}
        <span className="font-mono text-xs text-faint tabular-nums">{unique.length}</span>
      </h2>
      <ul
        className={clsx(
          'grid gap-2',
          showDiagrams
            ? instrument === 'piano'
              ? 'grid-cols-[repeat(auto-fill,minmax(150px,1fr))]'
              : 'grid-cols-[repeat(auto-fill,minmax(112px,1fr))]'
            : 'grid-cols-[repeat(auto-fill,minmax(76px,1fr))]',
        )}
      >
        {unique.map((u) => (
          <LegendTile key={u.label} chord={u} instrument={instrument} showDiagram={showDiagrams} spelling={spelling} />
        ))}
      </ul>
    </section>
  )
})

const LegendTile = memo(function LegendTile({
  chord,
  instrument,
  showDiagram,
  spelling,
}: {
  chord: UniqueChord
  instrument: ReturnType<typeof useApp.getState>['instrument']
  showDiagram: boolean
  spelling: 'sharp' | 'flat'
}) {
  const t = useT()
  const setHover = useChordUi((s) => s.setHoverLabel)
  const { done, run } = useCopyFeedback()
  const color = chordTone(chord.rootPc, chord.quality)
  return (
    <li>
      <button
        type="button"
        onClick={() => run(() => copyChordName(chord.label))}
        onPointerEnter={() => setHover(chord.label)}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover(chord.label)}
        onBlur={() => setHover(null)}
        title={t('chords.legend.copyHint', { chord: chord.label })}
        className="group relative flex h-full w-full flex-col items-center gap-2 rounded-xl border border-border bg-surface px-2 pt-2.5 pb-2 text-left transition-colors hover:border-border-strong hover:bg-surface-2"
      >
        <span className="flex w-full items-baseline justify-between gap-1">
          <ChordName label={chord.label} className="text-xl" />
          <span className="font-mono text-[11px] text-faint tabular-nums">
            {done ? <Check size={13} className="inline text-success" /> : t('chords.legend.count', { n: chord.count })}
          </span>
        </span>
        <span aria-hidden className="h-[3px] w-full rounded-full opacity-80" style={{ background: color }} />
        {showDiagram && <ChordDiagram label={chord.label} instrument={instrument} size="sm" spelling={spelling} />}
      </button>
    </li>
  )
})

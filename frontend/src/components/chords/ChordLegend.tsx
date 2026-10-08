// All unique chords of the song (after transpose / simplify) with diagrams and counts — by default
// grouped by song part (intro, verse, chorus, …: lib/music/sections), each part with the chords it
// plays, its name (a menu to rename it) and a jump to each place it plays; or all together.
// Click plays the chord (copies its name when the click sound is off); the copy button copies;
// hover highlights occurrences in the sheet / timeline.

import { memo, useMemo } from 'react'
import clsx from 'clsx'
import { Check, Copy } from 'lucide-react'
import { useT } from '../../i18n'
import { isKeyboard } from '../../lib/instruments'
import { chordTone } from '../../lib/music/color'
import type { UniqueChord } from '../../lib/music/display'
import { partChords, partKeys, songParts, type SongPart } from '../../lib/music/sections'
import { clickChordSound } from '../../lib/sound'
import { useApp } from '../../store'
import { ChordName } from './ChordName'
import { ChordDiagram } from './diagrams/ChordDiagram'
import { useChordModel } from './model'
import { PartNameSelect } from './SongParts'
import { partName, partTime } from './partNames'
import { Segmented } from './ui/controls'
import { useChordUi } from './uiStore'
import { copyChordName, useCopyFeedback } from './useCopy'

export const ChordLegend = memo(function ChordLegend() {
  const t = useT()
  const { unique, spelling, sections, chords, track } = useChordModel()
  const instrument = useApp((s) => s.instrument)
  const showDiagrams = useApp((s) => s.showDiagrams)
  const byParts = useApp((s) => s.legendByParts)
  const parts = useMemo(() => songParts(sections), [sections])
  const keys = useMemo(() => partKeys(sections), [sections])
  const renamed = useApp((s) => s.sectionKinds?.[track.id])
  if (!unique.length) return null
  const grouped = byParts && parts.length >= 2
  const grid = clsx(
    'grid gap-2',
    showDiagrams
      ? isKeyboard(instrument)
        ? // the 132 px piano / harmonium + the tile's padding; two columns from a 340 px phone
          'grid-cols-[repeat(auto-fill,minmax(150px,1fr))]'
        : 'grid-cols-[repeat(auto-fill,minmax(112px,1fr))]'
      : 'grid-cols-[repeat(auto-fill,minmax(104px,1fr))]',
  )
  const tiles = (list: UniqueChord[]) => (
    <ul className={grid}>
      {list.map((u) => (
        <LegendTile key={u.label} chord={u} instrument={instrument} showDiagram={showDiagrams} spelling={spelling} />
      ))}
    </ul>
  )
  return (
    <section aria-labelledby="cw-legend" data-tour="song.legend" data-tour-until="li" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="cw-legend" className="flex items-baseline gap-2 text-sm font-medium text-muted">
          {t('chords.legend.title')}
          <span className="font-mono text-xs text-faint tabular-nums">{unique.length}</span>
        </h2>
        {parts.length >= 2 && (
          <Segmented<'parts' | 'all'>
            variant="strong"
            label={t('chords.legend.view')}
            value={byParts ? 'parts' : 'all'}
            onChange={(v) => useApp.getState().setSetting('legendByParts', v === 'parts')}
            options={[
              { value: 'parts', label: t('chords.legend.byParts'), title: t('chords.legend.partsHint') },
              { value: 'all', label: t('chords.legend.all') },
            ]}
          />
        )}
      </div>
      {grouped
        ? parts.map((part) => (
            <PartChords
              key={part.group}
              part={part}
              trackId={track.id}
              partKey={keys.get(part.group)!}
              renamed={!!renamed?.[keys.get(part.group)!]}
              chords={partChords(chords, part)}
              tiles={tiles}
            />
          ))
        : tiles(unique)}
    </section>
  )
})

/** One song part: its name (a menu to rename it), how often it plays, a jump to each start, its chords. */
function PartChords({
  part,
  trackId,
  partKey,
  renamed,
  chords,
  tiles,
}: {
  part: SongPart
  trackId: string
  partKey: string
  renamed: boolean
  chords: UniqueChord[]
  tiles(list: UniqueChord[]): React.ReactNode
}) {
  const t = useT()
  if (!chords.length) return null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border pb-1">
        <PartNameSelect trackId={trackId} partKey={partKey} group={part.group} kind={part.kind} renamed={renamed} />
        {part.sections.length > 1 && <span className="font-mono text-xs text-faint tabular-nums">{t('chords.section.times', { n: part.sections.length })}</span>}
        <span className="flex flex-wrap gap-x-1.5">
          {part.sections.map((s) => (
            <button
              key={s.startBar}
              type="button"
              onClick={() => useApp.getState().seek(s.start)}
              title={t('chords.section.go', { name: partName(t, s.kind, s.group, s.n, s.of), time: partTime(s.start) })}
              className="font-mono text-xs text-muted tabular-nums hover:text-text"
            >
              {partTime(s.start)}
            </button>
          ))}
        </span>
      </div>
      {tiles(chords)}
    </div>
  )
}

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
  const sound = useApp((s) => s.chordSound)
  const { done, run } = useCopyFeedback()
  const color = chordTone(chord.rootPc, chord.quality)
  const copy = () => run(() => copyChordName(chord.label))
  const copyLabel = t('sound.legend.copy', { chord: chord.label })
  return (
    <li className="relative" onPointerEnter={() => setHover(chord.label)} onPointerLeave={() => setHover(null)}>
      <button
        type="button"
        data-cw-sound="click"
        onClick={(e) => {
          if (!clickChordSound(chord.label, { from: e.currentTarget, color })) copy()
        }}
        onFocus={() => setHover(chord.label)}
        onBlur={() => setHover(null)}
        title={sound ? t('sound.legend.play', { chord: chord.label }) : t('chords.legend.copyHint', { chord: chord.label })}
        aria-label={`${sound ? t('sound.playChord', { chord: chord.label }) : copyLabel} (${t('chords.legend.count', { n: chord.count })})`}
        className="group relative flex h-full w-full flex-col items-center gap-2 rounded-xl border border-border bg-surface px-2 pt-2.5 pb-2 text-left transition-colors hover:border-border-strong hover:bg-surface-2"
      >
        <span className="flex w-full items-baseline justify-between gap-1 pr-7">
          <ChordName label={chord.label} className="text-xl" />
          <span className="font-mono text-[11px] text-faint tabular-nums">{t('chords.legend.count', { n: chord.count })}</span>
        </span>
        <span aria-hidden className="h-[3px] w-full rounded-full opacity-80" style={{ background: color }} />
        {showDiagram && <ChordDiagram label={chord.label} instrument={instrument} size="sm" spelling={spelling} />}
      </button>
      <button
        type="button"
        onClick={copy}
        onFocus={() => setHover(chord.label)}
        onBlur={() => setHover(null)}
        aria-label={copyLabel}
        title={copyLabel}
        className={clsx(
          'absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-lg transition-colors hover:bg-surface-3 hover:text-text',
          done ? 'text-success' : 'text-faint',
        )}
      >
        {done ? <Check size={14} strokeWidth={2.4} /> : <Copy size={14} />}
      </button>
    </li>
  )
})

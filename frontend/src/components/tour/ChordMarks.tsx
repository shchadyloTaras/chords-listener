// The chord-marks cheat sheet of the Song tour (step 7): real ChordName examples in their chord colours
// (chordTone), an unsure one with the sheet's dotted underline, "no chord", a slash bass and the suffixes.
import clsx from 'clsx'
import { useT } from '../../i18n'
import { parseChord } from '../../lib/music/chord'
import { chordTone } from '../../lib/music/color'
import '../chords/chords.css'
import { ChordName } from '../chords/ChordName'

const ROWS: Array<{ labels: string[]; text: string; unsure?: boolean }> = [
  { labels: ['C', 'A', 'Am'], text: 'tour.marks.colour' },
  { labels: ['G'], text: 'tour.marks.unsure', unsure: true },
  { labels: ['N'], text: 'tour.marks.none' },
  { labels: ['G/B'], text: 'tour.marks.bass' },
  { labels: ['Am'], text: 'tour.marks.m' },
  { labels: ['G7'], text: 'tour.marks.7' },
  { labels: ['Cmaj7'], text: 'tour.marks.maj7' },
  { labels: ['Dsus4'], text: 'tour.marks.sus' },
  { labels: ['Bdim'], text: 'tour.marks.dim' },
  { labels: ['Caug'], text: 'tour.marks.aug' },
  { labels: ['Cadd9'], text: 'tour.marks.add9' },
]

function Mark({ label, unsure }: { label: string; unsure?: boolean }) {
  const p = parseChord(label)
  return (
    <span className="font-display text-base font-semibold" style={{ color: chordTone(p?.rootPc ?? null, p?.quality ?? null) }}>
      <ChordName label={label} className={clsx(unsure && 'cw-lowconf')} />
    </span>
  )
}

export function ChordMarks({ className }: { className?: string }) {
  const t = useT()
  return (
    <dl className={clsx('grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-sm', className)}>
      {ROWS.map((row) => (
        <div key={row.text} className="contents">
          <dt className="flex items-baseline gap-2">
            {row.labels.map((label) => (
              <Mark key={label} label={label} unsure={row.unsure} />
            ))}
          </dt>
          <dd className="text-muted">{t(row.text)}</dd>
        </div>
      ))}
    </dl>
  )
}

// Handpan diagram for one chord: the instrument with the chord's fields lit and a short verdict
// underneath ("3/3 ноти ✓" or "бракує: B").

import { memo } from 'react'
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { useT } from '../../../i18n'
import { playability, type HandpanPlayability } from '../../../lib/handpan'
import { parseChord } from '../../../lib/music/chord'
import { chordTone } from '../../../lib/music/color'
import { pcToName, type Spelling } from '../../../lib/music/notes'
import { useApp, type Lang } from '../../../store'
import { HandpanChart } from '../diagrams/HandpanChart'
import { countWord, describePlay } from './text'
import { useHandpanScale } from './useHandpanScale'

export type HandpanDiagramSize = 'sm' | 'md' | 'lg'

export const HandpanDiagram = memo(function HandpanDiagram({
  label,
  width,
  size,
  spelling,
  className,
  sounding,
  onPlay,
  onField,
}: {
  label: string
  width: number
  size: HandpanDiagramSize
  spelling?: Spelling
  className?: string
  /** note indices the chord sound is playing right now */
  sounding?: ReadonlySet<number>
  /** click on the instrument (not on a field): play the chord */
  onPlay?(e: React.MouseEvent<HTMLElement>): void
  /** click on a field / the ding: play that note */
  onField?(index: number): void
}) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const scale = useHandpanScale()
  const play = playability(label, scale)
  const parsed = parseChord(label)
  const color = parsed ? chordTone(parsed.rootPc, parsed.quality) : 'var(--chord-none)'
  const sp: Spelling = spelling ?? (parsed?.root.includes('b') ? 'flat' : 'sharp')
  const scaleName = scale.name ?? t('handpan.scale.custom')
  const title = play ? describePlay(lang, label, play, scale, sp) : `${t('chords.instrument.handpan')} — ${scaleName}`

  return (
    <figure
      className={clsx('flex flex-col items-center gap-1.5', onPlay && 'cursor-pointer', className)}
      onClick={onPlay}
      data-cw-sound={onPlay ? 'always' : undefined}
      title={onPlay ? t('sound.diagram.handpan') : undefined}
    >
      <HandpanChart
        scale={scale}
        roles={play?.roles ?? null}
        color={color}
        width={width}
        title={title}
        labels={size === 'sm' ? 'lit' : 'all'}
        octaves={size !== 'sm'}
        sounding={sounding}
        onFieldClick={onField}
      />
      <figcaption className="flex min-h-5 flex-col items-center gap-0.5">
        {play ? <Verdict play={play} spelling={sp} lang={lang} /> : <span className="h-5" aria-hidden />}
      </figcaption>
    </figure>
  )
})

function Verdict({ play, spelling, lang }: { play: HandpanPlayability; spelling: Spelling; lang: Lang }) {
  const t = useT()
  if (play.full) {
    return (
      <span
        className="inline-flex h-5 items-center gap-1 rounded-full bg-success/12 px-2 text-[11px] font-medium whitespace-nowrap text-success tabular-nums"
        title={t('handpan.chip.okTitle')}
      >
        <Check size={12} strokeWidth={2.6} aria-hidden />
        {t('handpan.chip.ok', { have: play.playable, total: play.total, notes: countWord(lang, 'handpan.note', play.total) })}
      </span>
    )
  }
  const missing = play.missing.map((m) => pcToName(m.pc, spelling))
  const thirdMissing = play.missing.some((m) => m.role === 'third')
  const power = play.powerChord && thirdMissing ? `${pcToName(play.rootPc, spelling)}5` : null
  return (
    <>
      <span
        className="inline-flex h-5 max-w-full items-center gap-1 rounded-full bg-surface-3 px-2 text-[11px] whitespace-nowrap text-muted"
        title={t('handpan.chip.missingTitle', { have: play.playable, total: play.total })}
      >
        {t('handpan.chip.missing', { notes: '' }).trim()}
        <span className="font-display text-xs font-semibold text-text">{missing.join(' ')}</span>
      </span>
      {power && (
        <span className="text-[11px] whitespace-nowrap text-faint" title={t('handpan.chip.powerTitle', { chord: power })}>
          {t('handpan.chip.power', { chord: power })}
        </span>
      )}
    </>
  )
}

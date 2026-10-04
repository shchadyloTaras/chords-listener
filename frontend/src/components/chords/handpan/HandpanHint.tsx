// Song-level handpan hint for the hero (in place of the capo hint): how much of the song the
// selected handpan covers, a one-click transposition when another key fits better, and the scale
// picker. Also hosts the "My handpan" editor dialog.

import { memo, useMemo } from 'react'
import clsx from 'clsx'
import { ArrowRight, Check } from 'lucide-react'
import { useT } from '../../../i18n'
import { bestTransposeForHandpan } from '../../../lib/handpan'
import { formatTranspose, resolveSpelling, transposeKeyName } from '../../../lib/music/key'
import { useApp } from '../../../store'
import { useChordModel } from '../model'
import { HandpanEditorHost } from './HandpanEditor'
import { HandpanScaleControls } from './HandpanScaleControls'
import { useHandpanScale } from './useHandpanScale'

const MARK = '\u0000'

/** Wraps a transpose amount into −6..+5 (the same pitch, the shortest way). */
function wrapTranspose(n: number): number {
  return ((((n + 6) % 12) + 12) % 12) - 6
}

export const HandpanHint = memo(function HandpanHint({ className }: { className?: string }) {
  const t = useT()
  const { unique, transpose, track } = useChordModel()
  const accidentals = useApp((s) => s.accidentals)
  const scale = useHandpanScale()

  const weighted = useMemo(() => unique.map((u) => ({ label: u.label, weight: u.seconds })), [unique])
  const fit = useMemo(() => bestTransposeForHandpan(weighted, scale), [weighted, scale])

  const pct = fit ? Math.round(fit.current * 100) : null
  const bestPct = fit ? Math.round(fit.coverage * 100) : null
  const target = fit && fit.shift !== 0 && bestPct! > pct! ? wrapTranspose(transpose + fit.shift) : null
  const targetKey = target == null ? null : transposeKeyName(track.key, target, resolveSpelling(accidentals, track.key, target))
  const transposeTitle = targetKey
    ? t('handpan.song.transposeTitle', { key: targetKey, pct: `${bestPct}%` })
    : t('handpan.song.transposeTitleNoKey', { pct: `${bestPct}%` })

  const coverageText = () => {
    if (pct === 100)
      return (
        <span className="inline-flex items-center gap-1 text-success">
          <Check size={13} strokeWidth={2.6} aria-hidden />
          {t('handpan.song.all')}
        </span>
      )
    const [before, after] = t('handpan.song.coverage', { pct: MARK }).split(MARK)
    return (
      <span title={t('handpan.song.title')}>
        {before}
        <strong className="font-semibold text-text tabular-nums">{pct}%</strong>
        {after}
      </span>
    )
  }

  return (
    <div className={clsx('flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-muted', className)}>
      {pct != null && coverageText()}
      {target != null && (
        <button
          type="button"
          onClick={() => {
            useApp.getState().setTranspose(target)
            useApp.getState().toast(t('handpan.song.transposed', { shift: formatTranspose(target), pct: `${bestPct}%` }), 'info')
          }}
          title={transposeTitle}
          aria-label={`${t('handpan.song.transpose', { shift: formatTranspose(target) })}: ${transposeTitle}`}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-accent-soft px-2 font-medium text-accent transition-colors hover:bg-accent hover:text-accent-fg"
        >
          {t('handpan.song.transpose', { shift: formatTranspose(target) })}
          <ArrowRight size={12} aria-hidden />
          <span className="tabular-nums">{bestPct}%</span>
        </button>
      )}
      <HandpanScaleControls />
      <HandpanEditorHost />
    </div>
  )
})

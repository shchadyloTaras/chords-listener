// "113 BPM" for track lists (history cards), honouring the track's tempo correction.

import clsx from 'clsx'
import { useT } from '../../../i18n'
import { correctedTempo } from '../../../lib/tempo'
import { useApp } from '../../../store'

export function BpmTag({ trackId, tempo, className }: { trackId: string; tempo?: number | null; className?: string }) {
  const t = useT()
  const factor = useApp((s) => s.tempoFactors?.[trackId])
  const bpm = correctedTempo(tempo, factor)
  if (bpm == null) return null
  return (
    <span title={t('tempo.title')} className={clsx('font-mono text-xs whitespace-nowrap text-muted tabular-nums', className)}>
      {t('tempo.bpm', { n: Math.round(bpm) })}
    </span>
  )
}

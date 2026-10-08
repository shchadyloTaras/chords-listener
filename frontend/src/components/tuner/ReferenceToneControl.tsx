// «Еталонний тон»: the note to sound (◀ ▶ by a semitone) and a play / stop toggle.

import { ChevronLeft, ChevronRight, Play, Square } from 'lucide-react'
import { useT } from '../../i18n'
import { Button, IconButton } from '../ui/IconButton'

export function ReferenceToneControl({
  note,
  playing,
  canLower,
  canRaise,
  onLower,
  onRaise,
  onToggle,
}: {
  /** e.g. "A4" */
  note: string
  playing: boolean
  canLower: boolean
  canRaise: boolean
  onLower(): void
  onRaise(): void
  onToggle(): void
}) {
  const t = useT()
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-sm text-muted">{t('tuner.tone.label')}</span>
      <IconButton size="sm" label={t('tuner.tone.lower')} disabled={!canLower} onClick={onLower}>
        <ChevronLeft className="size-4" />
      </IconButton>
      <span className="w-10 text-center font-mono text-sm tabular-nums text-text">{note}</span>
      <IconButton size="sm" label={t('tuner.tone.higher')} disabled={!canRaise} onClick={onRaise}>
        <ChevronRight className="size-4" />
      </IconButton>
      <Button
        size="sm"
        variant={playing ? 'primary' : 'secondary'}
        aria-pressed={playing}
        icon={playing ? <Square className="size-3.5" fill="currentColor" /> : <Play className="size-3.5" fill="currentColor" />}
        onClick={onToggle}
        className="ml-1"
      >
        {playing ? t('tuner.tone.stop') : t('tuner.tone.play')}
      </Button>
    </div>
  )
}

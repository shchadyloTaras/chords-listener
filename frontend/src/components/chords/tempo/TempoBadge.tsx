// Toolbar BPM badge: opens the tempo popover; shows the correction and the metronome state.

import { useState } from 'react'
import clsx from 'clsx'
import { useT } from '../../../i18n'
import { useApp } from '../../../store'
import { useChordModel } from '../model'
import { factorLabel } from './hooks'
import { MetronomeIcon } from './MetronomeIcon'
import { TempoPopover } from './TempoPanel'

/** `className` should carry the display utilities (default `inline-flex`), e.g. `hidden sm:inline-flex`. */
export function TempoBadge({ className = 'inline-flex' }: { className?: string }) {
  const t = useT()
  const { rhythm } = useChordModel()
  const metronome = useApp((s) => s.metronome)
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const bpm = rhythm.tempo != null ? Math.round(rhythm.tempo) : null

  return (
    <>
      <button
        ref={setBtn}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={bpm != null ? t('tempo.open', { n: bpm, ts: rhythm.timeSignature }) : t('tempo.openUnknown')}
        title={t('tempo.badge.title')}
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 font-mono text-xs tabular-nums transition-colors duration-150',
          open ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-3 hover:text-text',
          className,
        )}
      >
        {metronome && <MetronomeIcon className="size-3.5 text-accent" />}
        {bpm != null ? t('tempo.bpm', { n: bpm }) : t('tempo.title')}
        {rhythm.factor !== 1 && <span className="text-accent">×{factorLabel(rhythm.factor)}</span>}
      </button>
      <TempoPopover anchor={btn} open={open} onClose={() => setOpen(false)} />
    </>
  )
}

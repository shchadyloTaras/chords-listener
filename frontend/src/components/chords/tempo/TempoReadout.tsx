// Hero tempo readout: "113 BPM" big and tabular, the live beat pulse and the latest tap-tempo
// result. Opens the tempo popover (which also shows the local tempo).
// Also hosts the tempo runtime (metronome + T/K shortcuts) for the chord workspace.

import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { useT } from '../../../i18n'
import type { PulseGrid } from '../../../lib/tempo'
import { useChordModel } from '../model'
import { BeatPulse } from './BeatPulse'
import { factorLabel, useRecentTap } from './hooks'
import { useMetronome } from './metronome'
import { TempoPopover } from './TempoPanel'
import { useTap } from './tapStore'
import { usePulseGrid } from './usePulseGrid'
import { useTempoHotkeys } from './useTempoHotkeys'

export function TempoReadout() {
  const t = useT()
  const { rhythm } = useChordModel()
  const grid = usePulseGrid()
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const global = rhythm.tempo
  const bpm = global != null ? Math.round(global) : null
  const tap = useRecentTap()

  const aside: ReactNode = tap ? (
    <span className="text-xs font-medium text-accent tabular-nums">
      {tap.bpm != null ? t('tempo.tap.hero', { n: Math.round(tap.bpm) }) : t('tempo.tap.heroWait')}
    </span>
  ) : null

  return (
    <>
      <TempoRuntime grid={grid} />
      <button
        ref={setBtn}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={bpm != null ? t('tempo.open', { n: bpm, ts: rhythm.timeSignature }) : t('tempo.openUnknown')}
        title={t('tempo.badge.title')}
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          '-ml-2 inline-flex min-h-10 items-center gap-3 rounded-xl px-2 py-1 transition-colors duration-150',
          open ? 'bg-accent-soft' : 'hover:bg-surface-2',
        )}
      >
        <span className="flex items-baseline gap-1">
          <span className="font-display text-[1.875rem] leading-none font-semibold text-text tabular-nums sm:text-[2.25rem]">
            {bpm ?? '—'}
          </span>
          <span className="text-[11px] font-semibold tracking-wider text-faint">{t('tempo.unit')}</span>
          {rhythm.factor !== 1 && (
            <span className="ml-0.5 self-center rounded-md bg-accent-soft px-1 py-px text-[11px] font-semibold text-accent">
              ×{factorLabel(rhythm.factor)}
            </span>
          )}
        </span>
        <BeatPulse grid={grid} />
        {aside}
      </button>
      <TempoPopover anchor={btn} open={open} onClose={() => setOpen(false)} />
    </>
  )
}

/** Metronome + tempo shortcuts; renders nothing. A tap series belongs to the open track. */
function TempoRuntime({ grid }: { grid: PulseGrid }) {
  useMetronome(grid)
  useTempoHotkeys()
  useEffect(() => () => useTap.getState().clear(), [])
  return null
}

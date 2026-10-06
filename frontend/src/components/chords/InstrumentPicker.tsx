// The instrument switch of the now-playing hero and the live view: segmented buttons from the sm
// breakpoint up, below it a native select (six names do not fit a phone's width, and the phone's
// own picker opens above the page, so the hero's overflow-hidden never clips it).

import clsx from 'clsx'
import { ChevronDown } from 'lucide-react'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useT } from '../../i18n'
import { INSTRUMENTS } from '../../lib/instruments'
import { useApp, type Instrument } from '../../store'
import { Segmented } from './ui/controls'

/** Tailwind's `sm` breakpoint. */
export const WIDE_QUERY = '(min-width: 640px)'

export function InstrumentPicker({ className, tour }: { className?: string; tour?: string }) {
  const t = useT()
  const instrument = useApp((s) => s.instrument)
  const setSetting = useApp((s) => s.setSetting)
  const wide = useMediaQuery(WIDE_QUERY)
  const label = t('chords.instrument')
  const title = t('chords.instrument.title')
  const name = (v: Instrument) => t(`chords.instrument.${v}`)

  if (wide) {
    return (
      <Segmented<Instrument>
        size="sm"
        label={label}
        value={instrument}
        onChange={(v) => setSetting('instrument', v)}
        options={INSTRUMENTS.map((v) => ({ value: v, label: name(v), title }))}
        className={className}
        tour={tour}
      />
    )
  }
  return (
    <span
      data-tour={tour}
      className={clsx('relative inline-flex h-7 items-center rounded-lg bg-surface-2 text-xs font-medium text-text hover:bg-surface-3', className)}
      title={title}
    >
      <select
        aria-label={label}
        value={instrument}
        onChange={(e) => setSetting('instrument', e.target.value as Instrument)}
        className="h-full cursor-pointer appearance-none rounded-lg bg-transparent pr-7 pl-2.5 [&>option]:bg-surface-2 [&>option]:text-text"
      >
        {INSTRUMENTS.map((v) => (
          <option key={v} value={v}>
            {name(v)}
          </option>
        ))}
      </select>
      <ChevronDown size={14} aria-hidden className="pointer-events-none absolute right-2 text-muted" />
    </span>
  )
}

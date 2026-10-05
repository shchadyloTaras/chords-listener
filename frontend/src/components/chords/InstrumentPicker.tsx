// The instrument switch of the now-playing hero and the live view: segmented buttons from the sm
// breakpoint up, a dropdown below it (six names do not fit a phone's width).

import { ChevronDown } from 'lucide-react'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useT } from '../../i18n'
import { INSTRUMENTS } from '../../lib/instruments'
import { useApp, type Instrument } from '../../store'
import { Menu, MenuItem } from '../ui/Menu'
import { Segmented } from './ui/controls'

/** Tailwind's `sm` breakpoint. */
export const WIDE_QUERY = '(min-width: 640px)'

export function InstrumentPicker({ className }: { className?: string }) {
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
      />
    )
  }
  return (
    <Menu
      label={label}
      className={className}
      trigger={(props) => (
        <button
          type="button"
          {...props}
          title={title}
          aria-label={`${label}: ${name(instrument)}`}
          className="inline-flex h-7 items-center gap-1 rounded-lg bg-surface-2 px-2.5 text-xs font-medium text-text transition-colors duration-150 hover:bg-surface-3"
        >
          {name(instrument)}
          <ChevronDown size={14} aria-hidden className="text-muted" />
        </button>
      )}
    >
      {INSTRUMENTS.map((v) => (
        <MenuItem key={v} checked={v === instrument} onSelect={() => setSetting('instrument', v)}>
          {name(v)}
        </MenuItem>
      ))}
    </Menu>
  )
}

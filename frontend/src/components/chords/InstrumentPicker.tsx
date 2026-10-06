// The instrument switch of the now-playing hero and the live view: segmented buttons from the sm
// breakpoint up; below it (six names do not fit a phone's width) a button dressed as a control — a
// visible «Інструмент» label, the instrument's icon, an accent outline — that opens the app's own
// menu in a portal (Floating), so the hero's overflow-hidden never clips it.

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import clsx from 'clsx'
import { Check, ChevronDown } from 'lucide-react'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useT } from '../../i18n'
import { INSTRUMENTS } from '../../lib/instruments'
import { useApp, type Instrument } from '../../store'
import { INSTRUMENT_ICON } from './instrumentIcons'
import { Floating } from './ui/Floating'
import { Segmented } from './ui/controls'

/** Tailwind's `sm` breakpoint. */
export const WIDE_QUERY = '(min-width: 640px)'

export function InstrumentPicker({ className, tour }: { className?: string; tour?: string }) {
  const t = useT()
  const instrument = useApp((s) => s.instrument)
  const setSetting = useApp((s) => s.setSetting)
  const wide = useMediaQuery(WIDE_QUERY)

  if (!wide) return <NarrowPicker className={className} tour={tour} />
  return (
    <Segmented<Instrument>
      size="sm"
      label={t('chords.instrument')}
      value={instrument}
      onChange={(v) => setSetting('instrument', v)}
      options={INSTRUMENTS.map((v) => ({ value: v, label: t(`chords.instrument.${v}`), title: t('chords.instrument.title') }))}
      className={className}
      tour={tour}
    />
  )
}

function NarrowPicker({ className, tour }: { className?: string; tour?: string }) {
  const t = useT()
  const instrument = useApp((s) => s.instrument)
  const setSetting = useApp((s) => s.setSetting)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const label = t('chords.instrument')
  const name = (v: Instrument) => t(`chords.instrument.${v}`)
  const Icon = INSTRUMENT_ICON[instrument]

  // the checked instrument takes the focus when the menu opens
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open])

  const choose = (v: Instrument) => {
    setSetting('instrument', v)
    setOpen(false)
    anchor?.focus({ preventScroll: true })
  }

  // Esc is Floating's (it closes and focuses the button)
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]
    const idx = items.indexOf(document.activeElement as HTMLElement)
    let next: number | null = null
    if (e.key === 'ArrowDown') next = (idx + 1) % items.length
    else if (e.key === 'ArrowUp') next = (idx - 1 + items.length) % items.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    else if (e.key === 'Tab') setOpen(false)
    if (next === null) return
    e.preventDefault()
    // keep the player's arrow-key shortcuts quiet while the menu has focus
    e.stopPropagation()
    items[next]?.focus()
  }

  return (
    <div data-tour={tour} className={clsx('inline-flex items-center gap-2.5', className)}>
      <span aria-hidden className="text-xs font-medium text-muted">
        {label}
      </span>
      <button
        ref={setAnchor}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${label}: ${name(instrument)}`}
        title={t('chords.instrument.title')}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 items-center gap-2 rounded-xl border border-accent/60 bg-surface px-2.5 text-sm font-semibold text-text shadow-[0_0_0_3px_var(--accent-soft)] transition-colors hover:bg-surface-2"
      >
        <Icon size={16} aria-hidden className="text-accent" />
        {name(instrument)}
        <ChevronDown size={16} aria-hidden className={clsx('text-accent transition-transform duration-150', open && 'rotate-180')} />
      </button>
      <Floating
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        placement="bottom-start"
        role="menu"
        ariaLabel={label}
        id={menuId}
        className="w-60 max-w-[calc(100vw-16px)] p-1.5"
      >
        <div ref={listRef} onKeyDown={onKeyDown}>
          {INSTRUMENTS.map((v) => {
            const ItemIcon = INSTRUMENT_ICON[v]
            const on = v === instrument
            return (
              <button
                key={v}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                tabIndex={-1}
                onClick={() => choose(v)}
                className={clsx(
                  'flex h-11 w-full items-center gap-3 rounded-lg px-2 text-left text-[15px] outline-none! transition-colors duration-100',
                  'hover:bg-surface-3 focus-visible:bg-surface-3',
                  on ? 'font-semibold text-text' : 'text-text/90',
                )}
              >
                <span
                  aria-hidden
                  className={clsx('grid size-8 shrink-0 place-items-center rounded-lg', on ? 'bg-accent text-accent-fg' : 'bg-surface-3 text-muted')}
                >
                  <ItemIcon size={16} />
                </span>
                <span className="flex-1">{name(v)}</span>
                {on && <Check size={16} strokeWidth={2.6} aria-hidden className="text-accent" />}
              </button>
            )
          })}
        </div>
      </Floating>
    </div>
  )
}

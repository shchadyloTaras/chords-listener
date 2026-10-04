// Hover / focus popover for a chord (diagram + copy + edit + play from here) and the inline
// chord editor with autocomplete. One instance lives in the workspace; triggers call the
// helpers in ./popoverIntent.

import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Check, Copy, Pencil, Play } from 'lucide-react'
import { useT } from '../../i18n'
import { allChordNames, formatChord, isNoChordLabel, parseChord } from '../../lib/music/chord'
import { chordTone } from '../../lib/music/color'
import { formatTime } from '../../lib/music/formats'
import { useApp } from '../../store'
import { ChordName } from './ChordName'
import { ChordDiagram } from './diagrams/ChordDiagram'
import { editChord, toCanonical } from './edit'
import { useChordModel } from './model'
import { popoverIntent } from './popoverIntent'
import { useChordUi } from './uiStore'
import { Floating } from './ui/Floating'
import { copyChordName, useCopyFeedback } from './useCopy'

export function ChordPopoverHost() {
  const pop = useChordUi((s) => s.popover)
  const close = useChordUi((s) => s.closePopover)
  const { chords } = useChordModel()
  const chord = pop ? chords[pop.chordIndex] : undefined

  useEffect(() => () => popoverIntent.cancel(), [])

  if (!pop || !chord) return null
  return (
    <Floating
      anchor={pop.anchor}
      open
      onClose={close}
      placement="bottom"
      onPointerEnter={popoverIntent.keep}
      onPointerLeave={pop.mode === 'info' ? popoverIntent.closeSoon : undefined}
      ariaLabel={chord.isNone ? undefined : chord.label}
      className={pop.mode === 'edit' ? 'w-80 p-3' : 'w-64 p-3'}
    >
      {pop.mode === 'edit' ? (
        <ChordEditor key={`e${chord.index}`} chordIndex={chord.index} />
      ) : (
        <ChordInfo key={`i${chord.index}`} chordIndex={chord.index} time={pop.time} />
      )}
    </Floating>
  )
}

function ChordInfo({ chordIndex, time }: { chordIndex: number; time: number }) {
  const t = useT()
  const { chords, spelling } = useChordModel()
  const instrument = useApp((s) => s.instrument)
  const chord = chords[chordIndex]
  const { done, run } = useCopyFeedback()
  const pop = useChordUi((s) => s.popover)
  const color = chordTone(chord.rootPc, chord.quality)

  return (
    <div className="flex flex-col items-center gap-2.5">
      <div className="flex w-full items-baseline justify-between gap-2">
        <ChordName label={chord.label} none={t('chords.noChord')} className={clsx('text-3xl', chord.isNone && 'text-xl text-muted')} />
        <span className="font-mono text-xs text-faint tabular-nums">{formatTime(time)}</span>
      </div>
      {!chord.isNone && chord.confidence < 0.5 && (
        <div className="w-full text-xs text-muted">
          <span className="cw-lowconf">{t('chords.lowConfidence')}</span>
        </div>
      )}
      {!chord.isNone && (
        <div className="grid w-full place-items-center rounded-lg bg-surface py-3" style={{ boxShadow: `inset 0 2px 0 ${color}` }}>
          <ChordDiagram label={chord.label} instrument={instrument} size="md" switcher spelling={spelling} />
        </div>
      )}
      <div className="grid w-full grid-cols-3 gap-1">
        <PopButton
          icon={done ? <Check size={15} className="text-success" /> : <Copy size={15} />}
          label={t('chords.popover.copy')}
          disabled={chord.isNone}
          onClick={() => run(() => copyChordName(chord.label))}
        />
        <PopButton
          icon={<Pencil size={15} />}
          label={t('chords.popover.edit')}
          onClick={() => pop && useChordUi.getState().openPopover({ ...pop, mode: 'edit' })}
        />
        <PopButton icon={<Play size={15} />} label={t('chords.popover.play')} onClick={() => useApp.getState().seek(time)} />
      </div>
    </div>
  )
}

function PopButton({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick(): void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] text-muted transition-colors hover:bg-surface-3 hover:text-text disabled:opacity-35"
    >
      {icon}
      {label}
    </button>
  )
}

/** Inline editor: type a chord (display spelling, current transpose), autocomplete, Enter saves. */
function ChordEditor({ chordIndex }: { chordIndex: number }) {
  const t = useT()
  const model = useChordModel()
  const chord = model.chords[chordIndex]
  const close = useChordUi((s) => s.closePopover)
  const [value, setValue] = useState(chord.isNone ? '' : chord.label)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const pool = useMemo(() => {
    const song = model.unique.map((u) => u.label)
    const rest = allChordNames(model.spelling).filter((c) => !song.includes(c))
    return [...song, ...rest]
  }, [model.unique, model.spelling])

  const suggestions = useMemo(() => {
    const q = value.trim()
    if (!q) return model.unique.slice(0, 8).map((u) => u.label)
    const parsed = parseChord(q)
    const head = q.charAt(0).toUpperCase() + q.slice(1)
    const starts = pool.filter((c) => c.startsWith(head))
    const out = parsed && !starts.includes(q) ? [q, ...starts] : starts
    return out.slice(0, 8)
  }, [value, pool, model.unique])

  const valid = isNoChordLabel(value) || !!parseChord(value)

  const save = (raw: string) => {
    const canonical = toCanonical(raw, model.transpose)
    if (!canonical) return
    const parsed = parseChord(raw)
    const display = parsed ? formatChord(parsed, model.spelling) : 'N'
    close()
    void editChord(chord.srcStart, chord.srcEnd, canonical, display)
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const typed = value.trim()
        const pick = suggestions[active]
        if (active > 0 && pick) save(pick)
        else if (typed && valid) save(typed)
        else if (pick) save(pick)
      }}
      className="flex flex-col gap-2"
    >
      <label className="text-xs text-muted" htmlFor="cw-chord-edit">
        {t('chords.edit.title')}{' '}
        <ChordName label={chord.label} none={t('chords.noChord')} className="text-sm text-text" />
      </label>
      <input
        id="cw-chord-edit"
        ref={input}
        value={value}
        autoComplete="off"
        spellCheck={false}
        placeholder={t('chords.edit.placeholder')}
        aria-invalid={!!value.trim() && !valid}
        aria-autocomplete="list"
        aria-controls="cw-chord-suggest"
        onChange={(e) => {
          setValue(e.target.value)
          setActive(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => Math.min(suggestions.length - 1, i + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(0, i - 1))
          } else if (e.key === 'Tab' && suggestions[active]) {
            e.preventDefault()
            setValue(suggestions[active])
          }
        }}
        className={clsx(
          'h-11 w-full rounded-lg border bg-surface px-3 font-display text-xl font-semibold outline-none',
          value.trim() && !valid ? 'border-danger' : 'border-border-strong focus:border-accent',
        )}
      />
      <div className={clsx('h-4 text-xs', value.trim() && !valid ? 'text-danger' : 'text-faint')} aria-live="polite">
        {value.trim() && !valid ? t('chords.edit.invalid') : t('chords.edit.hint')}
      </div>
      <ul id="cw-chord-suggest" role="listbox" className="grid grid-cols-4 gap-1">
        {suggestions.map((s, i) => (
          <li key={s} role="option" aria-selected={i === active}>
            <button
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => save(s)}
              className={clsx(
                'h-9 w-full truncate rounded-md px-1 text-center text-base',
                i === active ? 'bg-accent-soft text-accent' : 'bg-surface text-text hover:bg-surface-3',
              )}
            >
              <ChordName label={s} />
            </button>
          </li>
        ))}
        <li className="col-span-4">
          <button
            type="button"
            onClick={() => save('N')}
            className="h-8 w-full rounded-md bg-surface text-xs text-muted hover:bg-surface-3 hover:text-text"
          >
            {t('chords.edit.noChord')}
          </button>
        </li>
      </ul>
      <div className="mt-1 flex items-center justify-end gap-2">
        <div className="flex gap-1">
          <button type="button" onClick={close} className="h-8 rounded-md px-3 text-sm text-muted hover:bg-surface-3 hover:text-text">
            {t('chords.edit.cancel')}
          </button>
          <button
            type="submit"
            disabled={!value.trim() || !valid}
            className="h-8 rounded-md bg-accent px-3 text-sm font-semibold text-accent-fg disabled:opacity-40"
          >
            {t('chords.edit.save')}
          </button>
        </div>
      </div>
    </form>
  )
}

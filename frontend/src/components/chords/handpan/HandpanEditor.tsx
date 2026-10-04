// "My handpan" editor: ding + 7–14 tone fields in physical order (clockwise from the field nearest
// the player), with a live preview, reordering, a free-text note list and preset templates.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowDown, ArrowUp, Plus, RotateCcw, X } from 'lucide-react'
import { useT } from '../../../i18n'
import {
  CUSTOM_SCALE_ID,
  DEFAULT_HANDPAN_NOTES,
  HANDPAN_PRESETS,
  MAX_TONES,
  MIN_TONES,
  NOTE_NAMES,
  OCTAVES,
  customScale,
  describeScale,
  formatHandpanNote,
  parseNotesText,
  presetScale,
  validateNotes,
  type HandpanNote,
  type NotesValidation,
} from '../../../lib/handpan'
import { useApp } from '../../../store'
import { Modal } from '../../ui/Modal'
import { HandpanChart } from '../diagrams/HandpanChart'
import { IconButton } from '../ui/controls'
import { useHandpanEditor } from './editorStore'
import { Select } from './HandpanScaleControls'

interface Row {
  /** stable React key across reorders */
  id: number
  name: string
  octave: number | null
}

let rowSeq = 1
const toRows = (notes: readonly HandpanNote[]): Row[] => notes.map((n) => ({ id: rowSeq++, name: n.name, octave: n.octave }))
const rowString = (r: Row) => (r.octave == null ? r.name : `${r.name}${r.octave}`)

/** Mounted once (by the hero hint); opened from the hint or the settings menu. */
export function HandpanEditorHost() {
  const t = useT()
  const open = useHandpanEditor((s) => s.open)
  const hide = useHandpanEditor((s) => s.hide)
  return (
    <Modal open={open} onClose={hide} title={t('handpan.edit.title')} width="max-w-xl">
      <HandpanEditor onDone={hide} />
    </Modal>
  )
}

function HandpanEditor({ onDone }: { onDone(): void }) {
  const t = useT()
  const uid = useId()
  const stored = useApp((s) => s.handpanNotes)
  const [rows, setRows] = useState<Row[]>(() => toRows(customScale(stored).notes))
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [focused, setFocused] = useState<number | null>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  const pendingFocus = useRef<string | null>(null)

  const scale = useMemo(() => customScale(rows.map(rowString)), [rows])
  const tones = rows.length - 1
  const strings = rows.map(rowString)
  const text = draft ?? `${strings[0]} | ${strings.slice(1).join(' ')}`
  const elId = (kind: string, i: number) => `${uid}-${kind}${i}`

  useEffect(() => {
    if (!pendingFocus.current) return
    document.getElementById(pendingFocus.current)?.focus()
    pendingFocus.current = null
  }, [rows])

  const fieldName = (i: number) => (i === 0 ? t('handpan.edit.ding') : t('handpan.edit.field', { n: i }))

  const errorText = (v: Extract<NotesValidation, { ok: false }>) => {
    switch (v.error) {
      case 'empty':
        return t('handpan.error.empty')
      case 'badNote':
        return t('handpan.error.badNote', { token: v.token ?? '' })
      case 'tooFew':
        return t('handpan.error.tooFew', { min: MIN_TONES })
      default:
        return t('handpan.error.tooMany', { max: MAX_TONES })
    }
  }

  const replaceAll = (notes: readonly HandpanNote[]) => {
    setRows(toRows(notes))
    setDraft(null)
    setError(null)
  }

  const update = (i: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
    setDraft(null)
  }

  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 1 || j >= rows.length) return
    const next = [...rows]
    ;[next[i], next[j]] = [next[j], next[i]]
    // keep the keyboard on the same arrow so the field can be moved repeatedly
    const edge = (d < 0 && j === 1) || (d > 0 && j === rows.length - 1)
    pendingFocus.current = elId(edge ? (d < 0 ? 'down' : 'up') : d < 0 ? 'up' : 'down', j)
    setRows(next)
    setDraft(null)
  }

  const remove = (i: number) => {
    if (tones <= MIN_TONES) return
    pendingFocus.current = elId('note', Math.min(i, rows.length - 2))
    setRows(rows.filter((_, j) => j !== i))
    setDraft(null)
  }

  const add = () => {
    if (tones >= MAX_TONES) return
    const last = rows[rows.length - 1]
    pendingFocus.current = elId('note', rows.length)
    setRows([...rows, { id: rowSeq++, name: last.name, octave: last.octave }])
    setDraft(null)
  }

  const applyText = () => {
    if (draft == null) return
    const v = parseNotesText(draft)
    if (v.ok) replaceAll([v.ding, ...v.tones])
    else setError(errorText(v))
  }

  const save = () => {
    let notes = strings
    if (draft != null) {
      const parsed = parseNotesText(draft)
      if (!parsed.ok) {
        setError(errorText(parsed))
        document.getElementById(elId('text', 0))?.focus()
        return
      }
      notes = [parsed.ding, ...parsed.tones].map(formatHandpanNote)
    }
    const v = validateNotes(notes)
    if (!v.ok) {
      setError(errorText(v))
      return
    }
    const app = useApp.getState()
    app.setSetting('handpanNotes', notes)
    app.setSetting('handpanScale', CUSTOM_SCALE_ID)
    app.toast(t('handpan.edit.saved'))
    onDone()
  }

  const highlight = hovered ?? focused

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted">{t('handpan.edit.intro')}</p>

      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:gap-6">
        <div className="flex shrink-0 flex-col items-center gap-2 sm:sticky sm:top-0">
          <HandpanChart
            scale={scale}
            roles={null}
            color="var(--accent)"
            width={176}
            title={t('handpan.edit.preview', { notes: describeScale(scale) })}
            labels="all"
            octaves
            highlight={highlight}
            onFieldClick={(i) => document.getElementById(elId('note', i))?.focus()}
          />
          <span className="text-xs text-faint tabular-nums">{t('handpan.edit.count', { n: tones, min: MIN_TONES, max: MAX_TONES })}</span>
        </div>

        <ol className="flex w-full min-w-0 flex-col gap-0.5" aria-label={t('handpan.edit.title')}>
          {rows.map((r, i) => (
            <li
              key={r.id}
              className={clsx('flex items-center gap-1.5 rounded-lg px-1.5 py-1 transition-colors', highlight === i && 'bg-surface-2')}
              onFocusCapture={() => setFocused(i)}
              onBlurCapture={() => setFocused(null)}
              onPointerEnter={() => setHovered(i)}
              onPointerLeave={() => setHovered(null)}
            >
              <span
                className={clsx(
                  'w-10 shrink-0 text-xs tabular-nums',
                  i === 0 ? 'font-semibold text-accent' : 'pl-1 font-mono text-faint',
                )}
              >
                {i === 0 ? t('handpan.edit.ding') : i}
              </span>
              <Select
                id={elId('note', i)}
                aria-label={t('handpan.edit.noteOf', { field: fieldName(i) })}
                value={r.name}
                onChange={(e) => update(i, { name: e.target.value })}
                className="h-8 w-[4.6rem] border border-border bg-surface-2 pl-2.5 font-display text-sm font-semibold hover:border-border-strong"
              >
                {(NOTE_NAMES as readonly string[]).includes(r.name) ? null : <option value={r.name}>{r.name}</option>}
                {NOTE_NAMES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={t('handpan.edit.octaveOf', { field: fieldName(i) })}
                title={t('handpan.edit.octave')}
                value={r.octave == null ? '' : String(r.octave)}
                onChange={(e) => update(i, { octave: e.target.value === '' ? null : Number(e.target.value) })}
                className="h-8 w-[4.1rem] border border-border bg-surface-2 pl-2.5 font-mono text-xs text-muted hover:border-border-strong"
              >
                <option value="">{t('handpan.edit.octaveNone')}</option>
                {r.octave != null && !(OCTAVES as readonly number[]).includes(r.octave) && <option value={String(r.octave)}>{r.octave}</option>}
                {OCTAVES.map((o) => (
                  <option key={o} value={String(o)}>
                    {o}
                  </option>
                ))}
              </Select>
              {i > 0 && (
                <span className="ml-auto flex shrink-0 items-center">
                  <IconButton id={elId('up', i)} size="sm" label={t('handpan.edit.up', { field: fieldName(i) })} disabled={i === 1} onClick={() => move(i, -1)}>
                    <ArrowUp size={14} />
                  </IconButton>
                  <IconButton
                    id={elId('down', i)}
                    size="sm"
                    label={t('handpan.edit.down', { field: fieldName(i) })}
                    disabled={i === rows.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown size={14} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label={t('handpan.edit.remove', { field: fieldName(i) })}
                    disabled={tones <= MIN_TONES}
                    onClick={() => remove(i)}
                    className="hover:text-danger"
                  >
                    <X size={14} />
                  </IconButton>
                </span>
              )}
            </li>
          ))}
          <li className="pt-1">
            <button
              type="button"
              onClick={add}
              disabled={tones >= MAX_TONES}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted transition-colors hover:bg-surface-3 hover:text-text disabled:pointer-events-none disabled:opacity-40"
            >
              <Plus size={14} />
              {t('handpan.edit.add')}
            </button>
          </li>
        </ol>
      </div>

      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          applyText()
        }}
      >
        <label htmlFor={elId('text', 0)} className="text-xs font-medium text-muted">
          {t('handpan.edit.list')}
        </label>
        <div className="flex gap-2">
          <input
            id={elId('text', 0)}
            value={text}
            onChange={(e) => {
              setDraft(e.target.value)
              setError(null)
            }}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="characters"
            aria-invalid={!!error}
            aria-describedby={elId('hint', 0)}
            className={clsx(
              'h-9 min-w-0 flex-1 rounded-lg border bg-surface-2 px-3 font-mono text-sm outline-none',
              error ? 'border-danger' : 'border-border-strong focus:border-accent',
            )}
          />
          <button
            type="submit"
            disabled={draft == null}
            className="h-9 shrink-0 rounded-lg bg-surface-3 px-3 text-sm font-medium text-text transition-colors hover:bg-border-strong disabled:opacity-40"
          >
            {t('handpan.edit.apply')}
          </button>
        </div>
        <p id={elId('hint', 0)} aria-live="polite" className={clsx('text-xs', error ? 'text-danger' : 'text-faint')}>
          {error ?? t('handpan.edit.listHint')}
        </p>
      </form>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={elId('preset', 0)} className="text-xs font-medium text-muted">
          {t('handpan.edit.fromPreset')}
        </label>
        <Select
          id={elId('preset', 0)}
          value=""
          onChange={(e) => {
            const s = e.target.value ? presetScale(e.target.value) : null
            if (s) replaceAll(s.notes)
          }}
          wrapClassName="w-full sm:w-auto sm:self-start"
          className="h-9 w-full border border-border bg-surface-2 pl-3 text-sm hover:border-border-strong"
        >
          <option value="">{t('handpan.edit.fromPresetPlaceholder')}</option>
          {HANDPAN_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.ding} | {p.tones.join(' ')}
            </option>
          ))}
        </Select>
      </div>

      <div className="sticky bottom-[-1rem] -mx-5 -mb-4 flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface px-5 py-3">
        <button
          type="button"
          onClick={() => replaceAll(customScale(DEFAULT_HANDPAN_NOTES).notes)}
          title={t('handpan.edit.resetTitle', { notes: `${DEFAULT_HANDPAN_NOTES[0]} | ${DEFAULT_HANDPAN_NOTES.slice(1).join(' ')}` })}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted transition-colors hover:bg-surface-3 hover:text-text"
        >
          <RotateCcw size={14} />
          {t('handpan.edit.reset')}
        </button>
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onDone} className="h-9 rounded-lg px-3 text-sm text-muted transition-colors hover:bg-surface-3 hover:text-text">
            {t('handpan.edit.cancel')}
          </button>
          <button type="button" onClick={save} className="h-9 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg transition-opacity hover:opacity-90">
            {t('handpan.edit.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

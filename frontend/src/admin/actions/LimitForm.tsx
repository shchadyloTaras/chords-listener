import { useId, useState, type FormEvent } from 'react'
import { Button } from '../../components/ui/IconButton'
import * as adminApi from '../../lib/adminApi'
import { adminErrorMessage, AdminApiError } from '../../lib/adminApi'
import type { AdminAccountState, AdminPersonalLimit, AdminPersonalLimitInput } from '../../types'

// The personal-limit form (US-08, AC-13 / AC-14). Every invalid field says what is allowed right beside it: from the
// checks made here before anything is sent, and from the server's `details.fields` (422 `invalid_value`) when it
// disagrees. Nothing is saved while any field is invalid.

type NumberField = 'analyses' | 'vocals' | 'jobs'
type FieldName = NumberField | 'until'

const NUMBER_FIELDS: ReadonlyArray<{ name: NumberField; label: string; min: number; max: number }> = [
  { name: 'analyses', label: 'Аналізи на добу', min: 1, max: 1000 },
  { name: 'vocals', label: 'Транскрипції вокалу на добу', min: 1, max: 150 },
  { name: 'jobs', label: 'Одночасні задачі', min: 1, max: 4 },
]

const UNTIL_LABEL = 'Остання доба дії (UTC)'
const UNTIL_RULE = 'не раніше за сьогодні (UTC); це останній день дії ліміту включно'
const NONE_FILLED = 'Задайте хоча б одне число: аналізи, транскрипції вокалу або одночасні задачі'

const rangeOf = (f: { min: number; max: number }) => `ціле від ${f.min} до ${f.max}`
const FIELD_NAMES: readonly string[] = [...NUMBER_FIELDS.map((f) => f.name), 'until']

/** The calls the form makes (replaceable in tests). */
export type LimitApi = Pick<typeof adminApi, 'setPersonalLimit'>

type Draft = Record<FieldName, string>

const draftOf = (limit: AdminPersonalLimit | null): Draft => ({
  analyses: limit?.analyses == null ? '' : String(limit.analyses),
  vocals: limit?.vocals == null ? '' : String(limit.vocals),
  jobs: limit?.jobs == null ? '' : String(limit.jobs),
  until: limit?.until ?? '',
})

/** Today as a UTC date, "2026-10-08": the day a limit may end on at the earliest (AC-14). */
const todayUtc = () => new Date().toISOString().slice(0, 10)

/** The request when every filled field is valid; otherwise what is wrong, per field (and `none` when nothing is filled). */
function parseLimit(draft: Draft, today: string = todayUtc()): { value: AdminPersonalLimitInput } | { errors: Partial<Record<FieldName, string>>; none: boolean } {
  const errors: Partial<Record<FieldName, string>> = {}
  const value: AdminPersonalLimitInput = {}
  for (const f of NUMBER_FIELDS) {
    const raw = draft[f.name].trim()
    if (raw === '') continue
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN
    if (Number.isInteger(n) && n >= f.min && n <= f.max) value[f.name] = n
    else errors[f.name] = `Допустимі значення: ${rangeOf(f)}`
  }
  const until = draft.until.trim()
  if (until !== '') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(until) && until >= today) value.until = until
    else errors.until = `Допустима дата: ${UNTIL_RULE}`
  }
  const none = NUMBER_FIELDS.every((f) => draft[f.name].trim() === '')
  if (none || Object.keys(errors).length) return { errors, none }
  return { value }
}

/** The per-field text for what the server refused: the allowed values of that field in the interface language. */
function serverFieldText(name: FieldName): string {
  if (name === 'until') return `Допустима дата: ${UNTIL_RULE}`
  const f = NUMBER_FIELDS.find((n) => n.name === name)!
  return `Допустимі значення: ${rangeOf(f)}`
}

const inputClass = 'h-10 w-full rounded-xl border border-border-strong bg-surface-3 px-3 text-sm text-text aria-[invalid=true]:border-danger'

interface LimitFormProps {
  uid: string
  /** the limit now in force (or ended), to start from; null when there is none */
  current: AdminPersonalLimit | null
  api?: LimitApi
  onSaved(account: AdminAccountState): void
  onCancel(): void
}

export function LimitForm({ uid, current, api = adminApi, onSaved, onCancel }: LimitFormProps) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(current))
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({})
  const [general, setGeneral] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const ids = useId()

  const edit = (name: FieldName, value: string) => {
    setDraft((d) => ({ ...d, [name]: value }))
    setErrors((e) => ({ ...e, [name]: undefined }))
    setGeneral([])
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const parsed = parseLimit(draft)
    if (!('value' in parsed)) {
      setErrors(parsed.errors)
      setGeneral(parsed.none ? [NONE_FILLED] : [])
      return
    }
    setErrors({})
    setGeneral([])
    setBusy(true)
    try {
      onSaved(await api.setPersonalLimit(uid, parsed.value))
    } catch (err) {
      const fieldErrors: Partial<Record<FieldName, string>> = {}
      const rest: string[] = [adminErrorMessage(err)]
      if (err instanceof AdminApiError) {
        for (const [name, message] of Object.entries(err.fields)) {
          if (FIELD_NAMES.includes(name)) fieldErrors[name as FieldName] = serverFieldText(name as FieldName)
          else rest.push(message)
        }
      }
      setErrors(fieldErrors)
      setGeneral(rest)
      setBusy(false)
    }
  }

  const inputs: ReadonlyArray<{ name: FieldName; label: string; hint: string; type: 'text' | 'date' }> = [
    ...NUMBER_FIELDS.map((f) => ({
      name: f.name,
      label: f.label,
      hint: `${rangeOf(f)}; порожньо — як за замовчуванням`,
      type: 'text' as const,
    })),
    { name: 'until', label: UNTIL_LABEL, hint: `${UNTIL_RULE}; порожньо — без кінцевої дати`, type: 'date' as const },
  ]

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <p className="text-sm text-muted">Задайте хоча б одне число; незадане стежить за типовим лімітом. Новий ліміт замінює попередній.</p>
      {inputs.map((f) => {
        const id = `${ids}-${f.name}`
        const err = errors[f.name]
        return (
          <div key={f.name}>
            <label htmlFor={id} className="mb-1 block text-sm font-medium text-text">
              {f.label}
            </label>
            <input
              id={id}
              type={f.type}
              inputMode={f.type === 'text' ? 'numeric' : undefined}
              autoComplete="off"
              min={f.type === 'date' ? todayUtc() : undefined}
              value={draft[f.name]}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? `${id}-hint ${id}-error` : `${id}-hint`}
              onChange={(e) => edit(f.name, e.target.value)}
              className={inputClass}
            />
            <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
              {f.hint}
            </p>
            {err && (
              <p id={`${id}-error`} className="mt-1 text-xs text-danger">
                {err}
              </p>
            )}
          </div>
        )
      })}
      {general.length > 0 && (
        <div role="alert" className="space-y-1 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {general.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={busy}>
          Скасувати
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          Зберегти ліміт
        </Button>
      </div>
    </form>
  )
}

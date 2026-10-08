import { useState } from 'react'
import { Button } from '../../components/ui/IconButton'
import { useT } from '../../i18n'
import { adminErrorMessage, listJobHistory } from '../../lib/adminApi'
import type { AdminFailureReason, AdminHistoryStatus, AdminJobFilters, AdminJobHistoryItem, AdminJobHistoryPage, AdminOrigin, AdminPaging } from '../../types'
import { useAdminData } from '../useAdminData'
import { Field, fieldClass, PeriodInputs, PeriodRule } from './PeriodInputs'
import { ORIGIN_LABEL, REASONS } from './labels'
import { isValidPeriod, lastDays, PERIOD_RULE } from './period'

type Load = (filters: AdminJobFilters, paging: AdminPaging, signal: AbortSignal) => Promise<AdminJobHistoryPage>

const STATUS_LABEL: Record<AdminHistoryStatus, string> = { running: 'Виконується', done: 'Успішна', error: 'Невдала' }
const KIND_LABEL = { analysis: 'Аналіз', vocals: 'Вокал' } as const

interface Draft {
  status: '' | AdminHistoryStatus
  reason: '' | AdminFailureReason
  origin: '' | AdminOrigin
  from: string
  to: string
}

/** Empty fields are left out of the request; an open end of the period is allowed (the history is kept 90 days). */
function toFilters(d: Draft): AdminJobFilters {
  const f: AdminJobFilters = {}
  if (d.status) f.status = d.status
  if (d.reason) f.reason = d.reason
  if (d.origin) f.origin = d.origin
  if (d.from) f.from = d.from
  if (d.to) f.to = d.to
  return f
}

function periodOk(d: Draft): boolean {
  if (d.from && d.to) return isValidPeriod(d.from, d.to)
  return !(d.from || d.to) || isValidPeriod(d.from || d.to, d.from || d.to)
}

/** "2026-10-08 09:00" in UTC, the same for every admin whatever their time zone. */
const when = (iso: string) => iso.slice(0, 16).replace('T', ' ')

function Who({ item }: { item: AdminJobHistoryItem }) {
  if (item.userDeleted) return <span className="text-muted">Користувача видалено</span>
  if (item.service) return <span className="text-muted">Службова задача</span>
  return <span>{item.email ?? item.uid}</span>
}

function Results({ filters, load }: { filters: AdminJobFilters; load: Load }) {
  const t = useT()
  // cursors of the pages left behind: «Назад» returns to the last one
  const [trail, setTrail] = useState<(string | undefined)[]>([])
  const after = trail.length ? trail[trail.length - 1] : undefined
  const key = JSON.stringify([filters, trail])
  const { data, error, loading, refresh } = useAdminData((signal) => load(filters, after ? { after } : {}, signal), key)

  const counts = REASONS.filter((r) => (data?.countsByReason[r] ?? 0) > 0)
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="sm" disabled={loading} onClick={refresh}>
          Оновити
        </Button>
        {loading && <span className="text-xs text-muted">Завантаження…</span>}
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {adminErrorMessage(error, t)}
        </p>
      )}
      {data && (
        <>
          <ul aria-label="Кількість за причинами" className="flex flex-wrap gap-2">
            {counts.length === 0 && <li className="text-sm text-muted">Невдалих задач немає</li>}
            {counts.map((r) => (
              <li key={r} className="rounded-full border border-border bg-surface-2 px-3 py-1 text-sm">
                {t(`admin.reason.${r}`)} <b className="ml-1 tabular-nums">{data.countsByReason[r]}</b>
              </li>
            ))}
          </ul>
          {data.items.length === 0 ? (
            <p className="text-sm text-muted">Задач за цими умовами немає</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[56rem] text-left text-sm">
                <thead className="bg-surface-2 text-xs text-muted">
                  <tr>
                    {['Користувач', 'Час (UTC)', 'Джерело', 'Вид', 'Результат', 'Причина збою', 'Текст помилки', 'Пісня'].map((h) => (
                      <th key={h} scope="col" className="px-3 py-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.items.map((j) => (
                    <tr key={j.id} className="align-top">
                      <td className="px-3 py-2">
                        <Who item={j} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{when(j.acceptedAt)}</td>
                      <td className="px-3 py-2">{ORIGIN_LABEL[j.origin]}</td>
                      <td className="px-3 py-2">{KIND_LABEL[j.kind]}</td>
                      <td className="px-3 py-2">{STATUS_LABEL[j.status]}</td>
                      <td className="px-3 py-2">{j.reason ? t(`admin.reason.${j.reason}`) : '—'}</td>
                      {/* user-supplied text: always a text node, never markup */}
                      <td className="max-w-xs break-words px-3 py-2 text-muted">{j.errorText ?? '—'}</td>
                      <td className="max-w-xs break-words px-3 py-2">{j.title ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={trail.length === 0} onClick={() => setTrail((s) => s.slice(0, -1))}>
              Назад
            </Button>
            <Button variant="secondary" size="sm" disabled={!data.hasNext || !data.nextCursor} onClick={() => setTrail((s) => [...s, data.nextCursor ?? undefined])}>
              Далі
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * «Задачі» (AC-07, AC-09): the history of cloud jobs of all users, filtered by result, reason, source and period,
 * with the number of jobs per failure reason. A period that is reversed or longer than 90 days is not requested.
 */
export function Jobs({ load = listJobHistory }: { load?: Load }) {
  const t = useT()
  const [draft, setDraft] = useState<Draft>(() => ({ status: '', reason: '', origin: '', ...lastDays(7) }))
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const ok = periodOk(draft)
  const filters = toFilters(draft)

  return (
    <section aria-label="Задачі" className="space-y-4 px-4 py-6">
      <h1 className="text-lg font-semibold">Історія задач</h1>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Результат">
          <select aria-label="Результат" className={fieldClass} value={draft.status} onChange={(e) => set({ status: e.target.value as Draft['status'] })}>
            <option value="">Усі</option>
            {(Object.keys(STATUS_LABEL) as AdminHistoryStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Причина збою">
          <select aria-label="Причина" className={fieldClass} value={draft.reason} onChange={(e) => set({ reason: e.target.value as Draft['reason'] })}>
            <option value="">Усі</option>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`admin.reason.${r}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Джерело">
          <select aria-label="Джерело" className={fieldClass} value={draft.origin} onChange={(e) => set({ origin: e.target.value as Draft['origin'] })}>
            <option value="">Усі</option>
            {(Object.keys(ORIGIN_LABEL) as AdminOrigin[]).map((o) => (
              <option key={o} value={o}>
                {ORIGIN_LABEL[o]}
              </option>
            ))}
          </select>
        </Field>
        <PeriodInputs from={draft.from} to={draft.to} onChange={set} />
      </div>
      {ok ? <Results key={JSON.stringify(filters)} filters={filters} load={load} /> : <PeriodRule text={PERIOD_RULE} />}
    </section>
  )
}

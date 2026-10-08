import { useMemo, useState } from 'react'
import { Button } from '../../components/ui/IconButton'
import { useAdminT } from '../ui'
import { adminErrorMessage, getStats } from '../../lib/adminApi'
import type { AdminStatsDay, AdminStatsRange } from '../../types'
import { useAdminData } from '../useAdminData'
import { PeriodInputs, PeriodRule } from './PeriodInputs'
import { REASONS } from './labels'
import { daysOf, isValidPeriod, lastDays, PERIOD_RULE, utcToday } from './period'

type Load = (from: string, to: string, signal: AbortSignal) => Promise<AdminStatsRange>

const PRESETS = [7, 30, 90] as const
const DEFAULT_DAYS = 30
const HEADERS = ['День', 'Посилання', 'Файл', 'Мікрофон', 'Вкладка', 'Вокал', 'Невдалі', 'Причини збоїв', 'Активні', 'Нові']

/** A day the server has no record of: nothing happened (the contract omits such days). */
const emptyDay = (day: string): AdminStatsDay => ({
  day,
  state: 'frozen',
  analyses: { link: 0, file: 0, mic: 0, tab: 0 },
  vocals: 0,
  failed: 0,
  failedByReason: {},
  active: 0,
  newUsers: 0,
  restoredTracks: null,
  frozenAt: null,
})

const num = 'px-3 py-2 text-right tabular-nums'

function RestoredRow({ day }: { day: AdminStatsDay }) {
  const r = day.restoredTracks
  return (
    <tr className="bg-surface-2/50 align-top">
      <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-normal tabular-nums">
        {day.day}
      </th>
      {/* before the launch only the songs added per source are known: no failure, user or quota columns */}
      <td colSpan={HEADERS.length - 1} className="px-3 py-2">
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">відновлено з пісень</span>
        {r && (
          <span className="ml-3 text-muted">
            Пісень додано: YouTube <b className="tabular-nums text-text">{r.youtube}</b> · Посилання <b className="tabular-nums text-text">{r.url}</b> · Файл{' '}
            <b className="tabular-nums text-text">{r.file}</b>
          </span>
        )}
      </td>
    </tr>
  )
}

function LiveRow({ day }: { day: AdminStatsDay }) {
  const t = useAdminT()
  const reasons = REASONS.filter((r) => (day.failedByReason[r] ?? 0) > 0)
  return (
    <tr className="align-top">
      <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-normal tabular-nums">
        {day.day}
        {day.state === 'live' && <span className="ml-2 text-xs text-muted">триває</span>}
      </th>
      <td className={num}>{day.analyses.link}</td>
      <td className={num}>{day.analyses.file}</td>
      <td className={num}>{day.analyses.mic}</td>
      <td className={num}>{day.analyses.tab}</td>
      <td className={num}>{day.vocals}</td>
      <td className={num}>{day.failed}</td>
      <td className="px-3 py-2 text-muted">
        {reasons.length === 0 ? '—' : reasons.map((r) => `${t(`admin.reason.${r}`)} ${day.failedByReason[r]}`).join(', ')}
      </td>
      <td className={num}>{day.active}</td>
      <td className={num}>{day.newUsers ?? '—'}</td>
    </tr>
  )
}

function Days({ from, to, load }: { from: string; to: string; load: Load }) {
  const t = useAdminT()
  const { data, error, loading, refresh } = useAdminData((signal) => load(from, to, signal), `${from}|${to}`)
  // one row per day of the period, newest first
  const rows = useMemo(() => {
    if (!data) return []
    const byDay = new Map(data.days.map((d) => [d.day, d]))
    return daysOf(from, to)
      .reverse()
      .map((day) => byDay.get(day) ?? emptyDay(day))
  }, [data, from, to])

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
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[56rem] text-sm">
            <caption className="sr-only">Денна статистика за період</caption>
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                {HEADERS.map((h, i) => (
                  <th key={h} scope="col" className={i === 0 || i === 7 ? 'px-3 py-2 text-left font-medium' : 'px-3 py-2 text-right font-medium'}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((d) => (d.state === 'restored' ? <RestoredRow key={d.day} day={d} /> : <LiveRow key={d.day} day={d} />))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * «Статистика» (AC-08, AC-09): one row per UTC day of the chosen period (default: the last 30 days). Days before
 * the launch are labelled «відновлено з пісень» and carry only the songs added per source. A period that is
 * reversed or longer than 90 days is not requested: the rule is explained instead.
 */
export function Stats({ load = getStats, today = utcToday() }: { load?: Load; today?: string }) {
  const [period, setPeriod] = useState(() => lastDays(DEFAULT_DAYS, today))
  const ok = isValidPeriod(period.from, period.to)

  return (
    <section aria-label="Статистика" className="space-y-4 px-4 py-6">
      <h1 className="text-lg font-semibold">Денна статистика</h1>
      <div className="flex flex-wrap items-end gap-3">
        <PeriodInputs from={period.from} to={period.to} onChange={setPeriod} />
        <div className="flex gap-2">
          {PRESETS.map((n) => (
            <Button key={n} variant="secondary" size="sm" onClick={() => setPeriod(lastDays(n, today))}>
              {n} днів
            </Button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted">Період — не довше 90 днів, кінець не раніше початку. Дні рахуються за UTC.</p>
      {ok ? <Days from={period.from} to={period.to} load={load} /> : <PeriodRule text={PERIOD_RULE} />}
    </section>
  )
}

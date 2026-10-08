import clsx from 'clsx'
import type { ReactNode } from 'react'
import { Button } from '../../components/ui/IconButton'
import { useT } from '../../i18n'
import { adminErrorMessage, getOverview } from '../../lib/adminApi'
import type { AdminFailureReason, AdminJobKind, AdminOrigin, AdminOverview, AdminSwitchName } from '../../types'
import { useAdminData } from '../useAdminData'

// The admin page is Ukrainian-only (like its menu): the admin is the owner. Failure reasons come from the
// dictionary (admin.reason.*), shared with the other screens.
const ORIGINS: ReadonlyArray<{ origin: AdminOrigin; label: string }> = [
  { origin: 'link', label: 'Посилання' },
  { origin: 'file', label: 'Файл' },
  { origin: 'mic', label: 'Мікрофон' },
  { origin: 'tab', label: 'Вкладка' },
]
const ORIGIN_LABEL = Object.fromEntries(ORIGINS.map((o) => [o.origin, o.label])) as Record<AdminOrigin, string>
const KIND_LABEL: Record<AdminJobKind, string> = { analysis: 'Аналіз', vocals: 'Вокал' }
const SWITCHES: ReadonlyArray<{ name: AdminSwitchName; label: string }> = [
  { name: 'analysesPaused', label: 'Пауза нових аналізів' },
  { name: 'youtubeEnabled', label: 'Завантаження з YouTube на сервері' },
  { name: 'vocalsEnabled', label: 'Транскрипція вокалу' },
]
const REASONS: readonly AdminFailureReason[] = [
  'youtube_blocked',
  'download_failed',
  'unsupported_format',
  'too_long',
  'too_large',
  'analysis_failed',
  'other',
]

function Card({ label, value, id, children }: { label: string; value: number | string; id: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface-1 p-4">
      <div className="text-sm text-muted">{label}</div>
      <div data-testid={id} className="mt-1 text-3xl font-semibold tabular-nums text-text">
        {value}
      </div>
      {children}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-medium text-muted">{title}</h2>
      {children}
    </section>
  )
}

function time(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(11, 16)
}

function Totals({ data }: { data: AdminOverview }) {
  const t = useT()
  const analysesTotal = ORIGINS.reduce((sum, o) => sum + data.analyses[o.origin], 0)
  const reasons = REASONS.filter((r) => (data.failedByReason[r] ?? 0) > 0)
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Card label="Аналізи" value={analysesTotal} id="analyses-total">
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {ORIGINS.map((o) => (
            <div key={o.origin} className="flex justify-between gap-2">
              <dt className="text-muted">{o.label}</dt>
              <dd data-testid={`analyses-${o.origin}`} className="tabular-nums text-text">
                {data.analyses[o.origin]}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card label="Транскрипції вокалу" value={data.vocals} id="vocals" />
      <Card label="Невдалі задачі" value={data.failed} id="failed">
        {reasons.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {reasons.map((r) => (
              <li key={r} className="flex justify-between gap-2">
                <span className="text-muted">{t(`admin.reason.${r}`)}</span>
                <span className="tabular-nums text-text">{data.failedByReason[r]}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card label="Активні користувачі" value={data.active} id="active" />
      <Card label="Нові користувачі" value={data.newUsers} id="new-users" />
    </div>
  )
}

function RunningJobs({ jobs }: { jobs: AdminOverview['runningJobs'] }) {
  if (jobs.length === 0) return <p className="text-sm text-muted">Зараз нічого не виконується</p>
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface-1">
      <table className="w-full text-left text-sm">
        <thead className="text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Користувач</th>
            <th className="px-4 py-2 font-medium">Задача</th>
            <th className="px-4 py-2 font-medium">Джерело</th>
            <th className="px-4 py-2 font-medium">Прийнято (UTC)</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} data-testid="running-job" className="border-t border-border">
              <td className="px-4 py-2 break-all">{job.service ? 'обліковий запис сервісу' : (job.email ?? job.uid)}</td>
              <td className="px-4 py-2">{KIND_LABEL[job.kind]}</td>
              <td className="px-4 py-2">{ORIGIN_LABEL[job.origin]}</td>
              <td className="px-4 py-2 tabular-nums">{time(job.acceptedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SwitchStates({ switches }: { switches: AdminOverview['switches'] }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {SWITCHES.map(({ name, label }) => {
        const on = switches[name]
        return (
          <li
            key={name}
            data-testid={`switch-${name}`}
            data-state={on ? 'on' : 'off'}
            className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-1 px-4 py-3 text-sm"
          >
            <span className="text-text">{label}</span>
            <span className={clsx('font-medium', on ? 'text-success' : 'text-muted')}>{on ? 'Увімкнено' : 'Вимкнено'}</span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The «Огляд» screen (AC-01): the totals of the current UTC day, the running jobs and the state of each service
 * switch. It loads when opened and on «Оновити» (and on a tab return after a minute — useAdminData); it never polls
 * (AC-02), so an idle open tab lets the cloud server sleep.
 */
export function Overview() {
  const { data, error, loading, refresh } = useAdminData(getOverview, 'overview')
  return (
    <div className="px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Огляд</h1>
          {data && <p className="text-sm text-muted">Доба UTC: {data.day}</p>}
        </div>
        <Button variant="secondary" onClick={refresh} disabled={loading}>
          Оновити
        </Button>
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-xl border border-danger/40 px-4 py-3 text-sm text-danger">
          {adminErrorMessage(error)}
        </p>
      )}
      {!data && loading && <p className="mt-6 text-sm text-muted">Завантаження…</p>}

      {data && (
        <div aria-busy={loading}>
          <Section title="Сьогодні">
            <Totals data={data} />
          </Section>
          <Section title="Виконуються зараз">
            <RunningJobs jobs={data.runningJobs} />
          </Section>
          <Section title="Перемикачі сервісу">
            <SwitchStates switches={data.switches} />
          </Section>
        </div>
      )}
    </div>
  )
}

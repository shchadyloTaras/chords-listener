import type { ReactNode } from 'react'
import { useState } from 'react'
import { Button } from '../../components/ui/IconButton'
import { formatBytes, formatTime } from '../../components/ui/format'
import { useT } from '../../i18n'
import { adminErrorMessage, getUserCard, listUserTracks } from '../../lib/adminApi'
import type {
  AdminAccountState,
  AdminJobHistoryItem,
  AdminOrigin,
  AdminPage,
  AdminPersonalLimit,
  AdminQuotaUsage,
  AdminTrackMeta,
  AdminUserCard,
} from '../../types'
import { useAdminData } from '../useAdminData'

// The card shows metadata only (AC-06, ADR-0002): no audio, no chords, no edits — and so nothing here opens or
// plays a song. Every string that comes from a user (email, title, error, reason) is a plain text node (AC-05);
// it gets `unicode-bidi: isolate` so a right-to-left override in it cannot reorder the text around it.

const PAGE_SIZE = 50
const USER_TEXT = 'break-words [unicode-bidi:isolate]'

/** "2026-10-07 12:00 UTC": the admin works in UTC days (quota, limits, statistics). */
function formatWhen(iso: string | null): string {
  const ms = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(ms)) return '—'
  const s = new Date(ms).toISOString()
  return `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`
}

const SOURCE_LABEL: Record<AdminTrackMeta['sourceType'], string> = { youtube: 'YouTube', url: 'Посилання', file: 'Файл' }
const ORIGIN_LABEL: Record<AdminOrigin, string> = { link: 'Посилання', file: 'Файл', mic: 'Мікрофон', tab: 'Вкладка' }
const STATUS_LABEL: Record<AdminJobHistoryItem['status'], string> = { running: 'Виконується', done: 'Готово', error: 'Помилка' }
const KIND_LABEL: Record<AdminJobHistoryItem['kind'], string> = { analysis: 'Аналіз', vocals: 'Вокал' }

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-muted sm:w-48">{label}</dt>
      <dd className="min-w-0 text-text">{children}</dd>
    </div>
  )
}

function Quota({ label, usage }: { label: string; usage: AdminQuotaUsage }) {
  return (
    <Field label={label}>
      <span className={usage.used >= usage.limit ? 'text-danger' : undefined}>
        {usage.used} / {usage.limit}
      </span>
    </Field>
  )
}

function limitPart(label: string, value: number | null): string {
  return `${label}: ${value === null ? 'як за замовчуванням' : value}`
}

function PersonalLimit({ limit }: { limit: AdminPersonalLimit | null }) {
  if (!limit) return <>Немає</>
  return (
    <>
      {[limitPart('аналізи', limit.analyses), limitPart('вокал', limit.vocals), limitPart('задачі', limit.jobs)].join(' · ')}
      {' · '}
      {limit.until ? `до ${limit.until}` : 'без кінцевої дати'}
      {limit.expired && <span className="ml-2 rounded-md bg-surface-3 px-1.5 py-0.5 text-xs text-muted">завершився</span>}
    </>
  )
}

function State({ account }: { account: AdminAccountState }) {
  if (account.status === 'restricted') {
    const r = account.restriction
    return (
      <>
        Хмарне обмеження
        {r && (
          <>
            {' · з '}
            {formatWhen(r.since)}
            {' · '}
            <span className={USER_TEXT}>{r.reason}</span>
          </>
        )}
      </>
    )
  }
  if (account.status === 'deletion_scheduled') {
    const d = account.deletion
    return (
      <>
        Заплановане видалення
        {d && (
          <>
            {' · видалення після '}
            {formatWhen(d.purgeAfter)}
          </>
        )}
      </>
    )
  }
  return <>Звичайний</>
}

function RecentJobs({ jobs }: { jobs: AdminJobHistoryItem[] }) {
  const t = useT()
  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold text-text">Останні задачі</h2>
      {jobs.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Задач ще не було</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-2 text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Час</th>
                <th className="px-3 py-2 font-medium">Задача</th>
                <th className="px-3 py-2 font-medium">Джерело</th>
                <th className="px-3 py-2 font-medium">Статус</th>
                <th className="px-3 py-2 font-medium">Причина збою</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {jobs.map((j) => (
                <tr key={j.id} className="align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-muted">{formatWhen(j.acceptedAt)}</td>
                  <td className="px-3 py-2">
                    {KIND_LABEL[j.kind]}
                    {j.title !== null && <span className={`block text-muted ${USER_TEXT}`}>{j.title}</span>}
                  </td>
                  <td className="px-3 py-2">{ORIGIN_LABEL[j.origin]}</td>
                  <td className="px-3 py-2">{STATUS_LABEL[j.status]}</td>
                  <td className="px-3 py-2">
                    {j.reason && <span>{t(`admin.reason.${j.reason}`)}</span>}
                    {j.errorText !== null && <span className={`block text-muted ${USER_TEXT}`}>{j.errorText}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** The songs, newest first as the server sends them, 50 to a page. Pages already seen are kept, so «Назад» asks nothing. */
function Songs({ uid, total, first }: { uid: string; total: number; first: AdminPage<AdminTrackMeta> }) {
  const [pages, setPages] = useState<AdminPage<AdminTrackMeta>[]>([first])
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const current = pages[index]

  async function next() {
    if (!current.nextCursor) return
    if (index + 1 < pages.length) {
      setIndex(index + 1)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const page = await listUserTracks(uid, { after: current.nextCursor, limit: PAGE_SIZE })
      setPages((p) => [...p.slice(0, index + 1), page])
      setIndex(index + 1)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold text-text">Пісні · {total}</h2>
      {current.items.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Пісень немає</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-2 text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Назва</th>
                <th className="px-3 py-2 font-medium">Джерело</th>
                <th className="px-3 py-2 font-medium">Додано</th>
                <th className="px-3 py-2 font-medium">Тривалість</th>
                <th className="px-3 py-2 font-medium">Розмір</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {current.items.map((s) => (
                <tr key={s.id} className="align-top">
                  <td className={`px-3 py-2 ${USER_TEXT}`}>{s.title}</td>
                  <td className="px-3 py-2">{SOURCE_LABEL[s.sourceType]}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted">{formatWhen(s.createdAt)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{formatTime(s.duration)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{s.sizeBytes === null ? '—' : formatBytes(s.sizeBytes, 'uk')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 flex items-center gap-2 text-sm text-muted">
        <Button size="sm" disabled={busy || index === 0} onClick={() => setIndex(index - 1)}>
          Назад
        </Button>
        <span>Сторінка {index + 1}</span>
        <Button size="sm" disabled={busy || !current.hasNext} onClick={next}>
          Далі
        </Button>
      </div>
      {error !== null && (
        <p className="mt-2 text-sm text-danger" role="alert">
          {adminErrorMessage(error)}
        </p>
      )}
    </section>
  )
}

function CardBody({ card, uid, loadedAt }: { card: AdminUserCard; uid: string; loadedAt: number | null }) {
  const { profile, account } = card
  return (
    <>
      <h1 className={`text-lg font-semibold text-text ${USER_TEXT}`}>{profile.email}</h1>
      <dl className="mt-4 flex flex-col gap-2 text-sm">
        <Field label="Реєстрація">{formatWhen(profile.createdAt)}</Field>
        <Field label="Останній вхід">{formatWhen(profile.lastLoginAt)}</Field>
        <Field label="Пісень">{profile.trackCount}</Field>
        <Field label="Зайняте місце">{formatBytes(profile.storageBytes, 'uk')}</Field>
        <Quota label="Аналізи сьогодні" usage={account.quota.analyses} />
        <Quota label="Розпізнавання вокалу" usage={account.quota.vocals} />
        <Quota label="Одночасні задачі" usage={account.quota.jobs} />
        <Field label="Персональний ліміт">
          <PersonalLimit limit={account.personalLimit} />
        </Field>
        <Field label="Стан">
          <State account={account} />
        </Field>
      </dl>
      <RecentJobs jobs={card.recentJobs} />
      {/* keyed by the load: a refresh starts the pager again from the first page */}
      <Songs key={loadedAt ?? 0} uid={uid} total={profile.trackCount} first={card.tracks} />
    </>
  )
}

/** The card of one user (#/users/<uid>): profile, quota against the limit, personal limit, state, recent jobs, songs. */
export function UserCard({ uid }: { uid: string }) {
  const { data, error, loading, loadedAt, refresh } = useAdminData((signal) => getUserCard(uid, signal), uid)
  return (
    <section className="px-4 py-6">
      {data && <CardBody key={uid} card={data} uid={uid} loadedAt={loadedAt} />}
      {!data && loading && <p className="text-sm text-muted">Завантаження…</p>}
      {error && (
        <div className="mt-2 text-sm" role="alert">
          <p className="text-danger">{adminErrorMessage(error)}</p>
        </div>
      )}
      <div className="mt-6">
        <Button size="sm" onClick={refresh} disabled={loading}>
          Оновити
        </Button>
      </div>
    </section>
  )
}

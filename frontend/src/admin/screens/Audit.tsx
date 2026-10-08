import { useState, type FormEvent } from 'react'
import { Button } from '../../components/ui/IconButton'
import { useAdminT } from '../ui'
import { ADMIN_ERROR_CODES, adminErrorKey, adminErrorMessage, listAudit, type AdminErrorCode } from '../../lib/adminApi'
import type { AdminAuditAction, AdminAuditEntry, AdminAuditFilters, AdminAuditOutcome } from '../../types'
import { useAdminData } from '../useAdminData'

// The journal screen (US-06, AC-10 / AC-10b / AC-11): a read-only, paged list of what admins did, newest first.
// It has no control that changes or deletes a record — the API has no such operation either. Like the menu, the
// texts are Ukrainian only (the admin page is for its owner).

const ACTION_LABEL: Record<AdminAuditAction, string> = {
  search: 'Пошук',
  view_card: 'Перегляд картки',
  quota_reset: 'Скидання квоти',
  limit_set: 'Особистий ліміт',
  limit_removed: 'Зняття особистого ліміту',
  restrict: 'Хмарне обмеження',
  unrestrict: 'Зняття хмарного обмеження',
  deletion_scheduled: 'Заплановано видалення',
  deletion_cancelled: 'Скасовано видалення',
  defaults_changed: 'Зміна типових лімітів',
  switch_changed: 'Зміна перемикача',
  banner_changed: 'Зміна банера',
}
const ACTIONS = Object.keys(ACTION_LABEL) as AdminAuditAction[]

const OUTCOME_LABEL: Record<AdminAuditOutcome, string> = {
  applied: 'Застосовано',
  rejected: 'Відхилено',
  not_applied: 'Не застосовано',
}

const SETTING_LABEL: Record<string, string> = {
  limits: 'Типові ліміти',
  banner: 'Банер',
  'switches.analysesPaused': 'Перемикач: пауза аналізів',
  'switches.youtubeEnabled': 'Перемикач: YouTube',
  'switches.vocalsEnabled': 'Перемикач: вокал',
}

const NONE = '—'
const dateFormat = new Intl.DateTimeFormat('uk', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

function formatWhen(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? dateFormat.format(ms) : iso
}

/** One value as text: strings as they are, everything else as JSON (rendered through React, so never as markup). */
function valueText(value: unknown): string {
  if (value === undefined) return NONE
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? String(value)
}

/** `before` / `after` as key: was → became lines (a key missing on one side shows «—» there). */
function changeLines(before: AdminAuditEntry['before'], after: AdminAuditEntry['after']): string[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
  return keys.map((key) => `${key}: ${valueText(before?.[key])} → ${valueText(after?.[key])}`)
}

/** Newest first, stable for equal times. The server already sorts so; this keeps the promise on the screen alone. */
function newestFirst(items: AdminAuditEntry[]): AdminAuditEntry[] {
  const ms = (e: AdminAuditEntry) => Date.parse(e.at) || 0
  return [...items].sort((a, b) => ms(b) - ms(a))
}

function Target({ entry }: { entry: AdminAuditEntry }) {
  const lines: string[] = []
  let purged = false
  if (entry.targetDeleted) purged = true
  else if (entry.targetEmail) lines.push(entry.targetEmail)
  else if (entry.targetUid) lines.push(entry.targetUid)
  if (entry.setting) lines.push(SETTING_LABEL[entry.setting] ?? entry.setting)
  if (entry.action === 'search') lines.push(entry.query ? `«${entry.query}»` : NONE)
  return (
    <>
      {purged && <div className="italic text-muted">видалений</div>}
      {lines.map((line) => (
        <div key={line} className="break-all">
          {line}
        </div>
      ))}
      {!purged && lines.length === 0 && NONE}
    </>
  )
}

function Outcome({ entry }: { entry: AdminAuditEntry }) {
  const t = useAdminT()
  const reason = entry.outcome === 'rejected' ? entry.rejectReason : null
  const known = reason !== null && (ADMIN_ERROR_CODES as readonly string[]).includes(reason)
  return (
    <>
      <span className={entry.outcome === 'applied' ? 'text-success' : 'text-danger'}>{OUTCOME_LABEL[entry.outcome]}</span>
      {reason && <div className="text-muted">{known ? t(adminErrorKey(reason as AdminErrorCode)) : reason}</div>}
    </>
  )
}

function Row({ entry }: { entry: AdminAuditEntry }) {
  const lines = changeLines(entry.before, entry.after)
  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-2 whitespace-nowrap">
        <time dateTime={entry.at}>{formatWhen(entry.at)}</time>
      </td>
      <td className="px-3 py-2 break-all">{entry.adminEmail}</td>
      <td className="px-3 py-2">{ACTION_LABEL[entry.action] ?? entry.action}</td>
      <td className="px-3 py-2">
        <Target entry={entry} />
      </td>
      <td className="px-3 py-2">
        {lines.length === 0 ? (
          NONE
        ) : (
          <ul className="space-y-0.5 font-mono text-xs">
            {lines.map((line) => (
              <li key={line} className="break-all">
                {line}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="px-3 py-2">
        <Outcome entry={entry} />
      </td>
    </tr>
  )
}

interface Draft {
  adminUid: string
  targetUid: string
  action: '' | AdminAuditAction
}
const EMPTY_DRAFT: Draft = { adminUid: '', targetUid: '', action: '' }

function toFilters(draft: Draft): AdminAuditFilters {
  const filters: AdminAuditFilters = {}
  const adminUid = draft.adminUid.trim()
  const targetUid = draft.targetUid.trim()
  if (adminUid) filters.adminUid = adminUid
  if (targetUid) filters.targetUid = targetUid
  if (draft.action) filters.action = draft.action
  return filters
}

const FIELD = 'h-9 rounded-lg border border-border-strong bg-surface-2 px-2 text-sm text-text'

export function Audit() {
  const t = useAdminT()
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  // The server sends a cursor for the next page only, so going back replays the earlier ones: cursors[i] opens page i + 1.
  const [view, setView] = useState<{ filters: AdminAuditFilters; cursors: string[] }>({ filters: {}, cursors: [] })
  const { filters, cursors } = view
  const after = cursors[cursors.length - 1]
  const { data, error, loading, refresh } = useAdminData(
    (signal) => listAudit(filters, after ? { after } : {}, signal),
    JSON.stringify(view),
  )

  const apply = (next: Draft) => setView({ filters: toFilters(next), cursors: [] })
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    apply(draft)
  }
  const onReset = () => {
    setDraft(EMPTY_DRAFT)
    apply(EMPTY_DRAFT)
  }
  const older = data?.hasNext && data.nextCursor ? data.nextCursor : null

  return (
    <section className="px-4 py-6" aria-labelledby="audit-title" data-screen="audit">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="audit-title" className="text-xl font-semibold">
          Журнал дій адміністратора
        </h1>
        <Button size="sm" onClick={refresh} disabled={loading}>
          Оновити
        </Button>
      </div>

      <form onSubmit={onSubmit} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Хто (uid адміністратора)
          <input name="adminUid" className={FIELD} value={draft.adminUid} onChange={(e) => setDraft({ ...draft, adminUid: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Над ким (uid користувача)
          <input name="targetUid" className={FIELD} value={draft.targetUid} onChange={(e) => setDraft({ ...draft, targetUid: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Дія
          <select name="action" className={FIELD} value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value as Draft['action'] })}>
            <option value="">Усі дії</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="primary" size="sm">
          Застосувати
        </Button>
        <Button size="sm" variant="ghost" onClick={onReset}>
          Скинути
        </Button>
      </form>

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-danger/40 px-3 py-2 text-sm text-danger">
          {adminErrorMessage(error, t)}
        </p>
      )}
      {loading && !data && !error && (
        <p className="mt-4 text-sm text-muted" aria-busy="true">
          Завантаження…
        </p>
      )}

      {data && (
        <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-surface-1">
          <table className="w-full min-w-[56rem] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                {['Коли', 'Хто', 'Дія', 'Над ким / що', 'Було → стало', 'Результат'].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {newestFirst(data.items).map((entry) => (
                <Row key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
          {data.items.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted">Записів немає</p>}
        </div>
      )}

      <nav aria-label="Сторінки журналу" className="mt-4 flex gap-2">
        <Button size="sm" disabled={cursors.length === 0} onClick={() => setView({ filters, cursors: cursors.slice(0, -1) })}>
          Новіші
        </Button>
        <Button size="sm" disabled={!older} onClick={() => older && setView({ filters, cursors: [...cursors, older] })}>
          Раніше
        </Button>
      </nav>
    </section>
  )
}

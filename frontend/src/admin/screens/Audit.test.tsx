// @vitest-environment jsdom
// AC-10 / AC-10b / AC-11: the journal screen lists admin actions newest first with who, when, target (or setting),
// before → after and outcome; rejected attempts and views of personal data are shown; a purged target reads
// «видалений» without an email; and the screen has no way to change or delete a record.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminApiError } from '../../lib/adminApi'
import type { AdminAuditEntry, AdminPage } from '../../types'
import { useApp } from '../../store'

const listAudit = vi.fn()
vi.mock('../../lib/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/adminApi')>()),
  listAudit: (...args: unknown[]) => listAudit(...args),
}))

const { Audit } = await import('./Audit')

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useApp.setState({ lang: 'uk' })
  listAudit.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function entry(over: Partial<AdminAuditEntry> & Pick<AdminAuditEntry, 'id' | 'at'>): AdminAuditEntry {
  return {
    adminUid: 'admin-1',
    adminEmail: 'admin@example.test',
    action: 'quota_reset',
    outcome: 'applied',
    targetUid: 'u-0000000001',
    targetEmail: 'user-1@example.test',
    targetDeleted: false,
    setting: null,
    before: null,
    after: null,
    rejectReason: null,
    query: null,
    refId: null,
    redactedAt: null,
    ...over,
  }
}

const page = (items: AdminAuditEntry[], over: Partial<AdminPage<AdminAuditEntry>> = {}): AdminPage<AdminAuditEntry> => ({
  items,
  hasNext: false,
  hasPrev: false,
  nextCursor: null,
  ...over,
})

async function show(first: AdminPage<AdminAuditEntry>) {
  listAudit.mockResolvedValue(first)
  await act(async () => {
    root.render(<Audit />)
  })
}

const text = () => host.textContent ?? ''
const rows = () => [...host.querySelectorAll('tbody tr')] as HTMLElement[]
const buttons = () => [...host.querySelectorAll('button')] as HTMLButtonElement[]
const button = (label: string) => buttons().find((b) => b.textContent?.trim() === label)

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

const RESET = entry({
  id: 'a1',
  at: '2026-10-08T10:00:00Z',
  action: 'quota_reset',
  before: { analyses: 40, vocals: 5 },
  after: { analyses: 0, vocals: 0 },
})
const LIMITS = entry({
  id: 'a2',
  at: '2026-10-08T09:00:00Z',
  action: 'defaults_changed',
  targetUid: null,
  targetEmail: null,
  setting: 'limits',
  before: { analyses: 40 },
  after: { analyses: 60 },
})

describe('Audit screen (AC-10)', () => {
  it('shows the actions newest first with who, when, target, before and after', async () => {
    // fed oldest first: the screen must not depend on the server's order for the "newest first" promise
    await show(page([LIMITS, RESET]))
    const r = rows()
    expect(r).toHaveLength(2)
    expect(r[0].textContent).toContain('Скидання квоти')
    expect(r[1].textContent).toContain('Зміна типових лімітів')

    const first = r[0]
    expect(first.textContent).toContain('admin@example.test')
    expect(first.textContent).toContain('user-1@example.test')
    const when = first.querySelector('time')
    expect(when?.getAttribute('datetime')).toBe('2026-10-08T10:00:00Z')
    expect(when?.textContent?.trim()).not.toBe('')
    // «було» → «стало», as text key/value pairs
    expect(first.textContent).toContain('analyses: 40 → 0')
    expect(first.textContent).toContain('vocals: 5 → 0')
    expect(first.textContent).toContain('Застосовано')

    // a setting instead of a user
    expect(r[1].textContent).toContain('Типові ліміти')
    expect(r[1].textContent).toContain('analyses: 40 → 60')
  })

  it('renders before and after as plain text, never as markup', async () => {
    await show(
      page([entry({ id: 'x', at: '2026-10-08T10:00:00Z', action: 'banner_changed', setting: 'banner', before: null, after: { text: '<b>hi</b>', nested: { a: 1 } } })]),
    )
    expect(host.querySelector('tbody b')).toBeNull()
    expect(text()).toContain('text: — → <b>hi</b>')
    expect(text()).toContain('nested: — → {"a":1}')
  })

  it('says so when the journal is empty', async () => {
    await show(page([]))
    expect(rows()).toHaveLength(0)
    expect(text()).toContain('Записів немає')
  })
})

describe('Audit screen (AC-10b)', () => {
  it('shows the search string, the card view and the rejected attempt with its reason', async () => {
    await show(
      page([
        entry({ id: 'r', at: '2026-10-08T10:03:00Z', action: 'restrict', outcome: 'rejected', targetUid: 'admin-1', targetEmail: 'admin@example.test', rejectReason: 'self_target' }),
        entry({ id: 'v', at: '2026-10-08T10:02:00Z', action: 'view_card' }),
        entry({ id: 's', at: '2026-10-08T10:01:00Z', action: 'search', targetUid: null, targetEmail: null, query: 'user-1@exa' }),
      ]),
    )
    const [rejected, view, search] = rows()
    expect(rejected.textContent).toContain('Відхилено')
    expect(rejected.textContent).toContain('Адміністратор не може обмежити чи видалити власний акаунт')
    expect(view.textContent).toContain('Перегляд картки')
    expect(view.textContent).toContain('user-1@example.test')
    expect(search.textContent).toContain('Пошук')
    expect(search.textContent).toContain('user-1@exa')
  })

  it('marks an entry whose change was not applied', async () => {
    await show(page([entry({ id: 'n', at: '2026-10-08T10:00:00Z', outcome: 'not_applied', refId: 'a0' })]))
    expect(rows()[0].textContent).toContain('Не застосовано')
  })
})

describe('Audit screen (AC-11)', () => {
  it('shows a purged target as «видалений» without an email', async () => {
    await show(
      page([
        entry({ id: 'p', at: '2026-10-08T10:00:00Z', targetUid: 'u-gone', targetEmail: null, targetDeleted: true }),
        entry({ id: 'q', at: '2026-10-08T09:00:00Z', action: 'search', targetUid: null, targetEmail: null, query: null, redactedAt: '2026-10-08T09:30:00Z' }),
      ]),
    )
    const target = rows()[0].querySelectorAll('td')[3].textContent ?? ''
    expect(target).toContain('видалений')
    expect(target).not.toContain('@')
    expect(target).not.toContain('u-gone')
    expect(rows()[1].textContent).toContain('Пошук')
  })

  it('never shows an email for a purged target even if one came along', async () => {
    await show(page([entry({ id: 'p', at: '2026-10-08T10:00:00Z', targetEmail: 'leak@example.test', targetDeleted: true })]))
    expect(text()).not.toContain('leak@example.test')
    expect(rows()[0].textContent).toContain('видалений')
  })

  it('has no control that changes or deletes a record', async () => {
    await show(page([RESET, LIMITS], { hasNext: true, nextCursor: 'c1' }))
    expect(host.querySelectorAll('tbody button, tbody input, tbody select, tbody textarea, tbody a, tbody [contenteditable]')).toHaveLength(0)
    // outside the rows: only «Оновити», the filter form's apply/reset and paging
    const allowed = new Set(['Оновити', 'Застосувати', 'Скинути', 'Раніше', 'Новіші'])
    for (const b of buttons()) expect(allowed.has(b.textContent?.trim() ?? '')).toBe(true)
    expect(host.querySelectorAll('form')).toHaveLength(1)
  })
})

describe('Audit screen filters and paging', () => {
  it('asks for everything first, then filters by admin, user and action', async () => {
    await show(page([RESET]))
    expect(listAudit).toHaveBeenLastCalledWith({}, {}, expect.any(AbortSignal))

    await act(async () => {
      setValue(host.querySelector('input[name="adminUid"]')!, ' admin-1 ')
      setValue(host.querySelector('input[name="targetUid"]')!, 'u-0000000001')
      setValue(host.querySelector('select[name="action"]')!, 'quota_reset')
    })
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(listAudit).toHaveBeenLastCalledWith({ adminUid: 'admin-1', targetUid: 'u-0000000001', action: 'quota_reset' }, {}, expect.any(AbortSignal))

    await act(async () => button('Скинути')!.click())
    expect(listAudit).toHaveBeenLastCalledWith({}, {}, expect.any(AbortSignal))
  })

  it('offers every journaled action in the action filter', async () => {
    await show(page([]))
    const values = [...host.querySelectorAll<HTMLOptionElement>('select[name="action"] option')].map((o) => o.value)
    expect(values).toEqual([
      '',
      'search',
      'view_card',
      'quota_reset',
      'limit_set',
      'limit_removed',
      'restrict',
      'unrestrict',
      'deletion_scheduled',
      'deletion_cancelled',
      'defaults_changed',
      'switch_changed',
      'banner_changed',
    ])
  })

  it('pages with the server cursors', async () => {
    await show(page([RESET], { hasNext: true, nextCursor: 'c-next' }))
    expect(button('Новіші')!.disabled).toBe(true)
    await act(async () => button('Раніше')!.click())
    expect(listAudit).toHaveBeenLastCalledWith({}, { after: 'c-next' }, expect.any(AbortSignal))
  })

  it('goes back by replaying the earlier cursors (the server sends no backward cursor)', async () => {
    listAudit.mockResolvedValueOnce(page([RESET], { hasNext: true, nextCursor: 'c1' }))
    await act(async () => {
      root.render(<Audit />)
    })
    listAudit.mockResolvedValueOnce(page([LIMITS], { hasPrev: true, hasNext: true, nextCursor: 'c2' }))
    await act(async () => button('Раніше')!.click())
    listAudit.mockResolvedValueOnce(page([RESET], { hasPrev: true }))
    await act(async () => button('Раніше')!.click())
    expect(listAudit).toHaveBeenLastCalledWith({}, { after: 'c2' }, expect.any(AbortSignal))
    expect(button('Раніше')!.disabled).toBe(true)

    listAudit.mockResolvedValueOnce(page([LIMITS], { hasPrev: true, hasNext: true, nextCursor: 'c2' }))
    await act(async () => button('Новіші')!.click())
    expect(listAudit).toHaveBeenLastCalledWith({}, { after: 'c1' }, expect.any(AbortSignal))
    listAudit.mockResolvedValueOnce(page([RESET], { hasNext: true, nextCursor: 'c1' }))
    await act(async () => button('Новіші')!.click())
    expect(listAudit).toHaveBeenLastCalledWith({}, {}, expect.any(AbortSignal))
    expect(button('Новіші')!.disabled).toBe(true)
  })

  it('starts again from the newest records when the filters change', async () => {
    listAudit.mockResolvedValueOnce(page([RESET], { hasNext: true, nextCursor: 'c1' }))
    await act(async () => {
      root.render(<Audit />)
    })
    listAudit.mockResolvedValueOnce(page([LIMITS], { hasPrev: true }))
    await act(async () => button('Раніше')!.click())
    listAudit.mockResolvedValue(page([RESET]))
    await act(async () => {
      setValue(host.querySelector('select[name="action"]')!, 'quota_reset')
    })
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(listAudit).toHaveBeenLastCalledWith({ action: 'quota_reset' }, {}, expect.any(AbortSignal))
    expect(button('Новіші')!.disabled).toBe(true)
  })
})

describe('Audit screen failures', () => {
  it('shows the error in words and lets the admin retry', async () => {
    listAudit.mockRejectedValueOnce(new AdminApiError('x', 'audit_unavailable', 503))
    await act(async () => {
      root.render(<Audit />)
    })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Дані недоступні, повторіть')
    expect(rows()).toHaveLength(0)

    listAudit.mockResolvedValue(page([RESET]))
    await act(async () => button('Оновити')!.click())
    expect(rows()).toHaveLength(1)
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })
})

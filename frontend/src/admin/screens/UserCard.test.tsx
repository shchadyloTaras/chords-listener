// @vitest-environment jsdom
// AC-03 / AC-04 / AC-05 / AC-06 (test-plan rows for T30): search needs 3 characters and says «Нікого не знайдено»,
// the card shows profile, quota, personal limit and state, songs come 50 per page newest first, text from users
// (titles, emails, errors) is shown verbatim as text, and a song row offers no open / play action.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from '../../store'
import type { AdminJobHistoryItem, AdminPage, AdminTrackMeta, AdminUserCard } from '../../types'

const api = vi.hoisted(() => ({
  searchUsers: vi.fn(),
  getUserCard: vi.fn(),
  listUserTracks: vi.fn(),
}))

vi.mock('../../lib/adminApi', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/adminApi')>()),
  searchUsers: api.searchUsers,
  getUserCard: api.getUserCard,
  listUserTracks: api.listUserTracks,
}))

import { AdminApiError } from '../../lib/adminApi'
import { UserCard } from './UserCard'
import { Users } from './Users'

// the same set the back-end fixtures plant (backend/tests/admin/fixtures.py HOSTILE_STRINGS)
const HOSTILE_STRINGS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  'javascript:alert(1)',
  '‮txet desrever',
  'x+<b>@example.test',
  '<b>bold</b> & &amp; &lt;i&gt;',
  'A'.repeat(300),
  '<img src=x onerror=alert(1)>'.repeat(12),
]
const HOSTILE_EMAILS = ['x+<b>@example.test', 'x+<img src=x onerror=alert(1)>@example.test']

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useApp.setState({ lang: 'uk' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  for (const fn of Object.values(api)) fn.mockReset()
})

const text = () => host.textContent ?? ''
const flush = () => act(async () => undefined)

async function mount(node: React.ReactNode) {
  await act(async () => {
    root.render(node)
  })
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function search(value: string) {
  await typeInto(host.querySelector('input')!, value)
  await act(async () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await flush()
}

const found = (query: string, items: { uid: string; email: string; service?: boolean }[], truncated = false) => ({
  query,
  items: items.map((i) => ({ service: false, ...i })),
  truncated,
})

describe('Users — search', () => {
  it('asks for at least 3 characters and sends no request for a shorter string', async () => {
    await mount(<Users />)
    await search('iv')
    expect(text()).toContain('щонайменше 3 символи')
    expect(api.searchUsers).not.toHaveBeenCalled()
  })

  it('sends no request while the person is only typing', async () => {
    await mount(<Users />)
    await typeInto(host.querySelector('input')!, 'ivan')
    expect(api.searchUsers).not.toHaveBeenCalled()
  })

  it('ignores surrounding spaces when counting characters', async () => {
    await mount(<Users />)
    await search('  iv  ')
    expect(text()).toContain('щонайменше 3 символи')
    expect(api.searchUsers).not.toHaveBeenCalled()
  })

  it('lists every match with a link to its card', async () => {
    api.searchUsers.mockResolvedValue(
      found('ivan', [
        { uid: 'u1', email: 'ivan.p@example.test' },
        { uid: 'u2', email: 'John.Ivanov@example.test' },
      ]),
    )
    await mount(<Users />)
    await search('ivan')
    expect(api.searchUsers).toHaveBeenCalledTimes(1)
    expect(api.searchUsers.mock.calls[0][0]).toBe('ivan')
    const links = [...host.querySelectorAll('a')]
    expect(links.map((a) => a.textContent)).toEqual(['ivan.p@example.test', 'John.Ivanov@example.test'])
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#/users/u1', '#/users/u2'])
    expect(text()).not.toContain('Нікого не знайдено')
  })

  it('says «Нікого не знайдено» when nothing matches', async () => {
    api.searchUsers.mockResolvedValue(found('zzzz', []))
    await mount(<Users />)
    await search('zzzz')
    expect(text()).toContain('Нікого не знайдено')
    expect(host.querySelectorAll('a')).toHaveLength(0)
  })

  it('asks to refine the query when there are more than 50 matches', async () => {
    api.searchUsers.mockResolvedValue(found('ann', [{ uid: 'u1', email: 'ann@example.test' }], true))
    await mount(<Users />)
    await search('ann')
    expect(text()).toContain('Уточніть запит')
  })

  it('shows the text of an API error', async () => {
    api.searchUsers.mockRejectedValue(new AdminApiError('boom', 'query_too_short', 422))
    await mount(<Users />)
    await search('ivan')
    expect(text()).toContain('Введіть щонайменше 3 символи')
  })

  it('renders hostile emails verbatim as text', async () => {
    api.searchUsers.mockResolvedValue(found('x+', HOSTILE_EMAILS.map((email, i) => ({ uid: `h${i}`, email }))))
    await mount(<Users />)
    await search('x+<')
    expect([...host.querySelectorAll('a')].map((a) => a.textContent)).toEqual(HOSTILE_EMAILS)
    expect(host.querySelector('img, script, b')).toBeNull()
  })
})

// ---------------------------------------------------------------- the card

const track = (i: number, over: Partial<AdminTrackMeta> = {}): AdminTrackMeta => ({
  id: `t${String(i).padStart(4, '0')}`,
  title: `Song ${i}`,
  sourceType: 'youtube',
  createdAt: new Date(Date.UTC(2026, 9, 7, 12, 0) - i * 60_000).toISOString(),
  duration: 215.4,
  edited: false,
  vocals: false,
  sizeBytes: 7_340_032,
  ...over,
})

const page = (items: AdminTrackMeta[], over: Partial<AdminPage<AdminTrackMeta>> = {}): AdminPage<AdminTrackMeta> => ({
  items,
  hasNext: false,
  hasPrev: false,
  nextCursor: null,
  ...over,
})

const job = (over: Partial<AdminJobHistoryItem> = {}): AdminJobHistoryItem => ({
  id: 'j1',
  uid: 'u1',
  email: 'ivan.p@example.test',
  userDeleted: false,
  service: false,
  kind: 'analysis',
  origin: 'link',
  sourceType: 'other',
  status: 'done',
  reason: null,
  errorText: null,
  title: null,
  acceptedAt: '2026-10-07T10:00:00Z',
  finishedAt: '2026-10-07T10:01:00Z',
  ...over,
})

function card(over: Partial<AdminUserCard> = {}): AdminUserCard {
  return {
    profile: {
      uid: 'u1',
      email: 'ivan.p@example.test',
      createdAt: '2026-03-01T12:00:00Z',
      lastLoginAt: '2026-10-06T08:30:00Z',
      service: false,
      trackCount: 3,
      storageBytes: 7_340_032,
    },
    account: {
      uid: 'u1',
      status: 'normal',
      restriction: null,
      deletion: null,
      personalLimit: null,
      quota: { day: '2026-10-08', analyses: { used: 12, limit: 40 }, vocals: { used: 3, limit: 15 }, jobs: { used: 1, limit: 2 } },
    },
    recentJobs: [],
    tracks: page([track(1), track(2), track(3)]),
    ...over,
  }
}

describe('UserCard — profile, quota, limit and state', () => {
  it('shows registration, last login, songs, storage and quota against the limit', async () => {
    api.getUserCard.mockResolvedValue(card())
    await mount(<UserCard uid="u1" />)
    await flush()
    expect(api.getUserCard.mock.calls[0][0]).toBe('u1')
    const t = text()
    expect(t).toContain('ivan.p@example.test')
    expect(t).toContain('2026') // registration + last login dates
    expect(t).toMatch(/Реєстрація/)
    expect(t).toMatch(/Останній вхід/)
    expect(t).toMatch(/Зайняте місце\s*7\.0 МБ/)
    expect(t).toContain('12 / 40')
    expect(t).toContain('3 / 15')
    expect(t).toContain('1 / 2')
    expect(t).toContain('Звичайний')
  })

  it('says so when the user has no last login and no personal limit', async () => {
    const c = card()
    c.profile.lastLoginAt = null
    api.getUserCard.mockResolvedValue(c)
    await mount(<UserCard uid="u1" />)
    await flush()
    expect(text()).toMatch(/Останній вхід\s*—/)
    expect(text()).toMatch(/Персональний ліміт\s*Немає/)
  })

  it('shows an active personal limit with its numbers and end date', async () => {
    const c = card()
    c.account.personalLimit = { analyses: 100, vocals: null, jobs: 5, until: '2026-10-30', setAt: '2026-10-01T00:00:00Z', byAdminUid: 'a1', expired: false }
    api.getUserCard.mockResolvedValue(c)
    await mount(<UserCard uid="u1" />)
    await flush()
    const t = text()
    expect(t).toContain('100')
    expect(t).toContain('2026-10-30')
    expect(t).not.toContain('завершився')
  })

  it('marks an expired personal limit «завершився»', async () => {
    const c = card()
    c.account.personalLimit = { analyses: 100, vocals: null, jobs: null, until: '2026-10-01', setAt: '2026-09-01T00:00:00Z', byAdminUid: 'a1', expired: true }
    api.getUserCard.mockResolvedValue(c)
    await mount(<UserCard uid="u1" />)
    await flush()
    expect(text()).toContain('завершився')
  })

  it('shows a cloud restriction with its reason as text', async () => {
    const c = card()
    c.account.status = 'restricted'
    c.account.restriction = { reason: HOSTILE_STRINGS[0], since: '2026-10-05T09:00:00Z', byAdminUid: 'a1' }
    api.getUserCard.mockResolvedValue(c)
    await mount(<UserCard uid="u1" />)
    await flush()
    expect(text()).toContain('Хмарне обмеження')
    expect(text()).toContain(HOSTILE_STRINGS[0])
    expect(host.querySelector('script')).toBeNull()
  })

  it('shows a scheduled deletion with its date', async () => {
    const c = card()
    c.account.status = 'deletion_scheduled'
    c.account.deletion = { scheduledAt: '2026-10-07T09:00:00Z', purgeAfter: '2026-10-14T09:00:00Z', byAdminUid: 'a1' }
    api.getUserCard.mockResolvedValue(c)
    await mount(<UserCard uid="u1" />)
    await flush()
    expect(text()).toContain('Заплановане видалення')
    expect(text()).toContain('2026-10-14')
  })

  it('lists recent jobs with the failure reason in plain words and the error as text', async () => {
    const c = card({
      recentJobs: [
        job({ id: 'j1', status: 'error', reason: 'youtube_blocked', errorText: HOSTILE_STRINGS[1], title: HOSTILE_STRINGS[5] }),
        job({ id: 'j2', status: 'done' }),
      ],
    })
    api.getUserCard.mockResolvedValue(c)
    await mount(<UserCard uid="u1" />)
    await flush()
    expect(text()).toContain('YouTube заблокував завантаження')
    expect(text()).toContain(HOSTILE_STRINGS[1])
    expect(text()).toContain(HOSTILE_STRINGS[5])
    expect(host.querySelector('img, b')).toBeNull()
  })

  it('shows the text of an API error', async () => {
    api.getUserCard.mockRejectedValue(new AdminApiError('x', 'not_found', 404))
    await mount(<UserCard uid="nope" />)
    await flush()
    expect(text()).toContain('Не знайдено')
  })
})

describe('UserCard — songs', () => {
  const rows = () => [...host.querySelectorAll('tbody tr')]
  const firstCell = (r: Element) => r.querySelector('td')?.textContent

  it('shows the songs in the order the server sends them (newest first) with metadata only', async () => {
    api.getUserCard.mockResolvedValue(
      card({
        tracks: page([
          track(1, { title: 'Newest', sourceType: 'youtube', duration: 215.4 }),
          track(2, { title: 'Middle', sourceType: 'file', sizeBytes: null }),
          track(3, { title: 'Oldest', sourceType: 'url' }),
        ]),
      }),
    )
    await mount(<UserCard uid="u1" />)
    await flush()
    expect(rows().map(firstCell)).toEqual(['Newest', 'Middle', 'Oldest'])
    expect(rows()[0].textContent).toContain('3:35')
    expect(rows()[0].textContent).toContain('YouTube')
    expect(rows()[1].textContent).toContain('Файл')
  })

  it('pages by 50: next loads after the cursor, previous goes back to the page before', async () => {
    const first = Array.from({ length: 50 }, (_, i) => track(i + 1))
    const second = Array.from({ length: 20 }, (_, i) => track(i + 51))
    api.getUserCard.mockResolvedValue(card({ tracks: page(first, { hasNext: true, nextCursor: 'CUR1' }) }))
    api.listUserTracks.mockResolvedValue(page(second, { hasPrev: true }))
    await mount(<UserCard uid="u1" />)
    await flush()
    expect(rows()).toHaveLength(50)

    const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(name))
    expect(button('Назад')?.disabled).toBe(true)
    await act(async () => {
      button('Далі')!.click()
    })
    await flush()
    expect(api.listUserTracks).toHaveBeenCalledTimes(1)
    expect(api.listUserTracks.mock.calls[0][0]).toBe('u1')
    expect(api.listUserTracks.mock.calls[0][1]).toEqual({ after: 'CUR1', limit: 50 })
    expect(rows()).toHaveLength(20)
    expect(firstCell(rows()[0])).toBe('Song 51')
    expect(button('Далі')?.disabled).toBe(true)

    await act(async () => {
      button('Назад')!.click()
    })
    await flush()
    expect(rows()).toHaveLength(50)
    expect(firstCell(rows()[0])).toBe('Song 1')
  })

  it('says there are no songs when the list is empty', async () => {
    api.getUserCard.mockResolvedValue(card({ tracks: page([]) }))
    await mount(<UserCard uid="u1" />)
    await flush()
    expect(text()).toContain('Пісень немає')
  })

  it('shows the text of a failed page load and keeps the current page', async () => {
    api.getUserCard.mockResolvedValue(card({ tracks: page([track(1)], { hasNext: true, nextCursor: 'C' }) }))
    api.listUserTracks.mockRejectedValue(new AdminApiError('x', 'network'))
    await mount(<UserCard uid="u1" />)
    await flush()
    await act(async () => {
      ;[...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Далі'))!.click()
    })
    await flush()
    expect(text()).toContain('Сервер не відповідає')
    expect(rows()).toHaveLength(1)
  })
})

describe('UserCard — text from users is only text (AC-05)', () => {
  it('renders every hostile title verbatim, creating no element or handler from it', async () => {
    const tracks = HOSTILE_STRINGS.map((title, i) => track(i + 1, { title }))
    const c = card({ tracks: page(tracks) })
    c.profile.email = HOSTILE_EMAILS[1]
    api.getUserCard.mockResolvedValue(c)
    await mount(<UserCard uid="u1" />)
    await flush()
    const titles = [...host.querySelectorAll('tbody tr')].map((r) => r.querySelector('td')?.textContent)
    expect(titles).toEqual(HOSTILE_STRINGS)
    expect(text()).toContain(HOSTILE_EMAILS[1])
    expect(host.querySelector('script, img, b, i, iframe, svg, [onerror], [onclick]')).toBeNull()
    expect(host.querySelectorAll('a[href^="javascript"]')).toHaveLength(0)
  })

  it('renders hostile error text verbatim in recent jobs', async () => {
    const c = card({ recentJobs: HOSTILE_STRINGS.map((s, i) => job({ id: `j${i}`, status: 'error', reason: 'other', errorText: s })) })
    api.getUserCard.mockResolvedValue(c)
    await mount(<UserCard uid="u1" />)
    await flush()
    for (const s of HOSTILE_STRINGS) expect(text()).toContain(s)
    expect(host.querySelector('script, img, b, i, iframe, [onerror]')).toBeNull()
  })
})

describe('UserCard — metadata only (AC-06)', () => {
  it('offers no open or play action on a song row', async () => {
    api.getUserCard.mockResolvedValue(card({ tracks: page([track(1, { title: 'Test Song', edited: true, vocals: true })]) }))
    await mount(<UserCard uid="u1" />)
    await flush()
    const row = host.querySelector('tbody tr')!
    expect(row.textContent).toContain('Test Song')
    expect(row.querySelectorAll('a, button, audio, video, source, iframe, input, [role="button"], [tabindex], [onclick]')).toHaveLength(0)
    expect(row.querySelector('[href], [src]')).toBeNull()
  })

  it('has no link to a song, to audio or to chords anywhere on the card', async () => {
    api.getUserCard.mockResolvedValue(card({ recentJobs: [job({ title: 'Job title' })] }))
    await mount(<UserCard uid="u1" />)
    await flush()
    expect(text()).toContain('Job title')
    expect(host.querySelector('audio, video, source, iframe')).toBeNull()
    expect([...host.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([])
    for (const b of host.querySelectorAll('button')) expect(b.textContent ?? '').not.toMatch(/відкрити|слухати|грати|акорд|play|open/i)
  })
})

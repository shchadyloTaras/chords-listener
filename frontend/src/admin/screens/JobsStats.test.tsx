// @vitest-environment jsdom
// AC-07: the job-history screen filters by result / reason / origin / period, shows who / when / source /
// reason with the error text as plain text, and counts per reason. AC-08: the stats screen lists every day of the
// period; days before the launch are «відновлено з пісень» with only track counts. AC-09: a period longer than
// 90 days or reversed is not sent — the screen explains the rule instead.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminApiError } from '../../lib/adminApi'
import { useApp } from '../../store'
import type { AdminJobFilters, AdminJobHistoryItem, AdminJobHistoryPage, AdminPaging, AdminStatsDay, AdminStatsRange } from '../../types'
import { Jobs } from './Jobs'
import { Stats } from './Stats'
import { KIND_LABEL, ORIGIN_LABEL } from './labels'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-08T10:00:00Z'))
  useApp.setState({ lang: 'uk' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const flush = () => act(async () => undefined)
const text = () => host.textContent ?? ''

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}
const field = <T extends HTMLElement>(label: string) => {
  const el = host.querySelector<T>(`[aria-label="${label}"]`)
  expect(el, `field «${label}»`).not.toBeNull()
  return el!
}
const change = (label: string, value: string) => act(async () => setValue(field<HTMLInputElement | HTMLSelectElement>(label), value))
const click = (el: Element) => act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(name))!

const RULE_LENGTH = 'не довшим за 90 днів'
const RULE_ORDER = 'закінчуватися не раніше'

// ---------------------------------------------------------------- Jobs

const job = (over: Partial<AdminJobHistoryItem> = {}): AdminJobHistoryItem => ({
  id: 'j1',
  uid: 'u1',
  email: 'user-1@example.test',
  userDeleted: false,
  service: false,
  kind: 'analysis',
  origin: 'link',
  sourceType: 'other',
  status: 'error',
  reason: 'youtube_blocked',
  errorText: "Sign in to confirm you're not a bot",
  title: 'Test Song',
  acceptedAt: '2026-10-08T09:00:00Z',
  finishedAt: '2026-10-08T09:00:20Z',
  ...over,
})

const page = (items: AdminJobHistoryItem[], over: Partial<AdminJobHistoryPage> = {}): AdminJobHistoryPage => ({
  items,
  hasNext: false,
  hasPrev: false,
  nextCursor: null,
  countsByReason: {},
  ...over,
})

type JobsLoad = (filters: AdminJobFilters, paging: AdminPaging, signal: AbortSignal) => Promise<AdminJobHistoryPage>

/** The «Джерело» cell of every row of the job table (not the filter's options). */
function sourceCells(): string[] {
  const column = [...host.querySelectorAll('thead th')].findIndex((th) => th.textContent === 'Джерело')
  expect(column, 'the «Джерело» column').toBeGreaterThanOrEqual(0)
  return [...host.querySelectorAll('tbody tr')].map((row) => row.children[column]?.textContent ?? '')
}

async function mountJobs(load: JobsLoad) {
  await act(async () => {
    root.render(createElement(Jobs, { load }))
  })
  await flush()
}

describe('AC-07 job history screen', () => {
  it('loads the last 7 days by default and shows who, when, source and reason as plain words', async () => {
    const load = vi.fn<JobsLoad>(async () => page([job()], { countsByReason: { youtube_blocked: 1 } }))
    await mountJobs(load)
    expect(load.mock.calls[0][0]).toEqual({ from: '2026-10-02', to: '2026-10-08' })
    expect(text()).toContain('user-1@example.test')
    expect(text()).toContain('2026-10-08 09:00')
    expect(text()).toContain('Посилання')
    expect(text()).toContain('YouTube заблокував завантаження')
    expect(text()).toContain("Sign in to confirm you're not a bot")
  })

  it('sends the chosen result, reason and origin to the server', async () => {
    const load = vi.fn<JobsLoad>(async () => page([job()]))
    await mountJobs(load)
    await change('Результат', 'error')
    await change('Джерело', 'link')
    await change('Причина', 'youtube_blocked')
    expect(load.mock.lastCall![0]).toEqual({ status: 'error', origin: 'link', reason: 'youtube_blocked', from: '2026-10-02', to: '2026-10-08' })
  })

  it('filters by the source type: YouTube or another source', async () => {
    const load = vi.fn<JobsLoad>(async () => page([job({ sourceType: 'youtube' })]))
    await mountJobs(load)
    await change('Тип джерела', 'youtube')
    expect(load.mock.lastCall![0]).toEqual({ sourceType: 'youtube', from: '2026-10-02', to: '2026-10-08' })
    expect(sourceCells()).toEqual(['Посилання · YouTube'])
  })

  it('names the source of every row: YouTube links say so, other links and files do not', async () => {
    await mountJobs(async () =>
      page([
        job({ id: 'j1', sourceType: 'youtube' }),
        job({ id: 'j2', sourceType: 'other' }),
        job({ id: 'j3', origin: 'file', sourceType: 'other' }),
        job({ id: 'j4', origin: 'tab', sourceType: 'other' }),
      ]),
    )
    expect(sourceCells()).toEqual(['Посилання · YouTube', 'Посилання', 'Файл', 'Вкладка'])
  })

  it('shows the number of jobs per failure reason, labelled in plain words', async () => {
    await mountJobs(async () => page([job()], { countsByReason: { youtube_blocked: 3, unsupported_format: 2 } }))
    const counts = field('Кількість за причинами')
    expect(counts.textContent).toMatch(/YouTube заблокував завантаження\s*3/)
    expect(counts.textContent).toMatch(/Формат не підтримується\s*2/)
  })

  it('shows the error text and the title as text, never as markup', async () => {
    const hostile = '<img src=x onerror="alert(1)"><b>bold</b>'
    await mountJobs(async () => page([job({ errorText: hostile, title: '<script>alert(2)</script>' })]))
    expect(host.querySelector('img, b, script')).toBeNull()
    expect(text()).toContain(hostile)
    expect(text()).toContain('<script>alert(2)</script>')
  })

  it('labels a user whose account was deleted', async () => {
    await mountJobs(async () => page([job({ email: null, userDeleted: true, title: null })]))
    expect(text()).toContain('Користувача видалено')
  })

  it('says so when nothing matches', async () => {
    await mountJobs(async () => page([]))
    expect(text()).toContain('Задач за цими умовами немає')
  })

  it('pages with the cursor of the previous answer', async () => {
    const load = vi.fn<JobsLoad>(async (_f, paging) =>
      paging.after ? page([job({ id: 'j2', email: 'second@example.test' })], { hasPrev: true }) : page([job()], { hasNext: true, nextCursor: 'CUR' }),
    )
    await mountJobs(load)
    await click(button('Далі'))
    await flush()
    expect(load.mock.lastCall![1]).toMatchObject({ after: 'CUR' })
    expect(text()).toContain('second@example.test')
  })
})

describe('AC-09 period of the job history', () => {
  it('blocks a reversed period: nothing is requested and the rule is explained', async () => {
    const load = vi.fn<JobsLoad>(async () => page([job()]))
    await mountJobs(load)
    load.mockClear()
    await change('Від', '2026-10-08') // a one-day period is fine and is requested
    load.mockClear()
    await change('До', '2026-10-01')
    expect(load).not.toHaveBeenCalled()
    expect(text()).toContain(RULE_ORDER)
    expect(host.querySelector('table')).toBeNull()
  })

  it('blocks a period longer than 90 days but accepts exactly 90', async () => {
    const load = vi.fn<JobsLoad>(async () => page([]))
    await mountJobs(load)
    load.mockClear()
    await change('Від', '2026-07-09') // 92 days up to 2026-10-08
    expect(load).not.toHaveBeenCalled()
    expect(text()).toContain(RULE_LENGTH)
    await change('Від', '2026-07-11') // 90 days, both ends included
    expect(load).toHaveBeenCalledTimes(1)
    expect(load.mock.lastCall![0]).toMatchObject({ from: '2026-07-11', to: '2026-10-08' })
  })
})

// ---------------------------------------------------------------- Stats

const zero = { link: 0, file: 0, mic: 0, tab: 0 }
const liveDay = (day: string, over: Partial<AdminStatsDay> = {}): AdminStatsDay => ({
  day,
  state: 'frozen',
  analyses: { ...zero, link: 2, file: 1 },
  vocals: 4,
  failed: 3,
  failedByReason: { youtube_blocked: 2, other: 1 },
  active: 5,
  newUsers: 1,
  restoredTracks: null,
  frozenAt: null,
  ...over,
})
const restoredDay = (day: string, tracks = { youtube: 2, url: 1, file: 3 }): AdminStatsDay => ({
  day,
  state: 'restored',
  analyses: { ...zero },
  vocals: 0,
  failed: 0,
  failedByReason: {},
  active: 0,
  newUsers: null,
  restoredTracks: tracks,
  frozenAt: null,
})

type StatsLoad = (from: string, to: string, signal: AbortSignal) => Promise<AdminStatsRange>

async function mountStats(load: StatsLoad) {
  await act(async () => {
    root.render(createElement(Stats, { load }))
  })
  await flush()
}

describe('AC-08 daily statistics', () => {
  it('asks for the last 30 days and shows a row for every day, zero for days without a record', async () => {
    const load = vi.fn<StatsLoad>(async (from, to) => ({ from, to, days: [liveDay('2026-10-08')] }))
    await mountStats(load)
    expect(load.mock.calls[0].slice(0, 2)).toEqual(['2026-09-09', '2026-10-08'])
    expect(host.querySelectorAll('tbody tr')).toHaveLength(30)
    const rows = [...host.querySelectorAll('tbody tr')]
    expect(rows[0].textContent).toContain('2026-10-08') // newest first
    expect(rows[0].textContent).toContain('YouTube заблокував завантаження')
    expect(rows[1].textContent).toContain('2026-10-07')
    expect(rows[1].textContent).not.toContain('відновлено')
  })

  it('marks restored days «відновлено з пісень» with song counts by source and no failure columns', async () => {
    await mountStats(async (from, to) => ({ from, to, days: [liveDay('2026-10-08'), restoredDay('2026-10-07')] }))
    const row = [...host.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('2026-10-07'))!
    expect(row.textContent).toContain('відновлено з пісень')
    expect(row.textContent).toMatch(/YouTube\s*2/)
    expect(row.textContent).toMatch(/Посилання\s*1/)
    expect(row.textContent).toMatch(/Файл\s*3/)
    expect(row.textContent).not.toContain('YouTube заблокував')
    expect(row.querySelectorAll('td').length).toBeLessThan(host.querySelectorAll('thead th').length)
    const live = [...host.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('2026-10-08'))!
    expect(live.textContent).not.toContain('відновлено')
  })

  it('shows an omitted (quiet) day as zeros, never as «триває»; only a live day is in progress', async () => {
    await mountStats(async (from, to) => ({ from, to, days: [liveDay('2026-10-08', { state: 'live' }), restoredDay('2026-10-01')] }))
    const rows = [...host.querySelectorAll('tbody tr')]
    expect(rows.filter((r) => r.textContent?.includes('триває'))).toHaveLength(1)
    expect(rows[1].textContent).toContain('2026-10-07')
    expect(rows[1].textContent).not.toContain('триває')
  })

  it('names the columns in the words of the other screens (labels.ts) and fills them from the day', async () => {
    await mountStats(async (from, to) => ({ from, to, days: [liveDay('2026-10-08', { analyses: { link: 2, file: 1, mic: 7, tab: 9 } })] }))
    const headers = [...host.querySelectorAll('thead th')].map((th) => th.textContent)
    expect(headers.slice(0, 6)).toEqual(['День', ORIGIN_LABEL.link, ORIGIN_LABEL.file, ORIGIN_LABEL.mic, ORIGIN_LABEL.tab, KIND_LABEL.vocals])
    const cells = [...host.querySelectorAll('tbody tr')[0].querySelectorAll('td')].map((td) => td.textContent)
    expect(cells.slice(0, 5)).toEqual(['2', '1', '7', '9', '4'])
  })

  it('offers 7, 30 and 90 day presets', async () => {
    const load = vi.fn<StatsLoad>(async (from, to) => ({ from, to, days: [] }))
    await mountStats(load)
    await click(button('90 днів'))
    expect(load.mock.lastCall!.slice(0, 2)).toEqual(['2026-07-11', '2026-10-08'])
    await click(button('7 днів'))
    expect(load.mock.lastCall!.slice(0, 2)).toEqual(['2026-10-02', '2026-10-08'])
  })
})

describe('AC-09 period of the statistics', () => {
  it('explains the rule and builds nothing for a period longer than 90 days', async () => {
    const load = vi.fn<StatsLoad>(async (from, to) => ({ from, to, days: [] }))
    await mountStats(load)
    load.mockClear()
    await change('Від', '2026-07-01')
    expect(load).not.toHaveBeenCalled()
    expect(text()).toContain(RULE_LENGTH)
    expect(host.querySelector('table')).toBeNull()
  })

  it('explains the rule and builds nothing when the end is before the start', async () => {
    const load = vi.fn<StatsLoad>(async (from, to) => ({ from, to, days: [] }))
    await mountStats(load)
    load.mockClear()
    await change('До', '2026-09-01')
    expect(load).not.toHaveBeenCalled()
    expect(text()).toContain(RULE_ORDER)
  })

  it('shows the period rule beside the form from the start', async () => {
    await mountStats(async (from, to) => ({ from, to, days: [] }))
    expect(text()).toContain('не довше 90 днів')
  })

  it('shows a server refusal of the period in words', async () => {
    await mountStats(async () => {
      throw new AdminApiError('bad period', 'invalid_period', 422)
    })
    expect(text()).toContain('Період має починатися не пізніше, ніж закінчується, і тривати не більше 90 днів')
  })
})

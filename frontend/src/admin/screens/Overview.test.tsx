// @vitest-environment jsdom
// AC-01: the overview shows today's (UTC day) totals — analyses by origin, vocals, failed, active and new users —
// the running jobs and the state of every service switch. AC-02: it loads on open and on «Оновити» only (no timer).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminOverview } from '../../types'
import { useApp } from '../../store'
import { Overview } from './Overview'

const getOverview = vi.hoisted(() => vi.fn())
vi.mock('../../lib/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/adminApi')>()),
  getOverview,
}))

const FIXTURE: AdminOverview = {
  day: '2026-10-08',
  analyses: { link: 11, file: 7, mic: 3, tab: 2 },
  vocals: 5,
  failed: 4,
  failedByReason: { youtube_blocked: 3, too_long: 1 },
  active: 9,
  newUsers: 2,
  runningJobs: [
    { id: 'j1', uid: 'u1', email: 'ivan.p@example.com', service: false, kind: 'analysis', origin: 'link', acceptedAt: '2026-10-08T09:58:00Z' },
    { id: 'j2', uid: 'u2', email: null, service: true, kind: 'vocals', origin: 'file', acceptedAt: '2026-10-08T09:59:00Z' },
  ],
  switches: { analysesPaused: true, youtubeEnabled: false, vocalsEnabled: true },
}

let root: Root
let host: HTMLDivElement

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)
const val = (id: string) => q(id)?.textContent
const refreshButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Оновити'))

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useApp.setState({ lang: 'uk' })
  getOverview.mockReset()
  getOverview.mockResolvedValue(FIXTURE)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const mount = () =>
  act(async () => {
    root.render(createElement(Overview))
  })

describe('Overview screen', () => {
  it('renders every total of the day from the fixture', async () => {
    await mount()
    expect(getOverview).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('2026-10-08')
    expect(val('analyses-link')).toBe('11')
    expect(val('analyses-file')).toBe('7')
    expect(val('analyses-mic')).toBe('3')
    expect(val('analyses-tab')).toBe('2')
    expect(val('analyses-total')).toBe('23')
    expect(val('vocals')).toBe('5')
    expect(val('failed')).toBe('4')
    expect(val('active')).toBe('9')
    expect(val('new-users')).toBe('2')
    expect(host.textContent).toContain('YouTube заблокував завантаження')
    expect(host.textContent).toContain('Задовгий запис')
  })

  it('lists the running jobs, with an «обліковий запис сервісу» label when there is no email', async () => {
    await mount()
    const rows = host.querySelectorAll('[data-testid="running-job"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('ivan.p@example.com')
    expect(rows[1].textContent).toContain('сервіс')
  })

  it('says so when no job is running', async () => {
    getOverview.mockResolvedValue({ ...FIXTURE, runningJobs: [] })
    await mount()
    expect(host.querySelectorAll('[data-testid="running-job"]')).toHaveLength(0)
    expect(host.textContent).toContain('Зараз нічого не виконується')
  })

  it('shows the state of each of the three switches', async () => {
    await mount()
    expect(q('switch-analysesPaused')?.getAttribute('data-state')).toBe('on')
    expect(q('switch-youtubeEnabled')?.getAttribute('data-state')).toBe('off')
    expect(q('switch-vocalsEnabled')?.getAttribute('data-state')).toBe('on')
    expect(q('switch-analysesPaused')?.textContent).toContain('Увімкнено')
    expect(q('switch-youtubeEnabled')?.textContent).toContain('Вимкнено')
  })

  it('renders an email as text, never as markup', async () => {
    const evil = '<img src=x onerror=alert(1)>@x.io'
    getOverview.mockResolvedValue({ ...FIXTURE, runningJobs: [{ ...FIXTURE.runningJobs[0], email: evil }] })
    await mount()
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain(evil)
  })

  it('shows an error with a retry instead of totals when the first load fails', async () => {
    getOverview.mockRejectedValue(new Error('boom'))
    await mount()
    expect(q('analyses-total')).toBeNull()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
  })
})

describe('Overview refresh (AC-02)', () => {
  it('«Оновити» sends exactly one request per click', async () => {
    await mount()
    expect(getOverview).toHaveBeenCalledTimes(1)
    await act(async () => refreshButton()!.click())
    expect(getOverview).toHaveBeenCalledTimes(2)
    await act(async () => refreshButton()!.click())
    expect(getOverview).toHaveBeenCalledTimes(3)
  })

  it('shows the new numbers after a refresh', async () => {
    await mount()
    getOverview.mockResolvedValue({ ...FIXTURE, vocals: 6 })
    await act(async () => refreshButton()!.click())
    expect(val('vocals')).toBe('6')
  })

  it('sets no timer and sends nothing while idle for 30 minutes', async () => {
    vi.useFakeTimers()
    await mount()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60_000)
    })
    expect(getOverview).toHaveBeenCalledTimes(1)
  })
})

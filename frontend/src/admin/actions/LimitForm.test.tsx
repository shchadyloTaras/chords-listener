// @vitest-environment jsdom
// AC-12 / AC-13 / AC-14 / AC-15 (test-plan rows for T33): the quota reset shows zeroed counters on the card, the
// personal-limit form saves and shows the end date, explains every invalid field with the allowed range (client
// checks and the server's details.fields), and an expired limit shows «завершився».
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from '../../store'
import type { AdminAccountState, AdminPersonalLimit, AdminUserCard } from '../../types'

const api = vi.hoisted(() => ({
  getUserCard: vi.fn(),
  listUserTracks: vi.fn(),
  resetQuota: vi.fn(),
  setPersonalLimit: vi.fn(),
  removePersonalLimit: vi.fn(),
}))

vi.mock('../../lib/adminApi', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/adminApi')>()),
  ...api,
}))

import { AdminApiError } from '../../lib/adminApi'
import { UserCard } from '../screens/UserCard'

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
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')

const todayUtc = () => new Date().toISOString().slice(0, 10)
const daysFromToday = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

function account(over: Partial<AdminAccountState> = {}): AdminAccountState {
  return {
    uid: 'u1',
    status: 'normal',
    restriction: null,
    deletion: null,
    personalLimit: null,
    quota: { day: todayUtc(), analyses: { used: 40, limit: 40 }, vocals: { used: 5, limit: 15 }, jobs: { used: 1, limit: 2 } },
    ...over,
  }
}

const limit = (over: Partial<AdminPersonalLimit> = {}): AdminPersonalLimit => ({
  analyses: 100,
  vocals: null,
  jobs: null,
  until: daysFromToday(10),
  setAt: '2026-10-08T10:05:00Z',
  byAdminUid: 'admin-1',
  expired: false,
  ...over,
})

function card(acc: AdminAccountState): AdminUserCard {
  return {
    profile: {
      uid: 'u1',
      email: 'ivan.p@example.test',
      createdAt: '2026-03-01T12:00:00Z',
      lastLoginAt: '2026-10-06T08:30:00Z',
      service: false,
      trackCount: 0,
      storageBytes: 0,
    },
    account: acc,
    recentJobs: [],
    tracks: { items: [], hasNext: false, hasPrev: false, nextCursor: null },
  }
}

async function open(acc: AdminAccountState) {
  api.getUserCard.mockResolvedValue(card(acc))
  await act(async () => {
    root.render(<UserCard uid="u1" />)
  })
  await flush()
}

/** a button anywhere in the page (the dialog lives in a portal) whose text is exactly `label` */
function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!found) throw new Error(`no button «${label}»`)
  return found as HTMLButtonElement
}

const hasButton = (label: string) => [...document.body.querySelectorAll('button')].some((b) => b.textContent?.trim() === label)

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function field(label: string): HTMLInputElement {
  const l = [...(dialog() ?? document.body).querySelectorAll('label')].find((n) => n.textContent?.trim() === label)
  if (!l) throw new Error(`no field «${label}»`)
  return document.getElementById(l.htmlFor) as HTMLInputElement
}

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submit() {
  await act(async () => {
    dialog()!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await flush()
}

/** the text shown beside a field: what its aria-describedby points at */
function beside(input: HTMLInputElement): string {
  return (input.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
}

const ANALYSES = 'Аналізи на добу'
const VOCALS = 'Транскрипції вокалу на добу'
const JOBS = 'Одночасні задачі'
const UNTIL = 'Остання доба дії (UTC)'

describe('UserCard — quota reset (AC-12)', () => {
  it('asks for confirmation and sends nothing when it is cancelled', async () => {
    await open(account())
    await click(button('Скинути квоту'))
    expect(dialog()).not.toBeNull()
    await click(button('Скасувати'))
    expect(api.resetQuota).not.toHaveBeenCalled()
    expect(text()).toContain('40 / 40')
  })

  it('shows zero counters on the card after the reset is confirmed, jobs in flight untouched', async () => {
    await open(account())
    expect(text()).toContain('40 / 40')
    api.resetQuota.mockResolvedValue(
      account({ quota: { day: todayUtc(), analyses: { used: 0, limit: 40 }, vocals: { used: 0, limit: 15 }, jobs: { used: 1, limit: 2 } } }),
    )
    await click(button('Скинути квоту'))
    await click(button('Скинути'))
    expect(api.resetQuota).toHaveBeenCalledTimes(1)
    expect(api.resetQuota.mock.calls[0][0]).toBe('u1')
    expect(text()).toContain('0 / 40')
    expect(text()).toContain('0 / 15')
    expect(text()).toContain('1 / 2')
    expect(text()).not.toContain('40 / 40')
  })

  it('keeps the old counters and says why when the reset is not applied', async () => {
    await open(account())
    api.resetQuota.mockRejectedValue(new AdminApiError('x', 'not_applied', 503))
    await click(button('Скинути квоту'))
    await click(button('Скинути'))
    expect(dialog()?.textContent).toContain('не застосовано')
    expect(text()).toContain('40 / 40')
  })
})

describe('UserCard — personal limit (AC-13)', () => {
  it('saves the limit and shows it with its end date on the card', async () => {
    await open(account())
    const until = daysFromToday(20)
    api.setPersonalLimit.mockResolvedValue(
      account({
        personalLimit: limit({ until }),
        quota: { day: todayUtc(), analyses: { used: 40, limit: 100 }, vocals: { used: 5, limit: 15 }, jobs: { used: 1, limit: 2 } },
      }),
    )
    await click(button('Задати ліміт'))
    await type(field(ANALYSES), '100')
    await type(field(UNTIL), until)
    await submit()
    expect(api.setPersonalLimit).toHaveBeenCalledTimes(1)
    expect(api.setPersonalLimit.mock.calls[0]).toEqual(['u1', { analyses: 100, until }])
    const t = text()
    expect(t).toContain('аналізи: 100')
    expect(t).toContain('вокал: як за замовчуванням')
    expect(t).toContain(`до ${until}`)
    expect(t).toContain('40 / 100')
    expect(t).not.toContain('завершився')
  })

  it('sends only the numbers that were filled in, and no end date when it is empty', async () => {
    await open(account())
    api.setPersonalLimit.mockResolvedValue(account({ personalLimit: limit({ analyses: null, jobs: 3, until: null }) }))
    await click(button('Задати ліміт'))
    await type(field(JOBS), '3')
    await submit()
    expect(api.setPersonalLimit.mock.calls[0]).toEqual(['u1', { jobs: 3 }])
    expect(text()).toContain('без кінцевої дати')
  })

  it('starts from the current limit when it is changed', async () => {
    await open(account({ personalLimit: limit({ analyses: 100, vocals: 20, until: '2099-01-31' }) }))
    await click(button('Змінити ліміт'))
    expect(field(ANALYSES).value).toBe('100')
    expect(field(VOCALS).value).toBe('20')
    expect(field(JOBS).value).toBe('')
    expect(field(UNTIL).value).toBe('2099-01-31')
  })

  it('removes the limit and shows «Немає»', async () => {
    await open(account({ personalLimit: limit() }))
    api.removePersonalLimit.mockResolvedValue(account())
    await click(button('Зняти ліміт'))
    await click(button('Зняти'))
    expect(api.removePersonalLimit).toHaveBeenCalledWith('u1')
    expect(text()).toMatch(/Персональний ліміт\s*Немає/)
  })

  it('offers no removal while there is no limit', async () => {
    await open(account())
    expect(hasButton('Зняти ліміт')).toBe(false)
  })
})

describe('UserCard — invalid personal limit (AC-14)', () => {
  it('asks for at least one number and sends nothing', async () => {
    await open(account())
    await click(button('Задати ліміт'))
    await submit()
    expect(api.setPersonalLimit).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain('Задайте хоча б одне число')
  })

  it.each([
    [ANALYSES, '1001', 'від 1 до 1000'],
    [ANALYSES, '0', 'від 1 до 1000'],
    [ANALYSES, '1.5', 'від 1 до 1000'],
    [ANALYSES, 'abc', 'від 1 до 1000'],
    [VOCALS, '151', 'від 1 до 150'],
    [VOCALS, '0', 'від 1 до 150'],
    [JOBS, '5', 'від 1 до 4'],
    [JOBS, '0', 'від 1 до 4'],
  ])('explains the allowed range beside «%s» for %s', async (label, value, range) => {
    await open(account())
    await click(button('Задати ліміт'))
    await type(field(label), value)
    await submit()
    expect(api.setPersonalLimit).not.toHaveBeenCalled()
    const input = field(label)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(beside(input)).toContain(range)
  })

  it('accepts the limits of every range', async () => {
    await open(account())
    api.setPersonalLimit.mockResolvedValue(account({ personalLimit: limit({ analyses: 1000, vocals: 150, jobs: 4, until: todayUtc() }) }))
    await click(button('Задати ліміт'))
    await type(field(ANALYSES), '1000')
    await type(field(VOCALS), '150')
    await type(field(JOBS), '4')
    await type(field(UNTIL), todayUtc())
    await submit()
    expect(api.setPersonalLimit.mock.calls[0]).toEqual(['u1', { analyses: 1000, vocals: 150, jobs: 4, until: todayUtc() }])
  })

  it('refuses an end date in the past and says it must be today (UTC) or later', async () => {
    await open(account())
    await click(button('Задати ліміт'))
    await type(field(ANALYSES), '100')
    await type(field(UNTIL), daysFromToday(-1))
    await submit()
    expect(api.setPersonalLimit).not.toHaveBeenCalled()
    const input = field(UNTIL)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(beside(input)).toContain('не раніше за сьогодні (UTC)')
    expect(field(ANALYSES).getAttribute('aria-invalid')).not.toBe('true') // the valid field carries no error
  })

  it('shows the range beside every invalid field at once', async () => {
    await open(account())
    await click(button('Задати ліміт'))
    await type(field(ANALYSES), '5000')
    await type(field(VOCALS), '0')
    await type(field(JOBS), '9')
    await submit()
    expect(beside(field(ANALYSES))).toContain('від 1 до 1000')
    expect(beside(field(VOCALS))).toContain('від 1 до 150')
    expect(beside(field(JOBS))).toContain('від 1 до 4')
  })

  it('shows the range beside the fields the server names in details.fields', async () => {
    await open(account())
    api.setPersonalLimit.mockRejectedValue(
      new AdminApiError('Some values are out of range', 'invalid_value', 422, {
        analyses: 'an integer from 1 to 1000',
        until: 'not before today (UTC)',
      }),
    )
    await click(button('Задати ліміт'))
    await type(field(ANALYSES), '100') // passes the client checks; the server disagrees
    await submit()
    expect(api.setPersonalLimit).toHaveBeenCalledTimes(1)
    expect(field(ANALYSES).getAttribute('aria-invalid')).toBe('true')
    expect(beside(field(ANALYSES))).toContain('від 1 до 1000')
    expect(field(UNTIL).getAttribute('aria-invalid')).toBe('true')
    expect(beside(field(UNTIL))).toContain('не раніше за сьогодні (UTC)')
    expect(text()).not.toContain('аналізи: 100') // nothing was saved
  })

  it('clears a field error once the field is edited', async () => {
    await open(account())
    await click(button('Задати ліміт'))
    await type(field(ANALYSES), '5000')
    await submit()
    expect(field(ANALYSES).getAttribute('aria-invalid')).toBe('true')
    await type(field(ANALYSES), '50')
    expect(field(ANALYSES).getAttribute('aria-invalid')).not.toBe('true')
  })
})

describe('UserCard — expired personal limit (AC-15)', () => {
  it('shows the limit as «завершився» with its end date', async () => {
    await open(account({ personalLimit: limit({ until: daysFromToday(-1), expired: true }) }))
    expect(text()).toContain('завершився')
    expect(text()).toContain(`до ${daysFromToday(-1)}`)
  })

  it('does not show «завершився» for a limit that is still in force', async () => {
    await open(account({ personalLimit: limit({ until: todayUtc(), expired: false }) }))
    expect(text()).not.toContain('завершився')
  })
})

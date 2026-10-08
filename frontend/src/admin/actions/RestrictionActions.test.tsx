// @vitest-environment jsdom
// AC-16 / AC-17 / AC-20 / AC-21 / AC-23 / AC-23b / AC-34 / AC-35 (test-plan rows for T34): the cloud restriction needs
// a reason and shows its state, reason and date on the card; the deletion dialog asks for the user's email and explains
// the rule; during a scheduled deletion the only state action is «Скасувати видалення»; refusals (self_target,
// deletion_pending, deletion_rate_limit, reauth_required, email mismatch) are explained and the dialog stays for a retry.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from '../../store'
import type { AdminAccountState, AdminUserCard } from '../../types'

const api = vi.hoisted(() => ({
  getUserCard: vi.fn(),
  listUserTracks: vi.fn(),
  resetQuota: vi.fn(),
  setPersonalLimit: vi.fn(),
  removePersonalLimit: vi.fn(),
  restrictUser: vi.fn(),
  unrestrictUser: vi.fn(),
  scheduleDeletion: vi.fn(),
  cancelDeletion: vi.fn(),
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

const EMAIL = 'Ivan.P@example.test'
const text = () => host.textContent ?? ''
const flush = () => act(async () => undefined)
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')

const todayUtc = () => new Date().toISOString().slice(0, 10)

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

const restricted = (reason = 'автоматичні масові запити') =>
  account({ status: 'restricted', restriction: { reason, since: '2026-10-08T10:10:00Z', byAdminUid: 'admin-1' } })

const scheduled = (prior: AdminAccountState['restriction'] = null) =>
  account({
    status: 'deletion_scheduled',
    restriction: prior ?? { reason: 'deletion scheduled', since: '2026-10-08T10:20:00Z', byAdminUid: 'admin-1' },
    deletion: { scheduledAt: '2026-10-08T10:20:00Z', purgeAfter: '2026-10-15T10:20:00Z', byAdminUid: 'admin-1' },
  })

function card(acc: AdminAccountState): AdminUserCard {
  return {
    profile: {
      uid: 'u1',
      email: EMAIL,
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
  await flush()
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const l = [...(dialog() ?? document.body).querySelectorAll('label')].find((n) => n.textContent?.trim() === label)
  if (!l) throw new Error(`no field «${label}»`)
  return document.getElementById(l.htmlFor) as HTMLInputElement | HTMLTextAreaElement
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
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
function beside(input: HTMLElement): string {
  return (input.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
}

const REASON = 'Причина обмеження'
const CONFIRM_EMAIL = 'Email користувача'

describe('UserCard — cloud restriction (AC-16)', () => {
  it('offers to restrict a normal account and shows state, reason and date after it is saved', async () => {
    await open(account())
    api.restrictUser.mockResolvedValue(restricted())
    await click(button('Обмежити хмару'))
    await type(field(REASON), '  автоматичні масові запити ')
    await submit()
    expect(api.restrictUser).toHaveBeenCalledTimes(1)
    expect(api.restrictUser.mock.calls[0]).toEqual(['u1', 'автоматичні масові запити'])
    expect(dialog()).toBeNull()
    const t = text()
    expect(t).toContain('Хмарне обмеження')
    expect(t).toContain('автоматичні масові запити')
    expect(t).toContain('2026-10-08 10:10 UTC')
  })

  it('needs a reason: an empty one is explained beside the field and nothing is sent', async () => {
    await open(account())
    await click(button('Обмежити хмару'))
    await submit()
    expect(api.restrictUser).not.toHaveBeenCalled()
    expect(beside(field(REASON))).toContain('Вкажіть причину')
    await type(field(REASON), '   ')
    await submit()
    expect(api.restrictUser).not.toHaveBeenCalled()
    expect(dialog()).not.toBeNull()
  })

  it('refuses a reason longer than 500 characters before sending it', async () => {
    await open(account())
    await click(button('Обмежити хмару'))
    await type(field(REASON), 'x'.repeat(501))
    await submit()
    expect(api.restrictUser).not.toHaveBeenCalled()
    expect(beside(field(REASON))).toContain('500')
  })

  it('says the reason is visible to admins only', async () => {
    await open(account())
    await click(button('Обмежити хмару'))
    expect(dialog()?.textContent).toContain('лише адміністратори')
  })

  it('changes the reason of a restricted account, starting from the current one, and can lift the restriction', async () => {
    await open(restricted('стара причина'))
    expect(hasButton('Обмежити хмару')).toBe(false)
    await click(button('Змінити причину'))
    expect((field(REASON) as HTMLTextAreaElement).value).toBe('стара причина')
    api.restrictUser.mockResolvedValue(restricted('нова причина'))
    await type(field(REASON), 'нова причина')
    await submit()
    expect(api.restrictUser.mock.calls[0]).toEqual(['u1', 'нова причина'])
    expect(text()).toContain('нова причина')

    api.unrestrictUser.mockResolvedValue(account())
    await click(button('Зняти обмеження'))
    if (dialog()) await click(button('Зняти'))
    expect(api.unrestrictUser).toHaveBeenCalledWith('u1')
    expect(text()).toMatch(/Стан\s*Звичайний/)
  })

  it('keeps the dialog open with the reason when the change is not applied', async () => {
    await open(account())
    api.restrictUser.mockRejectedValue(new AdminApiError('x', 'not_applied', 503))
    await click(button('Обмежити хмару'))
    await type(field(REASON), 'спам')
    await submit()
    expect(dialog()?.textContent).toContain('не застосовано')
    expect(field(REASON).value).toBe('спам')
    expect(text()).toMatch(/Стан\s*Звичайний/)
  })
})

describe('UserCard — own account (AC-17)', () => {
  it('explains that an admin cannot restrict their own account', async () => {
    await open(account())
    api.restrictUser.mockRejectedValue(new AdminApiError('x', 'self_target', 409))
    await click(button('Обмежити хмару'))
    await type(field(REASON), 'тест')
    await submit()
    expect(dialog()?.textContent).toContain('не може обмежити чи видалити власний акаунт')
    expect(text()).toMatch(/Стан\s*Звичайний/)
  })

  it('explains that an admin cannot schedule the deletion of their own account', async () => {
    await open(account())
    api.scheduleDeletion.mockRejectedValue(new AdminApiError('x', 'self_target', 409))
    await click(button('Запланувати видалення'))
    await type(field(CONFIRM_EMAIL), EMAIL)
    await submit()
    expect(api.scheduleDeletion).toHaveBeenCalledTimes(1)
    expect(dialog()?.textContent).toContain('не може обмежити чи видалити власний акаунт')
    expect(text()).toMatch(/Стан\s*Звичайний/)
  })
})

describe('UserCard — scheduling deletion (AC-20 / AC-21)', () => {
  it('explains the rule: type exactly the email of this user, and the 7-day window', async () => {
    await open(account())
    await click(button('Запланувати видалення'))
    const d = dialog()!.textContent!
    expect(d).toContain('саме email цього користувача')
    expect(d).toContain(EMAIL)
    expect(d).toContain('7 днів')
    expect(api.scheduleDeletion).not.toHaveBeenCalled()
  })

  it('schedules the deletion once the email is typed and shows the state with the date', async () => {
    await open(account())
    api.scheduleDeletion.mockResolvedValue(scheduled())
    await click(button('Запланувати видалення'))
    await type(field(CONFIRM_EMAIL), ' ivan.p@EXAMPLE.test ')
    await submit()
    expect(api.scheduleDeletion).toHaveBeenCalledTimes(1)
    expect(api.scheduleDeletion.mock.calls[0]).toEqual(['u1', 'ivan.p@EXAMPLE.test'])
    expect(dialog()).toBeNull()
    const t = text()
    expect(t).toContain('Заплановане видалення')
    expect(t).toContain('видалення після 2026-10-15 10:20 UTC')
  })

  it('does not schedule when the typed email differs, and says so beside the field', async () => {
    await open(account())
    await click(button('Запланувати видалення'))
    await type(field(CONFIRM_EMAIL), 'someone.else@example.test')
    await submit()
    expect(api.scheduleDeletion).not.toHaveBeenCalled()
    expect(beside(field(CONFIRM_EMAIL))).toContain('не збігається з email користувача')
    expect(dialog()).not.toBeNull()
    expect(text()).toMatch(/Стан\s*Звичайний/)
  })

  it('does not schedule on an empty email', async () => {
    await open(account())
    await click(button('Запланувати видалення'))
    await submit()
    expect(api.scheduleDeletion).not.toHaveBeenCalled()
    expect(beside(field(CONFIRM_EMAIL))).toContain('саме email цього користувача')
  })

  it('shows the server mismatch answer too, keeping the dialog open', async () => {
    await open(account())
    api.scheduleDeletion.mockRejectedValue(new AdminApiError('x', 'confirm_email_mismatch', 422))
    await click(button('Запланувати видалення'))
    await type(field(CONFIRM_EMAIL), EMAIL)
    await submit()
    expect(dialog()?.textContent).toContain('не збігається з email користувача')
    expect(text()).toMatch(/Стан\s*Звичайний/)
  })

  it('is offered for a restricted account as well', async () => {
    await open(restricted())
    expect(hasButton('Запланувати видалення')).toBe(true)
  })
})

describe('UserCard — deletion limit and fresh login (AC-35 / AC-34)', () => {
  it('explains the cap of 10 deletions per 60 minutes', async () => {
    await open(account())
    api.scheduleDeletion.mockRejectedValue(new AdminApiError('x', 'deletion_rate_limit', 429))
    await click(button('Запланувати видалення'))
    await type(field(CONFIRM_EMAIL), EMAIL)
    await submit()
    expect(dialog()?.textContent).toContain('не більше 10 видалень за будь-які 60 хвилин')
    expect(text()).toMatch(/Стан\s*Звичайний/)
  })

  it('explains that a fresh login is needed, keeps the email, and a second try goes through (re-login, then retry)', async () => {
    await open(account())
    api.scheduleDeletion.mockRejectedValueOnce(new AdminApiError('x', 'reauth_required', 401)).mockResolvedValueOnce(scheduled())
    await click(button('Запланувати видалення'))
    await type(field(CONFIRM_EMAIL), EMAIL)
    await submit()
    expect(dialog()?.textContent).toContain('увійшовши ще раз')
    expect(field(CONFIRM_EMAIL).value).toBe(EMAIL)
    expect(text()).toMatch(/Стан\s*Звичайний/)
    await submit()
    expect(api.scheduleDeletion).toHaveBeenCalledTimes(2)
    expect(dialog()).toBeNull()
    expect(text()).toContain('Заплановане видалення')
  })

  it('does not send twice while a call is in flight', async () => {
    await open(account())
    let finish!: (a: AdminAccountState) => void
    api.scheduleDeletion.mockReturnValue(new Promise<AdminAccountState>((r) => (finish = r)))
    await click(button('Запланувати видалення'))
    await type(field(CONFIRM_EMAIL), EMAIL)
    await submit()
    await submit()
    expect(api.scheduleDeletion).toHaveBeenCalledTimes(1)
    await act(async () => finish(scheduled()))
    expect(text()).toContain('Заплановане видалення')
  })
})

describe('UserCard — account under a scheduled deletion (AC-23 / AC-23b)', () => {
  it('offers only «Скасувати видалення» among the state actions', async () => {
    await open(scheduled())
    expect(hasButton('Скасувати видалення')).toBe(true)
    for (const other of ['Обмежити хмару', 'Змінити причину', 'Зняти обмеження', 'Запланувати видалення']) expect(hasButton(other)).toBe(false)
    expect(text()).toContain('Заплановане видалення')
    expect(text()).toContain('2026-10-15 10:20 UTC')
  })

  it('cancelling brings back the plain state when there was no restriction before', async () => {
    await open(scheduled())
    api.cancelDeletion.mockResolvedValue(account())
    await click(button('Скасувати видалення'))
    expect(api.cancelDeletion).toHaveBeenCalledWith('u1')
    expect(text()).toMatch(/Стан\s*Звичайний/)
    expect(hasButton('Скасувати видалення')).toBe(false)
    expect(hasButton('Обмежити хмару')).toBe(true)
  })

  it('cancelling brings back the earlier restriction with the same reason', async () => {
    await open(scheduled({ reason: 'ранішня причина', since: '2026-10-01T09:00:00Z', byAdminUid: 'admin-2' }))
    api.cancelDeletion.mockResolvedValue(restricted('ранішня причина'))
    await click(button('Скасувати видалення'))
    const t = text()
    expect(t).toContain('Хмарне обмеження')
    expect(t).toContain('ранішня причина')
    expect(t).not.toContain('Заплановане видалення')
    expect(hasButton('Зняти обмеження')).toBe(true)
  })

  it('says why when the cancellation window has passed', async () => {
    await open(scheduled())
    api.cancelDeletion.mockRejectedValue(new AdminApiError('x', 'not_scheduled', 409))
    await click(button('Скасувати видалення'))
    expect(text()).toContain('вікно скасування вже минуло')
    expect(text()).toContain('Заплановане видалення')
  })

  it('explains «спершу скасуйте» when the server refuses a restriction change during a deletion', async () => {
    await open(account())
    api.restrictUser.mockRejectedValue(new AdminApiError('x', 'deletion_pending', 409))
    await click(button('Обмежити хмару'))
    await type(field(REASON), 'тест')
    await submit()
    expect(dialog()?.textContent).toContain('спершу скасуйте')
  })
})

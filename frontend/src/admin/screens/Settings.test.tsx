// @vitest-environment jsdom
// Service-settings screen (US-12…US-14): default limits with their allowed ranges (AC-24, AC-25), the three
// switches with the pause needing a fresh login only when turned on (AC-26, AC-28, AC-34), and the maintenance
// banner, 1–250 characters in both languages, previewed as plain text (AC-29, AC-30).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminSettings } from '../../types'
import { useApp } from '../../store'

const auth = vi.hoisted(() => ({
  getIdToken: vi.fn<(forceRefresh?: boolean) => Promise<string | null>>(),
  requestSignIn: vi.fn<(reason?: string) => Promise<boolean>>(),
}))

vi.mock('../../lib/auth', () => ({
  getIdToken: auth.getIdToken,
  requestSignIn: auth.requestSignIn,
  useAuth: { getState: () => ({ user: null, ready: true }), subscribe: () => () => undefined },
}))

import { AdminApiError } from '../../lib/adminApi'
import * as adminApi from '../../lib/adminApi'
import { Settings, type SettingsApi } from './Settings'
import { SWITCH_LABEL } from './labels'

const SETTINGS: AdminSettings = {
  limits: { analyses: 40, vocals: 15, jobs: 2, maxDurationMin: 20, maxUploadMb: 500 },
  switches: { analysesPaused: false, youtubeEnabled: true, vocalsEnabled: true },
  banner: { enabled: false, uk: 'Технічні роботи', en: 'Maintenance' },
  updatedAt: '2026-10-08T08:00:00Z',
  updatedBy: 'admin-1',
}

function fakeApi(over: Partial<SettingsApi> = {}) {
  return {
    getSettings: vi.fn<SettingsApi['getSettings']>(async () => SETTINGS),
    setDefaultLimits: vi.fn<SettingsApi['setDefaultLimits']>(async (limits) => ({ ...SETTINGS, limits })),
    setSwitch: vi.fn<SettingsApi['setSwitch']>(async (name, value) => ({ ...SETTINGS, switches: { ...SETTINGS.switches, [name]: value } })),
    setBanner: vi.fn<SettingsApi['setBanner']>(async (banner) => ({ ...SETTINGS, banner })),
    ...over,
  }
}

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
  vi.unstubAllGlobals()
  auth.getIdToken.mockReset()
  auth.requestSignIn.mockReset()
})

async function render(api: SettingsApi) {
  await act(async () => {
    root.render(<Settings api={api} />)
  })
}

const text = () => host.textContent ?? ''

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const l = [...host.querySelectorAll('label')].find((x) => (x.textContent ?? '').trim().startsWith(label))
  if (!l) throw new Error(`no label «${label}»`)
  const el = l.htmlFor ? document.getElementById(l.htmlFor) : l.querySelector('input,textarea')
  if (!el) throw new Error(`label «${label}» has no field`)
  return el as HTMLInputElement | HTMLTextAreaElement
}

function switchOf(name: string): HTMLElement {
  const el = [...host.querySelectorAll('[role="switch"]')].find((x) => (x.getAttribute('aria-label') ?? '').startsWith(name))
  if (!el) throw new Error(`no switch «${name}»`)
  return el as HTMLElement
}

function button(label: string): HTMLButtonElement {
  const b = [...host.querySelectorAll('button')].find((x) => (x.textContent ?? '').trim() === label)
  if (!b) throw new Error(`no button «${label}»`)
  return b
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click()
  })
}

function section(title: string): HTMLElement {
  const h = [...host.querySelectorAll('h2')].find((x) => (x.textContent ?? '').trim() === title)
  if (!h) throw new Error(`no section «${title}»`)
  return h.closest('section') as HTMLElement
}

describe('loading', () => {
  it('shows three sections with the stored values', async () => {
    await render(fakeApi())
    expect(section('Типові ліміти')).toBeTruthy()
    expect(section('Перемикачі сервісу')).toBeTruthy()
    expect(section('Банер обслуговування')).toBeTruthy()
    expect(field('Аналізи на добу').value).toBe('40')
    expect(field('Транскрипції вокалу').value).toBe('15')
    expect(field('Одночасні задачі').value).toBe('2')
    expect(field('Тривалість пісні').value).toBe('20')
    expect(field('Розмір файлу').value).toBe('500')
    expect(field('Текст банера (українською)').value).toBe('Технічні роботи')
    expect(field('Текст банера (English)').value).toBe('Maintenance')
  })

  it('says so and offers a retry when the settings cannot be loaded', async () => {
    const getSettings = vi.fn<SettingsApi['getSettings']>().mockRejectedValueOnce(new AdminApiError('x', 'network')).mockResolvedValue(SETTINGS)
    await render(fakeApi({ getSettings }))
    expect(text()).toContain('Сервер не відповідає')
    expect(host.querySelector('[role="switch"]')).toBeNull()
    await click(button('Спробувати ще раз'))
    expect(field('Аналізи на добу').value).toBe('40')
  })
})

describe('default limits (AC-24, AC-25)', () => {
  it('explains the allowed range next to each field and points to the pause switch', async () => {
    await render(fakeApi())
    const limits = section('Типові ліміти').textContent ?? ''
    expect(limits).toContain('1–1000')
    expect(limits).toContain('1–150')
    expect(limits).toContain('1–4')
    expect(limits).toContain('1–120')
    expect(limits).toContain('від 1 МБ до 512 МБ')
    expect(limits).toContain('0,5 ГБ')
    expect(limits).toContain('Пауза нових аналізів')
  })

  it('saves a valid change with all five values (AC-24)', async () => {
    const api = fakeApi()
    await render(api)
    await type(field('Аналізи на добу'), '30')
    await click(button('Зберегти ліміти'))
    expect(api.setDefaultLimits).toHaveBeenCalledTimes(1)
    expect(api.setDefaultLimits).toHaveBeenCalledWith({ analyses: 30, vocals: 15, jobs: 2, maxDurationMin: 20, maxUploadMb: 500 })
    expect(text()).toContain('Збережено')
    expect(field('Аналізи на добу').value).toBe('30')
  })

  it.each([
    ['Аналізи на добу', '', 'від 1 до 1000'],
    ['Аналізи на добу', '0', 'від 1 до 1000'],
    ['Аналізи на добу', '-5', 'від 1 до 1000'],
    ['Аналізи на добу', '1001', 'від 1 до 1000'],
    ['Аналізи на добу', '1.5', 'від 1 до 1000'],
    ['Транскрипції вокалу', '151', 'від 1 до 150'],
    ['Одночасні задачі', '5', 'від 1 до 4'],
    ['Тривалість пісні', '121', 'від 1 до 120 хвилин'],
    ['Розмір файлу', '513', 'від 1 МБ до 512 МБ (0,5 ГБ)'],
    ['Розмір файлу', 'abc', 'від 1 МБ до 512 МБ (0,5 ГБ)'],
  ])('does not save %s = «%s» and says what is allowed (AC-25)', async (label, value, allowed) => {
    const api = fakeApi()
    await render(api)
    await type(field(label), value)
    await click(button('Зберегти ліміти'))
    expect(api.setDefaultLimits).not.toHaveBeenCalled()
    const alert = section('Типові ліміти').querySelector('[role="alert"]')
    expect(alert?.textContent ?? '').toContain(allowed)
    expect(text()).not.toContain('Збережено')
  })

  it('accepts the edges of every range', async () => {
    const api = fakeApi()
    await render(api)
    await type(field('Аналізи на добу'), '1000')
    await type(field('Транскрипції вокалу'), '1')
    await type(field('Одночасні задачі'), '4')
    await type(field('Тривалість пісні'), '120')
    await type(field('Розмір файлу'), '512')
    await click(button('Зберегти ліміти'))
    expect(api.setDefaultLimits).toHaveBeenCalledWith({ analyses: 1000, vocals: 1, jobs: 4, maxDurationMin: 120, maxUploadMb: 512 })
  })

  it('shows the server field messages when it refuses the values', async () => {
    const api = fakeApi({
      setDefaultLimits: vi.fn(async () => {
        throw new AdminApiError('bad', 'invalid_value', 422, { analyses: 'an integer from 1 to 1000' })
      }),
    })
    await render(api)
    await click(button('Зберегти ліміти'))
    const limits = section('Типові ліміти').textContent ?? ''
    expect(limits).toContain('Деякі значення не підходять')
    expect(limits).toContain('an integer from 1 to 1000')
    expect(limits).not.toContain('Збережено')
  })

  it('tells the change was not applied when the journal write failed (AC-33)', async () => {
    const api = fakeApi({
      setDefaultLimits: vi.fn(async () => {
        throw new AdminApiError('x', 'not_applied', 503)
      }),
    })
    await render(api)
    await click(button('Зберегти ліміти'))
    expect(section('Типові ліміти').textContent).toContain('Зміну не застосовано, повторіть')
  })
})

describe('switches (AC-26, AC-27, AC-28)', () => {
  it('shows the current state of the three switches', async () => {
    await render(fakeApi())
    expect(switchOf(SWITCH_LABEL.analysesPaused).getAttribute('aria-checked')).toBe('false')
    expect(switchOf(SWITCH_LABEL.youtubeEnabled).getAttribute('aria-checked')).toBe('true')
    expect(switchOf(SWITCH_LABEL.vocalsEnabled).getAttribute('aria-checked')).toBe('true')
  })

  it('says that accepted jobs are never stopped', async () => {
    await render(fakeApi())
    expect(section('Перемикачі сервісу').textContent).toContain('Прийняті задачі завершуються')
  })

  it('turns YouTube off and on with the switch, without asking for the password', async () => {
    const api = fakeApi()
    await render(api)
    await click(switchOf(SWITCH_LABEL.youtubeEnabled))
    expect(api.setSwitch).toHaveBeenLastCalledWith('youtubeEnabled', false)
    expect(switchOf(SWITCH_LABEL.youtubeEnabled).getAttribute('aria-checked')).toBe('false')
    await click(switchOf(SWITCH_LABEL.youtubeEnabled))
    expect(api.setSwitch).toHaveBeenLastCalledWith('youtubeEnabled', true)
    expect(switchOf(SWITCH_LABEL.youtubeEnabled).getAttribute('aria-checked')).toBe('true')
  })

  it('turns vocal transcription off with the switch', async () => {
    const api = fakeApi()
    await render(api)
    await click(switchOf(SWITCH_LABEL.vocalsEnabled))
    expect(api.setSwitch).toHaveBeenCalledWith('vocalsEnabled', false)
    expect(switchOf(SWITCH_LABEL.vocalsEnabled).getAttribute('aria-checked')).toBe('false')
  })

  it('warns beside the pause switch that turning it on asks for the password, and not beside the others', async () => {
    await render(fakeApi())
    const rows = [...section('Перемикачі сервісу').querySelectorAll('[data-switch]')]
    const byName = (n: string) => rows.find((r) => r.getAttribute('data-switch') === n)?.textContent ?? ''
    expect(byName('analysesPaused')).toContain('повторно ввести пароль')
    expect(byName('youtubeEnabled')).not.toContain('пароль')
    expect(byName('vocalsEnabled')).not.toContain('пароль')
  })

  it('keeps the old state and says why when a switch change is not applied', async () => {
    const api = fakeApi({
      setSwitch: vi.fn(async () => {
        throw new AdminApiError('x', 'not_applied', 503)
      }),
    })
    await render(api)
    await click(switchOf(SWITCH_LABEL.youtubeEnabled))
    expect(switchOf(SWITCH_LABEL.youtubeEnabled).getAttribute('aria-checked')).toBe('true')
    expect(section('Перемикачі сервісу').textContent).toContain('Зміну не застосовано, повторіть')
  })
})

describe('pause needs a fresh login only when turned on (AC-34)', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  function realApi(getSettings: () => Promise<AdminSettings> = async () => SETTINGS): SettingsApi {
    return { getSettings, setDefaultLimits: adminApi.setDefaultLimits, setSwitch: adminApi.setSwitch, setBanner: adminApi.setBanner }
  }

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    auth.getIdToken.mockImplementation(async (force) => (force ? 'tok-fresh' : 'tok-1'))
    auth.requestSignIn.mockResolvedValue(true)
  })

  const paused = { ...SETTINGS, switches: { ...SETTINGS.switches, analysesPaused: true } }

  it('asks for the password, then pauses', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'Sign in again', code: 'reauth_required' }, 401)).mockResolvedValueOnce(json(paused))
    await render(realApi())
    await click(switchOf(SWITCH_LABEL.analysesPaused))
    expect(auth.requestSignIn).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ value: true })
    expect(switchOf(SWITCH_LABEL.analysesPaused).getAttribute('aria-checked')).toBe('true')
  })

  it('leaves the pause off, with an explanation, when the password is not confirmed', async () => {
    auth.requestSignIn.mockResolvedValue(false)
    fetchMock.mockResolvedValue(json({ detail: 'Sign in again', code: 'reauth_required' }, 401))
    await render(realApi())
    await click(switchOf(SWITCH_LABEL.analysesPaused))
    expect(switchOf(SWITCH_LABEL.analysesPaused).getAttribute('aria-checked')).toBe('false')
    expect(section('Перемикачі сервісу').textContent).toContain('Підтвердіть дію, увійшовши ще раз')
  })

  it('does not ask for the password when the pause is turned off or another switch changes', async () => {
    fetchMock.mockImplementation(async () => json(SETTINGS))
    await render(realApi(async () => paused))
    await click(switchOf(SWITCH_LABEL.analysesPaused))
    await click(switchOf(SWITCH_LABEL.youtubeEnabled))
    expect(auth.requestSignIn).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('maintenance banner (AC-29, AC-30)', () => {
  it('explains the length rule beside the form', async () => {
    await render(fakeApi())
    expect(section('Банер обслуговування').textContent).toContain('від 1 до 250 символів обома мовами')
  })

  it('publishes both texts with the show/hide choice', async () => {
    const api = fakeApi()
    await render(api)
    await type(field('Текст банера (українською)'), 'Хмарний аналіз тимчасово на паузі')
    await type(field('Текст банера (English)'), 'Cloud analysis is paused for now')
    await click(switchOf('Показувати банер'))
    await click(button('Опублікувати банер'))
    expect(api.setBanner).toHaveBeenCalledWith({ enabled: true, uk: 'Хмарний аналіз тимчасово на паузі', en: 'Cloud analysis is paused for now' })
    expect(section('Банер обслуговування').textContent).toContain('Збережено')
  })

  it('turns the banner off keeping its texts', async () => {
    const api = fakeApi({ getSettings: vi.fn(async () => ({ ...SETTINGS, banner: { ...SETTINGS.banner, enabled: true } })) })
    await render(api)
    await click(switchOf('Показувати банер'))
    await click(button('Опублікувати банер'))
    expect(api.setBanner).toHaveBeenCalledWith({ enabled: false, uk: 'Технічні роботи', en: 'Maintenance' })
  })

  it.each([
    ['uk', ''],
    ['uk', '   '],
    ['uk', 'x'.repeat(251)],
    ['en', ''],
    ['en', 'x'.repeat(251)],
  ])('does not publish an invalid %s text of %j', async (lang, value) => {
    const api = fakeApi()
    await render(api)
    await type(field(lang === 'uk' ? 'Текст банера (українською)' : 'Текст банера (English)'), value)
    await click(button('Опублікувати банер'))
    expect(api.setBanner).not.toHaveBeenCalled()
    const alert = section('Банер обслуговування').querySelector('[role="alert"]')
    expect(alert?.textContent ?? '').toContain('від 1 до 250 символів обома мовами')
  })

  it.each([1, 250])('accepts a text of %i characters in both languages', async (n) => {
    const api = fakeApi()
    await render(api)
    await type(field('Текст банера (українською)'), 'я'.repeat(n))
    await type(field('Текст банера (English)'), 'e'.repeat(n))
    await click(button('Опублікувати банер'))
    expect(api.setBanner).toHaveBeenCalledWith({ enabled: false, uk: 'я'.repeat(n), en: 'e'.repeat(n) })
  })

  it('shows how many characters each text has', async () => {
    await render(fakeApi())
    expect(section('Банер обслуговування').textContent).toContain('15 / 250')
    expect(section('Банер обслуговування').textContent).toContain('11 / 250')
  })

  it('previews both texts as plain text, never as markup', async () => {
    await render(fakeApi())
    await type(field('Текст банера (English)'), '<b>Bold</b> <img src=x onerror=alert(1)>')
    const preview = host.querySelector('[data-banner-preview="en"]') as HTMLElement
    expect(preview.textContent).toBe('<b>Bold</b> <img src=x onerror=alert(1)>')
    expect(preview.querySelector('b,img')).toBeNull()
    expect((host.querySelector('[data-banner-preview="uk"]') as HTMLElement).textContent).toBe('Технічні роботи')
  })

  it('shows the server field messages when it refuses the banner', async () => {
    const api = fakeApi({
      setBanner: vi.fn(async () => {
        throw new AdminApiError('bad', 'invalid_value', 422, { uk: '1 to 250 characters' })
      }),
    })
    await render(api)
    await click(button('Опублікувати банер'))
    expect(section('Банер обслуговування').textContent).toContain('1 to 250 characters')
  })
})

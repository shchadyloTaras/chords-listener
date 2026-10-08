// @vitest-environment jsdom
// AC-31: a signed-in person without the admin mark sees only «Сторінку не знайдено» — no data, no action
// names, no menu. A signed-out visitor sees only a sign-in prompt; the admin sees the shell.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth, useAuthDialog } from '../lib/auth'
import { useApp } from '../store'
import { AdminApp } from './AdminApp'
import { ADMIN_NAV } from './useAdminRoute'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('CSS', { escape: (s: string) => s })
  // jsdom has no matchMedia (the theme hook reads prefers-color-scheme)
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
  useApp.setState({ lang: 'uk' })
  useAuthDialog.setState({ open: false, reason: null })
  window.location.hash = '#/'
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  useAuth.setState({ user: null, ready: false })
})

const signedIn = () => useAuth.setState({ user: { uid: 'u1', email: 'a@b.c' }, ready: true })
const render = async (probe: () => Promise<boolean>) => {
  await act(async () => {
    root.render(createElement(AdminApp, { probe }))
  })
}
const text = () => document.body.textContent ?? ''
const NAV_WORDS = ADMIN_NAV.map((n) => n.label)

describe('AdminApp access', () => {
  it('shows a non-admin only «Сторінку не знайдено»', async () => {
    signedIn()
    await render(() => Promise.resolve(false))
    expect(text()).toContain('Сторінку не знайдено')
    for (const w of NAV_WORDS) expect(text()).not.toContain(w)
    expect(document.querySelector('nav')).toBeNull()
  })

  it('answers a failed access check exactly like a non-admin', async () => {
    signedIn()
    await render(() => Promise.reject(new Error('network')))
    expect(text()).toContain('Сторінку не знайдено')
    expect(document.querySelector('nav')).toBeNull()
  })

  it('shows nothing of the admin while the access check is running', async () => {
    signedIn()
    await render(() => new Promise<boolean>(() => undefined))
    expect(document.querySelector('nav')).toBeNull()
    for (const w of NAV_WORDS) expect(text()).not.toContain(w)
  })

  it('gives a signed-out visitor only a sign-in prompt', async () => {
    useAuth.setState({ user: null, ready: true })
    const probe = vi.fn(() => Promise.resolve(true))
    await render(probe)
    expect(probe).not.toHaveBeenCalled()
    expect(document.querySelector('nav')).toBeNull()
    for (const w of NAV_WORDS) expect(text()).not.toContain(w)
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Увійти'))
    expect(button).toBeTruthy()
    act(() => button!.click())
    expect(useAuthDialog.getState().open).toBe(true)
  })

  it('shows the admin shell with the six screens to an admin', async () => {
    signedIn()
    await render(() => Promise.resolve(true))
    const nav = document.querySelector('nav')
    expect(nav).not.toBeNull()
    expect([...nav!.querySelectorAll('a')].map((a) => a.textContent)).toEqual(NAV_WORDS)
    expect(text()).not.toContain('Сторінку не знайдено')
  })

  it.each(['#/', '#/users', '#/jobs', '#/stats', '#/audit', '#/settings'])('renders a real screen at %s, not the empty placeholder', async (hash) => {
    vi.stubGlobal('fetch', () => new Promise(() => undefined))
    signedIn()
    window.location.hash = hash
    await render(() => Promise.resolve(true))
    expect(document.querySelector('section[data-screen]:empty')).toBeNull()
  })

  it('shows an admin «Сторінку не знайдено» for an unknown address', async () => {
    signedIn()
    window.location.hash = '#/nope'
    await render(() => Promise.resolve(true))
    expect(text()).toContain('Сторінку не знайдено')
  })
})

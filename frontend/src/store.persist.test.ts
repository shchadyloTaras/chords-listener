// @vitest-environment jsdom
// Persisted settings: `keepAwake` (the screen stays on while the app is open) is saved on this device only.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const KEY = 'chords-listener-settings'

/** A fresh page load: the store module reads localStorage when it is created. */
async function load() {
  vi.resetModules()
  return (await import('./store')).useApp
}

beforeEach(() => localStorage.clear())

describe('keepAwake', () => {
  it('is on by default', async () => {
    expect((await load()).getState().keepAwake).toBe(true)
  })

  it('is saved and read back on this device', async () => {
    ;(await load()).getState().setSetting('keepAwake', false)
    expect(JSON.parse(localStorage.getItem(KEY)!).state.keepAwake).toBe(false)
    expect((await load()).getState().keepAwake).toBe(false)
  })

  it('is on for settings saved before it existed', async () => {
    localStorage.setItem(KEY, JSON.stringify({ state: { lang: 'en', liveKeys: false }, version: 1 }))
    const app = (await load()).getState()
    expect(app.lang).toBe('en')
    expect(app.keepAwake).toBe(true)
  })
})

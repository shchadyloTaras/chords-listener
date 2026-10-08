// @vitest-environment jsdom
// Persisted settings: `keepAwake` (the screen stays on while the app is open) and the tuner's `tunerA4` are saved on this device only.
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

describe('tunerA4', () => {
  it('is 440 by default and for settings saved before it existed', async () => {
    expect((await load()).getState().tunerA4).toBe(440)
    localStorage.setItem(KEY, JSON.stringify({ state: { lang: 'en' }, version: 1 }))
    expect((await load()).getState().tunerA4).toBe(440)
  })

  it('is saved and read back on this device', async () => {
    ;(await load()).getState().setSetting('tunerA4', 442)
    expect(JSON.parse(localStorage.getItem(KEY)!).state.tunerA4).toBe(442)
    expect((await load()).getState().tunerA4).toBe(442)
  })
})

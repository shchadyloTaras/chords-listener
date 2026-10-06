// Which tours this device has seen: localStorage["chords-listener-tours"] = { "<tourId>": true }. Blocked or
// broken storage must never break the page — it reads as "nothing seen", so a tour simply shows again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNCED_KEYS } from '../syncedSettings'
import { isTourSeen, markTourSeen, seenTours, TOURS_KEY } from './storage'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the seen-tours flag', () => {
  it('lives under its own device-local key, never synced', () => {
    expect(TOURS_KEY).toBe('chords-listener-tours')
    expect((SYNCED_KEYS as readonly string[]).some((k) => /tour/i.test(k))).toBe(false)
  })

  it('reads nothing seen at first, then remembers each tour separately', () => {
    expect(seenTours()).toEqual({})
    expect(isTourSeen('home')).toBe(false)
    markTourSeen('home')
    markTourSeen('song')
    expect(isTourSeen('home')).toBe(true)
    expect(isTourSeen('score')).toBe(false)
    expect(JSON.parse(localStorage.getItem(TOURS_KEY)!)).toEqual({ home: true, song: true })
  })

  it.each(['not json', 'null', '[]', '"home"', '{"home":1,"song":true}'])(
    'reads a broken value %j as nothing seen (keeping only valid entries) and repairs it on write',
    (raw) => {
      localStorage.setItem(TOURS_KEY, raw)
      expect(isTourSeen('home')).toBe(false)
      markTourSeen('listen')
      const saved = JSON.parse(localStorage.getItem(TOURS_KEY)!) as Record<string, unknown>
      expect(saved.listen).toBe(true)
      expect(saved.home).toBeUndefined()
    },
  )

  it('never throws where storage is blocked: reads as not seen, writes are dropped', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
    })
    expect(isTourSeen('home')).toBe(false)
    expect(() => markTourSeen('home')).not.toThrow()
    expect(isTourSeen('home')).toBe(false)
  })
})

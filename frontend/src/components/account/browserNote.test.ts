// The one-time "these chords were recognized in the browser" note: dismissed once, hidden for good
// (a localStorage flag; blocked storage must never break the page).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissNote, noteDismissed, NOTE_KEY } from './browserNote'

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

describe('the browser-analysis note flag', () => {
  it('shows until it is dismissed, then stays hidden', () => {
    expect(noteDismissed()).toBe(false)
    dismissNote()
    expect(localStorage.getItem(NOTE_KEY)).toBe('1')
    expect(noteDismissed()).toBe(true)
  })

  it('lives under its own key', () => {
    expect(NOTE_KEY).toBe('chords-listener-note-browser')
  })

  it('reads as "not dismissed" and never throws where storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
    })
    expect(noteDismissed()).toBe(false)
    expect(() => dismissNote()).not.toThrow()
  })
})

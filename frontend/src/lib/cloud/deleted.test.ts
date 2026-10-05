// @vitest-environment jsdom
// Tracks deleted on this device: hidden from what is kept here and from list answers that set off before the
// delete, until a list shows the delete went through (or the song is listed again after it), or a week.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDeleted, DELETED_TTL_MS, deleteConfirmed, forgetDeleted, isDeleted, rememberDeleted, settleDeleted, withoutDeleted } from './deleted'

const songs = (...ids: string[]) => ids.map((id) => ({ id }))
const ids = (list: { id: string }[]) => list.map((t) => t.id)

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 9, 5, 12))
})

afterEach(() => vi.useRealTimers())

describe('deleted tracks', () => {
  it('are per account', () => {
    rememberDeleted('u1', 'a')
    expect(isDeleted('u1', 'a')).toBe(true)
    expect(isDeleted('u2', 'a')).toBe(false)
    expect(ids(withoutDeleted('u1', songs('a', 'b')))).toEqual(['b'])
    expect(ids(withoutDeleted('u2', songs('a', 'b')))).toEqual(['a', 'b'])
  })

  it('a list asked after the delete that no longer has it settles it', () => {
    const before = Date.now()
    rememberDeleted('u1', 'a')
    expect(ids(settleDeleted('u1', songs('a', 'b'), before))).toEqual(['b'])
    expect(isDeleted('u1', 'a')).toBe(true)
    vi.setSystemTime(Date.now() + 1)
    expect(ids(settleDeleted('u1', songs('b'), Date.now()))).toEqual(['b'])
    expect(isDeleted('u1', 'a')).toBe(false)
  })

  it('listed again by a list asked after the cloud confirmed the delete: it shows', () => {
    rememberDeleted('u1', 'a')
    deleteConfirmed('u1', 'a')
    vi.setSystemTime(Date.now() + 1)
    expect(ids(settleDeleted('u1', songs('a'), Date.now()))).toEqual(['a'])
    expect(isDeleted('u1', 'a')).toBe(false)
  })

  it('not confirmed: a list that still has it keeps hiding it, for a week at most', () => {
    rememberDeleted('u1', 'a')
    vi.setSystemTime(Date.now() + 1)
    expect(ids(settleDeleted('u1', songs('a'), Date.now()))).toEqual([])
    vi.setSystemTime(Date.now() + DELETED_TTL_MS)
    expect(ids(settleDeleted('u1', songs('a'), Date.now()))).toEqual(['a'])
  })

  it('forgotten one by one or all at once (sign-out)', () => {
    rememberDeleted('u1', 'a')
    rememberDeleted('u1', 'b')
    forgetDeleted('u1', 'a')
    expect(isDeleted('u1', 'a')).toBe(false)
    clearDeleted()
    expect(isDeleted('u1', 'b')).toBe(false)
  })

  it('survives blocked storage', () => {
    const orig = { get: Storage.prototype.getItem, set: Storage.prototype.setItem }
    Storage.prototype.getItem = Storage.prototype.setItem = () => {
      throw new Error('blocked')
    }
    try {
      expect(() => rememberDeleted('u1', 'a')).not.toThrow()
      expect(isDeleted('u1', 'a')).toBe(false)
      expect(ids(settleDeleted('u1', songs('a'), Date.now()))).toEqual(['a'])
    } finally {
      Storage.prototype.getItem = orig.get
      Storage.prototype.setItem = orig.set
    }
  })
})

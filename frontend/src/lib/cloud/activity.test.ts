// @vitest-environment jsdom
// Server jobs started on this device: a page load asks the server for its job list only when one of them
// may still be running (every request wakes the cloud).
import { beforeEach, describe, expect, it } from 'vitest'
import { forgetServerJob, recentServerJobs, rememberServerJob } from './activity'

beforeEach(() => localStorage.clear())

describe('recent server jobs', () => {
  it('keeps jobs of the last 2 hours', () => {
    rememberServerJob('a')
    expect(recentServerJobs()).toEqual(['a'])
    expect(recentServerJobs(Date.now() + 2 * 3600_000 + 1)).toEqual([])
  })

  it('forgets finished jobs', () => {
    rememberServerJob('a')
    forgetServerJob('a')
    expect(recentServerJobs()).toEqual([])
  })

  it('keeps the newest 20, each once', () => {
    for (let i = 0; i < 25; i++) rememberServerJob(`j${i}`)
    rememberServerJob('j24')
    const ids = recentServerJobs()
    expect(ids).toHaveLength(20)
    expect(ids[0]).toBe('j5')
    expect(ids.filter((id) => id === 'j24')).toHaveLength(1)
  })

  it('survives blocked storage', () => {
    const orig = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('blocked')
    }
    try {
      expect(recentServerJobs()).toEqual([])
      expect(() => rememberServerJob('a')).not.toThrow()
      expect(() => forgetServerJob('a')).not.toThrow()
    } finally {
      Storage.prototype.getItem = orig
    }
  })

  it('ignores a damaged entry', () => {
    localStorage.setItem('chords-listener-server-jobs', '{"not":"a list"}')
    expect(recentServerJobs()).toEqual([])
    rememberServerJob('a')
    expect(recentServerJobs()).toEqual(['a'])
  })
})

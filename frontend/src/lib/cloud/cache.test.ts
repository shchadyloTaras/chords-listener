// The signed-in user's cloud library kept on this device (on fake-indexeddb): opening the site and replaying a
// song ask the cloud nothing (every request wakes a Cloud Run instance).
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track, TrackSummary } from '../../types'
import {
  AUDIO_BUDGET_BYTES,
  cachedAudio,
  cachedJson,
  cachedList,
  cachedTrack,
  clearCloudCache,
  forgetTrack,
  isFresh,
  LIST_TTL_MS,
  markListStale,
  OPEN_TIMEOUT_MS,
  saveAudio,
  saveJson,
  saveList,
  saveTrack,
  TRACK_TTL_MS,
} from './cache'

function summary(id: string, patch: Partial<TrackSummary> = {}): TrackSummary {
  return { id, title: `Song ${id}`, duration: 10, source: { type: 'file', filename: `${id}.mp3` }, createdAt: '2026-10-05T00:00:00Z', ...patch }
}

function track(id: string, patch: Partial<Track> = {}): Track {
  return {
    ...summary(id),
    audioUrl: `/api/tracks/${id}/audio?u=u1&exp=1&sig=x`,
    timeSignature: 4,
    beats: [],
    downbeats: [],
    chords: [],
    waveform: [],
    engine: 'madmom',
    ...patch,
  }
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the cloud cache', () => {
  it('stores and returns a list per uid', async () => {
    await saveList('u1', [summary('a')])
    expect((await cachedList('u1'))?.tracks.map((t) => t.id)).toEqual(['a'])
    expect(await cachedList('u2')).toBeNull()
  })

  it('delete removes it from the cached list', async () => {
    await saveList('u1', [summary('a'), summary('b')])
    await saveTrack('u1', track('a'))
    await forgetTrack('u1', 'a')
    expect((await cachedList('u1'))?.tracks.map((t) => t.id)).toEqual(['b'])
    expect(await cachedTrack('u1', 'a')).toBeNull()
  })

  it('edit replaces the cached track', async () => {
    await saveTrack('u1', track('a', { title: 'old' }))
    await saveTrack('u1', track('a', { title: 'new' }))
    expect((await cachedTrack('u1', 'a'))?.title).toBe('new')
  })

  it('evicts the least recently used audio over budget', async () => {
    const big = new Blob([new Uint8Array(AUDIO_BUDGET_BYTES / 2 + 1)])
    await saveAudio('u1', 'a', big)
    await saveAudio('u1', 'b', big)
    expect(await cachedAudio('u1', 'a')).toBeNull()
    expect(await cachedAudio('u1', 'b')).not.toBeNull()
  })

  it('works without IndexedDB', async () => {
    const idb = globalThis.indexedDB
    // @ts-expect-error simulate a browser without it
    delete globalThis.indexedDB
    try {
      // a fresh module: no connection opened earlier can stand in for the missing IndexedDB
      vi.resetModules()
      const fresh = await import('./cache')
      await fresh.saveList('u1', [summary('a')])
      expect(await fresh.cachedList('u1')).toBeNull()
      await fresh.saveAudio('u1', 'a', new Blob(['x']))
      expect(await fresh.cachedAudio('u1', 'a')).toBeNull()
      await expect(fresh.clearCloudCache()).resolves.toBeUndefined()
    } finally {
      globalThis.indexedDB = idb
    }
  })

  it('clearCloudCache removes everything', async () => {
    await saveList('u1', [summary('a')])
    await saveTrack('u1', track('a'))
    await saveAudio('u1', 'a', new Blob(['x']))
    await clearCloudCache()
    expect(await cachedList('u1')).toBeNull()
    expect(await cachedTrack('u1', 'a')).toBeNull()
    expect(await cachedAudio('u1', 'a')).toBeNull()
  })

  it('expired audio URL: a cached blob still plays', async () => {
    await saveAudio('u1', 'a', new Blob(['x']))
    expect(await cachedAudio('u1', 'a')).not.toBeNull()
  })
})

describe('what is kept, and for whom', () => {
  it('keeps every part per account', async () => {
    await saveTrack('u1', track('a'))
    await saveAudio('u1', 'a', new Blob(['mp3']))
    await saveJson('u1', 'notes', 'a', { version: 1 })
    expect(await cachedTrack('u2', 'a')).toBeNull()
    expect(await cachedAudio('u2', 'a')).toBeNull()
    expect(await cachedJson('u2', 'notes', 'a')).toBeNull()
    expect(await (await cachedAudio('u1', 'a'))?.text()).toBe('mp3')
    expect(await cachedJson('u1', 'notes', 'a')).toEqual({ version: 1 })
    expect(await cachedJson('u1', 'vocals', 'a')).toBeNull()
  })

  it('a track is kept for less time than its signed audio URL lives (12 h)', async () => {
    expect(TRACK_TTL_MS).toBe(6 * 3600_000)
    expect(TRACK_TTL_MS).toBeLessThan(12 * 3600_000)
    // this device's own changes refresh the list sooner; another device's show by then (or with «Оновити»)
    expect(LIST_TTL_MS).toBe(6 * 3600_000)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 9, 5, 12))
    await saveTrack('u1', track('a'))
    vi.setSystemTime(Date.now() + TRACK_TTL_MS - 1)
    expect(await cachedTrack('u1', 'a')).not.toBeNull()
    vi.setSystemTime(Date.now() + 1)
    expect(await cachedTrack('u1', 'a')).toBeNull()
  })

  it('a clock that went back makes nothing look fresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 9, 5, 12))
    await saveTrack('u1', track('a'))
    vi.setSystemTime(Date.now() - 60_000)
    expect(await cachedTrack('u1', 'a')).toBeNull()
    expect(isFresh(Date.now() + 1, LIST_TTL_MS)).toBe(false)
    expect(isFresh(Date.now(), LIST_TTL_MS)).toBe(true)
  })

  it('a list from the server squares what is kept with it', async () => {
    await saveList('u1', [summary('a'), summary('b'), summary('c')])
    await saveTrack('u1', track('a'))
    await saveTrack('u1', track('b'))
    await saveTrack('u1', track('c'))
    await saveAudio('u1', 'a', new Blob(['a']))
    await saveAudio('u1', 'c', new Blob(['c']))
    await saveJson('u1', 'notes', 'c', { n: 1 })
    await saveJson('u1', 'vocals', 'c', { v: 1 })
    // only the audio and notes of d are kept (its track JSON ran out)
    await saveAudio('u1', 'd', new Blob(['d']))
    await saveJson('u1', 'notes', 'd', { n: 1 })
    await saveTrack('u2', track('c'))
    // b renamed and c deleted on another device
    await saveList('u1', [summary('a'), summary('b', { title: 'Renamed elsewhere' })])
    expect(await cachedTrack('u1', 'a')).not.toBeNull()
    expect(await cachedAudio('u1', 'a')).not.toBeNull()
    expect(await cachedTrack('u1', 'b')).toBeNull()
    expect(await cachedTrack('u1', 'c')).toBeNull()
    expect(await cachedAudio('u1', 'c')).toBeNull()
    expect(await cachedJson('u1', 'notes', 'c')).toBeNull()
    expect(await cachedJson('u1', 'vocals', 'c')).toBeNull()
    expect(await cachedAudio('u1', 'd')).toBeNull()
    expect(await cachedJson('u1', 'notes', 'd')).toBeNull()
    // another account's are not this list's business
    expect(await cachedTrack('u2', 'c')).not.toBeNull()
  })

  it('a list much shorter than the one kept (the server could not read its storage?) is not trusted yet', async () => {
    await saveList('u1', [summary('a'), summary('b'), summary('c')])
    await saveTrack('u1', track('a'))
    await saveAudio('u1', 'a', new Blob(['a']))
    for (const answer of [[], [summary('b')]]) {
      await saveList('u1', [summary('a'), summary('b'), summary('c')])
      await saveList('u1', answer)
      const list = await cachedList('u1')
      // what the server said shows, but is asked again next time; nothing kept goes for it
      expect(list?.tracks.map((t) => t.id)).toEqual(answer.map((t) => t.id))
      expect(isFresh(list?.savedAt ?? Date.now(), LIST_TTL_MS)).toBe(false)
      expect(await cachedTrack('u1', 'a')).not.toBeNull()
      expect(await cachedAudio('u1', 'a')).not.toBeNull()
    }
    // the same answer again: now it is the truth
    await saveList('u1', [summary('b')])
    expect(isFresh((await cachedList('u1'))?.savedAt ?? 0, LIST_TTL_MS)).toBe(true)
    expect(await cachedTrack('u1', 'a')).toBeNull()
    expect(await cachedAudio('u1', 'a')).toBeNull()
  })

  it('half of the list gone is still an ordinary answer', async () => {
    await saveList('u1', [summary('a'), summary('b')])
    await saveTrack('u1', track('a'))
    await saveList('u1', [summary('b')])
    expect(isFresh((await cachedList('u1'))?.savedAt ?? 0, LIST_TTL_MS)).toBe(true)
    expect(await cachedTrack('u1', 'a')).toBeNull()
  })

  it('a stale list keeps its tracks but is asked again', async () => {
    await saveList('u1', [summary('a')])
    await markListStale('u1')
    const list = await cachedList('u1')
    expect(list?.tracks.map((t) => t.id)).toEqual(['a'])
    expect(isFresh(list?.savedAt ?? Date.now(), LIST_TTL_MS)).toBe(false)
    // nothing kept: nothing to mark
    await markListStale('u2')
    expect(await cachedList('u2')).toBeNull()
  })

  it('the list says when it was saved', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 9, 5, 12))
    await saveList('u1', [summary('a')])
    expect((await cachedList('u1'))?.savedAt).toBe(Date.UTC(2026, 9, 5, 12))
  })

  it('a saved track refreshes its entry in the list, which keeps its age', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 9, 5, 12))
    await saveList('u1', [summary('a'), summary('b')])
    vi.setSystemTime(Date.now() + 60_000)
    await saveTrack('u1', track('a', { title: 'Renamed', edited: true, chords: [] }))
    await saveTrack('u1', track('c'))
    const list = await cachedList('u1')
    expect(list?.savedAt).toBe(Date.UTC(2026, 9, 5, 12))
    // a track that is not listed is not added (the list is the server's)
    expect(list?.tracks.map((t) => t.id)).toEqual(['a', 'b'])
    expect(list?.tracks[0]).toMatchObject({ id: 'a', title: 'Renamed', edited: true })
    // the list holds summaries, not whole tracks
    expect(list?.tracks[0]).not.toHaveProperty('audioUrl')
    expect(list?.tracks[0]).not.toHaveProperty('chords')
  })

  it('forgets only the parts asked for', async () => {
    await saveList('u1', [summary('a')])
    await saveTrack('u1', track('a'))
    await saveAudio('u1', 'a', new Blob(['mp3']))
    await saveJson('u1', 'notes', 'a', { n: 1 })
    await saveJson('u1', 'vocals', 'a', { v: 1 })
    // the server changed the track (vocals transcribed): its JSON goes, the rest stays
    await forgetTrack('u1', 'a', ['track', 'vocals'])
    expect(await cachedTrack('u1', 'a')).toBeNull()
    expect(await cachedJson('u1', 'vocals', 'a')).toBeNull()
    expect(await cachedJson('u1', 'notes', 'a')).toEqual({ n: 1 })
    expect(await cachedAudio('u1', 'a')).not.toBeNull()
    expect((await cachedList('u1'))?.tracks.map((t) => t.id)).toEqual(['a'])
    // deleted: everything goes
    await forgetTrack('u1', 'a')
    expect(await cachedAudio('u1', 'a')).toBeNull()
    expect(await cachedJson('u1', 'notes', 'a')).toBeNull()
    expect((await cachedList('u1'))?.tracks).toEqual([])
  })

  it('playing a song makes it the most recently used', async () => {
    const third = new Blob([new Uint8Array(Math.floor(AUDIO_BUDGET_BYTES / 3))])
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 9, 5, 12))
    await saveAudio('u1', 'a', third)
    vi.setSystemTime(Date.now() + 1000)
    await saveAudio('u1', 'b', third)
    vi.setSystemTime(Date.now() + 1000)
    await saveAudio('u1', 'c', third)
    vi.setSystemTime(Date.now() + 1000)
    expect(await cachedAudio('u1', 'a')).not.toBeNull()
    vi.setSystemTime(Date.now() + 1000)
    await saveAudio('u1', 'd', third)
    // b was the least recently used
    expect(await cachedAudio('u1', 'b')).toBeNull()
    expect(await cachedAudio('u1', 'a')).not.toBeNull()
    expect(await cachedAudio('u1', 'c')).not.toBeNull()
    expect(await cachedAudio('u1', 'd')).not.toBeNull()
  })

  it('a file over the whole budget is not kept', async () => {
    await saveAudio('u1', 'a', new Blob(['x']))
    await saveAudio('u1', 'huge', new Blob([new Uint8Array(AUDIO_BUDGET_BYTES + 1)]))
    expect(await cachedAudio('u1', 'huge')).toBeNull()
    expect(await cachedAudio('u1', 'a')).not.toBeNull()
  })

  it('a hanging IndexedDB holds nothing up', async () => {
    const idb = globalThis.indexedDB
    // an open request that never answers (seen in some browsers)
    globalThis.indexedDB = { open: () => ({}), deleteDatabase: () => ({}) } as unknown as IDBFactory
    vi.useFakeTimers()
    try {
      const pending = cachedList('u1')
      await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS)
      expect(await pending).toBeNull()
    } finally {
      vi.useRealTimers()
      globalThis.indexedDB = idb
    }
  })
})

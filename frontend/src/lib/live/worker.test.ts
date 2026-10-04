import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { resample } from '../engine/core/resample.ts'
import { SR } from '../engine/core/spectrum.ts'
import { SONGS, agreement, renderSong } from './testing/songs.ts'
import type { FromWorker, ToWorker } from './protocol.ts'

interface FakeScope {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: FromWorker): void
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(id: number): void
}

const posted: { at: number; msg: FromWorker }[] = []
const scope: FakeScope = {
  onmessage: null,
  postMessage: (msg) => posted.push({ at: performance.now(), msg }),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id),
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.stubGlobal('self', scope)
  await import('./worker.ts')
})

afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function send(msg: ToWorker | unknown): void {
  scope.onmessage!({ data: msg })
}

describe('live analysis worker', () => {
  it('ignores PCM before init and unrelated messages', () => {
    send({ type: 'pcm', samples: new Float32Array(4800) })
    send({ type: 'nope' })
    send(null)
    expect(posted).toEqual([])
  })

  it('posts throttled updates (<= 10 Hz) and the final chords on finish', () => {
    const rate = 48000
    const song = renderSong(SONGS[0], SR)
    const x = resample(song.audio, SR, rate)
    send({ type: 'init', sampleRate: rate } satisfies ToWorker)
    send({ type: 'init', sampleRate: 1 } satisfies ToWorker) // a second init is ignored
    const batch = 2048
    for (let i = 0; i < x.length; i += batch) {
      send({ type: 'pcm', samples: x.slice(i, i + batch) } satisfies ToWorker)
      // real time: one batch every ~43 ms
      vi.advanceTimersByTime((batch / rate) * 1000)
    }
    const updates = posted.filter((p) => p.msg.type === 'update')
    expect(updates.length).toBeGreaterThan(song.duration * 8)
    expect(updates.length).toBeLessThanOrEqual(song.duration * 10 + 2)
    for (let i = 1; i < updates.length; i++) expect(updates[i].at - updates[i - 1].at).toBeGreaterThanOrEqual(99)
    const last = updates[updates.length - 1].msg
    if (last.type !== 'update') throw new Error('expected an update')
    expect(last.time).toBeGreaterThan(song.duration - 0.2)
    expect(last.load).toBeGreaterThanOrEqual(0) // performance.now() is faked here
    expect(last.key?.name).toBe('C')

    send({ type: 'finish' } satisfies ToWorker)
    const result = posted[posted.length - 1].msg
    expect(result.type).toBe('result')
    if (result.type !== 'result') return
    expect(result.duration).toBeCloseTo(x.length / rate, 6)
    expect(result.chords[0].start).toBe(0)
    expect(result.chords[result.chords.length - 1].end).toBeCloseTo(result.duration, 2)
    expect(agreement(result.chords, song.truth, 0, song.duration, 0.15)).toBeGreaterThan(0.97)
    // finished: more input or a second finish change nothing
    const n = posted.length
    send({ type: 'pcm', samples: new Float32Array(4800) })
    send({ type: 'finish' })
    vi.advanceTimersByTime(500)
    expect(posted.length).toBe(n)
  })
})

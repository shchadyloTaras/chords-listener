// The worker in recording-only mode (`analyze: false`, the microphone): time and level, no chords.
// A file of its own: the worker module keeps one session per import.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FromWorker, ToWorker } from './protocol.ts'

interface FakeScope {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: FromWorker): void
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(id: number): void
}

const posted: FromWorker[] = []
const scope: FakeScope = {
  onmessage: null,
  postMessage: (msg) => posted.push(msg),
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

function send(msg: ToWorker): void {
  scope.onmessage!({ data: msg })
}

describe('live worker without chord analysis', () => {
  it('posts time and level only, and an empty result at once on finish', () => {
    const rate = 48000
    const batch = 2048
    const seconds = 6
    send({ type: 'init', sampleRate: rate, analyze: false })
    const x = new Float32Array(batch)
    for (let i = 0; i < batch; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / rate)
    const batches = Math.round((seconds * rate) / batch)
    for (let i = 0; i < batches; i++) {
      send({ type: 'pcm', samples: x.slice() })
      vi.advanceTimersByTime((batch / rate) * 1000)
    }
    const updates = posted.filter((m) => m.type === 'update')
    expect(updates.length).toBeGreaterThan(seconds * 8)
    for (const u of updates) {
      if (u.type !== 'update') continue
      expect(u.finalized).toEqual([])
      expect(u.open).toEqual([])
      expect(u.key).toBeNull()
      expect(u.tempo).toBeNull()
    }
    const last = updates[updates.length - 1]
    if (last.type !== 'update') throw new Error('expected an update')
    expect(last.level).toBeGreaterThan(0.8)
    expect(last.time).toBeGreaterThan(seconds - 0.2)

    send({ type: 'finish' })
    const result = posted[posted.length - 1]
    expect(result).toEqual({ type: 'result', chords: [], duration: (batches * batch) / rate })
  })
})

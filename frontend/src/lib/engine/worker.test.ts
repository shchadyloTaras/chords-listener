import { beforeAll, describe, expect, it, vi } from 'vitest'
import { SR } from './core/spectrum.ts'
import type { AnalyzeRequest, WorkerMessage } from './protocol.ts'
import { renderProgression } from './testing/synth.ts'

interface FakeScope {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: WorkerMessage): void
}

const posted: WorkerMessage[] = []
const scope: FakeScope = { onmessage: null, postMessage: (m) => posted.push(m) }

beforeAll(async () => {
  vi.stubGlobal('self', scope)
  await import('./worker.ts')
  return () => vi.unstubAllGlobals()
})

function send(data: unknown): WorkerMessage[] {
  posted.length = 0
  scope.onmessage!({ data })
  return posted.slice()
}

describe('analysis worker', () => {
  it('posts throttled, monotonic progress and then the result', () => {
    const song = renderProgression(
      [{ notes: [60, 64, 67], bass: 36 }, { notes: [57, 60, 64], bass: 45 }],
      { sr: SR, bpm: 120, beatsPerChord: 4, leadIn: 0.5, tail: 0.5 },
    )
    const req: AnalyzeRequest = { type: 'analyze', samples: song.audio, sampleRate: SR, duration: song.duration }
    const msgs = send(req)
    const progress = msgs.filter((m) => m.type === 'progress')
    expect(progress.length).toBeGreaterThan(5)
    expect(progress.length).toBeLessThan(150)
    progress.forEach((m, i) => i > 0 && expect(m.fraction).toBeGreaterThanOrEqual(progress[i - 1].fraction))
    const last = msgs[msgs.length - 1]
    expect(last.type).toBe('result')
    if (last.type === 'result') {
      // silent lead-in, then the two chords (the last one rings into the short tail)
      expect(last.analysis.chords.map((c) => c.label).slice(0, 3)).toEqual(['N', 'C', 'Am'])
    }
  })

  it('reports failures as an error message instead of throwing', () => {
    const msgs = send({ type: 'analyze', samples: null, sampleRate: SR, duration: 1 })
    expect(msgs[msgs.length - 1]).toMatchObject({ type: 'error', code: 'analysis_failed' })
  })

  it('ignores unrelated messages', () => {
    expect(send({ type: 'ping' })).toEqual([])
    expect(send(null)).toEqual([])
  })
})

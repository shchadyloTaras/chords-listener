import { describe, expect, it } from 'vitest'
import { MetronomeScheduler, type PlannedClick, type SchedulerInput } from './scheduler'

const BEATS = Array.from({ length: 40 }, (_, i) => i * 0.5) // 120 BPM from t = 0
const ACCENTS = BEATS.map((_, i) => i % 4 === 0)

/**
 * Simulates the driver: ticks every `step` audio seconds while the "player" advances by
 * `rate` media seconds per audio second. Returns every click planned (cancelled ones removed).
 */
function run(
  s: MetronomeScheduler,
  opts: { from?: number; to: number; ctx0?: number; media0?: number; rate?: number; step?: number },
  extra: Partial<SchedulerInput> = {},
): { clicks: PlannedClick[]; cancels: number; end: { ctx: number; media: number } } {
  const rate = opts.rate ?? 1
  const step = opts.step ?? 0.025
  let ctx = opts.ctx0 ?? 10
  let media = opts.media0 ?? 0
  let clicks: PlannedClick[] = []
  let cancels = 0
  while (media < opts.to) {
    const r = s.update({ enabled: true, ctxTime: ctx, mediaTime: media, rate, ...extra })
    if (r.cancel) {
      cancels++
      clicks = clicks.filter((c) => c.at <= ctx)
    }
    clicks.push(...r.clicks)
    ctx += step
    media += step * rate
  }
  return { clicks, cancels, end: { ctx, media } }
}

describe('metronome scheduler', () => {
  it('schedules every beat once, on time, with accents on downbeats', () => {
    const s = new MetronomeScheduler()
    s.setGrid(BEATS, ACCENTS)
    const { clicks, cancels } = run(s, { to: 4 })
    expect(cancels).toBe(0)
    // beats 0..4 s inclusive within the lookahead → 0, 0.5, … 4.0
    expect(clicks.map((c) => c.beat)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    for (const c of clicks) expect(c.at).toBeCloseTo(10 + BEATS[c.beat], 6)
    expect(clicks.filter((c) => c.accent).map((c) => c.beat)).toEqual([0, 4, 8])
  })

  it('never schedules further ahead than the lookahead', () => {
    const s = new MetronomeScheduler({ lookahead: 0.1 })
    s.setGrid(BEATS, ACCENTS)
    const r = s.update({ enabled: true, ctxTime: 5, mediaTime: 0.45, rate: 1 })
    expect(r.clicks.map((c) => c.beat)).toEqual([1])
    expect(r.clicks[0].at).toBeCloseTo(5.05, 6)
    expect(s.update({ enabled: true, ctxTime: 5.025, mediaTime: 0.475, rate: 1 }).clicks).toEqual([])
  })

  it('maps media time through the playback rate', () => {
    const s = new MetronomeScheduler()
    s.setGrid(BEATS, ACCENTS)
    const { clicks } = run(s, { to: 2, rate: 0.5 })
    const ats = clicks.map((c) => c.at)
    // 0.5 s of music per beat takes 1 s of real time at ×0.5
    for (let i = 1; i < ats.length; i++) expect(ats[i] - ats[i - 1]).toBeCloseTo(1, 6)
  })

  it('re-syncs on a rate change', () => {
    const s = new MetronomeScheduler()
    s.setGrid(BEATS, ACCENTS)
    s.update({ enabled: true, ctxTime: 0, mediaTime: 0.9, rate: 1 })
    const r = s.update({ enabled: true, ctxTime: 0.025, mediaTime: 0.925, rate: 1.5 })
    expect(r.cancel).toBe(true)
    expect(r.clicks[0].beat).toBe(2)
    expect(r.clicks[0].at).toBeCloseTo(0.025 + 0.075 / 1.5, 6)
  })

  it('cancels and re-syncs after a seek', () => {
    const s = new MetronomeScheduler()
    s.setGrid(BEATS, ACCENTS)
    s.update({ enabled: true, ctxTime: 0, mediaTime: 0.95, rate: 1 }) // queues beat 2 (t = 1.0)
    const r = s.update({ enabled: true, ctxTime: 0.025, mediaTime: 10.43, rate: 1 })
    expect(r.cancel).toBe(true)
    expect(r.clicks.map((c) => c.beat)).toEqual([21])
    expect(r.clicks[0].at).toBeCloseTo(0.025 + 0.07, 6)
    // seeking backwards works the same way
    const back = s.update({ enabled: true, ctxTime: 0.05, mediaTime: 2.49, rate: 1 })
    expect(back.cancel).toBe(true)
    expect(back.clicks.map((c) => c.beat)).toEqual([5])
  })

  it('clicks a beat that was just passed when re-syncing, never an old one', () => {
    const s = new MetronomeScheduler()
    s.setGrid(BEATS, ACCENTS)
    const r = s.update({ enabled: true, ctxTime: 3, mediaTime: 2.02, rate: 1 })
    expect(r.clicks[0]).toEqual({ at: 3, beat: 4, accent: true })
    const s2 = new MetronomeScheduler()
    s2.setGrid(BEATS, ACCENTS)
    expect(s2.update({ enabled: true, ctxTime: 3, mediaTime: 2.2, rate: 1 }).clicks).toEqual([])
  })

  it('stops on pause and resumes from the new position', () => {
    const s = new MetronomeScheduler()
    s.setGrid(BEATS, ACCENTS)
    s.update({ enabled: true, ctxTime: 0, mediaTime: 0.95, rate: 1 })
    const paused = s.update({ enabled: false, ctxTime: 0.025, mediaTime: 0.97, rate: 1 })
    expect(paused).toEqual({ cancel: true, clicks: [] })
    // a second disabled tick has nothing left to cancel
    expect(s.update({ enabled: false, ctxTime: 0.05, mediaTime: 0.97, rate: 1 }).cancel).toBe(false)
    const resumed = s.update({ enabled: true, ctxTime: 7, mediaTime: 0.97, rate: 1 })
    expect(resumed.cancel).toBe(false)
    expect(resumed.clicks.map((c) => c.beat)).toEqual([2])
    expect(resumed.clicks[0].at).toBeCloseTo(7.03, 6)
  })

  it('absorbs small clock jitter without re-syncing', () => {
    const s = new MetronomeScheduler()
    s.setGrid(BEATS, ACCENTS)
    let ctx = 0
    let cancels = 0
    const beats: number[] = []
    for (let i = 0; i < 200; i++) {
      const jitter = ((i * 7919) % 13) / 1000 - 0.006 // ±6 ms of reporting noise
      const r = s.update({ enabled: true, ctxTime: ctx, mediaTime: ctx + jitter, rate: 1 })
      if (r.cancel) cancels++
      for (const c of r.clicks) {
        beats.push(c.beat)
        expect(Math.abs(c.at - BEATS[c.beat])).toBeLessThan(0.01)
      }
      ctx += 0.025
    }
    expect(cancels).toBe(0)
    expect(beats).toEqual([...new Set(beats)].sort((a, b) => a - b))
  })

  it('drops clicks that are already late after a stalled tick instead of bunching them', () => {
    const s = new MetronomeScheduler()
    s.setGrid(BEATS, ACCENTS)
    s.update({ enabled: true, ctxTime: 0, mediaTime: 0, rate: 1 })
    // the timer stalls (background tab) for 0.18 s; media advanced consistently
    const r = s.update({ enabled: true, ctxTime: 0.18, mediaTime: 0.18, rate: 1 })
    expect(r.cancel).toBe(false)
    expect(r.clicks).toEqual([])
    const r2 = s.update({ enabled: true, ctxTime: 1.6, mediaTime: 1.6, rate: 1 })
    // 1.0 and 1.5 are long gone (1.5 is 0.1 s late) → skipped; 1.5 < now - 0.03
    expect(r2.clicks.map((c) => c.beat)).toEqual([])
    const r3 = s.update({ enabled: true, ctxTime: 1.92, mediaTime: 1.92, rate: 1 })
    expect(r3.clicks.map((c) => c.beat)).toEqual([4])
  })

  it('holds the clicks at the end of an A-B loop until the wrap', () => {
    const s = new MetronomeScheduler()
    s.setGrid(BEATS, ACCENTS)
    const loop = { loopEnd: 2 }
    const near = s.update({ enabled: true, ctxTime: 0, mediaTime: 1.95, rate: 1, ...loop })
    expect(near.clicks).toEqual([]) // beat at 2.0 = loop end is not queued
    const wrapped = s.update({ enabled: true, ctxTime: 0.06, mediaTime: 0, rate: 1, ...loop })
    expect(wrapped.cancel).toBe(true)
    expect(wrapped.clicks.map((c) => c.beat)).toEqual([0])
    expect(wrapped.clicks[0].accent).toBe(true)
  })

  it('does not click the loop end even when the player overshoots it before wrapping', () => {
    const s = new MetronomeScheduler()
    s.setGrid(BEATS, ACCENTS)
    s.update({ enabled: true, ctxTime: 0, mediaTime: 1.9, rate: 1, loopEnd: 2 })
    // a slow frame: the player is 10 ms past the loop end and has not jumped back yet
    expect(s.update({ enabled: true, ctxTime: 0.11, mediaTime: 2.01, rate: 1, loopEnd: 2 }).clicks).toEqual([])
    // far past the loop (the user sought beyond it): clicks resume normally
    const after = s.update({ enabled: true, ctxTime: 0.2, mediaTime: 4.95, rate: 1, loopEnd: 2 })
    expect(after.clicks.map((c) => c.beat)).toEqual([10])
  })

  it('re-syncs when the grid changes (tempo correction)', () => {
    const s = new MetronomeScheduler()
    s.setGrid(BEATS, ACCENTS)
    s.update({ enabled: true, ctxTime: 0, mediaTime: 0.95, rate: 1 })
    const doubled = BEATS.flatMap((b) => [b, b + 0.25])
    s.setGrid(doubled, doubled.map((_, i) => i % 8 === 0))
    const r = s.update({ enabled: true, ctxTime: 0.025, mediaTime: 0.975, rate: 1 })
    expect(r.cancel).toBe(true)
    expect(r.clicks.map((c) => doubled[c.beat])).toEqual([1])
  })

  it('does nothing without a grid', () => {
    const s = new MetronomeScheduler()
    expect(s.update({ enabled: true, ctxTime: 0, mediaTime: 0, rate: 1 })).toEqual({ cancel: false, clicks: [] })
    expect(Number.isNaN(s.mediaAt(1))).toBe(true)
  })
})

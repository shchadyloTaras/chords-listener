import { describe, expect, it } from 'vitest'
import { FrameLead, LiveClock } from './liveClock'

/** Simulates a player whose reported time updates only every `step` ms (like YouTube or a coarse <audio>). */
function coarsePlayer(opts: { start: number; rate?: number; step: number; t0: number; lag?: number }) {
  const rate = opts.rate ?? 1
  return (now: number) => {
    const reportAt = opts.t0 + Math.floor((now - opts.t0) / opts.step) * opts.step
    return opts.start + ((reportAt - opts.t0) / 1000) * rate - (opts.lag ?? 0)
  }
}

describe('LiveClock', () => {
  it('returns the exact player time while paused', () => {
    const c = new LiveClock()
    expect(c.update({ now: 1000, media: 12.345, playing: false, rate: 1 })).toBe(12.345)
    expect(c.update({ now: 1500, media: 12.345, playing: false, rate: 1 })).toBe(12.345)
    expect(c.update({ now: 1600, media: 3, playing: false, rate: 1 })).toBe(3) // seek while paused
  })

  it('extrapolates between coarse readings, smoothly and monotonically', () => {
    const c = new LiveClock()
    const t0 = 10_000
    const player = coarsePlayer({ start: 5, step: 250, t0 })
    c.update({ now: t0 - 16, media: 5, playing: false, rate: 1 })
    let prev = -Infinity
    let maxErr = 0
    for (let now = t0; now < t0 + 5000; now += 16.7) {
      const out = c.update({ now, media: player(now), playing: true, rate: 1 })
      expect(out).toBeGreaterThanOrEqual(prev)
      prev = out
      const truth = 5 + (now - t0) / 1000
      if (now > t0 + 600) maxErr = Math.max(maxErr, Math.abs(out - truth))
    }
    // the readings lag the truth by up to one step (250 ms) — the clock tracks the true time much closer
    expect(maxErr).toBeLessThan(0.15)
  })

  it('holds after play until the player time moves, then follows it', () => {
    const c = new LiveClock()
    c.update({ now: 0, media: 2, playing: false, rate: 1 })
    // audio output starts 80 ms after play(): the player still says 2.0
    expect(c.update({ now: 16, media: 2, playing: true, rate: 1 })).toBe(2)
    expect(c.update({ now: 50, media: 2, playing: true, rate: 1 })).toBe(2)
    expect(c.update({ now: 80, media: 2, playing: true, rate: 1 })).toBe(2)
    expect(c.update({ now: 96, media: 2.016, playing: true, rate: 1 })).toBeCloseTo(2.016, 6)
    expect(c.update({ now: 112.7, media: 2.016, playing: true, rate: 1 })).toBeCloseTo(2.0327, 3)
  })

  it('absorbs jitter without running backwards', () => {
    const c = new LiveClock()
    c.update({ now: 0, media: 0, playing: true, rate: 1 })
    c.update({ now: 16, media: 0.016, playing: true, rate: 1 })
    let prev = 0
    let seed = 1
    const noise = () => {
      seed = (seed * 16807) % 2147483647
      return (seed / 2147483647 - 0.5) * 0.04 // ±20 ms
    }
    for (let now = 33; now < 3000; now += 16.7) {
      const out = c.update({ now, media: now / 1000 + noise(), playing: true, rate: 1 })
      expect(out).toBeGreaterThanOrEqual(prev)
      expect(Math.abs(out - now / 1000)).toBeLessThan(0.03)
      prev = out
    }
  })

  it('re-anchors at once on seeks and loops, in both directions', () => {
    const c = new LiveClock()
    c.update({ now: 0, media: 10, playing: true, rate: 1 })
    c.update({ now: 16, media: 10.016, playing: true, rate: 1 })
    expect(c.update({ now: 33, media: 10.033, playing: true, rate: 1 })).toBeCloseTo(10.033, 2)
    // seek back 5 s
    expect(c.update({ now: 50, media: 5, playing: true, rate: 1 })).toBe(5)
    expect(c.jumped).toBe(true)
    expect(c.update({ now: 66, media: 5.016, playing: true, rate: 1 })).toBeCloseTo(5.016, 6)
    // a small seek forward (150 ms) is a jump too
    c.update({ now: 83, media: 5.033, playing: true, rate: 1 })
    expect(c.update({ now: 100, media: 5.2, playing: true, rate: 1 })).toBe(5.2)
    // loop back to the loop start
    c.update({ now: 116, media: 5.216, playing: true, rate: 1 })
    expect(c.update({ now: 133, media: 1.5, playing: true, rate: 1 })).toBe(1.5)
  })

  it('follows rate changes immediately and stays continuous', () => {
    const c = new LiveClock()
    c.update({ now: 0, media: 0, playing: true, rate: 1 })
    c.update({ now: 10, media: 0.01, playing: true, rate: 1 })
    const before = c.update({ now: 1000, media: 1.0, playing: true, rate: 1 })
    expect(before).toBeCloseTo(1.0, 2)
    // switch to half speed; the player keeps reporting its (coarse) old reading for a moment
    const at = c.update({ now: 1016, media: 1.0, playing: true, rate: 0.5 })
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at - before).toBeLessThan(0.02)
    const later = c.update({ now: 2016, media: 1.0, playing: true, rate: 0.5 })
    // 1 s of wall time at ×0.5 ≈ 0.5 s of media time (the stale reading does not pull it back)
    expect(later - at).toBeGreaterThan(0.45)
    expect(later - at).toBeLessThan(0.55)
  })

  it('pausing returns the exact paused position, even behind the estimate', () => {
    const c = new LiveClock()
    c.update({ now: 0, media: 0, playing: true, rate: 1 })
    c.update({ now: 16, media: 0.016, playing: true, rate: 1 })
    c.update({ now: 500, media: 0.5, playing: true, rate: 1 })
    expect(c.update({ now: 520, media: 0.49, playing: false, rate: 1 })).toBe(0.49)
  })

  it('converges to a player that consistently reports a little behind', () => {
    const c = new LiveClock()
    const t0 = 0
    const player = coarsePlayer({ start: 0, step: 40, t0, lag: 0.03 })
    let out = 0
    for (let now = t0; now < 4000; now += 16.7) out = c.update({ now, media: player(now), playing: true, rate: 1 })
    const reading = player(4000 - 16.7)
    expect(Math.abs(out - reading)).toBeLessThan(0.05)
  })
})

describe('FrameLead', () => {
  it('tracks the refresh interval and clamps it', () => {
    const lead = new FrameLead()
    let t = 0
    for (let i = 0; i < 200; i++) lead.tick((t += 8.33))
    expect(lead.ms).toBeGreaterThan(7.5)
    expect(lead.ms).toBeLessThan(9.5)
    lead.pause()
    lead.tick((t += 5000)) // idle gap is not a frame interval
    expect(lead.ms).toBeLessThan(9.5)
    const slow = new FrameLead()
    for (let i = 0; i < 200; i++) slow.tick(i * 45)
    expect(slow.ms).toBeLessThanOrEqual(34)
  })
})

import { describe, expect, it } from 'vitest'
import { createStabilizer, GATE_RMS, HOLD_MS } from './stabilizer'

const LOUD = 0.1
const est = (hz: number, clarity = 0.98) => ({ hz, clarity })
const A3 = 220
const A3_SHARP = 220 * 2 ** (10 / 1200)

describe('stabilizer', () => {
  it('shows a note only after it holds for 3 frames', () => {
    const s = createStabilizer()
    expect(s.push(est(A3), LOUD, 0, 440)).toBeNull()
    expect(s.push(est(A3), LOUD, 16, 440)).toBeNull()
    expect(s.push(est(A3), LOUD, 32, 440)).toEqual({ hz: A3, midi: 57, cents: 0 })
  })

  it('follows the note frame by frame once shown', () => {
    const s = createStabilizer()
    for (let i = 0; i < 3; i++) s.push(est(A3), LOUD, i * 16, 440)
    for (let i = 3; i < 8; i++) s.push(est(A3_SHARP), LOUD, i * 16, 440)
    expect(s.push(est(A3_SHARP), LOUD, 128, 440)).toMatchObject({ midi: 57, cents: 10 })
  })

  it('a single outlier does not move the reading (median of 5)', () => {
    const s = createStabilizer()
    for (let i = 0; i < 5; i++) s.push(est(A3), LOUD, i * 16, 440)
    expect(s.push(est(A3 * 2), LOUD, 80, 440)).toMatchObject({ midi: 57, cents: 0 })
  })

  it('switches to a new note only after it wins 3 frames in a row', () => {
    const s = createStabilizer()
    for (let i = 0; i < 5; i++) s.push(est(A3), LOUD, i * 16, 440)
    const E3 = 164.81
    const seen = [5, 6, 7, 8, 9, 10].map((i) => s.push(est(E3), LOUD, i * 16, 440)?.midi)
    // the median turns at the 3rd new frame, the note then needs 3 frames: 6 frames in all
    expect(seen).toEqual([57, 57, 57, 57, 52, 52])
  })

  it('treats quiet or unclear frames as silence', () => {
    const s = createStabilizer()
    for (let i = 0; i < 3; i++) expect(s.push(est(A3), GATE_RMS / 2, i * 16, 440)).toBeNull()
    for (let i = 0; i < 3; i++) expect(s.push(est(A3, 0.6), LOUD, i * 16, 440)).toBeNull()
    for (let i = 0; i < 3; i++) expect(s.push(null, LOUD, i * 16, 440)).toBeNull()
  })

  it('holds the last reading for HOLD_MS of silence, then lets go and starts afresh', () => {
    const s = createStabilizer()
    for (let i = 0; i < 3; i++) s.push(est(A3), LOUD, i * 16, 440)
    expect(s.push(null, 0, 32 + HOLD_MS, 440)).toMatchObject({ midi: 57 })
    expect(s.push(null, 0, 32 + HOLD_MS + 1, 440)).toBeNull()
    expect(s.push(est(A3), LOUD, 1000, 440)).toBeNull()
  })

  it('reads against the current A4', () => {
    const s = createStabilizer()
    for (let i = 0; i < 3; i++) s.push(est(440), LOUD, i * 16, 440)
    expect(s.push(est(440), LOUD, 48, 442)).toMatchObject({ midi: 69, cents: -7.9 })
  })

  it('reset forgets the shown note', () => {
    const s = createStabilizer()
    for (let i = 0; i < 3; i++) s.push(est(A3), LOUD, i * 16, 440)
    s.reset()
    expect(s.push(est(A3), LOUD, 64, 440)).toBeNull()
  })
})

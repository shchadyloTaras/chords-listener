import { describe, expect, it } from 'vitest'
import type { PulseGrid } from '../tempo'
import { accompanySteps, BEAT_SNAP, HARMONIUM_LIFT, PIANO_STEP_HOLD, type AccompChord, type AccompStep } from './accompany'
import type { NoteEvent } from './chordNotes'

/** 4/4 at 120 BPM: a beat every 0.5 s, 16 beats (4 bars). */
const grid = (meter = 4, beats = 16): PulseGrid => ({
  times: Array.from({ length: beats }, (_, i) => i * 0.5),
  pos: Array.from({ length: beats }, (_, i) => i % meter),
  meter,
})
// C for a bar, F for a bar, nothing for two beats, G to the end
const song: AccompChord[] = [
  { start: 0, end: 2, label: 'C' },
  { start: 2, end: 4, label: 'F' },
  { start: 4, end: 5, label: 'N' },
  { start: 5, end: 8, label: 'G' },
]
const ROOT: Record<string, number> = { C: 48, F: 53, G: 55 }

/** A fake diagram: n notes on strings / keys 0..n-1 from the chord's root up, rolled 10 ms apart. */
const shape =
  (n: number) =>
  (label: string): NoteEvent[] =>
    ROOT[label] == null ? [] : Array.from({ length: n }, (_, i) => ({ midi: ROOT[label] + [0, 7, 12, 16, 19, 24][i], offset: i * 0.01, velocity: 0.8, target: i }))

const at = (steps: AccompStep[], t: number) => steps.filter((s) => Math.abs(s.time - t) < 1e-9)
const times = (steps: AccompStep[]) => steps.map((s) => s.time)

describe('play-along: guitar / ukulele strum', () => {
  const steps = accompanySteps('guitar', song, grid(), shape(6))

  it('strums down on every beat and up between the beats, but not after the downbeat (D DU DU DU)', () => {
    expect(times(steps.filter((s) => s.time < 2))).toEqual([0, 0.5, 0.75, 1, 1.25, 1.5, 1.75])
    expect(at(steps, 0)[0].cut).toBe('all')
    expect(at(steps, 0.75)[0].cut).toBe('same')
  })

  it('accents the downbeat; an upstroke hits the top four strings high → low, softer and faster', () => {
    const [down1] = at(steps, 0)
    const [down2] = at(steps, 0.5)
    const [up] = at(steps, 0.75)
    expect(down1.notes[0].velocity).toBeGreaterThan(down2.notes[0].velocity)
    expect(up.notes.map((n) => n.target)).toEqual([5, 4, 3, 2])
    expect(up.notes[0].velocity).toBeLessThan(down2.notes[5].velocity)
    expect(up.notes[1].offset - up.notes[0].offset).toBeLessThan(0.0128) // the fastest downstroke gap (ukulele)
  })

  it('changes chord on the beat the chord starts on, and is silent where there is no chord', () => {
    expect(at(steps, 2)[0].label).toBe('F')
    expect(steps.filter((s) => s.time >= 4 && s.time < 5)).toEqual([])
    expect(at(steps, 5)[0].label).toBe('G')
  })

  it('counts a chord detected a little after the beat as starting on it', () => {
    const late = accompanySteps('guitar', [{ start: 0, end: 2.03, label: 'C' }, { start: 2.03, end: 4, label: 'F' }], grid(), shape(6))
    expect(BEAT_SNAP).toBeGreaterThan(0.03)
    expect(at(late, 2)[0].label).toBe('F')
  })
})

describe('play-along: bass', () => {
  const steps = accompanySteps('bass', song, grid(), shape(3))

  it('plays the root on the downbeat and at a change, the fifth on beat 3, nothing else', () => {
    expect(times(steps)).toEqual([0, 1, 2, 3, 5, 6, 7])
    expect(at(steps, 0)[0].notes.map((n) => n.midi)).toEqual([48]) // C
    expect(at(steps, 1)[0].notes.map((n) => n.midi)).toEqual([55]) // G, the fifth
    expect(at(steps, 5)[0].notes.map((n) => n.midi)).toEqual([55]) // G's root at the change (on beat 3)
    for (const s of steps) expect(s.notes).toHaveLength(1)
  })

  it('has no fifth on beat 3 in three-four', () => {
    const waltz = accompanySteps('bass', [{ start: 0, end: 6, label: 'C' }], grid(3, 12), shape(3))
    expect(times(waltz)).toEqual([0, 1.5, 3, 4.5])
    for (const s of waltz) expect(s.notes[0].midi).toBe(48)
  })
})

describe('play-along: piano', () => {
  const steps = accompanySteps('piano', song, grid(), shape(4))

  it('plays the whole chord with its bass on beats 1 and 3, the right hand alone on 2 and 4', () => {
    expect(at(steps, 0)[0].notes).toHaveLength(4)
    expect(at(steps, 0.5)[0].notes.map((n) => n.midi)).toEqual([55, 60, 64])
    expect(at(steps, 0.5)[0].notes[0].offset).toBe(0)
    expect(at(steps, 0.5)[0].cut).toBe('same') // the bass keeps ringing
    expect(at(steps, 1)[0].notes).toHaveLength(4)
    expect(at(steps, 2)[0].cut).toBe('all') // a new chord
    for (const s of steps) for (const n of s.notes) expect(n.hold).toBe(PIANO_STEP_HOLD)
  })
})

describe('play-along: harmonium', () => {
  const steps = accompanySteps('harmonium', song, grid(), shape(3))

  it('presses each chord once, when it comes, and holds it until it changes', () => {
    expect(times(steps)).toEqual([0, 2, 5])
    expect(at(steps, 0)[0].notes.every((n) => n.hold === 2 - HARMONIUM_LIFT && n.offset === 0)).toBe(true)
    expect(at(steps, 2)[0].notes[0].hold).toBeCloseTo(2 - HARMONIUM_LIFT, 9) // F ends where "no chord" starts
    expect(at(steps, 5)[0].notes[0].hold).toBeCloseTo(3 - HARMONIUM_LIFT, 9) // G to its end
  })

  it('keeps holding across the barline while the chord stays', () => {
    const held = accompanySteps('harmonium', [{ start: 0, end: 6, label: 'C' }, { start: 6, end: 8, label: 'G' }], grid(), shape(3))
    expect(times(held)).toEqual([0, 6])
    expect(held[0].notes[0].hold).toBeCloseTo(6 - HARMONIUM_LIFT, 9)
  })
})

describe('play-along: handpan', () => {
  const steps = accompanySteps('handpan', song, grid(), shape(3))

  it('strikes the bass on the downbeat and at a change, the other fields in turn on the beats and between', () => {
    const bar = steps.filter((s) => s.time < 2)
    expect(times(bar)).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75])
    expect(bar.map((s) => s.notes[0].midi)).toEqual([48, 55, 60, 55, 60, 55, 60, 55])
    for (const s of steps) {
      expect(s.notes).toHaveLength(1)
      expect(s.cut).toBe('same') // the fields ring on
    }
    expect(at(steps, 5)[0].notes[0].midi).toBe(55) // G's bass at the change
  })

  it('plays nothing for a chord the handpan has no notes of', () => {
    expect(accompanySteps('handpan', [{ start: 0, end: 2, label: 'Dbm' }], grid(), shape(3))).toEqual([])
  })
})

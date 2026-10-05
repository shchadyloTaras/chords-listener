import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RANGE,
  fitRange,
  foldNote,
  isBlack,
  layoutKeyboard,
  maxOctavesFor,
  noteName,
  pitchName,
  octaveCount,
  octaveRange,
  PIANO_HIGH,
  PIANO_LOW,
  whiteCount,
} from './keyboard'

function weights(entries: Array<[number, number]>): Float64Array {
  const w = new Float64Array(128)
  for (const [m, v] of entries) w[m] += v
  return w
}

describe('octave ranges', () => {
  it('pads to whole octaves C…B and clamps to the 88 keys', () => {
    expect(octaveRange(50, 70)).toEqual({ low: 48, high: 71 })
    expect(octaveRange(21, 108)).toEqual({ low: PIANO_LOW, high: PIANO_HIGH })
    expect(octaveRange(10, 30)).toEqual({ low: 21, high: 35 })
    expect(octaveCount({ low: 48, high: 71 })).toBe(2)
    expect(whiteCount({ low: 21, high: 108 })).toBe(52)
    expect(whiteCount({ low: 48, high: 59 })).toBe(7)
  })
})

describe('fitRange', () => {
  it('fits the song, at least 4 octaves, widening toward the music', () => {
    // a melody around middle C plus a little bass
    const w = weights([[60, 10], [64, 8], [67, 8], [72, 4], [48, 3], [43, 2]])
    const r = fitRange(w, { minOctaves: 4, maxOctaves: Infinity })
    expect(r.low % 12).toBe(0)
    expect(r.high % 12).toBe(11)
    expect(octaveCount(r)).toBe(4)
    expect(r.low).toBeLessThanOrEqual(43)
    expect(r.high).toBeGreaterThanOrEqual(72)
  })

  it('keeps wide songs whole up to 88 keys and ignores rare outliers', () => {
    const wide = weights([[24, 5], [36, 5], [60, 5], [84, 5], [100, 5]])
    expect(fitRange(wide, { minOctaves: 4, maxOctaves: Infinity })).toEqual({ low: 24, high: 107 })
    const all = weights([[21, 5], [108, 5], [60, 5]])
    expect(fitRange(all, { minOctaves: 4, maxOctaves: Infinity })).toEqual({ low: PIANO_LOW, high: PIANO_HIGH })
    // one stray very low note among thousands of mid notes does not stretch the keyboard
    const stray = weights([[60, 500], [64, 500], [67, 500], [55, 300], [72, 300], [22, 0.5]])
    const r = fitRange(stray, { minOctaves: 4, maxOctaves: Infinity })
    expect(r.low).toBeGreaterThan(30)
  })

  it('on narrow screens picks the ~3 octaves with the most notes', () => {
    const w = weights([[36, 1], [40, 1], [57, 9], [60, 12], [64, 10], [67, 8], [71, 6], [76, 5], [96, 1]])
    const r = fitRange(w, { minOctaves: 4, maxOctaves: 3 })
    expect(octaveCount(r)).toBe(3)
    expect(r.low).toBeLessThanOrEqual(57)
    expect(r.high).toBeGreaterThanOrEqual(76)
  })

  it('falls back to C2–B5 without notes', () => {
    expect(fitRange(new Float64Array(128), { minOctaves: 4, maxOctaves: Infinity })).toEqual(DEFAULT_RANGE)
    expect(octaveCount(fitRange(new Float64Array(128), { minOctaves: 4, maxOctaves: 3 }))).toBe(3)
  })
})

describe('foldNote', () => {
  const r = { low: 48, high: 83 } // C3–B5
  it('keeps notes inside', () => {
    expect(foldNote(60, r)).toEqual({ key: 60, fold: 0 })
    expect(foldNote(48, r)).toEqual({ key: 48, fold: 0 })
    expect(foldNote(83, r)).toEqual({ key: 83, fold: 0 })
  })
  it('folds by octaves onto the nearest edge octave, keeping the pitch class', () => {
    expect(foldNote(36, r)).toEqual({ key: 48, fold: -1 }) // C2 → C3
    expect(foldNote(25, r)).toEqual({ key: 49, fold: -1 }) // C#1 → C#3
    expect(foldNote(47, r)).toEqual({ key: 59, fold: -1 }) // B2 → B3
    expect(foldNote(84, r)).toEqual({ key: 72, fold: 1 }) // C6 → C5
    expect(foldNote(108, r)).toEqual({ key: 72, fold: 1 }) // C8 → C5
    expect(foldNote(95, r)).toEqual({ key: 83, fold: 1 }) // B6 → B5
  })
})

describe('layoutKeyboard', () => {
  it('uses real proportions: equal white keys, off-centre black keys', () => {
    const k = layoutKeyboard({ low: 48, high: 59 }, 700)
    expect(k.whites).toHaveLength(7)
    expect(k.blacks).toHaveLength(5)
    expect(k.whiteW).toBe(100)
    expect(k.keys[48]).toMatchObject({ x: 0, w: 100, black: false })
    expect(k.keys[59]).toMatchObject({ x: 600, w: 100 })
    const cs = k.keys[49]!
    const ds = k.keys[51]!
    expect(cs.black && ds.black).toBe(true)
    expect(cs.w).toBeCloseTo(58, 5)
    // octave split in 12 equal parts at the back: C# centred at 1.5/12 of the octave, D# at 3.5/12
    expect(cs.x + cs.w / 2).toBeCloseTo((1.5 * 700) / 12, 5)
    expect(ds.x + ds.w / 2).toBeCloseTo((3.5 * 700) / 12, 5)
    // C# leans left of the C/D boundary, D# right of the D/E boundary
    expect(cs.x + cs.w / 2).toBeLessThan(100)
    expect(ds.x + ds.w / 2).toBeGreaterThan(200)
    expect(cs.h).toBeCloseTo(k.whiteH * 0.63, 5)
    for (const b of k.blacks) expect(isBlack(b.midi)).toBe(true)
  })

  it('handles the A0 start of a full keyboard and gives each key a lane', () => {
    const k = layoutKeyboard({ low: 21, high: 108 }, 1040)
    expect(k.whites).toHaveLength(52)
    expect(k.keys[21]).toMatchObject({ x: 0, w: 20 })
    const as0 = k.keys[22]!
    expect(as0.black).toBe(true)
    expect(as0.x).toBeGreaterThan(0)
    expect(as0.x + as0.w).toBeLessThan(40)
    expect(k.keys[108]!.x + k.keys[108]!.w).toBeCloseTo(1040, 6)
    const [lx, lw] = k.lane(60)
    const c4 = k.keys[60]!
    expect(lx).toBeGreaterThan(c4.x)
    expect(lx + lw).toBeLessThan(c4.x + c4.w)
    expect(k.lane(20)).toEqual([0, 0])
  })

  it('keeps key length within limits', () => {
    expect(layoutKeyboard({ low: 21, high: 108 }, 380).whiteH).toBe(56)
    expect(layoutKeyboard({ low: 48, high: 59 }, 1200).whiteH).toBe(132)
  })
})

describe('helpers', () => {
  it('limits octaves on narrow screens', () => {
    expect(maxOctavesFor(380)).toBe(3)
    expect(maxOctavesFor(639)).toBe(3)
    expect(maxOctavesFor(700)).toBe(9)
    expect(maxOctavesFor(1100)).toBe(14)
  })
  it('names notes', () => {
    expect(noteName(60)).toBe('C4')
    expect(noteName(61)).toBe('C♯4')
    expect(noteName(61, 'flat')).toBe('D♭4')
    expect(noteName(21)).toBe('A0')
    expect(noteName(108)).toBe('C8')
  })
  it('names a key without its octave (the label on a lit key)', () => {
    expect(pitchName(60)).toBe('C')
    expect(pitchName(63)).toBe('D♯')
    expect(pitchName(63, 'flat')).toBe('E♭')
    expect(pitchName(-1, 'flat')).toBe('B')
  })
})

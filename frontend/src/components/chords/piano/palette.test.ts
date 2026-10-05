import { describe, expect, it } from 'vitest'
import { chordRgb, fifthsIndex, inkOn, mix, oklchToRgb, parseCssColor, pitchColor, rgba, type Palette } from './palette'

describe('parseCssColor', () => {
  it('reads hex and rgb()', () => {
    expect(parseCssColor('#0c0c0e')).toEqual([12, 12, 14])
    expect(parseCssColor('#fff')).toEqual([255, 255, 255])
    expect(parseCssColor(' rgb(255 181 71 / 0.14) ')).toEqual([255, 181, 71])
    expect(parseCssColor('rgba(10, 20, 30, 0.5)')).toEqual([10, 20, 30])
  })

  it('converts oklch() like the browser does', () => {
    // reference values (CSS Color 4 conversion, rounded): white, black, and the app's chord tokens
    expect(parseCssColor('oklch(1 0 0)')).toEqual([255, 255, 255])
    expect(parseCssColor('oklch(0 0 0)')).toEqual([0, 0, 0])
    expect(parseCssColor('oklch(62.8% 0.2577 29.23)')).toEqual(parseCssColor('oklch(0.628 0.2577 29.23)'))
    const red = parseCssColor('oklch(0.628 0.2577 29.23)')! // ≈ #ff0000
    expect(red[0]).toBeGreaterThan(250)
    expect(red[1]).toBeLessThan(8)
    expect(red[2]).toBeLessThan(8)
    const c0 = oklchToRgb(0.74, 0.15, 30) // --chord-0 (dark): a warm coral
    expect(c0[0]).toBeGreaterThan(c0[1])
    expect(c0[1]).toBeGreaterThan(c0[2] - 30)
    const c7 = parseCssColor('oklch(0.72 0.14 245)')! // --chord-7: blue
    expect(c7[2]).toBeGreaterThan(c7[0])
  })

  it('returns null for what it does not know', () => {
    expect(parseCssColor('color-mix(in oklch, red 50%, blue)')).toBeNull()
    expect(parseCssColor('tomato')).toBeNull()
    expect(parseCssColor('')).toBeNull()
  })
})

describe('colour helpers', () => {
  const palette = {
    chord: Array.from({ length: 12 }, (_, i) => [i * 10, 0, 0] as const),
    muted: [100, 100, 100],
    faint: [50, 50, 50],
  } as unknown as Palette

  it('maps pitch classes around the circle of fifths like the chord colours', () => {
    expect([0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5].map(fifthsIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(pitchColor(palette, 7)).toEqual([10, 0, 0]) // G → --chord-1
    expect(chordRgb(palette, 9, false)).toEqual([30, 0, 0]) // A → --chord-3
    expect(chordRgb(palette, 9, true)).toEqual(mix([30, 0, 0], [100, 100, 100], 0.22))
    expect(chordRgb(palette, null, false)).toEqual([50, 50, 50])
  })

  it('mixes and formats', () => {
    expect(mix([0, 0, 0], [200, 100, 50], 0.5)).toEqual([100, 50, 25])
    expect(rgba([1, 2, 3])).toBe('rgb(1,2,3)')
    expect(rgba([1, 2, 3], 0.25)).toBe('rgba(1,2,3,0.250)')
  })
})

describe('inkOn', () => {
  it('writes dark on light fills and white on dark ones', () => {
    expect(inkOn([255, 255, 255])).toMatch(/^rgba\(0,0,0/)
    expect(inkOn([240, 200, 120])).toMatch(/^rgba\(0,0,0/)
    expect(inkOn([0, 0, 0])).toMatch(/^rgba\(255,255,255/)
    expect(inkOn([90, 40, 140])).toMatch(/^rgba\(255,255,255/)
  })
})

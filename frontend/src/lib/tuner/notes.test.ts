import { describe, expect, it } from 'vitest'
import { A4_DEFAULT, clampA4, formatCents, formatHz, hzToNote, isInTune, noteHz, noteName, tunerSpelling } from './notes'

describe('hzToNote', () => {
  it('A4 = 440: exact notes have 0 cents', () => {
    expect(hzToNote(440, 440)).toEqual({ midi: 69, cents: 0 })
    expect(hzToNote(82.40689, 440)).toEqual({ midi: 40, cents: 0 })
    expect(hzToNote(261.6256, 440)).toEqual({ midi: 60, cents: 0 })
  })
  it('a moved A4 moves every note', () => {
    expect(hzToNote(442, 442)).toEqual({ midi: 69, cents: 0 })
    expect(hzToNote(440, 442)).toEqual({ midi: 69, cents: -7.9 })
  })
  it('reports the deviation in tenths of a cent', () => {
    expect(hzToNote(110 * 2 ** (12 / 1200), 440)).toEqual({ midi: 45, cents: 12 })
    expect(hzToNote(440 * 2 ** (-3.04 / 1200), 440)).toEqual({ midi: 69, cents: -3 })
  })
  it('just under half way stays, just over goes to the next note', () => {
    expect(hzToNote(440 * 2 ** (49.9 / 1200), 440)).toEqual({ midi: 69, cents: 49.9 })
    expect(hzToNote(440 * 2 ** (50.1 / 1200), 440)).toEqual({ midi: 70, cents: -49.9 })
    expect(hzToNote(440 * 2 ** (-50.1 / 1200), 440)).toEqual({ midi: 68, cents: 49.9 })
  })
})

describe('noteHz', () => {
  it('inverts hzToNote', () => {
    expect(noteHz(69, 440)).toBe(440)
    expect(noteHz(57, 440)).toBeCloseTo(220, 9)
    expect(noteHz(69, 432)).toBe(432)
    expect(noteHz(40, 440)).toBeCloseTo(82.40689, 4)
  })
})

describe('noteName', () => {
  it('spells by the setting and numbers octaves from C', () => {
    expect(noteName(70, 'sharp')).toEqual({ name: 'A#', octave: 4 })
    expect(noteName(70, 'flat')).toEqual({ name: 'Bb', octave: 4 })
    expect(noteName(59, 'sharp')).toEqual({ name: 'B', octave: 3 })
    expect(noteName(60, 'sharp')).toEqual({ name: 'C', octave: 4 })
    expect(noteName(28, 'sharp')).toEqual({ name: 'E', octave: 1 })
  })
  it('flats only when the user chose flats', () => {
    expect(tunerSpelling('flat')).toBe('flat')
    expect(tunerSpelling('sharp')).toBe('sharp')
    expect(tunerSpelling('auto')).toBe('sharp')
  })
})

describe('clampA4', () => {
  it('keeps A4 within 400..480 whole hertz', () => {
    expect(clampA4(442)).toBe(442)
    expect(clampA4(441.6)).toBe(442)
    expect(clampA4(300)).toBe(400)
    expect(clampA4(999)).toBe(480)
    expect(clampA4(Number.NaN)).toBe(A4_DEFAULT)
  })
})

describe('display', () => {
  it('«in tune» within ±5 cents', () => {
    expect(isInTune(5)).toBe(true)
    expect(isInTune(-5)).toBe(true)
    expect(isInTune(5.5)).toBe(false)
  })
  it('green exactly when the shown whole cents are within ±5', () => {
    for (const c of [4.6, 5.1, 5.4, -5.4, -5.5, 5.5, 6, -5.6]) {
      expect(isInTune(c), `${c} → ${formatCents(c)}`).toBe(Math.abs(Number(formatCents(c).replace('−', '-'))) <= 5)
    }
    expect(isInTune(5.4)).toBe(true)
    expect(isInTune(-5.6)).toBe(false)
  })
  it('hertz with one decimal in the language\'s style, no grouping', () => {
    expect(formatHz(82.40689, 'uk')).toBe('82,4')
    expect(formatHz(82.40689, 'en')).toBe('82.4')
    expect(formatHz(1318.51, 'uk')).toBe('1318,5')
  })
  it('signed whole cents with a true minus', () => {
    expect(formatCents(7.4)).toBe('+7')
    expect(formatCents(-12.2)).toBe('−12')
    expect(formatCents(0.3)).toBe('0')
    expect(formatCents(-0.4)).toBe('0')
  })
})

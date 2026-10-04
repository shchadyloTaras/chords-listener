import { describe, expect, it } from 'vitest'
import type { KeyInfo } from '../../types'
import { buildDisplayChords, chordIndexAt, uniqueChords } from './display'
import { keyPrefersFlats, resolveSpelling, transposeKeyName } from './key'
import { chordColor, chordTone, fifthsIndex } from './color'
import { shapeDifficulty, suggestCapo } from './capo'

const key = (name: string, tonic: string, mode: 'major' | 'minor'): KeyInfo => ({ name, tonic, mode, confidence: 0.9 })

describe('spelling by key', () => {
  it('knows flat keys', () => {
    for (const pc of [5, 10, 3, 8, 1, 6]) expect(keyPrefersFlats(pc, 'major')).toBe(true)
    for (const pc of [0, 7, 2, 9, 4, 11]) expect(keyPrefersFlats(pc, 'major')).toBe(false)
    for (const pc of [2, 7, 0, 5, 10, 3]) expect(keyPrefersFlats(pc, 'minor')).toBe(true)
    for (const pc of [9, 4, 11, 6, 1, 8]) expect(keyPrefersFlats(pc, 'minor')).toBe(false)
  })

  it('resolves auto spelling from the transposed key', () => {
    const am = key('Am', 'A', 'minor')
    expect(resolveSpelling('auto', am, 0)).toBe('sharp')
    expect(resolveSpelling('auto', am, -2)).toBe('flat') // Gm
    expect(resolveSpelling('auto', am, 1)).toBe('flat') // A#m → Bbm
    expect(resolveSpelling('auto', key('C', 'C', 'major'), 5)).toBe('flat') // F
    expect(resolveSpelling('auto', null, 3)).toBe('sharp')
    expect(resolveSpelling('flat', am, 0)).toBe('flat')
    expect(resolveSpelling('sharp', key('F', 'F', 'major'), 0)).toBe('sharp')
  })

  it('transposes key names', () => {
    const am = key('Am', 'A', 'minor')
    expect(transposeKeyName(am, 2, 'sharp')).toBe('Bm')
    expect(transposeKeyName(am, 1, 'flat')).toBe('Bbm')
    expect(transposeKeyName(key('F#', 'F#', 'major'), 0, 'flat')).toBe('Gb')
    expect(transposeKeyName(null, 2, 'sharp')).toBeNull()
  })
})

describe('colors', () => {
  it('maps roots around the circle of fifths', () => {
    const order = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#', 'F']
    order.forEach((n, i) => expect(chordColor(n)).toBe(`var(--chord-${i})`))
    expect(fifthsIndex(10)).toBe(10)
    expect(chordColor('Bb')).toBe('var(--chord-10)')
    expect(chordColor(null)).toBe('var(--chord-none)')
    expect(chordTone('A', 'min')).toContain('color-mix')
    expect(chordTone('A', 'maj')).toBe('var(--chord-3)')
  })
})

describe('display chords', () => {
  const seg = (start: number, end: number, label: string, confidence = 0.9) => ({
    start, end, label, root: null, quality: null, bass: null, confidence,
  })
  it('transposes, simplifies and merges equal neighbours', () => {
    const src = [seg(0, 1, 'N'), seg(1, 3, 'G'), seg(3, 4, 'Gsus4'), seg(4, 6, 'Am7')]
    const out = buildDisplayChords(src, { transpose: 0, simplify: true, spelling: 'sharp' })
    expect(out.map((c) => c.label)).toEqual(['N', 'G', 'Am'])
    expect(out[1]).toMatchObject({ start: 1, end: 4, srcStart: 1, srcEnd: 2 })
    const t = buildDisplayChords(src, { transpose: 3, simplify: false, spelling: 'flat' })
    expect(t.map((c) => c.label)).toEqual(['N', 'Bb', 'Bbsus4', 'Cm7'])
  })
  it('finds the chord at a time and lists unique chords', () => {
    const src = [seg(0, 2, 'Am'), seg(2, 4, 'F'), seg(4, 6, 'Am'), seg(6, 7, 'N')]
    const out = buildDisplayChords(src, { transpose: 0, simplify: false, spelling: 'sharp' })
    expect(chordIndexAt(out, 0)).toBe(0)
    expect(chordIndexAt(out, 2)).toBe(1)
    expect(chordIndexAt(out, 5.99)).toBe(2)
    expect(chordIndexAt(out, 7)).toBe(-1)
    expect(chordIndexAt(out, -1)).toBe(-1)
    expect(uniqueChords(out).map((u) => [u.label, u.count])).toEqual([['Am', 2], ['F', 1]])
  })
})

describe('capo suggestion', () => {
  it('rates shapes', () => {
    expect(shapeDifficulty('G')).toBe(0)
    expect(shapeDifficulty('F')).toBe(2)
    expect(shapeDifficulty('Bbm')).toBe(3)
    expect(shapeDifficulty('G/B')).toBeLessThan(1)
  })

  it('finds capo 3 for a G-minor-ish progression played as Em C G D', () => {
    const chords = ['Gm', 'Eb', 'Bb', 'F'].map((label) => ({ label, weight: 1 }))
    const s = suggestCapo(chords)
    expect(s?.capo).toBe(3)
    expect(s?.shapes).toEqual(['Em', 'C', 'G', 'D'])
  })

  it('suggests nothing when open shapes already work', () => {
    expect(suggestCapo(['Am', 'F', 'C', 'G'].map((label) => ({ label, weight: 1 })))).toBeNull()
    expect(suggestCapo([])).toBeNull()
  })

  it('handles sharps keys: capo 2 for B E F# C#m → A D E Bm? prefers easiest', () => {
    const chords = ['B', 'E', 'F#', 'G#m'].map((label) => ({ label, weight: 1 }))
    const s = suggestCapo(chords)
    expect(s).not.toBeNull()
    // capo 4 → G C D Em (all open shapes)
    expect(s?.capo).toBe(4)
    expect(s?.shapes).toEqual(['G', 'C', 'D', 'Em'])
  })

  it('works for ukulele', () => {
    const s = suggestCapo(['D', 'Bm', 'G', 'A'].map((label) => ({ label, weight: 1 })), 'ukulele')
    expect(s?.capo).toBe(2)
    expect(s?.shapes).toEqual(['C', 'Am', 'F', 'G'])
  })
})

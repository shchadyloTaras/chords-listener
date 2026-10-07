import { describe, expect, it } from 'vitest'
import { formatHandpanNote, noteMidi, parseHandpanNote, sameNote } from './notes'
import {
  CUSTOM_SCALE_ID,
  DEFAULT_HANDPAN_NOTES,
  HANDPAN_PRESETS,
  MAX_TONES,
  MIN_TONES,
  customScale,
  describeScale,
  parseNotesText,
  presetScale,
  resolveScale,
  scaleToStrings,
  validateNotes,
  zigzagLayout,
} from './scales'
import { bestTransposeForHandpan, chordTones, playability, songCoverage } from './playability'
import { handpanFieldSizes, handpanMidis } from './pitches'

const mine = customScale(DEFAULT_HANDPAN_NOTES)
const kurd = presetScale('d-kurd')!

describe('handpan notes', () => {
  it('parses names with optional octave', () => {
    expect(parseHandpanNote('A')).toEqual({ pc: 9, octave: null, name: 'A' })
    expect(parseHandpanNote('bb3')).toEqual({ pc: 10, octave: 3, name: 'Bb' })
    expect(parseHandpanNote('C♯4')).toEqual({ pc: 1, octave: 4, name: 'C#' })
    expect(parseHandpanNote(' e ')).toEqual({ pc: 4, octave: null, name: 'E' })
    expect(parseHandpanNote('H')).toBeNull()
    expect(parseHandpanNote('A10')).toBeNull()
    expect(parseHandpanNote('Am')).toBeNull()
    expect(parseHandpanNote('')).toBeNull()
  })

  it('treats enharmonics as the same note', () => {
    const bb = parseHandpanNote('Bb3')!
    const as = parseHandpanNote('A#3')!
    expect(sameNote(bb, as)).toBe(true)
    expect(sameNote(bb, parseHandpanNote('A#')!)).toBe(true)
    expect(sameNote(bb, parseHandpanNote('A#4')!)).toBe(false)
    expect(noteMidi(parseHandpanNote('C4')!)).toBe(60)
    expect(noteMidi(parseHandpanNote('Cb4')!)).toBe(59)
    expect(noteMidi(parseHandpanNote('A')!)).toBeNull()
    expect(formatHandpanNote(bb)).toBe('Bb3')
  })
})

describe('handpan scales', () => {
  it('builds the user handpan in the listed order', () => {
    expect(mine.id).toBe(CUSTOM_SCALE_ID)
    expect(mine.ding.name).toBe('A')
    expect(mine.tones.map((n) => n.name)).toEqual(['D', 'F', 'A', 'C', 'G', 'E', 'C', 'A'])
    expect(mine.notes).toHaveLength(9)
    expect(mine.octavesKnown).toBe(false)
    expect(scaleToStrings(mine)).toEqual([...DEFAULT_HANDPAN_NOTES])
    expect(describeScale(mine)).toBe('A | D F A C G E C A')
  })

  it('lays presets out in a zigzag and lists them ascending', () => {
    expect(zigzagLayout([1, 2, 3, 4, 5, 6, 7, 8])).toEqual([1, 2, 4, 6, 8, 7, 5, 3])
    expect(zigzagLayout([1, 2, 3])).toEqual([1, 2, 3])
    expect(kurd.tones.map(formatHandpanNote)).toEqual(['A3', 'Bb3', 'D4', 'F4', 'A4', 'G4', 'E4', 'C4'])
    expect(describeScale(kurd, true)).toBe('D3 | A3 Bb3 C4 D4 E4 F4 G4 A4')
    expect(kurd.octavesKnown).toBe(true)
  })

  it('has valid presets with unique ids', () => {
    const ids = new Set(HANDPAN_PRESETS.map((p) => p.id))
    expect(ids.size).toBe(HANDPAN_PRESETS.length)
    expect(ids.has(CUSTOM_SCALE_ID)).toBe(false)
    for (const p of HANDPAN_PRESETS) {
      const s = presetScale(p.id)
      expect(s, p.id).not.toBeNull()
      expect(s!.tones.length).toBeGreaterThanOrEqual(MIN_TONES)
      // makers list tone fields in ascending pitch
      const midi = p.tones.map((n) => noteMidi(parseHandpanNote(n)!)!)
      expect([...midi].sort((a, b) => a - b), p.id).toEqual(midi)
    }
  })

  it('validates note lists', () => {
    expect(parseNotesText('A, D, F, A, C, G, E, C, A').ok).toBe(true)
    expect(parseNotesText('D3 | A3 Bb3 C4 D4 E4 F4 G4 A4').ok).toBe(true)
    expect(parseNotesText('D3 / A3 Bb3 C4 D4 E4 F4 G4')).toMatchObject({ ok: true })
    expect(parseNotesText('')).toEqual({ ok: false, error: 'empty' })
    expect(parseNotesText('A D F')).toEqual({ ok: false, error: 'tooFew' })
    expect(parseNotesText('A D F A H G E C A')).toEqual({ ok: false, error: 'badNote', token: 'H' })
    expect(validateNotes(Array.from({ length: MAX_TONES + 2 }, () => 'C'))).toEqual({ ok: false, error: 'tooMany' })
    expect(validateNotes(Array.from({ length: MAX_TONES + 1 }, () => 'C')).ok).toBe(true)
  })

  it('resolves persisted settings safely', () => {
    expect(resolveScale('d-kurd', DEFAULT_HANDPAN_NOTES)).toBe(kurd)
    expect(resolveScale('custom', ['D', 'A', 'Bb', 'C', 'D', 'E', 'F', 'G', 'A']).ding.name).toBe('D')
    expect(resolveScale('no-such-scale', DEFAULT_HANDPAN_NOTES).key).toBe(mine.key)
    // corrupted storage → the default handpan
    expect(customScale(['X', 'Y']).key).toBe(mine.key)
    expect(customScale(null).key).toBe(mine.key)
  })
})

describe('chord tones', () => {
  it('labels chord functions', () => {
    expect(chordTones('Am7')?.tones.map((x) => [x.pc, x.role])).toEqual([
      [9, 'root'],
      [0, 'third'],
      [4, 'fifth'],
      [7, 'seventh'],
    ])
    expect(chordTones('Gsus4')?.tones.map((x) => x.role)).toEqual(['root', 'sus', 'fifth'])
    expect(chordTones('C6')?.tones.map((x) => x.role)).toEqual(['root', 'third', 'fifth', 'sixth'])
    expect(chordTones('Bdim7')?.tones.map((x) => x.role)).toEqual(['root', 'third', 'fifth', 'seventh'])
    expect(chordTones('Cadd9')?.tones.at(-1)).toMatchObject({ pc: 2, role: 'ninth' })
    expect(chordTones('C/F')?.bassPc).toBe(5)
    expect(chordTones('G/B')?.bassPc).toBeNull()
    expect(chordTones('N')).toBeNull()
  })
})

describe('playability', () => {
  it('finds every field of each chord tone', () => {
    const am = playability('Am', mine)!
    expect(am.full).toBe(true)
    expect(am.coverage).toBe(1)
    expect(am.tones.map((x) => x.fields)).toEqual([
      [0, 3, 8],
      [4, 7],
      [6],
    ])
    expect(am.roles).toEqual(['root', null, null, 'root', 'third', null, 'fifth', 'third', 'root'])
  })

  it('reports missing notes and power chords', () => {
    const g = playability('G', mine)!
    expect(g.full).toBe(false)
    expect(g.missing.map((x) => x.pc)).toEqual([11])
    expect(g.playable).toBe(2)
    expect(g.coverage).toBeCloseTo(2 / 3)
    expect(g.powerChord).toBe(true)
    const e = playability('E', mine)!
    expect(e.missing.map((x) => x.pc)).toEqual([8, 11])
    expect(e.powerChord).toBe(false)
  })

  it('matches enharmonic spellings', () => {
    expect(playability('A#', kurd)!.full).toBe(true)
    expect(playability('Bb', kurd)!.full).toBe(true)
    expect(playability('Gm', kurd)!.full).toBe(true)
  })

  it('lights a slash bass outside the chord', () => {
    const p = playability('C/F', mine)!
    expect(p.bass).toEqual({ pc: 5, fields: [2] })
    expect(p.roles[2]).toBe('bass')
    expect(p.full).toBe(true)
  })

  it('memoizes per scale and label', () => {
    expect(playability('Dm', mine)).toBe(playability('Dm', mine))
    expect(playability('Dm', kurd)).not.toBe(playability('Dm', mine))
    expect(playability('N', mine)).toBeNull()
  })
})

describe('song coverage', () => {
  it('weights chords by duration', () => {
    const cov = songCoverage(
      [
        { label: 'C', weight: 3 },
        { label: 'E', weight: 1 },
        { label: 'N', weight: 10 },
      ],
      mine,
    )
    expect(cov).toBeCloseTo((3 + 1 / 3) / 4)
    expect(songCoverage([{ label: 'N', weight: 5 }], mine)).toBeNull()
    expect(songCoverage([{ label: 'Bm', weight: 1 }], mine, -2)).toBe(1)
  })

  it('picks the transposition that fits the instrument best', () => {
    const song = [
      { label: 'C#', weight: 4 },
      { label: 'F#', weight: 4 },
      { label: 'A#m', weight: 2 },
    ]
    const best = bestTransposeForHandpan(song, mine)!
    // a semitone down: C F Am — all on the handpan
    expect(best).toEqual({ shift: -1, coverage: 1, current: expect.any(Number) })
    expect(best.current).toBeLessThan(0.5)
  })

  it('stays put when nothing is better and prefers the smallest shift', () => {
    expect(bestTransposeForHandpan([{ label: 'Am', weight: 1 }], mine)).toEqual({ shift: 0, coverage: 1, current: 1 })
    expect(bestTransposeForHandpan([{ label: 'F#m', weight: 1 }], kurd)?.shift).toBe(1)
    const both = customScale(['D', 'F#', 'A', 'E', 'G#', 'B', 'D', 'E', 'A'])
    expect(bestTransposeForHandpan([{ label: 'Eb', weight: 1 }], both)?.shift).toBe(-1)
    expect(bestTransposeForHandpan([], mine)).toBeNull()
  })
})

describe('field sizes', () => {
  it('make the lowest field the largest and shrink the fields up the scale, ding left out', () => {
    for (const scale of [customScale(DEFAULT_HANDPAN_NOTES), presetScale('d-kurd')!, presetScale('f-low-pygmy')!]) {
      const sizes = handpanFieldSizes(scale)
      const midis = handpanMidis(scale).slice(1)
      expect(sizes).toHaveLength(scale.tones.length)
      expect(Math.max(...sizes)).toBe(1)
      expect(sizes[midis.indexOf(Math.min(...midis))]).toBe(1)
      // strictly in pitch order: higher → smaller
      const byPitch = midis.map((m, i) => [m, sizes[i]]).sort((a, b) => a[0] - b[0])
      for (let k = 1; k < byPitch.length; k++) {
        if (byPitch[k][0] > byPitch[k - 1][0]) expect(byPitch[k][1]).toBeLessThan(byPitch[k - 1][1])
        else expect(byPitch[k][1]).toBe(byPitch[k - 1][1])
      }
      for (const s of sizes) expect(s).toBeGreaterThanOrEqual(0.55)
    }
    // an octave up ≈ 0.71×, works without written octaves too (A | D F A C G E C A: A3 … C5)
    const mine = handpanFieldSizes(customScale(DEFAULT_HANDPAN_NOTES))
    expect(Math.min(...mine)).toBeCloseTo(Math.pow(2, -15 / 24), 6)
  })
})

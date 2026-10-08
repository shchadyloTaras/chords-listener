import { describe, expect, it } from 'vitest'
import { accompanySteps, WIND_BREATH } from '../sound/accompany'
import { WIND_LAST_HOLD, WIND_STEP, windChordNotes, windNote } from '../sound/chordNotes'
import { arpeggioClasses, FLUTE, parseCover, SOPILKA, windArpeggio, windChord, windRange, WIND_SPECS, type WindSpec } from '.'

const names = (spec: WindSpec, label: string) => windArpeggio(spec, label).map((n) => `${n.name}${n.octave}`)

describe('wind arpeggio', () => {
  it('rises root, third, fifth and closes a triad on the root an octave up', () => {
    expect(arpeggioClasses('C')!.pcs).toEqual([0, 4, 7, 0])
    expect(arpeggioClasses('Am')!.pcs).toEqual([9, 0, 4, 9])
    expect(arpeggioClasses('G7')!.pcs).toEqual([7, 11, 2, 5])
    // five notes: the fifth is left out
    expect(arpeggioClasses('C9')!.pcs).toEqual([0, 4, 10, 2])
  })

  it('starts a slash chord on its bass: an inversion, or a bass note under the root', () => {
    expect(arpeggioClasses('C/E')).toEqual({ pcs: [4, 7, 0, 4], bassFirst: true })
    expect(arpeggioClasses('Am/G')).toEqual({ pcs: [7, 9, 0, 4], bassFirst: true })
    expect(arpeggioClasses('N')).toBeNull()
  })

  it('spells the notes like the chord and gives every note its fingering', () => {
    expect(names(FLUTE, 'C')).toEqual(['C5', 'E5', 'G5', 'C6'])
    expect(names(FLUTE, 'Gm')).toEqual(['G4', 'Bb4', 'D5', 'G5'])
    expect(names(FLUTE, 'D')).toEqual(['D4', 'F#4', 'A4', 'D5'])
    const notes = windArpeggio(FLUTE, 'Gm')
    expect(notes.map((n) => n.role)).toEqual(['root', 'tone', 'tone', 'root'])
    for (const n of notes) expect(n.cover).toHaveLength(FLUTE.keys.length)
    expect(windArpeggio(FLUTE, 'C/E')[0].role).toBe('bass')
    expect(windArpeggio(FLUTE, 'N')).toEqual([])
  })

  it('keeps every arpeggio of every chord on both instruments inside the range', () => {
    const roots = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
    const suffixes = ['', 'm', '7', 'maj7', 'm7', 'dim', 'aug', 'sus2', 'sus4', 'dim7', 'm7b5', '6', 'm6', '9', 'add9']
    for (const spec of [FLUTE, SOPILKA]) {
      const { low, high } = windRange(spec)
      for (const r of roots)
        for (const s of suffixes) {
          const notes = windArpeggio(spec, r + s)
          expect(notes.length, `${spec.instrument} ${r}${s}`).toBeGreaterThanOrEqual(3)
          for (const n of notes) {
            expect(n.midi).toBeGreaterThanOrEqual(low)
            expect(n.midi).toBeLessThanOrEqual(high)
          }
          // rising
          for (let i = 1; i < notes.length; i++) expect(notes[i].midi).toBeGreaterThan(notes[i - 1].midi)
        }
    }
  })

  it('has a well-formed fingering for every note of the range', () => {
    for (const spec of Object.values(WIND_SPECS)) {
      const { low, high } = windRange(spec)
      for (let m = low; m <= high; m++) {
        const f = spec.fingerings[m]
        expect(f, `${spec.instrument} ${m}`).toBeDefined()
        expect(f.replace(/\s+/g, '')).toMatch(new RegExp(`^[xoh]{${spec.keys.length}}$`))
      }
    }
    expect(parseCover('x h o')).toEqual([1, 0.5, 0])
  })
})

describe('the flute chart', () => {
  const cover = (midi: number) => parseCover(FLUTE.fingerings[midi]).map((c, i) => (c ? FLUTE.keys[i].id : null)).filter(Boolean)
  it('uses the standard fingerings', () => {
    expect(windRange(FLUTE)).toEqual({ low: 60, high: 93 })
    expect(cover(62)).toEqual(['T', 'L1', 'L2', 'L3', 'R1', 'R2', 'R3'])
    expect(cover(67)).toEqual(['T', 'L1', 'L2', 'L3', 'Eb'])
    expect(cover(69)).toEqual(['T', 'L1', 'L2', 'Eb'])
    expect(cover(70)).toEqual(['Bb', 'L1', 'Eb'])
    expect(cover(73)).toEqual(['Eb'])
    // the second octave's D and E♭ lift the left index finger
    expect(cover(74)).not.toContain('L1')
    expect(cover(75)).not.toContain('L1')
    // E–C♯ overblown: the same as an octave lower
    for (let m = 76; m <= 85; m++) expect(FLUTE.fingerings[m]).toBe(FLUTE.fingerings[m - 12])
    expect(cover(86)).toEqual(['T', 'L2', 'L3', 'Eb'])
    expect(cover(87)).toEqual(['T', 'L1', 'L2', 'L3', 'G#', 'R1', 'R2', 'R3', 'Eb'])
    expect(cover(91)).toEqual(['L1', 'L2', 'L3', 'Eb'])
    expect(windArpeggio(FLUTE, 'C').map((n) => n.register)).toEqual([1, 2, 2, 2])
    expect(windArpeggio(FLUTE, 'C#9').map((n) => n.register)).toEqual([1, 2, 2, 3])
  })
})

describe('wind chord sound', () => {
  it('plays the arpeggio one note after the other, each blown until a breath before the next', () => {
    const notes = windChordNotes('C', 'flute')
    expect(notes.map((n) => n.midi)).toEqual([72, 76, 79, 84])
    expect(notes.map((n) => n.target)).toEqual([0, 1, 2, 3])
    notes.forEach((n, i) => {
      expect(n.offset).toBeCloseTo(i * WIND_STEP, 9)
      if (i < notes.length - 1) expect(n.offset + n.hold!).toBeLessThan(notes[i + 1].offset)
    })
    expect(notes[3].hold).toBe(WIND_LAST_HOLD)
    expect(windNote('C', 'flute', 2)).toMatchObject({ midi: 79, target: 2 })
    expect(windNote('C', 'flute', 7)).toBeNull()
    expect(windChord('flute', 'C')).toBe(windChord('flute', 'C'))
    expect(windChord('piano', 'C')).toEqual([])
  })

  it('plays along a note per beat, from the first note at every change and downbeat', () => {
    const chords = [
      { start: 0, end: 4, label: 'C' },
      { start: 4, end: 6, label: 'G' },
    ]
    const times = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]
    const grid = { times, pos: times.map((_, i) => i % 4), meter: 4 } as unknown as Parameters<typeof accompanySteps>[2]
    const notesFor = (label: string) => windChordNotes(label, 'flute')
    const steps = accompanySteps('flute', chords, grid, notesFor)
    expect(steps.map((s) => s.notes[0].midi)).toEqual([72, 76, 79, 84, 72, 76, 79, 84, 67, 71, 74, 79])
    for (const s of steps) {
      expect(s.cut).toBe('all')
      expect(s.notes).toHaveLength(1)
      expect(s.notes[0].hold).toBeCloseTo(0.5 - WIND_BREATH, 9)
    }
  })
})

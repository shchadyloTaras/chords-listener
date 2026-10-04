import { describe, expect, it } from 'vitest'
import { decodeNotes, encodeNotes, MAX_NOTES, NotesFormatError, toEvents, validateNotes } from './compact'

describe('encodeNotes', () => {
  it('sorts, rounds to ms and drops invalid events', () => {
    const data = encodeNotes(
      [
        { midi: 64, start: 1.2504999, end: 1.7501, velocity: 0.81234 },
        { midi: 60, start: 0.5, end: 2, velocity: 1.4 },
        { midi: 48, start: 0.5, end: 1, velocity: -0.2 },
        { midi: 20, start: 0, end: 1, velocity: 0.5 }, // below the piano
        { midi: 70, start: 3, end: 3, velocity: 0.5 }, // empty
        { midi: 71, start: Number.NaN, end: 4, velocity: 0.5 },
      ],
      'test engine',
    )
    expect(data).toEqual({
      version: 1,
      engine: 'test engine',
      notes: [
        [0.5, 1, 48, 0],
        [0.5, 2, 60, 1],
        [1.25, 1.75, 64, 0.812],
      ],
    })
    expect(validateNotes(data)).toBeNull()
  })

  it('round-trips through JSON and the columnar form', () => {
    const events = Array.from({ length: 500 }, (_, i) => ({
      midi: 21 + (i % 88),
      start: i * 0.137,
      end: i * 0.137 + 0.25 + (i % 7) * 0.1,
      velocity: ((i * 37) % 100) / 100,
    }))
    const data = JSON.parse(JSON.stringify(encodeNotes(events, 'x')))
    const cols = decodeNotes(data, 500 * 0.137 + 2)
    expect(cols.count).toBe(500)
    expect(cols.start[0]).toBe(0)
    for (let i = 1; i < cols.count; i++) expect(cols.start[i]).toBeGreaterThanOrEqual(cols.start[i - 1])
    const back = toEvents(cols)
    back.forEach((e, i) => {
      expect(e.midi).toBe(events[i].midi)
      expect(e.start).toBeCloseTo(events[i].start, 3)
      expect(e.end).toBeCloseTo(events[i].end, 3)
      expect(e.velocity).toBeCloseTo(events[i].velocity, 3)
    })
    // compact: about 20 bytes per note
    expect(JSON.stringify(data).length / 500).toBeLessThan(26)
  })
})

describe('validateNotes / decodeNotes', () => {
  const ok = { version: 1, engine: 'e', notes: [[0, 1, 60, 0.5]] }

  it.each([
    [null, 'not an object'],
    [{ ...ok, version: 2 }, 'version'],
    [{ ...ok, engine: '' }, 'engine'],
    [{ ...ok, notes: 'x' }, 'array'],
    [{ ...ok, notes: [[0, 1, 60]] }, '[start, end, midi, velocity]'],
    [{ ...ok, notes: [[0, 1, 60.5, 0.5]] }, 'pitch'],
    [{ ...ok, notes: [[0, 1, 109, 0.5]] }, 'pitch'],
    [{ ...ok, notes: [[1, 1, 60, 0.5]] }, 'times'],
    [{ ...ok, notes: [[-1, 1, 60, 0.5]] }, 'times'],
    [{ ...ok, notes: [[0, 1, 60, 2]] }, 'velocity'],
    [{ ...ok, notes: [[0, Infinity, 60, 0.5]] }, 'non-finite'],
    [{ ...ok, notes: [[0, 1, 60, '0.5']] }, 'non-finite'],
  ])('rejects %j', (data, reason) => {
    expect(validateNotes(data)).toContain(reason)
    expect(() => decodeNotes(data)).toThrow(NotesFormatError)
  })

  it('bounds note ends by the track duration (+1 s)', () => {
    expect(validateNotes({ ...ok, notes: [[0, 30.9, 60, 0.5]] }, 30)).toBeNull()
    expect(validateNotes({ ...ok, notes: [[0, 31.5, 60, 0.5]] }, 30)).toContain('times')
    expect(validateNotes({ ...ok, notes: [[0, 31.5, 60, 0.5]] })).toBeNull()
  })

  it('caps the note count', () => {
    const many = Array.from({ length: MAX_NOTES + 1 }, () => [0, 1, 60, 0.5])
    expect(validateNotes({ ...ok, notes: many })).toContain('too many')
  })

  it('decodes unsorted rows into sorted columns', () => {
    const cols = decodeNotes({ version: 1, engine: 'e', notes: [[2, 3, 62, 0.4], [0, 1, 60, 0.5], [0, 2, 55, 1]] })
    expect([...cols.start]).toEqual([0, 0, 2])
    expect([...cols.midi]).toEqual([55, 60, 62])
    expect([...cols.end]).toEqual([2, 1, 3])
  })
})

import { describe, expect, it } from 'vitest'
import type { ChordSegment } from '../../types'
import { barIndexAt, buildBarGrid, buildBars, buildLines, groupRepeats, trimSilentBars } from './bars'
import { buildDisplayChords } from './display'
import { formatBarsText, formatChordPro, formatChords, formatTime, formatTimestamps, formatUnique, safeFileName, type ExportInput } from './formats'

const BEAT = 0.5 // 120 bpm

function seg(start: number, end: number, label: string): ChordSegment {
  return { start, end, label, root: null, quality: null, bass: null, confidence: 0.9 }
}

/** chords from [label, beats] pairs starting at t0 */
function song(spec: [string, number][], t0 = 0): ChordSegment[] {
  let t = t0
  return spec.map(([label, beats]) => {
    const s = seg(t, t + beats * BEAT, label)
    t += beats * BEAT
    return s
  })
}

function grid(duration: number, offset = 0) {
  const beats: number[] = []
  for (let t = offset; t < duration - 1e-9; t += BEAT) beats.push(+t.toFixed(6))
  return { duration, beats, downbeats: beats.filter((_, i) => i % 4 === 0), tempo: 120, timeSignature: 4 }
}

const opts = { transpose: 0, simplify: false, spelling: 'sharp' as const }

describe('buildBarGrid', () => {
  it('uses downbeats', () => {
    const g = buildBarGrid(grid(8))
    expect(g.map((b) => [b.start, b.end])).toEqual([[0, 2], [2, 4], [4, 6], [6, 8]])
    expect(g.every((b) => b.boundaries.length === 5 && !b.pickup)).toBe(true)
  })

  it('creates a pickup bar for a lead-in shorter than a bar', () => {
    const g = buildBarGrid(grid(9, 1))
    expect(g[0]).toMatchObject({ start: 0, end: 1, pickup: true })
    expect(g[0].boundaries.length - 1).toBe(2)
    expect(g[1].start).toBe(1)
    expect(g[g.length - 1].end).toBe(9)
  })

  it('absorbs a tiny lead-in and a tiny tail', () => {
    const g = buildBarGrid({ ...grid(8.3, 0.2), duration: 8.3 })
    expect(g[0].start).toBe(0)
    expect(g[0].pickup).toBe(false)
    expect(g[g.length - 1].end).toBe(8.3)
    expect(g.length).toBe(4)
  })

  it('falls back to beats, then tempo, then a fixed grid', () => {
    const fromBeats = buildBarGrid({ duration: 8, beats: grid(8).beats, downbeats: [], timeSignature: 4 })
    expect(fromBeats.map((b) => b.start)).toEqual([0, 2, 4, 6])
    const fromTempo = buildBarGrid({ duration: 6, tempo: 60, timeSignature: 3 })
    expect(fromTempo.map((b) => b.start)).toEqual([0, 3])
    expect(fromTempo[0].boundaries.length - 1).toBe(3)
    const fixed = buildBarGrid({ duration: 4 })
    expect(fixed.map((b) => [b.start, b.end])).toEqual([[0, 2], [2, 4]])
  })

  it('fills gaps in the downbeats', () => {
    const g = buildBarGrid({ duration: 10, downbeats: [0, 2, 8], tempo: 120, timeSignature: 4 })
    expect(g.map((b) => +b.start.toFixed(3))).toEqual([0, 2, 4, 6, 8])
  })

  it('handles empty input', () => {
    expect(buildBarGrid({ duration: 0 })).toEqual([])
  })
})

describe('fillBars', () => {
  it('places chords on beats and repeats held chords', () => {
    const src = song([['Am', 4], ['F', 4], ['C', 4], ['G', 2], ['G/B', 2], ['C', 8]])
    const chords = buildDisplayChords(src, opts)
    const bars = buildBars(grid(12), chords)
    expect(bars.map((b) => b.slots.map((s) => `${s.label}@${s.beat}+${s.span}`).join(' '))).toEqual([
      'Am@0+4', 'F@0+4', 'C@0+4', 'G@0+2 G/B@2+2', 'C@0+4', 'C@0+4',
    ])
    expect(bars[5].slots[0].continued).toBe(true)
    expect(bars[4].slots[0].continued).toBe(false)
    expect(bars[5].slots[0].chordIndex).toBe(bars[4].slots[0].chordIndex)
  })

  it('absorbs chords shorter than a beat', () => {
    const src = [seg(0, 1.9, 'Am'), seg(1.9, 2.1, 'E'), seg(2.1, 4, 'F')]
    const bars = buildBars(grid(4), buildDisplayChords(src, opts))
    expect(bars.map((b) => b.slots.map((s) => s.label))).toEqual([['Am'], ['F']])
    expect(bars[0].slots[0].span).toBe(4)
    expect(bars[1].slots[0]).toMatchObject({ beat: 0, span: 4, start: 2 })
  })

  it('finds bars by time and trims silent edges', () => {
    const src = song([['N', 4], ['Am', 4], ['N', 4]])
    const bars = buildBars(grid(6), buildDisplayChords(src, opts))
    expect(barIndexAt(bars, 2.5)).toBe(1)
    expect(barIndexAt(bars, 99)).toBe(-1)
    expect(trimSilentBars(bars).map((b) => b.index)).toEqual([1])
  })
})

describe('lines & repeats', () => {
  it('chunks lines and folds consecutive repeats', () => {
    const loop: [string, number][] = [['Am', 4], ['F', 4], ['C', 4], ['G', 4]]
    const src = song([...loop, ...loop, ...loop, ['Dm', 4], ['E', 4], ['Am', 8]])
    const bars = buildBars(grid(32), buildDisplayChords(src, opts))
    const lines = buildLines(bars, 4)
    expect(lines.length).toBe(4)
    const groups = groupRepeats(lines)
    expect(groups.map((g) => g.lines.length)).toEqual([3, 1])
  })

  it('puts a pickup bar on its own line', () => {
    const src = [seg(0, 1, 'E'), ...song([['Am', 4], ['F', 4]], 1)]
    const bars = buildBars(grid(5, 1), buildDisplayChords(src, opts))
    const lines = buildLines(bars, 4)
    expect(lines[0].pickup).toBe(true)
    expect(lines[0].bars.length).toBe(1)
    expect(lines[1].bars.map((b) => b.slots[0].label)).toEqual(['Am', 'F'])
  })
})

describe('formats', () => {
  const src = song([['N', 4], ['Am', 4], ['F', 4], ['C', 4], ['G', 2], ['G/B', 2], ['Am', 4], ['F', 4], ['C', 4], ['G', 2], ['G/B', 2], ['N', 4]])
  const chords = buildDisplayChords(src, opts)
  const bars = buildBars(grid(20), chords)
  const input: ExportInput = {
    meta: { title: 'Song', artist: 'Band', keyName: 'Am', tempo: 120.4, timeSignature: 4 },
    chords,
    bars,
    barsPerLine: 4,
  }

  it('formats time', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(12.7)).toBe('0:12')
    expect(formatTime(75)).toBe('1:15')
    expect(formatTime(3725)).toBe('1:02:05')
  })

  it('bars: trims silence, pads columns, folds repeats on demand', () => {
    expect(formatBarsText(input)).toBe(['| Am | F | C | G G/B |', '| Am | F | C | G G/B |'].join('\n'))
    expect(formatBarsText({ ...input, collapseRepeats: true })).toBe('| Am | F | C | G G/B |  ×2')
    expect(formatBarsText({ ...input, barsPerLine: 2 })).toBe(
      ['| Am | F     |', '| C  | G G/B |', '| Am | F     |', '| C  | G G/B |'].join('\n'),
    )
  })

  it('bars: selection range', () => {
    expect(formatBarsText(input, { fromBar: 2, toBar: 3 })).toBe('| F | C |')
    expect(formatBarsText(input, { fromBar: 0, toBar: 0 })).toBe('N.C.')
  })

  it('timestamps', () => {
    expect(formatTimestamps(input).split('\n').slice(0, 5)).toEqual(['0:02  Am', '0:04  F', '0:06  C', '0:08  G', '0:09  G/B'])
    expect(formatTimestamps(input, { fromBar: 2, toBar: 2 })).toBe('0:04  F')
  })

  it('chordpro', () => {
    const cho = formatChordPro(input)
    expect(cho.split('\n').slice(0, 7)).toEqual([
      '{title: Song}',
      '{artist: Band}',
      '{key: Am}',
      '{tempo: 120}',
      '{time: 4/4}',
      '',
      '| [Am] | [F] | [C] | [G] [G/B] |',
    ])
    expect(formatChordPro(input, { fromBar: 1, toBar: 2 })).toBe('| [Am] | [F] |')
  })

  it('unique', () => {
    expect(formatUnique(input)).toBe('Am F C G G/B')
    expect(formatChords('unique', input, { fromBar: 4, toBar: 4 })).toBe('G G/B')
  })

  it('honors transpose / simplify / spelling via display chords', () => {
    const t = buildDisplayChords(src, { transpose: 1, simplify: true, spelling: 'flat' })
    const tin: ExportInput = { ...input, chords: t, bars: buildBars(grid(20), t) }
    expect(formatChords('bars', tin).split('\n')[0]).toBe('| Bbm | Gb | Db | Ab |')
    expect(formatChords('unique', tin)).toBe('Bbm Gb Db Ab')
  })

  it('makes safe file names', () => {
    expect(safeFileName('AC/DC: Back?')).toBe('AC DC Back')
    expect(safeFileName('  ')).toBe('chords')
  })
})

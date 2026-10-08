import { describe, expect, it } from 'vitest'
import type { ChordSegment } from '../../types'
import { buildBarGrid, buildLines, fillBars, groupRepeats, type Bar } from './bars'
import { parseChord } from './chord'
import { buildDisplayChords } from './display'
import { detectSections, partChords, partKeys, songParts, withKinds, type SongSection } from './sections'

const BAR = 2 // s: 4/4 at 120 BPM

/** A song of one chord per bar, each [chords, loudness] block played in order. */
function song(blocks: [string[], number][]) {
  const labels = blocks.flatMap(([chords]) => chords)
  const chords: ChordSegment[] = labels.map((label, i) => {
    const p = parseChord(label)
    return { start: i * BAR, end: (i + 1) * BAR, label, root: p ? label.replace(/m.*$|7.*$/, '') : null, quality: p?.quality ?? null, confidence: 0.9 }
  })
  const duration = labels.length * BAR
  const beats = Array.from({ length: labels.length * 4 }, (_, i) => i * (BAR / 4))
  const downbeats = beats.filter((_, i) => i % 4 === 0)
  const bars: Bar[] = fillBars(buildBarGrid({ duration, beats, downbeats, tempo: 120, timeSignature: 4 }), buildDisplayChords(chords, { transpose: 0, simplify: false, spelling: 'sharp' }))
  // the waveform: 10 points a second at each block's loudness (dB → amplitude)
  const waveform: number[] = []
  for (const [chordsOf, db] of blocks) for (let k = 0; k < chordsOf.length * BAR * 10; k++) waveform.push(10 ** (db / 20) * (0.8 + 0.2 * Math.sin(k)))
  return { bars, duration, waveform, chords: buildDisplayChords(chords, { transpose: 0, simplify: false, spelling: 'sharp' }) }
}

const VERSE = ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G']
const CHORUS = ['F', 'G', 'C', 'Am', 'F', 'G', 'E', 'E']
const BRIDGE = ['Dm', 'Em', 'Dm', 'Em', 'Bb', 'Bb', 'G', 'G']
const kinds = (s: SongSection[]) => s.map((x) => x.kind)

/** Every bar covered once, in order, with the bars' times. */
function expectCovers(sections: SongSection[], bars: Bar[]) {
  sections.forEach((s, i) => {
    expect(s.startBar).toBe(i === 0 ? 0 : sections[i - 1].endBar)
    expect(s.endBar).toBeGreaterThan(s.startBar)
    expect(s.start).toBe(bars[s.startBar].start)
    expect(s.end).toBe(bars[s.endBar - 1].end)
  })
  expect(sections.at(-1)!.endBar).toBe(bars.length)
}

/** A deterministic "random" chord per bar: a song with no repeats. */
function noise(n: number, seed = 7): string[] {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  let x = seed
  return Array.from({ length: n }, () => {
    x = (x * 1103515245 + 12345) % 2 ** 31
    return names[x % 12] + (x & 4096 ? 'm' : '')
  })
}

describe('song sections', () => {
  const pop = song([
    [['C', 'C', 'C', 'C'], -6],
    [VERSE, -6],
    [CHORUS, 0],
    [VERSE, -6],
    [CHORUS, 0],
    [BRIDGE, -3],
    [CHORUS, 0],
    [['C', 'C', 'C', 'C'], -9],
  ])
  const sections = detectSections(pop)

  it('finds intro, verse, chorus, bridge and outro of a verse–chorus song', () => {
    expect(kinds(sections)).toEqual(['intro', 'verse', 'chorus', 'verse', 'chorus', 'bridge', 'chorus', 'outro'])
    expect(sections.map((s) => [s.startBar, s.endBar])).toEqual([
      [0, 4],
      [4, 12],
      [12, 20],
      [20, 28],
      [28, 36],
      [36, 44],
      [44, 52],
      [52, 56],
    ])
  })

  it('gives every repeat of a part the same letter, numbered in order', () => {
    const choruses = sections.filter((s) => s.kind === 'chorus')
    expect(new Set(choruses.map((s) => s.group)).size).toBe(1)
    expect(choruses.map((s) => `${s.n}/${s.of}`)).toEqual(['1/3', '2/3', '3/3'])
  })

  it('covers every bar, in order, with each section’s time range', () => {
    expectCovers(sections, pop.bars)
  })

  it('splits a song on one chord loop where it gets loud: a quiet verse, a loud chorus', () => {
    const loop = ['Am', 'F', 'C', 'G']
    const quiet = [...loop, ...loop, ...loop, ...loop]
    const s = detectSections(song([
      [quiet, -8],
      [quiet, 0],
      [quiet, -8],
      [quiet, 0],
    ]))
    const groups = s.map((x) => x.group)
    expect(groups[0]).not.toBe(groups[1])
    expect(groups[0]).toBe(groups[2])
    expect(groups[1]).toBe(groups[3])
    expect(s.filter((x) => x.group === groups[1]).every((x) => x.kind === 'chorus')).toBe(true)
  })

  it('finds the same parts in a fragment of a long video (bars from its start, waveform padded before it)', () => {
    const blocks: [string[], number][] = [
      [['C', 'C', 'C', 'C'], -6],
      [VERSE, -6],
      [CHORUS, 0],
      [BRIDGE, -3],
      [VERSE, -6],
      [CHORUS, 0],
      [VERSE, -6],
      [CHORUS, 0],
      [['C', 'C', 'C', 'C'], -9],
    ]
    const plain = song(blocks)
    const at = 1000
    const labels = blocks.flatMap(([chords]) => chords)
    const chords: ChordSegment[] = [
      { start: 0, end: at, label: 'N', root: null, quality: null, confidence: 1 },
      ...labels.map((label, i) => {
        const p = parseChord(label)
        return { start: at + i * BAR, end: at + (i + 1) * BAR, label, root: p ? label.replace(/m.*$|7.*$/, '') : null, quality: p?.quality ?? null, confidence: 0.9 }
      }),
    ]
    const beats = Array.from({ length: labels.length * 4 }, (_, i) => at + i * (BAR / 4))
    const duration = at + plain.duration
    const bars = fillBars(
      buildBarGrid({ start: at, duration, beats, downbeats: beats.filter((_, i) => i % 4 === 0), tempo: 120, timeSignature: 4 }),
      buildDisplayChords(chords, { transpose: 0, simplify: false, spelling: 'sharp' }),
    )
    const waveform = [...new Array<number>(at * 10).fill(0), ...plain.waveform]
    const s = detectSections({ bars, waveform, duration, start: at })
    expectCovers(s, bars)
    const expected = detectSections(plain)
    expect(kinds(s)).toEqual(kinds(expected))
    expect(s.map((x) => [x.startBar, x.endBar])).toEqual(expected.map((x) => [x.startBar, x.endBar]))
  })

  it('has no sections without chords', () => {
    expect(detectSections(song([[['N', 'N', 'N', 'N'], 0]]))).toEqual([])
  })

  it('groups the sections by part, with the chords each part plays', () => {
    const parts = songParts(sections)
    expect(parts.map((p) => p.kind)).toEqual(['intro', 'verse', 'chorus', 'bridge', 'outro'])
    const chorus = parts.find((p) => p.kind === 'chorus')!
    expect(partChords(pop.chords, chorus).map((u) => u.label)).toEqual(['F', 'G', 'C', 'Am', 'E'])
    expect(partChords(pop.chords, parts.find((p) => p.kind === 'bridge')!).map((u) => u.label)).toEqual(['Dm', 'Em', 'A#', 'G']) // sharp spelling
  })

  it('takes the user’s names for parts over the detected ones, keyed by when the part first starts', () => {
    const verse = sections.find((s) => s.kind === 'verse')!.group
    const keys = partKeys(sections)
    expect(keys.get(verse)).toBe(String(4 * BAR))
    const renamed = withKinds(sections, { [keys.get(verse)!]: 'prechorus' })
    expect(kinds(renamed)).toEqual(['intro', 'prechorus', 'chorus', 'prechorus', 'chorus', 'bridge', 'chorus', 'outro'])
    expect(withKinds(sections, undefined)).toEqual(sections)
    expect(withKinds(sections, null)).toEqual(sections)
    // a stale or unknown name is ignored
    expect(withKinds(sections, { [keys.get(verse)!]: 'solo', 999: 'chorus' })).toEqual(sections)
  })

  it('keeps a louder second verse a verse (only a cut section splits by loudness)', () => {
    const s = detectSections(song([
      [VERSE, -9],
      [CHORUS, 0],
      [VERSE, -3],
      [CHORUS, 0],
      [VERSE, -9],
      [CHORUS, 0],
    ]))
    const verses = s.filter((x) => x.kind === 'verse')
    expect(verses).toHaveLength(3)
    expect(new Set(verses.map((x) => x.group)).size).toBe(1)
  })

  it('handles tiny, one-chord and silent-waveform songs without gaps', () => {
    for (const blocks of [
      [[['C'], 0]],
      [[['C', 'G', 'Am'], 0]],
      [[['C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C'], 0]],
      [[['N', 'N', ...VERSE, 'N'], 0]],
    ] as [string[], number][][]) {
      const x = song(blocks)
      const s = detectSections({ bars: x.bars, duration: x.duration })
      expectCovers(s, x.bars)
      expect(new Set(s.map((y) => y.kind)).size).toBeGreaterThan(0)
    }
  })

  it('letters past Z, and stays fast on a long song', () => {
    const x = song([[noise(400), 0]])
    const t0 = performance.now()
    const s = detectSections(x)
    const ms = performance.now() - t0
    expectCovers(s, x.bars)
    for (const g of new Set(s.map((y) => y.group))) expect(g).toMatch(/^[A-Z](\d+)?′?$/)
    // one group per part: no two different parts share a letter
    const parts = songParts(s)
    expect(new Set(parts.map((p) => p.group)).size).toBe(parts.length)
    expect(ms).toBeLessThan(1000)
  })

  it('never folds a line that starts a section into the one before', () => {
    const loop = song([[['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'], 0]])
    const lines = buildLines(loop.bars, 4)
    expect(groupRepeats(lines).map((g) => g.lines.length)).toEqual([3])
    expect(groupRepeats(lines, new Set([8])).map((g) => g.lines.length)).toEqual([2, 1])
  })

  it('starts a sheet line at every section', () => {
    const lines = buildLines(pop.bars, 8, new Set(sections.map((s) => s.startBar)))
    expect(lines.map((l) => [l.bars[0].index, l.bars.length])).toEqual([
      [0, 4],
      [4, 8],
      [12, 8],
      [20, 8],
      [28, 8],
      [36, 8],
      [44, 8],
      [52, 4],
    ])
  })
})

import { describe, expect, it } from 'vitest'
import { demoSong, steadyBars } from './__fixtures__/song'
import { buildScore, type ScoreInput } from './build'
import type { ScoreLevel, ScoreNote, ScoreOptions } from './types'

const LABELS = { vocal: 'Вокал', vocalAbbr: 'Вок.', piano: 'Фортепіано', pianoAbbr: 'Фп.', credit: 'Транскрипція: Chords Listener' }

const opts = (level: ScoreLevel, over: Partial<ScoreOptions> = {}): ScoreOptions => ({ vocals: true, piano: true, chords: true, level, ...over })

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  const song = demoSong()
  return {
    title: 'Тест',
    artist: null,
    key: { tonic: 'A', mode: 'minor', name: 'Am' },
    keyName: 'Am',
    transpose: 0,
    accidentals: 'auto',
    tempo: 100,
    timeSignature: 4,
    bars: song.bars,
    piano: song.piano,
    pianoSource: 'instruments',
    vocals: song.vocals,
    options: opts('full'),
    labels: LABELS,
    ...over,
  }
}

const strikes = (ns: ScoreNote[]) => ns.map((n) => [n.start, n.end, n.pitches])
const onGrid = (ns: ScoreNote[], step: number) => ns.every((n) => n.start % step === 0 && n.end % step === 0)

describe('buildScore: notation levels', () => {
  it('simple: the piano part comes from the chord sheet, without any transcribed notes', () => {
    const s = buildScore(input({ piano: null, pianoSource: null, options: opts('simple') }))
    expect(s.parts.map((p) => p.id)).toEqual(['vocal', 'piano'])
    const piano = s.parts[1]
    expect(piano.staves.map((st) => st.clef)).toEqual(['treble', 'bass'])
    // Am | F | C | G: a whole note per bar
    expect(strikes(piano.staves[0].events)).toEqual([
      [0, 16, [60, 64, 69]],
      [16, 32, [60, 65, 69]],
      [32, 48, [60, 64, 67]],
      [48, 64, [59, 62, 67]],
    ])
    expect(piano.staves[1].events.map((n) => n.pitches)).toEqual([[45], [41], [48], [43]])
    expect(s.pianoSource).toBe('chords')
    // the chord symbols stay on the top part
    expect(s.chordsOn).toBe('vocal')
  })

  it('simple ignores the transcribed notes', () => {
    const withNotes = buildScore(input({ options: opts('simple') }))
    const without = buildScore(input({ piano: null, pianoSource: null, options: opts('simple') }))
    expect(withNotes.parts).toEqual(without.parts)
    expect(withNotes.pianoSource).toBe('chords')
  })

  it('simple: no piano part when the piano is off or the sheet has no chords', () => {
    expect(buildScore(input({ piano: null, pianoSource: null, options: opts('simple', { piano: false }) })).parts.map((p) => p.id)).toEqual(['vocal'])
    for (const chords of [[], [['N', 0, 16]]] as [string, number, number][][]) {
      const { bars } = steadyBars({ bpm: 100, bars: 4, chords })
      const s = buildScore(input({ bars, piano: null, pianoSource: null, options: opts('simple') }))
      expect(s.parts.map((p) => p.id)).toEqual(['vocal'])
      expect(s.pianoSource).toBeNull()
    }
  })

  it('simple: the chord symbols move to the piano without vocals', () => {
    const s = buildScore(input({ piano: null, pianoSource: null, vocals: null, options: opts('simple') }))
    expect(s.parts.map((p) => p.id)).toEqual(['piano'])
    expect(s.chordsOn).toBe('piano')
    expect(s.chords.map((c) => c.label)).toEqual(['Am', 'F', 'C', 'G'])
  })

  it('simple writes the vocals like medium: on the eighth grid', () => {
    const full = buildScore(input())
    const medium = buildScore(input({ options: opts('medium') }))
    const simple = buildScore(input({ piano: null, pianoSource: null, options: opts('simple') }))
    expect(onGrid(full.parts[0].staves[0].events, 2)).toBe(false)
    expect(onGrid(medium.parts[0].staves[0].events, 2)).toBe(true)
    expect(simple.parts[0].staves[0].events).toEqual(medium.parts[0].staves[0].events)
  })

  it('full and medium arrange the transcribed notes (medium on the eighth grid)', () => {
    const full = buildScore(input())
    const medium = buildScore(input({ options: opts('medium') }))
    expect(full.pianoSource).toBe('instruments')
    expect(medium.pianoSource).toBe('instruments')
    expect(full.parts[1].staves[0].events[0].pitches).toEqual([57, 60, 64])
    expect(onGrid(medium.parts[1].staves[0].events, 2)).toBe(true)
    // without notes there is no piano part
    expect(buildScore(input({ piano: null, pianoSource: null, options: opts('medium') })).parts.map((p) => p.id)).toEqual(['vocal'])
  })
})

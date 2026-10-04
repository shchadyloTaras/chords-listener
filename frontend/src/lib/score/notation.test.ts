import { describe, expect, it } from 'vitest'
import { steadyBars } from './__fixtures__/song'
import { notate, noteFits, restFits, splitValues } from './notation'
import { buildTimeMap, DIV } from './timeMap'
import type { ScoreNote, WrittenNote } from './types'

const map44 = buildTimeMap(steadyBars({ bpm: 120, bars: 4 }).bars, 4)
const map34 = buildTimeMap(steadyBars({ bpm: 120, bars: 4, ts: 3 }).bars, 3)
const note = (start: number, end: number, pitch = 60): ScoreNote => ({ start, end, pitches: [pitch], velocity: 0.8 })
const shape = (ws: WrittenNote[]) =>
  ws.map((w) => `${w.pitches.length ? 'n' : 'r'}${w.type ?? 'measure'}${w.dots ? '.' : ''}${w.tieStart ? '~' : ''}`)

describe('splitValues', () => {
  it('writes beat-aligned values as single notes', () => {
    expect(splitValues(0, 12, 16, 4, false).map((v) => v.ticks)).toEqual([12]) // dotted half on beat 1
    expect(splitValues(0, 6, 16, 4, false).map((v) => v.ticks)).toEqual([6]) // dotted quarter
    expect(splitValues(8, 3, 16, 4, false).map((v) => v.ticks)).toEqual([3]) // dotted eighth
    expect(splitValues(0, 16, 16, 4, false).map((v) => v.ticks)).toEqual([16]) // whole
  })

  it('allows the common syncopations', () => {
    expect(splitValues(2, 4, 16, 4, false).map((v) => v.ticks)).toEqual([4]) // 8th–quarter–8th
    expect(splitValues(4, 8, 16, 4, false).map((v) => v.ticks)).toEqual([8]) // quarter–half–quarter
    expect(splitValues(1, 2, 16, 4, false).map((v) => v.ticks)).toEqual([2]) // 16th–8th–16th
    expect(splitValues(2, 6, 16, 4, false).map((v) => v.ticks)).toEqual([6]) // 8th–dotted quarter
  })

  it('never hides the middle of a 4/4 bar with a syncopation', () => {
    expect(splitValues(6, 4, 16, 4, false).map((v) => v.ticks)).toEqual([2, 2])
    expect(splitValues(4, 12, 16, 4, false).map((v) => v.ticks)).toEqual([8, 4])
  })

  it('rests show every beat and are never dotted', () => {
    expect(splitValues(2, 6, 16, 4, true).map((v) => v.ticks)).toEqual([2, 4])
    expect(splitValues(4, 12, 16, 4, true).map((v) => v.ticks)).toEqual([4, 8])
    expect(splitValues(0, 6, 16, 4, true).map((v) => v.ticks)).toEqual([4, 2])
    expect(splitValues(0, 3, 16, 4, true).map((v) => v.ticks)).toEqual([2, 1])
  })

  it('3/4: a dotted half fills the bar, halves on beats 1 and 2', () => {
    expect(splitValues(0, 12, 12, 3, false).map((v) => v.ticks)).toEqual([12])
    expect(splitValues(4, 8, 12, 3, false).map((v) => v.ticks)).toEqual([8])
    expect(noteFits(0, 16, 12, 3)).toBe(false)
    expect(restFits(4, 8, 12, 3)).toBe(true)
  })
})

describe('notate', () => {
  it('fills gaps with rests and writes whole-measure rests', () => {
    const measures = notate([note(4, 8)], map44.measures)
    expect(shape(measures[0])).toEqual(['rquarter', 'nquarter', 'rhalf'])
    expect(shape(measures[1])).toEqual(['rmeasure'])
    expect(measures[1][0]).toMatchObject({ measureRest: true, duration: 16 })
  })

  it('ties a note across the barline', () => {
    const measures = notate([note(8, 20)], map44.measures)
    expect(shape(measures[0])).toEqual(['rhalf', 'nhalf~'])
    expect(shape(measures[1])).toEqual(['nquarter', 'rquarter', 'rhalf'])
    expect(measures[1][0]).toMatchObject({ tieStop: true, tieStart: false })
  })

  it('every measure adds up to its length', () => {
    const events = [note(0, 3), note(3, 9), note(10, 11), note(13, 30), note(31, 47), note(50, 64)]
    for (const [i, ws] of notate(events, map44.measures).entries()) {
      expect(ws.reduce((a, w) => a + w.duration, 0)).toBe(map44.measures[i].ticks)
    }
  })

  it('splits notes and rests where the chord changes and attaches the chord symbol', () => {
    const harmonies = new Map([
      [0, 'C'],
      [8, 'G'],
      [16, 'Am'],
      [24, 'F'],
    ])
    const measures = notate([note(0, 16)], map44.measures, harmonies)
    expect(shape(measures[0])).toEqual(['nhalf~', 'nhalf'])
    expect(measures[0].map((w) => w.harmony)).toEqual(['C', 'G'])
    // an empty measure with a chord change at beat 3: two half rests instead of a measure rest
    expect(shape(measures[1])).toEqual(['rhalf', 'rhalf'])
    expect(measures[1].map((w) => w.harmony)).toEqual(['Am', 'F'])
  })

  it('a measure rest still carries a chord symbol on its downbeat', () => {
    const measures = notate([], map44.measures, new Map([[16, 'Dm']]))
    expect(measures[1]).toHaveLength(1)
    expect(measures[1][0]).toMatchObject({ measureRest: true, harmony: 'Dm' })
  })

  it('beams eighths and sixteenths by beat with hooks', () => {
    const events = [note(0, 2), note(2, 4), note(4, 5), note(5, 6), note(6, 7), note(7, 8), note(8, 11), note(11, 12), note(12, 13), note(13, 16)]
    const [m] = notate(events, map44.measures)
    expect(m.map((w) => w.beams)).toEqual([
      ['begin'],
      ['end'],
      ['begin', 'begin'],
      ['continue', 'continue'],
      ['continue', 'continue'],
      ['end', 'end'],
      ['begin'],
      ['end', 'backward hook'],
      ['begin', 'forward hook'],
      ['end'],
    ])
  })

  it('rests break beams; a lone eighth has a flag', () => {
    const [m] = notate([note(0, 2), note(6, 8)], map44.measures)
    expect(m.map((w) => w.beams)).toEqual([[], [], [], [], []])
  })

  it('3/4 measures', () => {
    const measures = notate([note(0, 12), note(12, 14)], map34.measures)
    expect(shape(measures[0])).toEqual(['nhalf.'])
    expect(shape(measures[1])).toEqual(['neighth', 'reighth', 'rhalf'])
    expect(measures[1].reduce((a, w) => a + w.duration, 0)).toBe(3 * DIV)
  })
})

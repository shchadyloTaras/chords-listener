import { describe, expect, it } from 'vitest'
import { demoSong, steadyBars } from './__fixtures__/song'
import { buildScore, type ScoreInput } from './build'
import { midiVelocity, PPQ, toMidi } from './midi'

const LABELS = { vocal: 'Вокал', vocalAbbr: 'Вок.', piano: 'Фортепіано', pianoAbbr: 'Фп.', credit: 'Транскрипція: Chords Listener' }

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  const song = demoSong()
  return {
    title: 'Тест',
    artist: 'Гурт',
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
    options: { vocals: true, piano: true, chords: true, simplified: false },
    labels: LABELS,
    ...over,
  }
}

interface MidiEvent {
  tick: number
  status: number
  type?: number
  data: number[]
}

/** A small SMF reader for the tests. */
function parseMidi(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const str = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
  expect(str(0)).toBe('MThd')
  expect(dv.getUint32(4)).toBe(6)
  const format = dv.getUint16(8)
  const ntracks = dv.getUint16(10)
  const division = dv.getUint16(12)
  let at = 14
  const tracks: MidiEvent[][] = []
  for (let t = 0; t < ntracks; t++) {
    expect(str(at)).toBe('MTrk')
    const len = dv.getUint32(at + 4)
    let p = at + 8
    const end = p + len
    const events: MidiEvent[] = []
    let tick = 0
    const vlq = () => {
      let v = 0
      for (;;) {
        const b = bytes[p++]
        v = (v << 7) | (b & 0x7f)
        if (!(b & 0x80)) return v
      }
    }
    while (p < end) {
      tick += vlq()
      const status = bytes[p++]
      if (status === 0xff) {
        const type = bytes[p++]
        const n = vlq()
        events.push({ tick, status, type, data: [...bytes.subarray(p, p + n)] })
        p += n
      } else {
        const n = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2
        events.push({ tick, status, data: [...bytes.subarray(p, p + n)] })
        p += n
      }
    }
    expect(p).toBe(end)
    const last = events[events.length - 1]
    expect([last.status, last.type]).toEqual([0xff, 0x2f])
    tracks.push(events)
    at = end
  }
  expect(at).toBe(bytes.length)
  return { format, division, tracks }
}

const decode = (data: number[]) => new TextDecoder().decode(new Uint8Array(data))
const trackName = (events: MidiEvent[]) => decode(events.find((e) => e.status === 0xff && e.type === 0x03)?.data ?? [])

describe('toMidi', () => {
  const score = buildScore(input())
  const midi = parseMidi(toMidi(score))

  it('is a format-1 file with a conductor track and one track per staff', () => {
    expect(midi.format).toBe(1)
    expect(midi.division).toBe(PPQ)
    expect(midi.tracks).toHaveLength(4)
    expect(midi.tracks.map(trackName)).toEqual(['Тест', 'Вокал', 'Фортепіано RH', 'Фортепіано LH'])
  })

  it('has the time and key signature and a tempo from the beats', () => {
    const conductor = midi.tracks[0]
    const ts = conductor.find((e) => e.type === 0x58)
    expect(ts?.data).toEqual([4, 2, 24, 8])
    const key = conductor.find((e) => e.type === 0x59)
    expect(key?.data).toEqual([0, 1])
    const tempos = conductor.filter((e) => e.type === 0x51)
    // a steady 100 BPM: one tempo (600 000 µs per quarter)
    expect(tempos).toHaveLength(1)
    const us = (tempos[0].data[0] << 16) | (tempos[0].data[1] << 8) | tempos[0].data[2]
    expect(us).toBe(600000)
  })

  it('follows an uneven tempo beat by beat', () => {
    const song = steadyBars({ bpm: 100, bars: 2, jitter: (i) => (i % 2 ? 0.03 : 0) })
    const s = buildScore(input({ bars: song.bars, vocals: [[0, 0.5, 60, 0.8]], piano: null }))
    const tempos = parseMidi(toMidi(s)).tracks[0].filter((e) => e.type === 0x51)
    expect(tempos.length).toBeGreaterThan(4)
    // beat i lasts beats[i + 1] - beats[i]
    const us = (e: MidiEvent) => (e.data[0] << 16) | (e.data[1] << 8) | e.data[2]
    expect(us(tempos[0])).toBe(Math.round((song.beats[1] - song.beats[0]) * 1e6))
    expect(us(tempos[1])).toBe(Math.round((song.beats[2] - song.beats[1]) * 1e6))
    expect(tempos[1].tick).toBe(PPQ)
  })

  it('writes every note with its velocity and length', () => {
    const vocalTrack = midi.tracks[1]
    const ons = vocalTrack.filter((e) => (e.status & 0xf0) === 0x90)
    const offs = vocalTrack.filter((e) => (e.status & 0xf0) === 0x80)
    const vocal = score.parts[0].staves[0].events
    expect(ons).toHaveLength(vocal.length)
    expect(offs).toHaveLength(vocal.length)
    expect(ons[0].data).toEqual([69, midiVelocity(0.8)])
    expect(ons[0].tick).toBe(0)
    // the first note is a quarter
    expect(offs[0].tick).toBe(PPQ)
    // piano: chords become simultaneous note-ons
    const rh = midi.tracks[2].filter((e) => (e.status & 0xf0) === 0x90)
    expect(rh.filter((e) => e.tick === 0).map((e) => e.data[0])).toEqual([57, 60, 64])
    // channels: vocal 0, right hand 1, left hand 2; program change first
    expect(midi.tracks[1].find((e) => (e.status & 0xf0) === 0xc0)?.data).toEqual([53])
    expect(new Set(rh.map((e) => e.status & 0x0f))).toEqual(new Set([1]))
    expect(new Set(midi.tracks[3].filter((e) => (e.status & 0xf0) === 0x90).map((e) => e.status & 0x0f))).toEqual(new Set([2]))
  })

  it('note-offs come before note-ons at the same tick (re-struck notes)', () => {
    for (const track of midi.tracks.slice(1)) {
      for (let i = 1; i < track.length; i++) {
        const a = track[i - 1]
        const b = track[i]
        if (a.tick === b.tick && (a.status & 0xf0) === 0x90) expect((b.status & 0xf0) === 0x80).toBe(false)
      }
    }
  })

  it('maps velocities to 1..127', () => {
    expect(midiVelocity(0)).toBe(24)
    expect(midiVelocity(1)).toBe(127)
    expect(midiVelocity(2)).toBe(127)
    expect(midiVelocity(Number.NaN)).toBeGreaterThanOrEqual(1)
  })
})

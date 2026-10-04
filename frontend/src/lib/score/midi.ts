// Score → Standard MIDI File (format 1). Track 0 holds the tempo map — one tempo per beat, taken from
// the detected beats, so the quantized notes play in time with the recording — plus time and key
// signatures; then one track per staff ("Вокал", "Фортепіано RH", "Фортепіано LH") with velocities.

import { DIV } from './timeMap'
import type { Score, ScoreNote } from './types'

export const PPQ = 480

const encoder = new TextEncoder()

function vlq(n: number): number[] {
  let v = Math.max(0, Math.round(n))
  const bytes = [v & 0x7f]
  v >>= 7
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80)
    v >>= 7
  }
  return bytes
}

interface Ev {
  tick: number
  /** order at the same tick: meta 0, note off 1, program 2, note on 3 */
  order: number
  bytes: number[]
}

function meta(tick: number, type: number, data: number[]): Ev {
  return { tick, order: 0, bytes: [0xff, type, ...vlq(data.length), ...data] }
}

function textMeta(tick: number, type: number, s: string): Ev {
  return meta(tick, type, [...encoder.encode(s)])
}

function trackChunk(events: Ev[], endTick = 0): number[] {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order)
  const body: number[] = []
  let last = 0
  for (const e of sorted) {
    body.push(...vlq(e.tick - last), ...e.bytes)
    last = e.tick
  }
  body.push(...vlq(Math.max(0, endTick - last)), 0xff, 0x2f, 0x00)
  const n = body.length
  return [0x4d, 0x54, 0x72, 0x6b, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...body]
}

export function midiVelocity(v: number): number {
  const x = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.7
  return Math.min(127, Math.max(1, Math.round(24 + 103 * x)))
}

function noteEvents(notes: readonly ScoreNote[], channel: number, scale: number): Ev[] {
  const out: Ev[] = []
  for (const n of notes) {
    const on = n.start * scale
    const off = n.end * scale
    if (!(off > on)) continue
    for (const p of n.pitches) {
      out.push({ tick: on, order: 3, bytes: [0x90 | channel, p & 0x7f, midiVelocity(n.velocity)] })
      out.push({ tick: off, order: 1, bytes: [0x80 | channel, p & 0x7f, 0x40] })
    }
  }
  return out
}

export interface MidiOptions {
  /** track names of the piano hands, default "<piano name> RH" / "LH" */
  rhName?: string
  lhName?: string
}

/** The score as a format-1 Standard MIDI File. */
export function toMidi(score: Score, opts: MidiOptions = {}): Uint8Array {
  const scale = PPQ / DIV
  const { map, key, meta: info } = score

  // ---- conductor track: names, signatures, tempo per beat
  const conductor: Ev[] = [textMeta(0, 0x03, info.title)]
  conductor.push(textMeta(0, 0x01, [info.artist, info.credit].filter(Boolean).join(' · ')))
  conductor.push(meta(0, 0x59, [key.fifths & 0xff, key.mode === 'minor' ? 1 : 0]))
  let beats = -1
  let tempo = -1
  for (const m of map.measures) {
    if (m.beats !== beats) {
      conductor.push(meta(m.offset * scale, 0x58, [m.beats, 2, 24, 8]))
      beats = m.beats
    }
    for (let k = 0; k < m.beats; k++) {
      const seconds = m.boundaries[k + 1] - m.boundaries[k]
      const us = Math.min(0xffffff, Math.max(1, Math.round(seconds * 1e6)))
      if (us === tempo) continue
      tempo = us
      conductor.push(meta((m.offset + k * DIV) * scale, 0x51, [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]))
    }
  }
  if (!map.measures.length) conductor.push(meta(0, 0x51, [0x07, 0xa1, 0x20]))

  // ---- one track per staff
  const end = map.totalTicks * scale
  const tracks: number[][] = [trackChunk(conductor, end)]
  let channel = 0
  for (const part of score.parts) {
    part.staves.forEach((staff, si) => {
      const name =
        part.staves.length === 1 ? part.name : si === 0 ? (opts.rhName ?? `${part.name} RH`) : (opts.lhName ?? `${part.name} LH`)
      const ch = channel === 9 ? ++channel : channel
      channel++
      const events: Ev[] = [textMeta(0, 0x03, name), { tick: 0, order: 2, bytes: [0xc0 | ch, part.program & 0x7f] }]
      events.push(...noteEvents(staff.events, ch, scale))
      tracks.push(trackChunk(events, end))
    })
  }

  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (tracks.length >> 8) & 0xff, tracks.length & 0xff, (PPQ >> 8) & 0xff, PPQ & 0xff]
  const total = header.length + tracks.reduce((a, t) => a + t.length, 0)
  const bytes = new Uint8Array(total)
  bytes.set(header, 0)
  let at = header.length
  for (const t of tracks) {
    bytes.set(t, at)
    at += t.length
  }
  return bytes
}

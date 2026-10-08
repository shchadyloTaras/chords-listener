// Which notes the chord sound plays — always exactly what the diagram for the selected instrument
// shows: the staff voicing on the piano keys, the right hand's shape on the harmonium, the displayed guitar / ukulele / bass
// voicing (strummed low → high; the bass arpeggiated), or the chord tones the selected handpan
// really has (a low → high arpeggio). Pure functions.

import { BASS_TUNING } from '../diagrams/bass'
import type { DbInstrument, FretInstrument, Voicing } from '../diagrams/chordsDb'
import { HARMONIUM_LOW, harmoniumVoicing } from '../diagrams/harmonium'
import { pianoVoicing } from '../diagrams/piano'
import { staffChord } from '../diagrams/staff'
import { handpanMidis, playability, type HandpanScale } from '../handpan'
import { parseChord, QUALITY_INTERVALS, type ParsedChord } from '../music/chord'
import { mod12 } from '../music/notes'

export interface NoteEvent {
  /** MIDI note number */
  midi: number
  /** seconds after the chord starts */
  offset: number
  /** 0..1 */
  velocity: number
  /** what lights up while it sounds: piano key index (0 = C4 of the diagram), harmonium key index (0 = C3), guitar / ukulele / bass string index, handpan note index (0 = ding) */
  target: number
  /** stereo position −1..1 (when the instrument does not pan by pitch) */
  pan?: number
}

// ---------- piano ----------

/** MIDI note of key 0 of the two-octave piano diagram (its right hand starts at middle C). */
export const PIANO_DIAGRAM_C = 60

/**
 * The chord as the piano diagram and the staff show it: the left hand's bass note (C3 octave) a
 * hair earlier and stronger, like a pianist, then the right-hand notes rolled upwards in ~4 ms.
 */
export function pianoChordNotes(label: string): NoteEvent[] {
  const parsed = parseChord(label)
  if (!parsed) return []
  const voicing = pianoVoicing(parsed)
  const staff = staffChord(parsed, voicing)
  const notes: NoteEvent[] = [{ midi: staff.bass.midi, offset: 0, velocity: 0.72, target: voicing.bass }]
  const top = staff.treble.length - 1
  staff.treble.forEach((n, i) => {
    notes.push({ midi: n.midi, offset: 0.018 + i * 0.004, velocity: i === top ? 0.66 : 0.62, target: n.midi - PIANO_DIAGRAM_C })
  })
  return notes
}

/** One key of the piano diagram. */
export function pianoKeyNote(key: number): NoteEvent {
  return { midi: PIANO_DIAGRAM_C + key, offset: 0, velocity: 0.68, target: key }
}

// ---------- harmonium ----------

/**
 * The harmonium diagram's shape — one right hand, the left pumps the bellows — pressed together, no
 * roll, lighting the instrument's own keys (0 = C3); the top note a touch stronger.
 */
export function harmoniumChordNotes(label: string): NoteEvent[] {
  const parsed = parseChord(label)
  if (!parsed) return []
  const { notes } = harmoniumVoicing(parsed)
  const top = notes.length - 1
  return notes.map((k, i) => ({ midi: HARMONIUM_LOW + k, offset: 0, velocity: i === top ? 0.66 : 0.62, target: k }))
}

/** One key of the harmonium diagram (key 0 = C3, its lowest key). */
export function harmoniumKeyNote(key: number): NoteEvent {
  return { midi: HARMONIUM_LOW + key, offset: 0, velocity: 0.68, target: key }
}

// ---------- guitar / ukulele / bass ----------

/** Standard tunings per string in chords-db order (guitar low E → high E; ukulele re-entrant G C E A; bass E1 A1 D2 G2). */
export const TUNINGS: Record<FretInstrument, readonly number[]> = {
  guitar: [40, 45, 50, 55, 59, 64],
  ukulele: [67, 60, 64, 69],
  bass: BASS_TUNING,
}

/** Gap between strings across a downstroke (s): it starts a bit slower and speeds up. */
const STRUM_GAPS: Record<DbInstrument, { first: number; last: number }> = {
  guitar: { first: 0.0205, last: 0.0165 },
  ukulele: { first: 0.0152, last: 0.0128 },
}

const STRING_PAN: Record<FretInstrument, number> = { guitar: 0.36, ukulele: 0.28, bass: 0.16 }

/** Bass arpeggio: one string every 110 ms, low → high, each left ringing. */
export const BASS_STEP = 0.11

/** Start offsets (s) of `count` strings in a downstroke. */
export function strumOffsets(count: number, instrument: DbInstrument): number[] {
  const { first, last } = STRUM_GAPS[instrument]
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    if (i === 0) {
      out.push(0)
      continue
    }
    const x = count > 2 ? (i - 1) / (count - 2) : 0
    out.push(out[i - 1] + first + (last - first) * x)
  }
  return out
}

/** Sounding strings of a chords-db voicing in string order, with their MIDI notes. */
export function voicingStrings(v: Voicing, instrument: FretInstrument): { string: number; midi: number }[] {
  const tuning = TUNINGS[instrument]
  const sounding: { string: number; fret: number }[] = []
  v.frets.forEach((fret, string) => {
    if (fret >= 0 && string < tuning.length) sounding.push({ string, fret })
  })
  // chords-db lists the sounding notes (muted strings left out); fall back to tuning + fret
  const db = Array.isArray(v.midi) && v.midi.length === sounding.length ? v.midi : null
  return sounding.map(({ string, fret }, i) => ({
    string,
    midi: db ? db[i] : tuning[string] + (fret === 0 ? 0 : fret + v.baseFret - 1),
  }))
}

function strum(strings: { string: number; midi: number }[], instrument: DbInstrument): NoteEvent[] {
  const offsets = strumOffsets(strings.length, instrument)
  const total = TUNINGS[instrument].length
  return strings.map(({ string, midi }, i) => ({
    midi,
    offset: offsets[i],
    velocity: 0.86 * (1 - 0.045 * i),
    target: string,
    pan: (string / (total - 1) - 0.5) * STRING_PAN[instrument],
  }))
}

function arpeggio(strings: { string: number; midi: number }[]): NoteEvent[] {
  const total = TUNINGS.bass.length
  return strings.map(({ string, midi }, i) => ({
    midi,
    offset: i * BASS_STEP,
    velocity: i === 0 ? 0.9 : 0.8,
    target: string,
    pan: (string / (total - 1) - 0.5) * STRING_PAN.bass,
  }))
}

/** The displayed voicing: strummed down from the low (guitar) / top (ukulele G) string, arpeggiated on the bass. */
export function fretChordNotes(v: Voicing, instrument: FretInstrument): NoteEvent[] {
  const strings = voicingStrings(v, instrument)
  return instrument === 'bass' ? arpeggio(strings) : strum(strings, instrument)
}

/**
 * A plain voicing when chords-db has none: chord tones stacked upwards at least a minor third
 * apart from the bass — guitar from E2–D#3 (up to 6 strings), ukulele from C4–B4 (4 strings).
 */
export function fallbackFretNotes(chord: ParsedChord, instrument: DbInstrument): NoteEvent[] {
  const pcs = QUALITY_INTERVALS[chord.quality].map((i) => mod12(chord.rootPc + i))
  const bassPc = chord.bassPc ?? chord.rootPc
  const guitar = instrument === 'guitar'
  const low = guitar ? 40 + mod12(bassPc - 4) : 60 + bassPc
  const max = guitar ? 6 : 4
  const midis = [low]
  for (let m = low + 1; midis.length < max && m < low + 26; m++) {
    if (pcs.includes(mod12(m)) && m - midis[midis.length - 1] >= 3) midis.push(m)
  }
  return strum(
    midis.map((midi, string) => ({ string, midi })),
    instrument,
  )
}

// ---------- handpan ----------

/** Handpan arpeggio: one note every 70 ms, low → high. */
export const HANDPAN_STEP = 0.07
const MAX_HANDPAN_NOTES = 5

/** Stereo position of a note from where it sits on the instrument (ding centred, ring left / right). */
export function handpanFieldPan(scale: HandpanScale, index: number): number {
  if (index <= 0) return 0
  const n = scale.tones.length
  const deg = 90 + ((index - 1) * 360) / n
  return Math.cos((deg * Math.PI) / 180) * 0.4
}

/** One struck field (or the ding). Null for an index the scale does not have. */
export function handpanFieldNote(scale: HandpanScale, index: number): NoteEvent | null {
  const midi = handpanMidis(scale)[index]
  if (midi == null) return null
  return { midi, offset: 0, velocity: 0.82, target: index, pan: handpanFieldPan(scale, index) }
}

/**
 * The chord on the handpan, only with notes the instrument has: the bass (slash bass, else root,
 * else the lowest chord tone available) on its lowest field, every other chord tone once on the
 * nearest field above it, plus the root again when there is room — played low → high, 70 ms apart.
 * Empty when none of the chord's notes are on the instrument (and for "N").
 */
export function handpanChordNotes(label: string, scale: HandpanScale): NoteEvent[] {
  const parsed = parseChord(label)
  const play = playability(label, scale)
  if (!parsed || !play) return []
  const midis = handpanMidis(scale)
  const fieldsOf = (pc: number) =>
    scale.notes
      .map((n, i) => (n.pc === pc ? i : -1))
      .filter((i) => i >= 0)
      .sort((a, b) => midis[a] - midis[b])
  const playable = play.tones.filter((tone) => tone.fields.length > 0)
  const has = (pc: number) => (scale.mask & (1 << pc)) !== 0
  const rootOk = has(parsed.rootPc)
  let bassPc: number | null = parsed.bassPc != null && has(parsed.bassPc) ? parsed.bassPc : rootOk ? parsed.rootPc : null
  if (bassPc == null) {
    if (!playable.length) return []
    const lowest = playable.map((tone) => fieldsOf(tone.pc)[0]).sort((a, b) => midis[a] - midis[b])[0]
    bassPc = scale.notes[lowest].pc
  }
  const bass = fieldsOf(bassPc)[0]
  const chosen = [bass]
  for (const tone of playable) {
    if (tone.pc === bassPc) continue
    const fields = fieldsOf(tone.pc)
    chosen.push(fields.find((i) => midis[i] > midis[bass]) ?? fields[fields.length - 1])
  }
  if (chosen.length < 4 && rootOk) {
    const again = fieldsOf(parsed.rootPc).find((i) => midis[i] > midis[bass] && !chosen.includes(i))
    if (again != null) chosen.push(again)
  }
  const order = [...new Set(chosen)].sort((a, b) => midis[a] - midis[b]).slice(0, MAX_HANDPAN_NOTES)
  return order.map((i, k) => ({
    midi: midis[i],
    offset: k * HANDPAN_STEP,
    velocity: k === 0 ? 0.88 : 0.78 - 0.02 * k,
    target: i,
    pan: handpanFieldPan(scale, i),
  }))
}

// ---------- which chord ----------

export interface ChordSpan {
  start: number
  end: number
  isNone: boolean
}

/**
 * The chord the P key plays: the one under the playhead; when there is none (before the first
 * chord, in a "no chord" stretch, after the end) the first chord of the bar selection, else the
 * next chord, else the last one. −1 when the song has no chords.
 */
export function pickChordIndex(
  chords: readonly ChordSpan[],
  time: number,
  selection: { start: number; end: number } | null,
): number {
  const at = chords.findIndex((c) => time >= c.start && time < c.end)
  if (at >= 0 && !chords[at].isNone) return at
  if (selection) {
    const i = chords.findIndex((c) => !c.isNone && c.end > selection.start + 1e-6 && c.start < selection.end - 1e-6)
    if (i >= 0) return i
  }
  const next = chords.findIndex((c) => !c.isNone && c.start >= time)
  if (next >= 0) return next
  for (let i = chords.length - 1; i >= 0; i--) if (!chords[i].isNone) return i
  return -1
}

// Handpan scales: the user's own instrument ("custom") plus well-known presets.
//
// Physical layout convention: `tones` are the tone fields in the order they sit around the
// instrument — clockwise (seen from above, player at the bottom) starting with the field nearest
// the player. The user's own notes are stored exactly in that order. Presets are written the way
// makers list them (ascending pitch) and laid out with the usual zigzag: lowest field at the
// bottom, pitch climbing alternately left / right up to the highest field at the top.

import { formatHandpanNote, noteMidi, parseHandpanNote, type HandpanNote } from './notes'

export const CUSTOM_SCALE_ID = 'custom'
export const MIN_TONES = 7
export const MAX_TONES = 14

/** The user's own handpan: ding A, then the tone fields in the order they listed them. */
export const DEFAULT_HANDPAN_NOTES: readonly string[] = ['A', 'D', 'F', 'A', 'C', 'G', 'E', 'C', 'A']

export interface HandpanScale {
  /** CUSTOM_SCALE_ID or a preset id */
  id: string
  /** preset name ("D Kurd"); null for the user's own handpan (the UI names it) */
  name: string | null
  ding: HandpanNote
  /** tone fields in physical order (see the layout convention above) */
  tones: HandpanNote[]
  /** ding first, then `tones` — the note indices used by playability / the chart */
  notes: HandpanNote[]
  /** bit i set ⇔ pitch class i is playable somewhere on the instrument */
  mask: number
  /** stable identity for caches, e.g. "A|D F A C G E C A" */
  key: string
  /** true when every note has an octave (sizes / sorting by pitch are meaningful) */
  octavesKnown: boolean
}

export interface HandpanPreset {
  id: string
  name: string
  ding: string
  /** ascending pitch, the way makers list the scale */
  tones: string[]
}

/** Widely published scales (makers' standard tunings); only ones whose notes are well established. */
export const HANDPAN_PRESETS: readonly HandpanPreset[] = [
  { id: 'd-kurd', name: 'D Kurd', ding: 'D3', tones: ['A3', 'Bb3', 'C4', 'D4', 'E4', 'F4', 'G4', 'A4'] },
  { id: 'd-celtic', name: 'D Celtic Minor', ding: 'D3', tones: ['A3', 'C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'C5'] },
  { id: 'cs-amara', name: 'C# Amara', ding: 'C#3', tones: ['G#3', 'B3', 'C#4', 'D#4', 'E4', 'F#4', 'G#4', 'B4'] },
  { id: 'e-amara', name: 'E Amara', ding: 'E3', tones: ['B3', 'D4', 'E4', 'F#4', 'G4', 'A4', 'B4', 'D5'] },
  { id: 'd-integral', name: 'D Integral', ding: 'D3', tones: ['A3', 'Bb3', 'C4', 'D4', 'E4', 'F4', 'A4'] },
  { id: 'f-low-pygmy', name: 'F Low Pygmy', ding: 'F2', tones: ['F3', 'G3', 'Ab3', 'C4', 'Eb4', 'F4', 'G4', 'Ab4'] },
  { id: 'e-equinox', name: 'E Equinox', ding: 'E3', tones: ['G3', 'B3', 'C4', 'D4', 'E4', 'F#4', 'G4', 'B4'] },
  { id: 'c-aegean', name: 'C Aegean', ding: 'C3', tones: ['E3', 'G3', 'B3', 'C4', 'E4', 'F#4', 'G4', 'B4'] },
]

/**
 * Zigzag layout of an ascending list: slot 0 (bottom) gets the lowest note, then pitch climbs
 * alternately to the next slot clockwise and the next slot counter-clockwise.
 */
export function zigzagLayout<T>(ascending: readonly T[]): T[] {
  const n = ascending.length
  const out = new Array<T>(n)
  let left = 1
  let right = n - 1
  ascending.forEach((note, rank) => {
    if (rank === 0) out[0] = note
    else if (rank % 2 === 1) out[left++] = note
    else out[right--] = note
  })
  return out
}

export type NotesError = 'empty' | 'badNote' | 'tooFew' | 'tooMany'

export type NotesValidation =
  | { ok: true; ding: HandpanNote; tones: HandpanNote[] }
  | { ok: false; error: NotesError; token?: string }

/** Validates a note list: ding first, then MIN_TONES..MAX_TONES tone fields. */
export function validateNotes(tokens: readonly string[]): NotesValidation {
  const list = tokens.map((s) => s.trim()).filter(Boolean)
  if (!list.length) return { ok: false, error: 'empty' }
  const notes: HandpanNote[] = []
  for (const token of list) {
    const n = parseHandpanNote(token)
    if (!n) return { ok: false, error: 'badNote', token }
    notes.push(n)
  }
  const tones = notes.length - 1
  if (tones < MIN_TONES) return { ok: false, error: 'tooFew' }
  if (tones > MAX_TONES) return { ok: false, error: 'tooMany' }
  return { ok: true, ding: notes[0], tones: notes.slice(1) }
}

/** Splits free text ("A, D, F…", "D3 | A3 Bb3 …", "D3 / A3 …") into note tokens. */
export function splitNotesText(text: string): string[] {
  return text.split(/[\s,;|/]+/).filter(Boolean)
}

export function parseNotesText(text: string): NotesValidation {
  return validateNotes(splitNotesText(text))
}

function makeScale(id: string, name: string | null, ding: HandpanNote, tones: HandpanNote[]): HandpanScale {
  const notes = [ding, ...tones]
  let mask = 0
  for (const n of notes) mask |= 1 << n.pc
  return {
    id,
    name,
    ding,
    tones,
    notes,
    mask,
    key: `${formatHandpanNote(ding)}|${tones.map(formatHandpanNote).join(' ')}`,
    octavesKnown: notes.every((n) => n.octave != null),
  }
}

const presetCache = new Map<string, HandpanScale>()

export function presetScale(id: string): HandpanScale | null {
  const cached = presetCache.get(id)
  if (cached) return cached
  const def = HANDPAN_PRESETS.find((p) => p.id === id)
  if (!def) return null
  const v = validateNotes([def.ding, ...zigzagLayout(def.tones)])
  if (!v.ok) return null
  const scale = makeScale(def.id, def.name, v.ding, v.tones)
  presetCache.set(id, scale)
  return scale
}

/** The user's own handpan from stored notes; invalid / missing data falls back to the default list. */
export function customScale(notes: readonly string[] | null | undefined): HandpanScale {
  const v = Array.isArray(notes) ? validateNotes(notes.filter((s): s is string => typeof s === 'string')) : null
  if (v?.ok) return makeScale(CUSTOM_SCALE_ID, null, v.ding, v.tones)
  const d = validateNotes(DEFAULT_HANDPAN_NOTES) as Extract<NotesValidation, { ok: true }>
  return makeScale(CUSTOM_SCALE_ID, null, d.ding, d.tones)
}

/** Scale for the persisted settings (unknown preset ids fall back to the user's own handpan). */
export function resolveScale(scaleId: string | null | undefined, customNotes: readonly string[] | null | undefined): HandpanScale {
  return (scaleId && scaleId !== CUSTOM_SCALE_ID && presetScale(scaleId)) || customScale(customNotes)
}

/** Stored form: ["A", "D", …] / ["D3", "A3", …] (ding first, physical order). */
export function scaleToStrings(scale: Pick<HandpanScale, 'ding' | 'tones'>): string[] {
  return [scale.ding, ...scale.tones].map(formatHandpanNote)
}

/**
 * Readable summary "D3 | A3 Bb3 C4 …". With `ascending` (and known octaves) the tone fields are
 * sorted by pitch — the way makers list scales — instead of the physical order.
 */
export function describeScale(scale: HandpanScale, ascending = false): string {
  const tones =
    ascending && scale.octavesKnown
      ? [...scale.tones].sort((a, b) => (noteMidi(a) ?? 0) - (noteMidi(b) ?? 0))
      : scale.tones
  return `${formatHandpanNote(scale.ding)} | ${tones.map(formatHandpanNote).join(' ')}`
}

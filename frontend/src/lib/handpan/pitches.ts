// The pitch of every note of a handpan, octaves inferred where the scale does not give them —
// what the chord sound plays and how big the diagram draws each field.

import { mod12 } from '../music/notes'
import { noteMidi } from './notes'
import type { HandpanScale } from './scales'

/** Lowest ding we assume for a scale written without octaves (A2); dings span A2–G#3. */
const DING_FLOOR = 45

/**
 * The most compact ascending layout of the tone fields' pitch classes (a duplicated pitch class
 * goes an octave up) that starts at `minStart` or above; ties prefer a start near `prefer`. Of two
 * fields with the same pitch class the one nearer the player (the bottom of the ring, where the
 * big low fields sit) gets the lower octave.
 */
function compactLayout(pcs: readonly number[], minStart: number, prefer: number): number[] {
  const n = pcs.length
  const nearness = (i: number) => Math.min(i, n - i)
  const byPc = new Map<number, number[]>()
  pcs.forEach((pc, i) => byPc.set(pc, [...(byPc.get(pc) ?? []), i]))
  for (const fields of byPc.values()) fields.sort((a, b) => nearness(a) - nearness(b) || a - b)
  let best: { midis: number[]; span: number; dist: number } | null = null
  for (const start of byPc.keys()) {
    const startMidi = minStart + mod12(start - minStart)
    const midis = new Array<number>(n).fill(0)
    for (const [pc, fields] of byPc) {
      const base = startMidi + mod12(pc - start)
      fields.forEach((field, k) => {
        midis[field] = base + 12 * k
      })
    }
    const span = Math.max(...midis) - Math.min(...midis)
    const dist = Math.abs(startMidi - prefer)
    if (!best || span < best.span || (span === best.span && dist < best.dist)) best = { midis, span, dist }
  }
  return best ? best.midis : []
}

/**
 * MIDI note of every note of the handpan (ding first). Notes written with an octave keep it.
 * Without one (the user's own "A | D F A C G E C A"), we infer a plausible instrument: the ding
 * between A2 and G#3 (A → A2, D → D3, E → E3…), then the tone fields as the most compact
 * ascending scale starting at least a minor third above the ding, preferring to begin about a
 * fifth up — so A | D F A C G E C A becomes A2 | D4 F4 A4 C5 G4 E4 C4 A3 (fields A3–C5), and
 * D | A Bb C D E F G A becomes D Kurd (D3 | A3 … A4).
 */
export function handpanMidis(scale: HandpanScale): number[] {
  const known = scale.notes.map((n) => noteMidi(n))
  if (known.every((m) => m != null)) return known as number[]
  const knownTones = known.slice(1).filter((m): m is number => m != null)
  let ding = known[0] ?? DING_FLOOR + mod12(scale.ding.pc - DING_FLOOR)
  if (known[0] == null) while (knownTones.length && ding >= Math.min(...knownTones)) ding -= 12
  const layout = compactLayout(
    scale.tones.map((n) => n.pc),
    ding + 3,
    ding + 7,
  )
  return [ding, ...scale.tones.map((_, i) => known[i + 1] ?? layout[i])]
}

/** The smallest tone field, re the largest. */
export const HANDPAN_MIN_FIELD = 0.55

/**
 * Relative size of every tone field (ding excluded), 1 for the lowest: on a real handpan a field's
 * size goes roughly with 1/√f (a fifth up ≈ 0.82×, an octave ≈ 0.71×), never under HANDPAN_MIN_FIELD.
 */
export function handpanFieldSizes(scale: HandpanScale): number[] {
  const tones = handpanMidis(scale).slice(1)
  const lo = Math.min(...tones)
  return tones.map((m) => Math.max(HANDPAN_MIN_FIELD, Math.pow(2, -(m - lo) / 24)))
}

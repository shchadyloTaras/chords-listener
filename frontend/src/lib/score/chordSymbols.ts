// Chord symbols for the score: the chord sheet's bar slots (displayed labels — transpose, simplify
// and accidentals already applied — on the beat grid), written where the chord changes; and their
// MusicXML <harmony> description.

import type { ChordQuality } from '../../types'
import type { Bar } from '../music/bars'
import { parseChord } from '../music/chord'
import type { Step } from './spelling'
import { DIV, type Measure } from './timeMap'
import type { ChordSymbol } from './types'

/** Chord changes on the measures (a no-chord stretch is written as N.C. when it lasts 2+ beats). */
export function chordSymbolsFromBars(bars: readonly Pick<Bar, 'slots'>[], measures: readonly Measure[]): ChordSymbol[] {
  const out: ChordSymbol[] = []
  let current: string | null = null
  bars.forEach((bar, i) => {
    const m = measures[i]
    if (!m) return
    for (const slot of bar.slots) {
      const label = slot.isNone ? 'N' : slot.label
      if (label === current) continue
      if (label === 'N' && (current === null || slot.span < 2)) continue
      const tick = m.offset + Math.min(m.beats - 1, Math.max(0, slot.beat)) * DIV
      const prev = out[out.length - 1]
      if (prev && prev.tick === tick) prev.label = label
      else out.push({ tick, label })
      current = label
    }
  })
  return out
}

export interface HarmonyXml {
  root: { step: Step; alter: number }
  /** MusicXML kind value */
  kind: string
  /** the kind as displayed */
  text: string
  bass: { step: Step; alter: number } | null
  degrees: { value: number; alter: number; type: 'add' | 'alter' | 'subtract' }[]
}

const KINDS: Record<ChordQuality, { kind: string; text: string; add9?: boolean }> = {
  maj: { kind: 'major', text: '' },
  min: { kind: 'minor', text: 'm' },
  '7': { kind: 'dominant', text: '7' },
  maj7: { kind: 'major-seventh', text: 'maj7' },
  min7: { kind: 'minor-seventh', text: 'm7' },
  dim: { kind: 'diminished', text: 'dim' },
  aug: { kind: 'augmented', text: 'aug' },
  sus2: { kind: 'suspended-second', text: 'sus2' },
  sus4: { kind: 'suspended-fourth', text: 'sus4' },
  dim7: { kind: 'diminished-seventh', text: 'dim7' },
  hdim7: { kind: 'half-diminished', text: 'm7b5' },
  '6': { kind: 'major-sixth', text: '6' },
  min6: { kind: 'minor-sixth', text: 'm6' },
  '9': { kind: 'dominant-ninth', text: '9' },
  // "add9" is written by the <degree> (kind text stays empty, or readers would print it twice)
  add9: { kind: 'major', text: '', add9: true },
}

function noteParts(name: string): { step: Step; alter: number } {
  const step = name[0].toUpperCase() as Step
  let alter = 0
  for (const ch of name.slice(1)) alter += ch === '#' || ch === '♯' ? 1 : ch === 'b' || ch === '♭' ? -1 : 0
  return { step, alter }
}

/** MusicXML harmony of a displayed label; null for "N" (no chord) and unknown labels. */
export function harmonyOf(label: string): HarmonyXml | null {
  const p = parseChord(label)
  if (!p) return null
  const k = KINDS[p.quality]
  return {
    root: noteParts(p.root),
    kind: k.kind,
    text: k.text,
    bass: p.bass ? noteParts(p.bass) : null,
    degrees: k.add9 ? [{ value: 9, alter: 0, type: 'add' }] : [],
  }
}

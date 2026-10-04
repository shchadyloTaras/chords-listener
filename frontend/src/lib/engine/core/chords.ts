// Chord vocabulary and label convention (docs/SPEC.md "Chord label convention"):
// `<root><suffix>[/<bass>]` with sharp spelling, or "N" for no chord.

export const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

const FLAT_TO_SHARP: Record<string, string> = {
  Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C',
}

/** canonical quality -> intervals above the root + label suffix */
export const QUALITIES: Readonly<Record<string, { intervals: readonly number[]; suffix: string }>> = {
  maj: { intervals: [0, 4, 7], suffix: '' },
  min: { intervals: [0, 3, 7], suffix: 'm' },
  '7': { intervals: [0, 4, 7, 10], suffix: '7' },
  maj7: { intervals: [0, 4, 7, 11], suffix: 'maj7' },
  min7: { intervals: [0, 3, 7, 10], suffix: 'm7' },
  dim: { intervals: [0, 3, 6], suffix: 'dim' },
  aug: { intervals: [0, 4, 8], suffix: 'aug' },
  sus2: { intervals: [0, 2, 7], suffix: 'sus2' },
  sus4: { intervals: [0, 5, 7], suffix: 'sus4' },
  dim7: { intervals: [0, 3, 6, 9], suffix: 'dim7' },
  hdim7: { intervals: [0, 3, 6, 10], suffix: 'm7b5' },
  '6': { intervals: [0, 4, 7, 9], suffix: '6' },
  min6: { intervals: [0, 3, 7, 9], suffix: 'm6' },
  '9': { intervals: [0, 2, 4, 7, 10], suffix: '9' },
  add9: { intervals: [0, 2, 4, 7], suffix: 'add9' },
}

/** Qualities this engine emits (a deliberately conservative subset). */
export const ENGINE_QUALITIES = ['maj', 'min', '7', 'maj7', 'min7', 'sus2', 'sus4', 'dim', 'aug'] as const
export type EngineQuality = (typeof ENGINE_QUALITIES)[number]

/** Log-prior per frame relative to the plain triad: users are hurt more by a spurious "Cmaj7" than a missing one. */
export const QUALITY_PRIORS: Readonly<Record<EngineQuality, number>> = {
  maj: 0, min: 0, '7': -1.1, maj7: -1.45, min7: -1.1, sus4: -1.8, sus2: -2.0, dim: -1.8, aug: -2.5,
}

/** maj/min reduction used for evaluation. */
export const MAJMIN_OF: Readonly<Record<string, 'maj' | 'min' | null>> = {
  maj: 'maj', '7': 'maj', maj7: 'maj', '6': 'maj', '9': 'maj', add9: 'maj',
  min: 'min', min7: 'min', min6: 'min',
  dim: null, aug: null, sus2: null, sus4: null, dim7: null, hdim7: null,
}

/** A chord; `root === null` means no chord ("N"). Pitch classes 0 = C. */
export interface Chord {
  root: number | null
  quality: string | null
  /** bass pitch class when it differs from the root */
  bass: number | null
}

export const NO_CHORD: Chord = Object.freeze({ root: null, quality: null, bass: null })

export function pitchClass(name: string): number {
  const n = FLAT_TO_SHARP[name.trim()] ?? name.trim()
  const i = (PITCH_NAMES as readonly string[]).indexOf(n)
  if (i < 0) throw new Error(`unknown note name "${name}"`)
  return i
}

export function formatLabel(root: number | null, quality: string | null, bass: number | null = null): string {
  if (root === null || quality === null) return 'N'
  const q = QUALITIES[quality]
  if (!q) throw new Error(`unknown chord quality "${quality}"`)
  let label = PITCH_NAMES[((root % 12) + 12) % 12] + q.suffix
  if (bass !== null && (bass - root) % 12 !== 0) label += '/' + PITCH_NAMES[((bass % 12) + 12) % 12]
  return label
}

const SUFFIX_TO_QUALITY = Object.entries(QUALITIES)
  .map(([q, { suffix }]) => [suffix, q] as const)
  .sort((a, b) => b[0].length - a[0].length)

/** Parse a label in the SPEC convention (flats accepted). "N" / "X" / "" -> no chord. */
export function parseLabel(label: string): Chord {
  let s = label.trim()
  if (s === '' || s === 'N' || s === 'X') return NO_CHORD
  let bassName: string | null = null
  const slash = s.indexOf('/')
  if (slash >= 0) {
    bassName = s.slice(slash + 1)
    s = s.slice(0, slash)
  }
  const rootLen = s.length > 1 && (s[1] === '#' || s[1] === 'b') ? 2 : 1
  const root = pitchClass(s.slice(0, rootLen))
  const suffix = s.slice(rootLen)
  const hit = SUFFIX_TO_QUALITY.find(([suf]) => suf === suffix)
  if (!hit) throw new Error(`unknown chord suffix "${suffix}" in "${label}"`)
  let bass = bassName ? pitchClass(bassName) : null
  if (bass === root) bass = null
  return { root, quality: hit[1], bass }
}

export function chordPitchClasses(c: Chord): number[] {
  if (c.root === null || c.quality === null) return []
  return QUALITIES[c.quality].intervals.map((i) => (c.root! + i) % 12)
}

export function sameChord(a: Chord, b: Chord): boolean {
  return a.root === b.root && a.quality === b.quality && a.bass === b.bass
}

/** Engine-contract fields of a chord. */
export function chordFields(c: Chord): { label: string; root: string | null; quality: string | null; bass: string | null } {
  if (c.root === null || c.quality === null) return { label: 'N', root: null, quality: null, bass: null }
  return {
    label: formatLabel(c.root, c.quality, c.bass),
    root: PITCH_NAMES[c.root],
    quality: c.quality,
    bass: c.bass !== null && c.bass !== c.root ? PITCH_NAMES[c.bass] : null,
  }
}

/** Binary 12-bin templates (row-major K x 12) of the given chords. */
export function chordTemplates(chords: readonly Chord[]): Uint8Array {
  const M = new Uint8Array(chords.length * 12)
  chords.forEach((c, k) => {
    for (const pc of chordPitchClasses(c)) M[k * 12 + pc] = 1
  })
  return M
}

/**
 * Per-frame log-likelihood of each template under per-pitch-class presence probabilities.
 * prob: (T x 12), M: (K x 12) binary -> (T x K), written into `out` at column offset 0 with row stride `stride`.
 */
export function bernoulliScores(
  prob: Float32Array,
  T: number,
  M: Uint8Array,
  K: number,
  out: Float32Array | Float64Array,
  stride = K,
): void {
  const lp = new Float64Array(12)
  const lq = new Float64Array(12)
  for (let t = 0; t < T; t++) {
    let base = 0
    for (let i = 0; i < 12; i++) {
      const p = Math.min(0.97, Math.max(0.03, prob[t * 12 + i]))
      lp[i] = Math.log(p)
      lq[i] = Math.log(1 - p)
      base += lq[i]
    }
    for (let k = 0; k < K; k++) {
      let s = base
      for (let i = 0; i < 12; i++) if (M[k * 12 + i]) s += lp[i] - lq[i]
      out[t * stride + k] = s
    }
  }
}

/** Map non-negative chroma frames (T x 12) to soft "pitch class is sounding" probabilities. */
export function chromaProbabilities(chroma: Float32Array, T: number): Float32Array {
  const out = new Float32Array(T * 12)
  const sorted = new Float64Array(12)
  for (let t = 0; t < T; t++) {
    let top = 0
    for (let i = 0; i < 12; i++) {
      const v = chroma[t * 12 + i]
      sorted[i] = v
      if (v > top) top = v
    }
    if (top <= 1e-6) {
      out.fill(0.5, t * 12, t * 12 + 12)
      continue
    }
    sorted.sort()
    // adaptive noise floor: only energy above the frame's median counts as evidence
    const floor = 0.5 * (sorted[5] + sorted[6])
    const span = Math.max(top - floor, 1e-9)
    for (let i = 0; i < 12; i++) {
      const rel = Math.min(1, Math.max(0, (chroma[t * 12 + i] - floor) / span))
      out[t * 12 + i] = 1 / (1 + Math.exp(-(rel - 0.22) * 12))
    }
  }
  return out
}

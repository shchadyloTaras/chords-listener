// Circle-of-fifths color index for a chord root (see SPEC "Design direction").
const PITCH: Record<string, number> = {
  C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, 'E#': 5, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11,
}

export function pitchClass(note: string | null | undefined): number | null {
  if (!note) return null
  const pc = PITCH[note]
  return pc === undefined ? null : pc
}

/** 0..11 index into --chord-N (C=0, G=1, D=2 …), honoring transposition; null for "N". */
export function fifthsIndex(root: string | null | undefined, transpose = 0): number | null {
  const pc = pitchClass(root)
  if (pc === null) return null
  const shifted = (((pc + transpose) % 12) + 12) % 12
  return (shifted * 7) % 12
}

export function chordColorVar(root: string | null | undefined, transpose = 0): string {
  const idx = fifthsIndex(root, transpose)
  return idx === null ? 'var(--chord-none)' : `var(--chord-${idx})`
}

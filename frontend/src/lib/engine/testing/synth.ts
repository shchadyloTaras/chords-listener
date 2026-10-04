// Deterministic test signals for the engine's unit tests (not used by the app).

export function midiToHz(m: number): number {
  return 440 * 2 ** ((m - 69) / 12)
}

/** Small deterministic PRNG (mulberry32) so tests never flake. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Add a decaying harmonic tone (piano-like) to `out` starting at `at` seconds. */
export function addTone(out: Float32Array, sr: number, midi: number, at: number, dur: number,
  opts: { amp?: number; partials?: number; decay?: number; cents?: number } = {}): void {
  const { amp = 0.2, partials = 6, decay = 1.2, cents = 0 } = opts
  const f0 = midiToHz(midi + cents / 100)
  const i0 = Math.round(at * sr)
  const n = Math.min(out.length - i0, Math.round(dur * sr))
  const rel = Math.round(0.02 * sr)
  for (let k = 1; k <= partials; k++) {
    const fk = k * f0
    if (fk > 0.45 * sr) break
    const ak = amp / k
    const w = (2 * Math.PI * fk) / sr
    for (let i = 0; i < n; i++) {
      const env = Math.exp(-i / sr / (decay / k ** 0.5)) * Math.min(1, i / (0.004 * sr)) * Math.min(1, (n - i) / rel)
      out[i0 + i] += ak * env * Math.sin(w * i)
    }
  }
}

/** Add a short noise burst (drum-like click) at `at` seconds. */
export function addClick(out: Float32Array, sr: number, at: number, amp = 0.5, random = rng(7)): void {
  const i0 = Math.round(at * sr)
  const n = Math.min(out.length - i0, Math.round(0.03 * sr))
  for (let i = 0; i < n; i++) out[i0 + i] += amp * (2 * random() - 1) * Math.exp(-i / (0.006 * sr))
}

export interface ProgressionChord {
  /** treble notes (MIDI) */
  notes: number[]
  /** bass note (MIDI) */
  bass: number
}

/**
 * A simple song: each chord lasts `beatsPerChord` beats; the chord is restruck on every
 * beat, the bass plays on beats 1 and 3, a click marks every beat.
 */
export function renderProgression(chords: ProgressionChord[], opts: { sr: number; bpm: number; beatsPerChord: number;
  leadIn: number; tail: number }): { audio: Float32Array; beats: number[]; changes: number[]; duration: number } {
  const { sr, bpm, beatsPerChord, leadIn, tail } = opts
  const beat = 60 / bpm
  const duration = leadIn + chords.length * beatsPerChord * beat + tail
  const audio = new Float32Array(Math.round(duration * sr))
  const beats: number[] = []
  const changes: number[] = []
  const random = rng(11)
  chords.forEach((c, ci) => {
    const start = leadIn + ci * beatsPerChord * beat
    changes.push(start)
    for (let b = 0; b < beatsPerChord; b++) {
      const t = start + b * beat
      beats.push(t)
      for (const m of c.notes) addTone(audio, sr, m, t, beat * 0.95, { amp: 0.12 })
      if (b % 2 === 0) addTone(audio, sr, c.bass, t, beat * 1.9, { amp: 0.25, partials: 4, decay: 1.5 })
      addClick(audio, sr, t, b % 2 === 0 ? 0.35 : 0.2, random)
    }
  })
  let peak = 0
  for (const v of audio) peak = Math.max(peak, Math.abs(v))
  for (let i = 0; i < audio.length; i++) audio[i] *= 0.9 / peak
  return { audio, beats, changes, duration }
}

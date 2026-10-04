// Synthetic test music with KNOWN notes for the live-piano transcription (scripts only).
// Piano-like additive tones (inharmonic partials, per-partial decay), a plucked timbre and a
// fast "stress" etude, rendered at 44.1 kHz like a real file.

export interface TruthNote {
  midi: number
  /** seconds */
  start: number
  end: number
  velocity: number
}

export interface Clip {
  name: string
  sampleRate: number
  samples: Float32Array
  notes: TruthNote[]
  duration: number
}

export const SYNTH_RATE = 44100

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hz = (m: number) => 440 * 2 ** ((m - 69) / 12)

type Timbre = 'piano' | 'pluck'

/** Adds one note (sound starts exactly at `start`, damped at `end`). */
function addNote(out: Float32Array, sr: number, n: TruthNote, timbre: Timbre, random: () => number): void {
  const f0 = hz(n.midi)
  const i0 = Math.round(n.start * sr)
  const held = Math.max(1, Math.round((n.end - n.start) * sr))
  const release = Math.round((timbre === 'piano' ? 0.08 : 0.05) * sr)
  const total = Math.min(out.length - i0, held + release)
  const partials = timbre === 'piano' ? 12 : 15
  const tau0 = timbre === 'piano' ? Math.min(4, Math.max(0.35, 1.3 * (261 / f0) ** 0.6)) : Math.min(2.5, Math.max(0.3, (196 / f0) ** 0.5))
  const pluckPos = 0.17 + (random() - 0.5) * 0.06
  const attack = Math.round((timbre === 'piano' ? 0.004 : 0.002) * sr)
  const amp = 0.18 * n.velocity
  for (let k = 1; k <= partials; k++) {
    const inharm = timbre === 'piano' ? 1.2e-4 : 4e-5
    const fk = k * f0 * Math.sqrt(1 + inharm * k * k)
    if (fk > 0.45 * sr) break
    const ak =
      timbre === 'piano'
        ? (1 / k ** 1.1) * (k % 2 === 0 ? 0.8 : 1) * Math.exp((-k * f0) / 6000)
        : Math.abs(Math.sin(Math.PI * k * pluckPos)) / k ** 0.95
    const tau = tau0 / (1 + (timbre === 'piano' ? 0.3 : 0.45) * (k - 1))
    const w = (2 * Math.PI * fk) / sr
    const phase = random() * 2 * Math.PI
    for (let i = 0; i < total; i++) {
      let env = Math.exp(-i / sr / tau)
      if (i < attack) env *= i / attack
      if (i >= held) env *= Math.cos(((i - held) / release) * (Math.PI / 2)) ** 2
      out[i0 + i] += amp * ak * env * Math.sin(w * i + phase)
    }
  }
}

/** Drops notes that would overlap a sounding note of the same pitch (they cannot be told apart). */
function playable(notes: TruthNote[]): TruthNote[] {
  const out: TruthNote[] = []
  for (const n of [...notes].sort((a, b) => a.start - b.start)) {
    if (out.some((o) => o.midi === n.midi && n.start < o.end + 0.02 && o.start < n.end)) continue
    out.push(n)
  }
  return out
}

function render(name: string, input: TruthNote[], timbre: Timbre | ((n: TruthNote) => Timbre), seed: number, noise = 0.002): Clip {
  const random = rng(seed)
  const notes = playable(input)
  const duration = Math.max(...notes.map((n) => n.end)) + 1
  const samples = new Float32Array(Math.ceil(duration * SYNTH_RATE))
  for (const n of notes) addNote(samples, SYNTH_RATE, n, typeof timbre === 'function' ? timbre(n) : timbre, random)
  // a little room tone and a short reverb tail so it is not "too clean"
  const delay = Math.round(0.031 * SYNTH_RATE)
  for (let i = delay; i < samples.length; i++) samples[i] += 0.18 * samples[i - delay]
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    samples[i] += noise * (random() * 2 - 1)
    peak = Math.max(peak, Math.abs(samples[i]))
  }
  for (let i = 0; i < samples.length; i++) samples[i] *= 0.89 / peak
  return { name, sampleRate: SYNTH_RATE, samples, notes: [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi), duration }
}

const TRIADS: Record<string, number[]> = {
  C: [60, 64, 67],
  Am: [57, 60, 64],
  F: [53, 57, 60],
  G: [55, 59, 62],
  Em: [52, 55, 59],
  Dm: [50, 53, 57],
}
const ROOT: Record<string, number> = { C: 36, Am: 45, F: 41, G: 43, Em: 40, Dm: 38 }

/** Piano ballad: bass, block chords on beats 1 and 3, a melody of quarters and eighths. */
function pianoSong(seconds: number, seed: number): Clip {
  const r = rng(seed)
  const bpm = 96
  const beat = 60 / bpm
  const prog = ['C', 'Am', 'F', 'G', 'C', 'Em', 'Dm', 'G']
  const notes: TruthNote[] = []
  const v = (lo: number, hi: number) => +(lo + r() * (hi - lo)).toFixed(2)
  let t = 0.6
  for (let bar = 0; t < seconds - 2; bar++) {
    const ch = prog[bar % prog.length]
    notes.push({ midi: ROOT[ch], start: t, end: t + 4 * beat * 0.95, velocity: v(0.6, 0.9) })
    for (const b of [0, 2]) for (const m of TRIADS[ch]) notes.push({ midi: m, start: t + b * beat, end: t + (b + 1.6) * beat, velocity: v(0.45, 0.75) })
    // melody over chord tones (+ an octave) with passing tones
    let mt = t
    const tones = TRIADS[ch].map((m) => m + 12)
    while (mt < t + 4 * beat - 1e-6) {
      const len = r() < 0.4 ? beat / 2 : beat
      const passing = r() < 0.25
      const m = passing ? tones[Math.floor(r() * 3)] + (r() < 0.5 ? 2 : -1) : tones[Math.floor(r() * 3)] + (r() < 0.3 ? 12 : 0)
      notes.push({ midi: m, start: mt, end: mt + len * 0.9, velocity: v(0.55, 1) })
      mt += len
    }
    t += 4 * beat
  }
  return render('piano-ballad', notes, 'piano', seed)
}

/** Plucked arpeggios (guitar-like): one note every eighth, each ringing on. */
function pluckSong(seconds: number, seed: number): Clip {
  const r = rng(seed)
  const eighth = 60 / 112 / 2
  const prog = ['Am', 'F', 'C', 'G']
  const notes: TruthNote[] = []
  let t = 0.4
  for (let bar = 0; t < seconds - 2; bar++) {
    const ch = prog[bar % prog.length]
    const shape = [ROOT[ch] + 12, ...TRIADS[ch], TRIADS[ch][0] + 12, TRIADS[ch][1], TRIADS[ch][2], TRIADS[ch][0]]
    for (let i = 0; i < 8; i++) {
      notes.push({ midi: shape[i], start: t + i * eighth, end: t + Math.min(8, i + 3) * eighth, velocity: +(0.5 + r() * 0.45).toFixed(2) })
    }
    t += 8 * eighth
  }
  return render('pluck-arpeggio', notes, 'pluck', seed, 0.003)
}

/** Fast and wide: staccato runs over 5 octaves, repeated notes, low bass and high treble. */
function etude(seconds: number, seed: number): Clip {
  const r = rng(seed)
  const notes: TruthNote[] = []
  const step = 0.125
  let t = 0.5
  let i = 0
  while (t < seconds - 1.5) {
    const phase = Math.floor(i / 16) % 3
    let m: number
    if (phase === 0) m = 36 + ((i * 7) % 48) // wide leaps
    else if (phase === 1) m = 72 + (i % 8 < 4 ? 0 : 2) // repeated notes
    else m = 28 + Math.floor(r() * 68) // anywhere from E1 to B6
    const dur = phase === 1 ? 0.1 : 0.11 + r() * 0.2
    notes.push({ midi: m, start: t, end: t + dur, velocity: +(0.5 + r() * 0.5).toFixed(2) })
    if (i % 4 === 0) notes.push({ midi: 33 + (i % 12), start: t, end: t + 0.45, velocity: 0.8 })
    t += step
    i++
  }
  return render('stress-etude', notes, (n) => (n.midi < 45 || n.midi % 2 === 0 ? 'piano' : 'pluck'), seed)
}

/** The evaluation set (about `seconds` per clip). */
export function evaluationClips(seconds = 30): Clip[] {
  return [pianoSong(seconds, 3), pluckSong(Math.round(seconds * 0.7), 5), etude(Math.round(seconds * 0.5), 7)]
}

/** 16-bit PCM mono WAV bytes. */
export function wavBytes(clip: Clip): Uint8Array {
  const n = clip.samples.length
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, clip.sampleRate, true)
  v.setUint32(28, clip.sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(clip.samples[i] * 32767))), true)
  return new Uint8Array(buf)
}

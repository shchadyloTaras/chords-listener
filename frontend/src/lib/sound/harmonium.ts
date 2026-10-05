// Harmonium (pump organ) note: a free-reed tone — one oscillator on a dense, slightly nasal
// PeriodicWave plus a second reed a few cents sharp, the gentle beating of two reed ranks — through
// a soft lowpass, under a bellows envelope: a 40–80 ms swell (slower in the bass), a flat hold with
// a faint tremolo, a 150 ms release. Touch barely matters. The envelope is a precomputed curve
// (setValueCurveAtTime), so nothing runs on the main thread while the note sounds.

import { clamp, midiToFreq } from './dsp'
import { gainNode, type VoiceParts } from './voice'

/** Harmonics in the reed wave (the browser band-limits what lies above Nyquist). */
const REED_HARMONICS = 24
/** The second reed: this many cents sharp, at this level. */
export const CELESTE_CENTS = 4
const CELESTE_LEVEL = 0.45
/** Release after the key comes up, s. */
export const HARMONIUM_RELEASE = 0.15
/** Envelope curve resolution, s. */
export const HARMONIUM_STEP = 0.004
const TREMOLO_RATE = 5
const TREMOLO_DEPTH = 0.02
/** Output level per note (sustained: lower than the piano's 0.2). */
const LEVEL = 0.12

/** Amplitude of harmonic n (1-based) of the reed wave: ~1/n^0.8, even harmonics 30 % weaker. */
export function reedAmplitude(n: number): number {
  return Math.pow(n, -0.8) * (n % 2 === 1 ? 1 : 0.7)
}

/** Fourier coefficients for createPeriodicWave (index 0 = DC, sine terms only). */
export function reedWave(): { real: Float32Array; imag: Float32Array } {
  const real = new Float32Array(REED_HARMONICS + 1)
  const imag = new Float32Array(REED_HARMONICS + 1)
  for (let n = 1; n <= REED_HARMONICS; n++) imag[n] = reedAmplitude(n)
  return { real, imag }
}

/** Bellows swell, s: 80 ms at C2 down to 40 ms from C5 up. */
export function harmoniumAttack(midi: number): number {
  return clamp(0.08 - ((midi - 36) * 0.04) / 36, 0.04, 0.08)
}

/**
 * Gain curve of one note: raised-cosine swell, the hold with a ±2 % tremolo at 5 Hz, a linear
 * release after `hold`. Starts and ends at 0; sampled every HARMONIUM_STEP seconds.
 */
export function harmoniumEnvelope(midi: number, hold: number): Float32Array {
  const attack = harmoniumAttack(midi)
  const n = Math.ceil((hold + HARMONIUM_RELEASE) / HARMONIUM_STEP) + 1
  const curve = new Float32Array(n)
  for (let i = 0; i < n - 1; i++) {
    const t = i * HARMONIUM_STEP
    const swell = t < attack ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attack) : 1
    const release = t > hold ? Math.max(0, 1 - (t - hold) / HARMONIUM_RELEASE) : 1
    const tremolo = 1 + TREMOLO_DEPTH * Math.sin(2 * Math.PI * TREMOLO_RATE * t)
    curve[i] = swell * release * tremolo
  }
  return curve
}

const waves = new WeakMap<BaseAudioContext, PeriodicWave>()

function reed(ctx: BaseAudioContext): PeriodicWave {
  let wave = waves.get(ctx)
  if (!wave) {
    const { real, imag } = reedWave()
    wave = ctx.createPeriodicWave(real, imag)
    waves.set(ctx, wave)
  }
  return wave
}

/** Schedules one harmonium note at context time `when`; the key stays down `hold` seconds. */
export function startHarmoniumNote(ctx: BaseAudioContext, when: number, midi: number, velocity: number, hold: number): VoiceParts {
  const nodes: AudioNode[] = []
  const sources: AudioScheduledSourceNode[] = []
  const level = LEVEL * (0.85 + 0.15 * clamp(velocity, 0, 1))
  const out = gainNode(ctx, level, nodes)
  const env = gainNode(ctx, 0, nodes)
  const curve = harmoniumEnvelope(midi, hold)
  const duration = (curve.length - 1) * HARMONIUM_STEP
  env.gain.setValueCurveAtTime(curve, when, duration)
  const f0 = midiToFreq(midi)
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = clamp(f0 * 12, 2000, 6000)
  filter.Q.value = 0.5
  nodes.push(filter)
  filter.connect(env)
  env.connect(out)
  const end = when + duration + 0.01
  const wave = reed(ctx)
  for (const [cents, gain] of [
    [0, 1],
    [CELESTE_CENTS, CELESTE_LEVEL],
  ] as const) {
    const osc = ctx.createOscillator()
    osc.setPeriodicWave(wave)
    osc.frequency.value = f0 * Math.pow(2, cents / 1200)
    const g = gainNode(ctx, gain, nodes)
    osc.connect(g)
    g.connect(filter)
    osc.start(when)
    osc.stop(end)
    nodes.push(osc)
    sources.push(osc)
  }
  return { out, level, sources, nodes, end, release: hold }
}

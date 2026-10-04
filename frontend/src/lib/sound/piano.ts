// Soft acoustic piano, additive: per note 8 slightly inharmonic partials (sine oscillators), each
// with the piano's double decay — a fast "prompt" drop, then a long aftersound (longer for low
// notes, shorter for the upper partials) — a short hammer-noise thump on the attack, the key held
// for `hold` seconds and then damped. Envelopes are precomputed curves (setValueCurveAtTime), so
// nothing runs on the main thread while the note sounds.

import { clamp, midiToFreq } from './dsp'
import { gainNode, type VoiceParts } from './voice'

export interface PianoPartial {
  freq: number
  amp: number
  /** prompt-sound decay time constant, s */
  fast: number
  /** aftersound decay time constant, s */
  slow: number
  /** share of the prompt sound in the initial amplitude, 0..1 */
  mix: number
}

const PARTIALS = 8
/** Linear attack of every partial, s. */
const ATTACK = 0.004
/** Envelope curve resolution, s. */
const STEP = 0.004

/**
 * Relative partial amplitudes at a moderate touch: low notes have a weak fundamental and a rich
 * 2nd–4th partial, the middle a classic 1/n-ish fall (7th dipped by the hammer position), the top a
 * nearly pure tone. Interpolated by MIDI note.
 */
const SPECTRA: readonly { midi: number; amps: readonly number[] }[] = [
  { midi: 36, amps: [0.62, 0.85, 0.6, 0.42, 0.3, 0.2, 0.13, 0.1] },
  { midi: 60, amps: [1, 0.56, 0.36, 0.22, 0.16, 0.09, 0.05, 0.05] },
  { midi: 84, amps: [1, 0.36, 0.13, 0.06, 0.03, 0.015, 0.008, 0.004] },
]

function spectrum(midi: number, n: number): number {
  const m = clamp(midi, SPECTRA[0].midi, SPECTRA[SPECTRA.length - 1].midi)
  for (let i = 0; i < SPECTRA.length - 1; i++) {
    const a = SPECTRA[i]
    const b = SPECTRA[i + 1]
    if (m <= b.midi) {
      const x = (m - a.midi) / (b.midi - a.midi)
      return a.amps[n] + (b.amps[n] - a.amps[n]) * x
    }
  }
  return SPECTRA[SPECTRA.length - 1].amps[n]
}

/** String stiffness: partial n sits at n·f0·√(1 + B·n²); B grows towards the treble. */
export function inharmonicity(midi: number): number {
  return 0.00004 * Math.exp(0.05 * (midi - 21))
}

/** Damper time constant after the key is released, s (bass dampers are slower). */
export function damperTime(midi: number): number {
  return 0.16 * Math.pow(2, -(midi - 36) / 40)
}

/** The partials of one note for a touch `velocity` (0..1); partials above `maxFreq` are dropped. */
export function pianoPartials(midi: number, velocity: number, maxFreq: number): PianoPartial[] {
  const f0 = midiToFreq(midi)
  const b = inharmonicity(midi)
  const v = clamp(velocity, 0.05, 1)
  // a soft touch is darker: upper partials lose more
  const bright = 0.45 + 0.55 * v
  const fast = 0.5 * Math.pow(2, -(midi - 36) / 30)
  const slow = 5.5 * Math.pow(2, -(midi - 36) / 24)
  const out: PianoPartial[] = []
  for (let i = 0; i < PARTIALS; i++) {
    const n = i + 1
    const freq = n * f0 * Math.sqrt(1 + b * n * n)
    if (freq > maxFreq) break
    out.push({
      freq,
      amp: spectrum(midi, i) * Math.pow(bright, i * 0.55),
      fast: fast / (1 + 0.3 * i),
      slow: slow / (1 + 0.45 * i),
      mix: Math.min(0.9, 0.62 + 0.04 * i),
    })
  }
  return out
}

/**
 * Gain curve of one partial: 4 ms attack, double decay, the damper after `hold`. Starts and ends
 * at 0; sampled every STEP seconds, so it lasts `(length − 1) · STEP`.
 */
export function pianoEnvelope(p: PianoPartial, hold: number, damp: number): Float32Array {
  const total = hold + damp * 6
  const n = Math.ceil(total / STEP) + 1
  const curve = new Float32Array(n)
  for (let i = 0; i < n - 1; i++) {
    const t = i * STEP
    let e = p.mix * Math.exp(-t / p.fast) + (1 - p.mix) * Math.exp(-t / p.slow)
    if (t > hold) e *= Math.exp(-(t - hold) / damp)
    curve[i] = p.amp * Math.min(1, t / ATTACK) * e
  }
  return curve
}

/** Output level per note before velocity (a five-note chord peaks well below full scale). */
const LEVEL = 0.2

/**
 * Schedules one piano note at context time `when`. `hold` = seconds the key stays down; the
 * returned `release` is that moment. `noise` is a shared white-noise buffer for the hammer.
 */
export function startPianoNote(
  ctx: BaseAudioContext,
  when: number,
  midi: number,
  velocity: number,
  hold: number,
  noise: AudioBuffer | null,
): VoiceParts {
  const nodes: AudioNode[] = []
  const sources: AudioScheduledSourceNode[] = []
  const v = clamp(velocity, 0.05, 1)
  const level = LEVEL * Math.pow(v, 1.5)
  const out = gainNode(ctx, level, nodes)
  const damp = damperTime(midi)
  const partials = pianoPartials(midi, v, Math.min(12000, ctx.sampleRate * 0.45))
  let end = when
  for (const p of partials) {
    const curve = pianoEnvelope(p, hold, damp)
    const duration = (curve.length - 1) * STEP
    const osc = ctx.createOscillator()
    osc.frequency.value = p.freq
    const g = gainNode(ctx, 0, nodes)
    g.gain.setValueCurveAtTime(curve, when, duration)
    osc.connect(g)
    g.connect(out)
    osc.start(when)
    osc.stop(when + duration + 0.01)
    end = Math.max(end, when + duration + 0.01)
    nodes.push(osc)
    sources.push(osc)
  }

  // Hammer: a 10 ms band of noise (brighter for higher notes), a touch stronger when played harder.
  if (noise) {
    const src = ctx.createBufferSource()
    src.buffer = noise
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = clamp(midiToFreq(midi) * 3.5, 900, 5200)
    band.Q.value = 0.8
    const g = gainNode(ctx, 0, nodes)
    const peak = 0.32 * (0.5 + 0.5 * v)
    g.gain.setValueAtTime(0, when)
    g.gain.linearRampToValueAtTime(peak, when + 0.0012)
    g.gain.setTargetAtTime(0, when + 0.0012, 0.006 + 0.006 * clamp((60 - midi) / 24, 0, 1))
    src.connect(band)
    band.connect(g)
    g.connect(out)
    // a different slice of the noise for every note
    const offset = ((midi * 0.0371) % 1) * Math.max(0, noise.duration - 0.1)
    src.start(when, offset)
    src.stop(when + 0.08)
    nodes.push(src, band)
    sources.push(src)
  }
  return { out, level, sources, nodes, end, release: hold }
}

// Handpan note: the tuned fundamental, octave and compound fifth (3×f0) of a tone field, each a pair
// of sines a fraction of a hertz apart (the gentle beating of a real field), a soft ~8 ms hand
// strike, a long ring (~2.5–4 s to −30 dB, longer for low notes) and a subtle low "thump" of the
// shell's air resonance plus a whisper of skin contact.

import { clamp, midiToFreq } from './dsp'
import { gainNode, type VoiceParts } from './voice'

export interface HandpanPartial {
  /** multiple of the fundamental */
  ratio: number
  amp: number
  /** decay time constant, s */
  tau: number
  /** beat rate between the two sines, Hz */
  beat: number
  /** share of the weaker of the two sines (beat depth: 0.14 ≈ ±1.5 dB) */
  split: number
  /** rise time, s (the octave blooms a little later) */
  attack: number
}

/** Fundamental decay time constant, s: ~1.15 s for low notes down to ~0.75 s at the top. */
export function handpanDecay(midi: number): number {
  return clamp(1.15 - (midi - 50) * 0.0148, 0.75, 1.15)
}

export function handpanPartials(midi: number): HandpanPartial[] {
  const tau = handpanDecay(midi)
  return [
    { ratio: 1, amp: 1, tau, beat: 0.55, split: 0.14, attack: 0.008 },
    { ratio: 2, amp: 0.42, tau: tau * 0.62, beat: 0.9, split: 0.22, attack: 0.022 },
    { ratio: 3, amp: 0.2, tau: tau * 0.42, beat: 1.3, split: 0.28, attack: 0.012 },
  ]
}

/** When the note has faded to −30 dB (its live note's end), s after the strike. */
export function handpanRelease(midi: number): number {
  return handpanDecay(midi) * Math.log(Math.pow(10, 30 / 20))
}

const LEVEL = 0.3

export function startHandpanNote(
  ctx: BaseAudioContext,
  when: number,
  midi: number,
  velocity: number,
  noise: AudioBuffer | null,
): VoiceParts {
  const nodes: AudioNode[] = []
  const sources: AudioScheduledSourceNode[] = []
  const v = clamp(velocity, 0.05, 1)
  const level = LEVEL * Math.pow(v, 1.2)
  const out = gainNode(ctx, level, nodes)
  const f0 = midiToFreq(midi)
  const tau = handpanDecay(midi)
  const stop = when + tau * 7
  const maxFreq = ctx.sampleRate * 0.45

  for (const p of handpanPartials(midi)) {
    const f = f0 * p.ratio
    if (f + p.beat > maxFreq) continue
    // two close modes per field: unequal weights, so the beating is gentle, never a full cancel
    for (const [df, weight] of [
      [-p.beat / 2, 1 - p.split],
      [p.beat / 2, p.split],
    ] as const) {
      const osc = ctx.createOscillator()
      osc.frequency.value = f + df
      const g = gainNode(ctx, 0, nodes)
      g.gain.setValueAtTime(0, when)
      g.gain.linearRampToValueAtTime(p.amp * weight, when + p.attack)
      g.gain.setTargetAtTime(0, when + p.attack, p.tau)
      osc.connect(g)
      g.connect(out)
      osc.start(when)
      osc.stop(stop)
      nodes.push(osc)
      sources.push(osc)
    }
  }

  // The shell's air resonance: a short low sine that sags in pitch.
  const thump = ctx.createOscillator()
  thump.frequency.setValueAtTime(92, when)
  thump.frequency.exponentialRampToValueAtTime(58, when + 0.12)
  const tg = gainNode(ctx, 0, nodes)
  tg.gain.setValueAtTime(0, when)
  tg.gain.linearRampToValueAtTime(0.42 * v, when + 0.005)
  tg.gain.setTargetAtTime(0, when + 0.005, 0.038)
  thump.connect(tg)
  tg.connect(out)
  thump.start(when)
  thump.stop(when + 0.35)
  nodes.push(thump)
  sources.push(thump)

  // Skin on steel: a few milliseconds of soft, dark noise.
  if (noise) {
    const src = ctx.createBufferSource()
    src.buffer = noise
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1800
    const ng = gainNode(ctx, 0, nodes)
    ng.gain.setValueAtTime(0, when)
    ng.gain.linearRampToValueAtTime(0.06 * v, when + 0.002)
    ng.gain.setTargetAtTime(0, when + 0.002, 0.01)
    src.connect(lp)
    lp.connect(ng)
    ng.connect(out)
    src.start(when, ((midi * 0.0529) % 1) * Math.max(0, noise.duration - 0.1))
    src.stop(when + 0.08)
    nodes.push(src, lp)
    sources.push(src)
  }
  return { out, level, sources, nodes, end: stop, release: handpanRelease(midi) }
}

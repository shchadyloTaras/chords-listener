// Handpan note, rebuilt from recordings of a real one: Freesound pack #33041 "HandPan 1st model" by
// GAMEDRIX974 (CC0) — a D minor handpan, every field struck once by hand and left to ring (dry, ~-12
// dBFS). Each note was taken apart into its modes (subband ESPRIT from 4 ms after the strike: the
// frequency, decay, level and phase of every component down to ~40 dB under the strongest); its 24
// strongest are kept here and resynthesized, transposed to the wanted pitch from the nearest
// recorded field. What the analysis found, and what this voice reproduces:
//  - every tuned partial — the fundamental, the octave, the compound fifth (3×f0), a weak double
//    octave — is two to four modes a few hertz apart (the field's split modes), so each beats and
//    shimmers at 1–8 Hz and decays in more than one stage (T60 0.3–6 s);
//  - the octave starts ~15–25 dB under the fundamental and blooms within ~100 ms (two of its modes
//    start in opposite phase), then outlives it: the late sound is the octave;
//  - the steel's own untuned modes ring with every note, mostly in the first few hundred ms: around
//    0.71, 0.84, 0.86–0.96, 1.03–1.2 and 1.35 × f0, 10–25 dB down — the metallic "clang" of the strike;
//  - the ding (D3) has its own, richer set: a strong compound fifth and double octave and a hard,
//    short ring at ~1.16 × f0; it voices every ding, the tone fields voice the other notes;
//  - the strike: a skin-soft thump, ~3 ms, nearly all under 1 kHz (re 250 Hz: −20 dB at 2 kHz, −37 dB
//    at 8 kHz), its energy over the first 20 ms ~13 dB under the note's; the modes rise within ~1 ms;
//  - left out: the recording's other fields ringing in sympathy (they belong to that instrument's
//    scale, not to the one being played).
// Checked against E. Alon, "Analysis and Synthesis of the Handpan Sound" (MSc, University of York,
// 2015; four handpans, three makers): T60 of the three strongest modes 0.9–5.9 s (mean 2.9 s), shorter
// for higher fields; beat rates 3–9 Hz, from coupled, slightly mistuned modes.
// Rendered offline into a Float32Array once per (key, ding or field, sample rate) — the engine caches it.

import { midiToFreq, mulberry32 } from './dsp'

/** One measured mode: frequency re the field's pitch, level (dB re the strongest mode), T60 (s), phase at the strike (rad). */
export type HandpanMode = readonly [ratio: number, db: number, t60: number, phase: number]

export interface HandpanField {
  /** the recorded field's pitch */
  midi: number
  modes: readonly HandpanMode[]
}

/** The ding (D3): every ding is voiced from it. */
export const HANDPAN_DING: HandpanField = {
  midi: 50, // D3, sound 05.wav
  modes: [
    [0.7479, -25.2, 2.36, -2.44], [0.7553, -22, 0.7, -1.06], [0.8019, -24.7, 0.93, -0.97], [0.8097, -13, 0.26, 2.12],
    [0.9807, -0.6, 1.06, 2.18], [1, 0, 3.19, 0.14], [1.0178, -9.6, 2.47, -0.35], [1.0312, -12.2, 1.68, 0.13],
    [1.1638, -2.7, 0.33, -2.68], [1.2005, -12.1, 0.85, 0.85], [1.3603, -19.5, 0.51, -2.03], [1.4645, -17.6, 0.27, -1.69],
    [1.5352, -17.5, 0.37, -2.32], [1.6085, -20.6, 0.47, -2.09], [1.9835, -11.5, 3.68, 1.49], [1.9953, -2.4, 2.83, -0.87],
    [2.0026, -3.5, 0.98, 2.74], [2.0272, -18.5, 0.91, 2.67], [2.9867, -9.9, 1.66, 1.39], [2.992, -10.2, 4.85, -2.23],
    [3.0004, -19.3, 4.92, 2.21], [3.974, -18.2, 0.25, 0.57], [3.9867, -16.1, 4.18, 3.04], [3.9904, -15.2, 1.71, -0.55],
  ],
}

/** The tone fields, E3–A5: a note is voiced from the nearest one in pitch. */
export const HANDPAN_FIELDS: readonly HandpanField[] = [
  {
    midi: 52, // E3, sound 08.wav
    modes: [
      [0.7728, -28.3, 0.37, -2.8], [0.9737, -12.2, 1.26, 1.67], [0.9882, -17.9, 2.76, 0.78], [1, -0.9, 1.46, 1.01],
      [1.0278, 0, 0.31, -1.88], [1.1765, -26.2, 0.6, 2.42], [1.2454, -18.9, 0.28, -1.62], [1.3636, -25.1, 0.53, -2.14],
      [1.8107, -32.5, 0.64, 3.08], [1.833, -31.6, 0.3, -2.25], [1.9886, -17.1, 2.72, 0.85], [1.998, -13, 2.19, 0.61],
      [2.0017, -6.8, 1.9, -2.61], [2.007, -27.4, 1.96, -0.6], [2.188, -34.6, 0.73, 2.62], [2.2987, -32.8, 0.38, 2.12],
      [2.3182, -29.9, 0.33, 2.3], [2.9868, -26.4, 1.32, 2.29], [2.9979, -19.5, 3.5, -1.33], [3.0008, -20.5, 1.37, 2.1],
      [3.0075, -28.3, 4.25, 1.5], [3.993, -22.8, 1.16, -0.73], [3.9968, -24.5, 3.21, 1.94], [4.0039, -33.4, 1.03, -2.6],
    ],
  },
  {
    midi: 53, // F3, sound 04.wav
    modes: [
      [0.7282, -30.2, 0.32, 2.17], [0.8883, -28.2, 4.21, -2.73], [0.9681, 0, 0.26, 1.88], [1, -0.2, 3.02, -1.13],
      [1.0078, -8.8, 2.81, -0.34], [1.0577, -14.7, 2.72, -0.55], [1.145, -35.5, 2.29, -2.08], [1.1961, -32.7, 1.77, -2.25],
      [1.235, -17.8, 0.32, -2.54], [1.2804, -20.1, 0.25, -2.87], [1.3282, -29.5, 4, -1.31], [1.354, -25.4, 0.45, -2.05],
      [1.4402, -29.6, 0.66, -2.1], [1.5178, -22.1, 0.32, 2.68], [1.7038, -26.6, 0.35, -2.87], [1.9862, -25, 3.7, 2.09],
      [1.9988, -15.5, 3.49, -2.61], [2.0059, -17.3, 3.66, 0.84], [2.0348, -19.3, 0.86, -1], [2.9859, -23.5, 0.98, -1.47],
      [2.9939, -20.9, 5.32, 1.32], [2.9992, -29.8, 2.99, 1.57], [3.0065, -35.1, 3.2, -2.19], [4.0135, -34.9, 2.9, -1.96],
    ],
  },
  {
    midi: 55, // G3, sound 09.wav
    modes: [
      [0.8592, -4.9, 0.63, -2.51], [0.8618, -20.7, 1.85, -0.9], [0.877, -0.7, 0.68, 1.16], [0.9451, -11.8, 0.76, 1.49],
      [0.9897, -8.5, 1.56, -0.09], [1, 0, 2.56, -0.7], [1.0308, -7.9, 0.53, -2.18], [1.1434, -10.7, 0.42, -2.76],
      [1.347, -9.7, 0.38, 2.49], [1.3657, -30, 1.89, -2.06], [1.5094, -28.2, 1.03, 0.65], [1.5186, -17.4, 0.47, 2.47],
      [1.6176, -25.8, 0.41, 2.39], [1.9904, -23.5, 2.63, -2.82], [1.9936, -16.8, 3.18, 1.42], [1.9975, -15.1, 1.63, 0],
      [2.0087, -24.3, 1.23, -2.28], [2.9773, -34.8, 3.27, 1.18], [2.9837, -22.9, 5.53, 2.64], [2.986, -21.5, 1.39, 0.91],
      [2.9948, -22.6, 1.79, -1.57], [3.9869, -27.6, 2.1, 2.22], [3.9942, -22.1, 0.68, -0.47], [4.0022, -29.7, 4.09, 3.02],
    ],
  },
  {
    midi: 57, // A3, sound 03.wav
    modes: [
      [0.5081, -35.3, 1.05, -1.49], [0.7798, -16.5, 0.39, 0.37], [0.8408, -21.7, 0.42, 0.87], [1, 0, 1.01, -0.07],
      [1.0031, -12.3, 4.29, -2.42], [1.0057, -10.5, 3.59, -1.67], [1.0358, -8.5, 0.41, -2.86], [1.066, -22.4, 1.73, -3.08],
      [1.0788, -15.9, 0.54, -2.34], [1.1361, -16.9, 0.29, 2.85], [1.2341, -28.4, 0.56, 2.71], [1.2646, -26, 2.16, -2.01],
      [1.2701, -25.3, 0.34, 1.75], [1.2962, -28.4, 0.48, -2.76], [1.3539, -34.9, 1.12, -0.6], [1.5328, -33.6, 0.78, 2.17],
      [1.651, -34.9, 1.08, 1.94], [1.6588, -34.2, 0.75, -2.68], [2.0069, -29.1, 2.42, -2.73], [2.0105, -23, 4.19, 0.31],
      [2.0168, -30.6, 5.36, 2.68], [3.0025, -22.5, 1.89, -1.63], [3.0091, -25.3, 3.28, 0.81], [3.0134, -29.5, 2.16, 2.79],
    ],
  },
  {
    midi: 62, // D4, sound 14.wav
    modes: [
      [0.7924, -24.7, 3.53, 2.27], [0.7956, -26.5, 4.27, 1.24], [0.8081, -21.7, 0.67, 0.62], [0.9026, -12.6, 0.35, -0.62],
      [0.9195, -17.8, 0.82, -0.7], [0.9456, -17.4, 0.55, 0.17], [0.9887, -10.8, 1.14, -1.05], [1, 0, 2.63, -2.15],
      [1.0051, -12.9, 3.19, -0.51], [1.0078, -9.1, 2.29, 2.73], [1.0544, -24.4, 3.41, -2.88], [1.0603, -23.5, 3.14, -1.63],
      [1.0657, -15.7, 1.07, 2.32], [1.0746, -23.6, 1.44, 2.24], [1.203, -14.8, 0.18, 2.04], [1.9995, -17.6, 3.14, 1.55],
      [2.0045, -14.7, 6.33, 0.16], [2.005, -5.6, 1.86, -0.97], [2.0108, -4.5, 0.44, 2.75], [3.0006, -29.2, 3.03, 1.95],
      [3.0058, -19.2, 2.62, -2.36], [3.0077, -22.2, 3.98, 0.46], [3.0102, -28.8, 1.71, -0.08], [4.0119, -32.9, 1.91, -2.93],
    ],
  },
  {
    midi: 64, // E4, sound 17.wav
    modes: [
      [0.827, -27, 1.44, 0.01], [0.84, -13.5, 0.48, -0.23], [0.8417, -23.7, 1.01, 2.31], [0.923, -13.1, 0.43, -1.25],
      [0.9468, -14.3, 2.4, 1.09], [0.9517, -7.6, 0.38, -0.8], [0.9564, -19.8, 1.18, 2.75], [0.9957, 0, 0.87, -1.5],
      [1, -1.4, 2.71, -2.34], [1.0058, -10.1, 1.84, 1.36], [1.0138, -3.3, 0.35, 1.92], [1.1047, -21.7, 0.45, 1.78],
      [1.1241, -30.3, 4.31, -2.94], [1.1315, -22.4, 1.75, -2.3], [1.145, -18.4, 0.49, 1.92], [1.4967, -19.5, 0.26, 1.63],
      [2.0003, -18.3, 1.38, 0.88], [2.0053, -14.8, 1.66, 0.67], [2.0077, -9.6, 3.28, -2.29], [2.0124, -28.6, 2.25, 1.61],
      [3.0096, -27.5, 1.99, -0.67], [3.0198, -15.6, 4.04, 0.77], [3.0244, -16.6, 0.98, -2.57], [4.0119, -37.3, 2.74, -0.27],
    ],
  },
  {
    midi: 65, // F4, sound 13.wav
    modes: [
      [0.3209, -17.9, 0.37, 0.15], [0.3333, -28.5, 2.69, -3.09], [0.7049, -14.2, 2.32, 2.01], [0.7072, -14.5, 0.33, -0.82],
      [0.7322, -17.4, 0.42, -0.02], [0.8572, -17.3, 0.42, -2.07], [0.8837, -24.6, 3.43, -0.24], [0.889, -15.7, 2.04, 0.52],
      [0.8931, -18.2, 1.4, -0.1], [0.9857, -8, 0.84, -2.43], [0.9932, -2.9, 3.15, -2.02], [1, 0, 2.64, -1.75],
      [1.0163, -0.4, 0.31, 1.62], [1.0609, -23.3, 0.93, -3.08], [1.0789, -17.7, 0.56, 2.21], [1.0914, -22.7, 0.77, 1.71],
      [1.1716, -19.5, 0.34, 2.1], [1.9927, -7.2, 4.91, -1.17], [1.9938, -12.3, 1.04, 2.08], [2.004, -14.4, 0.9, 2.59],
      [2.6712, -29.1, 3.64, -0.9], [2.9905, -14.8, 0.6, -0.65], [2.9949, -16.4, 3.9, 2.21], [2.9964, -24.8, 6.17, -1.75],
    ],
  },
  {
    midi: 67, // G4, sound 18.wav
    modes: [
      [0.7057, -19.6, 2.05, 1.87], [0.7254, -18.5, 0.26, -0.41], [0.8516, -20.7, 0.58, -1.14], [0.9095, -14.5, 0.66, -0.56],
      [0.9347, -18, 0.68, -1.57], [0.9582, -11.3, 0.6, -0.69], [0.9736, -8.6, 0.63, -1.13], [0.9948, -6.9, 2.8, -2.62],
      [1, -0.6, 1.49, -1.53], [1.0068, 0, 0.39, 2.11], [1.0348, -19.1, 0.77, -1.51], [1.04, -3.9, 0.28, 1.89],
      [1.0567, -11.8, 0.5, -2.09], [1.1521, -22.6, 0.3, 2.43], [1.1895, -25.6, 1.02, -0.06], [1.1942, -22.2, 1.69, 0.49],
      [1.2033, -15.3, 0.39, 3], [1.993, -30.5, 6.46, 0.74], [1.9951, -8.2, 5.49, -0.05], [1.9961, -7.1, 2.46, -2.69],
      [2.0071, -15.8, 0.94, 2.55], [2.9935, -20.8, 0.97, -1.44], [2.9984, -18.2, 2.2, -0.29], [3.0005, -18.9, 2.53, 2.83],
    ],
  },
  {
    midi: 69, // A4, sound 12.wav
    modes: [
      [0.5319, -32.3, 2.3, 2.79], [0.7089, -20.7, 1.74, 2.32], [0.7113, -21.8, 1.21, 0.38], [0.7279, -18.1, 0.27, -0.78],
      [0.8387, -28.3, 1.78, 1.08], [0.8434, -12.4, 2.05, 0.41], [0.8502, -12.5, 0.19, -2.16], [0.9142, -19.5, 0.47, -1.17],
      [0.9362, -17.2, 0.56, -1.48], [1, -0.6, 2.44, -2.63], [1.004, -0.7, 1.15, -0.69], [1.0089, 0, 1.11, 2.72],
      [1.0193, -9.2, 0.88, 1.34], [1.044, -27.7, 1.34, -2.69], [1.0478, -11.2, 0.4, 1.33], [1.0664, -15.6, 0.47, -3.04],
      [1.1042, -14.2, 0.22, 2.01], [1.2133, -22.3, 0.48, 2.4], [2.0065, -12.2, 4.64, -0.87], [2.007, -10.3, 4.13, 2.84],
      [2.009, -21.9, 1.93, 1.21], [2.0208, -20.9, 0.67, 1.22], [3.0128, -30.1, 1.2, -1.3], [3.0168, -29.4, 2.82, 0.34],
    ],
  },
  {
    midi: 72, // C5, sound 16.wav
    modes: [
      [0.3296, -24.5, 0.46, -2.33], [0.7028, -23.5, 1.6, 1.71], [0.8803, -24.4, 2.82, 0.78], [0.8856, -20.3, 2.08, 1.13],
      [0.8924, -27.8, 1.27, -1.69], [0.9013, -18.3, 0.4, -1.01], [0.9295, -15.3, 0.45, -1.5], [0.9517, -19.8, 0.45, -0.49],
      [0.9906, -8.5, 2.92, -1.76], [0.996, -4.2, 0.79, -0.05], [1, 0, 0.86, 2.96], [1.0028, -13.4, 0.97, -1.58],
      [1.0399, -16.2, 0.38, 2.19], [1.0567, -24.5, 0.8, -2.6], [1.0734, -28.2, 0.83, 2.62], [1.0972, -20.9, 0.29, 2.07],
      [1.1906, -27.7, 1.34, -0.8], [1.9828, -28.4, 1.02, 0.35], [1.9869, -16.4, 3.57, -0.84], [1.9879, -22.8, 4.31, 3.1],
      [1.999, -21.7, 0.65, 2.54], [2.6632, -26.6, 0.81, -0.61], [2.6637, -29.3, 3.22, 2.16], [2.9864, -34.3, 2.8, 1.94],
    ],
  },
  {
    midi: 81, // A5, sound 15.wav
    modes: [
      [0.7056, -17, 1.14, 1.76], [0.8351, -14.8, 0.79, 1.49], [0.8363, -24.4, 1.92, 2.91], [0.8389, -13.8, 1.53, -0.16],
      [0.8437, -19.6, 1.21, -0.94], [0.8841, -19.6, 1.54, 0.2], [0.9268, -18.6, 0.4, -0.7], [0.9341, -14.4, 0.48, -1.57],
      [0.9579, -11.2, 0.38, -1.09], [0.9744, -16, 0.77, -1.3], [0.9883, -12.3, 0.79, -2.33], [0.9941, -2, 1.3, -2.26],
      [1, 0, 1.09, -1.31], [1.0053, 0, 0.52, 2.27], [1.0343, -19.3, 0.73, 2.32], [1.0453, -21.9, 0.7, 1.15],
      [1.1, -20, 0.41, 1.96], [1.682, -24.1, 1.78, -2.77], [1.994, -4.7, 1.58, -1.01], [1.9949, -6.9, 3.05, 0.75],
      [1.9964, -5.5, 1.16, 2.93], [1.9992, -10, 0.44, -2.91], [2.9967, -16.3, 0.99, -2.64], [2.9997, -21, 2.13, 0.6],
    ],
  },
]

/** Decay change when a field is transposed: T60 × 2^(−DECAY_SLOPE) per octave up (smaller fields ring shorter). */
const DECAY_SLOPE = 0.3
/** RMS of a rendered note over its first STEADY_WINDOW seconds (before the engine's level). */
export const HANDPAN_RMS = 0.12
const STEADY_WINDOW = 0.3
/** The modes rise over this long as the hand lands (s). */
const RISE = 0.001
/** The strike: noise energy over its first 20 ms re the note's (dB), its decay (s), its band (Hz). */
const STRIKE_DB = -13
const STRIKE_DECAY = 0.003
const STRIKE_LOW = 50
const STRIKE_DARK = 300
const STRIKE_DARKER = 1500
/** A mode stops once this far under the note's RMS; the note is never longer than HANDPAN_MAX (s). */
const SILENCE = 1e-4
export const HANDPAN_MAX = 6
/** The live note ends when the note has faded this far (dB) from its first STEADY_WINDOW. */
const RELEASE_DB = -30

export interface HandpanParams {
  sampleRate: number
  midi: number
  /** the ding (the big centre field) rather than a tone field */
  ding: boolean
  seed: number
}

export function handpanParams(midi: number, ding: boolean, sampleRate: number): HandpanParams {
  return { sampleRate, midi, ding, seed: 9157 + midi * 211 + (ding ? 1 : 0) }
}

/** The recorded field a note is voiced from: the ding for a ding, else the tone field nearest in pitch. */
export function handpanSource(midi: number, ding: boolean): HandpanField {
  if (ding) return HANDPAN_DING
  let best = HANDPAN_FIELDS[0]
  for (const f of HANDPAN_FIELDS) if (Math.abs(f.midi - midi) < Math.abs(best.midi - midi)) best = f
  return best
}

export interface HandpanComponent {
  freq: number
  /** amplitude re the strongest mode */
  amp: number
  /** amplitude time constant, s */
  tau: number
  phase: number
}

/** The modes of a note at `midi`: its source field's, transposed (frequencies and decays). */
export function handpanModes(midi: number, ding: boolean): HandpanComponent[] {
  const src = handpanSource(midi, ding)
  const f0 = midiToFreq(midi)
  const decay = Math.pow(2, (-DECAY_SLOPE * (midi - src.midi)) / 12)
  return src.modes.map(([ratio, db, t60, phase]) => ({
    freq: f0 * ratio,
    amp: Math.pow(10, db / 20),
    tau: (t60 / Math.log(1000)) * decay,
    phase,
  }))
}

/** Power of the modes at time t (s), beats averaged out. */
function power(modes: readonly HandpanComponent[], t: number): number {
  let p = 0
  for (const m of modes) p += (m.amp * m.amp * Math.exp((-2 * t) / m.tau)) / 2
  return p
}

/** Mean power of the modes over [0, w] s. */
function meanPower(modes: readonly HandpanComponent[], w: number): number {
  let p = 0
  for (const m of modes) p += ((m.amp * m.amp) / 2) * (m.tau / (2 * w)) * (1 - Math.exp((-2 * w) / m.tau))
  return p
}

/** When the note has faded RELEASE_DB from its first moments (the live note's end), s after the strike. */
export function handpanRelease(midi: number, ding: boolean): number {
  const modes = handpanModes(midi, ding)
  const target = meanPower(modes, STEADY_WINDOW) * Math.pow(10, RELEASE_DB / 10)
  let t = 0
  while (t < HANDPAN_MAX && power(modes, t) > target) t += 0.01
  return Math.min(t, HANDPAN_MAX)
}

/** Renders one handpan note: mono, starting and ending at silence, its first STEADY_WINDOW at HANDPAN_RMS. */
export function renderHandpan(p: HandpanParams): Float32Array {
  const fs = p.sampleRate
  const modes = handpanModes(p.midi, p.ding).filter((m) => m.freq < fs * 0.45)
  // (about) the note's level, to know when each mode has died away
  const scale = HANDPAN_RMS / Math.sqrt(meanPower(modes, STEADY_WINDOW))
  const silence = SILENCE * HANDPAN_RMS
  const ends = modes.map((m) => Math.ceil(Math.min(HANDPAN_MAX, m.tau * Math.log(Math.max(1, (m.amp * scale) / silence))) * fs))
  const length = Math.max(Math.round(0.05 * fs), ...ends)
  const acc = new Float64Array(length)

  // every mode is a damped sinusoid: y[i] = c·y[i−1] − q·y[i−2]
  modes.forEach((m, k) => {
    const w = (2 * Math.PI * m.freq) / fs
    const r = Math.exp(-1 / (m.tau * fs))
    const c = 2 * r * Math.cos(w)
    const q = r * r
    const a = m.amp * scale
    let y1 = (a * Math.cos(m.phase - w)) / r
    let y2 = (a * Math.cos(m.phase - 2 * w)) / q
    for (let i = 0; i < ends[k]; i++) {
      const y0 = c * y1 - q * y2
      acc[i] += y0
      y2 = y1
      y1 = y0
    }
  })

  // the beats make the first moments louder or softer than the modes' powers say: level them exactly
  const steady = Math.min(length, Math.round(STEADY_WINDOW * fs))
  let sum = 0
  for (let i = 0; i < steady; i++) sum += acc[i] * acc[i]
  const level = sum > 0 ? HANDPAN_RMS / Math.sqrt(sum / steady) : 0
  for (let i = 0; i < length; i++) acc[i] *= level

  // the strike: a few ms of dark noise (one-pole highpass, two one-pole lowpasses)
  const rand = mulberry32(p.seed)
  const n = Math.min(length, Math.round(10 * STRIKE_DECAY * fs))
  const strike = new Float64Array(n)
  const hp = Math.exp((-2 * Math.PI * STRIKE_LOW) / fs)
  const lp1 = Math.exp((-2 * Math.PI * STRIKE_DARK) / fs)
  const lp2 = Math.exp((-2 * Math.PI * STRIKE_DARKER) / fs)
  let h = 0
  let x1 = 0
  let l1 = 0
  let l2 = 0
  let energy = 0
  for (let i = 0; i < n; i++) {
    const x = (rand() * 2 - 1) * Math.exp(-i / (STRIKE_DECAY * fs))
    h = hp * (h + x - x1)
    x1 = x
    l1 += (1 - lp1) * (h - l1)
    l2 += (1 - lp2) * (l1 - l2)
    strike[i] = l2
    energy += l2 * l2
  }
  // its energy over the first 20 ms, STRIKE_DB under the note's
  const g = energy > 0 ? HANDPAN_RMS * Math.sqrt((Math.pow(10, STRIKE_DB / 10) * 0.02 * fs) / energy) : 0
  for (let i = 0; i < n; i++) acc[i] += g * strike[i]

  // the hand lands: everything rises over ~1 ms
  const rise = Math.max(1, Math.round(RISE * fs))
  for (let i = 0; i < Math.min(rise, length); i++) acc[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / rise)

  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = acc[i]
  // a last 5 ms fade
  const fade = Math.min(length, Math.round(0.005 * fs))
  for (let i = 0; i < fade; i++) out[length - 1 - i] *= i / fade
  return out
}

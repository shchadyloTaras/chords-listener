import { describe, expect, it } from 'vitest'
import { volumeGain } from './engine'
import { midiToFreq } from './dsp'
import {
  HANDPAN_DING,
  HANDPAN_FIELDS,
  HANDPAN_MAX,
  HANDPAN_RMS,
  handpanModes,
  handpanParams,
  handpanRelease,
  handpanSource,
  renderHandpan,
} from './handpanTone'
import {
  HARMONIUM_RELEASE,
  HARMONIUM_RMS,
  HARMONIUM_SPECTRA,
  HARMONIUM_TAIL,
  harmoniumDetune,
  harmoniumParams,
  harmoniumSpectrum,
  reedSpeech,
  renderHarmonium,
  speechCurve,
} from './harmonium'
import {
  PIANO_REF_VELOCITY,
  PIANO_RMS,
  PIANO_SPECTRA,
  PIANO_TAIL_MAX,
  damperTime,
  inharmonicity,
  pianoDecay,
  pianoParams,
  pianoSpectrum,
  pianoTouch,
  pianoTuning,
  renderPiano,
} from './piano'
import { allpassCoefficient, pluckParams, pluckRelease, renderPluck, type PluckInstrument } from './pluck'
import { roomImpulse } from './reverb'
import { COMPRESSOR_DELAY, contextToPerformance, timeRef } from './time'

/** Fundamental frequency by normalized autocorrelation over a window after the attack, with parabolic interpolation. */
function pitchOf(x: Float32Array, fs: number, expected: number): number {
  const from = Math.round(0.15 * fs)
  const len = Math.round(0.25 * fs)
  const r = (lag: number) => {
    let s = 0
    let e1 = 0
    let e2 = 0
    for (let i = from; i < from + len; i++) {
      s += x[i] * x[i + lag]
      e1 += x[i] * x[i]
      e2 += x[i + lag] * x[i + lag]
    }
    return s / Math.sqrt(e1 * e2)
  }
  const period = fs / expected
  let best = -Infinity
  let bestLag = 0
  for (let lag = Math.floor(period * 0.9); lag <= Math.ceil(period * 1.1); lag++) {
    const v = r(lag)
    if (v > best) {
      best = v
      bestLag = lag
    }
  }
  const a = r(bestLag - 1)
  const b = r(bestLag)
  const c = r(bestLag + 1)
  return fs / (bestLag + (a - c) / (2 * (a - 2 * b + c)))
}

function rms(x: Float32Array, fs: number, t0: number, t1: number): number {
  let s = 0
  let n = 0
  for (let i = Math.round(t0 * fs); i < Math.min(x.length, Math.round(t1 * fs)); i++, n++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, n))
}

const cents = (f: number, ref: number) => 1200 * Math.log2(f / ref)

describe('Karplus-Strong plucks', () => {
  const cases: [PluckInstrument, number][] = [
    ['guitar', 40], // E2, the low string
    ['guitar', 47],
    ['guitar', 55],
    ['guitar', 64], // E4, the high string
    ['guitar', 76],
    ['ukulele', 60], // C4
    ['ukulele', 67], // G4
    ['ukulele', 69], // A4
    ['ukulele', 81], // A5, 12th fret
    ['bass', 28], // E1, the low string
    ['bass', 33], // A1
    ['bass', 43], // G2, the high string
    ['bass', 55], // G3, 12th fret
  ]

  for (const fs of [44100, 48000]) {
    // Renders ~9 multi-second buffers; generous timeout for slow CI runners.
    it(`are finite, decay and are in tune at ${fs} Hz`, { timeout: 30_000 }, () => {
      for (const [instrument, midi] of cases) {
        const p = pluckParams(instrument, midi, fs)
        const x = renderPluck(p)
        expect(x.length).toBe(Math.round(p.duration * fs))
        let peak = 0
        let nonFinite = 0
        for (const v of x) {
          if (!Number.isFinite(v)) nonFinite++
          else peak = Math.max(peak, Math.abs(v))
        }
        expect(nonFinite, `${instrument} ${midi}`).toBe(0)
        expect(peak).toBeGreaterThan(0.1)
        expect(peak).toBeLessThanOrEqual(0.96)
        // decays: well down after a second, silent at the very end (faded out)
        const early = rms(x, fs, 0, 0.1)
        expect(rms(x, fs, 1, 1.1)).toBeLessThan(early * 0.35)
        expect(Math.abs(x[x.length - 1])).toBeLessThan(1e-3)
        // in tune within a few cents
        expect(Math.abs(cents(pitchOf(x, fs, p.frequency), p.frequency)), `${instrument} ${midi}`).toBeLessThan(3)
      }
    })
  }

  it('rings longer on low strings, shorter on the ukulele', () => {
    const low = pluckParams('guitar', 40, 48000)
    const high = pluckParams('guitar', 64, 48000)
    const uke = pluckParams('ukulele', 64, 48000)
    expect(low.t60).toBeGreaterThan(high.t60)
    expect(high.t60).toBeGreaterThan(uke.t60)
    expect(pluckRelease(low)).toBeCloseTo(low.t60 / 2, 6)
    expect(pluckRelease(uke)).toBeLessThan(pluckRelease(high))
  })

  it('gives the bass a long, dark, round string', () => {
    const e1 = pluckParams('bass', 28, 48000)
    const g2 = pluckParams('bass', 43, 48000)
    const guitarG2 = pluckParams('guitar', 43, 48000)
    expect(e1.t60).toBeGreaterThan(g2.t60)
    expect(e1.t60).toBeGreaterThanOrEqual(5)
    // darker than a guitar at the same pitch: high partials die sooner, softer finger attack
    expect(g2.damping).toBeGreaterThan(guitarG2.damping)
    expect(g2.pickCutoff).toBeLessThan(guitarG2.pickCutoff)
    // no acoustic body: a pickup's low bump and a mid growl for small speakers
    expect(e1.body.map((b) => b.freq)).toEqual([90, 700])
  })

  it('renders the same pluck every time (cacheable)', () => {
    const p = pluckParams('guitar', 52, 44100)
    expect(renderPluck(p)).toEqual(renderPluck(p))
  })

  it('solves the tuning allpass exactly', () => {
    for (const [delay, w] of [
      [0.5, 0.01],
      [0.9, 0.1],
      [1.4, 0.2],
    ]) {
      const c = allpassCoefficient(delay, w)
      const phase = Math.atan2(-Math.sin(w), c + Math.cos(w)) - Math.atan2(-c * Math.sin(w), 1 + c * Math.cos(w))
      expect(-phase / w).toBeCloseTo(delay, 6)
    }
  })
})

describe('piano keys', () => {
  const fs = 16000
  /** Amplitude of the component at `freq` (Hann-windowed DFT over [from, from + seconds)). */
  const amplitude = (x: Float32Array, freq: number, from: number, seconds: number) => {
    const a = Math.round(from * fs)
    const n = Math.round(seconds * fs)
    let re = 0
    let im = 0
    let ws = 0
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
      re += x[a + i] * w * Math.cos((2 * Math.PI * freq * i) / fs)
      im += x[a + i] * w * Math.sin((2 * Math.PI * freq * i) / fs)
      ws += w
    }
    return (2 * Math.hypot(re, im)) / ws
  }
  const rms = (x: Float32Array, from: number, to: number) => {
    let s = 0
    const a = Math.round(from * fs)
    const b = Math.round(to * fs)
    for (let i = a; i < b; i++) s += x[i] * x[i]
    return Math.sqrt(s / (b - a))
  }
  const db = (a: number, b: number) => 20 * Math.log10(a / b)
  const render = (midi: number, hold = 2.6, velocity = PIANO_REF_VELOCITY) => renderPiano(pianoParams(midi, velocity, hold, fs))
  /** Partial n of `midi` as rendered: stretched by the string's stiffness and the tuning. */
  const partial = (midi: number, n: number) =>
    n * 440 * Math.pow(2, (midi - 69) / 12 + pianoTuning(midi) / 1200) * Math.sqrt(1 + inharmonicity(midi) * n * n)

  it('have the measured spectra, stretched partials and stretch tuning', () => {
    for (const s of PIANO_SPECTRA) expect(Math.max(...s.levels)).toBe(0) // dB re the key's strongest partial
    expect(PIANO_SPECTRA[0].levels.length).toBeGreaterThan(40) // the bass is rich…
    expect(PIANO_SPECTRA[PIANO_SPECTRA.length - 1].levels.length).toBeLessThan(4) // …the top nearly pure
    expect(pianoSpectrum(61.5)[2]).toBeCloseTo((pianoSpectrum(60)[2] + pianoSpectrum(63)[2]) / 2, 6)
    expect(pianoSpectrum(20)).toEqual(pianoSpectrum(33))
    // B as measured on both pianos: ~1e-4 in the bass, ~3e-4 at C4, ~2.5e-3 at C6
    expect(inharmonicity(36)).toBeCloseTo(1e-4, 6)
    expect(inharmonicity(60)).toBeGreaterThan(2.6e-4)
    expect(inharmonicity(60)).toBeLessThan(3.6e-4)
    expect(inharmonicity(84)).toBeGreaterThan(2.1e-3)
    expect(inharmonicity(84)).toBeLessThan(2.9e-3)
    expect(pianoTuning(69)).toBe(0)
    expect(pianoTuning(36)).toBeLessThan(-2)
    expect(pianoTuning(96)).toBeGreaterThan(5)
    // the rendered C4: its partials sit where the stiff string puts them, nothing in between
    const x = render(60)
    for (const n of [1, 2, 5]) {
      const f = partial(60, n)
      const near = [-4, -2, 0, 2, 4].map((c) => amplitude(x, f * Math.pow(2, c / 1200), 0.1, 1.2))
      expect(Math.max(...near)).toBe(near[2])
    }
    expect(cents(partial(60, 8), 8 * partial(60, 1))).toBeGreaterThan(5)
    const main = amplitude(x, partial(60, 1), 0.1, 0.5)
    expect(amplitude(x, partial(60, 1) * 1.5, 0.1, 0.5)).toBeLessThan(main * 0.03)
  })

  it('decay twice: the prompt sound, then the aftersound, faster up the keyboard and for upper partials', () => {
    const c4 = pianoDecay(60, 262)
    expect(c4.prompt).toBeGreaterThan(0.25)
    expect(c4.prompt).toBeLessThan(0.5)
    expect(c4.after).toBeGreaterThan(5 * c4.prompt)
    expect(10 * Math.log10(c4.share)).toBeLessThan(-12)
    expect(pianoDecay(60, 3000).after).toBeLessThan(c4.after)
    expect(pianoDecay(84, 1050).prompt).toBeLessThan(pianoDecay(48, 1050).prompt)
    const x = render(60, 6)
    const f = partial(60, 1)
    const level = (t: number) => amplitude(x, f, t, 0.2)
    const peak = level(0.02)
    // the measured C4: −7…−9 dB at 0.3 s, ~−25 dB at 1 s, ~−30 dB at 3 s (beats blur each reading)
    expect(db(level(0.3), peak)).toBeLessThan(-3)
    expect(db(level(0.3), peak)).toBeGreaterThan(-14)
    expect(db(level(1), peak)).toBeLessThan(-12)
    const late = db(level(4), level(2))
    expect(late).toBeLessThan(0)
    expect(late).toBeGreaterThan(db(level(1), peak)) // slower after the first second
  })

  it('beat: the unison strings make every partial waver', () => {
    const x = render(60, 6)
    const ripples = [1, 2, 3, 4, 5, 6].map((n) => {
      const f = partial(60, n)
      const env = Array.from({ length: 30 }, (_, k) => 20 * Math.log10(amplitude(x, f, 0.8 + k * 0.1, 0.12)))
      // remove the straight-line decay, keep the ripple
      const k0 = (env.length - 1) / 2
      const mean = env.reduce((a, b) => a + b, 0) / env.length
      const slope = env.reduce((a, v, k) => a + (k - k0) * (v - mean), 0) / env.reduce((a, _, k) => a + (k - k0) ** 2, 0)
      const res = env.map((v, k) => v - mean - slope * (k - k0))
      return Math.max(...res) - Math.min(...res)
    })
    ripples.sort((a, b) => a - b)
    expect(ripples[3]).toBeGreaterThan(2) // median ripple, dB peak to peak
  })

  it('knock: the hammer thumps the soundboard under the tone, then it dies away', () => {
    // probes 150–220 Hz, under the fundamental of both keys; dB re the fundamental
    const knock = (x: Float32Array, from: number) => Math.hypot(...[150, 180, 220].map((f) => amplitude(x, f, from, 0.02)))
    const re = (midi: number) => {
      const x = render(midi)
      return db(knock(x, 0.01), amplitude(x, partial(midi, 1), 0.01, 0.1))
    }
    // on the top keys the measured knock is about as loud as the fundamental, in the middle ~10 dB less
    expect(re(84)).toBeGreaterThan(-20)
    expect(re(84)).toBeLessThan(6)
    expect(re(84)).toBeGreaterThan(re(64) + 4)
    const c6 = render(84)
    expect(db(knock(c6, 0.35), knock(c6, 0.01))).toBeLessThan(-20)
  })

  it('touch: softer is darker and quieter, harder brighter and louder', () => {
    expect(pianoTouch(PIANO_REF_VELOCITY, 300)).toBe(0)
    expect(pianoTouch(0.3, 4000)).toBeLessThan(pianoTouch(0.3, 250) - 10)
    expect(pianoTouch(1, 4000)).toBeGreaterThan(pianoTouch(1, 250) + 5)
    const ref = render(60, 1)
    const soft = render(60, 1, 0.35)
    const hard = render(60, 1, 0.95)
    const at = (x: Float32Array, n: number) => amplitude(x, partial(60, n), 0.02, 0.2)
    expect(at(soft, 1)).toBeLessThan(at(ref, 1))
    expect(at(hard, 1)).toBeGreaterThan(at(ref, 1))
    expect(at(soft, 10) / at(soft, 1)).toBeLessThan((at(ref, 10) / at(ref, 1)) * 0.6)
    expect(at(hard, 10) / at(hard, 1)).toBeGreaterThan((at(ref, 10) / at(ref, 1)) * 1.4)
  })

  it('stop as the dampers fall (the top keys have none) and end in silence', () => {
    const hold = 1
    const x = render(60, hold)
    expect(x.length).toBeLessThanOrEqual(Math.round((hold + PIANO_TAIL_MAX) * fs) + 1)
    expect(rms(x, hold + 0.3, hold + 0.35)).toBeLessThan(rms(x, hold - 0.1, hold) * 0.05)
    expect(Math.abs(x[x.length - 1])).toBeLessThan(1e-6)
    expect(Math.abs(x[0])).toBeLessThan(1e-3)
    expect(damperTime(60, 4000)).toBeLessThan(damperTime(60, 250))
    expect(damperTime(91, 2000)).toBe(Infinity)
    const top = render(91, hold)
    expect(rms(top, hold + 0.1, hold + 0.15)).toBeGreaterThan(rms(top, hold - 0.05, hold) * 0.3)
  })

  it('are deterministic, clean and level across the keys', () => {
    expect(render(67, 1)).toEqual(render(67, 1))
    for (const m of [36, 48, 60, 72, 84]) {
      const x = render(m, 1)
      let peak = 0
      for (const v of x) peak = Math.max(peak, Math.abs(v))
      expect(peak).toBeLessThan(0.9)
      expect(Math.abs(db(rms(x, 0, 0.3), PIANO_RMS))).toBeLessThan(6)
    }
  })
})

describe('handpan notes', () => {
  const fs = 16000
  /** Amplitude of the component at `freq` (Hann-windowed DFT over [from, from + seconds)). */
  const amplitude = (x: Float32Array, freq: number, from: number, seconds: number) => {
    const a = Math.round(from * fs)
    const n = Math.round(seconds * fs)
    let re = 0
    let im = 0
    let ws = 0
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
      re += x[a + i] * w * Math.cos((2 * Math.PI * freq * i) / fs)
      im += x[a + i] * w * Math.sin((2 * Math.PI * freq * i) / fs)
      ws += w
    }
    return (2 * Math.hypot(re, im)) / ws
  }
  const rms = (x: Float32Array, from: number, to: number) => {
    let s = 0
    const a = Math.round(from * fs)
    const b = Math.min(x.length, Math.round(to * fs))
    for (let i = a; i < b; i++) s += x[i] * x[i]
    return Math.sqrt(s / (b - a))
  }
  const db = (a: number, b: number) => 20 * Math.log10(a / b)
  const render = (midi: number, ding = false) => renderHandpan(handpanParams(midi, ding, fs))
  const near = (ratio: number, k: number) => Math.abs(ratio - k) < 0.03 * k

  it('have the measured modes: split tuned partials and the steel\'s own untuned ones', () => {
    for (const field of [HANDPAN_DING, ...HANDPAN_FIELDS]) {
      const modes = field.modes
      expect(Math.max(...modes.map((m) => m[1]))).toBe(0) // dB re the strongest mode
      expect(modes.some((m) => m[0] === 1)).toBe(true) // the pitch: the strongest long-ringing mode
      // fundamental, octave and compound fifth
      for (const k of [1, 2, 3]) expect(modes.some((m) => near(m[0], k))).toBe(true)
      // the fundamental is two or more modes a few hertz apart (it beats)
      expect(modes.filter((m) => near(m[0], 1)).length).toBeGreaterThanOrEqual(2)
      // and the steel rings at untuned frequencies too
      expect(modes.filter((m) => ![1, 2, 3, 4, 5, 6].some((k) => near(m[0], k))).length).toBeGreaterThan(0)
      for (const [, , t60] of modes) {
        expect(t60).toBeGreaterThan(0.1)
        expect(t60).toBeLessThan(10)
      }
    }
  })

  it('voice the ding from the recorded ding and a field from the nearest recorded field, transposed', () => {
    expect(handpanSource(41, true)).toBe(HANDPAN_DING)
    expect(handpanSource(56, true)).toBe(HANDPAN_DING)
    expect(handpanSource(62, false).midi).toBe(62)
    expect(handpanSource(60, false).midi).toBe(62)
    expect(handpanSource(40, false).midi).toBe(HANDPAN_FIELDS[0].midi)
    expect(handpanSource(90, false).midi).toBe(HANDPAN_FIELDS[HANDPAN_FIELDS.length - 1].midi)
    const at = handpanModes(62, false)
    const down = handpanModes(61, false) // D4's modes a semitone lower, ringing a little longer
    down.forEach((m, i) => {
      expect(m.freq / at[i].freq).toBeCloseTo(Math.pow(2, -1 / 12), 9)
      expect(m.tau).toBeGreaterThan(at[i].tau)
      expect(m.amp).toBe(at[i].amp)
    })
    expect(Math.max(...handpanModes(62, false).filter((m) => m.amp === 1).map((m) => m.freq))).toBeCloseTo(midiToFreq(62), 6)
  })

  it('ring like the recording: the fundamental first, the octave blooming and outliving it', () => {
    for (const [midi, ding] of [
      [50, true],
      [62, false],
      [69, false],
    ] as const) {
      const x = render(midi, ding)
      const f = midiToFreq(midi)
      const octave = (t: number) => db(amplitude(x, 2 * f, t, 0.04), amplitude(x, f, t, 0.04))
      // at the strike the fundamental leads by 10+ dB; a second later the octave is (nearly) as strong
      expect(octave(0.005)).toBeLessThan(-10)
      expect(octave(1)).toBeGreaterThan(octave(0.005) + 10)
      // nothing between the partial clusters
      expect(amplitude(x, 1.5 * f, 0.05, 0.5)).toBeLessThan(amplitude(x, f, 0.05, 0.5) * 0.05)
    }
    // the octave blooms: ~10 dB up within 100 ms (as measured on D3 and D4)
    for (const [midi, ding] of [
      [50, true],
      [62, false],
    ] as const) {
      const x = render(midi, ding)
      const f = midiToFreq(midi)
      expect(db(amplitude(x, 2 * f, 0.09, 0.04), amplitude(x, 2 * f, 0.002, 0.02))).toBeGreaterThan(6)
    }
  })

  it('shimmer: the split modes make the partials beat', () => {
    for (const midi of [62, 69]) {
      const x = render(midi)
      const f = midiToFreq(midi)
      const env = Array.from({ length: 25 }, (_, k) => db(amplitude(x, f, 0.2 + k * 0.04, 0.08), 1))
      // remove the straight-line decay, keep the ripple
      const k0 = (env.length - 1) / 2
      const mean = env.reduce((a, b) => a + b, 0) / env.length
      const slope = env.reduce((a, v, k) => a + (k - k0) * (v - mean), 0) / env.reduce((a, _, k) => a + (k - k0) ** 2, 0)
      const res = env.map((v, k) => v - mean - slope * (k - k0))
      expect(Math.max(...res) - Math.min(...res)).toBeGreaterThan(3)
    }
  })

  it('clang: the untuned modes sound with the strike and die away first', () => {
    const x = render(69) // A4: its strongest untuned mode, 0.84 × f0
    const f = midiToFreq(69)
    expect(db(amplitude(x, 0.8434 * f, 0.02, 0.25), amplitude(x, f, 0.02, 0.25))).toBeGreaterThan(-20)
    const g = render(55) // G3: a hard, short ring under the fundamental
    const g0 = midiToFreq(55)
    const early = db(amplitude(g, 0.877 * g0, 0.01, 0.1), amplitude(g, g0, 0.01, 0.1))
    const late = db(amplitude(g, 0.877 * g0, 1, 0.2), amplitude(g, g0, 1, 0.2))
    expect(early).toBeGreaterThan(-10)
    expect(late).toBeLessThan(early - 20)
  })

  it('decay in a few seconds: −30 dB in 1–2.5 s, never longer than HANDPAN_MAX', () => {
    for (const [midi, ding] of [
      [41, true],
      [50, true],
      [55, false],
      [64, false],
      [72, false],
      [81, false],
    ] as const) {
      const release = handpanRelease(midi, ding)
      expect(release).toBeGreaterThan(1)
      expect(release).toBeLessThan(2.5)
      const x = render(midi, ding)
      expect(x.length).toBeLessThanOrEqual(HANDPAN_MAX * fs + 1)
      expect(db(rms(x, release, release + 0.2), rms(x, 0, 0.3))).toBeLessThan(-22)
    }
    // low dings ring longer than high fields
    expect(handpanRelease(41, true)).toBeGreaterThan(handpanRelease(81, false))
  })

  it('are deterministic, clean, level and end in silence', () => {
    expect(render(67)).toEqual(render(67))
    for (const [midi, ding] of [
      [41, true],
      [50, true],
      [52, false],
      [60, false],
      [69, false],
      [77, false],
    ] as const) {
      const x = render(midi, ding)
      let peak = 0
      for (const v of x) peak = Math.max(peak, Math.abs(v))
      expect(peak).toBeLessThan(0.9)
      expect(Math.abs(db(rms(x, 0, 0.3), HANDPAN_RMS))).toBeLessThan(0.1)
      expect(Math.abs(x[0])).toBeLessThan(1e-3)
      expect(Math.abs(x[x.length - 1])).toBeLessThan(1e-6)
    }
  })
})

describe('harmonium reeds', () => {
  const fs = 16000
  /** Amplitude of the component at `freq` (Hann-windowed DFT over [from, from + seconds)). */
  const amplitude = (x: Float32Array, freq: number, from: number, seconds: number) => {
    const a = Math.round(from * fs)
    const n = Math.round(seconds * fs)
    let re = 0
    let im = 0
    let ws = 0
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
      re += x[a + i] * w * Math.cos((2 * Math.PI * freq * i) / fs)
      im += x[a + i] * w * Math.sin((2 * Math.PI * freq * i) / fs)
      ws += w
    }
    return (2 * Math.hypot(re, im)) / ws
  }
  const rms = (x: Float32Array, from: number, to: number) => {
    let s = 0
    const a = Math.round(from * fs)
    const b = Math.round(to * fs)
    for (let i = a; i < b; i++) s += x[i] * x[i]
    return Math.sqrt(s / (b - a))
  }
  const render = (midi: number, hold = 1.2) => renderHarmonium(harmoniumParams(midi, hold, fs))

  it('sound two reeds per key: the written pitch and a bass reed an octave below, detuned as measured', () => {
    const x = render(60)
    const f = 261.63
    const bass = (f / 2) * Math.pow(2, -harmoniumDetune(60) / 1200)
    const main = amplitude(x, f, 0.4, 0.75)
    expect(amplitude(x, bass, 0.4, 0.75)).toBeGreaterThan(main * 0.3)
    // nothing between the harmonics
    expect(amplitude(x, f * 0.75, 0.4, 0.75)).toBeLessThan(main * 0.02)
    expect(amplitude(x, f * 1.25, 0.4, 0.75)).toBeLessThan(main * 0.02)
    // the main reed is in tune (the pitch wanders about a cent)
    const near = [-6, -3, 0, 3, 6].map((c) => amplitude(x, f * Math.pow(2, c / 1200), 0.2, 0.95))
    expect(Math.max(...near)).toBe(near[2])
    // every key its own beating, as on the recorded instrument
    const detunes = Array.from({ length: 37 }, (_, k) => harmoniumDetune(48 + k))
    expect(Math.min(...detunes)).toBeLessThan(0)
    expect(Math.max(...detunes)).toBeGreaterThan(10)
    expect(new Set(detunes).size).toBeGreaterThan(15)
  })

  it('have the measured spectra: rich, interpolated between the measured keys', () => {
    for (const s of HARMONIUM_SPECTRA) {
      expect(Math.max(...s.main, ...s.bass)).toBe(0) // dB re the key's strongest partial
      expect(s.main.length).toBeGreaterThanOrEqual(7)
      expect(s.bass.length).toBeGreaterThanOrEqual(15)
    }
    const a = harmoniumSpectrum(60)
    const b = harmoniumSpectrum(63)
    const mid = harmoniumSpectrum(61.5)
    expect(mid.main[0]).toBeCloseTo((a.main[0] + b.main[0]) / 2, 6)
    expect(harmoniumSpectrum(30)).toEqual(harmoniumSpectrum(48))
  })

  it('speak like reeds: the main fundamental first, then its harmonics, the bass reed last', () => {
    const x = render(53) // F3 over F2, the recording's cleanly started key
    const f = 174.61
    const bass = (f / 2) * Math.pow(2, -harmoniumDetune(53) / 1200)
    const level = (freq: number, t: number) => amplitude(x, freq, t, 0.04) / amplitude(x, freq, 0.8, 0.04)
    const firstAbove = (freq: number, ratio: number) => {
      for (let t = 0; t < 0.6; t += 0.005) if (level(freq, t) >= ratio) return t
      return Infinity
    }
    const main = firstAbove(f, 0.5)
    const harmonics = firstAbove(3 * f, 0.5)
    const low = firstAbove(bass, 0.5)
    expect(main).toBeLessThan(0.12)
    expect(harmonics).toBeGreaterThan(main + 0.03)
    expect(low).toBeGreaterThan(main)
    expect(Math.max(harmonics, low)).toBeLessThan(0.4)
    expect(rms(x, 0, 0.02)).toBeLessThan(rms(x, 0.6, 1.1) * 0.1)
    expect(reedSpeech(87)).toBeGreaterThan(reedSpeech(175))
    expect(reedSpeech(2000)).toBe(0.025)
    expect(speechCurve(0)).toBeCloseTo(0.01, 6)
    expect(speechCurve(1)).toBe(1)
  })

  it('stop as the pallet closes and end in silence', () => {
    const hold = 1.2
    const x = render(64, hold)
    expect(x.length).toBe(Math.round((hold + HARMONIUM_TAIL) * fs))
    const steady = rms(x, 0.6, 1.1)
    expect(rms(x, hold + 0.03, hold + 0.05)).toBeLessThan(steady * 0.1)
    expect(Math.abs(x[x.length - 1])).toBeLessThan(1e-6)
    expect(Math.abs(x[0])).toBeLessThan(1e-3)
    expect(HARMONIUM_RELEASE).toBeLessThan(0.02)
  })

  it('are deterministic, clean and level across the keys', () => {
    expect(render(67)).toEqual(render(67))
    for (const m of [48, 55, 62, 69, 76, 84]) {
      const x = render(m)
      let peak = 0
      for (const v of x) peak = Math.max(peak, Math.abs(v))
      expect(peak).toBeLessThan(0.9)
      const db = 20 * Math.log10(rms(x, 0.6, 1.1) / HARMONIUM_RMS)
      expect(Math.abs(db)).toBeLessThan(3)
    }
  })
})

describe('room reverb', () => {
  it('is a decaying, unit-energy stereo response', () => {
    const [l, r] = roomImpulse(8000)
    expect(l.length).toBe(r.length)
    let e = 0
    for (const v of l) e += v * v
    expect(e).toBeCloseTo(1, 4)
    expect(l).not.toEqual(r)
    expect(rms(l, 8000, 0.05, 0.15)).toBeGreaterThan(rms(l, 8000, 1, 1.1) * 20)
  })
})

describe('AudioContext → performance.now()', () => {
  it('adds base + output latency when there is no output timestamp', () => {
    const ref = timeRef({ currentTime: 10, baseLatency: 0.01, outputLatency: 0.02 }, 5000)
    expect(ref).toEqual({ contextTime: 10, performanceTime: 5030 })
    expect(contextToPerformance(10.5, ref)).toBeCloseTo(5530, 6)
    // the limiter's lookahead on top
    const withLimiter = timeRef({ currentTime: 10, baseLatency: 0.01, outputLatency: 0.02 }, 5000, COMPRESSOR_DELAY)
    expect(contextToPerformance(10.5, withLimiter)).toBeCloseTo(5536, 6)
  })

  it('ignores latencies the browser does not report', () => {
    const ref = timeRef({ currentTime: 3, outputLatency: Number.NaN }, 1000)
    expect(contextToPerformance(3.25, ref)).toBeCloseTo(1250, 6)
  })

  it('prefers the output timestamp, which already includes the output latency', () => {
    const clock = {
      currentTime: 10,
      baseLatency: 0.01,
      outputLatency: 0.02,
      // the frame at 9.97 s left the speakers at 4995 ms
      getOutputTimestamp: () => ({ contextTime: 9.97, performanceTime: 4995 }),
    }
    const ref = timeRef(clock, 5000)
    expect(contextToPerformance(10.5, ref)).toBeCloseTo(4995 + 530, 6)
  })

  it('falls back when the timestamp is empty or stale', () => {
    const zero = timeRef({ currentTime: 2, getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }) }, 800)
    expect(zero).toEqual({ contextTime: 2, performanceTime: 800 })
    const stale = timeRef({ currentTime: 2, getOutputTimestamp: () => ({ contextTime: 1.5, performanceTime: 100 }) }, 9000)
    expect(stale).toEqual({ contextTime: 2, performanceTime: 9000 })
    const throws = timeRef(
      {
        currentTime: 2,
        getOutputTimestamp: () => {
          throw new Error('nope')
        },
      },
      800,
    )
    expect(throws.contextTime).toBe(2)
  })

  it('ignores a timestamp rendered before the context (re)started', () => {
    // resumed at 5000 ms: the stamp still describes the frame from before the pause
    const clock = { currentTime: 4.2, getOutputTimestamp: () => ({ contextTime: 4.18, performanceTime: 4400 }) }
    expect(timeRef(clock, 5010, 0, 5000)).toEqual({ contextTime: 4.2, performanceTime: 5010 })
    expect(timeRef(clock, 5010, 0, 4000)).toEqual({ contextTime: 4.18, performanceTime: 4400 })
    expect(timeRef(clock, 5010, 0, Infinity).contextTime).toBe(4.2) // timestamps disabled
  })
})

describe('volume', () => {
  it('maps the setting perceptually and clamps it', () => {
    expect(volumeGain(0)).toBe(0)
    expect(volumeGain(1)).toBe(1)
    expect(volumeGain(0.5)).toBeCloseTo(0.25, 6)
    expect(volumeGain(2)).toBe(1)
    expect(volumeGain(Number.NaN)).toBeCloseTo(0.64, 6)
  })
})

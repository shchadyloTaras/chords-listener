import { describe, expect, it } from 'vitest'
import { volumeGain } from './engine'
import { handpanDecay, handpanPartials, handpanRelease } from './handpanTone'
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
import { inharmonicity, pianoEnvelope, pianoPartials } from './piano'
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

describe('piano partials', () => {
  it('are slightly stretched, quieter and faster-decaying towards the top', () => {
    const p = pianoPartials(60, 0.7, 20000)
    expect(p).toHaveLength(8)
    const f0 = p[0].freq
    expect(f0).toBeCloseTo(261.63 * Math.sqrt(1 + inharmonicity(60)), 1)
    for (let i = 1; i < p.length; i++) {
      expect(p[i].freq / f0).toBeGreaterThan(i + 1) // inharmonic stretch
      expect(cents(p[i].freq, (i + 1) * f0)).toBeLessThan(25) // but only slightly
      expect(p[i].fast).toBeLessThan(p[i - 1].fast)
      expect(p[i].slow).toBeLessThan(p[i - 1].slow)
    }
    expect(p[7].amp).toBeLessThan(p[0].amp * 0.2)
    // a softer touch is darker
    expect(pianoPartials(60, 0.3, 20000)[5].amp).toBeLessThan(p[5].amp)
    // low notes ring longer; partials above the limit are dropped
    expect(pianoPartials(40, 0.7, 20000)[0].slow).toBeGreaterThan(p[0].slow)
    expect(pianoPartials(96, 0.7, 6000).length).toBeLessThan(8)
  })

  it('has a double decay, then the damper', () => {
    const [fund] = pianoPartials(60, 0.7, 20000)
    const hold = 2.6
    const env = pianoEnvelope(fund, hold, 0.1)
    const at = (t: number) => env[Math.round(t / 0.004)]
    expect(env[0]).toBe(0)
    expect(env[env.length - 1]).toBe(0)
    const peak = Math.max(...env)
    // fast prompt drop over the first half second…
    const early = 20 * Math.log10(at(0.5) / peak)
    // …then a slow aftersound
    const late = 20 * Math.log10(at(2) / at(1))
    expect(early).toBeLessThan(-5)
    expect(late).toBeGreaterThan(-5)
    expect(late).toBeLessThan(0)
    // the damper falls after the hold
    expect(at(hold + 0.3)).toBeLessThan(at(hold) * 0.06)
  })
})

describe('handpan tone', () => {
  it('has fundamental, octave and compound fifth with a long ring', () => {
    const p = handpanPartials(62)
    expect(p.map((x) => x.ratio)).toEqual([1, 2, 3])
    expect(p[0].attack).toBeCloseTo(0.008, 6)
    for (const x of p) expect(x.beat).toBeGreaterThan(0)
    expect(handpanDecay(45)).toBeGreaterThan(handpanDecay(77))
    for (const m of [45, 62, 77]) {
      expect(handpanRelease(m)).toBeGreaterThanOrEqual(2.5)
      expect(handpanRelease(m)).toBeLessThanOrEqual(4)
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

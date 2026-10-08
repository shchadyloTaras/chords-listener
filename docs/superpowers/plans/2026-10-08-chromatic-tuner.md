# Chromatic Tuner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chromatic tuner page `#/tuner` (needle with cents, note with octave, Hz, A4 calibration, reference tone), opened from a third card on Home next to «Файл» and «Слухати».

**Architecture:** Pure DSP and note math in `frontend/src/lib/tuner/` (McLeod Pitch Method over the existing `RealFFT`, a display stabilizer), two thin Web Audio wrappers (microphone → `AnalyserNode`; a sine reference tone), a React hook that runs the detection loop on `requestAnimationFrame`, and a page under `frontend/src/components/tuner/` wired into the hash router. Everything runs in the browser; nothing touches the backend or Firestore.

**Tech Stack:** React 19, TypeScript 6, zustand 5 (persisted settings), framer-motion 14, Tailwind 4, lucide-react, Vitest 5 (+ jsdom per file).

**Spec:** `docs/superpowers/specs/2026-10-08-chromatic-tuner-design.md`

**Provenance:** every code block was prototyped before this plan was written, and the whole plan (Tasks 1–8) was then applied mechanically to a throwaway worktree of `tuner`: `tsc -b`, `vitest run` (122 files, 1214 tests), `oxlint` and `vite build` all passed. Measured: sines 27.5–2000 Hz at 44.1/48 kHz within 0.03 cent; 0.14 ms per 4096-sample frame. Copy the blocks as they are; Task 9 (the browser) was not run.

## Global Constraints

- Frontend + docs only. Backend, `firestore.rules`, `storage.rules` untouched. No new dependencies.
- Everything runs in the browser: works for guests, no account, no cloud calls; only the A4 setting is stored (device-local, never in `SYNCED_KEYS`).
- Every UI string has `uk` (informal «ти») and `en` entries.
- After every task, from `frontend/`: `npx tsc -b && npx vitest run && npx oxlint && npx vite build` pass.
- One commit per task on branch `tuner`, message ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push or deploy without the owner's go-ahead.
- Match the surrounding code: pure logic in `lib/`, tests next to code (`*.test.ts[x]`, jsdom via a first-line `// @vitest-environment jsdom`), React hooks tested with `createRoot` + `act` (no testing-library), extensionless imports.
- Run commands from `frontend/` (paths below are relative to the repo root).

## Review Focus

1. Leaving the page or pressing «Зупинити» while the browser's permission prompt is open → the microphone granted afterwards is released at once (mic indicator off). Pinned in Task 5 (`stop() while the browser asks…`).
2. The microphone disappears mid-session (unplugged, taken by a call) → an error with «Почати знову», never a frozen needle. Pinned in Task 5 (`a microphone that goes away…`).
3. A half-typed or odd A4 («4», «1000», «abc», «441,6», empty) → nothing applies until Enter / leaving the field, then clamped to 400–480; junk is dropped. Pinned in Task 7 (`A4Control.test.tsx`).
4. iOS keeps the `AudioContext` suspended after the permission prompt → it resumes on the next tap. Pinned in Task 4 (`resumes a suspended context…`).
5. Leaving the page while the reference tone sounds → silence. Pinned in Task 4 (`dispose stops the tone…`) and checked in the browser in Task 9.

---

### Task 1: Note math and display helpers

**Files:**
- Create: `frontend/src/lib/tuner/notes.ts`
- Test: `frontend/src/lib/tuner/notes.test.ts`

**Interfaces:**
- Consumes: `pcToName(pc, spelling)`, `type Spelling` from `frontend/src/lib/music/notes.ts`; `type Accidentals`, `type Lang` from `frontend/src/store.ts`.
- Produces:
  - `A4_DEFAULT = 440`, `A4_MIN = 400`, `A4_MAX = 480`, `IN_TUNE_CENTS = 5`
  - `clampA4(hz: number): number`
  - `interface NearestNote { midi: number; cents: number }`; `hzToNote(hz: number, a4: number): NearestNote`
  - `noteHz(midi: number, a4: number): number`
  - `noteName(midi: number, spelling: Spelling): { name: string; octave: number }`
  - `tunerSpelling(accidentals: Accidentals): Spelling`
  - `isInTune(cents: number): boolean`; `formatHz(hz: number, lang: Lang): string`; `formatCents(cents: number): string`

- [ ] **Step 1: Write the failing test** — `frontend/src/lib/tuner/notes.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { A4_DEFAULT, clampA4, formatCents, formatHz, hzToNote, isInTune, noteHz, noteName, tunerSpelling } from './notes'

describe('hzToNote', () => {
  it('A4 = 440: exact notes have 0 cents', () => {
    expect(hzToNote(440, 440)).toEqual({ midi: 69, cents: 0 })
    expect(hzToNote(82.40689, 440)).toEqual({ midi: 40, cents: 0 })
    expect(hzToNote(261.6256, 440)).toEqual({ midi: 60, cents: 0 })
  })
  it('a moved A4 moves every note', () => {
    expect(hzToNote(442, 442)).toEqual({ midi: 69, cents: 0 })
    expect(hzToNote(440, 442)).toEqual({ midi: 69, cents: -7.9 })
  })
  it('reports the deviation in tenths of a cent', () => {
    expect(hzToNote(110 * 2 ** (12 / 1200), 440)).toEqual({ midi: 45, cents: 12 })
    expect(hzToNote(440 * 2 ** (-3.04 / 1200), 440)).toEqual({ midi: 69, cents: -3 })
  })
  it('just under half way stays, just over goes to the next note', () => {
    expect(hzToNote(440 * 2 ** (49.9 / 1200), 440)).toEqual({ midi: 69, cents: 49.9 })
    expect(hzToNote(440 * 2 ** (50.1 / 1200), 440)).toEqual({ midi: 70, cents: -49.9 })
    expect(hzToNote(440 * 2 ** (-50.1 / 1200), 440)).toEqual({ midi: 68, cents: 49.9 })
  })
})

describe('noteHz', () => {
  it('inverts hzToNote', () => {
    expect(noteHz(69, 440)).toBe(440)
    expect(noteHz(57, 440)).toBeCloseTo(220, 9)
    expect(noteHz(69, 432)).toBe(432)
    expect(noteHz(40, 440)).toBeCloseTo(82.40689, 4)
  })
})

describe('noteName', () => {
  it('spells by the setting and numbers octaves from C', () => {
    expect(noteName(70, 'sharp')).toEqual({ name: 'A#', octave: 4 })
    expect(noteName(70, 'flat')).toEqual({ name: 'Bb', octave: 4 })
    expect(noteName(59, 'sharp')).toEqual({ name: 'B', octave: 3 })
    expect(noteName(60, 'sharp')).toEqual({ name: 'C', octave: 4 })
    expect(noteName(28, 'sharp')).toEqual({ name: 'E', octave: 1 })
  })
  it('flats only when the user chose flats', () => {
    expect(tunerSpelling('flat')).toBe('flat')
    expect(tunerSpelling('sharp')).toBe('sharp')
    expect(tunerSpelling('auto')).toBe('sharp')
  })
})

describe('clampA4', () => {
  it('keeps A4 within 400..480 whole hertz', () => {
    expect(clampA4(442)).toBe(442)
    expect(clampA4(441.6)).toBe(442)
    expect(clampA4(300)).toBe(400)
    expect(clampA4(999)).toBe(480)
    expect(clampA4(Number.NaN)).toBe(A4_DEFAULT)
  })
})

describe('display', () => {
  it('«in tune» within ±5 cents', () => {
    expect(isInTune(5)).toBe(true)
    expect(isInTune(-5)).toBe(true)
    expect(isInTune(5.1)).toBe(false)
  })
  it('hertz with one decimal in the language\'s style, no grouping', () => {
    expect(formatHz(82.40689, 'uk')).toBe('82,4')
    expect(formatHz(82.40689, 'en')).toBe('82.4')
    expect(formatHz(1318.51, 'uk')).toBe('1318,5')
  })
  it('signed whole cents with a true minus', () => {
    expect(formatCents(7.4)).toBe('+7')
    expect(formatCents(-12.2)).toBe('−12')
    expect(formatCents(0.3)).toBe('0')
    expect(formatCents(-0.4)).toBe('0')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/tuner/notes.test.ts`
Expected: FAIL — `Failed to resolve import "./notes"`.

- [ ] **Step 3: Implement** — `frontend/src/lib/tuner/notes.ts`:

```ts
// Notes for the tuner: a frequency against the equal-tempered note nearest to it, for a movable A4.

import { pcToName, type Spelling } from '../music/notes'
import type { Accidentals, Lang } from '../../store'

export const A4_DEFAULT = 440
export const A4_MIN = 400
export const A4_MAX = 480
/** within this many cents of the note the tuner shows «in tune» */
export const IN_TUNE_CENTS = 5

/** A4 within A4_MIN..A4_MAX in whole hertz; anything unreadable is the default. */
export function clampA4(hz: number): number {
  if (!Number.isFinite(hz)) return A4_DEFAULT
  return Math.min(A4_MAX, Math.max(A4_MIN, Math.round(hz)))
}

export interface NearestNote {
  midi: number
  /** deviation from that note, -50..+50 in 0.1 steps (exactly half way belongs to the note above) */
  cents: number
}

export function hzToNote(hz: number, a4: number): NearestNote {
  const exact = 69 + 12 * Math.log2(hz / a4)
  const midi = Math.round(exact)
  // + 0: no "-0"
  return { midi, cents: Math.round((exact - midi) * 1000) / 10 + 0 }
}

export function noteHz(midi: number, a4: number): number {
  return a4 * 2 ** ((midi - 69) / 12)
}

/** "C#" / "Db" and the scientific octave (middle C = C4). */
export function noteName(midi: number, spelling: Spelling): { name: string; octave: number } {
  return { name: pcToName(midi, spelling), octave: Math.floor(midi / 12) - 1 }
}

/** The tuner spells with flats only when the user chose flats; "auto" has no key to follow here. */
export function tunerSpelling(accidentals: Accidentals): Spelling {
  return accidentals === 'flat' ? 'flat' : 'sharp'
}

export function isInTune(cents: number): boolean {
  return Math.abs(cents) <= IN_TUNE_CENTS
}

/** "82,4" / "82.4": one decimal, the language's decimal mark, no grouping. */
export function formatHz(hz: number, lang: Lang): string {
  return new Intl.NumberFormat(lang === 'uk' ? 'uk-UA' : 'en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false,
  }).format(hz)
}

/** "+7", "−12" (a true minus sign), "0": whole cents. */
export function formatCents(cents: number): string {
  const r = Math.round(cents)
  return r > 0 ? `+${r}` : r < 0 ? `−${-r}` : '0'
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/lib/tuner/notes.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Full checks** — `npx tsc -b && npx vitest run && npx oxlint && npx vite build` → all pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/tuner/notes.ts frontend/src/lib/tuner/notes.test.ts
git commit -m "feat(tuner): note math against a movable A4, display helpers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pitch detector (McLeod Pitch Method)

**Files:**
- Create: `frontend/src/lib/tuner/pitch.ts`
- Test: `frontend/src/lib/tuner/pitch.test.ts`

**Interfaces:**
- Consumes: `RealFFT` from `frontend/src/lib/engine/core/fft.ts` (`new RealFFT(n)`, `forward(x, outRe, outIm)` → spectrum bins 0..n/2); test helpers `addTone`, `rng` from `frontend/src/lib/engine/testing/synth.ts`.
- Produces:
  - `interface PitchEstimate { hz: number; clarity: number }`
  - `MIN_HZ = 25`, `MAX_HZ = 2100`
  - `interface PitchDetector { readonly size: number; detect(frame: Float32Array, sampleRate: number): PitchEstimate | null }`
  - `createPitchDetector(size: number): PitchDetector`

How it works (for the reviewer): the autocorrelation comes from one zero-padded `RealFFT` of the frame and a second forward `RealFFT` of the (real, even) power spectrum, which equals `n · r(τ)`. The NSDF is `2 r(τ) / m(τ)`, with `m(τ)` updated lag by lag. The first key maximum ≥ 0.9 × the highest wins and is refined by a parabola. A winning period shorter than `MAX_HZ` allows returns `null`, not its octave below.

- [ ] **Step 1: Write the failing test** — `frontend/src/lib/tuner/pitch.test.ts`:

```ts
// The tuner's pitch detector on synthetic frames: sines across the range at both common sample rates,
// tones rich in overtones (no octave errors), a detuned note, a plucked note, and frames with no pitch.
import { describe, expect, it } from 'vitest'
import { addTone, rng } from '../engine/testing/synth'
import { createPitchDetector } from './pitch'

const SIZE = 4096
const cents = (hz: number, ref: number) => 1200 * Math.log2(hz / ref)

/** sum of sines k·hz with amplitudes amps[k-1] */
function partials(hz: number, sr: number, amps: number[]): Float32Array {
  const x = new Float32Array(SIZE)
  amps.forEach((a, k) => {
    const w = (2 * Math.PI * hz * (k + 1)) / sr
    for (let i = 0; i < SIZE; i++) x[i] += a * Math.sin(w * i + 0.3 + k)
  })
  return x
}

const detector = createPitchDetector(SIZE)

describe('createPitchDetector', () => {
  for (const sr of [44100, 48000]) {
    for (const hz of [27.5, 41.2, 82.41, 110, 196, 440, 1318.5, 2000]) {
      it(`a ${hz} Hz sine at ${sr} Hz is within 1 cent`, () => {
        const r = detector.detect(partials(hz, sr, [0.5]), sr)
        expect(r).not.toBeNull()
        expect(Math.abs(cents(r!.hz, hz))).toBeLessThan(1)
        expect(r!.clarity).toBeGreaterThan(0.99)
      })
    }
  }

  it('a sawtooth (every overtone) is not read an octave off', () => {
    const r = detector.detect(partials(82.41, 48000, Array.from({ length: 20 }, (_, k) => 0.3 / (k + 1))), 48000)
    expect(Math.abs(cents(r!.hz, 82.41))).toBeLessThan(1)
  })

  it('a fundamental weaker than its 2nd harmonic is still the pitch', () => {
    const r = detector.detect(partials(82.41, 48000, [0.15, 0.3, 0.2, 0.1, 0.05]), 48000)
    expect(Math.abs(cents(r!.hz, 82.41))).toBeLessThan(1)
  })

  it('measures a detuned note: A2 + 12 cents', () => {
    const r = detector.detect(partials(110 * 2 ** (12 / 1200), 48000, [0.5, 0.25]), 48000)
    expect(cents(r!.hz, 110)).toBeCloseTo(12, 0)
  })

  it('a plucked E2 (+12 cents) 50 ms after the attack is within 1 cent', () => {
    const sr = 48000
    const audio = new Float32Array(sr)
    addTone(audio, sr, 40, 0, 1, { amp: 0.4, partials: 8, cents: 12 })
    const noise = rng(3)
    for (let i = 0; i < audio.length; i++) audio[i] += 0.003 * (2 * noise() - 1)
    const at = Math.round(0.05 * sr)
    const r = detector.detect(audio.subarray(at, at + SIZE), sr)
    expect(cents(r!.hz, 82.40689) - 12).toBeLessThan(1)
    expect(cents(r!.hz, 82.40689) - 12).toBeGreaterThan(-1)
  })

  it('silence, noise and pitches out of range give nothing', () => {
    expect(detector.detect(new Float32Array(SIZE), 48000)).toBeNull()
    const noise = rng(9)
    expect(detector.detect(Float32Array.from({ length: SIZE }, () => noise() - 0.5), 48000)).toBeNull()
    expect(detector.detect(partials(3000, 48000, [0.5]), 48000)).toBeNull()
    expect(detector.detect(partials(20, 48000, [0.5]), 48000)).toBeNull()
  })

  it('accepts a frame shorter than its size', () => {
    const r = detector.detect(partials(440, 48000, [0.5]).subarray(0, 2048), 48000)
    expect(Math.abs(cents(r!.hz, 440))).toBeLessThan(1)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/tuner/pitch.test.ts`
Expected: FAIL — `Failed to resolve import "./pitch"`.

- [ ] **Step 3: Implement** — `frontend/src/lib/tuner/pitch.ts`:

```ts
// Pitch of a monophonic frame by the McLeod Pitch Method (McLeod & Wyvill, "A smarter way to find
// pitch", 2005): the normalized square difference function (NSDF) from an FFT autocorrelation, the
// first "key maximum" close to the highest one, refined by a parabola through its neighbours.

import { RealFFT } from '../engine/core/fft'

export interface PitchEstimate {
  hz: number
  /** height of the chosen NSDF peak, 0..1 (1 = perfectly periodic) */
  clarity: number
}

/** detection range: below the lowest 5-string bass note (B0 ≈ 30.9 Hz) to above a violin's E7 */
export const MIN_HZ = 25
export const MAX_HZ = 2100
/** the first key maximum at least this share of the highest one wins (lower = more octave-down errors) */
const KEY_SHARE = 0.9
/** weaker peaks are noise, not a pitch */
const MIN_CLARITY = 0.5

export interface PitchDetector {
  /** frame length the detector was built for (the frame may be shorter, never longer) */
  readonly size: number
  detect(frame: Float32Array, sampleRate: number): PitchEstimate | null
}

/** Buffers are allocated once: one detector serves every frame of a session. */
export function createPitchDetector(size: number): PitchDetector {
  const n = size * 2 // zero-padded: the circular autocorrelation equals the linear one for lags < size
  const fft = new RealFFT(n)
  const padded = new Float64Array(n)
  const power = new Float64Array(n)
  const re = new Float64Array(n / 2 + 1)
  const im = new Float64Array(n / 2 + 1)
  const nsdf = new Float64Array(size)

  function detect(frame: Float32Array, sampleRate: number): PitchEstimate | null {
    const w = Math.min(frame.length, size)
    // autocorrelation r(τ) = IFFT(|X|²); |X|² is real and even, so its forward FFT is n·r(τ)
    padded.fill(0)
    for (let i = 0; i < w; i++) padded[i] = frame[i]
    fft.forward(padded, re, im)
    for (let k = 0; k <= n / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k]
      power[k] = p
      if (k > 0 && k < n / 2) power[n - k] = p
    }
    fft.forward(power, re, im)

    // NSDF n(τ) = 2 r(τ) / m(τ), m(τ) = Σ x[j]² + x[j+τ]² over the overlap, updated lag by lag
    const limit = w - 2
    let m = 0
    for (let i = 0; i < w; i++) m += 2 * frame[i] * frame[i]
    if (m <= 1e-12) return null
    for (let tau = 0; tau <= limit + 1; tau++) {
      if (tau > 0) m -= frame[tau - 1] * frame[tau - 1] + frame[w - tau] * frame[w - tau]
      nsdf[tau] = m > 1e-12 ? (2 * re[tau]) / n / m : 0
    }

    // key maxima: the highest point of each positive lobe after the first negative-going zero crossing
    const minLag = Math.max(2, Math.floor(sampleRate / MAX_HZ))
    const maxLag = Math.min(limit, Math.ceil(sampleRate / MIN_HZ))
    const peaks: number[] = []
    let tau = 1
    while (tau <= limit && nsdf[tau] > 0) tau++
    while (tau <= limit) {
      while (tau <= limit && nsdf[tau] <= 0) tau++
      let peak = -1
      while (tau <= limit && nsdf[tau] > 0) {
        if (peak < 0 || nsdf[tau] > nsdf[peak]) peak = tau
        tau++
      }
      if (peak < 0 || peak > maxLag || tau > limit) break
      peaks.push(peak)
    }
    if (!peaks.length) return null
    let highest = 0
    for (const p of peaks) highest = Math.max(highest, nsdf[p])
    const best = peaks.find((p) => nsdf[p] >= KEY_SHARE * highest)!
    // a period shorter than MAX_HZ allows: out of range (not its octave below)
    if (best < minLag) return null

    // parabola through the peak and its neighbours: sub-sample lag and height
    const a = nsdf[best - 1]
    const b = nsdf[best]
    const c = nsdf[best + 1]
    const den = a - 2 * b + c
    const shift = den < 0 ? (0.5 * (a - c)) / den : 0
    const clarity = Math.min(1, b - 0.25 * (a - c) * shift)
    if (clarity < MIN_CLARITY) return null
    return { hz: sampleRate / (best + shift), clarity }
  }

  return { size, detect }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/lib/tuner/pitch.test.ts`
Expected: PASS (22 tests).

- [ ] **Step 5: Full checks** — `npx tsc -b && npx vitest run && npx oxlint && npx vite build` → all pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/tuner/pitch.ts frontend/src/lib/tuner/pitch.test.ts
git commit -m "feat(tuner): McLeod pitch detector over the FFT autocorrelation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Display stabilizer

**Files:**
- Create: `frontend/src/lib/tuner/stabilizer.ts`
- Test: `frontend/src/lib/tuner/stabilizer.test.ts`

**Interfaces:**
- Consumes: `hzToNote` (Task 1), `type PitchEstimate` (Task 2).
- Produces:
  - `interface TunerReading { hz: number; midi: number; cents: number }`
  - `GATE_RMS` (−50 dBFS), `STEADY_CLARITY = 0.9`, `MEDIAN_OF = 5`, `CONFIRM_FRAMES = 3`, `HOLD_MS = 600`
  - `interface Stabilizer { push(estimate: PitchEstimate | null, rms: number, nowMs: number, a4: number): TunerReading | null; reset(): void }`
  - `createStabilizer(): Stabilizer`

- [ ] **Step 1: Write the failing test** — `frontend/src/lib/tuner/stabilizer.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createStabilizer, GATE_RMS, HOLD_MS } from './stabilizer'

const LOUD = 0.1
const est = (hz: number, clarity = 0.98) => ({ hz, clarity })
const A3 = 220
const A3_SHARP = 220 * 2 ** (10 / 1200)

describe('stabilizer', () => {
  it('shows a note only after it holds for 3 frames', () => {
    const s = createStabilizer()
    expect(s.push(est(A3), LOUD, 0, 440)).toBeNull()
    expect(s.push(est(A3), LOUD, 16, 440)).toBeNull()
    expect(s.push(est(A3), LOUD, 32, 440)).toEqual({ hz: A3, midi: 57, cents: 0 })
  })

  it('follows the note frame by frame once shown', () => {
    const s = createStabilizer()
    for (let i = 0; i < 3; i++) s.push(est(A3), LOUD, i * 16, 440)
    for (let i = 3; i < 8; i++) s.push(est(A3_SHARP), LOUD, i * 16, 440)
    expect(s.push(est(A3_SHARP), LOUD, 128, 440)).toMatchObject({ midi: 57, cents: 10 })
  })

  it('a single outlier does not move the reading (median of 5)', () => {
    const s = createStabilizer()
    for (let i = 0; i < 5; i++) s.push(est(A3), LOUD, i * 16, 440)
    expect(s.push(est(A3 * 2), LOUD, 80, 440)).toMatchObject({ midi: 57, cents: 0 })
  })

  it('switches to a new note only after it wins 3 frames in a row', () => {
    const s = createStabilizer()
    for (let i = 0; i < 5; i++) s.push(est(A3), LOUD, i * 16, 440)
    const E3 = 164.81
    const seen = [5, 6, 7, 8, 9, 10].map((i) => s.push(est(E3), LOUD, i * 16, 440)?.midi)
    // the median turns at the 3rd new frame, the note then needs 3 frames: 6 frames in all
    expect(seen).toEqual([57, 57, 57, 57, 52, 52])
  })

  it('treats quiet or unclear frames as silence', () => {
    const s = createStabilizer()
    for (let i = 0; i < 3; i++) expect(s.push(est(A3), GATE_RMS / 2, i * 16, 440)).toBeNull()
    for (let i = 0; i < 3; i++) expect(s.push(est(A3, 0.6), LOUD, i * 16, 440)).toBeNull()
    for (let i = 0; i < 3; i++) expect(s.push(null, LOUD, i * 16, 440)).toBeNull()
  })

  it('holds the last reading for HOLD_MS of silence, then lets go and starts afresh', () => {
    const s = createStabilizer()
    for (let i = 0; i < 3; i++) s.push(est(A3), LOUD, i * 16, 440)
    expect(s.push(null, 0, 32 + HOLD_MS, 440)).toMatchObject({ midi: 57 })
    expect(s.push(null, 0, 32 + HOLD_MS + 1, 440)).toBeNull()
    expect(s.push(est(A3), LOUD, 1000, 440)).toBeNull()
  })

  it('reads against the current A4', () => {
    const s = createStabilizer()
    for (let i = 0; i < 3; i++) s.push(est(440), LOUD, i * 16, 440)
    expect(s.push(est(440), LOUD, 48, 442)).toMatchObject({ midi: 69, cents: -7.9 })
  })

  it('reset forgets the shown note', () => {
    const s = createStabilizer()
    for (let i = 0; i < 3; i++) s.push(est(A3), LOUD, i * 16, 440)
    s.reset()
    expect(s.push(est(A3), LOUD, 64, 440)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/tuner/stabilizer.test.ts`
Expected: FAIL — `Failed to resolve import "./stabilizer"`.

- [ ] **Step 3: Implement** — `frontend/src/lib/tuner/stabilizer.ts`:

```ts
// Steadies the detector's raw estimates for the display: a level and clarity gate, a short median, a
// new note shown only once it wins several frames in a row, and a brief hold when the sound stops.

import { hzToNote } from './notes'
import type { PitchEstimate } from './pitch'

export interface TunerReading {
  /** median frequency of the last frames, Hz */
  hz: number
  midi: number
  /** deviation from `midi`, -50..+50 */
  cents: number
}

/** quieter frames are silence: −50 dBFS */
export const GATE_RMS = 10 ** (-50 / 20)
/** less periodic frames are not a steady pitch (a pluck's attack, speech, noise) */
export const STEADY_CLARITY = 0.9
export const MEDIAN_OF = 5
export const CONFIRM_FRAMES = 3
export const HOLD_MS = 600

export interface Stabilizer {
  /** One frame: the detector's estimate (null = none), the frame's RMS, its time in ms and the current A4. */
  push(estimate: PitchEstimate | null, rms: number, nowMs: number, a4: number): TunerReading | null
  /** forget everything (after a pause, a stop) */
  reset(): void
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function createStabilizer(): Stabilizer {
  let recent: number[] = []
  let shown: TunerReading | null = null
  let lastHeard = -Infinity
  let candidate: number | null = null
  let streak = 0

  function reset() {
    recent = []
    shown = null
    lastHeard = -Infinity
    candidate = null
    streak = 0
  }

  function push(estimate: PitchEstimate | null, rms: number, nowMs: number, a4: number): TunerReading | null {
    if (!estimate || rms < GATE_RMS || estimate.clarity < STEADY_CLARITY) {
      if (shown && nowMs - lastHeard <= HOLD_MS) return shown
      reset()
      return null
    }
    lastHeard = nowMs
    recent.push(estimate.hz)
    if (recent.length > MEDIAN_OF) recent.shift()
    const hz = median(recent)
    const { midi, cents } = hzToNote(hz, a4)
    if (shown?.midi === midi) {
      candidate = null
      streak = 0
      shown = { hz, midi, cents }
      return shown
    }
    // another note: it shows once it has held for CONFIRM_FRAMES frames in a row
    streak = candidate === midi ? streak + 1 : 1
    candidate = midi
    if (streak >= CONFIRM_FRAMES) {
      candidate = null
      streak = 0
      shown = { hz, midi, cents }
    }
    return shown
  }

  return { push, reset }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/lib/tuner/stabilizer.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Full checks** — `npx tsc -b && npx vitest run && npx oxlint && npx vite build` → all pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/tuner/stabilizer.ts frontend/src/lib/tuner/stabilizer.test.ts
git commit -m "feat(tuner): steady readings — level gate, median, note confirmation, hold" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Microphone input and reference tone (Web Audio)

**Files:**
- Create: `frontend/src/lib/tuner/session.ts`, `frontend/src/lib/tuner/tone.ts`
- Test: `frontend/src/lib/tuner/session.test.ts`, `frontend/src/lib/tuner/tone.test.ts`

**Interfaces:**
- Consumes: `CaptureError` from `frontend/src/lib/live` (the module's entry point; codes `denied | blocked | no-audio | unsupported | insecure | no-device | failed`).
- Produces:
  - `session.ts`: `FRAME_SIZE = 4096`; `audioContextCtor(): (new (o?: AudioContextOptions) => AudioContext) | undefined`; `interface TunerInput { readonly sampleRate: number; read(into: Float32Array<ArrayBuffer>): number /* RMS */; stop(): void }`; `startTuner(stream: MediaStream): TunerInput` (throws `CaptureError('unsupported')` without Web Audio).
  - `tone.ts`: `TONE_LOW = 36` (C2), `TONE_HIGH = 84` (C6), `TONE_GAIN = 0.25`, `FADE_S = 0.02`; `clampToneMidi(midi: number): number`; `interface ReferenceTone { readonly playing: boolean; play(hz: number): void; stop(): void; dispose(): void }`; `createReferenceTone(): ReferenceTone`.

Note: the tone does not follow the player's `muted` setting (a deviation from the spec draft, now updated in the spec): it sounds only on an explicit press, and a silent «Грати» would look broken.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/tuner/session.test.ts`:

```ts
// @vitest-environment jsdom
// The tuner's microphone graph against a fake Web Audio: window size, reading a frame, the iOS unlock,
// and a stop that releases the microphone exactly once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureError } from '../live'
import { FRAME_SIZE, startTuner } from './session'

class FakeNode {
  connect = vi.fn()
  disconnect = vi.fn()
}
class FakeAnalyser extends FakeNode {
  fftSize = 2048
  smoothingTimeConstant = 0.8
  data = new Float32Array(FRAME_SIZE)
  getFloatTimeDomainData(into: Float32Array) {
    into.set(this.data.subarray(0, into.length))
  }
}
class FakeContext {
  static last: FakeContext
  static startState: AudioContextState = 'running'
  sampleRate = 48000
  state: AudioContextState = FakeContext.startState
  destination = {}
  analyser = new FakeAnalyser()
  source = new FakeNode()
  resume = vi.fn(async () => {
    this.state = 'running'
  })
  close = vi.fn(async () => {
    this.state = 'closed'
  })
  constructor() {
    FakeContext.last = this
  }
  createMediaStreamSource() {
    return this.source
  }
  createAnalyser() {
    return this.analyser
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: { value: 1 } })
  }
}

function fakeStream() {
  const track = { stop: vi.fn() }
  return { track, stream: { getTracks: () => [track] } as unknown as MediaStream }
}

beforeEach(() => {
  FakeContext.startState = 'running'
  vi.stubGlobal('AudioContext', FakeContext)
})
afterEach(() => vi.unstubAllGlobals())

describe('startTuner', () => {
  it('reads FRAME_SIZE-sample windows with no smoothing, wired silently to the speakers', () => {
    const input = startTuner(fakeStream().stream)
    const ctx = FakeContext.last
    expect(input.sampleRate).toBe(48000)
    expect(ctx.analyser.fftSize).toBe(FRAME_SIZE)
    expect(ctx.analyser.smoothingTimeConstant).toBe(0)
    expect(ctx.source.connect).toHaveBeenCalledWith(ctx.analyser)
  })

  it('read() copies the newest window and returns its RMS', () => {
    const input = startTuner(fakeStream().stream)
    FakeContext.last.analyser.data.fill(0.5)
    const frame = new Float32Array(FRAME_SIZE)
    expect(input.read(frame)).toBeCloseTo(0.5, 6)
    expect(frame[FRAME_SIZE - 1]).toBe(0.5)
  })

  it('resumes a suspended context at once and on the next tap, not after stop', () => {
    FakeContext.startState = 'suspended'
    const input = startTuner(fakeStream().stream)
    const ctx = FakeContext.last
    expect(ctx.resume).toHaveBeenCalledTimes(1)
    ctx.state = 'suspended' // iOS suspended it again
    window.dispatchEvent(new Event('pointerdown'))
    expect(ctx.resume).toHaveBeenCalledTimes(2)
    input.stop()
    ctx.state = 'suspended'
    window.dispatchEvent(new Event('pointerdown'))
    expect(ctx.resume).toHaveBeenCalledTimes(2)
  })

  it('stop() releases the microphone and closes the context once', () => {
    const { stream, track } = fakeStream()
    const input = startTuner(stream)
    input.stop()
    input.stop()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(FakeContext.last.source.disconnect).toHaveBeenCalledTimes(1)
    expect(FakeContext.last.close).toHaveBeenCalledTimes(1)
  })

  it('without Web Audio it fails as unsupported', () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', undefined)
    expect(() => startTuner(fakeStream().stream)).toThrow(CaptureError)
    try {
      startTuner(fakeStream().stream)
    } catch (e) {
      expect((e as CaptureError).code).toBe('unsupported')
    }
  })
})
```

`frontend/src/lib/tuner/tone.test.ts`:

```ts
// The reference tone against a fake Web Audio: a click-free start and stop, a glide between notes on the
// same oscillator, and nothing at all where Web Audio is missing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clampToneMidi, createReferenceTone, FADE_S, TONE_GAIN } from './tone'

class FakeParam {
  value = 0
  calls: string[] = []
  setValueAtTime(v: number, t: number) {
    this.calls.push(`set ${v} @${t}`)
    this.value = v
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(`ramp ${v} @${t}`)
  }
  setTargetAtTime(v: number, t: number) {
    this.calls.push(`target ${v} @${t}`)
  }
  cancelScheduledValues(t: number) {
    this.calls.push(`cancel @${t}`)
  }
}
class FakeOsc {
  type = ''
  frequency = new FakeParam()
  onended: (() => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
}
class FakeGain {
  gain = new FakeParam()
  connect = vi.fn()
  disconnect = vi.fn()
}
class FakeContext {
  static made: FakeContext[] = []
  currentTime = 1
  state: AudioContextState = 'running'
  destination = {}
  oscs: FakeOsc[] = []
  gains: FakeGain[] = []
  resume = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
  constructor() {
    FakeContext.made.push(this)
  }
  createOscillator() {
    const o = new FakeOsc()
    this.oscs.push(o)
    return o
  }
  createGain() {
    const g = new FakeGain()
    this.gains.push(g)
    return g
  }
}

beforeEach(() => {
  FakeContext.made = []
  vi.stubGlobal('AudioContext', FakeContext)
})
afterEach(() => vi.unstubAllGlobals())

describe('createReferenceTone', () => {
  it('starts a sine at the note, fading in from silence', () => {
    const tone = createReferenceTone()
    tone.play(440)
    const ctx = FakeContext.made[0]
    expect(ctx.oscs[0].type).toBe('sine')
    expect(ctx.oscs[0].frequency.calls).toEqual(['set 440 @1'])
    expect(ctx.gains[0].gain.calls).toEqual(['set 0 @1', `ramp ${TONE_GAIN} @${1 + FADE_S}`])
    expect(ctx.oscs[0].start).toHaveBeenCalledWith(1)
    expect(tone.playing).toBe(true)
  })

  it('glides the same oscillator to another note', () => {
    const tone = createReferenceTone()
    tone.play(440)
    tone.play(466.16)
    const ctx = FakeContext.made[0]
    expect(ctx.oscs).toHaveLength(1)
    expect(ctx.oscs[0].frequency.calls[1]).toMatch(/^target 466.16 @1$/)
  })

  it('stops with a fade, then frees the nodes', () => {
    const tone = createReferenceTone()
    tone.play(440)
    tone.stop()
    const ctx = FakeContext.made[0]
    expect(ctx.gains[0].gain.calls.at(-1)).toBe(`ramp 0 @${1 + FADE_S}`)
    expect(ctx.oscs[0].stop).toHaveBeenCalledWith(1 + FADE_S + 0.01)
    expect(tone.playing).toBe(false)
    ctx.oscs[0].onended?.()
    expect(ctx.oscs[0].disconnect).toHaveBeenCalled()
    expect(ctx.gains[0].disconnect).toHaveBeenCalled()
  })

  it('a new play after stop starts a fresh oscillator in the same context', () => {
    const tone = createReferenceTone()
    tone.play(440)
    tone.stop()
    tone.play(220)
    expect(FakeContext.made).toHaveLength(1)
    expect(FakeContext.made[0].oscs).toHaveLength(2)
  })

  it('dispose stops the tone and closes the context', () => {
    const tone = createReferenceTone()
    tone.play(440)
    tone.dispose()
    expect(tone.playing).toBe(false)
    expect(FakeContext.made[0].close).toHaveBeenCalledTimes(1)
  })

  it('does nothing without Web Audio', () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', undefined)
    const tone = createReferenceTone()
    expect(() => tone.play(440)).not.toThrow()
    expect(tone.playing).toBe(false)
  })

  it('keeps the picker within C2..C6', () => {
    expect(clampToneMidi(28)).toBe(36)
    expect(clampToneMidi(69)).toBe(69)
    expect(clampToneMidi(96)).toBe(84)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/tuner/session.test.ts src/lib/tuner/tone.test.ts`
Expected: FAIL — `Failed to resolve import "./session"` / `"./tone"`.

- [ ] **Step 3: Implement**

`frontend/src/lib/tuner/session.ts`:

```ts
// The tuner's microphone graph: the stream into an AnalyserNode (silent, nothing reaches the
// speakers); the page reads the newest window once per animation frame.

import { CaptureError } from '../live'

/** samples per detection window: ≈ 85 ms at 48 kHz, three periods of the lowest bass string */
export const FRAME_SIZE = 4096

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext

export function audioContextCtor(): AudioContextCtor | undefined {
  return globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
}

export interface TunerInput {
  readonly sampleRate: number
  /** Copies the newest FRAME_SIZE samples into `into`; returns their RMS level. */
  read(into: Float32Array<ArrayBuffer>): number
  /** Stops the microphone and closes the graph (again: nothing). */
  stop(): void
}

const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend'] as const

export function startTuner(stream: MediaStream): TunerInput {
  const Ctor = audioContextCtor()
  if (!Ctor) throw new CaptureError('unsupported', 'this browser has no Web Audio')
  const ctx = new Ctor({ latencyHint: 'interactive' })
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = FRAME_SIZE
  analyser.smoothingTimeConstant = 0
  // a muted path to the destination keeps the graph pulled in every browser (old Safari skips orphans)
  const silent = ctx.createGain()
  silent.gain.value = 0
  source.connect(analyser)
  analyser.connect(silent)
  silent.connect(ctx.destination)

  // without a user activation left (iOS after the permission prompt) the context can stay suspended:
  // resume it now and on the next tap or key press
  const unlock = () => {
    if (ctx.state === 'suspended') ctx.resume().catch(() => undefined)
  }
  for (const e of UNLOCK_EVENTS) window.addEventListener(e, unlock, { capture: true, passive: true })
  unlock()

  let stopped = false
  return {
    sampleRate: ctx.sampleRate,
    read(into) {
      analyser.getFloatTimeDomainData(into)
      let sum = 0
      for (let i = 0; i < into.length; i++) sum += into[i] * into[i]
      return Math.sqrt(sum / into.length)
    },
    stop() {
      if (stopped) return
      stopped = true
      for (const e of UNLOCK_EVENTS) window.removeEventListener(e, unlock, { capture: true })
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      ctx.close().catch(() => undefined)
    },
  }
}
```

`frontend/src/lib/tuner/tone.ts`:

```ts
// The tuner's reference tone: one sine held until stopped, faded in and out and glided between notes
// so it never clicks. Its own AudioContext, made on the first play() (a click: browsers start audio
// only on a user gesture).

import { audioContextCtor } from './session'

/** the picker's range: C2..C6 */
export const TONE_LOW = 36
export const TONE_HIGH = 84
export const TONE_GAIN = 0.25
/** seconds: fade in / out, and the glide to another note */
export const FADE_S = 0.02
const GLIDE_S = 0.015

export function clampToneMidi(midi: number): number {
  return Math.min(TONE_HIGH, Math.max(TONE_LOW, Math.round(midi)))
}

export interface ReferenceTone {
  readonly playing: boolean
  /** Starts the tone at \`hz\`, or glides the sounding one there. */
  play(hz: number): void
  stop(): void
  /** stop and close the context (leaving the page) */
  dispose(): void
}

export function createReferenceTone(): ReferenceTone {
  let ctx: AudioContext | null = null
  let osc: OscillatorNode | null = null
  let gain: GainNode | null = null

  function play(hz: number) {
    const Ctor = audioContextCtor()
    if (!Ctor) return
    ctx ??= new Ctor({ latencyHint: 'interactive' })
    if (ctx.state === 'suspended') ctx.resume().catch(() => undefined)
    const now = ctx.currentTime
    if (osc) {
      osc.frequency.setTargetAtTime(hz, now, GLIDE_S / 3)
      return
    }
    gain = ctx.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(TONE_GAIN, now + FADE_S)
    gain.connect(ctx.destination)
    osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(hz, now)
    osc.connect(gain)
    osc.start(now)
  }

  function stop() {
    if (!ctx || !osc || !gain) return
    const now = ctx.currentTime
    const o = osc
    const g = gain
    g.gain.cancelScheduledValues(now)
    g.gain.setValueAtTime(g.gain.value, now)
    g.gain.linearRampToValueAtTime(0, now + FADE_S)
    o.onended = () => {
      o.disconnect()
      g.disconnect()
    }
    o.stop(now + FADE_S + 0.01)
    osc = null
    gain = null
  }

  return {
    get playing() {
      return osc !== null
    },
    play,
    stop,
    dispose() {
      stop()
      ctx?.close().catch(() => undefined)
      ctx = null
    },
  }
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/lib/tuner/session.test.ts src/lib/tuner/tone.test.ts`
Expected: PASS (5 + 7 tests).

- [ ] **Step 5: Full checks** — `npx tsc -b && npx vitest run && npx oxlint && npx vite build` → all pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/tuner/session.ts frontend/src/lib/tuner/session.test.ts frontend/src/lib/tuner/tone.ts frontend/src/lib/tuner/tone.test.ts
git commit -m "feat(tuner): microphone analyser input and a click-free reference tone" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `useTuner` — the detection loop

**Files:**
- Create: `frontend/src/components/tuner/useTuner.ts`
- Test: `frontend/src/components/tuner/useTuner.test.ts`

**Interfaces:**
- Consumes: `captureMicrophone`, `CaptureError`, `type CaptureErrorCode` from `frontend/src/lib/live`; `createPitchDetector` (Task 2); `FRAME_SIZE`, `startTuner`, `type TunerInput` (Task 4); `createStabilizer`, `type TunerReading` (Task 3).
- Produces:
  - `type TunerErrorCode = CaptureErrorCode | 'ended'`
  - `type TunerState = { phase: 'idle' } | { phase: 'starting' } | { phase: 'running'; reading: TunerReading | null } | { phase: 'error'; code: TunerErrorCode; detail: string | null }`
  - `sameReading(a: TunerReading | null, b: TunerReading | null): boolean`
  - `useTuner({ a4, paused }: { a4: number; paused: boolean }): { state: TunerState; lastMidi: number | null; start(): Promise<void>; stop(): void }`

- [ ] **Step 1: Write the failing test** — `frontend/src/components/tuner/useTuner.test.ts`:

```ts
// @vitest-environment jsdom
// The tuner loop with a fake microphone and manual animation frames: it shows a held note, waits while
// paused, reports refusals, and always lets the microphone go (stop, leaving, a late grant, unplugging).
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureError, captureMicrophone } from '../../lib/live'
import { FRAME_SIZE, startTuner, type TunerInput } from '../../lib/tuner/session'
import { useTuner } from './useTuner'

vi.mock('../../lib/live', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/live')>()),
  captureMicrophone: vi.fn(),
}))
vi.mock('../../lib/tuner/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tuner/session')>()),
  startTuner: vi.fn(),
}))

const SR = 48000
const A4_FRAME = Float32Array.from({ length: FRAME_SIZE }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR))

function fakeMic() {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() })
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
  return { track, stream }
}
function fakeInput() {
  const read = vi.fn((into: Float32Array) => {
    into.set(A4_FRAME)
    return 0.35
  })
  return { sampleRate: SR, read, stop: vi.fn() } satisfies TunerInput
}

let frames: FrameRequestCallback[] = []
let clock = 0
/** runs the queued animation frames n times */
const step = (n = 1) =>
  act(() => {
    for (let i = 0; i < n; i++) {
      const due = frames
      frames = []
      clock += 16
      due.forEach((cb) => cb(clock))
    }
  })

let root: Root
/** what the hook returned on the latest render */
const seen = {} as { hook: ReturnType<typeof useTuner> }
function Probe({ paused = false }: { paused?: boolean }) {
  const hook = useTuner({ a4: 440, paused })
  useEffect(() => {
    seen.hook = hook
  })
  return null
}
const render = (paused = false) => act(() => root.render(createElement(Probe, { paused })))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  frames = []
  clock = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = []
  })
  root = createRoot(document.createElement('div'))
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  vi.mocked(captureMicrophone).mockReset()
  vi.mocked(startTuner).mockReset()
})

describe('useTuner', () => {
  it('starts on start() and shows a note once it has held for a few frames', async () => {
    const mic = fakeMic()
    const input = fakeInput()
    vi.mocked(captureMicrophone).mockResolvedValue(mic.stream)
    vi.mocked(startTuner).mockReturnValue(input)
    await render()
    await act(() => seen.hook.start())
    expect(seen.hook.state).toEqual({ phase: 'running', reading: null })
    step(3)
    expect(seen.hook.state).toMatchObject({ phase: 'running', reading: { midi: 69, cents: 0 } })
    expect(seen.hook.lastMidi).toBe(69)
  })

  it('does not listen while paused', async () => {
    vi.mocked(captureMicrophone).mockResolvedValue(fakeMic().stream)
    const input = fakeInput()
    vi.mocked(startTuner).mockReturnValue(input)
    await render(true)
    await act(() => seen.hook.start())
    step(5)
    expect(input.read).not.toHaveBeenCalled()
    expect(seen.hook.state).toEqual({ phase: 'running', reading: null })
  })

  it('a refused microphone is an error with its code', async () => {
    vi.mocked(captureMicrophone).mockRejectedValue(new CaptureError('denied'))
    await render()
    await act(() => seen.hook.start())
    expect(seen.hook.state).toEqual({ phase: 'error', code: 'denied', detail: null })
  })

  it('stop() while the browser asks releases the microphone granted afterwards', async () => {
    const mic = fakeMic()
    let grant!: (s: MediaStream) => void
    vi.mocked(captureMicrophone).mockReturnValue(new Promise((r) => (grant = r)))
    await render()
    let started!: Promise<void>
    act(() => {
      started = seen.hook.start()
    })
    expect(seen.hook.state).toEqual({ phase: 'starting' })
    act(() => seen.hook.stop())
    await act(async () => {
      grant(mic.stream)
      await started
    })
    expect(mic.track.stop).toHaveBeenCalled()
    expect(startTuner).not.toHaveBeenCalled()
    expect(seen.hook.state).toEqual({ phase: 'idle' })
  })

  it('leaving the page stops the microphone', async () => {
    vi.mocked(captureMicrophone).mockResolvedValue(fakeMic().stream)
    const input = fakeInput()
    vi.mocked(startTuner).mockReturnValue(input)
    await render()
    await act(() => seen.hook.start())
    act(() => root.unmount())
    expect(input.stop).toHaveBeenCalled()
    root = createRoot(document.createElement('div'))
  })

  it('a microphone that goes away ends with an error and is released', async () => {
    const mic = fakeMic()
    vi.mocked(captureMicrophone).mockResolvedValue(mic.stream)
    const input = fakeInput()
    vi.mocked(startTuner).mockReturnValue(input)
    await render()
    await act(() => seen.hook.start())
    act(() => {
      mic.track.dispatchEvent(new Event('ended'))
    })
    expect(input.stop).toHaveBeenCalled()
    expect(seen.hook.state).toEqual({ phase: 'error', code: 'ended', detail: null })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/components/tuner/useTuner.test.ts`
Expected: FAIL — `Failed to resolve import "./useTuner"`.

- [ ] **Step 3: Implement** — `frontend/src/components/tuner/useTuner.ts`:

```ts
// The tuner page's microphone loop: start() asks for the microphone, then every animation frame reads
// the newest window, detects its pitch and steadies it for the display. It stops on stop(), on leaving
// the page and when the microphone goes away; detection waits while `paused` (the reference tone).

import { useCallback, useEffect, useRef, useState } from 'react'
import { CaptureError, captureMicrophone, type CaptureErrorCode } from '../../lib/live'
import { createPitchDetector } from '../../lib/tuner/pitch'
import { FRAME_SIZE, startTuner, type TunerInput } from '../../lib/tuner/session'
import { createStabilizer, type TunerReading } from '../../lib/tuner/stabilizer'

/** 'ended': the microphone went away while tuning (unplugged, taken by another app) */
export type TunerErrorCode = CaptureErrorCode | 'ended'

export type TunerState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'running'; reading: TunerReading | null }
  | { phase: 'error'; code: TunerErrorCode; detail: string | null }

/** a reading is worth a render when the note changes or the needle moves this far */
const REDRAW_CENTS = 0.5

export function sameReading(a: TunerReading | null, b: TunerReading | null): boolean {
  if (!a || !b) return a === b
  return a.midi === b.midi && Math.abs(a.cents - b.cents) < REDRAW_CENTS
}

function failure(err: unknown): TunerState {
  if (err instanceof CaptureError) return { phase: 'error', code: err.code, detail: err.message !== err.code ? err.message : null }
  return { phase: 'error', code: 'failed', detail: err instanceof Error ? err.message : String(err) }
}

export function useTuner({ a4, paused }: { a4: number; paused: boolean }) {
  const [state, setState] = useState<TunerState>({ phase: 'idle' })
  /** the last note heard this visit (the reference tone's picker starts there) */
  const [lastMidi, setLastMidi] = useState<number | null>(null)
  const input = useRef<TunerInput | null>(null)
  const raf = useRef(0)
  /** bumped by every start and stop: a microphone granted to an abandoned start is released at once */
  const attempt = useRef(0)
  const a4Ref = useRef(a4)
  const pausedRef = useRef(paused)
  useEffect(() => {
    a4Ref.current = a4
    pausedRef.current = paused
  }, [a4, paused])

  const release = useCallback(() => {
    cancelAnimationFrame(raf.current)
    raf.current = 0
    input.current?.stop()
    input.current = null
  }, [])

  const start = useCallback(async () => {
    const id = ++attempt.current
    release()
    setState({ phase: 'starting' })
    let stream: MediaStream
    try {
      stream = await captureMicrophone()
    } catch (err) {
      if (id === attempt.current) setState(failure(err))
      return
    }
    if (id !== attempt.current) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    let tuner: TunerInput
    try {
      tuner = startTuner(stream)
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop())
      setState(failure(err))
      return
    }
    input.current = tuner
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (input.current !== tuner) return
        release()
        setState({ phase: 'error', code: 'ended', detail: null })
      })
    }

    const detector = createPitchDetector(FRAME_SIZE)
    const stabilizer = createStabilizer()
    const frame = new Float32Array(FRAME_SIZE)
    let shown: TunerReading | null = null
    const tick = (now: number) => {
      if (input.current !== tuner) return
      let reading: TunerReading | null = null
      if (pausedRef.current) stabilizer.reset()
      else {
        const rms = tuner.read(frame)
        reading = stabilizer.push(detector.detect(frame, tuner.sampleRate), rms, now, a4Ref.current)
      }
      if (!sameReading(reading, shown)) {
        if (reading && reading.midi !== shown?.midi) setLastMidi(reading.midi)
        shown = reading
        setState({ phase: 'running', reading })
      }
      raf.current = requestAnimationFrame(tick)
    }
    setState({ phase: 'running', reading: null })
    raf.current = requestAnimationFrame(tick)
  }, [release])

  const stop = useCallback(() => {
    attempt.current++
    release()
    setState({ phase: 'idle' })
  }, [release])

  // leaving the page
  useEffect(
    () => () => {
      attempt.current++
      release()
    },
    [release],
  )

  return { state, lastMidi, start, stop }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/components/tuner/useTuner.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Full checks** — `npx tsc -b && npx vitest run && npx oxlint && npx vite build` → all pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/tuner/useTuner.ts frontend/src/components/tuner/useTuner.test.ts
git commit -m "feat(tuner): useTuner runs detection per animation frame and always releases the mic" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Route, A4 setting and strings

**Files:**
- Modify: `frontend/src/hooks/useRoute.ts` (doc comment, `Route`, `paths`, `parseHash`)
- Modify: `frontend/src/hooks/useRoute.test.ts`
- Modify: `frontend/src/store.ts` (`Settings`, `defaultSettings`, `partialize`)
- Modify: `frontend/src/store.persist.test.ts`
- Modify: `frontend/src/lib/syncedSettings.test.ts` (its full `Settings` literal needs the new key, or `tsc` fails)
- Create: `frontend/src/i18n/tuner.ts`, `frontend/src/i18n/tuner.test.ts`
- Modify: `frontend/src/i18n/index.ts` (register `tuner`)

**Interfaces:**
- Produces: `Route` member `{ name: 'tuner' }`; `paths.tuner(): '/tuner'`; setting `tunerA4: number` (default 440, persisted, not synced); i18n keys `tuner.*` (listed in the file below).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/hooks/useRoute.test.ts`:

```ts
describe('tuner route', () => {
  it('round-trips, with or without a trailing slash', () => {
    expect(paths.tuner()).toBe('/tuner')
    expect(parseHash(`#${paths.tuner()}`)).toEqual({ name: 'tuner' })
    expect(parseHash('#/tuner/')).toEqual({ name: 'tuner' })
  })
})
```

In `frontend/src/store.persist.test.ts`, change the header comment's first line to
`// Persisted settings: \`keepAwake\` (the screen stays on while the app is open) and the tuner's \`tunerA4\` are saved on this device only.`
and append:

```ts
describe('tunerA4', () => {
  it('is 440 by default and for settings saved before it existed', async () => {
    expect((await load()).getState().tunerA4).toBe(440)
    localStorage.setItem(KEY, JSON.stringify({ state: { lang: 'en' }, version: 1 }))
    expect((await load()).getState().tunerA4).toBe(440)
  })

  it('is saved and read back on this device', async () => {
    ;(await load()).getState().setSetting('tunerA4', 442)
    expect(JSON.parse(localStorage.getItem(KEY)!).state.tunerA4).toBe(442)
    expect((await load()).getState().tunerA4).toBe(442)
  })
})
```

Create `frontend/src/i18n/tuner.test.ts`:

```ts
// tuner.* strings: every key has a non-empty uk and en entry, and the Ukrainian speaks informally («ти»).
import { describe, expect, it } from 'vitest'
import { tuner } from './tuner'

const L = 'а-яіїєґʼ'
const FORMAL = new RegExp(`(^|[^${L}])(ви|вас|вам|ваш[${L}]*|[${L}]+(іть|айте|уйте|ийте))(?=$|[^${L}])`, 'iu')

describe('tuner texts', () => {
  it('every tuner.* key has a non-empty uk and en entry', () => {
    const keys = new Set([...Object.keys(tuner.uk), ...Object.keys(tuner.en)])
    for (const key of keys) {
      expect(key.startsWith('tuner.'), key).toBe(true)
      expect(tuner.uk[key]?.trim(), `uk ${key}`).toBeTruthy()
      expect(tuner.en[key]?.trim(), `en ${key}`).toBeTruthy()
    }
  })

  it('speaks to the reader informally in Ukrainian («ти», not «ви»)', () => {
    for (const [key, text] of Object.entries(tuner.uk)) expect(FORMAL.test(text), `${key}: ${text}`).toBe(false)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/hooks/useRoute.test.ts src/store.persist.test.ts src/i18n/tuner.test.ts`
Expected: FAIL — `paths.tuner is not a function`, `expected undefined to be 440`, `Failed to resolve import "./tuner"`.

- [ ] **Step 3: Implement**

`frontend/src/hooks/useRoute.ts` — in the doc comment, end the `#/youtube/…` line with ` ·` and add a line after it:

```ts
 * #/youtube/<videoId>[?t=<s>] (pick a fragment of a YouTube video for the cloud, starting at t) ·
 * #/tuner (a chromatic tuner on the microphone)
```

Add the route member after `clip`:

```ts
  | { name: 'clip'; videoId: string; start: number | null }
  | { name: 'tuner' }
  | { name: 'notFound' }
```

Add to `paths` after `demo`:

```ts
  demo: () => '/demo',
  tuner: () => '/tuner',
```

In `parseHash`, after the `/demo` line:

```ts
  if (path === '/demo') return { name: 'demo' }
  if (path === '/tuner') return { name: 'tuner' }
```

`frontend/src/store.ts` — in `Settings`, after `playAlongOffsetMs: number`:

```ts
  /** the tuner's reference pitch A4, Hz (lib/tuner/notes.ts A4_MIN..A4_MAX); this device only */
  tunerA4: number
```

in `defaultSettings`, after `playAlongOffsetMs: 0,`: `tunerA4: 440,`; in `partialize`, after `playAlongOffsetMs: s.playAlongOffsetMs,`: `tunerA4: s.tunerA4,`. Do **not** add it to `SYNCED_KEYS` (`lib/syncedSettings.ts`).

`frontend/src/lib/syncedSettings.test.ts` — in the `local` literal ("every device-only field set to a non-default value"), after `playAlongOffsetMs: -20,` add `tunerA4: 442,`.

`frontend/src/i18n/tuner.ts`:

```ts
import type { Dict } from './index'

// Owned by the tuner (#/tuner, src/components/tuner). Keys prefixed "tuner.".
export const tuner: Dict = {
  uk: {
    'tuner.title': 'Тюнер',
    'tuner.subtitle': 'Зіграй одну ноту — стрілка покаже, наскільки вона вища чи нижча за найближчу. Посередині й зеленим — у строї.',
    'tuner.start': 'Почати',
    'tuner.stop': 'Зупинити',
    'tuner.retry': 'Почати знову',
    'tuner.requesting': 'Дозволь доступ до мікрофона…',
    'tuner.idle': 'Натисни «Почати» й дозволь мікрофон',
    'tuner.playNote': 'Зіграй ноту',
    'tuner.hz': 'Гц',
    'tuner.cents': 'ц',
    'tuner.a4.label': 'Еталон A4',
    'tuner.a4.lower': 'Нижче на 1 Гц',
    'tuner.a4.higher': 'Вище на 1 Гц',
    'tuner.tone.label': 'Еталонний тон',
    'tuner.tone.lower': 'На півтону нижче',
    'tuner.tone.higher': 'На півтону вище',
    'tuner.tone.play': 'Грати',
    'tuner.tone.stop': 'Стоп',
    'tuner.tone.sounding': 'Звучить {note}. Поки грає тон, тюнер не слухає.',
    'tuner.tone.hint': 'Тон звучить, доки його не зупиниш. Підлаштуй струну на слух в унісон із ним.',
    'tuner.error.ended': 'Мікрофон вимкнувся. Підключи його й почни знову.',
    'tuner.aria.dial': '{note}, відхилення {cents} центів',
    'tuner.aria.noNote': 'Ноти не чути',
  },
  en: {
    'tuner.title': 'Tuner',
    'tuner.subtitle': 'Play a single note — the needle shows how far it is above or below the nearest one. Centred and green means in tune.',
    'tuner.start': 'Start',
    'tuner.stop': 'Stop',
    'tuner.retry': 'Start again',
    'tuner.requesting': 'Allow access to the microphone…',
    'tuner.idle': 'Press Start and allow the microphone',
    'tuner.playNote': 'Play a note',
    'tuner.hz': 'Hz',
    'tuner.cents': '¢',
    'tuner.a4.label': 'A4 reference',
    'tuner.a4.lower': '1 Hz lower',
    'tuner.a4.higher': '1 Hz higher',
    'tuner.tone.label': 'Reference tone',
    'tuner.tone.lower': 'A semitone lower',
    'tuner.tone.higher': 'A semitone higher',
    'tuner.tone.play': 'Play',
    'tuner.tone.stop': 'Stop',
    'tuner.tone.sounding': 'Playing {note}. The tuner does not listen while the tone sounds.',
    'tuner.tone.hint': 'The tone sounds until you stop it. Tune the string by ear until it matches.',
    'tuner.error.ended': 'The microphone went away. Reconnect it and start again.',
    'tuner.aria.dial': '{note}, {cents} cents off',
    'tuner.aria.noNote': 'No note heard',
  },
}
```

`frontend/src/i18n/index.ts` — add `import { tuner } from './tuner'` after `import { clip } from './clip'`, and append `tuner` to the `dicts` array: `[core, chords, account, handpan, tempo, web, sound, keys, cloud, live, score, tour, clip, tuner]`.

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/hooks/useRoute.test.ts src/store.persist.test.ts src/i18n/tuner.test.ts`
Expected: PASS.

- [ ] **Step 5: Full checks** — `npx tsc -b && npx vitest run && npx oxlint && npx vite build` → all pass. (`tsc` will flag any exhaustive `switch (route.name)` that needs the new member; `reopenTours` and `tourRouteKey` in `lib/tour/trigger.ts` already fall through to `default`, which is right: no tour on the tuner.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useRoute.ts frontend/src/hooks/useRoute.test.ts frontend/src/store.ts frontend/src/store.persist.test.ts frontend/src/lib/syncedSettings.test.ts frontend/src/i18n/tuner.ts frontend/src/i18n/tuner.test.ts frontend/src/i18n/index.ts
git commit -m "feat(tuner): #/tuner route, device-local A4 setting, tuner strings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The tuner page

**Files:**
- Create: `frontend/src/components/tuner/TunerDial.tsx`, `frontend/src/components/tuner/A4Control.tsx`, `frontend/src/components/tuner/ReferenceToneControl.tsx`, `frontend/src/components/tuner/TunerPage.tsx`
- Test: `frontend/src/components/tuner/A4Control.test.tsx`
- Modify: `frontend/src/App.tsx` (import + `case 'tuner'`)

**Interfaces:**
- Consumes: everything from Tasks 1–6; `Button`, `IconButton` from `frontend/src/components/ui/IconButton.tsx`; `CaptureErrorAlert({ message, detail, className })` from `frontend/src/components/capture/CaptureErrorAlert.tsx`; `canCaptureMicrophone()` from `frontend/src/lib/live`; `useDocumentTitle`, `navigate`, `paths`.
- Produces: `TunerPage()` (no props); `TunerDial({ cents: number | null; inTune: boolean; label: string })`; `A4Control({ value: number; onChange(hz: number): void })`; `ReferenceToneControl({ note, playing, canLower, canRaise, onLower, onRaise, onToggle })`.

- [ ] **Step 1: Write the failing test** — `frontend/src/components/tuner/A4Control.test.tsx`:

```tsx
// @vitest-environment jsdom
// The A4 field: steps of 1 Hz, a typed value only on Enter / leaving the field, clamped; junk is dropped.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { A4Control } from './A4Control'

let root: Root
let host: HTMLDivElement
const onChange = vi.fn()

function render(value: number) {
  act(() => root.render(createElement(A4Control, { value, onChange })))
}
const field = () => host.querySelector('input')!
const button = (n: number) => host.querySelectorAll('button')[n]

/** types into the controlled input the way React notices */
function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), text)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const press = (key: string) => act(() => field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
const leave = () =>
  act(() => {
    field().focus()
    field().blur()
  })

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  onChange.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('A4Control', () => {
  it('− and + move A4 by 1 Hz', () => {
    render(440)
    act(() => button(0).click())
    act(() => button(1).click())
    expect(onChange.mock.calls).toEqual([[439], [441]])
  })

  it('does not apply a half-typed value, only on Enter', () => {
    render(440)
    type('4')
    type('44')
    expect(onChange).not.toHaveBeenCalled()
    type('442')
    press('Enter')
    expect(onChange).toHaveBeenCalledWith(442)
  })

  it('applies on leaving the field, clamped to 400..480, with a comma as decimal mark', () => {
    render(440)
    type('9')
    leave()
    type('1000')
    leave()
    type('441,6')
    leave()
    expect(onChange.mock.calls).toEqual([[400], [480], [442]])
  })

  it('drops junk and an empty field; Escape restores the value', () => {
    render(440)
    type('abc')
    leave()
    type('')
    leave()
    type('450')
    press('Escape')
    expect(onChange).not.toHaveBeenCalled()
    expect(field().value).toBe('440')
  })

  it('the buttons stop at the ends of the range', () => {
    render(400)
    expect(button(0).disabled).toBe(true)
    render(480)
    expect(button(1).disabled).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/components/tuner/A4Control.test.tsx`
Expected: FAIL — `Failed to resolve import "./A4Control"`.

- [ ] **Step 3: Implement the components**

`frontend/src/components/tuner/A4Control.tsx`:

```tsx
// «Еталон A4»: − / + by 1 Hz and a number to type; the typed value counts on Enter or leaving the field
// (clamped to 400..480), so a half-typed "4" never retunes everything to 400 Hz.

import { Minus, Plus } from 'lucide-react'
import { useState } from 'react'
import { useT } from '../../i18n'
import { A4_MAX, A4_MIN, clampA4 } from '../../lib/tuner/notes'
import { IconButton } from '../ui/IconButton'

export function A4Control({ value, onChange }: { value: number; onChange(hz: number): void }) {
  const t = useT()
  const [draft, setDraft] = useState<string | null>(null)

  const commit = () => {
    if (draft === null) return
    const typed = Number(draft.replace(',', '.'))
    setDraft(null)
    if (draft.trim() && Number.isFinite(typed)) onChange(clampA4(typed))
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="mr-1 text-sm text-muted">{t('tuner.a4.label')}</span>
      <IconButton size="sm" label={t('tuner.a4.lower')} disabled={value <= A4_MIN} onClick={() => onChange(clampA4(value - 1))}>
        <Minus className="size-4" />
      </IconButton>
      <input
        type="text"
        inputMode="decimal"
        aria-label={t('tuner.a4.label')}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') setDraft(null)
        }}
        className="h-8 w-14 rounded-lg border border-border-strong bg-surface text-center font-mono text-sm tabular-nums text-text focus-visible:border-accent"
      />
      <IconButton size="sm" label={t('tuner.a4.higher')} disabled={value >= A4_MAX} onClick={() => onChange(clampA4(value + 1))}>
        <Plus className="size-4" />
      </IconButton>
      <span className="text-sm text-muted">{t('tuner.hz')}</span>
    </div>
  )
}
```

`frontend/src/components/tuner/TunerDial.tsx`:

```tsx
// The tuner's meter: an arc from −50 to +50 cents with a tick every 10, the green «in tune» zone, and a
// needle that springs to the deviation (back to the middle, dimmed, when no note is heard).

import clsx from 'clsx'
import { motion } from 'framer-motion'
import { IN_TUNE_CENTS } from '../../lib/tuner/notes'

const CX = 120
const CY = 126
const R = 100
/** ±50 cents span ±60° of the arc */
const SPAN_DEG = 60
const TICKS = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50]

const angle = (cents: number) => (Math.max(-50, Math.min(50, cents)) / 50) * SPAN_DEG

function point(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)]
}

function arc(fromDeg: number, toDeg: number, r: number): string {
  const [x1, y1] = point(fromDeg, r)
  const [x2, y2] = point(toDeg, r)
  return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`
}

export function TunerDial({ cents, inTune, label }: { cents: number | null; inTune: boolean; label: string }) {
  const idle = cents === null
  return (
    <svg viewBox="0 0 240 140" role="img" aria-label={label} className="w-full max-w-[26rem]">
      <path d={arc(-SPAN_DEG, SPAN_DEG, R)} fill="none" className="stroke-border-strong" strokeWidth={2} />
      <path
        d={arc(angle(-IN_TUNE_CENTS), angle(IN_TUNE_CENTS), R)}
        fill="none"
        className={clsx('stroke-success transition-opacity', inTune ? 'opacity-100' : 'opacity-45')}
        strokeWidth={inTune ? 8 : 5}
        strokeLinecap="round"
      />
      {TICKS.map((c) => {
        const [x1, y1] = point(angle(c), R - (c === 0 ? 16 : c % 50 === 0 ? 12 : 8))
        const [x2, y2] = point(angle(c), R - 2)
        return <line key={c} x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-muted" strokeWidth={c === 0 ? 2 : 1} />
      })}
      {[-50, 50].map((c) => {
        const [x, y] = point(angle(c), R - 26)
        return (
          <text key={c} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="fill-faint font-mono text-[9px]">
            {c > 0 ? '+50' : '−50'}
          </text>
        )
      })}
      <motion.path
        d={`M ${CX - 2.5} ${CY} L ${CX} ${CY - R + 6} L ${CX + 2.5} ${CY} Z`}
        className={inTune ? 'fill-success' : 'fill-accent'}
        style={{ originX: 0.5, originY: 1 }}
        initial={false}
        animate={{ rotate: idle ? 0 : angle(cents), opacity: idle ? 0.3 : 1 }}
        transition={{ type: 'spring', stiffness: 220, damping: 24, mass: 0.7 }}
      />
      <circle cx={CX} cy={CY} r={6} className="fill-text" />
    </svg>
  )
}
```

`frontend/src/components/tuner/ReferenceToneControl.tsx`:

```tsx
// «Еталонний тон»: the note to sound (◀ ▶ by a semitone) and a play / stop toggle.

import { ChevronLeft, ChevronRight, Play, Square } from 'lucide-react'
import { useT } from '../../i18n'
import { Button, IconButton } from '../ui/IconButton'

export function ReferenceToneControl({
  note,
  playing,
  canLower,
  canRaise,
  onLower,
  onRaise,
  onToggle,
}: {
  /** e.g. "A4" */
  note: string
  playing: boolean
  canLower: boolean
  canRaise: boolean
  onLower(): void
  onRaise(): void
  onToggle(): void
}) {
  const t = useT()
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-sm text-muted">{t('tuner.tone.label')}</span>
      <IconButton size="sm" label={t('tuner.tone.lower')} disabled={!canLower} onClick={onLower}>
        <ChevronLeft className="size-4" />
      </IconButton>
      <span className="w-10 text-center font-mono text-sm tabular-nums text-text">{note}</span>
      <IconButton size="sm" label={t('tuner.tone.higher')} disabled={!canRaise} onClick={onRaise}>
        <ChevronRight className="size-4" />
      </IconButton>
      <Button
        size="sm"
        variant={playing ? 'primary' : 'secondary'}
        aria-pressed={playing}
        icon={playing ? <Square className="size-3.5" fill="currentColor" /> : <Play className="size-3.5" fill="currentColor" />}
        onClick={onToggle}
        className="ml-1"
      >
        {playing ? t('tuner.tone.stop') : t('tuner.tone.play')}
      </Button>
    </div>
  )
}
```

`frontend/src/components/tuner/TunerPage.tsx`:

```tsx
// #/tuner — a chromatic tuner. «Почати» asks for the microphone; the dial shows the nearest note and how
// far off it is against an adjustable A4; the reference tone sounds a picked note (the tuner does not
// listen meanwhile, or it would hear the tone). Everything stops when the page is left.

import clsx from 'clsx'
import { ArrowLeft, LoaderCircle, Mic, RotateCcw, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { navigate, paths } from '../../hooks/useRoute'
import { canCaptureMicrophone } from '../../lib/live'
import { clampA4, formatCents, formatHz, isInTune, noteHz, noteName, tunerSpelling } from '../../lib/tuner/notes'
import { clampToneMidi, createReferenceTone, TONE_HIGH, TONE_LOW, type ReferenceTone } from '../../lib/tuner/tone'
import { useApp } from '../../store'
import { CaptureErrorAlert } from '../capture/CaptureErrorAlert'
import { Button } from '../ui/IconButton'
import { A4Control } from './A4Control'
import { ReferenceToneControl } from './ReferenceToneControl'
import { TunerDial } from './TunerDial'
import { useTuner, type TunerErrorCode } from './useTuner'

/** The microphone cannot be asked for here at all: say why instead of offering «Почати». */
function unavailable(): 'insecure' | 'unsupported' | null {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure'
  return canCaptureMicrophone() ? null : 'unsupported'
}

export function TunerPage() {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const a4 = clampA4(useApp((s) => s.tunerA4))
  const setSetting = useApp((s) => s.setSetting)
  const spelling = tunerSpelling(useApp((s) => s.accidentals))
  useDocumentTitle(t('tuner.title'))

  const [toneOn, setToneOn] = useState(false)
  const [toneMidi, setToneMidi] = useState<number | null>(null)
  const { state, lastMidi, start, stop } = useTuner({ a4, paused: toneOn })
  const toneRef = useRef<ReferenceTone | null>(null)

  // the picker starts at the last note heard, else A4
  const picked = clampToneMidi(toneMidi ?? lastMidi ?? 69)
  const pickedName = noteName(picked, spelling)
  // the sounding tone follows the picked note and A4
  useEffect(() => {
    if (toneOn) toneRef.current?.play(noteHz(picked, a4))
  }, [toneOn, picked, a4])
  // leaving the page silences it
  useEffect(() => () => toneRef.current?.dispose(), [])

  const toggleTone = () => {
    const tone = (toneRef.current ??= createReferenceTone())
    if (toneOn) tone.stop()
    else tone.play(noteHz(picked, a4)) // in the click: browsers start audio only on a gesture
    setToneOn(!toneOn)
  }

  const blocked = unavailable()
  const reading = state.phase === 'running' && !toneOn ? state.reading : null
  const shownMidi = toneOn ? picked : (reading?.midi ?? null)
  const shown = shownMidi === null ? null : noteName(shownMidi, spelling)
  const inTune = reading !== null && isInTune(reading.cents)
  const errorText = (code: TunerErrorCode) => (code === 'ended' ? t('tuner.error.ended') : t(`live.error.${code}`))

  let status: string
  if (toneOn) status = t('tuner.tone.sounding', { note: `${pickedName.name}${pickedName.octave}` })
  else if (reading) status = `${formatHz(reading.hz, lang)} ${t('tuner.hz')} · ${formatCents(reading.cents)} ${t('tuner.cents')}`
  else if (state.phase === 'running') status = t('tuner.playNote')
  else status = t('tuner.idle')

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 sm:px-6 sm:pt-10">
      <Button
        variant="ghost"
        className="-ml-3"
        icon={<ArrowLeft className="size-4" />}
        onClick={() => {
          stop()
          navigate(paths.home())
        }}
      >
        {t('core.job.backHome')}
      </Button>

      <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t('tuner.title')}</h1>
      <p className="mt-2 max-w-[60ch] text-[15px] leading-relaxed text-muted sm:text-base">{t('tuner.subtitle')}</p>

      <div className="mt-8 flex flex-col items-center">
        <TunerDial
          cents={reading ? reading.cents : null}
          inTune={inTune}
          label={reading ? t('tuner.aria.dial', { note: `${shown!.name}${shown!.octave}`, cents: formatCents(reading.cents) }) : t('tuner.aria.noNote')}
        />
        <p
          className={clsx(
            'mt-1 font-display text-7xl leading-none font-semibold tracking-tight tabular-nums transition-colors',
            toneOn ? 'text-muted' : inTune ? 'text-success' : shown ? 'text-text' : 'text-faint',
          )}
        >
          {shown ? (
            <>
              {shown.name}
              <sub className="ml-0.5 align-baseline text-3xl font-medium text-muted">{shown.octave}</sub>
            </>
          ) : (
            '—'
          )}
        </p>
        <p className="mt-3 min-h-5 text-center font-mono text-sm text-muted tabular-nums">{status}</p>
      </div>

      <div className="mt-8 flex flex-col items-center gap-3">
        {blocked ? (
          <CaptureErrorAlert message={t(`live.error.${blocked}`)} detail={null} className="w-full max-w-md" />
        ) : (
          <>
            {state.phase === 'error' && <CaptureErrorAlert message={errorText(state.code)} detail={state.detail} className="w-full max-w-md" />}
            {state.phase === 'running' ? (
              <Button icon={<Square className="size-3.5" fill="currentColor" />} onClick={stop}>
                {t('tuner.stop')}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={state.phase === 'starting'}
                icon={
                  state.phase === 'starting' ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : state.phase === 'error' ? (
                    <RotateCcw className="size-4" />
                  ) : (
                    <Mic className="size-4" />
                  )
                }
                onClick={() => void start()}
                className="h-12 px-6 text-base"
              >
                {state.phase === 'error' ? t('tuner.retry') : t('tuner.start')}
              </Button>
            )}
            {state.phase === 'starting' && (
              <span aria-live="polite" className="text-sm text-muted">
                {t('tuner.requesting')}
              </span>
            )}
          </>
        )}
      </div>

      <div className="mx-auto mt-10 flex max-w-md flex-col gap-4 rounded-2xl border border-border bg-surface p-4">
        <A4Control value={a4} onChange={(hz) => setSetting('tunerA4', hz)} />
        <ReferenceToneControl
          note={`${pickedName.name}${pickedName.octave}`}
          playing={toneOn}
          canLower={picked > TONE_LOW}
          canRaise={picked < TONE_HIGH}
          onLower={() => setToneMidi(clampToneMidi(picked - 1))}
          onRaise={() => setToneMidi(clampToneMidi(picked + 1))}
          onToggle={toggleTone}
        />
        <p className="text-xs text-faint">{t('tuner.tone.hint')}</p>
      </div>
    </div>
  )
}
```

`frontend/src/App.tsx` — add `import { TunerPage } from './components/tuner/TunerPage'` after the `TrackPage` import, and in `Page` after the `clip` case:

```tsx
    case 'tuner':
      return <TunerPage />
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/components/tuner/A4Control.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Full checks** — `npx tsc -b && npx vitest run && npx oxlint && npx vite build` → all pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/tuner frontend/src/App.tsx
git commit -m "feat(tuner): tuner page — dial, note and Hz, A4 control, reference tone" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Home card, tour text, README

**Files:**
- Modify: `frontend/src/components/input/SmartInput.tsx` (lucide import, card grid)
- Modify: `frontend/src/i18n/cloud.ts` (uk after `'cloud.ways.listen.hint'` ≈ line 38, en ≈ line 189)
- Modify: `frontend/src/i18n/tour.ts` (`tour.home.sources.*`, uk ≈ lines 32–33, en ≈ 169–170)
- Modify: `frontend/src/components/tour/TourHost.test.ts` (lines ≈ 108 and 266 pin the old step title)
- Modify: `README.md` (section «Онлайн-версія»)

- [ ] **Step 1: Strings**

`frontend/src/i18n/cloud.ts`, uk block, after `'cloud.ways.listen.hint'`:

```ts
    'cloud.ways.tuner.title': 'Тюнер',
    'cloud.ways.tuner.hint': 'Налаштуй інструмент за мікрофоном',
```

en block, after `'cloud.ways.listen.hint'`:

```ts
    'cloud.ways.tuner.title': 'Tuner',
    'cloud.ways.tuner.hint': 'Tune your instrument with the microphone',
```

`frontend/src/i18n/tour.ts` — replace the two uk lines:

```ts
    'tour.home.sources.title': 'Файл, «Слухати» чи тюнер',
    'tour.home.sources.text': '«Файл» відкриває пісню з твого пристрою. «Слухати» — сайт записує мікрофон чи звук іншої вкладки й розпізнає акорди, а для вкладки показує їх ще й наживо. «Тюнер» допоможе налаштувати інструмент перед грою.',
```

and the two en lines:

```ts
    'tour.home.sources.title': 'File, Listen or Tuner',
    'tour.home.sources.text': 'File opens a song from your device. Listen records your microphone or another tab and recognises the chords; for a tab it also shows them live. Tuner helps you tune your instrument before you play.',
```

In `frontend/src/components/tour/TourHost.test.ts` replace both `expect(title()).toBe('Файл або «Слухати»')` with `expect(title()).toBe('Файл, «Слухати» чи тюнер')`.

- [ ] **Step 2: The card** — in `frontend/src/components/input/SmartInput.tsx` add `Gauge` to the lucide import (alphabetical: `… FolderOpen, Gauge, Link2, …`). In the ways grid change `className="mt-4 grid gap-3 sm:grid-cols-2"` to `className="mt-4 grid gap-3 md:grid-cols-3"` (three columns from 768 px; below that the cards stack — at 640 px three columns squeeze the hints into four lines), and add after the «Слухати» `WayCard`:

```tsx
        <WayCard
          icon={<Gauge className="size-5" aria-hidden="true" />}
          title={t('cloud.ways.tuner.title')}
          hint={t('cloud.ways.tuner.hint')}
          href={`#${paths.tuner()}`}
        />
```

- [ ] **Step 3: README** — in «Онлайн-версія», after the «Слухати» bullet, add a paragraph (the list stays «три способи почати»; the tuner is not a way to get a song in):

```markdown

**Тюнер.** Третя картка на головній відкриває хроматичний тюнер: зіграй ноту, і стрілка покаже відхилення в центах, нота — з октавою й частотою. Еталон A4 налаштовується (400–480 Гц), а еталонний тон програє обрану ноту. Працює в браузері, без акаунта; записів не зберігає.
```

- [ ] **Step 4: Tests** — `npx vitest run src/i18n/tour.test.ts src/components/tour/TourHost.test.ts` → PASS (uk/en parity, informal «ти», the Home tour walks to the renamed step).

- [ ] **Step 5: Full checks** — `npx tsc -b && npx vitest run && npx oxlint && npx vite build` → all pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/input/SmartInput.tsx frontend/src/i18n/cloud.ts frontend/src/i18n/tour.ts frontend/src/components/tour/TourHost.test.ts README.md
git commit -m "feat(tuner): «Тюнер» card on Home next to File and Listen" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Verify in the browser

No new code unless a check fails (then fix in the owning file, re-run Tasks' checks, commit as `fix(tuner): …`).

- [ ] **Step 1: Start the dev server** — built-in browser: `preview_start` with `{ name: "frontend-dev" }` (port 5173, `.claude/launch.json`). Open `http://localhost:5173/#/`.

- [ ] **Step 2: Home** — `read_page`: three cards «Файл», «Слухати», «Тюнер»; screenshot at desktop width, then `resize_window` preset `mobile` (375 px): cards stacked, no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`). Reset to `desktop`.

- [ ] **Step 3: Fake microphone** — click «Тюнер» (URL becomes `#/tuner`), then with `javascript_tool`:

```js
(() => {
  const ctx = new AudioContext()
  const osc = ctx.createOscillator()
  osc.frequency.value = 110 * 2 ** (10 / 1200)
  const dest = ctx.createMediaStreamDestination()
  osc.connect(dest)
  osc.start()
  addEventListener('pointerdown', () => ctx.resume(), { once: true, capture: true })
  window.__fake = { osc, stream: dest.stream }
  navigator.mediaDevices.getUserMedia = async () => dest.stream
  return 'fake mic ready'
})()
```

- [ ] **Step 4: Tuning** — click «Почати» (a real click, so the fake context resumes). `get_page_text` within ~1 s: note **A** with octave 2, status `110,6 Гц · +10 ц`; the needle rotated right of centre (screenshot). Then `window.__fake.osc.frequency.value = 440` → **A**₄, `440,0 Гц · 0 ц`, note and needle green (screenshot). **If the needle pivots around its middle instead of the hub**, wrap it: replace the `motion.path` with `<motion.g style={{ transformBox: 'view-box', transformOrigin: '120px 126px' }} initial={false} animate={{ rotate: …, opacity: … }} transition={…}><path d=… className=… /></motion.g>` in `TunerDial.tsx`.

- [ ] **Step 5: A4** — set the A4 field to `442` + Enter → status shows `−8 ц` at once; reload the page → field still `442`; set it back to `440`.

- [ ] **Step 6: Reference tone** — click «Грати»: status «Звучить A4. Поки грає тон, тюнер не слухає.», note greyed; ▶ raises it to A#4 (B♭4 with flats); «Стоп» resumes tuning.

- [ ] **Step 7: Leaving** — start the tone, click «На головну» → `window.__fake.stream.getTracks()[0].readyState === 'ended'` and no tone (the page's tone context is closed: no `AudioContext` in `running` state besides the fake one).

- [ ] **Step 8: Errors** — `navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('x', 'NotAllowedError') }`, click «Почати» → the `live.error.denied` text and «Почати знову».

- [ ] **Step 9: Themes and phone** — screenshots of the running tuner in light and dark (`resize_window` `colorScheme`) and at 375 px; nothing overlaps; reset to `desktop`. `read_console_messages` with `onlyErrors` → none from the tuner.

- [ ] **Step 10: Share proof** — the screenshots from Steps 2, 4 and 9 go to the owner with the summary.

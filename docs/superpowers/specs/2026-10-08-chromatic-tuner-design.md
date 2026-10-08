# Chromatic tuner — Design

**Date:** 2026-10-08 · **Status:** approved in chat (both sections), awaiting written-spec review.
Details added while writing it up are marked *(added)*.

## Intent

The owner asked for a tuner like Pano Tuner (iOS) next to the existing ways in on Home (link, «Файл»,
«Слухати»), so a player can tune the instrument before playing along with the chords. Done when the
acceptance criteria at the end pass.

Decisions taken with the owner:

1. **Scope:** chromatic tuner core — needle with cents, note with octave, frequency in Hz, A4
   calibration, an «in tune» zone — plus a **reference tone**. Not in scope: string mode for an
   instrument, pitch-trace graph, temperaments, transposition, adjustable tolerance, Do-Re-Mi naming.
2. **Entry:** only a third card on Home, opening its own page `#/tuner` with «Назад». No button on the
   song page or in the header.
3. **Detection:** own McLeod Pitch Method (MPM) over an `AnalyserNode`, read every animation frame,
   autocorrelation through the existing `RealFFT`. No new dependency; the `lib/live` chord pipeline
   is not touched.
4. Work on branch `tuner` from `main`.

## Global constraints

- Frontend + docs only. Backend, `firestore.rules`, `storage.rules` untouched. No new dependencies.
- Everything runs in the browser: works for guests, no account, no cloud calls, nothing recorded or
  stored besides the A4 setting.
- Every UI string has `uk` (informal «ти») and `en` entries.
- `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build` pass after every task.
- One commit per task; never push or deploy without the owner's go-ahead.
- Match the surrounding code: pure logic in `lib/`, tests next to code, comment density and naming of
  the neighbours.

## 1. What the user sees

**Home.** `SmartInput`'s card grid gets a third `WayCard` «Тюнер» (lucide `Gauge` icon *(added: lucide
has no tuning-fork glyph)*), `href="#/tuner"`; the grid becomes `sm:grid-cols-3`. The Home tour step
`tour.home.sources` is retitled and its text gains one sentence about the tuner (uk + en).

**Page `#/tuner`** (centred column like `ListenPage`):

- Header row: «Назад» (→ `#/`) and the title «Тюнер»; `useDocumentTitle`.
- **Idle:** a short hint and a «Почати» button. The microphone is requested only on that click (iOS
  needs a gesture; same as «Слухати»). Insecure context or no `getUserMedia` → the start button is
  replaced by the matching `live.error.*` text.
- **Running:**
  - Large note name with octave as a subscript (e.g. **E**₂), below it the frequency «82,4 Гц»
    (one decimal, locale decimal separator) and the signed deviation «+7 ц».
  - A dial: an SVG arc −50…+50 cents with ticks every 10, a green zone ±5 cents, and a needle that
    moves with a spring (framer-motion). Inside ±5 cents the note and the zone light up green.
  - No signal: the last reading stays for 600 ms, then the needle eases back to 0 and the display
    dims to «—».
  - «Зупинити» stops the microphone and returns to Idle.
- **Calibration:** «A4 = 440 Гц» with − / + buttons (step 1 Hz) and an editable number, range
  400–480 Hz. Changes apply immediately. Stored in the settings store, device-local.
- **Reference tone:** a ▶︎ / ■ toggle and ◀︎ ▶︎ to pick the note (one semitone per click, range
  C2–C6 *(added)*). The picker starts at the last detected note clamped to that range, else A4. The tone sounds until
  stopped and follows the current A4. While it sounds, detection pauses (the microphone would
  otherwise pick up the tone) and the dial shows the tone's note greyed out. The tone can be played
  in Idle too, without the microphone.
- **Errors:** the mic failures reuse `captureMicrophone` → `CaptureError` and the existing
  `live.error.{denied,blocked,no-audio,unsupported,insecure,no-device,failed}` texts, with a «Почати
  знову» button. A track that ends mid-session (device unplugged) → `no-audio`.
- **Note spelling** follows the existing `accidentals` setting: `flat` → flats, `auto` and `sharp` →
  sharps.
- **Leaving the page** (Back, logo, any hash change) stops the microphone and the tone.

No tour for the tuner: `reopenTours` falls through to `[]`, so «Інструкція» is hidden there, as on
other tour-less routes.

## 2. Structure and data flow

### `lib/tuner/` (new)

| File | Purity | Responsibility |
|---|---|---|
| `pitch.ts` | pure | `createPitchDetector(size)` → `detect(frame, sampleRate): { hz, clarity } \| null`. MPM: NSDF from the autocorrelation (zero-padded `RealFFT` of size 2·N, power spectrum, inverse) and the running energy term; key maxima between positive-going and negative-going zero crossings; pick the first key maximum ≥ 0.9 × the highest; parabolic interpolation of the lag. Search range 25–2100 Hz (lag bounds). Buffers allocated once per detector. Returns `null` when no key maximum or `clarity < 0.5`. |
| `notes.ts` | pure | `hzToNote(hz, a4, spelling)` → `{ midi, name, octave, cents }` (cents in −50…+50, rounded to 0.1); `noteHz(midi, a4)`; `A4_MIN = 400`, `A4_MAX = 480`, `clampA4`. Names via `pcToName` from `lib/music/notes.ts`. |
| `stabilizer.ts` | pure | `createStabilizer()` → `push(estimate \| null, rms, nowMs)` returning `TunerReading \| null`. Gate: rms below −50 dBFS or clarity < 0.9 counts as silence. Median of the last 5 valid Hz. A new note is shown only after it wins 3 consecutive frames. On silence the last reading holds for 600 ms, then `null`. |
| `session.ts` | impure | `startTuner(stream)` → `{ sampleRate, read(into: Float32Array): number /* rms */, stop() }`. Own `AudioContext({ latencyHint: 'interactive' })` (webkit fallback), `MediaStreamSource` → `AnalyserNode` (`fftSize = 4096`, not connected to the destination), `getFloatTimeDomainData`. Resumes a suspended context on the next user gesture, as `lib/live/session.ts` does. `stop()` stops the tracks and closes the context. |
| `tone.ts` | impure | `createReferenceTone()` → `{ play(hz), stop(), dispose() }`. One `OscillatorNode` (sine) → gain, 20 ms attack and release, changing notes glides the frequency (`setTargetAtTime`) without a click. Gain 0.25, 0 when the app is `muted`. Own lazily created `AudioContext`, resumed in the click handler. |

Window: 4096 samples ≈ 85 ms at 48 kHz, so the lowest bass string (E1 = 41.2 Hz, period ≈ 24 ms)
fits more than three periods. One detection per animation frame (~60 Hz) on overlapping windows.

### `components/tuner/` (new)

- `useTuner.ts`: state `idle | starting | running | error(code)`. `start()` calls `captureMicrophone()`
  then `startTuner()`; a `requestAnimationFrame` loop does `read → detect → stabilizer.push →` React
  state, committing only when the note changes or the cents/Hz move by ≥ 0.5 cent. The loop is
  skipped while the reference tone sounds. Cleans up on unmount and on track `ended`.
- `TunerPage.tsx`: the page layout from section 1; owns the reference-tone instance.
- `TunerDial.tsx`: the SVG arc, ticks, green zone and the spring needle; props `{ cents: number | null,
  inTune: boolean, muted: boolean }`.
- `A4Control.tsx`, `ReferenceTone.tsx`: the two small control rows *(added: keeps `TunerPage` short)*.

### Changes to existing code

- `hooks/useRoute.ts`: route `{ name: 'tuner' }`, `paths.tuner() = '/tuner'`, `parseHash('/tuner')`;
  doc comment lists it.
- `App.tsx`: `case 'tuner': return <TunerPage />`.
- `store.ts`: setting `tunerA4: number` (default 440) in `Settings`, `defaultSettings` and
  `partialize`. Not in `SYNCED_KEYS` (stays on the device). A persisted value outside the range is
  clamped on read in `TunerPage`.
- `components/input/SmartInput.tsx`: third `WayCard`, grid `sm:grid-cols-3`.
- `i18n/tuner.ts` (new, keys `tuner.*`, uk then en) registered in `i18n/index.ts`;
  `cloud.ways.tuner.{title,hint}` in `i18n/cloud.ts`; `tour.home.sources.{title,text}` updated in
  `i18n/tour.ts` (uk + en).
- `cloud.ts` header comments that say "the three ways in" stay true (the tuner is not a way to get a
  song in) — unchanged.

## 3. Testing

- `lib/tuner/pitch.test.ts`: sines at 41.2, 82.41, 110, 196, 440, 1318.5 Hz at 44.1 and 48 kHz →
  within ±1 cent; a sawtooth and a "guitar" mix (fundamental weaker than the 2nd harmonic) at 82.41 Hz
  → no octave error; a +12-cent detuned 110 Hz → +12 ± 1 cent; white noise and silence → `null`.
  Signals from `lib/engine/testing/synth.ts` where it fits.
- `lib/tuner/notes.test.ts`: A4 440 and 442; 466.16 Hz → A#4 / Bb4 by spelling; the ±50-cent
  boundary rounds to the nearer note; octave numbering around C4; `clampA4`.
- `lib/tuner/stabilizer.test.ts`: below-gate input → silence; median rejects a single outlier; a new
  note needs 3 frames; hold for 600 ms then `null`.
- `hooks/useRoute.test.ts`: `#/tuner` parses and `paths.tuner()` round-trips.
- `i18n/tour.test.ts` keeps passing (uk/en parity, informal «ти»).
- **In the browser** (built-in browser, local dev server): on Home the third card opens `#/tuner`;
  with `navigator.mediaDevices.getUserMedia` overridden to return an `OscillatorNode` →
  `MediaStreamAudioDestinationNode` stream at 110 Hz × 2^(10/1200), the page shows **A**₂, ≈ 110.6 Hz
  and the needle at ≈ +10 cents; switching to 440 Hz shows A₄ in the green zone; Back stops the
  stream. Screenshots of Home and the running tuner in light and dark themes and at 375 px width.

## Acceptance criteria

1. Home shows three cards: «Файл», «Слухати», «Тюнер»; «Тюнер» opens `#/tuner`; on a phone width the
   cards stack without horizontal scroll.
2. After «Почати» and mic permission, a steady tone shows the right note, octave and Hz, and the
   needle sits within ±1 cent of the true deviation for 41–1400 Hz test tones.
3. Inside ±5 cents the note and zone are green; outside they are not.
4. Changing A4 to 442 moves a 440 Hz tone to ≈ −7.9 cents immediately; the value survives a reload.
5. The reference tone plays the picked note at the current A4 with no click on start, stop or note
   change; detection pauses while it plays.
6. Denied / missing microphone shows the matching `live.error.*` text and a retry; leaving the page
   releases the microphone (the browser's mic indicator goes off).
7. All checks in Global constraints pass; uk and en strings exist for every new key.

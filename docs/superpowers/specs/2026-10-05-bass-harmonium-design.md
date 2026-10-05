# Bass guitar and harmonium — Design

**Date:** 2026-10-05 · **Status:** approved in chat, awaiting written-spec review

## Intent

The owner asked to add a bass guitar and a harmonium to the service. They become two more
instruments next to guitar, ukulele, piano and handpan: each has its chord diagram, its chord
sound (click / `P`), the `I` cycle and the account-synced `instrument` setting. Done when both can
be picked everywhere the instrument can be picked today, their diagrams are musically right, they
sound like the real thing at the same loudness as the others, and the checks pass.

Decisions taken with the owner:

1. Bass diagram shows **all chord tones in one position** (an arpeggio shape), not just the bass note.
2. Bass voicings come from a **generator** (chords-db has no bass), not a hand-written shape table.
3. Harmonium = a keyboard: **the piano's diagram and staff, plus the live keys panel**, with its own
   sustained reed sound.
4. Harmonium sound is **synthesized in the browser** like the other instruments (no samples).
5. With six instruments the hero picker becomes a **dropdown on phones**; wider screens keep the
   segmented buttons.

## Global constraints

- Frontend + `firestore.rules` (+ its test) + docs only. Backend, `storage.rules`, `scripts/`,
  `.github/` untouched. No new dependencies.
- Every new / changed UI string has `uk` (informal «ти») and `en` entries.
- `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build` pass after every task.
- Work on a feature branch (a push to `main` publishes GitHub Pages); one commit per task; never push
  or deploy without the owner's explicit go-ahead.
- Match the surrounding code: comment density, naming, pure functions in `lib/`, tests next to code.

## 1. Model and UI

- `Instrument = 'guitar' | 'bass' | 'ukulele' | 'piano' | 'harmonium' | 'handpan'` in `store.ts`; one
  exported `INSTRUMENTS` constant in that order in a new `lib/instruments.ts`. It replaces the five
  copies of the list (`Toolbar.tsx`, `NowPlaying.tsx`, `LiveChordsView.tsx`, `hotkeys.ts`,
  `syncedSettings.ts`); `I` cycles in this order.
- Labels: `chords.instrument.bass` «Бас» / "Bass", `chords.instrument.harmonium` «Фісгармонія» /
  "Harmonium".
- Helpers in `lib/instruments.ts`: `isKeyboard(i)` (piano, harmonium), `isFretted(i)` (guitar, bass,
  ukulele), `hasCapo(i)` (guitar, ukulele), `nextInstrument(i)` (the `I` cycle).
- New `components/chords/InstrumentPicker.tsx`, used by the now-playing hero and the live view:
  `Segmented` from the `sm` breakpoint (640 px) up; below it a `Menu` whose trigger shows the current
  instrument's name and a chevron, items checked like other menus. The toolbar settings panel keeps
  its wrapping `Segmented` (two rows fit its 304 px).
- Capo hint (`model.ts` → `suggestCapo`): guitar and ukulele only; null for bass and harmonium.
- Harmonium wherever piano behaves as a keyboard: `ChordDiagram` keyboard branch, the wider legend
  tiles (`ChordLegend`), `LivePianoSlot` (shown for `isKeyboard(instrument) && liveKeys`), and the
  «Живе піаніно» switch (checked when `liveKeys && isKeyboard`; turning it on picks piano only when the
  current instrument is not a keyboard).
- Synced settings: `bass` and `harmonium` added to `ENUMS.instrument` in `lib/syncedSettings.ts` and to
  `isValidSettings` in `/firestore.rules` (comment at the top of the rules too).

## 2. Bass voicings

New pure module `lib/diagrams/bass.ts`:

```ts
export const BASS_TUNING = [28, 33, 38, 43] as const // E1 A1 D2 G2
export function bassVoicings(chord: ParsedChord): VoicingLookup
```

It returns the chords-db `Voicing` shape (`frets` relative to `baseFret`, `fingers`, `barres: []`,
`midi`), so `FretChart`, the ‹ › switcher and the shared `voicings["bass:<label>"]` index work unchanged.

Search (4 strings, frets 0–12):

- **Tones.** The chord's pitch classes from `QUALITY_INTERVALS`; the bass is the slash bass, else the
  root. The perfect fifth (only for qualities whose fifth is perfect — never `dim`, `aug`, `dim7`,
  `hdim7` — and never when it is the bass) is left out when the tones outnumber the strings from the
  bass string up, and in a second pass when no shape at all holds every tone (e.g. `Fadd9`: no
  4-fret position has F A C G).
- **Bass note** on string E or A, lowest note of the shape; strings below it muted.
- **Every higher string**: one chord tone or muted. Pitches strictly ascending in string order.
- **Hand span**: fretted notes within 4 frets (max − min ≤ 3); open strings allowed.
- **Accept** a shape only if it contains every required tone; the octave of a tone may repeat.
- **Rank**: lower position first (min fretted fret, open = 0), then bass on E before A, fewer muted
  strings, smaller span. Deduplicate; keep up to 6.
- **Fingers**: `fret − minFret + 1` (1–4) for fretted notes, 0 for open / muted.
  **baseFret**: 1 when every fret ≤ 4, else the lowest fretted fret.
- **Fallback** (no complete shape): the shapes covering the most tones, `exact: false`, so the
  diagram shows «≈», as guitar does today.

Wiring:

- `FretInstrument = 'guitar' | 'ukulele' | 'bass'`; chords-db code is typed to
  `DbInstrument = 'guitar' | 'ukulele'`.
- New `fretVoicings(instrument, chord, db)`: bass → `bassVoicings` (synchronous, nothing to load);
  guitar / ukulele → `lookupVoicings` as today. `ChordDiagram` and `play.ts` both use it, so the sound
  is always the shape on screen. `useChordDb` is not called for bass.
- `ChordDiagram` widths for bass: `{ sm: 56, md: 80, lg: 100 }`.

## 3. Sound

**Bass** — a `bass` model in `lib/sound/pluck.ts` (same Karplus-Strong renderer, cached per pitch):

- Electric bass, fingerstyle: long T60 (~4–6 s low strings), darker loop damping, soft finger
  excitation (`pickCutoff` ~2.5 kHz), pluck position ~0.18.
- No acoustic body: a "pickup" colour instead — peaking ~90 Hz and a ~700 Hz growl bump (audible on
  laptop / phone speakers that cannot reproduce E1 = 41 Hz), final lowpass ~3.5 kHz.
- Chord = arpeggio low → high from the shown voicing, ~110 ms apart, every note left ringing; the bass
  note a bit stronger; narrow pan (~0.16); reverb send ~0.06.
- `TUNINGS.bass = BASS_TUNING`; `fallbackFretNotes` is not needed for bass (the generator always
  answers).

**Harmonium** — new `lib/sound/harmonium.ts`, `startHarmoniumNote(ctx, when, midi, velocity, hold)`:

- Reed tone: an `OscillatorNode` with a `PeriodicWave` (dense spectrum ~1/n^0.8, odd harmonics a bit
  stronger), built once per context and cached; a second reed +4 cents, quieter, for gentle beating;
  a soft per-note lowpass.
- Envelope as a precomputed curve (`setValueCurveAtTime`, like the piano): bellows attack 40–80 ms
  (slower in the bass), flat hold with a faint tremolo (~2 % at ~5 Hz), 150 ms release. Almost
  touch-insensitive.
- Hold: chord 2.6 s, single key 1.6 s (the piano's values); `release` = the hold.
- Chord notes: the piano's notes (`pianoChordNotes`) with the roll removed — bass at 0, right hand
  at +10 ms together. Pan by pitch like the piano, narrower.
- `playPianoKey(label, key, opts)` gains the instrument, so a key on the harmonium diagram plays
  harmonium.

**Levels** — `BUS.bass` and `BUS.harmonium` tuned with the existing measure: a chord ≈ −16 dBFS RMS
over its first 300 ms at full volume, peaks ≤ −4 dBFS after the limiter (`renderOffline`). The
harmonium is also checked over a 1 s window so the sustained sound does not come out louder.

## 4. Tests

Written first (red), in the repo's vitest layout:

- `lib/diagrams/bass.test.ts`: every shape holds all required tones (9th chords may lack the fifth),
  the bass is the lowest note, pitches ascend, span ≤ 4 frets, `midi` matches E1 A1 D2 G2 + fret;
  slash chords (`C/G`, `D/F#`, `C/D`) carry the right bass; all 12 roots × 15 qualities yield at
  least one shape; the first shape is the lowest position.
- `lib/sound/chordNotes.test.ts`: bass = arpeggio of the shown voicing (offsets ~110 ms, ascending);
  harmonium = the piano diagram's notes, near-simultaneous.
- `lib/sound/synth.test.ts`: bass plucks finite, decaying and in tune (< 3 cents, like the existing
  pluck test) for E1–G3; harmonium envelope (swell, tremolo depth, release, length) and reed spectrum.
- Loudness: there is no `OfflineAudioContext` under vitest, so the bus levels are measured in the
  dev page with `window.__chordSound.renderOffline` (a scripted console check, numbers recorded in the
  commit message).
- `lib/syncedSettings.test.ts` and `firestore.rules.test.mjs`: `bass` and `harmonium` accepted, an
  unknown instrument rejected.
- Picker: menu below `sm`, segmented above; `I` cycles all six.
- Manual check in the browser: diagrams, sounds, phone width, dark and light themes.

## 5. Docs and rollout

- `docs/SPEC.md`: instruments list, the bass voicing and sound rules, the harmonium sound, synced keys.
- `README.md`: `lib/diagrams/` (bass), `lib/sound/` (bass, harmonium).
- Order: (1) code and tests on the branch; (2) **deploy `firestore.rules`**
  (`firebase deploy --only firestore:rules`) — asked separately, it changes the live project;
  (3) only then merge / push to `main`, which publishes the frontend. The order matters: the new
  client lists `bass` / `harmonium` as valid synced values, so with the old rules still live a
  signed-in user who picks one would have the whole settings write rejected (no key syncs) until the
  rules are deployed.

## Out of scope

Bass tablature or bass lines in the score view, a 5-string bass or other tunings, harmonium stops /
registers, a capo for bass, samples.

# Chords Listener — shared spec & contracts

Local web app: paste a YouTube (or any yt-dlp-supported) URL, drop an audio/video file, or record from mic → the app detects chords and shows them in a beautiful, interactive, play-along UI where chords are easy to read and copy.

Everything runs on `localhost`. Target machine: macOS arm64 (Apple M4 Pro), ffmpeg 9 at `/opt/homebrew/bin/ffmpeg`, node 22, uv.

## Layout

```
chords-listener/
  backend/            Python 3.11, uv project (run everything with `uv run ...` from backend/)
    app/
      main.py         FastAPI app (API agent)
      jobs.py, sources.py, storage.py, models.py   (API agent)
      engine/         chord recognition engine (Engine agent) — public API in engine/__init__.py
    tests/            pytest
    scripts/          eval / tooling scripts
  frontend/           Vite + React 19 + TS + Tailwind v4 + zustand + framer-motion + lucide-react
  data/               runtime storage (gitignored): data/tracks/<trackId>/...
  docs/SPEC.md        this file
```

Ports: backend `127.0.0.1:8765`. Vite dev `5173` proxies `/api` → backend. In "prod" mode the backend serves `frontend/dist` at `/` (SPA fallback) so the whole app is `http://localhost:8765`.

## JSON conventions

All API JSON uses **camelCase** keys exactly as in `frontend/src/types.ts` (the source of truth for shapes). Times are seconds (float). Ids are lowercase hex strings.

## Chord label convention (engine output == frontend parser input)

`label = <root><suffix>[/<bass>]`, or `"N"` for no-chord (silence / non-harmonic).

- root / bass spelled with **sharps**: `C C# D D# E F F# G G# A A# B` (frontend re-spells by key / user preference).
- `quality` field (canonical) → suffix in label:

| quality | suffix | example |
|---|---|---|
| maj | `` | `C` |
| min | `m` | `Cm` |
| 7 | `7` | `C7` |
| maj7 | `maj7` | `Cmaj7` |
| min7 | `m7` | `Cm7` |
| dim | `dim` | `Cdim` |
| aug | `aug` | `Caug` |
| sus2 | `sus2` | `Csus2` |
| sus4 | `sus4` | `Csus4` |
| dim7 | `dim7` | `Cdim7` |
| hdim7 | `m7b5` | `Cm7b5` |
| 6 | `6` | `C6` |
| min6 | `m6` | `Cm6` |
| 9 | `9` | `C9` |
| add9 | `add9` | `Cadd9` |

The engine may output any subset (maj/min at minimum). For `N`, `root`/`quality`/`bass` are `null`.

## Engine contract (`backend/app/engine/__init__.py`)

```python
ProgressFn = Callable[[float, str], None]   # (fraction 0..1 within analysis, short stage message)

def engine_info() -> dict:
    # {"name": str, "version": str, "features": {"separation": bool, "downbeats": bool, ...}}

def analyze(audio_path: str, progress: ProgressFn | None = None, options: dict | None = None) -> dict:
    # audio_path: ANY file ffmpeg can decode (mp3/m4a/wav/flac/ogg/opus/webm/mp4/mov...). Engine decodes it itself.
    # options: {"separate": bool} (ignored if unsupported) — unknown keys ignored.
    # returns (camelCase):
    # {
    #   "duration": float, "tempo": float, "timeSignature": int (usually 4),
    #   "beats": [float...], "downbeats": [float...],
    #   "chords": [{"start","end","label","root","quality","bass","confidence"}...],  # contiguous, sorted, cover 0..duration
    #   "key": {"tonic": "A", "mode": "minor", "name": "Am", "confidence": float},
    #   "waveform": [float 0..1] (~1200 peaks),
    #   "engine": "name version"
    # }
```

Must be thread-safe (called from a worker thread) and must never import torch/heavy optional deps unless an option requires it.

## HTTP API (`/api`)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/health` | – | `Health` |
| POST | `/api/jobs` | `{"url": str, "options"?: {"separate"?: bool}}` | `Job` (201). If the same source was already analyzed → job is immediately `done` with `trackId`. |
| POST | `/api/jobs/upload` | multipart `file` (+ optional form field `options` JSON) | `Job` (201) — dedup by content sha1 |
| GET | `/api/jobs` | – | `Job[]` (active + recent, newest first) |
| GET | `/api/jobs/{jobId}` | – | `Job` (frontend polls every ~400ms) |
| GET | `/api/tracks` | – | `TrackSummary[]` newest first |
| GET | `/api/tracks/{id}` | – | `Track` |
| PATCH | `/api/tracks/{id}` | `{"title"?: str, "artist"?: str, "chords"?: ChordSegment[]}` | `Track` (user edits; sets `edited: true`; original detection kept on disk) |
| POST | `/api/tracks/{id}/reset` | – | `Track` (drop user chord edits) |
| POST | `/api/tracks/{id}/reanalyze` | `{"options"?: {...}}` | `Job` |
| DELETE | `/api/tracks/{id}` | – | 204 |
| GET | `/api/tracks/{id}/audio` | – | playback audio (mp3), **must support HTTP Range** (seeking) |
| GET | `/api/tracks/{id}/notes` | – | `TrackNotes` (live piano, see below); 404 `not_found` while not computed yet (or unknown track) |
| PUT | `/api/tracks/{id}/notes` | `TrackNotes` | 204; stores / replaces them. 422 `internal` when invalid, 413 `too_large` over 25 MB, 404 unknown track |

Errors: `{"detail": str, "code": ErrorCode}` with proper HTTP status. Job failures: `status: "error"`, `errorCode`, `error` (human message, English; frontend maps `errorCode` → localized text).

`ErrorCode`: `invalid_url | download_failed | unsupported_format | too_long | too_large | analysis_failed | not_found | internal`.

Job progress mapping (overall `progress` 0..1): queued 0 → downloading 0–0.35 → decoding/transcoding 0.35–0.45 → analyzing 0.45–1.0 (engine fraction scaled) → done 1.

Limits (env-overridable): `CHORDS_MAX_DURATION_MIN=30`, `CHORDS_MAX_UPLOAD_MB=500`, `CHORDS_DATA_DIR=<project>/data`.

### Where the API lives (same origin / cloud / remote / browser mode)

The UI is also published as a static site (GitHub Pages, `VITE_BASE=/chords-listener/` build). `src/lib/serverMode.ts` picks the API in this order (`candidateList`) and `src/lib/api.ts` routes every call; callers never build URLs themselves. `useConnection` = `{ status: 'checking' | 'server' | 'browser', backend: 'local' | 'cloud' | null, apiBase, … }`.

- **Same origin** (local builds): `/api` (served by the backend or the Vite proxy).
- **Cloud** (signed in, `CLOUD_API_URL` in `src/config.ts` set): `<cloud>/api`, see docs/CLOUD.md. Selected at once (no waiting for a cold start; `/health` is fetched in the background and never polled, so Cloud Run can scale to zero). Every call but `/health` carries `Authorization: Bearer <Firebase ID token>`; a 401 renews the token once, then asks the user to sign in again (`requestSignIn`) and repeats the call; 429 → `quota_exceeded`. Uploads go to Firebase Storage `users/{uid}/uploads/{uploadId}/{filename}` (resumable) and then `POST /jobs/storage` (`src/lib/cloud/storage.ts`); small files fall back to multipart when Storage refuses. Signed media URLs are resolved against the cloud origin.
- **Remote** (opt-in `useServerPrefs.localServer`, always on in local builds): `settings.serverUrl` (default `http://localhost:8765`). URLs the server returns (`audioUrl`, relative thumbnails) are resolved against it. Probed on load and every 10 s while down; on a public https page Chrome's Local Network Access permission is required, so with permission state `prompt` the server is probed only on a user click.
- **Browser mode** (no server): files and recordings are analyzed in the page (`src/lib/engine`), stored in IndexedDB (`src/lib/local`). Ids start with `local-` (tracks) / `local-job-` (jobs) and are served by the browser library in every mode; jobs go `queued → decoding → analyzing → done` with the same progress ranges. `createJob` (links) rejects with client code `server_required`; `startLink` decides first (`linkTarget` in `components/input/url.ts`): every YouTube link opens "listen in the tab" (`#/listen/youtube/<videoId>`) — also for a signed-in user, because YouTube refuses the cloud's servers; only a local server (`backend: 'local'`) downloads it. Other sites go to a connected server, otherwise ask for an account. Tab recordings of a video keep `source: {type: 'youtube'}`; a recording that began at video time t > 0 is stored with t seconds of silence in front, so its times are video times.
- Backend: `CHORDS_ALLOWED_ORIGINS` (comma-separated, default `https://shchadylotaras.github.io` + the Vite dev origins) may use the API cross-origin (CORS, Private Network Access preflight, cross-site write check); pages on a local host (any port) always may.

## Frontend architecture & file ownership

Shared, pre-written (edit only if truly necessary, keep backwards compatible, mention it in your report):
- `src/types.ts` — API shapes
- `src/store.ts` — zustand store: track, playback (controller pattern), view settings (persisted), toasts
- `src/i18n/index.ts` — `useT()` merging `src/i18n/core.ts` (Shell agent) and `src/i18n/chords.ts` (Chords agent). Ukrainian (`uk`) is the default language, English (`en`) available.
- `src/index.css` — Tailwind v4 + design tokens (CSS vars, light/dark via `html[data-theme]`), chord root colors `--chord-0..11`.

**Shell agent** owns: `src/main.tsx`, `src/App.tsx`, `src/lib/api.ts`, `src/i18n/core.ts`, `src/hooks/**`, `src/components/{layout,input,jobs,player,history,ui}/**`, `index.html`, `public/**`, `vite.config.ts`.

**Chords agent** owns: `src/components/chords/**` (entry: `src/components/chords/index.ts` exporting `ChordWorkspace`), `src/lib/music/**`, `src/lib/diagrams/**`, `src/lib/clipboard.ts`, `src/i18n/chords.ts`, tests in `src/**/*.test.ts`.

`<ChordWorkspace />` takes no props; reads `track` + playback + settings from the store; renders everything chord-related for the loaded track (now-playing hero, timeline, sheet, toolbar, chord legend/diagrams, copy, edit). The Shell places it in the track page above the sticky bottom `PlayerBar`.

The Shell's player components register a `PlayerController` in the store (`registerController`) and push `currentTime`/`isPlaying`/`duration` updates (rAF while playing). Anyone seeks via `useApp.getState().seek(t)`.

### Keyboard shortcuts (global; ignore when focus is in input/textarea/contenteditable)

Shell agent: `Space` play/pause · `←/→` seek ∓5s · `Shift+←/→` previous/next chord change (uses `track.chords`) · `,`/`.` speed −/+ · `M` mute · `?` shortcuts help modal (lists ALL shortcuts below) · `Esc` close modal / clear loop.
Chords agent: `-`/`=` (also `[`/`]`) transpose −/+ · `0` reset transpose · `S` simplify toggle · `V` switch view (sheet → timeline → score) · `C` copy all (default format) · `F` follow-playhead toggle · `L` loop current bar / selection · `I` cycle instrument.
Tempo (`src/components/chords/tempo/useTempoHotkeys.ts`): `T` tap tempo (median of the last taps; a 2 s pause starts a new series) · `K` metronome on/off. Physical keys (`event.code`), no modifiers, also ignored while a modal dialog is open.
Chord sound (in `src/components/chords/hotkeys.ts`): `P` play the current chord (else the first chord of the bar selection, else the next one, else the last) on the selected instrument; same rules as the chord keys.

### Tempo

The per-track correction factor `tempoFactors[track.id]` ∈ {0.5, 1, 2} (persisted locally, missing = 1) is applied in ONE place: `useEffectiveRhythm()` → `ChordModel.rhythm` (`src/lib/tempo/rhythm.ts`: ×2 inserts midpoints between beats and recomputes downbeats every `timeSignature` beats from the first downbeat; ×½ keeps every other beat). `ChordModel.bars`, the bar counter, timeline ticks, loops, copy formats (ChordPro `{tempo}`), the beat pulse and the metronome are all built from it; factor 1 = the detection unchanged. History cards show `tempo × factor`.

### Handpan

`instrument: 'handpan'` swaps the chord diagram for a top-down handpan (`src/components/chords/handpan/`, logic in `src/lib/handpan/`). Settings (local only, not synced): `handpanScale` = `'custom'` (the user's own instrument) or a preset id (`d-kurd`, `d-celtic`, `cs-amara`, `e-amara`, `d-integral`, `f-low-pygmy`, `e-equinox`, `c-aegean`; unknown → `custom`); `handpanNotes` = `[ding, ...tone fields in physical order]`, each like `A` or `Bb3` (invalid → the default `A | D F A C G E C A`). Notes match by pitch class (`Bb` = `A#`). Song coverage = share of chord notes playable, weighted by duration; the best transposition is searched in −6..+6 (ties → smallest shift). The capo hint is replaced by this coverage hint while the handpan is selected.

### Chord sound (`src/lib/sound`)

Clicking a chord plays it (Web Audio, synthesized in the page; no samples, no dependencies). Settings (local only, not synced): `chordSound` (default `true`) turns on the *implicit* click-to-play; `chordSoundVolume` 0..1 (default 0.8, master gain = v²). Independent of the player's volume / mute.

- **Implicit** (only with `chordSound`): sheet slots and timeline blocks — they still seek, and sound only while paused (playing: the recording is heard there right away); legend tiles (with `chordSound` off a tile click copies the name; the tile's copy button always copies); the hero's current and next chord. **Explicit** (always): the popover's «Прослухати» button, every chord diagram (fretted chart → strum; piano key / handpan field → that one note; elsewhere on a piano / handpan diagram → the chord; voicing ‹ › never sound), `P`, the settings' test button. A brief ring / glow animates the element that was clicked; diagrams of the sounding chord light the keys / strings / fields while each note sounds (`useSoundingTargets`).
- **Notes = what the diagram shows**, for the display label (transpose / simplify / spelling applied). Piano: `staffChord(parsed, pianoVoicing(parsed))` — the left-hand bass first, the right hand ~18 ms later and a bit softer; keys are held 2.6 s, then damped. Guitar / ukulele: the displayed chords-db voicing (same lookup and `voicings["instrument:label"]` index as `ChordDiagram`), its `midi` in string order, strummed from the first string (guitar gaps 20→16 ms, ukulele 15→13 ms, velocity falling ~4.5 % per string); a plain stacked voicing if chords-db has none. Handpan: only chord tones on the selected scale — the bass (slash bass, else root, else the lowest available tone) on its lowest field, each other tone once on the nearest field above, the root again if there is room; low → high, 70 ms apart. No playable tone → no sound + a hint toast. `N` plays nothing. Scales without octaves get inferred ones: the ding between A2 and G#3, the fields as the most compact ascending scale starting ≥ a minor third (preferably a fifth) above it, a duplicated pitch class an octave higher on the field nearer the player (default `A | D F A C G E C A` → `A2 | D4 F4 A4 C5 G4 E4 C4 A3`).
- **Voices**: piano = 8 inharmonic partials with a double decay + hammer noise, stereo by pitch; guitar (steel) / ukulele (nylon) = Karplus-Strong plucks (allpass-tuned, pluck-position comb, frequency-dependent damping, body peaks + lowpass) rendered once per pitch × sample rate and cached (LRU 48); handpan = fundamental + octave + compound fifth, each a slightly beating pair, ~8 ms strike, 2.5–4 s ring, a low air-resonance thump, panned by field position. A new chord fades the previous voices out in 70 ms (a single note replaces only a chord or the same note).
- **Graph**: one lazily created `AudioContext({ latencyHint: 'interactive' })`, separate from the metronome: voices → instrument bus (+ send to a small synthetic room reverb) → master gain → DynamicsCompressor limiter → destination. Created / resumed synchronously inside the gesture (plus a silent buffer for iOS); a mouse press on `[data-cw-sound]` warms it up before the click. Suspended after 15 s without sound; nothing runs while idle. Without Web Audio: silent, one info toast, no errors.
- **Live notes** (`src/lib/liveNotes.ts`): every played note is emitted once, when scheduled, with the `performance.now()` times it is heard (`start`) and released (`end`: piano = key up; strings / handpan = faded to −30 dB). Times come from `getOutputTimestamp()` (waiting ≤ 250 ms for a live one after the context starts) or `currentTime + baseLatency + outputLatency`, plus the limiter's 6 ms lookahead. When a newer sound cuts a note, the same note (**same `midi` and `start`**) is emitted again with the earlier `end` (= when the new chord starts) — consumers should treat `(midi, start)` as the note's identity and keep the latest `end`. Notes scheduled after the cut get `end = start`.
- Dev builds expose `window.__chordSound` (`.stats`: plays, voices, the last live notes and their context times; `.renderOffline(request)` renders through the same graph for level checks).

### Live piano (`src/components/chords/piano`, `src/lib/transcription`)

With `instrument: 'piano'` a panel under the hero shows the song's notes falling onto a keyboard whose keys go down in sync with the audio. Settings (local only, not synced): `liveKeys` (default `true`; the panel's ✕ turns it off, the toolbar settings switch «Живе піаніно» turns it — and the piano — back on) and `syncOffsetMs` (−300..300, default 0, positive = keys light later).

- **TrackNotes** (`src/types.ts`): `{"version": 1, "engine": str (≤ 200), "notes": [[start, end, midi, velocity], …]}` — seconds rounded to ms, sorted by start; `midi` integer 21..108 (the 88 keys), `velocity` 0..1, `0 ≤ start < end ≤ duration + 1`, at most 300 000 notes, body ≤ 25 MB (`Settings.max_notes` / `max_notes_mb`). The server re-rounds, sorts and writes `data/tracks/<id>/notes.json` atomically (compact JSON) and serves it verbatim (`Cache-Control: no-cache`); an unreadable / unknown-version file counts as not computed. Notes are deleted with the track and kept by re-analysis, chord edits and reset (the audio is the same). PUT goes through the same local-only / cross-site guard and CORS as every write. Browser tracks (`local-…`) keep them in IndexedDB (`chords-listener` version 2, store `notes`, rows `{id, notes}`; the upgrade from version 1 only adds the store), deleted with the track. If saving fails (e.g. an older server without the endpoint) the notes live for the session.
- **Transcription** — once per track, in the page (`requestNotes(track, {force?})`, hook `useTrackNotes(track)`): memory cache (6 tracks) → saved notes (`api.getTrackNotes`) → `api.fetchTrackAudio` (the server's `audioUrl`, or the IndexedDB blob) → `decodeAudioData` on a 22 050 Hz `OfflineAudioContext`, channels averaged → Spotify's **Basic Pitch** (Apache-2.0; `public/models/basic-pitch/` = the unmodified model of `@spotify/basic-pitch` 1.0.1 with LICENSE / NOTICE, loaded from `${BASE_URL}models/basic-pitch/model.json`) on slim TF.js 4.22 (core + converter + WebGL + CPU backends). A module worker runs it with WebGL through OffscreenCanvas (its shaders are compiled in parallel while the audio downloads); without WebGL in workers the page's WebGL runs it, yielding between windows; else the CPU backend in the worker. TF.js is only in the worker / a lazy chunk, never in the main bundle; the panel itself is lazy too. Windows of 43 844 samples every 36 164 (30-frame overlap, half trimmed per side) with exact per-window frame times; one window per call (~360 MB of GPU textures; ≈ 0.7 s per minute of audio on an M4 Pro, CPU ≈ 30 s per minute). Decoding = a port of basic-pitch's `outputToNotesPoly` (identical output, checked against the package in tests; heap-driven melodia trick, O(n log n)) with onset 0.5, frame 0.3, notes ≥ 80 ms, melodia trick and inferred onsets on; then parabolic sub-frame onset refinement, +4 ms onset shift (measured bias), merging per pitch (overlaps, double attacks, re-attacks weaker than 0.7 within 30 ms of the same pitch's end, onset-less continuations within 120 ms), dropping notes weaker than 0.4 (½ amplitude + ½ onset), velocity = that strength stretched over the song (95th percentile → 1). Progress: audio 0–0.04, decode → 0.1, model 0.1–0.96 (with the running count of notes found, decoded from what is evaluated so far), notes 0.97. One transcription at a time: another track's request stops it, and it stops 2.5 s after no panel shows its track. Accuracy / speed: `cd frontend && node scripts/eval-transcription.ts` (synthetic piano / plucked / fast clips with known notes, TF.js CPU in Node).
- **Sync**: every animation frame the panel reads `controller.getTime()` and smooths it with `LiveClock` (extrapolates with `performance.now()` × `playbackRate` between readings, folds fresh readings in at 20 %, never runs backwards, re-anchors at once on jumps > 120 ms ahead / 50 ms behind (seek, loop, stall), holds after play / a jump until the player's time moves; pause and rate changes apply on the next frame). Drawn time = clock + rate × (frame lead − `syncOffsetMs`), frame lead = the measured refresh interval (a frame reaches the screen one refresh later). Media elements report the position being heard (Chromium / Gecko / WebKit subtract the device output latency), so `AudioContext.outputLatency + baseLatency` is not added to the song — it is measured once (on opening the sync popover) and shown there as information. Preview notes from `onLiveNotes` light keys at their own `performance.now()` times with the same lead / offset, also while paused; `(midi, start)` identifies a note, a re-emitted one updates its `end` (`end = start` removes it).
- **Drawing**: one `<canvas>` (devicePixelRatio): a ~3 s falling-notes roll (black-key lanes, octave and bar lines, chord-change lines with the displayed labels) above a keyboard with real proportions (7 equal white keys per octave, black keys 0.58 × 0.63 at the 12-way split of the octave); pressed keys sink 2 px, take the pitch class colour (`--chord-N` by fifths, read from `<html>` and re-read on theme change) at a brightness from velocity, and flash for ~150 ms with a glow on every attack. The keyboard fits the song (whole octaves, ≥ 4, ≤ 88 keys; outliers ignored); under 640 px ≤ 3 octaves around the most notes. Notes outside the keys fold by octaves to the nearest edge octave with ▲ / ▼ marks. Song notes follow `transpose`. While paused the keys under the playhead (and attacks ≤ 80 ms later) stay down, dimmer. Animation frames run only while playing, while preview notes sound / glow, or once after a change; reduced motion = no roll, keys only. Accessible: `role="img"` + label, and a polite live region naming the keys down (≤ every 1.5 s). Test hook: `canvas.__livePiano` = `{time, playing, keys, range}` of the last drawn frame.

### Score — «Ноти» (`src/components/chords/score`, `src/lib/score`, `src/lib/vocals.ts`)

`view: 'score'` shows the song as sheet music drawn by OpenSheetMusicDisplay 2.x (BSD-3) from the MusicXML that is also exported: «Вокал» (the sung melody, when the server transcribed it) above «Фортепіано» (grand staff, the instruments' notes), chord symbols on top. OSMD + VexFlow (≈1.4 MB) and jsPDF + svg2pdf.js (≈0.5 MB) are lazy chunks only.

- **Time**: measures = the chord sheet's bars (`buildBarGrid` on the effective rhythm, so ×½ / ×2 apply); seconds → ticks piecewise linear between each bar's beat boundaries, a beat = 4 ticks (MusicXML divisions 4, a tick = a 16th). A short first bar is an implicit measure "0"; an incomplete last bar is padded (a long one split); other odd bars get a time-signature change.
- **Vocal part** (`lib/score/vocal.ts`) from VocalNotes: monophonic; slides / blips shorter than 0.55 of a 16th (≤ 130 ms) next to another note go to the neighbour nearest in pitch; onsets on the 16th grid (8th when simplified) leaning to the 8th by 0.2 tick; the end is the rounded offset or onset + rounded length, whichever keeps both nearer to what was sung; overlaps cut; gaps < 1/8 closed (< 1/4 simplified). Treble clef, treble-8vb (`clef-octave-change −1`) when the median is below C4.
- **Piano part** (`lib/score/piano.ts`) from TrackNotes: ghost notes dropped (velocity < 0.3, < 90 ms, < 40 % of the loudest note of the onset), onsets within 60 ms aligned, notes below A1 an octave up; hands split per beat by a Viterbi path over split points 48–72 (gap between pitch clusters, hand span ≤ an octave, ledger lines, near middle C, smooth); same onset in a hand = one chord, ≤ 4 notes (outer voices + loudest inner); a chord lasts until its longest note ends, never past the hand's next onset; short releases closed (< 1/8 or ≤ ¼ of the gap between onsets), releases before rests on 8ths. Simplified: 8th grid, RH ≤ 3 / LH ≤ 2 notes, stricter ghosts, a chord repeated within a beat is held.
- **Source**: with the track's `instruments` stem the piano notes are transcribed from it (`requestNotes({…, notesSource: 'instruments', loadAudio})`; cached per device in IndexedDB `chords-listener-stems`, newest 16 — the server keeps only the mix notes), else from the mix, minus the sung notes when they exist. The view, the live piano and exports show which source was used.
- **Chord symbols**: the sheet's bar slots (displayed labels: transpose / simplify / accidentals), written where the chord changes; N.C. for no-chord ≥ 2 beats. Notes / rests are split (tied) at chord changes so every symbol sits on a note or rest of the top part.
- **Key / spelling** (`lib/score/spelling.ts`): the transposed track key (F♯/G♭, D♯m/E♭m by the spelling preference); notes on the line of fifths — diatonic as in the key, chromatic from [fifths−3, fifths+8] (major) / [−2, +9] (minor), the minor leading tone always raised.
- **Notation** (`lib/score/notation.ts`): split at barlines and into values that show the beat (dotted values where standard, syncopations inside a half bar, no dotted / syncopated rests, whole-measure rests), beams per beat with 16th hooks, explicit accidentals per measure and staff.
- **MusicXML** (`toMusicXml`): score-partwise 4.0, work-title, `creator type="composer"` = artist, credits (title, subtitle "Транскрипція: Chords Listener", composer), A4 defaults, metronome + `sound tempo`, `harmony` (root / kind / bass / degree; N.C. = kind `none`). Tests parse it back (DOMParser, jsdom), load it in OSMD and compare with `src/lib/score/__fixtures__/demo.musicxml`; it validates against the MusicXML XSD.
- **MIDI** (`toMidi`): SMF format 1, 480 PPQ; track 0 = title, key / time signatures and one tempo per beat taken from the beat times (the quantized notes play in time with the recording); tracks «Вокал» (Voice Oohs, channel 1), «Фортепіано RH» / «LH» (piano, channels 2 / 3); velocity = 24 + 103·v; UTF-8 names.
- **PDF** (`lib/score/pdf.ts`): OSMD lays out A4 portrait pages (1100 px wide ≈ a 7.6 mm staff), svg2pdf.js draws each page SVG as vectors into jsPDF; the text font is an embedded DejaVu Serif subset (Latin, Cyrillic, ♩ ♭ ♮ ♯; `src/lib/score/fonts/`, Bitstream Vera / DejaVu licence), also used by OSMD on screen. Page 1: title, credit, "Тональність · Темп", artist; every page: "Сторінка n з N".
- **Downloads** (`lib/score/download.ts`): «<title> — ноти.pdf|.musicxml|.mid» via a Blob URL on `<a download>` (iOS 13+, Android); without `download` a new tab; if that is blocked a toast offers «Відкрити». From the score header and the toolbar's copy menu (which loads / transcribes the notes first and never starts a vocal job).
- **View**: toggles Вокал / Фортепіано / Акорди / Спрощено (local `chords-listener-score`); the cursor follows the clock (interpolated between written notes, auto-scroll with `follow`, manual scrolling pauses it); clicking a note seeks there; phones get a smaller zoom and abbreviated part names; colours from the theme.
- **Vocals** (`lib/vocals.ts`): `GET /api/tracks/{id}/vocals` (404 = not yet), `POST …/vocals` → Job (`kind: 'vocals'`) polled every 0.8 s (stages «Відділяю голос → Визначаю мелодію» from the job message), stems via `track.stemUrls[name]` when the server provides signed URLs, else `GET /api/tracks/{id}/stems/{name}` through `apiFetch`. Browser tracks / browser mode: "needs a server"; 501 / `features.vocals === false`: "not installed here". A finished job marks the loaded track `vocals: true, stems: [...]` without resetting playback.
- **Live piano**: same instrument notes (instruments stem when available); the sung melody as outlined bars in the ink colour and a dot on the sung key, toggle 🎤 (`liveVocals`, local).

### In-browser engine (`src/lib/engine`)

`analyzeInBrowser(file, onProgress?, { signal })` decodes with Web Audio on the main thread (22 050 Hz mono) and runs the DSP in a module Web Worker. It returns the same shape as the engine contract above (`engine: "chords-listener-web 1.0.0"`). Failures reject with `BrowserEngineError.code` ∈ `unsupported_format | too_long | too_large | analysis_failed` (same limits as the server: 30 min, 500 MB); an abort rejects with `signal.reason`. Accuracy tooling: `cd frontend && node scripts/eval-web-engine.ts --dir <synthetic songs>`.

## Design direction

Simple, calm, extremely usable; play-along first. Dark theme default (studio feel), light theme available. The current chord must be readable from 2 meters away. Chord blocks are colored by root around the **circle of fifths** (`--chord-N`, N = fifths index of root: C=0, G=1, D=2, A=3, E=4, B=5, F#=6, C#=7, G#=8, D#=9, A#=10, F=11) so related chords look related; minor = same hue, slightly darker/desaturated treatment. Fonts: `font-sans` Inter (UI), `font-display` Space Grotesk (chord names), `font-mono` JetBrains Mono (times). Motion: subtle, fast (≤200ms), respects `prefers-reduced-motion`. Every copy action gives a toast + inline check-mark feedback.

## Firebase (sign-in: the cloud on the hosted site, settings sync everywhere)

Project `build-chords-listener`, web app `chords-listener-web`. Signing in (email + password) keeps 11 UI preferences the same on every device and, on the hosted site, switches the API to the cloud (docs/CLOUD.md, "Where the API lives" above): the library then lives in the account. A local server (`./start.sh`, same origin) stays unauthenticated and never sees the account. Without an account, or with Firebase blocked or offline, the app works in browser mode; the home page invites to «Зареєструватися» / «Увійти». The one account dialog of the app is `components/account/AuthDialogHost` (`openAuthDialog`, `requestSignIn` in `src/lib/auth.ts`).

- **Synced keys** (`src/lib/syncedSettings.ts` ⇄ `isValidSettings` in `/firestore.rules`, keep both in sync): `simplify`, `accidentals`, `instrument` (`guitar|ukulele|piano|handpan`), `view` (`sheet|timeline|score`), `barsPerLine` (2|4|8), `follow`, `showDiagrams`, `copyFormat`, `theme`, `lang`, `showVideo`. Everything else (transpose, volume, speed, handpan notes/scale, metronome, tempo factors, server URL) stays local. A new value for a synced key needs a rules change + deploy first; until then the client keeps it local and syncs the other keys.
- **Data**: one doc `users/{uid}` = `{ email, createdAt, updatedAt, settings }`, owner-only read/write, strict schema (`/firestore.rules`). No collection queries.
- **Sync rules** (`src/lib/settingsSync.ts`): on sign-in the profile wins (except keys changed on this device while it was loading); local changes are pushed after 800 ms; changes from other devices arrive live; the first sign-in creates the profile from this device's settings; nothing is written before the server has been reached.
- **Loading**: `src/lib/auth.ts` (store `useAuth`, `startAuth()` mounted in `App.tsx`, `signIn/signUp/sendPasswordReset/signOut`) imports `src/lib/firebase.ts` (app + Auth) lazily; Firestore (`settingsSync.ts`) loads only once someone is signed in. The main bundle contains no Firebase code.
- **UI**: `src/components/account/{AccountButton,AuthModal}.tsx`, strings in `src/i18n/account.ts`, error codes → keys in `src/lib/authErrors.ts`.
- **Config**: `/firebase.json` (auth providers, Firestore `(default)` in `eur3`, emulator ports), `/.firebaserc`, `/firestore.rules`, `/firestore.indexes.json`. Authorized domains: `localhost`, `shchadylotaras.github.io` (+ the default `*.firebaseapp.com` / `*.web.app`).

Emulators (need Java: `brew install openjdk`; run from the repo root):

```bash
export PATH=/opt/homebrew/opt/openjdk/bin:$PATH
npx -y firebase-tools@latest emulators:start --only auth,firestore --project build-chords-listener   # UI: http://localhost:4000
cd frontend && VITE_FIREBASE_EMULATORS=true npx vite                                            # Auth → :9099, Firestore → :8080
npx -y firebase-tools@latest emulators:exec --only auth,firestore --project build-chords-listener "node --test firestore.rules.test.mjs"   # rules tests
npx -y firebase-tools@latest deploy --only firestore:rules --project build-chords-listener        # after editing the rules
```

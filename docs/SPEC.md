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

Errors: `{"detail": str, "code": ErrorCode}` with proper HTTP status. Job failures: `status: "error"`, `errorCode`, `error` (human message, English; frontend maps `errorCode` → localized text).

`ErrorCode`: `invalid_url | download_failed | unsupported_format | too_long | too_large | analysis_failed | not_found | internal`.

Job progress mapping (overall `progress` 0..1): queued 0 → downloading 0–0.35 → decoding/transcoding 0.35–0.45 → analyzing 0.45–1.0 (engine fraction scaled) → done 1.

Limits (env-overridable): `CHORDS_MAX_DURATION_MIN=30`, `CHORDS_MAX_UPLOAD_MB=500`, `CHORDS_DATA_DIR=<project>/data`.

### Where the API lives (server / remote / browser mode)

The UI is also published as a static site (GitHub Pages, `VITE_BASE=/chords-listener/` build). `src/lib/serverMode.ts` finds the server and `src/lib/api.ts` routes every call; callers never build URLs themselves.

- **Same origin** (local builds): `/api` (served by the backend or the Vite proxy).
- **Remote** (hosted build, or no same-origin server): `settings.serverUrl` (default `http://localhost:8765`). URLs the server returns (`audioUrl`, relative thumbnails) are resolved against it. Probed on load and every 10 s while down; on a public https page Chrome's Local Network Access permission is required, so with permission state `prompt` the server is probed only on a user click.
- **Browser mode** (no server): files and recordings are analyzed in the page (`src/lib/engine`), stored in IndexedDB (`src/lib/local`). Ids start with `local-` (tracks) / `local-job-` (jobs) and are served by the browser library in every mode; jobs go `queued → decoding → analyzing → done` with the same progress ranges. `createJob` (links) rejects with client code `server_required`.
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
Chords agent: `-`/`=` (also `[`/`]`) transpose −/+ · `0` reset transpose · `S` simplify toggle · `V` switch view (sheet/timeline) · `C` copy all (default format) · `F` follow-playhead toggle · `L` loop current bar / selection · `I` cycle instrument.
Tempo (`src/components/chords/tempo/useTempoHotkeys.ts`): `T` tap tempo (median of the last taps; a 2 s pause starts a new series) · `K` metronome on/off. Physical keys (`event.code`), no modifiers, also ignored while a modal dialog is open.

### Tempo

The per-track correction factor `tempoFactors[track.id]` ∈ {0.5, 1, 2} (persisted locally, missing = 1) is applied in ONE place: `useEffectiveRhythm()` → `ChordModel.rhythm` (`src/lib/tempo/rhythm.ts`: ×2 inserts midpoints between beats and recomputes downbeats every `timeSignature` beats from the first downbeat; ×½ keeps every other beat). `ChordModel.bars`, the bar counter, timeline ticks, loops, copy formats (ChordPro `{tempo}`), the beat pulse and the metronome are all built from it; factor 1 = the detection unchanged. History cards show `tempo × factor`.

### Handpan

`instrument: 'handpan'` swaps the chord diagram for a top-down handpan (`src/components/chords/handpan/`, logic in `src/lib/handpan/`). Settings (local only, not synced): `handpanScale` = `'custom'` (the user's own instrument) or a preset id (`d-kurd`, `d-celtic`, `cs-amara`, `e-amara`, `d-integral`, `f-low-pygmy`, `e-equinox`, `c-aegean`; unknown → `custom`); `handpanNotes` = `[ding, ...tone fields in physical order]`, each like `A` or `Bb3` (invalid → the default `A | D F A C G E C A`). Notes match by pitch class (`Bb` = `A#`). Song coverage = share of chord notes playable, weighted by duration; the best transposition is searched in −6..+6 (ties → smallest shift). The capo hint is replaced by this coverage hint while the handpan is selected.

### In-browser engine (`src/lib/engine`)

`analyzeInBrowser(file, onProgress?, { signal })` decodes with Web Audio on the main thread (22 050 Hz mono) and runs the DSP in a module Web Worker. It returns the same shape as the engine contract above (`engine: "chords-listener-web 1.0.0"`). Failures reject with `BrowserEngineError.code` ∈ `unsupported_format | too_long | too_large | analysis_failed` (same limits as the server: 30 min, 500 MB); an abort rejects with `signal.reason`. Accuracy tooling: `cd frontend && node scripts/eval-web-engine.ts --dir <synthetic songs>`.

## Design direction

Simple, calm, extremely usable; play-along first. Dark theme default (studio feel), light theme available. The current chord must be readable from 2 meters away. Chord blocks are colored by root around the **circle of fifths** (`--chord-N`, N = fifths index of root: C=0, G=1, D=2, A=3, E=4, B=5, F#=6, C#=7, G#=8, D#=9, A#=10, F=11) so related chords look related; minor = same hue, slightly darker/desaturated treatment. Fonts: `font-sans` Inter (UI), `font-display` Space Grotesk (chord names), `font-mono` JetBrains Mono (times). Motion: subtle, fast (≤200ms), respects `prefers-reduced-motion`. Every copy action gives a toast + inline check-mark feedback.

## Firebase (optional sign-in, settings sync only)

Project `build-chords-listener`, web app `chords-listener-web`. Signing in (email + password) is **optional** and does exactly one thing: keeps 11 UI preferences the same on every device. Songs, chords, edits and history never leave the device, and the `/api` backend stays unauthenticated (it never sees the account). Without an account, or with Firebase blocked or offline, the app works fully; the header just shows "Увійти".

- **Synced keys** (`src/lib/syncedSettings.ts` ⇄ `isValidSettings` in `/firestore.rules`, keep both in sync): `simplify`, `accidentals`, `instrument` (`guitar|ukulele|piano|handpan`), `view`, `barsPerLine` (2|4|8), `follow`, `showDiagrams`, `copyFormat`, `theme`, `lang`, `showVideo`. Everything else (transpose, volume, speed, handpan notes/scale, metronome, tempo factors, server URL) stays local. A new value for a synced key needs a rules change + deploy first; until then the client keeps it local and syncs the other keys.
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

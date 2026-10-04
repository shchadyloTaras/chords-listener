# Chords Listener online — cloud contract

Goal: the GitHub Pages site (https://shchadylotaras.github.io/chords-listener/) is a complete web service.
A user registers (Firebase Auth email/password), pastes a YouTube link, uploads audio, or lets the site
listen (microphone / this tab), and gets the analysis on the site. Nothing has to be installed. The local
server (`./start.sh`) keeps working unchanged as an optional extra.

The Firebase / GCP project is `build-chords-listener` on the Blaze plan. Already enabled APIs: run,
cloudbuild, artifactregistry, iamcredentials, storage, firestore, identitytoolkit.

## Architecture

| Piece | Where |
|---|---|
| Frontend | GitHub Pages (Vite build, base `/chords-listener/`), Actions workflow `.github/workflows/pages.yml` |
| API | Cloud Run service `chords-api`, region `europe-west1`: **https://chords-api-84488579848.europe-west1.run.app**. Image `europe-west1-docker.pkg.dev/build-chords-listener/chords/api` built by Cloud Build from `backend/Dockerfile` |
| Files | One GCS bucket: the project's Firebase Storage default bucket `build-chords-listener.firebasestorage.app` (created in `EUROPE-WEST1` by the deploy script). Mounted on Cloud Run at `/data` (Cloud Storage volume, gen2, mount options `uid=10001;gid=10001` = the image's non-root user), so the backend's file storage works with `CHORDS_DATA_DIR=/data`. Job scratch space is local (`CHORDS_WORK_DIR=/tmp/chords-work`, in memory) |
| Users | Firebase Auth (email/password, already live). Firestore keeps only the synced settings (`users/{uid}`) |
| Jobs | In memory on the single instance (`max-instances=1`); files on the bucket. A restart loses running/finished job records, never tracks |

## Auth

- Cloud mode (`CHORDS_AUTH=firebase`): every `/api/*` call except `/api/health`, `/api/docs` and `/api/openapi.json` needs `Authorization: Bearer <Firebase ID token>`. The token is verified for project `build-chords-listener` (RS256 against Google's public certificates, cached per their `Cache-Control`; issuer `https://securetoken.google.com/build-chords-listener`, audience = project id, `exp`/`iat` with 60 s leeway), giving `uid` (`sub`; only `[A-Za-z0-9_-]{1,128}` is accepted). Missing or invalid → 401 `unauthorized` (with `WWW-Authenticate: Bearer`; CORS headers are present, so the page can read it). Google's certificates unreachable and none cached → 503 `internal`. Implementation: `backend/app/auth.py` (`AuthMiddleware`, `FirebaseTokenVerifier`, `MediaSigner`).
- Emulators: with `FIREBASE_AUTH_EMULATOR_HOST` set, the server also accepts the Auth emulator's unsigned tokens (claims still checked). Never set it on the real service.
- Smoke tests: header `X-Smoke-Key: <CHORDS_SMOKE_KEY>` acts as uid `smoke-test` (keys shorter than 16 characters are ignored). The key is a random secret set only as an env var on the service and in the deployer's gitignored `.cloud.env`. Never commit it.
- `GET /api/me` → `UserInfo` `{uid, cloud, quotas: {day, analyses: {used, limit}, vocals: {...}, jobs: {...}}}` (local server: `{uid: null, cloud: false, quotas: null}`).
- Local mode (`CHORDS_AUTH=off`, the default): no auth (Authorization / X-Smoke-Key are ignored), a single implicit user; legacy layout `data/tracks/<id>` unchanged.

## Per-user data

- Cloud layout: `/data/users/<uid>/tracks/<trackId>/…` (audio.mp3, analysis.json, meta.json, edits.json, notes.json, vocals.json, stems/…), `/data/users/<uid>/quota.json`, plus `/data/users/<uid>/uploads/<uploadId>/<filename>` (client uploads, deleted after ingest).
- Storage helpers resolve paths for the *current user*, a context variable set per request (`app/users.py`: `current_uid()`, `user_context(uid)`) and captured by background jobs, so feature code (e.g. vocals) never builds user paths itself. In cloud mode a helper called without a user raises `NoUserContext` instead of falling back to shared paths. Helpers on the `TrackStore` (`app.state.store`, also `jobs.store`), stable names:
  - `store.track_dir(id)`, `store.audio_path(id)`, `store.exists(id)`, `store.read_meta(id)`, `store.duration(id)`, `store.root` (the user's tracks dir), `store.list_tracks()`
  - `store.user_dir()` (`<data>/users/<uid>`; local: `<data>`), `store.uploads_dir()`, `store.upload_prefix()` (`users/<uid>/uploads/`)
  - `store.media_url(id, name)` → `/api/tracks/<id>/<name>`, signed in cloud mode, e.g. `store.media_url(id, "stems/vocals")`
  - `store.new_work_dir(prefix)` (scratch; may be on another file system than the library: write results into `track_dir(id)` by copying, not by renaming directories)
  - Jobs: anything submitted through `JobManager` (`_new_record` + `_submit`) records the owner and runs in a copy of the request's context. Code starting its own threads uses `contextvars.copy_context().run(...)` or `with user_context(uid)`. `jobs.admit("vocals")` enforces the running-jobs limit and counts one daily vocal transcription (call it right before submitting; raises `QuotaExceeded` → 429).
- Jobs are per user: `GET /api/jobs` lists only the caller's jobs, `GET /api/jobs/{id}` of another user's job → 404; running-job dedup (same link / same file) never crosses users. Tracks are deduplicated per user (another user's identical file is analyzed into their own library).
- Quotas, per user per UTC day (env-overridable): `CHORDS_QUOTA_ANALYSES=40`, `CHORDS_QUOTA_VOCALS=15`, at most `CHORDS_QUOTA_JOBS=2` running jobs per user. A unit is counted when a job is accepted (failures still count; "Already analyzed" duplicates don't). Exceeded → 429 `quota_exceeded` (the detail says which limit). Counters live in `users/<uid>/quota.json` and survive restarts. Local mode has no quotas.

## Media URLs

Track JSON returns **signed** relative URLs, e.g. `/api/tracks/<id>/audio?u=<uid>&exp=<unix>&sig=<hmac>`. The HMAC uses `CHORDS_SIGNING_KEY` over uid, path and exp, and is valid for 12 h. `<audio>` elements can therefore play them without headers. HTTP Range must keep working. Stems use the same scheme: `/api/tracks/<id>/stems/{vocals|instruments}`. The client resolves relative URLs against the API base.

Details: `sig` = base64url(HMAC-SHA256(key, "v1\n<uid>\n<path>\n<exp>")) without padding; `exp` is rounded up to the next full hour + 12 h, so a URL stays identical within an hour (cacheable) and is valid 12–13 h. The middleware accepts a signature on `GET`/`HEAD` of `^/api/tracks/<id>/(audio|stems/<name>)$` and runs the request as `u`; an invalid or expired signature → 401 `unauthorized` (reload the track for a fresh URL). The same paths also work with a Bearer token. Local mode keeps plain `/api/tracks/<id>/audio`.

## Uploads

- Cloud Run caps request bodies at 32 MiB. So in cloud mode the client uploads to Firebase Storage `users/{uid}/uploads/{uploadId}/{filename}` (resumable, with progress). Storage rules: only the owner may write, ≤ 500 MB, contentType `audio/*`, `video/*` or `application/octet-stream`. No client reads.
- The client then calls `POST /api/jobs/storage` with `{ path, title?, source?, startOffset?, options? }` → `Job`. The server checks that `path` starts with `users/<uid>/uploads/`, ingests the file like a normal upload (sha1 dedup per user), and deletes the upload.
  - The server reads the object with the google-cloud-storage client (bucket `CHORDS_UPLOAD_BUCKET`; `STORAGE_EMULATOR_HOST` points it at the Storage emulator), not through the `/data` mount. The object is deleted as soon as it was downloaded, also when the analysis then fails.
  - Errors: another user's prefix → 403 `unauthorized`; bad path (`..`, empty segments) or missing object → 404 `not_found`; larger than `CHORDS_MAX_UPLOAD_MB` (500) → 413 `too_large`; empty → 415 `unsupported_format` (both delete the object); not a cloud server / no bucket → 501 `unavailable`; YouTube source without a usable `videoId`/`url` → 400 `invalid_url`.
  - `source: {type: 'youtube', videoId, url?}`: the track is linked to the video (`source`, thumbnail, title + channel from YouTube's oEmbed unless `title` is given). `startOffset` (seconds, video time where the recording began) shifts every analysis time; the track gets `startOffset` and an `N` chord over 0..startOffset (see `Track.startOffset` in types.ts). Re-analysis keeps the shift.
  - Uploads abandoned for more than 24 h are deleted when the server starts.
- `POST /api/jobs/upload` (multipart) still works for small files and in local mode. In cloud mode it accepts at most `CHORDS_MAX_REQUEST_MB=30` MB and answers 413 `too_large` ("…upload them to cloud storage and use POST /api/jobs/storage") above that; Cloud Run itself rejects bodies over 32 MiB before they reach the app.

## YouTube

- `POST /api/jobs {url}`: the server tries yt-dlp (with the node JS runtime). When YouTube answers with a bot check / sign-in wall, the job fails with `download_blocked`. Other failures stay `download_failed`.
  - Classified as `download_blocked` (`sources.is_blocked_message`): "Sign in to confirm…" (bot check, age gate), "not a bot", the `--cookies-from-browser` hint, HTTP 403 / 429 / "Too Many Requests", "content is not available on this app", and for YouTube links also "Requested format is not available" / "Only images are available" (all streams withheld).
- Client fallback ("Слухати у вкладці"):
  1. The video plays embedded on the page.
  2. The site captures this tab's audio (`getDisplayMedia`, desktop Chrome/Edge), showing live chords while it plays. Recording pauses and resumes with the video.
  3. It uploads the recording to Storage, then calls `POST /api/jobs/storage` with `{ path, source: { type: 'youtube', videoId, url }, startOffset }`. `startOffset` is the video time in seconds where the recording began.
  4. The resulting track is linked to the video: its chord times are shifted by `startOffset`, so they line up with the video. Playback can use the YouTube embed.
- Phones (no tab capture): listen through the microphone, or upload the file.

## Vocals

- `POST /api/tracks/{id}/vocals` (body optional: `{force?: boolean}`) → `Job` with `kind: 'vocals'`. It runs Demucs htdemucs separation, then torchcrepe pitch tracking and note segmentation. It writes `vocals.json` (`VocalNotes`) and the stems `vocals.mp3` and `instruments.mp3` (instruments = bass + other, no drums).
  - Already transcribed and no `force` → the job is `done` at once (no quota used). A second POST while one runs returns the running job.
  - The job has `trackId` from the start, `status: 'analyzing'`, `progress` 0..1 and English stage messages ("Separating vocals", "Saving stems", "Tracking the melody", "Finding notes", "Waiting for another vocal analysis": one vocal job runs at a time per server, the others queue). Failures: `errorCode` `analysis_failed` / `unsupported_format` / `unavailable`; `not_found` when the track is deleted meanwhile.
  - Cloud: counts one `vocals` quota unit (`CHORDS_QUOTA_VOCALS`, 429 `quota_exceeded`).
- `GET /api/tracks/{id}/vocals` → `VocalNotes` (`Cache-Control: no-cache`), or 404 `not_found`. Note times are track times (shifted by `startOffset` like the chords); `notes` MIDI is already corrected by `tuningCents`. `contour` (50 Hz) is the **raw** f0 (fractional MIDI, not tuning-corrected): subtract `tuningCents / 100` to draw it over the notes.
- The Track / TrackSummary get `vocals: true` and `stems: ['vocals', 'instruments']`; the Track also gets `stemUrls: {vocals, instruments}`: playable URLs, signed like `audioUrl` in cloud mode (not yet in `types.ts`).
- `GET|HEAD /api/tracks/{id}/stems/{vocals|instruments}` → `audio/mpeg` (44.1 kHz stereo, 160 kbit/s CBR, same length as `audio.mp3`, so it is in *audio* time like `audioUrl`), HTTP Range, `Cache-Control: private, no-cache` (a forced re-run replaces them).
- Re-analysis, reset and edits keep the vocals; deleting the track removes them.
- When the optional dependencies are not installed: 501 `unavailable` (unless already transcribed), and `health.engine.features.vocals = false`.
- Install: `cd backend && uv sync --extra vocals` (Linux takes `torch`/`torchaudio` from the PyTorch CPU wheel index, no CUDA; macOS uses PyPI and Apple MPS). Pre-download the Demucs weights (~84 MB) at build time with `python -m app.vocals.warmup` (exit code 1 on failure); keep the same `HF_HOME` at runtime and set `HF_HUB_OFFLINE=1`. Tuning: `CHORDS_VOCALS_DEVICE=auto|cpu|mps`, `CHORDS_VOCALS_THREADS` (default: the cgroup CPU quota), `CHORDS_VOCALS_CREPE=tiny|full` (default tiny).

## CORS / hosts

Allowed origins: `https://shchadylotaras.github.io`, `http://localhost:5173`, `http://localhost:8765` (+ `CHORDS_ALLOWED_ORIGINS`). Allowed host: the service's `*.run.app` host (+ `CHORDS_ALLOWED_HOSTS`).

As implemented (cloud mode): CORS allows the GitHub Pages origin, the default Vite origins and any page on a local host and port (`http(s)://localhost|127.0.0.1|[::1]|*.localhost[:port]`), plus `CHORDS_ALLOWED_ORIGINS` (added to the defaults, not replacing them). Cookies are never used, so CORS only decides which pages may read responses; the token is the credential. The cross-site check for writes accepts exactly those origins and same-origin requests (another `*.run.app` origin is rejected even though the host pattern matches). Allowed `Host` headers: `*.run.app`, `localhost`, `127.0.0.1`, `::1` (local testing of the cloud mode) + `CHORDS_ALLOWED_HOSTS`.

## Cloud Run settings (cost guards)

gen2 execution environment, 4 vCPU, 16 GiB, CPU always allocated (background jobs), timeout 3600 s, concurrency 16, min instances 0, **max instances 1**, startup CPU boost, unauthenticated invocations allowed (app-level auth above). Env: `CHORDS_AUTH=firebase`, `CHORDS_DATA_DIR=/data`, `CHORDS_SIGNING_KEY`, `CHORDS_SMOKE_KEY`, quotas.

As deployed by `scripts/deploy_cloud.sh`: runtime service account `chords-api@build-chords-listener.iam.gserviceaccount.com` with only `roles/storage.objectUser` on the bucket; volume `data` (cloud-storage, `mount-options=uid=10001;gid=10001`) at `/data`; env `CHORDS_AUTH=firebase`, `CHORDS_FIREBASE_PROJECT`, `CHORDS_DATA_DIR=/data`, `CHORDS_WORK_DIR=/tmp/chords-work`, `CHORDS_UPLOAD_BUCKET`, `CHORDS_SIGNING_KEY`, `CHORDS_SMOKE_KEY`, `CHORDS_QUOTA_ANALYSES=40`, `CHORDS_QUOTA_VOCALS=15`, `CHORDS_QUOTA_JOBS=2`, `CHORDS_MAX_WORKERS=2`. Artifact Registry keeps the 3 newest images (cleanup policy). The image (python 3.11 slim, ffmpeg, node 22, the `vocals` extra with CPU-only torch, non-root uid 10001) warms the chord models / numba kernels / Demucs weights at build time. numba's cache is keyed by the CPU, so the image pins `NUMBA_CPU_NAME=haswell` + empty `NUMBA_CPU_FEATURES` (AVX2 baseline, valid on every Cloud Run host); without it each new instance recompiled for ~20 s on its first analysis. At start-up the server preloads the chord models and analyzes 8 s of synthetic audio in the background (≈7 s), so the first real job runs at full speed. On the bucket mount every file check is a network round trip, so the track list reads the tracks in parallel.

## Frontend config

`frontend/src/config.ts` exports `CLOUD_API_URL` (from `import.meta.env.VITE_CLOUD_API_URL`, with the deployed URL as the fallback). The Pages workflow sets `VITE_CLOUD_API_URL`. The API base is chosen in this order:
1. Same-origin local server, when the page is served by `./start.sh`.
2. Cloud API, when the user is signed in.
3. A user-configured local server URL (advanced).
4. Browser-only mode.

## Deploy

`scripts/deploy_cloud.sh`: Cloud Build → Artifact Registry → `gcloud run deploy`. Auth comes from normal `gcloud auth`, or from an access token minted from the logged-in firebase-tools session (`scripts/gcloud_token.cjs`, written to a 0600 temp file and passed with `--access-token-file`).

- Steps (idempotent): enable APIs → Artifact Registry repo `chords` (+ cleanup policy) → Firebase Storage default bucket (`projects.defaultBucket.create`, `europe-west1`, linked to Firebase) → service account + bucket role → `firebase deploy --only storage` (`storage.rules`) → secrets in `.cloud.env` (generated once with `openssl rand`, mode 600, gitignored) → `gcloud builds submit backend --config backend/cloudbuild.yaml` (the uploaded source archive is deleted afterwards) → `gcloud run deploy` → prints the URL.
- `SKIP_SETUP=1` for code-only redeploys, `SKIP_BUILD=1` to redeploy the newest image with changed settings.
- `python3 scripts/smoke_cloud.py` runs the end-to-end smoke test against the service as `smoke-test` and cleans up after itself; `--cold` only measures the first request + one analysis.
- A full deploy takes ~9 min (Cloud Build ~7.5 min on the default free-tier machine, image ≈0.9 GB compressed); the uploaded source archive is deleted afterwards.

## Verified (2026-10-05, revisions `chords-api-00002` and `-00003`)

- `scripts/smoke_cloud.py`: 26/26 checks on both revisions — health; 401 without / with an invalid token (readable cross-origin); CORS preflight from GitHub Pages; multipart upload → job → track with chords → signed audio with `Range` (206), tampered / unsigned audio → 401; notes PUT/GET; bucket upload with `gcloud storage cp` → `POST /api/jobs/storage` linked to a YouTube video with `startOffset` (title from oEmbed, times shifted, upload object deleted); another user's path → 403; a real YouTube link; third concurrent job → 429 `quota_exceeded`; daily counter; delete.
- **YouTube from Cloud Run worked** (Rick Astley "Never Gonna Give You Up", 3:33: downloaded and analyzed in 22–34 s, key G#; yt-dlp logged one 403 on an API page and used another client). Data-center IPs can be blocked at any time; the server then answers `download_blocked` and the client falls back to tab capture.
- Timings: new instance ready 5–6 s after Cloud Run starts it (GCSFuse mount ~2 s + Python start); first response after scale-to-zero 9.2 s at the client; chord models ready ~3 s later (cached numba kernels), first song on that cold instance done 12 s after the first request. Warm: a 41 s song 6.8 s end to end; a 4-minute song 14 s in the engine, 22 s end to end (with a second job running); storage ingest 6.3 s. Idle instances shut down after ~15 min.
- Vocals on `-00003` (23 s synthetic song): `POST /api/tracks/{id}/vocals` done in 43 s, both stems served through signed `stemUrls` with `Range` (206), one `vocals` quota unit counted.
- Local, against the Firebase Auth + Storage emulators: emulator ID tokens accepted, `storage.rules` enforced (owner upload OK; other users, `text/plain`, paths outside `uploads/` and client reads → 403), the google-cloud-storage client reads and deletes uploads through `STORAGE_EMULATOR_HOST`.

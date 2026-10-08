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
| Users | Firebase Auth (email/password, already live). Firestore keeps the synced settings (`users/{uid}`) and the published library index (`users/{uid}/tracks/{trackId}`, written only by the API; see Library in Firestore) |
| Library reads | The signed-in site reads the library, `track.json`, notes and vocals straight from Firestore and Firebase Storage (owner-only rules) and streams audio through download-token URLs; the API is woken only for real work. Bucket CORS (`storage-cors.json`) lets the site stream it |
| YouTube fragments | Cloud Run service `chords-fetch` (europe-west1, up to 3 containers, private; `chords-api` calls it with an ID token): 30 s of a video through Cloudflare WARP into `fetch/` of the bucket. See YouTube clips |
| Jobs | In memory on the single instance (`max-instances=1`); files on the bucket. A restart loses running/finished job records, never tracks |

## Auth

- Cloud mode (`CHORDS_AUTH=firebase`): every `/api/*` call except `/api/health`, `/api/docs` and `/api/openapi.json` needs `Authorization: Bearer <Firebase ID token>`. The token is verified for project `build-chords-listener` (RS256 against Google's public certificates, cached per their `Cache-Control`; issuer `https://securetoken.google.com/build-chords-listener`, audience = project id, `exp`/`iat` with 60 s leeway), giving `uid` (`sub`; only `[A-Za-z0-9_-]{1,128}` is accepted). Missing or invalid → 401 `unauthorized` (with `WWW-Authenticate: Bearer`; CORS headers are present, so the page can read it). Google's certificates unreachable and none cached → 503 `internal`. Implementation: `backend/app/auth.py` (`AuthMiddleware`, `FirebaseTokenVerifier`, `MediaSigner`).
- Emulators: with `FIREBASE_AUTH_EMULATOR_HOST` set, the server also accepts the Auth emulator's unsigned tokens (claims still checked). Never set it on the real service.
- Smoke tests: header `X-Smoke-Key: <CHORDS_SMOKE_KEY>` acts as uid `smoke-test` (keys shorter than 16 characters are ignored). The key is a random secret set only as an env var on the service and in the deployer's gitignored `.cloud.env`. Never commit it.
- `GET /api/me` → `UserInfo` `{uid, cloud, quotas: {day, analyses: {used, limit}, vocals: {...}, jobs: {...}}}` (local server: `{uid: null, cloud: false, quotas: null}`).
- Local mode (`CHORDS_AUTH=off`, the default): no auth (Authorization / X-Smoke-Key are ignored), a single implicit user; legacy layout `data/tracks/<id>` unchanged.

## Per-user data

- Cloud layout: `/data/users/<uid>/tracks/<trackId>/…` (audio.mp3, analysis.json, meta.json, edits.json, notes.json, vocals.json, stems/…, and `track.json`, the published composed track, see Library in Firestore), `/data/users/<uid>/quota.json`, `/data/users/<uid>/publish-pending.json` (track ids whose publish failed), plus `/data/users/<uid>/uploads/<uploadId>/<filename>` (client uploads, deleted after ingest).
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

The signed-in site streams `audio.mp3` and the stems from Storage through download-token URLs instead (Library in Firestore → Media); the signed API URLs stay for other callers and as the fallback.

## Library in Firestore

A signed-in user's library, track data, notes, vocals and audio are read by the site straight from Firestore and Firebase Storage. The API is woken only for real work (a new analysis, re-analysis, vocals, an edit, a delete); writes stay on its endpoints. Changes made on another device arrive through the Firestore snapshot. Guests and the local server (`./start.sh`) are unchanged. Design: `docs/superpowers/specs/2026-10-05-library-firestore-storage-design.md`.

- **Publishing** (cloud mode; `CHORDS_PUBLISH`, on by default, `0|false|off` turns it off — not once the site reads the index, see below; the deploy script sets `1`). After every track change (new analysis, re-analysis, vocals, an edit, reset) the API bumps the integer `version` in `meta.json` and publishes, under a per-track lock (`backend/app/publish.py`, `backend/app/firestore.py`):
  1. `audio.mp3` and every `stems/<name>.mp3` get a `firebaseStorageDownloadTokens` metadata token and `contentType` `audio/mpeg` (an existing token is kept);
  2. `users/<uid>/tracks/<id>/track.json` is written: the Track JSON without `audioUrl` / `stemUrls`, plus `version` and `media: {audio: {path, token}, stems: {<name>: {path, token}}}`;
  3. the index document `users/{uid}/tracks/{trackId}` is upserted over the Firestore REST API with the runtime service account (no gRPC client): the `TrackSummary` fields of `GET /api/tracks` + `version` + `publishedAt`.
- A track, its notes and vocal notes, kept on a device with a version, are valid exactly while that version and the track's `createdAt` equal the index document's. A track deleted and added again gets the same id (ids come from the content) and starts at version 1 again, with new media objects and tokens; its `createdAt` (set when it is installed) tells it from the old one. `version` is bumped in every mode (a meta field, not part of the API's JSON); local mode publishes nothing and writes no `track.json`.
- **Delete** unpublishes first (removes the index document), then removes the directory, under the same lock, so a late publish cannot bring a deleted track back. "Already analyzed" duplicates publish the track when the index lacks it (self-heal for tracks that predate publishing).
- **Failures never fail the user's request.** A publish or unpublish that still fails after 3 attempts (HTTP 408/429/5xx, network) puts the track id into `users/<uid>/publish-pending.json`; the API retries those at start-up and every 10 minutes while an instance is up. The file is never client-readable.
- **Fallback.** When the index or a Storage read fails (permission, network, no answer within a few seconds, a track that is not published yet), the site uses the API path as before: missing Firestore / Storage rules or bucket CORS break nothing. A failed index, and each kind of Storage file (`track.json`, `notes.json`, `vocals.json`) once a read of it failed (anything but a missing object), stay on the API path for the rest of the session: a reload, or another account, tries again (no retry storms). An index that did not answer in time is not waited for again until it answers. Client side: docs/SPEC.md "Live library".
- **Do not turn publishing off once the site reads the index.** With `CHORDS_PUBLISH=0`, or without `CHORDS_UPLOAD_BUCKET` in cloud mode (the API then logs an error at start-up and publishes nothing), the index keeps answering, so no client ever takes the API path: a new analysis shows in the list on no device, and an edit seems to revert when the track is opened again (the index and `track.json` keep the old version). To send every client to the API instead, the kill switch is the rules: `allow read: if false;` on `users/{userId}/tracks/{trackId}` in `firestore.rules`, deployed with `firebase deploy --only firestore:rules`. The listener then errors and every client takes the API path (as with missing rules); keep publishing on meanwhile, so the index is current when reads are allowed again.
- **The backfill must run before the site.** An index that answers is taken as the whole library: a track without an index document (one that predates publishing, before the backfill ran) is not listed — opened by its link, it still comes from the API. So the site with the new read path is deployed only after a verified backfill (Rollout order, below).

### Rules

| What | Its owner (signed in) | Everyone else; any client write |
|---|---|---|
| Firestore `users/{uid}/tracks/{trackId}` (`firestore.rules`) | get and list | denied; only the API's service account writes (it bypasses rules) |
| Storage `users/{uid}/tracks/{trackId}/{track.json, notes.json, vocals.json, audio.mp3}` and `…/stems/{vocals.mp3, instruments.mp3}` (`storage.rules`) | read | denied |
| Storage `users/{uid}/tracks/{trackId}/{meta.json, analysis.json, edits.json, …}`, `users/{uid}/quota.json`, `publish-pending.json`, listings | denied | denied |

`firestore.rules.test.mjs` and `storage.rules.test.mjs` run against the local emulators (the commands are in their headers; the emulators need Java): owner get / list, other user and signed-out denied, no client write, the library files readable only by their owner, everything else denied, uploads unchanged.

### Media

`audio.mp3` and `stems/<name>.mp3` are streamed from `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<encodeURIComponent(path)>?alt=media&token=<token>` (bucket from `firebaseConfig.storageBucket`; path and token from `track.json` → `media`). The token URL is a bearer URL without expiry and does not go through the Storage rules; it stops working when the track is deleted (the object is gone). `track.json` itself is owner-readable only. A token URL that Storage refuses (403/404: the track was deleted and added again, a token was revoked in the console, or `track.json` was re-published with another token and the same version) makes the site forget its copy of the track and read `track.json` once more, else ask the API; once per track per session (the audio, the player's recovery and stems alike), never in a loop. A network failure (offline, no CORS) is not such a refusal and wakes nothing.

### Bucket CORS

`storage-cors.json`: `GET`, `HEAD` from `https://shchadylotaras.github.io`, `http://localhost:5173` and `http://localhost:4173`; response headers `Content-Type, Content-Length, Content-Range, Accept-Ranges`; `maxAgeSeconds` 3600. The deploy script applies it with `gcloud storage buckets update gs://$BUCKET --cors-file=storage-cors.json`; a new origin goes into the file, then the same command (or a full `scripts/deploy_cloud.sh`). Check: `gcloud storage buckets describe gs://build-chords-listener.firebasestorage.app --format='default(cors_config)'`.

### Rollout order and backfill

Each step runs only with the owner's OK, so each is run on its own. A full `scripts/deploy_cloud.sh` cannot do that: its setup (IAM, rules, CORS) runs before the API deploy, i.e. steps 2, 3, 1 in one go (Deploy, below).

1. **The API with publishing** (it writes the index and `track.json`; current clients ignore them). Until step 2 its index writes fail and wait in `publish-pending.json` (retried at start-up and every 10 minutes while an instance is up; the backfill covers them anyway): `SKIP_SETUP=1 scripts/deploy_cloud.sh` (Cloud Build and `gcloud run deploy` with `CHORDS_PUBLISH=1`, no IAM / rules / CORS step).
2. **IAM role** for the runtime service account: `gcloud projects add-iam-policy-binding build-chords-listener --member=serviceAccount:chords-api@build-chords-listener.iam.gserviceaccount.com --role=roles/datastore.user --condition=None`
3. **Rules and bucket CORS**: `npx -y firebase-tools@15 deploy --only storage,firestore:rules --project build-chords-listener`, then `gcloud storage buckets update gs://build-chords-listener.firebasestorage.app --cors-file=storage-cors.json`. `storage.rules` reads Firestore (an upload is refused once the account's purge began: `adminTombstones/{uid}`), which needs the Cloud Storage for Firebase service agent (`service-<project number>@gcp-sa-firebasestorage.iam.gserviceaccount.com`) to hold the cross-service role `roles/firebaserules.firestoreServiceAgent`. The Firebase CLI offers to grant it on the first such deploy: answer yes (or grant it in the console); without it every client upload is refused.
4. **Backfill, and verify it** (the job below). It prints `N track(s) published`. Every track has its `track.json` and nothing is pending: `gcloud storage ls 'gs://build-chords-listener.firebasestorage.app/users/*/tracks/*/meta.json' | wc -l` equals the same with `track.json`, and `gcloud storage ls 'gs://build-chords-listener.firebasestorage.app/users/*/publish-pending.json'` finds nothing. Look at a few index documents in the Firestore console (`users/<uid>/tracks`).
5. **The site with the new read path** (a push to `main` runs `.github/workflows/pages.yml`) — only then: it lists what the index has, and without the backfill older tracks would be missing from the list.

The smoke test (`python3 scripts/smoke_cloud.py`, Deploy below) runs after steps 1, 4 and 5; `--firestore-token-file PATH` (the published-library checks) applies from step 4 on — before step 2 the API cannot write the index, so those checks fail.

Backfill publishes the tracks that exist already: `python -m app.publish backfill [--uid UID]` (every user, or one) prints `N track(s) published`. It is idempotent: a track that is published already is simply published again. Run it once as a Cloud Run job with the service image and the service account:

```
gcloud run jobs deploy chords-backfill --region europe-west1 \
  --image europe-west1-docker.pkg.dev/build-chords-listener/chords/api:latest \
  --service-account chords-api@build-chords-listener.iam.gserviceaccount.com \
  --execution-environment gen2 --cpu 1 --memory 1Gi --max-retries 0 --task-timeout 3600 \
  --set-env-vars CHORDS_AUTH=firebase,CHORDS_FIREBASE_PROJECT=build-chords-listener,CHORDS_DATA_DIR=/data,CHORDS_UPLOAD_BUCKET=build-chords-listener.firebasestorage.app \
  --add-volume 'name=data,type=cloud-storage,bucket=build-chords-listener.firebasestorage.app,mount-options=uid=10001;gid=10001' \
  --add-volume-mount volume=data,mount-path=/data \
  --command python --args=-m,app.publish,backfill
gcloud run jobs execute chords-backfill --region europe-west1 --wait
```

(One user: `--args=-m,app.publish,backfill,--uid,<uid>`.) The job runs in its own process, so it is **not serialized against the live service**: the per-track locks live in the service. Run it when nobody is deleting tracks, e.g. right after the deploy, and re-run it to repair a track that was left unpublished or stale. It only looks at tracks that exist; an index document whose track was deleted at the same moment would stay and has to be removed by hand (Firestore console, `users/<uid>/tracks/<id>`).

## Uploads

- Cloud Run caps request bodies at 32 MiB. So in cloud mode the client uploads to Firebase Storage `users/{uid}/uploads/{uploadId}/{filename}` (resumable, with progress). Storage rules: only the owner may write, ≤ 500 MB, contentType `audio/*`, `video/*` or `application/octet-stream`, and not once the account's purge began (`adminTombstones/{uid}` in Firestore; its ID token stays valid for up to an hour). No client reads of uploads (the owner's reads of their published track files are in Library in Firestore → Rules).
- The client then calls `POST /api/jobs/storage` with `{ path, title?, source?, startOffset?, options? }` → `Job`. The server checks that `path` starts with `users/<uid>/uploads/`, ingests the file like a normal upload (sha1 dedup per user), and deletes the upload.
  - The server reads the object with the google-cloud-storage client (bucket `CHORDS_UPLOAD_BUCKET`; `STORAGE_EMULATOR_HOST` points it at the Storage emulator), not through the `/data` mount. The object is deleted as soon as it was downloaded, also when the analysis then fails.
  - Errors: another user's prefix → 403 `unauthorized`; bad path (`..`, empty segments) or missing object → 404 `not_found`; larger than `CHORDS_MAX_UPLOAD_MB` (500) → 413 `too_large`; empty → 415 `unsupported_format` (both delete the object); not a cloud server / no bucket → 501 `unavailable`; YouTube source without a usable `videoId`/`url` → 400 `invalid_url`.
  - `source: {type: 'youtube', videoId, url?}`: the track is linked to the video (`source`, thumbnail, title + channel from YouTube's oEmbed unless `title` is given). `startOffset` (seconds, video time where the recording began) shifts every analysis time; the track gets `startOffset` and an `N` chord over 0..startOffset (see `Track.startOffset` in types.ts). Re-analysis keeps the shift.
  - Uploads abandoned for more than 24 h are deleted by the API's bucket sweep (`users/*/uploads/**`; at start-up and then hourly, together with `fetch/**` older than an hour, see YouTube clips).
- `POST /api/jobs/upload` (multipart) still works for small files and in local mode. In cloud mode it accepts at most `CHORDS_MAX_REQUEST_MB=30` MB and answers 413 `too_large` ("…upload them to cloud storage and use POST /api/jobs/storage") above that; Cloud Run itself rejects bodies over 32 MiB before they reach the app.

## YouTube

- `POST /api/jobs {url}`: the server tries yt-dlp (with the node JS runtime). When YouTube answers with a bot check / sign-in wall, the job fails with `download_blocked`. Other failures stay `download_failed`.
  - Classified as `download_blocked` (`sources.is_blocked_message`): "Sign in to confirm…" (bot check, age gate), "not a bot", the `--cookies-from-browser` hint, HTTP 403 / 429 / "Too Many Requests", "content is not available on this app", and for YouTube links also "Requested format is not available" / "Only images are available" (all streams withheld).
- Client: a guest's YouTube link opens "Слухати у вкладці" (`#/listen/youtube/<videoId>`); a signed-in user's opens the fragment picker (`#/youtube/<videoId>`, see "YouTube clips" below); a YouTube page that is not one video (a playlist, a channel, a clip) only gets a hint to copy the video's own link. `parseYouTubeId` (`frontend/src/components/input/url.ts`) reads the same hosts and shapes as `sources._youtube_id_from` — keep them in step. A local server (`backend: 'local'`, a home connection) downloads whole videos. The API behaviour above (a whole video through yt-dlp from Cloud Run) remains for direct callers and old jobs: a job that ends in `download_blocked` offers "Слухати у вкладці".
- "Слухати у вкладці":
  1. The video plays embedded on the page.
  2. The site captures this tab's audio (`getDisplayMedia`, desktop Chrome/Edge), showing live chords while it plays. Recording pauses and resumes with the video.
  3. It uploads the recording to Storage, then calls `POST /api/jobs/storage` with `{ path, source: { type: 'youtube', videoId, url }, startOffset }`. `startOffset` is the video time in seconds where the recording began.
  4. The resulting track is linked to the video: its chord times are shifted by `startOffset`, so they line up with the video. Playback can use the YouTube embed.
- Phones and browsers without tab capture (Safari, Firefox): the same page offers the microphone (the song playing nearby) or uploading the file.

## YouTube clips (`chords-fetch`)

Spec: `docs/superpowers/specs/2026-10-07-youtube-warp-fetch-design.md`. YouTube asks Google Cloud addresses to prove they are not a bot; through Cloudflare WARP it does not (spike 2026-10-07: 18/18 videos, 54/54 from 3 parallel containers sharing one profile, 0 bot checks). WARP from Cloud Run works only over **Direct VPC egress + Cloud NAT**; over the default egress the WireGuard tunnel comes up but stalls on any payload over ~500 bytes.

- `POST /api/jobs {url, clip: {start}}` (chords-api, signed-in users): dedup by track key `youtube:<videoId>@<start>` → admit (quota "analyses") → `RemoteClipFetcher` calls `POST $CHORDS_FETCH_URL/clip {videoId, start, length: CHORDS_YT_CLIP_S}` with a Google ID token (audience = that URL; a failed token is a `download_failed` job, not a crash); 429 / 503 / no connection are asked again with backoff for up to 60 s, then `download_failed` "The server is busy, try again in a minute". The answer names an object under `fetch/` (a `path` outside it is refused and nothing is deleted); the API downloads it, deletes it, and analyzes it with `startOffset = start`; the track gets `clip: {start, end}`. Without `CHORDS_FETCH_URL` a cloud server answers 501 `unavailable` (it never downloads YouTube itself); a local server downloads fragments in-process (`LocalClipFetcher`). A fragment job is one job in two phases: the download (the wait for `chords-fetch`, up to minutes) runs on its own pool of 4 threads (`CLIP_FETCH_WORKERS`) and then queues the analysis on the analysis pool (`CHORDS_MAX_WORKERS`), so a slow download never holds an analysis worker; the dedup keys stay claimed across both phases, and cancelling works in both.
- `chords-fetch` (`backend/app/fetch_service.py`, image `backend/fetch.Dockerfile`): FastAPI, `POST /clip {videoId, start, length}` (id `^[A-Za-z0-9_-]{11}$`, `start` 0..86400 whole seconds, `length` 1..60; anything else 400 `invalid_url`; URLs are never accepted). It probes the video (live streams and a start past the end → `invalid_url`), downloads `[start, min(start + length, duration)]` with yt-dlp `download_ranges` (yt-dlp through `socks5h://127.0.0.1:40000`; ffmpeg, which fetches and cuts the range and can't use SOCKS, through the HTTP proxy, see WARP below), uploads `fetch/<requestId>/source.<ext>` to the Firebase bucket and answers `{title, artist, duration, thumbnail, start, end, path, size}`; errors `{code, message}`. The cut is exact: ffmpeg re-encodes the 30 s (`force_keyframes_at_cuts`), because a stream-copy cut snapped to a seek point up to ~10 s early and misaligned the chords.
  - Retries: a refused media URL (HTTP 403) or a stall, including "ffmpeg exited with code N", gets up to 3 fresh tries; a bot check gets one WARP reconnect (new session) and one more try, then `download_blocked`. ffmpeg gives up on a network stall after 20 s (`-rw_timeout`); each try is cut off after 90 s by a watchdog; no new try starts after 240 s per request; with ffmpeg's 20 s stall timeout a request normally ends well under Cloud Run's 300 s (a try that starts just before 240 s can still run to its 90 s watchdog). A dead tunnel (wireproxy exited, or the last request ended in network failures) is reconnected before the next request. One log line per request (video, range, outcome, attempts, seconds), no user ids.
- WARP: `wireproxy` (`github.com/windtf/wireproxy` v1.1.3) on the wgcf profile from Secret Manager (`warp-profile`, mounted at `/secrets/warp/wgcf-profile.conf`), as SOCKS5 `127.0.0.1:40000` (yt-dlp) and HTTP CONNECT `127.0.0.1:40001` (ffmpeg: `-http_proxy` via yt-dlp's `external_downloader_args`); the container listens only after `https://www.cloudflare.com/cdn-cgi/trace` shows `warp=on` through the proxy. One profile is shared by all containers.
- Cloud Run (`scripts/deploy_fetch.sh`): `europe-west1`, gen2, 1 vCPU / 1 GiB, request-based billing, concurrency 1, min 0 / max `FETCH_MAX_INSTANCES` (3), timeout 300 s, `--no-allow-unauthenticated` (only `chords-api`'s service account has `roles/run.invoker`), Direct VPC egress `all-traffic` on `default`/`default`, service account `chords-fetch` with `roles/storage.objectUser` limited by an IAM condition to `objects/fetch/` and `roles/secretmanager.secretAccessor` on `warp-profile`. Cloud Router `chords-nat-router` + Cloud NAT `chords-nat` (auto IP, all subnet ranges); Private Google Access on subnet `default`. **An IAM condition on a bucket needs uniform bucket-level access** on it: check `gcloud storage buckets describe gs://build-chords-listener.firebasestorage.app --format='value(uniform_bucket_level_access)'` and enable it if it is off (`gcloud storage buckets update gs://build-chords-listener.firebasestorage.app --uniform-bucket-level-access`) before the first deploy. Next to that conditional binding, `chords-api`'s own bucket binding in `deploy_cloud.sh` carries `--condition=None` (required once the bucket's policy has a conditional binding).
- Clean-up: the API deletes each fragment once read; its bucket sweep runs hourly (the first at start-up) and removes `fetch/**` older than 1 h and `users/*/uploads/**` older than a day.
- Cost: Cloud NAT gateway + IP ≈ $4–5 / month whether used or not; NAT data ≈ $0.045 / GB (a fragment ≈ 0.5 MB); `chords-fetch` within Cloud Run's free tier at this scale; Secret Manager within its free tier.
- Rollout order: `scripts/deploy_fetch.sh` → `scripts/deploy_cloud.sh` (sets `CHORDS_FETCH_URL` when `chords-fetch` exists, and `CHORDS_YT_CLIP_S=30`) → `python3 scripts/smoke_fetch.py` → the web release. The web release must not go out before `deploy_cloud.sh`: an API without `clip` support ignores the unknown `clip` field of `POST /api/jobs` and would download the whole video. With the new API but no `chords-fetch` (or no `CHORDS_FETCH_URL`), fragments answer 501 and the site opens "Слухати у вкладці", so `chords-fetch` itself may come later.
- Smoke (`scripts/smoke_fetch.py`, as `smoke-test`): one 30 s fragment of each of the 18 spike videos; it first deletes fragment tracks that earlier runs left for these videos, deletes everything it made, and fails when a delete fails. A run spends up to 18 of the smoke user's 40 daily analyses (`CHORDS_QUOTA_ANALYSES`), so a third run, or one after `smoke_cloud.py`, on the same UTC day may hit 429.
- Risks: YouTube may start flagging WARP addresses (fallback: the capture page; next step several profiles or a home relay); yt-dlp must be bumped in `backend/uv.lock` and `backend/fetch.Dockerfile` together (`tests/test_fetch_image.py`); WARP's free tier is meant for personal devices.

## Vocals

- `POST /api/tracks/{id}/vocals` (body optional: `{force?: boolean}`) → `Job` with `kind: 'vocals'`. It runs Demucs htdemucs separation, then torchcrepe pitch tracking and note segmentation. It writes `vocals.json` (`VocalNotes`) and the stems `vocals.mp3` and `instruments.mp3` (instruments = bass + other, no drums).
  - Already transcribed and no `force` → the job is `done` at once (no quota used). A second POST while one runs returns the running job.
  - The job has `trackId` from the start, `status: 'analyzing'`, `progress` 0..1 and English stage messages ("Separating vocals", "Saving stems", "Tracking the melody", "Finding notes", "Waiting for another vocal analysis": one vocal job runs at a time per server, the others queue). Failures: `errorCode` `analysis_failed` / `unsupported_format` / `unavailable`; `not_found` when the track is deleted meanwhile.
  - Cloud: counts one `vocals` quota unit (`CHORDS_QUOTA_VOCALS`, 429 `quota_exceeded`).
  - `POST /api/jobs/{id}/cancel` stops it (the "Скасувати" button on the vocals card): `errorCode: "cancelled"`, the quota unit is given back, and asking for the vocals again starts a new job even while the old one is still stopping.
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

gen2 execution environment, 4 vCPU, 16 GiB, CPU always allocated (background jobs), timeout 3600 s, concurrency 16, min instances 0, **max instances 1**, startup CPU boost, unauthenticated invocations allowed (app-level auth above). Env: `CHORDS_AUTH=firebase`, `CHORDS_DATA_DIR=/data`, `CHORDS_SIGNING_KEY`, `CHORDS_SMOKE_KEY`, `CHORDS_PUBLISH`, quotas, `CHORDS_FETCH_URL`, `CHORDS_YT_CLIP_S`.

As deployed by `scripts/deploy_cloud.sh`: runtime service account `chords-api@build-chords-listener.iam.gserviceaccount.com` with only `roles/storage.objectUser` on the bucket and `roles/datastore.user` on the project (the library index is written to Firestore); volume `data` (cloud-storage, `mount-options=uid=10001;gid=10001`) at `/data`; env `CHORDS_AUTH=firebase`, `CHORDS_FIREBASE_PROJECT`, `CHORDS_DATA_DIR=/data`, `CHORDS_WORK_DIR=/tmp/chords-work`, `CHORDS_UPLOAD_BUCKET`, `CHORDS_PUBLISH=1`, `CHORDS_SIGNING_KEY`, `CHORDS_SMOKE_KEY`, `CHORDS_QUOTA_ANALYSES=40`, `CHORDS_QUOTA_VOCALS=15`, `CHORDS_QUOTA_JOBS=2`, `CHORDS_MAX_WORKERS=2`, `CHORDS_YT_CLIP_S=30`, `CHORDS_FETCH_URL` (when `chords-fetch` exists). Artifact Registry keeps the 3 newest images (cleanup policy). The image (python 3.11 slim, ffmpeg, node 22, the `vocals` extra with CPU-only torch, non-root uid 10001) warms the chord models / numba kernels / Demucs weights at build time. numba's cache is keyed by the CPU, so the image pins `NUMBA_CPU_NAME=haswell` + empty `NUMBA_CPU_FEATURES` (AVX2 baseline, valid on every Cloud Run host); without it each new instance recompiled for ~20 s on its first analysis. At start-up the server preloads the chord models and analyzes 8 s of synthetic audio in the background (≈7 s), so the first real job runs at full speed. On the bucket mount every file check is a network round trip, so the track list reads the tracks in parallel.

## Frontend config

`frontend/src/config.ts` exports `CLOUD_API_URL` (from `import.meta.env.VITE_CLOUD_API_URL`, with the deployed URL as the fallback). The Pages workflow sets `VITE_CLOUD_API_URL`. The API base is chosen in this order:
1. Same-origin local server, when the page is served by `./start.sh`.
2. Cloud API, when the user is signed in.
3. A user-configured local server URL (advanced).
4. Browser-only mode.

## Deploy

`scripts/deploy_cloud.sh`: Cloud Build → Artifact Registry → `gcloud run deploy`. Auth comes from normal `gcloud auth`, or from an access token minted from the logged-in firebase-tools session (`scripts/gcloud_token.cjs`, written to a 0600 temp file and passed with `--access-token-file`).

- Steps (idempotent): enable APIs (including `firestore.googleapis.com`) → Artifact Registry repo `chords` (+ cleanup policy) → Firebase Storage default bucket (`projects.defaultBucket.create`, `europe-west1`, linked to Firebase) → service account + bucket role `roles/storage.objectUser` + project role `roles/datastore.user` → `firebase deploy --only storage,firestore:rules` (`storage.rules`, `firestore.rules`) → bucket CORS (`gcloud storage buckets update gs://$BUCKET --cors-file=storage-cors.json`) → secrets in `.cloud.env` (generated once with `openssl rand`, mode 600, gitignored) → `gcloud builds submit backend --config backend/cloudbuild.yaml --region $REGION` (the uploaded source archive is deleted afterwards) → `gcloud run deploy` → prints the URL.
- `scripts/deploy_fetch.sh` (before `deploy_cloud.sh`): APIs (Secret Manager, Compute) → secret `warp-profile` (registered once with a local `wgcf`, only when Secret Manager answers NOT_FOUND and you answer "y"; any other failure stops the script) → Cloud Router + Cloud NAT + Private Google Access → service account `chords-fetch` + IAM → `gcloud builds submit backend --config backend/fetch.cloudbuild.yaml` → `gcloud run deploy chords-fetch` → `roles/run.invoker` for `chords-api` → one fragment straight from the service when `gcloud auth print-identity-token` works (it deletes only the object under `fetch/` that the answer names). Both scripts share `scripts/gcloud_common.sh` (credentials, Cloud Build wait loop). Before the first run the bucket needs uniform bucket-level access (YouTube clips, above).
- `SKIP_SETUP=1` for code-only redeploys (skips the APIs, IAM, rules and CORS steps too), `SKIP_BUILD=1` to redeploy the newest image with changed settings.
- `python3 scripts/smoke_cloud.py` runs the end-to-end smoke test against the service as `smoke-test` and cleans up after itself; `--cold` only measures the first request + one analysis. With `--firestore-token-file PATH` (an access token that reads Firestore and the bucket, e.g. `gcloud auth print-access-token > PATH`) it also checks the published library: after the upload analysis the index document `users/smoke-test/tracks/<id>` exists with `version >= 1` and `gcloud storage cat` shows a matching `track.json`; after the delete the index documents are gone.
- A full deploy takes ~9 min (Cloud Build ~7.5 min on the default free-tier machine, image ≈0.9 GB compressed); the uploaded source archive is deleted afterwards.
- The build runs in `$REGION` (europe-west1), the Artifact Registry repo's region. From the global pool (US) each build's cache pull of the previous image was billed as intercontinental Artifact Registry egress (~$0.06 per deploy).

## Admin console

The administrator's page (`admin.html`, built next to the site by the Pages workflow) and `/api/admin/*` on the same Cloud Run service: **https://shchadylotaras.github.io/chords-listener/admin.html**. Anyone without the admin mark gets "Сторінку не знайдено" (AC-31). Design: [`docs/features/admin/sad.md`](features/admin/sad.md), [spec](features/admin/spec.md), [data model](features/admin/data-model.md); who may write the allowlist: [ADR-0006](features/admin/adr/0006-authorize-admins-via-firestore-allowlist-with-60s-cache.md). No new service, no 2FA in v1 (final actions need a sign-in no older than 15 minutes), no e-mails to users.

### Granting and revoking admins

Only the owner can do it, from their own machine: `scripts/admin_grant.py` writes or deletes `adminAllowlist/<uid>` in Firestore with the owner's Application Default Credentials (no key file, no service account; the server's code has no write path to that collection). The e-mail is only looked up in Firebase Auth to find the uid and is never stored; the document holds `grantedAt` and an optional `--note` (up to 200 characters, never an e-mail).

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project build-chords-listener   # once per machine
backend/.venv/bin/python scripts/admin_grant.py grant  person@example.com --note "support"
backend/.venv/bin/python scripts/admin_grant.py revoke person@example.com
```

A grant by e-mail is refused when Firebase Auth has not verified that e-mail (grant by uid once you have checked who owns it; a revoke works either way). A uid works in place of the e-mail; `--project ID` overrides `build-chords-listener`. Exit code 0 also means "already granted" / "was not an admin"; 1 means refused or failed (the message says why). The person has to have signed in to the site once, or the e-mail has no uid yet. The server caches the allowlist for 60 seconds, so **a revoke takes effect within a minute** (AC-32): from then on every admin action and read of an already open admin page is refused with the same "not found" answer. Every change is visible in Cloud Audit Logs under the owner's name; anyone with write access to the project's Firestore can also change the allowlist, so keep that IAM role with the owner alone. Against the emulators: `FIRESTORE_EMULATOR_HOST=localhost:8080 FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 backend/.venv/bin/python scripts/admin_grant.py grant some-test-uid` (an e-mail needs an account in the Auth emulator).

### Migrations: promotion order 01–06

The staged files in [`docs/features/admin/migrations/`](features/admin/migrations/) are the only copy (the repo has no live migrations tree). Each step is idempotent and has a `.down` pair; run them one at a time, in this order, each with the owner's OK. 02 and 03 are already merged into `firestore.indexes.json` and `firestore.rules`, so they are deployed, not copied.

| # | File | Run |
|---|---|---|
| 01 | `01_add_track_size.up.py` | adds `sizeBytes` to every published track; it measures the track files, so `CHORDS_DATA_DIR` must point at the mounted bucket (the same files the service sees at `/data`) |
| 02 | `02_admin_indexes_and_ttl.up.json` | `npx -y firebase-tools@15 deploy --only firestore:indexes --project build-chords-listener`; wait until the indexes are built (Firebase console → Firestore → Indexes). 18 composite indexes: each of 9 in both directions, because Firestore reads an index only in its declared direction (the way back, a range with no order and a `count()` over a period need the ascending one; data-model.md → Indexes) |
| 03 | `03_admin_rules.up.rules` | `npx -y firebase-tools@15 deploy --only firestore:rules,storage --project build-chords-listener` (`storage.rules` refuses a purged account's uploads by reading Firestore: accept the CLI's offer to grant the Storage service agent its cross-service Firestore role, step 3 of "Library in Firestore" above) |
| 04 | `04_seed_runtime_config.up.py` | creates `adminConfig/settings` and `publicStatus/current` from the `CHORDS_*` values, only if absent |
| 05 | `05_build_email_index.up.py` | builds the e-mail search index from `users` |
| 06 | `06_restore_stats_from_tracks.up.py` | restores the daily statistics before the launch day: `--before YYYY-MM-DD` (the day the admin goes live) |

01, 04, 05 and 06 run from `backend/` with the owner's credentials; add `--dry-run` first, then run again without it (each prints what it found or changed):

```bash
gcloud auth application-default login
cd backend
export CHORDS_AUTH=firebase   # cloud mode: tracks live under <data>/users/<uid> (without it 01 finds nothing)
export CHORDS_FIREBASE_PROJECT=build-chords-listener
export PYTHONPATH=.:../docs/features/admin/migrations
.venv/bin/python ../docs/features/admin/migrations/04_seed_runtime_config.up.py --dry-run
.venv/bin/python ../docs/features/admin/migrations/05_build_email_index.up.py --dry-run
.venv/bin/python ../docs/features/admin/migrations/06_restore_stats_from_tracks.up.py --before 2026-10-15 --dry-run
CHORDS_DATA_DIR=/path/to/mounted/bucket .venv/bin/python ../docs/features/admin/migrations/01_add_track_size.up.py --dry-run
```

Without a local mount of the bucket, 01 can run against a size-only mirror: list `gs://<bucket>/users/**` with `gcloud storage ls -l -r`, create each object as an empty file truncated to its size (sparse: no content is downloaded, `dir_size` reads `st_size`), point `CHORDS_DATA_DIR` at it, and delete the mirror afterwards (done this way on 2026-10-08). Put the real launch day in `--before`. Roll back with the matching `*.down.*` file in reverse order (06 → 01); roll back 01 only after the code that writes `sizeBytes` is rolled back, or the publish path adds it again. Rolling out the code: 01–04 before the new revision serves the admin page (the server falls back to the `CHORDS_*` values while `adminConfig/settings` is missing), 05 and 06 may follow it.

### Sweep schedule and alerts

`scripts/deploy_cloud.sh` (after the deploy; `SKIP_OPS=1` skips it) sets up the background work, idempotently:

- **Max instances = 1 guard.** The daily quota, the probe limiter and the deletion limit are counted in the memory of the one process, so the script refuses any `MAX_INSTANCES` other than 1 before it touches Google Cloud, checks the deployed value afterwards, and the server logs a warning at start-up when the cap is not 1.
- **Two Cloud Scheduler jobs** `chords-sweep-0015` (00:15 UTC) and `chords-sweep-1215` (12:15 UTC) call `POST /api/internal/sweep` with an OIDC token of the service account `chords-scheduler@build-chords-listener.iam.gserviceaccount.com` (role `run.invoker`); the server checks signature, audience and that e-mail. A sweep replays the projections, closes stale jobs, reconciles and freezes yesterday, syncs the e-mail index and runs due deletions; the first natural wake-up after 00:00 UTC runs it too. Twice a day because a deletion then runs at most 12 hours after its window and one failed pass still fits in 24; the price is up to 30 minutes of instance time on a day with no traffic.
- **Log-based metrics** `admin_request`, `server_wake_by`, `deletion_overdue`, `stats_mismatch`, `audit_write_failed`, and **two alert policies e-mailed to `ALERT_EMAIL`** (environment or `.cloud.env`): `deletion_overdue > 0` (a deletion is more than 24 hours late) and `stats_mismatch > 0` (the nightly reconciliation of a day found a difference). Without `ALERT_EMAIL` the script warns and creates no alerts. These are operational alerts for the owner, not an admin feature.

See the plan without touching Google Cloud: `DRY_RUN=1 scripts/deploy_cloud.sh`. Run the sweep by hand: `gcloud scheduler jobs run chords-sweep-0015 --location europe-west1`; look at the logs: `gcloud run services logs read chords-api --region europe-west1 --limit 100`.

### Running the emulator suites

Without the Firebase emulators about 170 backend tests (admin integration + NFR, admission, grant script, Firestore index) are skipped, and the security-rules tests do not run at all. CI runs both (`.github/workflows/backend-emulators.yml`, on every push to `main` and every pull request). Locally, from the repository root, with Java 21+ and Node installed and ports 8080 (Firestore) and 9099 (Auth) free:

```bash
export PATH=/opt/homebrew/opt/openjdk/bin:$PATH   # macOS + Homebrew only
npx -y firebase-tools@15 emulators:exec --only auth,firestore --project build-chords-listener \
  "cd backend && uv run pytest -q -p no:cacheprovider"
npx -y firebase-tools@15 emulators:exec --only auth,firestore --project build-chords-listener \
  "node --test firestore.rules.test.mjs"
npx -y firebase-tools@15 emulators:exec --only auth,firestore,storage --project build-chords-listener \
  "node --test storage.rules.test.mjs"   # the upload rule reads Firestore, so all three run
```

`emulators:exec` sets `FIRESTORE_EMULATOR_HOST` and `FIREBASE_AUTH_EMULATOR_HOST` for the command, which is what un-skips the tests; the emulators are stopped afterwards. If a port is taken, an earlier emulator is still running — stop it first. `firebase-tools` is pinned to major version 15 here and in CI. CI also installs ffmpeg and sets `CHORDS_FAIL_ON_SKIP=1`, under which a test skipped for want of ffmpeg or an emulator fails instead (`backend/tests/strict_skips.py`); set it locally to check the same.

### Live e2e (browser + server + emulators)

The scheduled test level of the admin feature (docs/features/admin/test-plan.md): a real Chromium, the real backend
in cloud mode and the Firebase emulators (Auth 9099, Firestore 8080, Storage 9199 — the ports a
`VITE_FIREBASE_EMULATORS=true` build hardcodes), in real time: no stubs, no fake clocks. Specs in
`frontend/e2e-live/`, config `frontend/playwright.live.config.ts`; the stubbed suite (`npm run test:e2e`,
`frontend/e2e/`) is separate and unchanged. Locally, with Java 21+, ports 8080 / 9099 / 9199 / 8775 / 4183 free,
`uv sync` done in `backend/` and Chromium installed once (`npx playwright install chromium`):

```bash
cd frontend
npm run test:e2e:live                          # ~2 min: every spec except the 30-minute one
LIVE_SLOW=1 npm run test:e2e:live              # + the idle-tab spec (30 real minutes; nightly in CI)
npm run test:e2e:live -- revoke.spec.ts        # one spec (any Playwright argument after --)
npm run test:e2e:live -- banner.spec.ts --update-snapshots   # re-take this platform's banner baselines
```

- `npm run test:e2e:live` (`frontend/e2e-live/run.mjs`) starts the emulators with
  `npx -y firebase-tools@15 emulators:exec --only auth,firestore,storage` from the repository root (rules and ports
  from `firebase.json`; on macOS the Homebrew openjdk is put on PATH when `java` is missing), in a temp directory of
  their own, and stops them afterwards. Emulators already listening on all three ports are reused (their data is
  wiped); only some of the ports taken is an error.
- Playwright then starts the backend fresh (`python -m uvicorn app.main:app` from the `uv` environment in `backend/`, on 127.0.0.1:8775 with
  `CHORDS_AUTH=firebase`, the emulator hosts, a scratch `CHORDS_DATA_DIR`, `CHORDS_UPLOAD_BUCKET`; its stdout/stderr,
  uvicorn's access log included, go to `<tmp>/chords-live-e2e-8775/backend.log`, which the specs read as the
  server's own record of requests) and the hosted build (`VITE_BASE=/chords-listener/`,
  `VITE_FIREBASE_EMULATORS=true`, `VITE_CLOUD_API_URL=http://127.0.0.1:8775`, into `dist-e2e-live/`, gitignored) under
  `vite preview` on localhost:4183. The emulator build's admin.html also allows the Auth emulator in connect-src
  (`adminBuildCsp` in `frontend/vite.config.ts`); a production build's policy is unchanged.
- Every spec starts from empty emulators, migration 04, an admin granted with `scripts/admin_grant.py grant <uid>`
  and an ordinary user, both with fresh uids. Firestore and bucket seeding goes through
  `backend/scripts/live_e2e.py` (the factories of `backend/tests/admin/fixtures.py`), which refuses to run without the
  three emulator hosts. Its `sweep` command runs the server's own `Sweeper` + `Purger` (as `create_app` builds them
  from the same environment): `POST /api/internal/sweep` accepts only a Google-signed OIDC token of the scheduler's
  service account, which cannot be minted locally.
- Knobs: `LIVE_SLOW=1`; `LIVE_IDLE_MIN` (default 30) for the idle-tab spec; `LIVE_API_PORT` / `LIVE_SITE_PORT`;
  `LIVE_PYTHON` (default: `.venv/bin/python` of `backend/`); `LIVE_RUN_DIR` (the server's scratch and log);
  `LIVE_P95_USERS` / `LIVE_P95_SONGS` (the data set of the p95 spec, default 1 000 × 20); `LIVE_FIREBASE_TOOLS`
  (default `firebase-tools@15`).

| Spec | What it proves, in real time |
|---|---|
| `banner.spec.ts` | AC-29: a guest sees the banner the admin published in Settings, UA then EN, with no request to the server (browser record and access log); banner screenshots match the baselines; turned off, the next visit shows none. AC-27 / NFR ≤ 5 min: with YouTube off the next visit sends a link to «Слухати у вкладці» at once |
| `restriction.spec.ts` | AC-16 / AC-18: restricted on the card → the user's next cloud job is refused (`cloud_restricted`) within 60 s, nothing counted; the site explains it and offers the browser |
| `default-limit.spec.ts` | AC-24: 40 → 30 in Settings → `GET /api/me` reports 30 within 60 s, the 31st analysis is refused, same server process; journal 40 → 30 |
| `pause.spec.ts` | AC-26: pause on → an upload is refused (`analyses_paused`), explained, offered in the browser, nothing counted |
| `revoke.spec.ts` | AC-32: `admin_grant.py revoke` → within 60 s the open pages' reads and actions get the unknown-address 404; nothing applied; a reload shows «Сторінку не знайдено» |
| `purge.spec.ts` | AC-22: deletion scheduled on the card, `purgeAfter` moved into the past, sweep → no sign-in, no songs (index, files, bucket), search finds nobody, journal and job history show «видалений» only |
| `overview-p95.spec.ts` | NFR: 20 browser openings of the overview on the warm server with 1 000 × 20 seeded, p95 ≤ 2 s |
| `idle-tab.spec.ts` (`@slow`) | AC-02: admin tabs in front and in the background for 30 min send nothing to the server; a guest tab does not poll the public status |

CI: `.github/workflows/admin-live-e2e.yml` runs it nightly (02:30 UTC, with `LIVE_SLOW=1`) and on demand
(`workflow_dispatch`: `slow`, `update_snapshots`); the report, traces and the server log are uploaded on failure.

**One-time step: the Linux banner baselines.** Screenshot baselines are per platform and only the macOS ones
(`banner-uk-darwin.png`, `banner-en-darwin.png` in `frontend/e2e-live/banner.spec.ts-snapshots/`) are committed; until the Linux ones are,
the nightly run fails at the banner comparison. Run the workflow by hand with `update_snapshots` ticked (Actions →
"Admin live e2e" → Run workflow, or `gh workflow run admin-live-e2e.yml -f update_snapshots=true`), download the
artifact `banner-baselines-linux` (`gh run download <run-id> -n banner-baselines-linux`), look at both PNGs, copy
`banner-uk-linux.png` and `banner-en-linux.png` into `frontend/e2e-live/banner.spec.ts-snapshots/` and commit
them. Repeat only when the banner's look changes on purpose (locally: `--update-snapshots` for the macOS pair).

### Measuring the cold start

NFR "admin overview from a sleeping server: p95 ≤ 15 s" needs the deployed service, so it is not part of CI.
After a deploy, from any machine (standard library only; `gcloud` with the owner's login for `--verify-cold`):

```bash
python3 scripts/measure_cold_start.py --dry-run                 # the plan; sends nothing
python3 scripts/measure_cold_start.py --verify-cold             # 5 × (20 min silence + GET /api/health)
CHORDS_ADMIN_REFRESH_TOKEN=... python3 scripts/measure_cold_start.py --admin --verify-cold   # GET /api/admin/overview
```

Before each attempt it sends nothing for `--idle-min` minutes (default 20; Cloud Run stops an idle instance after
~15), then times the first request to the whole answer; it prints every attempt and the nearest-rank p95 (with 5
attempts, the slowest) and exits 1 over `--bound-s` (default 15). Something else waking the service meanwhile (a
visitor, a 00:15 / 12:15 sweep) makes an attempt warm: `--verify-cold` asks Cloud Logging whether a new server
process started for the request and counts only those (up to 10 tries for 5 cold ones). The admin variant takes the
token from the environment only — never the command line — and never prints it: `CHORDS_ADMIN_REFRESH_TOKEN` (a
Firebase refresh token of an admin; a fresh ID token is minted from it at securetoken.googleapis.com before each
attempt, which does not touch the service) or `CHORDS_ADMIN_ID_TOKEN` (an ID token as is; it lasts an hour, about 2
attempts). The run takes ~attempts × idle-min (≈ 1 h 40 min by default).

### Decisions taken at design (spec §8)

Closed 2026-10-07: no 2FA in v1, no e-mails to users (a restricted or scheduled-for-deletion user sees the same cloud-restriction explanation, without the deletion date). Defaults applied: the support address in that explanation is the owner's (`SUPPORT_EMAIL` in `frontend/src/i18n/cloud.ts`), and the `smoke-test` account is shown apart as "службовий" and left out of the statistics.

## Verified (2026-10-05, revisions `chords-api-00002` and `-00003`)

- `scripts/smoke_cloud.py`: 26/26 checks on both revisions — health; 401 without / with an invalid token (readable cross-origin); CORS preflight from GitHub Pages; multipart upload → job → track with chords → signed audio with `Range` (206), tampered / unsigned audio → 401; notes PUT/GET; bucket upload with `gcloud storage cp` → `POST /api/jobs/storage` linked to a YouTube video with `startOffset` (title from oEmbed, times shifted, upload object deleted); another user's path → 403; a real YouTube link; third concurrent job → 429 `quota_exceeded`; daily counter; delete.
- **YouTube from Cloud Run worked** (Rick Astley "Never Gonna Give You Up", 3:33: downloaded and analyzed in 22–34 s, key G#; yt-dlp logged one 403 on an API page and used another client). Data-center IPs can be blocked at any time; the server then answers `download_blocked` and the client falls back to tab capture.
- Timings: new instance ready 5–6 s after Cloud Run starts it (GCSFuse mount ~2 s + Python start); first response after scale-to-zero 9.2 s at the client; chord models ready ~3 s later (cached numba kernels), first song on that cold instance done 12 s after the first request. Warm: a 41 s song 6.8 s end to end; a 4-minute song 14 s in the engine, 22 s end to end (with a second job running); storage ingest 6.3 s. Idle instances shut down after ~15 min.
- Vocals on `-00003` (23 s synthetic song): `POST /api/tracks/{id}/vocals` done in 43 s, both stems served through signed `stemUrls` with `Range` (206), one `vocals` quota unit counted.
- Rules, local, against the Firestore + Storage emulators: `firestore.rules.test.mjs` 33/33 and `storage.rules.test.mjs` 17/17 (library index and files readable only by their owner, nothing writable from a client, uploads unchanged). Not yet deployed or run against the real project.
- Local, against the Firebase Auth + Storage emulators: emulator ID tokens accepted, `storage.rules` enforced (owner upload OK; other users, `text/plain`, paths outside `uploads/` and client reads → 403), the google-cloud-storage client reads and deletes uploads through `STORAGE_EMULATOR_HOST`.

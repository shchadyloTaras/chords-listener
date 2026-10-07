# YouTube clips through Cloudflare WARP — design

Status: approved in conversation on 2026-10-07 (approach A: a separate `chords-fetch` service). Spike results: see "Background".

## Goal

A signed-in user pastes a YouTube link on any device (phones included), picks a 30-second fragment of the video, and gets a track with chords for that fragment — no microphone, no tab capture. The cloud downloads only those 30 seconds, through Cloudflare WARP, from a small separate service that can run as several containers.

Success: from a phone, a YouTube link → fragment picked → track with chords aligned to the video; when YouTube still refuses, the user lands on "Слухати у вкладці" at the chosen fragment; the monthly bill grows by about $4–5 (Cloud NAT) and nothing else.

Non-goals: guests (they keep "Слухати у вкладці"); the user's own server (`backend === 'local'`, full-song downloads, unchanged); other sites than YouTube (still fetched by `chords-api` itself); fragments other than exactly 30 s; several WARP profiles (one is shared, see Background); searching YouTube inside the app.

## Background (spike, 2026-10-07)

Cloud Run `europe-west1`, yt-dlp 2026.08.19, 18 popular music videos:

- Direct from Cloud Run: "Sign in to confirm you're not a bot" on almost every video.
- WARP (wgcf profile + wireproxy, userspace SOCKS5) over Cloud Run's default egress: the tunnel comes up but any upstream payload over ~500 B stalls (every MTU 1280→500, IPv4/IPv6 endpoint, ports 2408/500). gen1: the tunnel never comes up.
- WARP over **Direct VPC egress + Cloud NAT**: 18/18 (16 on the first try), 0 bot checks, 2–7 s per full song.
- 3 parallel containers sharing **one** WARP profile: 54/54, 0 bot checks, each container got its own WARP IPv6 egress.
- About 1 in 10 first tries gets a random HTTP 403 on the media URL (also from a home IP); a retry fixes it.

## Decisions

1. **Exactly 30 s, user-chosen start.** `end = min(start + 30, videoDuration)`; a video shorter than 30 s is taken whole. The video's own length no longer matters (only 30 s are downloaded), so `CHORDS_MAX_DURATION_MIN` does not apply to clip jobs. The client's picker uses a 30 s constant (`CLIP_SECONDS`); the server's length comes from `CHORDS_YT_CLIP_S` (default 30) and the two are kept equal. The actual range always comes back in the job / track (`clip`), so a short video or a changed setting is shown correctly.
2. **Signed-in cloud users only, on every device.** Their YouTube links open the fragment picker, then a server job. "Слухати у вкладці" opens only as the fallback (YouTube blocked, or the cloud cannot fetch clips). Guests keep today's behaviour plus a sign-in hint.
3. **A separate service `chords-fetch`** does every YouTube request (metadata + audio) through WARP and writes the clip to the bucket; `chords-api` analyzes it like an upload. NAT applies to `chords-fetch` only.
4. **One fragment = one track.** Track key `youtube:<videoId>@<start>` (start in whole seconds) → `track_id_for`. The same fragment is never downloaded twice; another fragment of the same video is another track. Full-video tracks from the local server keep `youtube:<videoId>`.
5. **A clip track is a video-linked recording.** Same shape as today's tab recordings (`POST /api/jobs/storage` with `startOffset`): track times are video times, `startOffset = start`, chords cover `0..start` with `N`. New field `clip: {start, end}` (video seconds) tells the player where the fragment ends.
6. **One WARP profile, shared by all containers**, stored in Secret Manager, registered once by the deploy script (owner's consent at that step).

## Flow

```
client (signed in, cloud)
  paste YouTube link → #/youtube/<videoId>  (fragment picker)
  «Розібрати акорди» → POST /api/jobs {url, clip: {start}}
chords-api
  dedup: track youtube:<id>@<start> exists → job done at once
  admit (quota "analyses") → job "downloading"
  POST chords-fetch /clip {videoId, start, length}   (ID token, retried while busy)
chords-fetch (1 request per container, up to 3 containers)
  yt-dlp via WARP: metadata, then audio of [start, end] only
  upload gs://<bucket>/fetch/<requestId>/source.<ext> → JSON
chords-api
  download object → delete object → analyze (startOffset = start) → track
client
  job page → track page: video from `clip.start`, pauses at `clip.end`, chords on top
```

## `chords-fetch` service

- Code: `backend/app/fetch_service.py` (FastAPI app) reusing `sources.YtDlpFetcher`; image `backend/fetch.Dockerfile` (python 3.11 slim, `yt-dlp[default]` at the backend's locked version, fastapi/uvicorn, google-cloud-storage, google-auth, ffmpeg, node 22, wireproxy v1.1.3 built in a Go stage). No analysis dependencies.
- `POST /clip` body `{videoId, start, length}`:
  - `videoId` must match `^[A-Za-z0-9_-]{11}$`; `start` ≥ 0 (whole seconds); `length` 1..60. Anything else → 400. Arbitrary URLs are never accepted, so the service is not an open proxy.
  - Probe (title, artist/channel, duration, live status) → reject live streams (`invalid_url`), `start ≥ duration` (`invalid_url`).
  - Download `[start, min(start+length, duration)]` with yt-dlp `download_ranges` (ffmpeg cuts; only the range is fetched).
  - Upload to `fetch/<requestId>/source.<ext>` in the Firebase default bucket; respond `{title, artist, duration, thumbnail, start, end, path, size}`.
  - Errors: `{code, message}` with the existing error codes (`download_blocked`, `download_failed`, `invalid_url`, `too_large`), HTTP 4xx/5xx.
- WARP: the container starts wireproxy (SOCKS5 `127.0.0.1:40000`) from the profile mounted from Secret Manager, waits until `cdn-cgi/trace` shows `warp=on` (readiness), and yt-dlp uses `socks5h://127.0.0.1:40000`.
- Retries inside one request: HTTP 403 / timeouts on the media → up to 3 attempts (fresh extraction each time). Bot check / sign-in wall → restart wireproxy (a new tunnel session gets a new WARP IP) and try once more; still blocked → `download_blocked`.
- `yt-dlp` options: the backend's `_opts` (node JS runtime, timeouts) + `proxy`, `--retries 2`; a hard per-attempt timeout of 90 s.
- Cloud Run: `europe-west1`, gen2, 1 vCPU / 1 GiB, request-based billing, concurrency 1, min 0 / max `FETCH_MAX_INSTANCES` (default 3), timeout 300 s, `--no-allow-unauthenticated`, Direct VPC egress `all-traffic` on network `default` / subnet `default`.
- Logs: one line per request (videoId, start, attempts, outcome, seconds); no user ids.

## `chords-api` changes

- `CreateJobRequest` gets `clip: {start: number} | null`. Valid only for YouTube video links; otherwise 400 `invalid_url`.
- Settings: `CHORDS_FETCH_URL` (the `chords-fetch` URL), `CHORDS_YT_CLIP_S` (30).
- `sources.ClipFetcher` (used when `clip` is set):
  - `CHORDS_FETCH_URL` set → `RemoteClipFetcher`: calls `/clip` with a Google ID token for that audience (metadata server; `google-auth` is already locked), retries 429/503 (all containers busy, cold start) with backoff for up to 60 s, then `download_failed` "The server is busy, try again in a minute". Then downloads the object with `UploadBucket.download` and deletes it whatever happens next (like storage jobs).
  - Not set, local mode → the same clip download done in-process by `YtDlpFetcher` (dev, tests, the local server if it ever receives `clip`).
  - Not set, cloud mode (`CHORDS_AUTH=firebase`) → `POST /api/jobs` with a `clip` answers 501 `unavailable` (Google Cloud addresses are blocked, so the API never tries itself); the client then opens "Слухати у вкладці".
- `JobManager.submit_url(url, options, clip)`: dedup by `youtube:<id>@<start>` before admitting; `_run_url` for clips skips the video-length limit, sets `startOffset = start`, `clip = {start, end}`, source `{type: 'youtube', videoId, url}`, title = YouTube title (the client shows the range next to it), thumbnail from the video.
- `Track` / `TrackSummary` / `track.json` / Firestore index get `clip` (null for every other track). `types.ts` mirrors it.
- The cloud sweep also removes `fetch/**` objects older than 1 h (`UploadBucket.sweep(max_age_s=3600, glob="fetch/**")`).

## Client changes (`frontend/src`)

- `linkTarget`: cloud + signed in + a YouTube video id → `'clip'` (new); guests → `'capture'` (as now); local server → `'server'` (as now).
- Route `#/youtube/<videoId>[?t=<start>]` → `ClipPage`:
  - YouTube embed (existing `youtubeApi.ts`) + a timeline 0..duration with a 30 s window (drag; tap to move), the range label `1:12 – 1:42`, «↓ Звідси» (window starts at the player's current time), «▶ Прослухати» (plays the window once, then pauses), «Розібрати акорди».
  - The window is clamped so it never runs past the end (`start ≤ duration − 30`; whole video when shorter). Default start: `t` from the URL, else 0.
  - Works by touch on a 375 px screen; keyboard: ←/→ move the window by 1 s, Shift by 5 s.
- Fallback to `#/listen/youtube/<videoId>?blocked=1&t=<start>` (the capture page seeks to `t` before listening): a clip job that ends in `download_blocked` (job page), or `POST /api/jobs` with a clip answering 501 `unavailable` (picker).
- Guest on the capture page: a hint «Увійдіть, щоб розбирати YouTube без мікрофона» with the sign-in action.
- Clip tracks: the title shows the range (`Назва · 1:12–1:42`) in the library and on the track page; the YouTube source starts at `clip.start` and pauses at `clip.end`; the audio source plays the clip as today's recordings do.
- Tour: a short tour for `ClipPage` (window, «Звідси», «Прослухати», «Розібрати акорди»), using the existing tour framework and readiness flags.
- Docs: README (feature + cost), `docs/SPEC.md`, `docs/CLOUD.md` (YouTube section, `chords-fetch`, NAT, costs).

## Infrastructure and deploy

New `scripts/deploy_fetch.sh` (idempotent; `REGION`/`PROJECT` like `deploy_cloud.sh`):

1. Enable `secretmanager.googleapis.com`.
2. Secret `warp-profile`: if missing, register one WARP device with local `wgcf` (`brew install wgcf`; the script stops and asks for confirmation before `wgcf register --accept-tos`) and store `wgcf-profile.conf` as the first version. Never printed, never written into the repo.
3. Cloud Router `chords-nat-router` + Cloud NAT `chords-nat` (auto-allocated IP, all subnet ranges) in `europe-west1`; Private Google Access on subnet `default` (bucket and token traffic bypass NAT).
4. Service account `chords-fetch`: `roles/storage.objectUser` on the bucket with an IAM condition limited to `objects/fetch/`; `roles/secretmanager.secretAccessor` on `warp-profile`. `chords-api`'s runtime service account gets `roles/run.invoker` on `chords-fetch`.
5. Cloud Build (`--region $REGION`) of `backend/fetch.Dockerfile` → `…/chords/fetch:<tag>`; deploy `chords-fetch` with the settings above and the secret mounted as a file.
6. Print the URL. `deploy_cloud.sh` sets `CHORDS_FETCH_URL` on `chords-api` when `chords-fetch` exists.

Cost: Cloud NAT gateway + its IP ≈ $4–5 / month whether used or not; NAT data processing ≈ $0.045 / GB (a 30 s clip ≈ 0.5 MB); `chords-fetch` itself stays within Cloud Run's free tier at this scale; Secret Manager within its free tier. The existing $15 budget alert covers it.

## Errors and edge cases

| Case | Behaviour |
|---|---|
| YouTube bot check after the WARP reconnect | job `download_blocked` → "Слухати у вкладці" at `t=start` |
| All `chords-fetch` containers busy > 60 s | `download_failed`, "The server is busy, try again in a minute" |
| Live stream / premiere | `invalid_url` (as today) |
| `start` beyond the video's end | `invalid_url` |
| Video shorter than 30 s | the whole video, `clip.end = duration` |
| Age-restricted / private / removed video | `download_failed` with yt-dlp's cleaned message (as today) |
| Same fragment requested again (any device) | job done at once with the existing track |
| `chords-fetch` not deployed | 501 `unavailable` → "Слухати у вкладці" |
| Orphan objects in `fetch/` | removed by the hourly sweep (> 1 h old) |

## Testing

- Backend unit tests (no network): `fetch_service` (id/start/length validation, retries on 403, bot check → reconnect → `download_blocked`, live stream, upload path, error JSON) with a fake yt-dlp and a fake bucket; `RemoteClipFetcher` (ID token header, busy retries, object download + delete, error mapping) with a fake HTTP server; `JobManager` clip jobs (dedup key, `startOffset`, `clip`, no length limit, quota); `CreateJobRequest` validation; sweep glob.
- Frontend unit tests: `linkTarget` (guest / signed in / local), the clip window math (clamping, short videos, «Звідси»), route parsing for `#/youtube/<id>?t=` and the capture `t` param, title range formatting.
- Live after deploy: `scripts/smoke_fetch.py` — the 18 spike videos as clips through `chords-api` (signed smoke user), each a track with chords and `clip`; then the owner tries it from a phone.

## Rollout

1. `deploy_fetch.sh` (infra + service), smoke `/clip` directly with an ID token.
2. `deploy_cloud.sh` (API with `CHORDS_FETCH_URL`), `smoke_fetch.py`.
3. Frontend release (GitHub Pages). Until step 2 is live, clip jobs answer `unavailable` and the client falls back to "Слухати у вкладці", so the order is safe.

## Risks

- YouTube may start flagging WARP addresses: the fallback is the existing capture page; a second step would be several WARP profiles or a home relay.
- yt-dlp needs regular updates for YouTube changes: the fetch image pins the backend's version; bump both together.
- WARP's free tier is meant for personal devices; using it from a server is a grey zone, as is downloading from YouTube at all.
- NAT is a fixed monthly cost even with no users.

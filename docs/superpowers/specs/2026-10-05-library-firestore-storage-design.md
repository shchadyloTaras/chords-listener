# Library in Firestore, files straight from Storage — design (phase 2)

Status: approved in conversation on 2026-10-05 (variant A, audio streamed through download-token URLs).

## Goal

A signed-in user's library, track data, notes, vocals and audio are read straight from Firestore and Firebase Storage. The Cloud Run API is woken only for real work: a new analysis, re-analysis, vocals, an edit (title / chords / reset / notes), a delete. Changes made on another device show up live (no 6 h delay).

Non-goals: guests (they already make zero requests and keep everything on the device); the local server (`./start.sh`, `backend === 'local'`) — unchanged; moving writes off Cloud Run; offline mode.

## Decisions

1. **Index in Firestore** — one document per track: `users/{uid}/tracks/{trackId}`. Written only by the API (service-account credentials bypass rules); readable only by its owner; clients never write it.
2. **Composed track file in Storage** — the API writes `users/{uid}/tracks/{trackId}/track.json` (cloud mode only) next to the existing files. The client reads it, `notes.json` and `vocals.json` with the Firebase Storage SDK (`getBytes`), authorized by Storage rules (owner only).
3. **Audio and stems stream through Firebase download-token URLs.** On publish the API makes sure `audio.mp3` and every `stems/<name>.mp3` carry a `firebaseStorageDownloadTokens` metadata token and `contentType: audio/mpeg`; the tokens are written into `track.json` (owner-readable only). The URL is a bearer URL without expiry; it stops working when the track is deleted (the object is gone). Owner's explicit choice: streaming starts immediately (vs. download-then-play).
4. **Version, not TTL** — every track mutation increments an integer `version` in `meta.json` (under `TrackStore._lock`); the index document and `track.json` carry it. A track kept on the device is valid exactly while its version equals the index version.
5. **Firestore from the API over REST** (`google.auth.transport.requests.AuthorizedSession`; `google-auth` and `requests` are already locked) — no `google-cloud-firestore` / grpcio.
6. **Firestore on the client uses the memory cache** (no IndexedDB persistence), so nothing of one account stays in Firestore's own browser cache for the next. The instant first paint keeps using the phase-1 device cache (`lib/cloud/cache.ts`, keyed by uid, cleared on sign-out); the live snapshot replaces it.
7. **Fallback** — when the index or a Storage read fails (permission, network, missing `track.json` before backfill), the client uses the existing API path (phase-1 behaviour). Nothing breaks if a rollout step is missing.
8. **Writes stay on the API**, unchanged endpoints. After each write the API publishes; the client sees the new version through its snapshot.

## Data model

### Index document `users/{uid}/tracks/{trackId}`

Fields (Firestore REST typed values): exactly the `TrackSummary` JSON fields as `GET /api/tracks` returns them — `id, title, artist, duration, thumbnail, source, key, tempo, chordCount, edited, vocals, stems, createdAt` — plus `version` (integer) and `publishedAt` (timestamp). `createdAt` is the meta value (string, ISO); when meta has none, the publisher writes the track directory's mtime once into meta so the value is stable.

### `track.json`

`store.get_track(id).model_dump(mode="json")` (the API's camelCase Track JSON) **without** `audioUrl` and `stemUrls`, plus:

```json
{
  "version": 7,
  "media": {
    "audio": { "path": "users/<uid>/tracks/<id>/audio.mp3", "token": "<uuid>" },
    "stems": { "vocals": { "path": ".../stems/vocals.mp3", "token": "<uuid>" } }
  }
}
```

The client builds `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<encodeURIComponent(path)>?alt=media&token=<token>` (bucket from `firebaseConfig.storageBucket`).

## API side (`backend/app`)

- `publish.py` — `Publisher` with `publish(uid, track_id)` and `unpublish(uid, track_id)`; `NullPublisher` when not in cloud mode. Pieces: a Firestore REST client (`FirestoreIndex.upsert(uid, id, fields)`, `.delete(uid, id)`; base URL `https://firestore.googleapis.com/v1/projects/<project>/databases/(default)/documents`, or `http://$FIRESTORE_EMULATOR_HOST/v1/...` with `Authorization: Bearer owner` for the emulator), a token keeper (reads / sets object metadata through the existing `google-cloud-storage` client: `firebaseStorageDownloadTokens`, `contentType`), and the `track.json` writer (`write_json_atomic` into the track directory).
- `publish(uid, id)`: under `store._lock`: if the track does not exist → `unpublish`; else read meta (+ version), ensure tokens, write `track.json`, upsert the index doc. Up to 3 attempts with short backoff on HTTP 429/5xx/network; on final failure add `id` to `users/<uid>/publish-pending.json` (never client-readable) and log.
- Hooks (each after its file writes, same lock): `install_track`, `save_reanalysis`, `install_vocals`, `patch`, `reset` → bump `version` + publish; `delete` → `unpublish` first (pending on failure), then remove the directory. Dedup "already analyzed" paths call `publish` when the index lacks the track (self-heal for old tracks).
- Pending sweep: at start-up (the existing cloud sweep thread) and every 10 min while the instance lives, retry `users/*/publish-pending.json`.
- Backfill: `python -m app.publish backfill [--uid UID]` publishes every track of every user (idempotent). Run once as a Cloud Run job with the service image and service account.
- Settings: `CHORDS_PUBLISH` (default on in cloud mode), the project id already in settings; `create_app(..., publisher_factory=None)` for tests.
- Local mode: `NullPublisher` and no `track.json`. The `version` counter is bumped in every mode (a meta field only; it is not part of the API's JSON contract), so the store code has one path; the existing local-mode tests of directory contents stay valid and the cloud ones are updated for `track.json`.

## Client side (`frontend/src`)

- `lib/firestore.ts` — one lazily created Firestore instance (`initializeFirestore(app, { localCache: memoryLocalCache() })`) shared by `settingsSync.ts` and the library (never imported on the guest path).
- `lib/cloud/library.ts` — `subscribeLibrary(uid)` → zustand store `{ tracks: TrackSummary[] | null, versions: Record<id, number>, error }` from `onSnapshot(query(collection(db, 'users', uid, 'tracks'), orderBy('createdAt', 'desc')))`. Started when the cloud is the backend and a uid exists; stopped on sign-out / uid change.
- `api.listTracks` (cloud): the snapshot (merged with browser tracks as today); before the first snapshot, the kept list from the device cache; on snapshot error → the API path. The phase-1 list TTL, `markListStale`, list reconciliation and deletion tombstones are replaced for the cloud path by the snapshot (kept list = first paint only).
- `api.getTrack` (cloud): kept track with `version === versions[id]` → use it; else `getBytes(ref(storage, 'users/<uid>/tracks/<id>/track.json'))` → Track with `audioUrl` / `stemUrls` built from `media` → save with its version; missing file / error → the API path.
- Notes / vocals (cloud): `getBytes` of `notes.json` / `vocals.json` (object-not-found → "not computed"); kept per version; writes unchanged (`PUT /notes`, `POST /vocals`).
- Audio: the player streams the token URL; the phase-1 background blob save keeps working (needs CORS).
- Guests and the local server: untouched.

## Rules, CORS, IAM

- `firestore.rules`: `match /users/{userId}/tracks/{trackId} { allow read: if isOwner(userId); allow write: if false; }` (owner-scoped list queries are allowed by `isOwner`). Extend `firestore.rules.test.mjs`.
- `storage.rules`: owner read of `users/{uid}/tracks/{trackId}/{file}` for `track.json`, `notes.json`, `vocals.json`, `audio.mp3` and `stems/{name}`; `quota.json`, `publish-pending.json` and everything else stay denied; uploads unchanged.
- Bucket CORS: `GET, HEAD` from `https://shchadylotaras.github.io`, `http://localhost:5173`, `http://localhost:4173`; response headers `Content-Type, Content-Length, Content-Range, Accept-Ranges`.
- IAM: `roles/datastore.user` on the project for `chords-api@build-chords-listener.iam.gserviceaccount.com`; `deploy_cloud.sh` grants it and deploys `firestore:rules` with `storage`.
- Every infrastructure step (IAM, rules deploy, CORS, backfill job, API and site deploys) runs only with the owner's explicit OK at that step.

## Rollout order

1. API with publishing (writes index + `track.json`; current clients ignore them). 2. IAM role. 3. Firestore + Storage rules, bucket CORS. 4. Backfill job; verify a few documents. 5. Site with the new read path (falls back on any gap). Smoke test after 1, 4 and 5.

## Error handling

- Publish failures never fail the user's request; they go to the pending list and the sweep.
- A client read failure falls back to the API path once per session per kind (no retry storms).
- A deleted track: `unpublish` first; the snapshot removes it everywhere; token URLs die with the objects.

## Testing

- Backend: unit tests for `Publisher` with a fake Firestore REST session and the existing `FakeGcs` (tokens, contentType), version bumps on each mutation, delete order, pending file + sweep, backfill idempotence, local mode untouched; cloud API tests updated for `track.json`.
- Rules: Firestore rules tests (owner read, no client write, other user denied); Storage rules covered by an emulator test if the emulator suite runs here, else a documented manual check.
- Frontend: vitest with mocked `firebase/firestore` / `firebase/storage`: snapshot → list, version-keyed cache, Storage read → Track URLs, fallbacks, sign-out stops the listener and clears; guest path still loads no Firebase SDK (`auth.test.ts`).
- Cloud: `smoke_cloud.py` checks, after an analysis, that the index doc exists with the right version (read with the deploy credentials) and `track.json` is present.
- Browser: hosted build — guest makes zero cross-origin requests; signed-in page load makes no `*.run.app` request.

## Docs

`docs/CLOUD.md` (architecture, per-user data, media URLs, uploads, Cloud Run roles, deploy steps, verified), `docs/SPEC.md` (Cloud cache, Firebase section), rules file headers.

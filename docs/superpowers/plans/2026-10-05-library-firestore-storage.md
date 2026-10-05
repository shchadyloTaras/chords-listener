# Library in Firestore, files straight from Storage — Implementation Plan (B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user's library, track data, notes, vocals and audio are read from Firestore / Firebase Storage instead of the Cloud Run API, which is woken only for real work; other devices' changes appear live.

**Architecture:** The API keeps writing the library files on the bucket mount and, after every track mutation, publishes: it bumps a `version` in `meta.json`, makes sure `audio.mp3` / stems carry a Firebase download token, writes a composed `track.json`, and upserts `users/{uid}/tracks/{id}` in Firestore over REST. The web client listens to that collection, reads `track.json` / `notes.json` / `vocals.json` with the Storage SDK, streams audio through token URLs, and falls back to the API on any gap.

**Tech Stack:** Python 3.11 FastAPI, google-auth `AuthorizedSession` (REST), google-cloud-storage (metadata), pytest; React 19 + TS, Firebase JS SDK 12 (`firebase/firestore`, `firebase/storage`), vitest + fake-indexeddb.

**Spec:** `docs/superpowers/specs/2026-10-05-library-firestore-storage-design.md`

## Global Constraints

- Branch `library-firestore`; one commit per task (more is fine), each passing; messages end with the author model's `Co-Authored-By` line. Never push, never deploy, never run `gcloud`/`firebase deploy` — rollout is the controller's job with the owner's per-step OK.
- Backend: `cd backend && uv run pytest -q` passes; no new dependencies (no `google-cloud-firestore`, no `firebase-admin`; `google-auth` + `requests` are already locked).
- Frontend: `cd frontend && npx vitest run && npm run build && npm run lint` pass; no new dependencies; a fresh guest still loads no Firebase SDK and makes no cross-origin request (`src/lib/auth.test.ts` green).
- Local mode (`CHORDS_AUTH=off`, `backend === 'local'` in the client) is functionally unchanged: no `track.json`, no Firestore, the API paths as today.
- The client never writes Firestore track documents or Storage track files; all writes stay on the existing API endpoints.
- Every new or changed UI string has `uk` (informal "ти") and `en` entries.
- Names and values exactly as in the spec: collection `users/{uid}/tracks/{trackId}`; file `track.json`; field `version` (integer); `media.audio.{path,token}`, `media.stems.<name>.{path,token}`; pending file `users/<uid>/publish-pending.json`; env `CHORDS_PUBLISH`; CLI `python -m app.publish backfill [--uid UID]`; token metadata key `firebaseStorageDownloadTokens`; audio `contentType` `audio/mpeg`; token URL `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<encodeURIComponent(path)>?alt=media&token=<token>`.

## Review Focus

1. A track deleted while a publish for it is in flight must not come back in Firestore → pinned in Task 3 (`test_unpublish_wins_over_a_late_publish`).
2. Firestore unreachable / 5xx during a mutation: the user's request still succeeds, the track lands in `publish-pending.json`, and the sweep publishes it later → pinned in Task 3 (`test_publish_failure_goes_pending_and_sweeps`).
3. Another account on the same browser never sees the previous account's library: the listener stops and its store empties on sign-out / uid change before anything renders → pinned in Task 7 (`library.test.ts` "switching accounts drops the old list").
4. A kept track whose index `version` moved on (edited on another device) is re-read, and one with the same version is served from the device without any request → pinned in Task 8 (`api.firestore.test.ts` "version decides").
5. Before the rules / CORS / backfill exist (any rollout step missing), every read falls back to the API path and the app behaves as before → pinned in Task 8 (`api.firestore.test.ts` "falls back to the API").

---

### Task 1: A `version` on every track mutation

**Files:**
- Modify: `backend/app/storage.py` (`install_track`, `save_reanalysis`, `install_vocals`, `patch`, `reset`; new `TrackStore.version(track_id) -> int`)
- Test: `backend/tests/test_version.py` (new)

**Interfaces:**
- Produces: `meta["version"]: int` — 1 at install, +1 on reanalysis, vocals, a patch that changes something, reset; `TrackStore.version(track_id) -> int` (0 when absent, for old tracks); helper `_bump(meta: dict) -> None`.

- [ ] **Step 1: Failing test** (`test_version.py`, local-mode store like `tests/test_api.py` fixtures; reuse `FakeEngine`/`media` fixtures via the API client):

```python
def test_version_grows_with_every_change(client, media):
    tid = upload_and_wait(client, media.a)["trackId"]          # helper as in test_api.py
    store = client.app.state.store
    assert store.version(tid) == 1
    client.patch(f"/api/tracks/{tid}", json={"title": "New"})
    assert store.version(tid) == 2
    client.patch(f"/api/tracks/{tid}", json={})                 # nothing changed
    assert store.version(tid) == 2
    client.post(f"/api/tracks/{tid}/reset")
    assert store.version(tid) == 3
    wait_job(client, client.post(f"/api/tracks/{tid}/reanalyze").json()["id"])
    assert store.version(tid) == 4

def test_old_tracks_without_version_read_as_zero(client, media):
    tid = upload_and_wait(client, media.a)["trackId"]
    store = client.app.state.store
    meta_path = store.track_dir(tid) / "meta.json"
    meta = json.loads(meta_path.read_text()); meta.pop("version"); meta_path.write_text(json.dumps(meta))
    assert store.version(tid) == 0
    client.patch(f"/api/tracks/{tid}", json={"title": "x"})
    assert store.version(tid) == 1
```

(Locate `upload_and_wait` / `wait_job` / fixtures in `tests/test_api.py` and import or copy them; vocals bump is covered in Task 4's cloud test.)

- [ ] **Step 2: Run** `cd backend && uv run pytest tests/test_version.py -q` — FAIL (`version` missing).

- [ ] **Step 3: Implement**

```python
def _bump(meta: dict[str, Any]) -> None:
    """Every change a reader can see gets a new version (phase 2: the published copies follow it)."""
    meta["version"] = int(meta.get("version") or 0) + 1
```

- `install_track`: `meta = {**meta, "version": 1}` before writing it into `staged_dir`.
- `save_reanalysis`, `install_vocals`: `_bump(meta)` right before their `write_json_atomic(d / META_FILE, ...)`.
- `patch`: inside `if meta_changed:` add `_bump(meta)`.
- `reset`: read meta, `_bump`, write it (pretty) inside the existing lock after unlinking `edits.json`, only when `edits.json` existed.
- `version(self, track_id) -> int`: `int(self.read_meta(track_id).get("version") or 0)`.

- [ ] **Step 4: Run** the new test, then `uv run pytest -q` — PASS. Commit "Tracks get a version that grows with every change".

---

### Task 2: Firestore index client over REST

**Files:**
- Create: `backend/app/firestore.py`
- Test: `backend/tests/test_firestore.py`

**Interfaces:**
- Produces:
  - `to_value(v: Any) -> dict` / `from_value(d: dict) -> Any` (Firestore REST typed values: None→`nullValue`, bool→`booleanValue`, int→`integerValue` (string), float→`doubleValue`, str→`stringValue`, list→`arrayValue.values`, dict→`mapValue.fields`; datetime→`timestampValue` ISO with `Z`).
  - `class FirestoreIndex(project: str, *, session_factory: Callable[[], Any] | None = None, emulator_host: str | None = None)` with `upsert(uid: str, track_id: str, data: dict) -> None`, `delete(uid: str, track_id: str) -> None` (404 is success), `exists(uid: str, track_id: str) -> bool`.
  - `class IndexError_(Exception)` with `.retryable: bool` (429 / 5xx / network → True; other 4xx → False).
  - Defaults: base `https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents`; with `FIRESTORE_EMULATOR_HOST` (or `emulator_host`) → `http://{host}/v1/...` and header `Authorization: Bearer owner`; otherwise `google.auth.default(scopes=["https://www.googleapis.com/auth/datastore"])` + `google.auth.transport.requests.AuthorizedSession`, created lazily under a lock. Timeout 10 s per call.

- [ ] **Step 1: Failing tests**

```python
class FakeSession:
    def __init__(self, *responses): self.calls, self.responses = [], list(responses)
    def request(self, method, url, json=None, headers=None, timeout=None):
        self.calls.append((method, url, json, headers))
        status = self.responses.pop(0) if self.responses else 200
        return SimpleNamespace(status_code=status, text="", json=lambda: {})

def test_upsert_patches_the_document_with_typed_fields():
    s = FakeSession(200)
    idx = FirestoreIndex("p1", session_factory=lambda: s)
    idx.upsert("alice", "0123456789ab", {"title": "T", "version": 3, "duration": 1.5, "vocals": False,
                                         "artist": None, "stems": ["vocals"], "source": {"type": "file"}})
    method, url, body, _ = s.calls[0]
    assert method == "PATCH"
    assert url == "https://firestore.googleapis.com/v1/projects/p1/databases/(default)/documents/users/alice/tracks/0123456789ab"
    f = body["fields"]
    assert f["version"] == {"integerValue": "3"} and f["duration"] == {"doubleValue": 1.5}
    assert f["artist"] == {"nullValue": None} and f["vocals"] == {"booleanValue": False}
    assert f["stems"] == {"arrayValue": {"values": [{"stringValue": "vocals"}]}}
    assert f["source"] == {"mapValue": {"fields": {"type": {"stringValue": "file"}}}}

def test_delete_treats_404_as_done():
    idx = FirestoreIndex("p1", session_factory=lambda: FakeSession(404))
    idx.delete("alice", "0123456789ab")   # no raise

@pytest.mark.parametrize("status,retryable", [(429, True), (503, True), (403, False), (400, False)])
def test_errors_say_whether_to_retry(status, retryable):
    idx = FirestoreIndex("p1", session_factory=lambda: FakeSession(status))
    with pytest.raises(IndexError_) as e:
        idx.upsert("alice", "0123456789ab", {"title": "T"})
    assert e.value.retryable is retryable

def test_emulator_url_and_owner_token():
    s = FakeSession(200)
    FirestoreIndex("p1", session_factory=lambda: s, emulator_host="127.0.0.1:8080").exists("alice", "0123456789ab")
    method, url, _, headers = s.calls[0]
    assert method == "GET" and url.startswith("http://127.0.0.1:8080/v1/projects/p1/")
    assert headers["Authorization"] == "Bearer owner"

def test_values_round_trip():
    v = {"a": [1, 2.5, None, True, "x"], "m": {"k": "v"}}
    assert from_value(to_value(v)) == v
```

- [ ] **Step 2: Run** `uv run pytest tests/test_firestore.py -q` — FAIL (module missing).

- [ ] **Step 3: Implement** `firestore.py` per the interface (network exceptions from `requests` → `IndexError_(retryable=True)`; `bool` checked before `int`).

- [ ] **Step 4: Run** tests — PASS. Commit "Firestore index client over REST".

---

### Task 3: The publisher

**Files:**
- Create: `backend/app/publish.py`
- Modify: `backend/tests/test_cloud.py` (FakeGcs blobs gain `metadata`, settable `content_type`, `patch()`, `reload()`)
- Test: `backend/tests/test_publish.py`

**Interfaces:**
- Consumes: Task 1 (`store.version`, `meta.version`), Task 2 (`FirestoreIndex`, `IndexError_`), `TrackStore.get_track` / `read_meta` / `track_dir` / `exists` / `user_dir`, `write_json_atomic`, the GCS client from `gcs.default_client`.
- Produces:
  - `class Publisher(store: TrackStore, index: FirestoreIndex, *, bucket: str, gcs_client_factory: Callable[[], Any], attempts: int = 3, backoff_s: float = 0.5)` with `publish(uid: str, track_id: str) -> bool`, `unpublish(uid: str, track_id: str) -> bool`, `sweep_pending() -> int`, `backfill(uid: str | None = None) -> int`.
  - `class NullPublisher` with the same methods doing nothing (returns True / 0).
  - `summary_doc(track: Track, version: int) -> dict` (TrackSummary JSON fields + `version` + `publishedAt`), `track_file(track: Track, version: int, media: dict) -> dict` (Track JSON without `audioUrl`/`stemUrls` + `version` + `media`).
  - Per-track lock `self._lock_for(uid, track_id) -> threading.Lock` used by publish and unpublish.
  - `delete_track(uid: str, track_id: str, remove: Callable[[], None]) -> None`: under the per-track lock, unpublish (pending on failure) and then call `remove()` (the directory removal), so no publish can run between the two and resurrect the document.

- [ ] **Step 1: Failing tests** (`test_publish.py`; build a cloud `TrackStore` + `FakeGcs` + `FakeIndex`; install a track through `store.install_track` like `tests/test_vocals_api.py:82-89` under `user_context("alice")`, and `FakeGcs.put` its `users/alice/tracks/<id>/audio.mp3` object):

```python
class FakeIndex:
    def __init__(self): self.docs, self.fail = {}, 0
    def upsert(self, uid, tid, data):
        if self.fail: self.fail -= 1; raise IndexError_("down", retryable=True)
        self.docs[(uid, tid)] = data
    def delete(self, uid, tid): self.docs.pop((uid, tid), None)
    def exists(self, uid, tid): return (uid, tid) in self.docs

def test_publish_writes_index_track_file_and_tokens(pub, store, gcs, index, tid):
    assert pub.publish("alice", tid)
    doc = index.docs[("alice", tid)]
    assert doc["version"] == 1 and doc["title"] and "audioUrl" not in doc
    tf = json.loads((store.track_dir(tid, uid="alice") / "track.json").read_text())   # adapt to track_dir's signature
    assert tf["version"] == 1 and "audioUrl" not in tf and "stemUrls" not in tf
    blob = gcs.bucket(BUCKET).get_blob(f"users/alice/tracks/{tid}/audio.mp3")
    assert tf["media"]["audio"] == {"path": f"users/alice/tracks/{tid}/audio.mp3",
                                     "token": blob.metadata["firebaseStorageDownloadTokens"]}
    assert blob.content_type == "audio/mpeg"

def test_tokens_are_kept_across_publishes(pub, gcs, tid):
    pub.publish("alice", tid); first = gcs.bucket(BUCKET).get_blob(f"users/alice/tracks/{tid}/audio.mp3").metadata
    pub.publish("alice", tid); again = gcs.bucket(BUCKET).get_blob(f"users/alice/tracks/{tid}/audio.mp3").metadata
    assert first["firebaseStorageDownloadTokens"] == again["firebaseStorageDownloadTokens"]

def test_unpublish_wins_over_a_late_publish(pub, store, index, tid):
    pub.publish("alice", tid)
    removed = []
    def remove():
        # a publish racing the delete waits for the per-track lock, then finds no directory
        t = threading.Thread(target=pub.publish, args=("alice", tid)); t.start()
        with user_context("alice"): store._discard_dir(store.track_dir(tid))
        removed.append(t)
    pub.delete_track("alice", tid, remove)
    removed[0].join(5)
    assert ("alice", tid) not in index.docs
    assert pub.publish("alice", tid) is True               # publish of a missing track = unpublish
    assert ("alice", tid) not in index.docs

def test_publish_failure_goes_pending_and_sweeps(pub, store, index, tid):
    index.fail = 3
    assert pub.publish("alice", tid) is False
    pending = json.loads((store.user_dir("alice") / "publish-pending.json").read_text())
    assert pending == {"ids": {tid: "publish"}}
    assert pub.sweep_pending() == 1
    assert ("alice", tid) in index.docs
    assert not (store.user_dir("alice") / "publish-pending.json").exists()

def test_backfill_is_idempotent(pub, index, tid):
    assert pub.backfill() == 1 and pub.backfill() == 1
    assert len(index.docs) == 1

def test_null_publisher_does_nothing(store, tid):
    assert NullPublisher().publish("alice", tid) is True
    assert not (store.track_dir(tid, uid="alice") / "track.json").exists()
```

(If `TrackStore.track_dir` has no `uid` parameter, use `with user_context("alice"): store.track_dir(tid)`.)

- [ ] **Step 2: Run** `uv run pytest tests/test_publish.py -q` — FAIL.

- [ ] **Step 3: Implement** `publish.py`:
  - `publish(uid, id)`: `with self._lock_for(uid, id), user_context(uid):` if not `store.exists(id)` → `self._index_delete(uid, id)`; else, when meta has no `createdAt`, write the track directory's mtime (ISO UTC) into meta once (so the published value is stable); `track = store.get_track(id)`, `version = store.version(id)`, `media = self._ensure_media(uid, id, track)` (audio + each `track.stem_urls` name → `{path, token}`), `write_json_atomic(track_dir / "track.json", track_file(...))`, `self._index_upsert(uid, id, summary_doc(track, version))`. Retries `attempts` times with `backoff_s * 2**i` sleeps on `IndexError_.retryable` / GCS errors; on final failure `_add_pending(uid, id, "publish")` and return False (log warning). Success removes a pending entry for that id.
  - `unpublish(uid, id)`: same lock; delete the index doc with retries; failure → pending `"unpublish"`.
  - `_ensure_media`: `blob = bucket.get_blob(path)`; missing → skip that item; `token = (blob.metadata or {}).get("firebaseStorageDownloadTokens", "").split(",")[0] or str(uuid.uuid4())`; when the token was new or `blob.content_type != "audio/mpeg"`: set `blob.metadata = {**(blob.metadata or {}), "firebaseStorageDownloadTokens": token}`, `blob.content_type = "audio/mpeg"`, `blob.patch()`.
  - Object path = `(store.track_dir(id) / name).relative_to(settings.data_dir).as_posix()`.
  - Pending file `users/<uid>/publish-pending.json` = `{"ids": {id: "publish"|"unpublish"}}`, read/written under a module lock with `write_json_atomic`; `sweep_pending()` globs `settings.users_dir/*/publish-pending.json`, retries each entry once, returns the number done.
  - `backfill(uid=None)`: for every `users_dir/<uid>/tracks/<id>` directory (only `valid_id` names), `publish`; returns the number published.
  - `summary_doc`: `TrackSummary.model_validate(track.model_dump()).model_dump(mode="json")` + `version` + `publishedAt` (UTC `datetime`); `track_file`: `track.model_dump(mode="json", exclude={"audio_url", "stem_urls"})` + `version` + `media`.
  - FakeGcs (in `test_cloud.py`): `FakeBlob.metadata` (dict stored in the object), settable `content_type`, `patch()` (persists both), `reload()` no-op.

- [ ] **Step 4: Run** tests — PASS; `uv run pytest -q` — PASS. Commit "Publisher: index doc, track.json and download tokens per track".

---

### Task 4: Publish on every mutation; settings; sweep; backfill CLI

**Files:**
- Modify: `backend/app/storage.py` (`TrackStore.publisher` attribute, calls after each mutation; `delete` unpublishes first)
- Modify: `backend/app/jobs.py` (`_already_done` publishes — self-heal)
- Modify: `backend/app/main.py` (`create_app(..., publisher_factory=None)`; build `Publisher` in cloud mode when `settings.publish` and `settings.upload_bucket`; sweep at start-up and every 10 min in `_start_cloud_background_tasks`)
- Modify: `backend/app/models.py` (`Settings.publish: bool = True`, `CHORDS_PUBLISH` = `0|false|off` disables)
- Modify: `backend/app/publish.py` (`if __name__ == "__main__"` CLI: `backfill [--uid UID]`, builds Settings.from_env + the default clients, prints the count)
- Test: `backend/tests/test_cloud.py` (publishing through the API), update directory-content assertions (`test_cloud.py:784` now also has `track.json` in cloud mode)

**Interfaces:**
- Consumes: Task 3 `Publisher` / `NullPublisher`.
- Produces: `create_app(settings, ..., publisher_factory: Callable[[TrackStore], Any] | None = None)`; `make_cloud` fixture passes `publisher_factory=lambda store: Publisher(store, FakeIndex(), bucket=BUCKET, gcs_client_factory=lambda: gcs)` and exposes `index`.

- [ ] **Step 1: Failing tests** (`test_cloud.py`):

```python
def test_publishes_after_every_change(cloud, media):
    tid = upload_and_wait(cloud, "alice", media.a)["trackId"]        # existing helper
    docs = cloud.index.docs
    assert docs[("alice", tid)]["version"] == 1
    cloud.client.patch(f"/api/tracks/{tid}", json={"title": "Renamed"}, headers=H("alice"))
    assert docs[("alice", tid)]["title"] == "Renamed" and docs[("alice", tid)]["version"] == 2
    cloud.client.post(f"/api/tracks/{tid}/reset", headers=H("alice"))
    cloud.client.delete(f"/api/tracks/{tid}", headers=H("alice"))
    assert ("alice", tid) not in docs

def test_other_users_are_published_separately(cloud, media):
    a = upload_and_wait(cloud, "alice", media.a)["trackId"]
    b = upload_and_wait(cloud, "bob", media.a)["trackId"]
    assert ("alice", a) in cloud.index.docs and ("bob", b) in cloud.index.docs

def test_already_analyzed_republishes(cloud, media):
    tid = upload_and_wait(cloud, "alice", media.a)["trackId"]
    cloud.index.docs.clear()
    upload_and_wait(cloud, "alice", media.a)                          # dedup path
    assert ("alice", tid) in cloud.index.docs

def test_publish_off_switch(make_cloud, media):
    c = make_cloud(publish=False)
    tid = upload_and_wait(c, "alice", media.a)["trackId"]
    assert not c.index.docs
```

(Match helper names/signatures in the file; vocals: extend the vocals cloud test in `test_vocals_api.py` to assert the published doc has `vocals: True` and the version grew.)

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement**
  - `TrackStore.__init__(..., publisher=None)`; `self.publisher = publisher or NullPublisher()`; after each mutation (outside `self._lock`, uid = `current_uid()`): `install_track` (when it returned True), `save_reanalysis`, `install_vocals`, `patch`, `reset` → `self.publisher.publish(uid, track_id)`; `delete` → `self.publisher.delete_track(uid, track_id, remove)` where `remove` is the existing lock + `_discard_dir` body (local mode: `NullPublisher.delete_track` just calls `remove()`). Local mode: uid is None → no publish.
  - `_already_done` → `self.store.publisher.publish(current_uid(), track_id)` when cloud.
  - `create_app`: `publisher = publisher_factory(store) if publisher_factory else (Publisher(store, FirestoreIndex(settings.firebase_project), bucket=settings.upload_bucket, gcs_client_factory=gcs_client_factory or (lambda: default_client(settings.firebase_project))) if settings.cloud and settings.publish and settings.upload_bucket else NullPublisher())`; `store.publisher = publisher`; `app.state.publisher = publisher`.
  - Background: a daemon thread `chords-publish-sweep` runs `publisher.sweep_pending()` at start-up and then every 600 s.
  - CLI: `python -m app.publish backfill [--uid UID]`.

- [ ] **Step 4: Run** `uv run pytest -q` — PASS. Commit "Publish every track change; pending sweep; backfill command".

---

### Task 5: Rules, CORS, deploy script, smoke test, cloud docs

**Files:**
- Modify: `firestore.rules` (+ header data-model comment), `firestore.rules.test.mjs`
- Modify: `storage.rules` (+ header comment)
- Create: `storage-cors.json`
- Modify: `scripts/deploy_cloud.sh` (enable `firestore.googleapis.com`; grant `roles/datastore.user` to the runtime SA; `firebase deploy --only storage,firestore:rules`; `gcloud storage buckets update gs://$BUCKET --cors-file=storage-cors.json`; env `CHORDS_PUBLISH: "1"`)
- Modify: `scripts/smoke_cloud.py` (optional `--firestore-token-file PATH`: after the upload analysis, GET the index doc for uid `smoke-test` and check `version >= 1`; check `track.json` via `gcloud storage cat` only when the flag is given)
- Modify: `docs/CLOUD.md` (architecture table, per-user data, media URLs, uploads "no client reads" → owner reads of track files, Cloud Run roles, deploy steps)

**Interfaces:** none for code; rules must allow exactly what Task 7–8 read.

- [ ] **Step 1: Failing rules tests** (`firestore.rules.test.mjs`, same REST/emulator style as the file):
  - owner `get` and `list` (query on `users/alice/tracks`) of `users/alice/tracks/0123456789ab` → allowed;
  - other user / unauthenticated → denied;
  - owner `create`/`update`/`delete` → denied.

- [ ] **Step 2: Run** the rules tests the way the file's header says (`firebase emulators:exec --only firestore "node firestore.rules.test.mjs"`). If Java / the emulator is not available here, report that and keep the tests written (they run in CI / by the controller).

- [ ] **Step 3: Implement**

```
// firestore.rules — inside match /databases/{database}/documents
match /users/{userId}/tracks/{trackId} {
  // the published library index (written by the API's service account, which bypasses rules)
  allow read: if isOwner(userId);
  allow write: if false;
}
```

```
// storage.rules — inside match /b/{bucket}/o
match /users/{uid}/tracks/{trackId}/{file} {
  allow read: if request.auth != null && request.auth.uid == uid
    && file in ['track.json', 'notes.json', 'vocals.json', 'audio.mp3'];
  allow write: if false;
}
match /users/{uid}/tracks/{trackId}/stems/{stem} {
  allow read: if request.auth != null && request.auth.uid == uid && stem in ['vocals.mp3', 'instruments.mp3'];
  allow write: if false;
}
```

```json
[{"origin": ["https://shchadylotaras.github.io", "http://localhost:5173", "http://localhost:4173"],
  "method": ["GET", "HEAD"],
  "responseHeader": ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"],
  "maxAgeSeconds": 3600}]
```

Update the rules files' header comments (data model, access patterns) and `docs/CLOUD.md`.

- [ ] **Step 4: Run** rules tests (if available), `bash -n scripts/deploy_cloud.sh`, `python3 -m py_compile scripts/smoke_cloud.py`. Commit "Rules, CORS and deploy steps for the published library".

---

### Task 6: One shared Firestore instance

**Files:**
- Create: `frontend/src/lib/firestore.ts`
- Modify: `frontend/src/lib/settingsSync.ts:18-19` (use it)
- Test: `frontend/src/lib/firestore.test.ts`

**Interfaces:**
- Produces: `export const db: Firestore` created with `initializeFirestore(app, { localCache: memoryLocalCache() })`, emulator connected when `useEmulators`; imported only from lazily loaded modules (settingsSync, library).

- [ ] **Step 1: Failing test** — mock `firebase/firestore` and `./firebase`; import `./firestore`; assert `initializeFirestore` was called once with `{ localCache: <memoryLocalCache()> }` and `connectFirestoreEmulator` only when `useEmulators` is true; import `./settingsSync` and assert it does not call `getFirestore`.
- [ ] **Step 2: Run** — FAIL. **Step 3:** implement; `settingsSync` imports `db` from `./firestore`. **Step 4:** full vitest + build + lint — PASS (`auth.test.ts` green). Commit "One Firestore instance with the memory cache".

---

### Task 7: The live library

**Files:**
- Create: `frontend/src/lib/cloud/library.ts`
- Modify: `frontend/src/lib/auth.ts` (stop + clear the library on sign-out / uid change, next to `clearCloudCache()`)
- Modify: `frontend/src/types.ts` (`TrackSummary.version?: number`)
- Test: `frontend/src/lib/cloud/library.test.ts`

**Interfaces:**
- Produces:
  - `useLibrary` (zustand): `{ uid: string | null, tracks: TrackSummary[] | null, versions: Record<string, number>, error: boolean }`.
  - `startLibrary(uid: string): void` (idempotent per uid; lazily imports `firebase/firestore` + `../firestore`; `onSnapshot(query(collection(db, 'users', uid, 'tracks'), orderBy('createdAt', 'desc')))` → `tracks` = docs' data mapped to `TrackSummary` (+`version`), `versions` map; snapshot error → `error: true`, `tracks` unchanged).
  - `stopLibrary(): void` (unsubscribes, resets the store synchronously).
  - `libraryReady(): boolean` (`tracks !== null && !error`).
  - Started by `lib/serverMode.ts` / the auth mirror when `backend === 'cloud'` and a uid exists (pick the one place that already reacts to both — `useConnection.subscribe` + `useAuth.subscribe` in `library.ts` itself, started from `App.tsx` effects is fine); never on the guest path.

- [ ] **Step 1: Failing tests** (mock `firebase/firestore` with a controllable `onSnapshot` that stores its callback and returns an unsubscribe spy):
  - "first snapshot fills tracks and versions";
  - "a changed document updates versions";
  - "snapshot error keeps the last list and sets error";
  - "switching accounts drops the old list": `startLibrary('a')`, snapshot with a's track, `stopLibrary()` → store empty synchronously and the old unsubscribe was called; `startLibrary('b')` → still empty until b's snapshot.
  - "guests never import firebase/firestore" (the module's top level imports nothing from firebase).
- [ ] **Step 2: Run** — FAIL. **Step 3:** implement. **Step 4:** full vitest + build + lint — PASS. Commit "Live library from Firestore".

---

### Task 8: Read tracks, notes and vocals from Storage

**Files:**
- Create: `frontend/src/lib/cloud/files.ts`
- Modify: `frontend/src/lib/api.ts` (`listTracks`, `listCachedTracks`, `getTrack`, `getTrackNotes`; `fetchTrackAudio` accepts absolute token URLs as today)
- Modify: `frontend/src/lib/vocals.ts` (`vocalNotes` reads Storage first)
- Modify: `frontend/src/lib/cloud/cache.ts` (kept tracks carry `version`; `cachedTrack` unchanged signature)
- Modify: `frontend/src/components/history/tracksStore.ts` (`useLibrary.subscribe` → `refreshTracks()`)
- Modify: `docs/SPEC.md` ("Cloud cache" + Firebase section: the index, files from Storage, fallback)
- Test: `frontend/src/lib/api.firestore.test.ts` (new), `frontend/src/lib/cloud/files.test.ts` (new)

**Interfaces:**
- Consumes: Task 7 (`useLibrary`, `libraryReady`), Task 5 rules (read paths), the phase-1 cache.
- Produces:
  - `files.ts`: `readTrackFile(uid: string, id: string): Promise<(Omit<Track,'audioUrl'|'stemUrls'> & { version: number; media: Media }) | null>` (null on `storage/object-not-found`; throws `ApiError('network'|'unauthorized')` otherwise), `readJsonFile<T>(uid, id, name: 'notes.json' | 'vocals.json'): Promise<T | null>`, `mediaUrl(m: { path: string; token: string }): string` (token URL from the Global Constraints with `firebaseConfig.storageBucket`), `trackFromFile(file): Track` (`audioUrl = mediaUrl(media.audio)`, `stemUrls = {name: mediaUrl(...)}`).
  - Lazily imports `firebase/storage` through the existing loader in `lib/cloud/storage.ts` (extract a shared `loadStorage()` export rather than duplicating it).

- [ ] **Step 1: Failing tests** (`api.firestore.test.ts`; mock `./cloud/files` and set `useLibrary` state directly; cloud connection as in `api.cache.test.ts`):
  - "the library comes from the index, no cloud request": `useLibrary` ready with 2 tracks → `listTracks()` returns them merged with browser tracks; `fetch` not called.
  - "version decides": kept track v3, index v3 → `getTrack` returns it, `readTrackFile` not called, no fetch; index v4 → `readTrackFile` called, result kept with version 4, `audioUrl` is the token URL.
  - "falls back to the API": `useLibrary.error` → `listTracks` asks `GET /tracks`; `readTrackFile` rejects or returns null → `getTrack` asks `GET /tracks/{id}`; `readJsonFile` rejects → notes via `GET /notes`.
  - "notes and vocals come from Storage": `readJsonFile` returns notes → `getTrackNotes` returns them without fetch; object missing → null without fetch.
  - "a deleted track disappears with its document": index without the id → `listTracks` doesn't list it and `getTrack` (index ready, id absent) asks the API once (which answers 404 → forgotten).
  - `files.test.ts`: `mediaUrl` encodes the path (`users%2Falice%2Ftracks%2F…`), `readTrackFile` maps `storage/object-not-found` to null and other errors to `ApiError`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**
  - `listTracks` (cloud, `libraryReady()`): `byNewest([...browserTracks, ...useLibrary.getState().tracks])`, saving the list to the device cache for the next first paint; not ready and no error → the kept list if any (first paint), else wait up to 3 s for the first snapshot, else the API path; error → the API path (phase-1 code unchanged).
  - `getTrack` (cloud): `v = useLibrary.getState().versions[id]`; kept track with `kept.version === v` → it; `libraryReady()` and `v === undefined` → the API path (it may be brand new or gone); else `readTrackFile` → `trackFromFile` → keep with version → return; null / error → the API path.
  - `getTrackNotes` / `vocalNotes`: kept JSON whose kept version equals the index version → it; else `readJsonFile` → keep; error → the API path.
  - `tracksStore`: `useLibrary.subscribe((s, prev) => { if (s.tracks !== prev.tracks) void refreshTracks() })`.
- [ ] **Step 4: Run** full vitest + build + lint — PASS. Commit "Read the signed-in library from Firestore and Storage".

---

### Task 9: Whole-branch check

- [ ] **Step 1:** backend `uv run pytest -q`; frontend `npx vitest run && npm run build && npm run lint` — all PASS.
- [ ] **Step 2:** hosted preview as a fresh guest (phone + desktop emulation): zero cross-origin requests, no Firebase SDK until the auth dialog opens.
- [ ] **Step 3:** whole-branch review (superpowers:requesting-code-review) against `main..HEAD`.
- [ ] **Step 4 (controller, each step only with the owner's OK):** deploy the API → grant `roles/datastore.user` → deploy rules + CORS → run the backfill (Cloud Run job with the service image: `python -m app.publish backfill`) → smoke test with `--firestore-token-file` → merge + push the site → browser check signed-in: page load makes no `*.run.app` request.

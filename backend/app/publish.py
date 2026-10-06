"""Publishing the library for the browser (docs/superpowers/specs/2026-10-05-library-firestore-storage-design.md).

After a track changes (cloud mode) the ``Publisher`` brings three things in step with its directory:

* ``track.json`` next to the other files: the composed Track JSON without ``audioUrl`` / ``stemUrls``, plus
  ``version`` and ``media`` (object path + download token of the audio and every stem);
* a Firebase download token (``firebaseStorageDownloadTokens``) and ``audio/mpeg`` on those objects, so the
  browser can stream them straight from Storage;
* the Firestore index document ``users/{uid}/tracks/{trackId}`` (``FirestoreIndex``).

Publishing never fails the user's request: ``publish`` / ``unpublish`` / ``sweep_pending`` / ``backfill``
return instead of raising. A transient failure is retried with a growing pause; a lasting one is written to
``users/<uid>/publish-pending.json`` (``{"ids": {trackId: "publish" | "unpublish"}}``) for ``sweep_pending``.
Lock order: the per-track publish lock first, then ``TrackStore._lock``, never the reverse.

``python -m app.publish backfill [--uid UID]`` publishes the tracks that exist already (see ``main``).
"""
from __future__ import annotations

import argparse
import logging
import threading
import time
import uuid
import weakref
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

import requests
from google.api_core import exceptions as api_exceptions
from google.auth import exceptions as auth_exceptions

from .firestore import FirestoreIndex, IndexError_
from .models import Settings, Track, TrackSummary
from .storage import AUDIO_FILE, META_FILE, STEMS_DIR, TrackStore, read_json, write_json_atomic
from .users import user_context, valid_uid

log = logging.getLogger("chords.publish")

TRACK_FILE = "track.json"
PENDING_FILE = "publish-pending.json"
TOKEN_KEY = "firebaseStorageDownloadTokens"
MEDIA_TYPE = "audio/mpeg"
_TRANSIENT_STATUS = {408, 429, 500, 502, 503, 504}

_pending_lock = threading.Lock()  # guards every read-modify-write of a publish-pending.json (a leaf lock)


def summary_doc(track: Track, version: int) -> dict[str, Any]:
    """The index document: the TrackSummary JSON fields of ``GET /api/tracks`` + ``version`` + ``publishedAt``."""
    doc = TrackSummary.model_validate(track.model_dump()).model_dump(mode="json")
    return {**doc, "version": version, "publishedAt": datetime.now(timezone.utc)}


def track_file(track: Track, version: int, media: dict[str, Any]) -> dict[str, Any]:
    """``track.json``: the Track JSON (the client builds the media URLs from ``media``) + ``version`` + ``media``."""
    data = track.model_dump(mode="json", exclude={"audio_url", "stem_urls"})
    return {**data, "version": version, "media": media}


def _transient(exc: BaseException) -> bool:
    """Whether trying again may help: the index says so, the network failed, or Storage is throttled / down."""
    if isinstance(exc, IndexError_):
        return exc.retryable
    if isinstance(exc, (requests.RequestException, auth_exceptions.TransportError, ConnectionError, TimeoutError)):
        return True
    if isinstance(exc, api_exceptions.GoogleAPICallError):
        return exc.code in _TRANSIENT_STATUS
    return False


def _listing(what: str, list_fn: Callable[[], Any]) -> list[Any]:
    """A directory listing that cannot fail the caller: on the bucket mount an outage shows up as an OSError
    (EIO ...) from glob / iterdir / is_dir; the listing is then empty and the next run tries again."""
    try:
        return list(list_fn())
    except OSError as exc:
        log.warning("could not list %s: %s", what, exc)
        return []


def _read_pending(path: Path) -> dict[str, str]:
    try:
        ids = read_json(path).get("ids")
    except FileNotFoundError:
        return {}
    except (OSError, ValueError, AttributeError):
        log.warning("ignoring unreadable %s", path)
        return {}
    return {str(k): str(v) for k, v in ids.items()} if isinstance(ids, dict) else {}


class Publisher:
    def __init__(
        self,
        store: TrackStore,
        index: FirestoreIndex,
        *,
        bucket: str,
        gcs_client_factory: Callable[[], Any],
        attempts: int = 3,
        backoff_s: float = 0.5,
    ) -> None:
        self.store = store
        self.index = index
        self.bucket_name = bucket
        self.attempts = max(1, attempts)
        self.backoff_s = backoff_s
        self._client_factory = gcs_client_factory
        self._client: Any = None
        self._client_lock = threading.Lock()
        # A lock lives only while somebody holds or awaits it, so the table does not grow with the library.
        self._locks: weakref.WeakValueDictionary[str, threading.Lock] = weakref.WeakValueDictionary()
        self._locks_guard = threading.Lock()

    # ------------------------------------------------------------------ public

    def publish(self, uid: str, track_id: str) -> bool:
        """Bring the track's published copies up to date (a track that is gone is unpublished). True when done;
        False when it was queued in the pending file instead."""
        return self._publish(uid, track_id, self.attempts)

    def unpublish(self, uid: str, track_id: str) -> bool:
        """Remove the track's index document. True when done; False when it was queued."""
        with self._lock_for(uid, track_id):
            return self._run(uid, track_id, "unpublish", lambda: self.index.delete(uid, track_id), self.attempts)

    def delete_track(self, uid: str, track_id: str, remove: Callable[[], None]) -> None:
        """Unpublish (queued when the index is down), then ``remove()`` the directory, all under the track's
        lock: a publish cannot run in between and bring the document back. ``remove`` errors propagate."""
        with self._lock_for(uid, track_id):
            self._run(uid, track_id, "unpublish", lambda: self.index.delete(uid, track_id), self.attempts)
            remove()

    def ensure_published(self, uid: str, track_id: str) -> bool:
        """Publish the track unless the index has it already (self-heal for tracks that predate publishing).
        True when it is published (or was); False when it was queued instead. An index that cannot say is
        treated as lacking the track."""
        try:
            if self.index.exists(uid, track_id):
                return True
        except Exception as exc:
            log.warning("could not check track %s of %s in the index: %s", track_id, uid, exc)
        return self.publish(uid, track_id)

    def sweep_pending(self) -> int:
        """Try every queued entry of every user once; returns how many are done now. An entry is settled by
        the track's state on disk (``publish`` removes the document of a track that is gone), so a stale
        "unpublish" cannot take down a track that exists again."""
        users_dir = self.store.settings.users_dir
        done = 0
        for path in _listing(PENDING_FILE + " files", lambda: sorted(users_dir.glob(f"*/{PENDING_FILE}"))):
            uid = path.parent.name
            if not valid_uid(uid):
                continue
            with _pending_lock:
                ids = _read_pending(path)
            for track_id in ids:
                if self._publish(uid, track_id, 1):
                    done += 1
        if done:
            log.info("pending publish: %d done", done)
        return done

    def backfill(self, uid: Optional[str] = None) -> int:
        """Publish every complete track of ``uid`` (default: every user); returns how many were published."""
        users_dir = self.store.settings.users_dir
        if uid is not None:
            uids = [uid] if valid_uid(uid) else []
        else:
            uids = _listing(
                "users", lambda: sorted(p.name for p in users_dir.iterdir() if valid_uid(p.name) and p.is_dir())
            )
        published = 0
        for user in uids:
            tracks = self.store.user_dir(user) / "tracks"
            for d in _listing(f"the tracks of {user}", lambda: sorted(tracks.iterdir()) if tracks.is_dir() else []):
                try:
                    if not (self.store.valid_id(d.name) and d.is_dir()):
                        continue
                    with user_context(user):
                        complete = self.store.exists(d.name)
                except OSError as exc:
                    log.warning("could not check track %s of %s: %s", d.name, user, exc)
                    continue
                if complete and self.publish(user, d.name):
                    published += 1
        log.info("backfill: %d track(s) published", published)
        return published

    # ------------------------------------------------------------------ locks and retries

    def _lock_for(self, uid: str, track_id: str) -> threading.Lock:
        key = f"{uid}|{track_id}"
        with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = self._locks[key] = threading.Lock()
            return lock

    def _publish(self, uid: str, track_id: str, attempts: int) -> bool:
        with self._lock_for(uid, track_id):
            return self._run(uid, track_id, "publish", lambda: self._publish_once(uid, track_id), attempts)

    def _run(self, uid: str, track_id: str, kind: str, action: Callable[[], None], attempts: int) -> bool:
        """Run ``action`` (the track's lock is held), again with a growing pause while the failure is
        transient. A lasting failure is queued in the user's pending file; success clears the entry. Never raises."""
        tried = 0
        while True:
            try:
                action()
            except Exception as exc:
                tried += 1
                if tried < attempts and _transient(exc):
                    time.sleep(self.backoff_s * 2 ** (tried - 1))
                    continue
                log.warning(
                    "could not %s track %s of %s (queued for later): %s",
                    kind, track_id, uid, exc, exc_info=not _transient(exc) and not isinstance(exc, IndexError_),
                )
                self._set_pending(uid, track_id, kind)
                return False
            self._set_pending(uid, track_id, None)
            return True

    def _set_pending(self, uid: str, track_id: str, kind: Optional[str]) -> None:
        """Queue ``track_id`` as ``kind`` in the user's pending file; ``None`` takes it off the queue."""
        try:
            path = self.store.user_dir(uid) / PENDING_FILE
            with _pending_lock:
                ids = _read_pending(path)
                if kind is None:
                    if ids.pop(track_id, None) is None:
                        return
                else:
                    ids[track_id] = kind
                if ids:
                    write_json_atomic(path, {"ids": ids})
                else:
                    path.unlink(missing_ok=True)
        except Exception:
            log.warning("could not update %s of %s", PENDING_FILE, uid, exc_info=True)

    # ------------------------------------------------------------------ one publish

    def _publish_once(self, uid: str, track_id: str) -> None:
        with user_context(uid):
            store = self.store
            if not store.exists(track_id):
                self.index.delete(uid, track_id)
                return
            self._pin_created_at(track_id)
            # The version first: a change in between only makes the copies look older than they are, and that
            # change publishes again itself. The other way round a client could keep old content as the new version.
            version = store.version(track_id)
            track = store.get_track(track_id)
            media = self._ensure_media(track_id, track)
            write_json_atomic(store.track_dir(track_id) / TRACK_FILE, track_file(track, version, media))
            self.index.upsert(uid, track_id, summary_doc(track, version))

    def _pin_created_at(self, track_id: str) -> None:
        """A track whose meta has no ``createdAt`` shows "now" in the API; the index gets the directory's mtime
        instead, written into meta once so the value stays put. Not a visible change: no version bump."""
        store = self.store
        if store.read_meta(track_id).get("createdAt"):
            return
        with store._lock:
            d = store.track_dir(track_id)
            meta = read_json(d / META_FILE)
            if meta.get("createdAt"):
                return
            mtime = datetime.fromtimestamp(d.stat().st_mtime, timezone.utc)
            meta["createdAt"] = mtime.isoformat(timespec="seconds").replace("+00:00", "Z")
            write_json_atomic(d / META_FILE, meta, pretty=True)

    def _bucket(self) -> Any:
        with self._client_lock:
            if self._client is None:
                self._client = self._client_factory()
            return self._client.bucket(self.bucket_name)

    def _ensure_media(self, track_id: str, track: Track) -> dict[str, Any]:
        """``media`` for track.json: path + token of the audio and every stem whose object exists (each is
        given a download token and the audio content type first when it lacks them)."""
        d = self.store.track_dir(track_id)
        bucket = self._bucket()
        media: dict[str, Any] = {"stems": {}}
        audio = self._ensure_token(bucket, d / AUDIO_FILE)
        if audio:
            media["audio"] = audio
        for name in track.stem_urls:
            stem = self._ensure_token(bucket, d / STEMS_DIR / f"{name}.mp3")
            if stem:
                media["stems"][name] = stem
        return media

    def _ensure_token(self, bucket: Any, file: Path) -> Optional[dict[str, str]]:
        path = file.relative_to(self.store.settings.data_dir).as_posix()
        blob = bucket.get_blob(path)
        if blob is None:
            return None
        metadata = blob.metadata or {}
        token = (metadata.get(TOKEN_KEY) or "").split(",")[0].strip()
        new = not token
        if new:
            token = str(uuid.uuid4())
        if new:  # an existing token (maybe several, set by a client) stays as it is
            blob.metadata = {**metadata, TOKEN_KEY: token}
        if new or blob.content_type != MEDIA_TYPE:
            blob.content_type = MEDIA_TYPE
            blob.patch()
        return {"path": path, "token": token}


class NullPublisher:
    """Local mode (and ``CHORDS_PUBLISH`` off): nothing is published; a delete just removes the directory."""

    def publish(self, uid: Optional[str], track_id: str) -> bool:
        return True

    def unpublish(self, uid: Optional[str], track_id: str) -> bool:
        return True

    def ensure_published(self, uid: Optional[str], track_id: str) -> bool:
        return True

    def delete_track(self, uid: Optional[str], track_id: str, remove: Callable[[], None]) -> None:
        remove()

    def sweep_pending(self) -> int:
        return 0

    def backfill(self, uid: Optional[str] = None) -> int:
        return 0


def main(argv: Optional[list[str]] = None) -> int:
    """``python -m app.publish backfill [--uid UID]``: publish every complete track of every user (or of
    ``UID``) and print how many; safe to repeat. Runs with the service's environment and credentials
    (a Cloud Run job on the service image), so ``CHORDS_PUBLISH`` does not matter here."""
    parser = argparse.ArgumentParser(
        prog="python -m app.publish", description="Publish the library to Firestore and Storage."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    backfill = commands.add_parser("backfill", help="publish every complete track (idempotent)")
    backfill.add_argument("--uid", help="only this user's tracks (default: every user)")
    args = parser.parse_args(argv)
    if args.uid is not None and not valid_uid(args.uid):
        parser.error(f"invalid uid: {args.uid!r}")
    settings = Settings.from_env()
    if not (settings.cloud and settings.upload_bucket):
        parser.error("needs CHORDS_AUTH=firebase and CHORDS_UPLOAD_BUCKET, like the service")
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from .gcs import default_client

    project = settings.firebase_project
    publisher = Publisher(
        TrackStore(settings),
        FirestoreIndex(project),
        bucket=settings.upload_bucket,
        gcs_client_factory=lambda: default_client(project),
    )
    print(f"{publisher.backfill(args.uid)} track(s) published")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Client uploads in the Firebase Storage bucket (cloud mode, docs/CLOUD.md → Uploads).

The browser uploads big files to ``users/<uid>/uploads/<uploadId>/<filename>``; the server reads them
with the google-cloud-storage client (not through the /data FUSE mount), ingests them and deletes them.
``STORAGE_EMULATOR_HOST`` (e.g. ``http://127.0.0.1:9199``) points the client at the Firebase Storage
emulator with anonymous credentials.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Optional

from .sources import Cancelled, SourceError

log = logging.getLogger("chords.gcs")

UPLOADS_GLOB = "users/*/uploads/**"
FETCH_PREFIX = "fetch/"  # fragments chords-fetch leaves for the API (docs/CLOUD.md → YouTube clips)
FETCH_GLOB = FETCH_PREFIX + "**"


@dataclass
class ObjectInfo:
    path: str
    size: int
    content_type: Optional[str] = None
    created: Optional[datetime] = None


def default_client(project: Optional[str] = None) -> Any:
    from google.cloud import storage

    if os.environ.get("STORAGE_EMULATOR_HOST"):
        from google.auth.credentials import AnonymousCredentials

        return storage.Client(project=project or "demo-project", credentials=AnonymousCredentials())
    return storage.Client(project=project)


class _ProgressWriter:
    """File wrapper for ``Blob.download_to_file``: progress, cancellation and a size cap."""

    def __init__(
        self, fh: Any, total: int, progress: Callable[[float], None], cancel: threading.Event, max_bytes: int
    ) -> None:
        self._fh, self._total, self._progress, self._cancel, self._max = fh, max(total, 1), progress, cancel, max_bytes
        self.written = 0
        self._last = 0.0

    def write(self, data: bytes) -> int:
        if self._cancel.is_set():
            raise Cancelled()
        self.written += len(data)
        if self.written > self._max:
            raise SourceError("too_large", f"The file is larger than the {self._max / (1024 * 1024):g} MB limit")
        self._fh.write(data)
        now = time.monotonic()
        if now - self._last > 0.2:
            self._last = now
            self._progress(min(1.0, self.written / self._total))
        return len(data)

    def __getattr__(self, name: str) -> Any:  # tell/seek/flush pass through
        return getattr(self._fh, name)


class UploadBucket:
    def __init__(
        self, name: str, *, project: Optional[str] = None, client_factory: Optional[Callable[[], Any]] = None
    ) -> None:
        self.name = name
        self._factory = client_factory or (lambda: default_client(project))
        self._client: Any = None
        self._lock = threading.Lock()

    def client(self) -> Any:
        with self._lock:
            if self._client is None:
                self._client = self._factory()
            return self._client

    def _bucket(self) -> Any:
        return self.client().bucket(self.name)

    def stat(self, path: str) -> Optional[ObjectInfo]:
        """Object metadata, or None when it doesn't exist."""
        try:
            blob = self._bucket().get_blob(path)
        except Exception as exc:
            raise _map_error(exc, "Couldn't read the upload") from exc
        if blob is None:
            return None
        return ObjectInfo(path=path, size=int(blob.size or 0), content_type=blob.content_type, created=blob.time_created)

    def download(
        self,
        path: str,
        dest: Path,
        *,
        size: int,
        progress: Callable[[float], None],
        cancel: threading.Event,
        max_bytes: int,
    ) -> int:
        """Stream the object into ``dest``; returns the byte count. Raises SourceError / Cancelled."""
        blob = self._bucket().blob(path)
        with open(dest, "wb") as fh:
            writer = _ProgressWriter(fh, size, progress, cancel, max_bytes)
            try:
                blob.download_to_file(writer)
            except (Cancelled, SourceError):
                raise
            except Exception as exc:
                if cancel.is_set():
                    raise Cancelled() from exc
                raise _map_error(exc, "Couldn't download the upload") from exc
        progress(1.0)
        return writer.written

    def delete(self, path: str) -> bool:
        try:
            self._bucket().blob(path).delete()
            return True
        except Exception as exc:
            if type(exc).__name__ != "NotFound":
                log.warning("could not delete upload %s: %s", path, exc)
            return False

    def sweep(self, max_age_s: float = 24 * 3600, glob: str = UPLOADS_GLOB) -> int:
        """Delete abandoned uploads older than ``max_age_s``. Returns how many were removed."""
        cutoff = time.time() - max_age_s
        removed = 0
        for blob in self.client().list_blobs(self.name, match_glob=glob):
            created = getattr(blob, "time_created", None)
            if created is not None and created.timestamp() < cutoff:
                try:
                    blob.delete()
                    removed += 1
                except Exception as exc:  # pragma: no cover - best effort
                    log.warning("could not delete stale upload %s: %s", blob.name, exc)
        if removed:
            log.info("removed %d stale upload(s)", removed)
        return removed


def _map_error(exc: Exception, message: str) -> SourceError:
    name = type(exc).__name__
    if name == "NotFound":
        return SourceError("not_found", "The upload was not found (it may have been processed already)", 404)
    log.warning("%s: %s: %s", message, name, exc)
    return SourceError("download_failed", message)

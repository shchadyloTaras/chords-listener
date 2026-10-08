"""chords-api's side of YouTube fragments (docs/CLOUD.md → YouTube clips): ``RemoteClipFetcher`` asks the
chords-fetch service (Cloud Run, downloads through Cloudflare WARP) for a fragment, then moves the file it left in
the bucket (``fetch/<requestId>/source.<ext>``) into the job's work dir and deletes the object."""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from pydantic import BaseModel, ValidationError

from .gcs import FETCH_PREFIX
from .sources import Cancelled, FetchedClip, ProgressCb, SourceError, safe_suffix

log = logging.getLogger("chords.fetch_client")

BUSY_MESSAGE = "The server is busy, try again in a minute"
TOKEN_TTL_S = 50 * 60  # Google ID tokens live 1 h
_BUSY = frozenset({0, 429, 503})  # 0: no connection (a cold start, a network hiccup)
_PASSED_ON = frozenset({"invalid_url", "download_blocked", "download_failed", "too_large"})

TokenFn = Callable[[str], str]


def google_id_token(audience: str) -> str:
    """An ID token for ``audience`` (the chords-fetch URL) from the metadata server: Cloud Run's service account."""
    import google.auth.transport.requests
    import google.oauth2.id_token

    return google.oauth2.id_token.fetch_id_token(google.auth.transport.requests.Request(), audience)


class _ClipAnswer(BaseModel):
    title: str
    artist: Optional[str] = None
    duration: Optional[float] = None
    thumbnail: Optional[str] = None
    start: float
    end: float
    path: str
    size: int = 0


class RemoteClipFetcher:
    """ClipFetcher backed by chords-fetch: ``POST {base_url}/clip`` with an ID token, asked again while every
    container is busy or starting (429 / 503 / no connection) for up to ``busy_wait_s``."""

    def __init__(
        self,
        base_url: str,
        bucket: Any,
        *,
        max_bytes: int,
        token_fn: Optional[TokenFn] = None,
        session: Any = None,
        busy_wait_s: float = 60.0,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.bucket = bucket
        self.max_bytes = max_bytes
        self.busy_wait_s = busy_wait_s
        self._token_fn = token_fn or google_id_token
        self._token: Optional[tuple[str, float]] = None
        self._lock = threading.Lock()
        self._session = session
        self._sleep, self._clock = sleep, clock

    def fetch(
        self, video_id: str, start: int, length: int, dest_dir: Path, progress: ProgressCb, cancel: threading.Event
    ) -> FetchedClip:
        raw = self._call({"videoId": video_id, "start": int(start), "length": int(length)}, cancel)
        try:
            answer = _ClipAnswer.model_validate(raw)
        except ValidationError as exc:
            log.error("chords-fetch answered something unexpected: %.300s", raw)
            raise SourceError("download_failed", "The download service gave an invalid answer") from exc
        segments = answer.path.split("/")
        if not answer.path.startswith(FETCH_PREFIX) or any(s in ("", ".", "..") for s in segments):
            # never read or delete anything outside fetch/ on the service's word
            log.error("chords-fetch answered with an object outside %s: %.200s", FETCH_PREFIX, answer.path)
            raise SourceError("download_failed", "The download service gave an invalid answer")
        dest = dest_dir / ("source" + safe_suffix(segments[-1]))
        try:
            if cancel.is_set():
                raise Cancelled()
            self.bucket.download(
                answer.path, dest, size=answer.size, progress=progress, cancel=cancel, max_bytes=self.max_bytes
            )
        finally:
            self.bucket.delete(answer.path)  # the fragment is consumed whatever happens next
        return FetchedClip(
            path=dest,
            title=answer.title.strip()[:300] or video_id,
            artist=answer.artist,
            duration=answer.duration,
            thumbnail=answer.thumbnail,
            start=answer.start,
            end=answer.end,
        )

    # ------------------------------------------------------------------ HTTP

    def _call(self, body: dict[str, Any], cancel: threading.Event) -> Any:
        deadline = self._clock() + self.busy_wait_s
        delay = 2.0
        while True:
            if cancel.is_set():
                raise Cancelled()
            status, payload = self._post(body)
            if status == 200:
                return payload
            if status not in _BUSY:
                raise _service_error(status, payload)
            if self._clock() + delay > deadline:
                log.warning("chords-fetch still busy after %.0f s (last: %s)", self.busy_wait_s, status or "no connection")
                raise SourceError("download_failed", BUSY_MESSAGE)
            log.info("chords-fetch busy (%s); asking again in %.0f s", status or "no connection", delay)
            self._sleep(delay)
            delay = min(delay * 2, 15.0)

    def _post(self, body: dict[str, Any]) -> tuple[int, Any]:
        import requests

        token = self._id_token()  # a failure here is not a busy service: it is raised, not retried
        try:
            res = self._http().post(
                f"{self.base_url}/clip",
                json=body,
                headers={"Authorization": f"Bearer {token}"},
                timeout=(10, 300),
            )
        except requests.RequestException as exc:
            log.info("chords-fetch unreachable: %s", exc)
            return 0, None
        try:
            return res.status_code, res.json()
        except ValueError:
            return res.status_code, None

    def _http(self) -> Any:
        if self._session is None:
            import requests

            self._session = requests.Session()
        return self._session

    def _id_token(self) -> str:
        with self._lock:
            now = self._clock()
            if self._token is None or now - self._token[1] > TOKEN_TTL_S:
                try:
                    self._token = (self._token_fn(self.base_url), now)
                except Exception as exc:  # google.auth errors, a dead metadata server: never a crash
                    log.warning("could not get an ID token for chords-fetch: %s", exc)
                    raise SourceError("download_failed", "The download service failed") from exc
            return self._token[0]


def _service_error(status: int, payload: Any) -> SourceError:
    """chords-fetch's own user-facing codes pass on; anything else (IAM refusals, crashes) is a plain failure."""
    code = payload.get("code") if isinstance(payload, dict) else None
    message = payload.get("message") if isinstance(payload, dict) else None
    if code in _PASSED_ON and isinstance(message, str) and message.strip():
        return SourceError(code, message.strip()[:300])
    log.warning("chords-fetch failed: HTTP %s %.200s", status, payload)
    return SourceError("download_failed", "The download service failed")

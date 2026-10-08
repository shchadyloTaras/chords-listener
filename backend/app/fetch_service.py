"""chords-fetch: short YouTube fragments through Cloudflare WARP, for chords-api
(docs/superpowers/specs/2026-10-07-youtube-warp-fetch-design.md; docs/CLOUD.md → YouTube clips).

    uvicorn --factory app.fetch_service:create_app_from_env --port 8080

``POST /clip {videoId, start, length}``: probe the video, download only ``[start, min(start + length, duration)]``
with yt-dlp through the WARP SOCKS5 proxy, store it as ``fetch/<requestId>/source.<ext>`` in the bucket and answer
``{title, artist, duration, thumbnail, start, end, path, size}``; errors are ``{code, message}``. Only video ids are
accepted, never URLs, so this is no open proxy; Cloud Run lets in only chords-api's service account. One request
per container (concurrency 1), so a WARP reconnect never cuts another download.
"""
from __future__ import annotations

import logging
import os
import secrets
import shutil
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from .gcs import FETCH_PREFIX, UploadBucket
from .sources import (
    YT_CLIP_MAX_S,
    Cancelled,
    ClipFetcher,
    FetchedClip,
    LocalClipFetcher,
    SourceError,
    YtDlpFetcher,
    ensure_tool_path,
    is_bot_check,
    safe_suffix,
)
from .warp import Warp, WarpError

log = logging.getLogger("chords.fetch")

MAX_ATTEMPTS = 3  # a refused media URL (HTTP 403, ~1 in 10 first tries) or a stall: fresh tries
ATTEMPT_TIMEOUT_S = 90.0
MAX_CLIP_BYTES = 50 * 1024 * 1024  # a minute of the best audio is a few MB
STATUS = {"invalid_url": 400, "too_large": 413, "download_blocked": 502, "download_failed": 502}
CONTENT_TYPES = {
    ".webm": "audio/webm", ".weba": "audio/webm", ".m4a": "audio/mp4", ".mp4": "audio/mp4",
    ".opus": "audio/ogg", ".ogg": "audio/ogg", ".mp3": "audio/mpeg",
}
_STALLS = ("timed out", "timeout", "connection reset", "connection refused", "connection aborted",
           "network is unreachable", "unable to download webpage", "temporary failure", "eof occurred")


class ClipBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    videoId: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")  # noqa: N815 - the JSON name
    start: int = Field(ge=0, le=24 * 3600)
    length: int = Field(ge=1, le=YT_CLIP_MAX_S)


def failure_kind(exc: SourceError) -> str:
    """'bot' (a new WARP session may pass), 'retry' (a refused media URL, a stall) or 'final'."""
    detail = exc.detail or exc.message
    if exc.code == "download_blocked":
        return "bot" if is_bot_check(detail) else "retry"
    if exc.code == "download_failed" and any(s in detail.lower() for s in _STALLS):
        return "retry"
    return "final"


def _reconnect(warp: Warp) -> None:
    try:
        warp.restart()
    except WarpError as exc:
        log.error("WARP reconnect failed: %s", exc)
        raise SourceError("download_failed", "The download service lost its connection - try again in a minute") from exc


def fetch_with_retries(
    fetcher: ClipFetcher,
    warp: Optional[Warp],
    body: ClipBody,
    dest: Path,
    *,
    max_attempts: int = MAX_ATTEMPTS,
    attempt_timeout_s: float = ATTEMPT_TIMEOUT_S,
    stats: Optional[dict[str, int]] = None,
) -> FetchedClip:
    """One fragment, retried: a refused media URL or a stall gets up to ``max_attempts`` fresh tries (a new
    extraction each time); a bot check gets one WARP reconnect (a new session, usually a new address) and one more
    try, then ``download_blocked``. ``stats["attempts"]`` counts the tries."""
    stats = stats if stats is not None else {}
    attempts, reconnected = 0, False
    while True:
        attempts += 1
        stats["attempts"] = attempts
        shutil.rmtree(dest, ignore_errors=True)  # a failed try may leave parts behind
        dest.mkdir(parents=True)
        cancel = threading.Event()
        watchdog = threading.Timer(attempt_timeout_s, cancel.set)
        watchdog.daemon = True
        watchdog.start()
        try:
            return fetcher.fetch(body.videoId, body.start, body.length, dest, lambda _f: None, cancel)
        except Cancelled as exc:  # only the watchdog cancels here
            if attempts >= max_attempts:
                raise SourceError(
                    "download_failed", f"Network error: the download timed out after {attempt_timeout_s:g} s"
                ) from exc
            log.info("clip %s: attempt %d timed out", body.videoId, attempts)
        except SourceError as exc:
            kind = failure_kind(exc)
            if kind == "bot" and warp is not None and not reconnected:
                log.info("clip %s: bot check on attempt %d, reconnecting WARP", body.videoId, attempts)
                reconnected = True
                _reconnect(warp)
            elif kind == "retry" and attempts < max_attempts:
                log.info("clip %s: attempt %d failed (%s), trying again", body.videoId, attempts, exc.code)
            else:
                raise
        finally:
            watchdog.cancel()


def _error(code: str, message: str) -> JSONResponse:
    return JSONResponse({"code": code, "message": message}, status_code=STATUS.get(code, 500))


def create_fetch_app(
    *,
    fetcher: ClipFetcher,
    bucket: Any,
    warp: Optional[Warp],
    work_dir: Path,
    max_attempts: int = MAX_ATTEMPTS,
    attempt_timeout_s: float = ATTEMPT_TIMEOUT_S,
) -> FastAPI:
    """``bucket``: ``upload(path, src, content_type)`` (gcs.UploadBucket). ``warp`` None: no proxy (local runs)."""

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        work_dir.mkdir(parents=True, exist_ok=True)
        if warp is not None:
            await run_in_threadpool(warp.start)  # Cloud Run sends requests once the port is open, i.e. after this
        try:
            yield
        finally:
            if warp is not None:
                warp.stop()

    app = FastAPI(title="chords-fetch", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(RequestValidationError)
    async def _invalid(_: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
        return _error("invalid_url", f"Invalid request - {where}: {first.get('msg', 'invalid value')}")

    @app.exception_handler(SourceError)
    async def _source(_: Request, exc: SourceError) -> JSONResponse:
        return _error(exc.code, exc.message)

    @app.get("/healthz")
    def healthz() -> dict[str, bool]:
        return {"ok": warp is None or warp.ready}

    @app.post("/clip")
    def clip(body: ClipBody) -> dict[str, Any]:
        request_id = secrets.token_hex(8)
        dest = work_dir / request_id
        stats = {"attempts": 0}
        started, outcome = time.monotonic(), "internal"
        try:
            if warp is not None and not warp.ready:
                _reconnect(warp)
            got = fetch_with_retries(fetcher, warp, body, dest, max_attempts=max_attempts,
                                     attempt_timeout_s=attempt_timeout_s, stats=stats)
            size = got.path.stat().st_size
            if size > MAX_CLIP_BYTES:
                raise SourceError("too_large", "The fragment is too large")
            suffix = safe_suffix(got.path.name)
            path = f"{FETCH_PREFIX}{request_id}/source{suffix}"
            bucket.upload(path, got.path, content_type=CONTENT_TYPES.get(suffix, "application/octet-stream"))
            outcome = "ok"
            return {
                "title": got.title, "artist": got.artist, "duration": got.duration, "thumbnail": got.thumbnail,
                "start": got.start, "end": got.end, "path": path, "size": size,
            }
        except SourceError as exc:
            outcome = exc.code
            raise
        finally:
            shutil.rmtree(dest, ignore_errors=True)
            log.info("clip %s@%d+%d: %s after %d attempt(s) in %.1fs", body.videoId, body.start, body.length,
                     outcome, stats["attempts"], time.monotonic() - started)

    return app


def create_app_from_env() -> FastAPI:
    """The Cloud Run service. ``FETCH_BUCKET``: the Firebase default bucket; ``WARP_PROFILE``: the wgcf profile
    mounted from Secret Manager (unset: no WARP, for local runs); ``FETCH_WORK_DIR``: scratch space."""
    ensure_tool_path()
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    bucket_name = os.environ.get("FETCH_BUCKET", "").strip()
    if not bucket_name:
        raise RuntimeError("FETCH_BUCKET is not set")
    profile = os.environ.get("WARP_PROFILE", "").strip()
    work_dir = Path(os.environ.get("FETCH_WORK_DIR", "").strip() or "/tmp/chords-fetch")
    warp = Warp(Path(profile), work_dir=work_dir / ".warp") if profile else None
    fetcher = LocalClipFetcher(YtDlpFetcher(
        MAX_CLIP_BYTES, proxy=warp.proxy if warp else None, ffmpeg_proxy=warp.http_proxy if warp else None
    ))
    return create_fetch_app(fetcher=fetcher, bucket=UploadBucket(bucket_name), warp=warp, work_dir=work_dir)

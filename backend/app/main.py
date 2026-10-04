"""Chords Listener HTTP API (FastAPI).

Run:  cd backend && uv run uvicorn app.main:app --port 8765
When ``frontend/dist`` exists the built UI is served at ``/`` as well (SPA fallback), so the whole app
lives at http://localhost:8765.
"""
from __future__ import annotations

import fnmatch
import logging
import shutil
from contextlib import asynccontextmanager
from typing import Annotated, Any, AsyncIterator, Callable, Optional

from fastapi import APIRouter, Body, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Receive, Scope, Send

from app.engine import engine_info

from .jobs import Analyzer, JobManager, too_long_message
from .models import (
    AnalysisOptions,
    CreateJobRequest,
    EngineInfo,
    ErrorCode,
    Health,
    Job,
    ReanalyzeRequest,
    Settings,
    Track,
    TrackNotes,
    TrackPatch,
    TrackSummary,
    normalize_origin,
)
from .sources import (
    SourceError,
    UrlFetcher,
    YtDlpFetcher,
    ensure_tool_path,
    ffmpeg_available,
    normalize_url,
    probe_media,
    receive_upload,
    ytdlp_version,
)
from .storage import TrackNotFound, TrackStore

log = logging.getLogger("chords.api")

STATUS_BY_CODE: dict[str, int] = {
    "invalid_url": 400,
    "download_failed": 502,
    "unsupported_format": 415,
    "too_long": 422,
    "too_large": 413,
    "analysis_failed": 500,
    "not_found": 404,
    "internal": 500,
}


class ApiException(Exception):
    def __init__(self, code: ErrorCode, detail: str, status: Optional[int] = None) -> None:
        super().__init__(detail)
        self.code: ErrorCode = code
        self.detail = detail
        self.status = status or STATUS_BY_CODE.get(code, 500)


def error_response(status: int, code: ErrorCode, detail: str, headers: Optional[dict[str, str]] = None) -> JSONResponse:
    return JSONResponse({"detail": detail, "code": code}, status_code=status, headers=headers)


def _not_found(what: str = "Track") -> ApiException:
    return ApiException("not_found", f"{what} not found")


# --------------------------------------------------------------------------- local-only guard


def _host_matches(host: str, patterns: tuple[str, ...]) -> bool:
    host = host.lower().strip("[]")
    return any(p == "*" or host == p.strip("[]") or fnmatch.fnmatch(host, p) for p in patterns)


def _split_host(value: str) -> str:
    value = value.strip()
    if value.startswith("["):  # [::1]:8765
        return value[1 : value.find("]")] if "]" in value else value
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


class LocalOnlyMiddleware:
    """Rejects requests whose Host header isn't a local name (DNS-rebinding protection) and state-changing
    API calls coming from foreign web pages (Origin check, CSRF protection for simple form posts).

    Pages on a local host (any port) and the explicitly ``allowed_origins`` (e.g. the GitHub Pages build of
    the UI) may use the API; CORS (configured in ``create_app``) mirrors the same list.
    """

    def __init__(
        self, app: ASGIApp, allowed_hosts: tuple[str, ...], allowed_origins: tuple[str, ...] = ()
    ) -> None:
        self.app = app
        self.allowed = allowed_hosts
        self.origins = frozenset(normalize_origin(o) for o in allowed_origins)

    def origin_allowed(self, origin: str) -> bool:
        if not origin or origin == "null":
            return False
        if normalize_origin(origin) in self.origins:
            return True
        origin_host = _split_host(origin.split("://", 1)[-1].split("/", 1)[0])
        return bool(origin_host) and _host_matches(origin_host, self.allowed)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if "*" in self.allowed:
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        host = _split_host(headers.get("host", ""))
        if host and not _host_matches(host, self.allowed):
            await error_response(400, "internal", "Host not allowed (set CHORDS_ALLOWED_HOSTS)")(scope, receive, send)
            return
        origin = headers.get("origin")
        if (
            origin
            and scope.get("method") not in ("GET", "HEAD", "OPTIONS")
            and scope.get("path", "").startswith("/api")
            and not self.origin_allowed(origin)
        ):
            await error_response(403, "internal", "Cross-site requests are not allowed")(scope, receive, send)
            return
        await self.app(scope, receive, send)


# Pages served from a local host on any port (Vite dev / preview) may read API responses (CORS).
LOCAL_ORIGIN_REGEX = r"https?://(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)(:\d+)?"


# --------------------------------------------------------------------------- app factory


def create_app(
    settings: Optional[Settings] = None,
    *,
    analyzer: Optional[Analyzer] = None,
    fetcher: Optional[UrlFetcher] = None,
    engine_info_fn: Optional[Callable[[], dict]] = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    ensure_tool_path()
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    store = TrackStore(settings)
    jobs = JobManager(settings, store, fetcher or YtDlpFetcher(settings.max_upload_bytes), analyzer)
    get_engine_info = engine_info_fn or engine_info

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        store.init()
        log.info("data dir: %s", settings.data_dir)
        try:
            yield
        finally:
            jobs.shutdown()

    app = FastAPI(
        title="Chords Listener",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.settings = settings
    app.state.store = store
    app.state.jobs = jobs

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_origin_regex=LOCAL_ORIGIN_REGEX,
        # Private Network Access: an https page (GitHub Pages) calling http://localhost gets a preflight
        # with "Access-Control-Request-Private-Network: true"; allowed origins get "...-Allow-Private-Network".
        allow_private_network=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
    )
    app.add_middleware(
        LocalOnlyMiddleware, allowed_hosts=settings.allowed_hosts, allowed_origins=settings.allowed_origins
    )

    _install_error_handlers(app)
    app.include_router(_api_router(settings, store, jobs, get_engine_info))
    _install_frontend(app, settings)
    return app


def _install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiException)
    async def _api_exc(_: Request, exc: ApiException) -> JSONResponse:
        return error_response(exc.status, exc.code, exc.detail)

    @app.exception_handler(SourceError)
    async def _source_exc(_: Request, exc: SourceError) -> JSONResponse:
        return error_response(exc.status or STATUS_BY_CODE.get(exc.code, 500), exc.code, exc.message)

    @app.exception_handler(TrackNotFound)
    async def _track_missing(_: Request, __: TrackNotFound) -> JSONResponse:
        return error_response(404, "not_found", "Track not found")

    @app.exception_handler(StarletteHTTPException)
    async def _http_exc(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code: ErrorCode = {404: "not_found", 413: "too_large", 415: "unsupported_format"}.get(exc.status_code, "internal")
        detail = exc.detail if isinstance(exc.detail, str) else "Request failed"
        return error_response(exc.status_code, code, detail, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def _validation_exc(request: Request, exc: RequestValidationError) -> JSONResponse:
        errors = exc.errors()
        first = errors[0] if errors else {}
        where = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
        message = f"{where}: {first.get('msg', 'invalid value')}" if where else str(first.get("msg", "Invalid request"))
        code: ErrorCode = "invalid_url" if request.url.path.rstrip("/") == "/api/jobs" else "internal"
        return error_response(422, code, f"Invalid request - {message}")

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.error("unhandled error on %s %s", request.method, request.url.path, exc_info=exc)
        return error_response(500, "internal", "Internal server error")


async def _read_body_limited(request: Request, limit: int) -> bytes:
    """The request body, refusing (413 too_large) anything over ``limit`` bytes without buffering it all."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise ApiException("too_large", f"The request body is larger than {limit // (1024 * 1024)} MB")
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise ApiException("too_large", f"The request body is larger than {limit // (1024 * 1024)} MB")
        chunks.append(chunk)
    return b"".join(chunks)


def _validation_message(exc: ValidationError) -> str:
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(p) for p in first.get("loc", ()))
    msg = str(first.get("msg", "invalid value")).removeprefix("Value error, ")
    return f"Invalid notes - {where}: {msg}" if where else f"Invalid notes - {msg}"


def _options(raw: Optional[AnalysisOptions | dict[str, Any]]) -> dict[str, Any]:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        try:
            raw = AnalysisOptions.model_validate(raw)
        except ValueError:
            return {}
    return raw.to_engine()


def _api_router(
    settings: Settings, store: TrackStore, jobs: JobManager, get_engine_info: Callable[[], dict]
) -> APIRouter:
    api = APIRouter(prefix="/api")

    @api.get("/health", response_model=Health)
    def health() -> Health:
        ok = True
        try:
            info = EngineInfo.model_validate(get_engine_info())
        except Exception:
            log.exception("engine_info() failed")
            info, ok = EngineInfo(name="unavailable", version="", features={}), False
        has_ffmpeg = ffmpeg_available()
        return Health(ok=ok and has_ffmpeg, engine=info, ytdlp=ytdlp_version(), ffmpeg=has_ffmpeg)

    # ------------------------------------------------------------------ jobs

    @api.post("/jobs", response_model=Job, status_code=201)
    def create_job(body: CreateJobRequest) -> Job:
        url = normalize_url(body.url)
        return jobs.submit_url(url, _options(body.options))

    @api.post(
        "/jobs/upload",
        response_model=Job,
        status_code=201,
        openapi_extra={
            "requestBody": {
                "required": True,
                "content": {
                    "multipart/form-data": {
                        "schema": {
                            "type": "object",
                            "required": ["file"],
                            "properties": {
                                "file": {"type": "string", "format": "binary"},
                                "options": {"type": "string", "description": 'JSON, e.g. {"separate": true}'},
                            },
                        }
                    }
                },
            }
        },
    )
    async def upload_job(request: Request) -> Job:
        """Multipart upload streamed straight to disk; deduplicated by content sha1."""
        work = store.new_work_dir("upload")
        try:
            upload = await receive_upload(request, work, settings.max_upload_bytes)
            probe = await run_in_threadpool(probe_media, upload.path)
            if not probe.has_audio:
                raise SourceError("unsupported_format", "This file has no audio track")
            if probe.duration and probe.duration > settings.max_duration_s:
                raise SourceError("too_long", too_long_message(probe.duration, settings.max_duration_min))
        except BaseException:
            shutil.rmtree(work, ignore_errors=True)
            raise
        return await run_in_threadpool(jobs.submit_upload, upload, probe, _options(upload.options))

    @api.get("/jobs", response_model=list[Job])
    def list_jobs() -> list[Job]:
        return jobs.list()

    @api.get("/jobs/{job_id}", response_model=Job)
    def get_job(job_id: str) -> Job:
        job = jobs.get(job_id)
        if job is None:
            raise _not_found("Job")
        return job

    # ------------------------------------------------------------------ tracks

    @api.get("/tracks", response_model=list[TrackSummary])
    def list_tracks() -> list[TrackSummary]:
        return store.list_tracks()

    @api.get("/tracks/{track_id}", response_model=Track)
    def get_track(track_id: str) -> Track:
        return store.get_track(track_id)

    @api.patch("/tracks/{track_id}", response_model=Track)
    def patch_track(track_id: str, body: TrackPatch) -> Track:
        return store.patch(track_id, body)

    @api.post("/tracks/{track_id}/reset", response_model=Track)
    def reset_track(track_id: str) -> Track:
        return store.reset(track_id)

    @api.post("/tracks/{track_id}/reanalyze", response_model=Job, status_code=201)
    def reanalyze_track(track_id: str, body: Annotated[Optional[ReanalyzeRequest], Body()] = None) -> Job:
        return jobs.submit_reanalyze(track_id, _options(body.options if body else None))

    @api.delete("/tracks/{track_id}", status_code=204)
    def delete_track(track_id: str) -> Response:
        if not store.valid_id(track_id):
            raise _not_found()
        jobs.cancel_track_jobs(track_id, "not_found", "The track was deleted")
        store.delete(track_id)
        return Response(status_code=204)

    # ------------------------------------------------------------------ live-piano notes

    @api.get(
        "/tracks/{track_id}/notes",
        response_model=TrackNotes,
        responses={404: {"description": "Unknown track, or its notes were not computed yet (code not_found)"}},
    )
    def get_notes(track_id: str) -> Response:
        """Notes transcribed in the browser for the live piano (stored by PUT)."""
        raw = store.read_notes(track_id)  # unknown track -> 404 not_found
        if raw is None:
            raise ApiException("not_found", "Notes were not computed for this track yet")
        return Response(content=raw, media_type="application/json", headers={"Cache-Control": "no-cache"})

    @api.put(
        "/tracks/{track_id}/notes",
        status_code=204,
        openapi_extra={
            "requestBody": {
                "required": True,
                "content": {"application/json": {"schema": TrackNotes.model_json_schema()}},
            }
        },
    )
    async def put_notes(track_id: str, request: Request) -> Response:
        """Stores (replaces) a track's live-piano notes: ≤ max_notes rows, ≤ max_notes_mb of JSON."""
        if not store.exists(track_id):
            raise _not_found()
        body = await _read_body_limited(request, settings.max_notes_bytes)
        try:
            notes = await run_in_threadpool(TrackNotes.model_validate_json, body)
        except ValidationError as exc:
            raise ApiException("internal", _validation_message(exc), status=422) from exc
        if len(notes.notes) > settings.max_notes:
            raise ApiException("internal", f"Invalid notes - at most {settings.max_notes} notes are allowed", status=422)
        duration = await run_in_threadpool(store.duration, track_id)
        if duration and notes.latest_end() > duration + 1.0:
            raise ApiException("internal", f"Invalid notes - a note ends after the track ({duration:.1f} s)", status=422)
        await run_in_threadpool(store.write_notes, track_id, notes)
        return Response(status_code=204)

    @api.api_route("/tracks/{track_id}/audio", methods=["GET", "HEAD"], response_class=FileResponse)
    def track_audio(track_id: str) -> FileResponse:
        path = store.audio_path(track_id)
        return FileResponse(
            path,
            media_type="audio/mpeg",
            headers={"Cache-Control": "private, max-age=3600", "Accept-Ranges": "bytes"},
        )

    @api.api_route("/{rest:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
    def api_not_found(rest: str) -> Response:
        raise ApiException("not_found", f"Unknown API endpoint: /api/{rest}")

    return api


# --------------------------------------------------------------------------- built frontend (SPA)

_FRONTEND_MISSING = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Chords Listener</title>
<style>body{font-family:system-ui,sans-serif;background:#0d0f14;color:#e6e8ee;display:grid;place-items:center;
min-height:100vh;margin:0}main{max-width:34rem;padding:1.5rem;line-height:1.55}code{background:#1c2030;
padding:.1rem .35rem;border-radius:.3rem}a{color:#8ab4ff}</style></head><body><main>
<h1>Chords Listener API is running</h1>
<p>The web UI hasn't been built yet. Either run <code>npm run build</code> in <code>frontend/</code> and reload
this page, or start the dev server with <code>npm run dev</code> and open
<a href="http://localhost:5173">http://localhost:5173</a>.</p>
<p>API docs: <a href="/api/docs">/api/docs</a></p></main></body></html>"""


def _install_frontend(app: FastAPI, settings: Settings) -> None:
    dist = settings.frontend_dist

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def frontend(full_path: str) -> Response:
        if full_path == "api" or full_path.startswith("api/"):
            raise ApiException("not_found", f"Unknown API endpoint: /{full_path}")
        root = dist.resolve()
        index = root / "index.html"
        if full_path:
            candidate = (root / full_path).resolve()
            if candidate.is_relative_to(root) and candidate.is_file():
                hashed = candidate.parent.name == "assets" and candidate.parent.parent == root
                cache = "public, max-age=31536000, immutable" if hashed else "no-cache"
                return FileResponse(candidate, headers={"Cache-Control": cache})
            if "." in full_path.rsplit("/", 1)[-1]:  # a missing file, not an app route
                raise ApiException("not_found", "File not found")
        if index.is_file():
            return FileResponse(index, media_type="text/html", headers={"Cache-Control": "no-cache"})
        return HTMLResponse(_FRONTEND_MISSING, status_code=404, headers={"Cache-Control": "no-cache"})


app = create_app()

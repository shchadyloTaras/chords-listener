"""Chords Listener HTTP API (FastAPI).

Run:  cd backend && uv run uvicorn app.main:app --port 8765
When ``frontend/dist`` exists the built UI is served at ``/`` as well (SPA fallback), so the whole app
lives at http://localhost:8765.
"""
from __future__ import annotations

import fnmatch
import logging
import os
import re
import shutil
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, AsyncIterator, Callable, Optional

from fastapi import APIRouter, Body, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.engine import engine_info

from .admin.audit import AuditFailure
from .admin.authz import ADMIN_PREFIX, AdminAuthz, HiddenFromCaller, ReauthRequired, unguarded_admin_routes
from .admin.deletion import AuthAdmin, BucketEraser, Purger
from .admin.directory import Directory
from .admin.history import Projections, pending_path
from .admin.router import router as admin_router_default
from .admin.settings import RuntimeSettings
from .admin.sweeps import Sweeper, internal_router
from .admission import Admission
from .auth import AuthMiddleware, FirebaseTokenVerifier, MediaSigner, SchedulerTokenVerifier
from .fetch_client import RemoteClipFetcher
from .firestore import FirestoreIndex
from .gcs import FETCH_GLOB, UPLOADS_GLOB, UploadBucket, default_client
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
    StorageJobRequest,
    Track,
    TrackNotes,
    TrackPatch,
    TrackSummary,
    UserInfo,
    VocalNotes,
    VocalsRequest,
    normalize_origin,
)
from .publish import NullPublisher, Publisher
from .sources import (
    ClipFetcher,
    LocalClipFetcher,
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
from .users import current_uid

log = logging.getLogger("chords.api")

PUBLISH_SWEEP_INTERVAL_S = 600.0  # how often the pending publishes (publish-pending.json) are retried
BACKGROUND_START_QUIET_S = 10.0  # with no request, the start-up background work begins this long after start-up
_UNSET: Any = object()  # "not given" for create_app arguments where None means "none"


def _scheduler_verifier_from_env() -> Optional[SchedulerTokenVerifier]:
    """The check of Cloud Scheduler's OIDC token (``CHORDS_SCHEDULER_AUDIENCE`` = this service's URL,
    ``CHORDS_SCHEDULER_EMAIL`` = ``chords-scheduler@...``); None unless both are set: the sweep endpoint then
    answers 404 to everyone."""
    audience = os.environ.get("CHORDS_SCHEDULER_AUDIENCE", "").strip()
    email = os.environ.get("CHORDS_SCHEDULER_EMAIL", "").strip()
    return SchedulerTokenVerifier(audience, email) if audience and email else None

def instance_cap_warning(env: Optional[Any] = None) -> Optional[str]:
    """The start-up warning when the Cloud Run instance cap is not 1, else None. The daily quota, the probe limiter
    and the 10 deletions / 60 min limit live in this process's memory (docs/features/admin sad §11, ADR-0003), so a second
    instance would double them. ``scripts/deploy_cloud.sh`` declares the cap it deploys with as ``CHORDS_MAX_INSTANCES``."""
    value = (os.environ if env is None else env).get("CHORDS_MAX_INSTANCES", "").strip()
    if value == "1":
        return None
    shown = f"{value!r}" if value else "not declared (CHORDS_MAX_INSTANCES)"
    return (f"max-instances is {shown}, expected 1: the admin's quotas, attempt limits and deletion limit are kept "
            "in this process's memory and are only correct with one instance (deploy with scripts/deploy_cloud.sh)")
BUCKET_SWEEP_INTERVAL_S = 3600.0  # how often abandoned uploads and fragments are removed from the bucket
UPLOAD_MAX_AGE_S = 24 * 3600.0
FETCH_MAX_AGE_S = 3600.0  # fragments chords-fetch left that no job took (the API died meanwhile)

STATUS_BY_CODE: dict[str, int] = {
    "invalid_url": 400,
    "download_failed": 502,
    "unsupported_format": 415,
    "too_long": 422,
    "too_large": 413,
    "analysis_failed": 500,
    "not_found": 404,
    "internal": 500,
    "unauthorized": 401,
    "quota_exceeded": 429,
    "download_blocked": 502,
    "unavailable": 501,
    # admin (docs/features/admin)
    "cloud_restricted": 403,
    "analyses_paused": 503,
    "youtube_disabled": 503,
    "vocals_disabled": 503,
    "query_too_short": 422,
    "invalid_period": 422,
    "invalid_value": 422,
    "confirm_email_mismatch": 422,
    "reauth_required": 401,
    "self_target": 409,
    "deletion_pending": 409,
    "not_scheduled": 409,
    "not_set": 409,
    "deletion_rate_limit": 429,
    "not_applied": 503,
    "audit_unavailable": 503,
}


class ApiException(Exception):
    def __init__(self, code: ErrorCode, detail: str, status: Optional[int] = None) -> None:
        super().__init__(detail)
        self.code: ErrorCode = code
        self.detail = detail
        self.status = status or STATUS_BY_CODE.get(code, 500)


def error_response(
    status: int,
    code: ErrorCode,
    detail: str,
    headers: Optional[dict[str, str]] = None,
    details: Optional[dict[str, Any]] = None,
) -> JSONResponse:
    body: dict[str, Any] = {"detail": detail, "code": code}
    if details is not None:
        body["details"] = details
    return JSONResponse(body, status_code=status, headers=headers)


def _is_admin_path(path: str) -> bool:
    return path == ADMIN_PREFIX or path.startswith(ADMIN_PREFIX + "/")


def _unknown_endpoint(path: str) -> str:
    """The detail of the 404 for an address no route serves; also what a non-admin gets from /api/admin/*."""
    return f"Unknown API endpoint: {path}"


def _validation_fields(errors: list[Any]) -> dict[str, str]:
    """Field name (as in the request) -> first problem. A model-level error names no field: it is keyed ``_form``."""
    fields: dict[str, str] = {}
    for err in errors:
        loc = [str(p) for p in err.get("loc", ())]
        if loc and loc[0] in ("body", "query", "path", "header", "cookie"):
            loc = loc[1:]
        fields.setdefault(".".join(loc) or "_form", str(err.get("msg", "invalid value")))
    return fields


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

    Cloud mode (``cloud=True``): the host patterns (``*.run.app``) don't make an origin trusted - only the
    listed origins, local pages and same-origin requests (e.g. /api/docs) pass the cross-site check.
    """

    def __init__(
        self,
        app: ASGIApp,
        allowed_hosts: tuple[str, ...],
        allowed_origins: tuple[str, ...] = (),
        cloud: bool = False,
    ) -> None:
        self.app = app
        self.allowed = allowed_hosts
        self.origins = frozenset(normalize_origin(o) for o in allowed_origins)
        self.cloud = cloud

    def origin_allowed(self, origin: str, host: str = "") -> bool:
        if not origin or origin == "null":
            return False
        if normalize_origin(origin) in self.origins:
            return True
        origin_host = _split_host(origin.split("://", 1)[-1].split("/", 1)[0])
        if self.cloud:
            return bool(re.fullmatch(LOCAL_ORIGIN_REGEX, origin.lower())) or (
                bool(origin_host) and origin_host.lower() == host.lower()
            )
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
            and not self.origin_allowed(origin, host)
        ):
            await error_response(403, "internal", "Cross-site requests are not allowed")(scope, receive, send)
            return
        await self.app(scope, receive, send)


# Pages served from a local host on any port (Vite dev / preview) may read API responses (CORS).
LOCAL_ORIGIN_REGEX = r"https?://(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)(:\d+)?"


# --------------------------------------------------------------------------- start-up background work


class BackgroundStart:
    """Starts the cloud start-up background work (``work``: the chord-model preload, the bucket and publish sweeps, the
    first-wake sweep) once per app, after the first response of a new instance has been sent: a cold instance answers
    its first request without that work competing for the CPU, the GIL and the cold disk (docs/features/admin T65).

    ``arm`` (the lifespan's start-up) makes ``start`` effective and calls it anyway after ``BACKGROUND_START_QUIET_S``
    when no response triggers it first; ``stop`` (shutdown) makes any later ``start`` - the timer's or a response's -
    do nothing. Never armed (local mode): nothing ever starts."""

    def __init__(self, work: Callable[[], None]) -> None:
        self._work = work
        self._lock = threading.Lock()
        self._state = "idle"  # idle -> armed -> started; stopped from any of them
        self._timer: Optional[threading.Timer] = None

    def arm(self) -> None:
        with self._lock:
            if self._state != "idle":
                return
            self._state = "armed"
            self._timer = threading.Timer(BACKGROUND_START_QUIET_S, self.start)
            self._timer.name, self._timer.daemon = "chords-background-start", True
            self._timer.start()

    def start(self) -> None:
        with self._lock:
            if self._state != "armed":
                return
            self._state = "started"
            if self._timer is not None:
                self._timer.cancel()
        try:
            self._work()
        except Exception:  # pragma: no cover - called after a response was sent: nothing may surface there
            log.warning("the start-up background work did not start", exc_info=True)

    def stop(self) -> None:
        with self._lock:
            self._state = "stopped"
            if self._timer is not None:
                self._timer.cancel()


class AfterFirstResponseMiddleware:
    """Calls ``start`` once the first response of the app has been sent in full (its last body part handed to the
    server), then is a plain pass-through. A CORS preflight does not count: the request it asked about follows at once
    and is the one to answer first. Pure ASGI on purpose - BaseHTTPMiddleware would cost every request and runs
    before the body is sent."""

    def __init__(self, app: ASGIApp, start: Callable[[], None]) -> None:
        self.app = app
        self.start = start
        self.fired = False

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if self.fired or scope["type"] != "http" or scope.get("method") == "OPTIONS":
            await self.app(scope, receive, send)
            return

        async def send_then_start(message: Message) -> None:
            await send(message)
            if message["type"] == "http.response.pathsend" or (
                message["type"] == "http.response.body" and not message.get("more_body", False)
            ):
                self.fired = True
                self.start()

        await self.app(scope, receive, send_then_start)


# --------------------------------------------------------------------------- app factory


def create_app(
    settings: Optional[Settings] = None,
    *,
    analyzer: Optional[Analyzer] = None,
    fetcher: Optional[UrlFetcher] = None,
    clip_fetcher: Optional[ClipFetcher] = None,
    engine_info_fn: Optional[Callable[[], dict]] = None,
    token_verifier: Any = None,
    gcs_client_factory: Optional[Callable[[], Any]] = None,
    vocal_transcriber: Optional[Callable[..., dict]] = None,
    publisher_factory: Optional[Callable[[TrackStore], Any]] = None,
    admin_db: Any = None,
    admin_authz: Optional[AdminAuthz] = None,
    admin_router: Optional[APIRouter] = None,
    sweeper: Any = _UNSET,
    scheduler_verifier: Any = _UNSET,
    wake_sweep: Optional[bool] = None,
) -> FastAPI:
    """``token_verifier`` (``.verify(token) -> uid``) and ``gcs_client_factory`` replace the Firebase token
    check and the google-cloud-storage client (tests); ``vocal_transcriber`` replaces app.vocals.transcribe;
    ``publisher_factory(store)`` replaces the ``Publisher`` that publishes track changes in cloud mode
    (tests; ``CHORDS_PUBLISH`` off still wins). ``admin_db`` (``.get(path)``; default ``FirestoreIndex`` in cloud
    mode) holds the admin allowlist, ``admin_authz`` replaces the allowlist check and probe limiter built from it,
    ``admin_router`` replaces ``app.admin.router.router`` (tests). ``sweeper`` (default: built on ``admin_db``;
    None = no sweep endpoint) runs ``POST /api/internal/sweep``, which only ``scheduler_verifier`` (``.verify(token)``;
    default: from ``CHORDS_SCHEDULER_*``; None = nobody) may call. ``wake_sweep`` runs the first-wake sweep of the
    UTC day with the rest of the start-up background work, after the first response (``BackgroundStart``; default: on
    Cloud Run, i.e. when ``K_SERVICE`` is set). ``clip_fetcher`` replaces the YouTube fragment downloader (tests; see
    ``_clip_fetcher``)."""
    settings = settings or Settings.from_env()
    ensure_tool_path()
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    signer: Optional[MediaSigner] = None
    if settings.cloud:
        if settings.signing_key:
            signer = MediaSigner(settings.signing_key, ttl_s=settings.media_url_ttl_s)
        else:
            log.warning("CHORDS_SIGNING_KEY is not set: media links stop working when the server restarts")
            signer = MediaSigner.random(ttl_s=settings.media_url_ttl_s)
    store = TrackStore(settings, signer=signer)
    if admin_db is None and settings.cloud:
        admin_db = FirestoreIndex(settings.firebase_project)
    # one instance per app of what the job history and the sweep share (docs/features/admin): the projections buffer
    # file (admin/projections-pending.json) is filled by JobManager and replayed by the sweep through the same
    # ``Projections``; the email index the admin routes search is the one the sweep rebuilds. None without a database.
    projections = Projections(admin_db, pending_path(settings.data_dir)) if admin_db is not None else None
    admin_directory = Directory(admin_db) if admin_db is not None else None
    # the settings cache the admin routes edit and the admission gate reads (ADR-0008): one per app, falling back to
    # this app's own ``Settings`` while ``adminConfig/settings`` does not exist
    admin_settings = RuntimeSettings(admin_db, env=lambda: settings) if admin_db is not None else None
    admission = Admission(admin_db, admin_settings) if admin_settings is not None else None
    # whether a uid's account was purged (``adminTombstones/<uid>``, ADR-0011): the job results and the publish path check it
    is_tombstoned: Optional[Callable[[str], bool]] = (
        (lambda uid: admin_db.get(f"adminTombstones/{uid}") is not None) if admin_db is not None else None
    )
    bucket = (
        UploadBucket(settings.upload_bucket, project=settings.firebase_project, client_factory=gcs_client_factory)
        if settings.cloud and settings.upload_bucket
        else None
    )
    # the fetchers' deploy-time byte cap is a fallback only: every job passes the size limit in force (the admin-set
    # one on the cloud, AC-25) with its download, so a change applies without a restart
    jobs = JobManager(
        settings,
        store,
        fetcher or YtDlpFetcher(settings.max_upload_bytes),
        analyzer,
        vocal_transcriber=vocal_transcriber,
        clip_fetcher=clip_fetcher or _clip_fetcher(settings, bucket),
        # admin job history and the late-job discard of purged accounts (docs/features/admin): none without a database
        projections=projections,
        is_tombstoned=is_tombstoned,
        admission=admission,
    )
    get_engine_info = engine_info_fn or engine_info
    if not (settings.cloud and settings.publish):
        publisher: Any = NullPublisher()
    elif publisher_factory:
        publisher = publisher_factory(store)
    elif settings.upload_bucket:
        publisher = Publisher(
            store,
            FirestoreIndex(settings.firebase_project),
            bucket=settings.upload_bucket,
            gcs_client_factory=gcs_client_factory or (lambda: default_client(settings.firebase_project)),
            is_tombstoned=is_tombstoned,
        )
    else:
        # Not a mere warning: clients that read the index keep reading it, so nothing new or changed would show
        # anywhere (docs/CLOUD.md "Library in Firestore" → turning publishing off)
        log.error("CHORDS_UPLOAD_BUCKET is not set: track changes are not published")
        publisher = NullPublisher()
    store.publisher = publisher
    stop_background = threading.Event()  # set at shutdown: ends the sweep threads

    def start_background_work() -> None:
        _start_cloud_background_tasks(
            preload_engine=analyzer is None,
            bucket=bucket,
            work_dir=settings.work_dir,
            publisher=None if isinstance(publisher, NullPublisher) else publisher,
            stop=stop_background,
        )
        if sweeper is not None and wake_sweep_on:  # the first natural wake of the UTC day runs the -wake slot
            threading.Thread(target=sweeper.run_wake, name="chords-wake-sweep", daemon=True).start()

    # cloud only: after the first response (AfterFirstResponseMiddleware below) or a quiet period, whichever is first
    background = BackgroundStart(start_background_work)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        store.init()
        log.info("data dir: %s (auth: %s)", settings.data_dir, settings.auth)
        if settings.cloud:
            cap_warning = instance_cap_warning()
            if cap_warning:
                log.warning(cap_warning)
            background.arm()
        try:
            yield
        finally:
            background.stop()  # a quiet-period timer that has not fired yet starts nothing
            stop_background.set()
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
    app.state.bucket = bucket
    app.state.publisher = publisher
    app.state.admin_db = admin_db
    app.state.admin_authz = admin_authz or AdminAuthz(admin_db)
    app.state.admin_directory = admin_directory  # the admin router's ``directory`` (app.admin.router)
    app.state.admin_settings = admin_settings  # ... and its ``settings`` (None: built on first use)
    app.state.admission = admission  # None without a database: no gate (local mode)
    if sweeper is _UNSET:
        sweeper = None
        if admin_db is not None:
            # the purges step of the sweep (ADR-0011): the same database and e-mail index as the admin routes
            erase_objects = None
            if settings.upload_bucket:
                eraser = BucketEraser(
                    settings.upload_bucket, gcs_client_factory or (lambda: default_client(settings.firebase_project))
                )
                erase_objects = eraser.erase
            purger = Purger(
                admin_db, directory=admin_directory, users_dir=settings.users_dir,
                auth=AuthAdmin(settings.firebase_project), erase_objects=erase_objects,
            )
            sweeper = Sweeper(admin_db, projections, admin_directory, purge=purger.run)
    app.state.sweeper = sweeper
    if scheduler_verifier is _UNSET:
        scheduler_verifier = _scheduler_verifier_from_env() if settings.cloud else None
    wake_sweep_on = settings.cloud and (bool(os.environ.get("K_SERVICE")) if wake_sweep is None else wake_sweep)

    if settings.cloud:  # innermost: CORS (below) also decorates its 401 responses
        app.add_middleware(
            AuthMiddleware,
            verifier=token_verifier or FirebaseTokenVerifier(settings.firebase_project),
            signer=signer,
            smoke_key=settings.smoke_key,
            scheduler_verifier=scheduler_verifier,
        )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_origin_regex=LOCAL_ORIGIN_REGEX,
        # Private Network Access: an https page (GitHub Pages) calling http://localhost gets a preflight
        # with "Access-Control-Request-Private-Network: true"; allowed origins get "...-Allow-Private-Network".
        allow_private_network=True,
        # Cloud API calls carry an Authorization header, so every request is preflighted; let browsers
        # cache the preflight instead of repeating it on each job poll.
        max_age=600,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
    )
    app.add_middleware(
        LocalOnlyMiddleware,
        allowed_hosts=settings.allowed_hosts,
        allowed_origins=settings.allowed_origins,
        cloud=settings.cloud,
    )
    if settings.cloud:  # outermost: it sees the response that actually leaves (host guard and CORS included)
        app.add_middleware(AfterFirstResponseMiddleware, start=background.start)

    _install_error_handlers(app)
    admin = admin_router or admin_router_default
    api = _api_router(settings, store, jobs, get_engine_info, bucket)
    unguarded = unguarded_admin_routes(admin, api)  # a new admin route without the guard stops the start-up
    if unguarded:
        raise RuntimeError("admin routes without the admin guard (use new_admin_router): " + "; ".join(unguarded))
    app.include_router(admin)  # before the API router: its catch-all would shadow it
    app.include_router(internal_router)  # POST /api/internal/sweep: AuthMiddleware lets only the scheduler through
    app.include_router(api)
    _install_frontend(app, settings)
    return app


def _clip_fetcher(settings: Settings, bucket: Optional[UploadBucket]) -> Optional[ClipFetcher]:
    """Who downloads YouTube fragments: chords-fetch when CHORDS_FETCH_URL is set (it hands files over through the
    bucket); yt-dlp in this process on a local server; nobody on a cloud server without chords-fetch - YouTube
    refuses Google Cloud addresses, so the API never tries itself (501, the client listens in the tab)."""
    if settings.fetch_url:
        if bucket is None:
            log.error("CHORDS_FETCH_URL is set but CHORDS_UPLOAD_BUCKET is not: YouTube fragments are off")
            return None
        return RemoteClipFetcher(settings.fetch_url, bucket, max_bytes=settings.max_upload_bytes)
    if settings.cloud:
        return None
    return LocalClipFetcher(YtDlpFetcher(settings.max_upload_bytes))


def _warm_analysis(work_dir: Path) -> None:
    """Analyze 8 s of synthetic chords once, so every import, model and numba kernel is ready before the
    first real job (the kernels come from the image's cache when the CPU target matches)."""
    import numpy as np
    import soundfile as sf

    from app.engine import analyze

    sr = 44100
    t = np.arange(sr * 2) / sr
    chords = [(261.63, 329.63, 392.0), (220.0, 261.63, 329.63), (174.61, 220.0, 261.63), (196.0, 246.94, 293.66)]
    y = np.concatenate([sum(np.sin(2 * np.pi * f * t) * np.exp(-1.2 * t) for f in c) for c in chords]) * 0.25
    work_dir.mkdir(parents=True, exist_ok=True)
    path = work_dir / "engine-warmup.wav"  # one preload per process; scratch is wiped at start-up
    try:
        sf.write(path, y.astype(np.float32), sr)
        analyze(str(path))
    finally:
        path.unlink(missing_ok=True)


def _start_cloud_background_tasks(
    *,
    preload_engine: bool,
    bucket: Optional[UploadBucket],
    work_dir: Path,
    publisher: Any,
    stop: threading.Event,
) -> None:
    """The cloud start-up background work, started by ``BackgroundStart`` once the first response of the instance has
    been sent: load the chord models (and run one tiny analysis) before the first job comes, remove uploads abandoned
    by clients (older than a day) and fragments that chords-fetch left (older than an hour), and retry the publishes
    that failed earlier (``publisher``, unless None: now, then every ``PUBLISH_SWEEP_INTERVAL_S`` until ``stop`` is
    set)."""

    def preload() -> None:
        try:
            from app.engine import neural

            started = time.monotonic()
            if neural.available():
                neural.ensure_loaded()
            log.info("engine models preloaded in %.1fs", time.monotonic() - started)
            _warm_analysis(work_dir)
            log.info("engine warm in %.1fs", time.monotonic() - started)
        except Exception:  # pragma: no cover - the first job loads them anyway
            log.warning("engine preload failed", exc_info=True)

    def sweep() -> None:
        """Abandoned client uploads (a day old) and fragments chords-fetch left behind (an hour old), hourly."""
        assert bucket is not None
        while True:
            for glob, max_age in ((UPLOADS_GLOB, UPLOAD_MAX_AGE_S), (FETCH_GLOB, FETCH_MAX_AGE_S)):
                try:
                    bucket.sweep(max_age_s=max_age, glob=glob)
                except Exception as exc:  # pragma: no cover - best effort
                    log.warning("stale object sweep (%s) failed: %s", glob, exc)
            if stop.wait(BUCKET_SWEEP_INTERVAL_S):  # the app's shutdown ends the loop
                return

    def sweep_publishes() -> None:
        while True:
            try:
                publisher.sweep_pending()
            except Exception:  # sweep_pending does not raise; the loop must outlive a surprise all the same
                log.warning("pending publish sweep failed", exc_info=True)
            if stop.wait(PUBLISH_SWEEP_INTERVAL_S):  # not time.sleep: the app's shutdown ends the wait
                return

    if preload_engine:
        threading.Thread(target=preload, name="chords-preload", daemon=True).start()
    if bucket is not None:
        threading.Thread(target=sweep, name="chords-upload-sweep", daemon=True).start()
    if publisher is not None:
        threading.Thread(target=sweep_publishes, name="chords-publish-sweep", daemon=True).start()


def _install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiException)
    async def _api_exc(_: Request, exc: ApiException) -> JSONResponse:
        return error_response(exc.status, exc.code, exc.detail)

    @app.exception_handler(SourceError)
    async def _source_exc(_: Request, exc: SourceError) -> JSONResponse:
        return error_response(exc.status or STATUS_BY_CODE.get(exc.code, 500), exc.code, exc.message)

    @app.exception_handler(HiddenFromCaller)
    async def _admin_hidden(_: Request, exc: HiddenFromCaller) -> JSONResponse:
        return error_response(404, "not_found", _unknown_endpoint(exc.path))

    @app.exception_handler(ReauthRequired)
    async def _admin_reauth(_: Request, exc: ReauthRequired) -> JSONResponse:
        return error_response(401, "reauth_required", str(exc))

    @app.exception_handler(AuditFailure)
    async def _admin_audit(_: Request, exc: AuditFailure) -> JSONResponse:
        return error_response(exc.status, exc.code, str(exc))

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
        if _is_admin_path(request.url.path):
            return error_response(
                422, "invalid_value", f"Invalid request - {message}", details={"fields": _validation_fields(errors)}
            )
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


def _cloud_too_large(settings: Settings) -> str:
    return (
        f"Files over {settings.max_request_mb:g} MB can't be sent in one request to the cloud server - "
        "upload them to cloud storage and use POST /api/jobs/storage"
    )


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


_UPLOAD_SEGMENT_RE = re.compile(r"^[^/\\\x00-\x1f\x7f]{1,255}$")


def _upload_path(raw: str, prefix: str) -> str:
    """Validate a client upload path: ``users/<uid>/uploads/<...>/<filename>`` of the caller."""
    path = raw.strip()
    if not path.startswith(prefix):
        raise ApiException("unauthorized", f"The upload path must start with {prefix}", status=403)
    rest = path[len(prefix):].split("/")
    if not rest or any(seg in ("", ".", "..") or not _UPLOAD_SEGMENT_RE.fullmatch(seg) for seg in rest):
        raise ApiException("not_found", "Invalid upload path")
    return path


def _api_router(
    settings: Settings,
    store: TrackStore,
    jobs: JobManager,
    get_engine_info: Callable[[], dict],
    bucket: Optional[UploadBucket] = None,
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
        info.features["vocals"] = jobs.vocals_available()
        has_ffmpeg = ffmpeg_available()
        return Health(ok=ok and has_ffmpeg, engine=info, ytdlp=ytdlp_version(), ffmpeg=has_ffmpeg)

    # ------------------------------------------------------------------ jobs

    @api.post(
        "/jobs",
        response_model=Job,
        status_code=201,
        responses={501: {"description": "A clip, and this server can't download YouTube fragments (code unavailable)"}},
    )
    def create_job(body: CreateJobRequest) -> Job:
        url = normalize_url(body.url)
        return jobs.submit_url(url, _options(body.options), clip_start=body.clip.start if body.clip else None)

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
        """Multipart upload streamed straight to disk; deduplicated by content sha1. Cloud mode caps the
        body at ~30 MB (Cloud Run allows 32 MiB per request): bigger files go through POST /jobs/storage."""
        limits = jobs.effective_limits()
        limit = min(limits.upload_bytes, settings.max_request_bytes) if settings.cloud else limits.upload_bytes
        work = store.new_work_dir("upload")
        try:
            try:
                upload = await receive_upload(request, work, limit)
            except SourceError as exc:
                if settings.cloud and exc.code == "too_large":
                    raise SourceError("too_large", _cloud_too_large(settings)) from exc
                raise
            probe = await run_in_threadpool(probe_media, upload.path)
            if not probe.has_audio:
                raise SourceError("unsupported_format", "This file has no audio track")
            if probe.duration and probe.duration > limits.duration_s:
                raise SourceError("too_long", too_long_message(probe.duration, limits.duration_min))
        except BaseException:
            shutil.rmtree(work, ignore_errors=True)
            raise
        return await run_in_threadpool(jobs.submit_upload, upload, probe, _options(upload.options), upload.origin)

    @api.post(
        "/jobs/storage",
        response_model=Job,
        status_code=201,
        responses={501: {"description": "Not a cloud server (code unavailable)"}},
    )
    def storage_job(body: StorageJobRequest) -> Job:
        """Cloud mode: analyze a file the client uploaded to ``users/<uid>/uploads/...`` in the upload bucket
        (big files, tab recordings). The object is deleted once read."""
        if bucket is None:
            raise ApiException("unavailable", "Cloud storage uploads are not enabled on this server")
        path = _upload_path(body.path, store.upload_prefix())
        info = bucket.stat(path)
        if info is None:
            raise ApiException("not_found", "The upload was not found (it may have been processed already)")
        limits = jobs.effective_limits()
        if info.size > limits.upload_bytes:
            bucket.delete(path)
            raise ApiException("too_large", f"The file is larger than the {limits.upload_mb:g} MB limit")
        if info.size == 0:
            bucket.delete(path)
            raise ApiException("unsupported_format", "The uploaded file is empty")
        video_id = None
        if body.source is not None and body.source.type == "youtube":
            video_id = body.source.video_id
            if not video_id and body.source.url:
                video_id = normalize_url(body.source.url).youtube_id
            if not video_id:
                raise ApiException("invalid_url", "source.videoId is required for a YouTube recording")
        return jobs.submit_storage(
            path,
            bucket,
            size=info.size,
            title=body.title,
            video_id=video_id,
            start_offset=float(body.start_offset or 0.0),
            options=_options(body.options),
            origin=body.origin,
        )

    @api.get("/me", response_model=UserInfo)
    def me() -> UserInfo:
        """The signed-in user (cloud mode) and their quotas for today (UTC)."""
        uid = current_uid()
        if not settings.cloud or not uid:
            return UserInfo(uid=None, cloud=settings.cloud, quotas=None)
        usage = jobs.quotas.usage(uid)
        return UserInfo.model_validate(
            {
                "uid": uid,
                "cloud": True,
                "quotas": {
                    "day": usage["day"],
                    "analyses": usage["analyses"],
                    "vocals": usage["vocals"],
                    "jobs": {"used": jobs.running_count(uid), "limit": usage["jobs"]["limit"]},
                },
            }
        )

    @api.get("/jobs", response_model=list[Job])
    def list_jobs() -> list[Job]:
        return jobs.list()

    @api.get("/jobs/{job_id}", response_model=Job)
    def get_job(job_id: str) -> Job:
        job = jobs.get(job_id)
        if job is None:
            raise _not_found("Job")
        return job

    @api.post("/jobs/{job_id}/cancel", response_model=Job)
    def cancel_job(job_id: str) -> Job:
        """Cancel a running job: it ends with ``errorCode: "cancelled"`` at its next progress report (a finished
        job is returned unchanged). A cancelled vocal transcription gives its daily quota unit back."""
        job = jobs.cancel(job_id)
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

    # ------------------------------------------------------------------ vocal melody + stems (optional extra)

    @api.post(
        "/tracks/{track_id}/vocals",
        response_model=Job,
        status_code=201,
        responses={501: {"description": "Vocal transcription is not installed on this server (code unavailable)"}},
    )
    def transcribe_vocals(track_id: str, body: Annotated[Optional[VocalsRequest], Body()] = None) -> Job:
        """Separate the vocals (Demucs) and transcribe the sung melody: a job with ``kind: "vocals"``. It is
        done at once when the track already has them, unless ``{"force": true}``."""
        force = bool(body and body.force)
        if not store.exists(track_id):
            raise _not_found()
        if (force or not store.has_vocals(track_id)) and not jobs.vocals_available():
            raise ApiException("unavailable", "Vocal transcription is not installed on this server")
        return jobs.submit_vocals(track_id, force=force)

    @api.get(
        "/tracks/{track_id}/vocals",
        response_model=VocalNotes,
        responses={404: {"description": "Unknown track, or its vocals were not transcribed yet (code not_found)"}},
    )
    def get_vocals(track_id: str) -> Response:
        raw = store.read_vocals(track_id)  # unknown track -> 404 not_found
        if raw is None:
            raise ApiException("not_found", "The vocals were not transcribed for this track yet")
        return Response(content=raw, media_type="application/json", headers={"Cache-Control": "no-cache"})

    @api.api_route("/tracks/{track_id}/stems/{name}", methods=["GET", "HEAD"], response_class=FileResponse)
    def track_stem(track_id: str, name: str) -> FileResponse:
        """A separated stem (``vocals`` or ``instruments`` = bass + other) as mp3, with HTTP Range support."""
        try:
            path = store.stem_path(track_id, name)
        except TrackNotFound:
            raise ApiException("not_found", f"No {name!r} stem for this track") from None
        return FileResponse(
            path,
            media_type="audio/mpeg",
            headers={"Cache-Control": "private, no-cache", "Accept-Ranges": "bytes"},  # may be recomputed
        )

    @api.api_route("/{rest:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
    def api_not_found(rest: str) -> Response:
        raise ApiException("not_found", _unknown_endpoint(f"/api/{rest}"))

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

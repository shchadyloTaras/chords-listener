"""``/api/admin/*``: the router the admin handlers are added to (docs/features/admin).

Handlers are added with ``@router.get(...)`` etc. on the router from ``new_admin_router()``; every route of
it uses ``AdminRoute`` (admins only, 404-identical denial for everyone else, ``admin_request`` logging).
The routes stay out of the OpenAPI document that ``/api/openapi.json`` serves without sign-in, so the public
schema doesn't tell anyone which admin actions exist (AC-31).

Served here: ``getOverview`` (AC-01: today's UTC totals, the jobs running now, the switch states) and
``getSettings`` (default limits, switches, banner). Neither is journaled and nothing polls: the UI decides when to
ask again (AC-02).
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping, Optional

from fastapi import APIRouter, Request

from app.firestore import FirestoreIndex

from . import stats
from .authz import ADMIN_PREFIX, AdminRoute
from .directory import Directory
from .history import REASONS
from .models import Origin, Overview, OriginCounts, RunningJob, Settings
from .settings import RuntimeSettings

log = logging.getLogger("chords.admin")


def new_admin_router() -> APIRouter:
    return APIRouter(prefix=ADMIN_PREFIX, route_class=AdminRoute, include_in_schema=False)


router = new_admin_router()


def utc_now() -> datetime:
    """"Now" for the stats day (UTC). Module-level so tests can pin the clock."""
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- shared per-app objects

_state_lock = threading.Lock()


def database(request: Request) -> FirestoreIndex:
    db = getattr(request.app.state, "admin_db", None)
    if db is None:
        raise RuntimeError("the admin area has no database on this server")  # unreachable: nobody is admitted without one
    return db


def _shared(request: Request, name: str, build: Callable[[FirestoreIndex], Any]) -> Any:
    """``app.state.<name>``, built from the admin database on first use (a test may put its own there)."""
    state = request.app.state
    value = getattr(state, name, None)
    if value is None:
        db = database(request)
        with _state_lock:
            value = getattr(state, name, None)
            if value is None:
                value = build(db)
                setattr(state, name, value)
    return value


def runtime_settings(request: Request) -> RuntimeSettings:
    return _shared(request, "admin_settings", RuntimeSettings)


def directory(request: Request) -> Directory:
    return _shared(request, "admin_directory", Directory)


# --------------------------------------------------------------------------- overview


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _origin_of(rec: Any) -> Origin:
    """The origin of a job: the one the client hinted when it has been recorded, else from the source (a link or a
    YouTube address is ``link``; an uploaded file is ``file``)."""
    hinted = getattr(rec, "origin", None)
    if hinted in stats.ORIGINS:
        return hinted
    return "link" if (rec.source or {}).get("type") in ("youtube", "url") else "file"


def _email_of(people: Directory, uid: str) -> Optional[str]:
    try:
        return people.email_of(uid)
    except Exception:  # noqa: BLE001 - an email we can't look up must not hide the running jobs
        log.warning("overview: the email of %s could not be looked up", uid, exc_info=True)
        return None


def _running_jobs(request: Request) -> list[RunningJob]:
    people = directory(request)
    emails: dict[str, Optional[str]] = {}
    out = []
    for rec in request.app.state.jobs.running_records():
        if not rec.uid:  # local mode has no accounts (and no admin area)
            continue
        if rec.uid not in emails:
            emails[rec.uid] = _email_of(people, rec.uid)
        out.append(RunningJob(
            id=rec.id,
            uid=rec.uid,
            email=emails[rec.uid],
            service=stats.is_service(rec.uid),
            kind="vocals" if rec.kind == "vocals" else "analysis",
            origin=_origin_of(rec),
            accepted_at=datetime.fromtimestamp(rec.created_ts, timezone.utc),
        ))
    return out


def _new_users(db: FirestoreIndex, day: str, stored: Mapping[str, Any]) -> int:
    """Registrations of the day: the stored total once the day is closed, else a server-side ``count()``."""
    if isinstance(stored.get("newUsers"), int):
        return _count(stored["newUsers"])
    start = stats.day_start(day)
    return db.count("users", filters=[("createdAt", ">=", start), ("createdAt", "<", start + timedelta(days=1))])


@router.get("/overview", response_model=Overview)
def get_overview(request: Request) -> Overview:
    db = database(request)
    now = utc_now()
    day = stats.utc_day(now)
    doc = db.get(stats.day_path(day))
    stored: Mapping[str, Any] = doc.data if doc is not None else stats.empty_day(now)
    by_origin = stored.get("analyses") if isinstance(stored.get("analyses"), dict) else {}
    by_reason = stored.get("failedByReason") if isinstance(stored.get("failedByReason"), dict) else {}
    return Overview(
        day=day,
        analyses=OriginCounts(**{origin: _count(by_origin.get(origin)) for origin in stats.ORIGINS}),
        vocals=_count(stored.get("vocals")),
        failed=_count(stored.get("failed")),
        failed_by_reason={r: _count(by_reason[r]) for r in REASONS if _count(by_reason.get(r))},
        active=_count(stored.get("active")),
        new_users=_new_users(db, day, stored),
        running_jobs=_running_jobs(request),
        switches=runtime_settings(request).current().switches,
    )


# --------------------------------------------------------------------------- settings


@router.get("/settings", response_model=Settings)
def get_settings(request: Request) -> Settings:
    return runtime_settings(request).current()

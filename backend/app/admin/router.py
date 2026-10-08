"""``/api/admin/*``: the router the admin handlers are added to (docs/features/admin).

Handlers are added with ``@router.get(...)`` etc. on the router from ``new_admin_router()``; every route of
it uses ``AdminRoute`` (admins only, 404-identical denial for everyone else, ``admin_request`` logging).
The routes stay out of the OpenAPI document that ``/api/openapi.json`` serves without sign-in, so the public
schema doesn't tell anyone which admin actions exist (AC-31).

Served here:

* ``getOverview`` (AC-01: today's UTC totals, the jobs running now, the switch states) and ``getSettings`` (default
  limits, switches, banner). Neither is journaled and nothing polls: the UI decides when to ask again (AC-02).
* ``searchUsers``, ``getUserCard`` and ``listUserTracks`` (US-02, US-03). A search and a card view are journaled
  BEFORE the response is built, and a journal that cannot be written withholds the data (AC-33b); the songs of a
  user are metadata only, never audio, chords or edits (AC-06).
"""
from __future__ import annotations

import base64
import json
import logging
import re
import threading
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Mapping, NoReturn, Optional

from fastapi import APIRouter, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError

from app.firestore import Document, FirestoreIndex
from app.users import valid_uid

from . import models, stats
from .audit import Audit, AuditEntry
from .authz import ADMIN_PREFIX, AdminRoute, current_admin_uid
from .directory import MAX_RESULTS, USERS, Directory, parse_time
from .history import JOBS, REASONS
from .identity import AuthLookup
from .models import (
    MAX_EMAIL_CHARS,
    MIN_SEARCH_CHARS,
    PAGE_SIZE,
    AccountState,
    Deletion,
    JobHistoryItem,
    Origin,
    OriginCounts,
    Overview,
    PersonalLimit,
    QuotaUsage,
    Restriction,
    RunningJob,
    Settings,
    TrackMeta,
    TrackMetaPage,
    UserCard,
    UserProfile,
    UserQuotas,
    UserSearchItem,
    UserSearchResult,
)
from .settings import RuntimeSettings

log = logging.getLogger("chords.admin")

TOMBSTONES = "adminTombstones"
RECENT_JOBS = 20   # jobs on the user card


def new_admin_router() -> APIRouter:
    return APIRouter(prefix=ADMIN_PREFIX, route_class=AdminRoute, include_in_schema=False)


router = new_admin_router()


def utc_now() -> datetime:
    """"Now" for the stats day (UTC). Module-level so tests can pin the clock."""
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- shared per-app objects

_state_lock = threading.RLock()   # re-entrant: building the services builds the directory and settings it holds


def _admin_db(app: FastAPI) -> FirestoreIndex:
    db = getattr(app.state, "admin_db", None)
    if db is None:
        raise RuntimeError("the admin area has no database on this server")  # unreachable: nobody is admitted without one
    return db


def database(request: Request) -> FirestoreIndex:
    return _admin_db(request.app)


def _shared(app: FastAPI, name: str, build: Callable[[FirestoreIndex], Any]) -> Any:
    """``app.state.<name>``, built from the admin database on first use (a test may put its own there)."""
    state = app.state
    value = getattr(state, name, None)
    if value is None:
        db = _admin_db(app)
        with _state_lock:
            value = getattr(state, name, None)
            if value is None:
                value = build(db)
                setattr(state, name, value)
    return value


@dataclass
class AdminServices:
    """What the admin handlers share, built once per app from ``app.state.admin_db`` (``get_services``). Its
    ``directory`` and ``settings`` are the app's one email-index cache and one settings cache
    (``app.state.admin_directory`` / ``app.state.admin_settings``, which the background sweep shares). Tests replace a
    field (or the whole object in ``app.state.admin_services``) to fake the one thing they cannot run for real."""

    db: Any
    audit: Audit
    directory: Directory
    settings: RuntimeSettings
    last_login: Callable[[str], Optional[datetime]]


def get_services(app: FastAPI) -> AdminServices:
    def build(db: FirestoreIndex) -> AdminServices:
        return AdminServices(
            db=db, audit=Audit(db),
            directory=_shared(app, "admin_directory", Directory),
            settings=_shared(app, "admin_settings", RuntimeSettings),
            last_login=AuthLookup(app.state.settings.firebase_project).last_login_at,
        )

    return _shared(app, "admin_services", build)


def runtime_settings(request: Request) -> RuntimeSettings:
    return get_services(request.app).settings


def directory(request: Request) -> Directory:
    return get_services(request.app).directory


# --------------------------------------------------------------------------- shared helpers


def _refuse(code: str, detail: str) -> NoReturn:
    """Answer ``{"detail", "code"}`` with the status of ``code``. ``ApiException`` lives in main.py, which imports this
    module, so it is imported when needed."""
    from app.main import ApiException

    raise ApiException(code, detail)  # type: ignore[arg-type]


def _invalid(field: str, message: str) -> RequestValidationError:
    """A 422 ``invalid_value`` for one query parameter, rendered by the app's validation handler."""
    return RequestValidationError([{"loc": ("query", field), "msg": message, "type": "value_error"}])


def _pack_cursor(fields: Mapping[str, Any]) -> str:
    """An opaque page cursor: the sort key and id of the last item of a page, base64url-encoded JSON."""
    raw = json.dumps(dict(fields), separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unpack_cursor(cursor: str) -> Any:
    """The JSON inside a cursor; ``ValueError`` when it is not base64url JSON. Its fields are each list's to check."""
    return json.loads(base64.urlsafe_b64decode((cursor + "=" * (-len(cursor) % 4)).encode("ascii")))


_EPOCH = datetime.fromtimestamp(0, timezone.utc)


def _time(value: Any) -> Optional[datetime]:
    try:
        return parse_time(value)
    except ValueError:
        return None


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _email_of(people: Directory, uid: str) -> Optional[str]:
    try:
        return people.email_of(uid)
    except Exception:  # noqa: BLE001 - an email we can't look up must not hide the running jobs
        log.warning("overview: the email of %s could not be looked up", uid, exc_info=True)
        return None


def _registrations(db: FirestoreIndex, day: str) -> int:
    """New users of a UTC day: a server-side ``count()`` of ``users`` by ``createdAt``."""
    start = stats.day_start(day)
    return db.count(USERS, filters=[("createdAt", ">=", start), ("createdAt", "<", start + timedelta(days=1))])


# --------------------------------------------------------------------------- overview


def _origin_of(rec: Any) -> Origin:
    """The origin of a job: the one the client hinted when it has been recorded, else from the source (a link or a
    YouTube address is ``link``; an uploaded file is ``file``)."""
    hinted = getattr(rec, "origin", None)
    if hinted in stats.ORIGINS:
        return hinted
    return "link" if (rec.source or {}).get("type") in ("youtube", "url") else "file"


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
    return _registrations(db, day)


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


# --------------------------------------------------------------------------- users: who is looking, who is looked at


def _admin_email(svc: AdminServices, uid: str) -> str:
    """The signed-in admin's own address for the journal: from their ``users`` document, else the email index. A
    journal record needs one; an admin without any (never expected) is recorded under their uid."""
    doc = svc.db.get(f"{USERS}/{uid}")
    email = doc.data.get("email") if doc is not None else None
    if isinstance(email, str) and email:
        return email
    return svc.directory.email_of(uid) or uid


def _live_user(svc: AdminServices, uid: str) -> Optional[Document]:
    """``users/{uid}``, or None when ``uid`` is not an account user or the account was purged (tombstone)."""
    if not valid_uid(uid):
        return None
    user = svc.db.get(f"{USERS}/{uid}")
    if user is None or svc.db.get(f"{TOMBSTONES}/{uid}") is not None:
        return None
    return user


# --------------------------------------------------------------------------- tracks (metadata only, AC-06)

_CURSOR_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _track_cursor(track: Document) -> str:
    return _pack_cursor({"c": track.data.get("createdAt"), "i": track.id})


def _track_position(cursor: str) -> tuple[str, str]:
    """(createdAt, track id) of the last song of the previous page; a cursor the server did not make is a 422."""
    try:
        data = _unpack_cursor(cursor)
        created, track_id = data["c"], data["i"]
        if set(data) != {"c", "i"} or not isinstance(created, str) or not 0 < len(created) <= 64:
            raise ValueError("shape")
        if not isinstance(track_id, str) or not _CURSOR_ID.fullmatch(track_id):
            raise ValueError("id")
    except Exception as exc:  # noqa: BLE001 - anything unreadable is "not a cursor of ours"
        raise _invalid("after", "Invalid cursor") from exc
    return created, track_id


def _track_meta(doc: Document) -> TrackMeta:
    """The metadata of a ``users/{uid}/tracks`` summary: title, source, date, duration, flags, size. Nothing else of
    the document is copied (no audio, chords, edits, notes or links)."""
    d = doc.data
    title = d.get("title")
    source = d.get("source")
    source_type = source.get("type") if isinstance(source, dict) else None
    duration = d.get("duration")
    size = d.get("sizeBytes")
    return TrackMeta(
        id=doc.id,
        title=title[:300] if isinstance(title, str) else "",
        source_type=source_type if source_type in ("youtube", "url", "file") else "file",
        created_at=_time(d.get("createdAt")) or _EPOCH,
        duration=float(duration) if isinstance(duration, (int, float)) and not isinstance(duration, bool) and duration >= 0 else 0.0,
        edited=d.get("edited") is True,
        vocals=d.get("vocals") is True,
        size_bytes=size if isinstance(size, int) and not isinstance(size, bool) and size >= 0 else None,
    )


def _track_page(svc: AdminServices, uid: str, after: Optional[str], limit: int) -> TrackMetaPage:
    """``limit`` songs newest first, after the song the cursor names. One extra song is read to know whether another
    page follows."""
    start: Optional[Document] = None
    if after:
        created, track_id = _track_position(after)
        start = Document(f"{USERS}/{uid}/tracks/{track_id}", {"createdAt": created})
    docs = svc.db.run_query(f"{USERS}/{uid}/tracks", order_by=["-createdAt"], limit=limit + 1, start_after=start)
    has_next = len(docs) > limit
    docs = docs[:limit]
    return TrackMetaPage(
        items=[_track_meta(d) for d in docs],
        has_next=has_next,
        has_prev=after is not None,
        next_cursor=_track_cursor(docs[-1]) if has_next else None,
    )


# --------------------------------------------------------------------------- account state and quota (AC-15, AC-16)


def _personal_limit(data: Any) -> Optional[PersonalLimit]:
    if not isinstance(data, dict):
        return None
    until = data.get("until")
    until_day = date.fromisoformat(until) if isinstance(until, str) and until else None
    return PersonalLimit(
        analyses=data.get("analyses"), vocals=data.get("vocals"), jobs=data.get("jobs"), until=until_day,
        set_at=_time(data.get("setAt")) or _EPOCH, by_admin_uid=data.get("byAdminUid") or "unknown",
        expired=until_day is not None and until_day < models.today_utc(),   # the last day counts: «завершився» after it
    )


def _restriction(data: Any) -> Optional[Restriction]:
    if not isinstance(data, dict):
        return None
    return Restriction(
        reason=str(data.get("reason") or "-")[:500], since=_time(data.get("since")) or _EPOCH,
        by_admin_uid=data.get("byAdminUid") or "unknown",
    )


def _deletion(data: Any) -> Optional[Deletion]:
    if not isinstance(data, dict):
        return None       # ``priorRestriction`` stays inside (api-sync-report: deliberately not exposed)
    return Deletion(
        scheduled_at=_time(data.get("scheduledAt")) or _EPOCH, purge_after=_time(data.get("purgeAfter")) or _EPOCH,
        by_admin_uid=data.get("byAdminUid") or "unknown",
    )


def _account_state(svc: AdminServices, request: Request, uid: str) -> AccountState:
    doc = svc.db.get(f"adminAccounts/{uid}")
    data = doc.data if doc is not None else {}
    restriction = _restriction(data.get("restriction"))
    deletion = _deletion(data.get("deletion"))
    personal = _personal_limit(data.get("personalLimit"))
    status = "deletion_scheduled" if deletion else "restricted" if restriction else "normal"
    # the limit in force: a personal value (until its last day, inclusive) over the default, field by field (ADR-0008)
    limits = svc.settings.current().limits
    active = personal if personal is not None and not personal.expired else None
    effective = {
        name: (getattr(active, name) if active is not None and getattr(active, name) is not None else getattr(limits, name))
        for name in ("analyses", "vocals", "jobs")
    }
    manager = request.app.state.jobs
    usage = manager.quotas.usage(uid) or {}
    quota = UserQuotas(
        day=usage.get("day") or models.today_utc().isoformat(),
        analyses=QuotaUsage(used=usage.get("analyses", {}).get("used", 0), limit=effective["analyses"]),
        vocals=QuotaUsage(used=usage.get("vocals", {}).get("used", 0), limit=effective["vocals"]),
        jobs=QuotaUsage(used=manager.running_count(uid), limit=effective["jobs"]),
    )
    return AccountState(uid=uid, status=status, restriction=restriction, deletion=deletion, personal_limit=personal, quota=quota)


def _recent_job(doc: Document, uid: str, email: Optional[str]) -> JobHistoryItem:
    d = doc.data
    error_text, title = d.get("errorText"), d.get("title")
    return JobHistoryItem(
        id=doc.id, uid=uid, email=email, user_deleted=False, service=d.get("service") is True or stats.is_service(uid),
        kind=d.get("kind"), origin=d.get("origin"), status=d.get("status"), reason=d.get("reason"),
        error_text=error_text[:200] if isinstance(error_text, str) else None,
        title=title[:300] if isinstance(title, str) else None,
        accepted_at=_time(d.get("acceptedAt")) or _EPOCH, finished_at=_time(d.get("finishedAt")),
    )


def _last_login(svc: AdminServices, uid: str) -> Optional[datetime]:
    try:
        return svc.last_login(uid)
    except Exception:  # noqa: BLE001 - the card opens without the date
        log.warning("last login of %s unavailable", uid, exc_info=True)
        return None


# --------------------------------------------------------------------------- searchUsers, getUserCard, listUserTracks


@router.get("/users", response_model=UserSearchResult)
def search_users(request: Request, q: str = Query("", max_length=MAX_EMAIL_CHARS * 4)) -> Any:
    """Case-insensitive substring search over the email index (AC-03). A query under 3 characters is refused and not
    journaled (AC-04); otherwise the search is journaled with its query and matches BEFORE the answer (AC-10b, AC-33b)."""
    needle = q.strip()
    if len(needle) < MIN_SEARCH_CHARS:
        _refuse("query_too_short", "Type at least 3 characters")
    if len(needle) > MAX_EMAIL_CHARS:
        raise _invalid("q", f"Must be at most {MAX_EMAIL_CHARS} characters")
    svc = get_services(request.app)
    admin_uid = current_admin_uid(request)
    hits = svc.directory.search(needle)
    svc.audit.record_view(AuditEntry(
        action="search", admin_uid=admin_uid, admin_email=_admin_email(svc, admin_uid),
        query=needle, matched_uids=[m.uid for m in hits],
    ))
    return UserSearchResult(
        query=needle,
        items=[UserSearchItem(uid=m.uid, email=m.email, service=stats.is_service(m.uid)) for m in hits],
        truncated=len(hits) >= MAX_RESULTS,       # the directory stops at 50: a full list may have more behind it
    )


@router.get("/users/{uid}", response_model=UserCard)
def get_user_card(uid: str, request: Request) -> Any:
    """Profile, quota against the limit in force, personal limit, state, the 20 newest jobs and the first 50 songs
    (metadata only). The view is journaled BEFORE any of it is read out (AC-33b); an unknown or purged uid is a 404
    and leaves no record."""
    svc = get_services(request.app)
    user = _live_user(svc, uid)
    if user is None:
        _refuse("not_found", "User not found")
    admin_uid = current_admin_uid(request)
    svc.audit.record_view(AuditEntry(
        action="view_card", admin_uid=admin_uid, admin_email=_admin_email(svc, admin_uid), target_uid=uid))
    stored_email = user.data.get("email")
    email = stored_email[:MAX_EMAIL_CHARS] if isinstance(stored_email, str) else ""
    totals = svc.db.aggregate(f"{USERS}/{uid}/tracks", {"count": "count", "bytes": ("sum", "sizeBytes")})
    profile = UserProfile(
        uid=uid, email=email, created_at=_time(user.data.get("createdAt")) or _EPOCH,
        last_login_at=_last_login(svc, uid), service=stats.is_service(uid),
        track_count=int(totals.get("count") or 0), storage_bytes=int(totals.get("bytes") or 0),
    )
    jobs = svc.db.run_query(JOBS, filters=[("uid", "==", uid)], order_by=["-acceptedAt"], limit=RECENT_JOBS)
    return UserCard(
        profile=profile,
        account=_account_state(svc, request, uid),
        recent_jobs=[_recent_job(j, uid, email or None) for j in jobs],
        tracks=_track_page(svc, uid, None, PAGE_SIZE),
    )


@router.get("/users/{uid}/tracks", response_model=TrackMetaPage)
def list_user_tracks(
    uid: str,
    request: Request,
    after: Optional[str] = Query(None, max_length=512),
    limit: int = Query(PAGE_SIZE, ge=1, le=PAGE_SIZE),
) -> Any:
    """The next pages of a user's songs, 50 at a time, newest first. Not journaled again: the card view that leads to
    them is (api-sync-report notes)."""
    svc = get_services(request.app)
    if _live_user(svc, uid) is None:
        _refuse("not_found", "User not found")
    return _track_page(svc, uid, after, limit)

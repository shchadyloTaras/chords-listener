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
* ``GET /jobs`` (job history, AC-07) and ``GET /stats`` (daily stats, AC-08, AC-09).
* ``listAudit`` (``GET /audit``, AC-10, AC-10b, AC-11): the admin action journal, read-only.
* ``setDefaultLimits``, ``setSwitch`` and ``setBanner`` (``PUT /settings/...``, AC-13b, AC-24..AC-30, AC-34): the
  service settings, each written with its journal record in one commit (``actions.py``).
* ``resetQuota`` (``POST /users/{uid}/quota/reset``, AC-12, AC-12b), ``setPersonalLimit`` and ``removePersonalLimit``
  (``PUT`` / ``DELETE /users/{uid}/limit``, AC-13..AC-15): each answers the account's state after the change.
* ``restrictUser`` and ``unrestrictUser`` (``PUT`` / ``DELETE /users/{uid}/restriction``, AC-16, AC-17, AC-19, AC-23b):
  the cloud restriction, one transaction with its journal record; own account and scheduled deletion are refused
  (409) and journaled.
* ``scheduleDeletion`` and ``cancelDeletion`` (``POST`` / ``DELETE /users/{uid}/deletion``, AC-17, AC-20, AC-21, AC-23,
  AC-34, AC-35): scheduling needs a sign-in at most 15 minutes old, the user's e-mail typed again and a free place in the
  cap of 10 per 60 minutes; one transaction with its journal record (``actions.py``).
"""
from __future__ import annotations

import base64
import binascii
import json
import logging
import re
import threading
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Annotated, Any, Callable, Mapping, NoReturn, Optional

from fastapi import APIRouter, Depends, FastAPI, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError

from app.firestore import Document, Filter, FirestoreIndex
from app.users import valid_uid

from . import models, stats
from .audit import COLLECTION as AUDIT_COLLECTION
from .audit import Audit, AuditEntry
from . import actions
from .authz import ADMIN_PREFIX, AdminRoute, current_admin_uid, require_fresh_login
from .directory import MAX_RESULTS, USERS, Directory, parse_time
from .history import JOBS, REASONS
from .identity import AuthLookup
from .models import (
    MAX_EMAIL_CHARS,
    MIN_SEARCH_CHARS,
    PAGE_SIZE,
    AccountState,
    Deletion,
    FailureReason,
    HistoryStatus,
    InvalidPeriod,
    JobHistoryItem,
    JobHistoryPage,
    Origin,
    OriginCounts,
    Overview,
    PersonalLimit,
    QuotaUsage,
    RestoredTracks,
    Restriction,
    RunningJob,
    Settings,
    SourceType,
    StatsDay,
    StatsPeriod,
    StatsRange,
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
PERIOD_RULE = "The period must be at most 90 days and end no earlier than it starts"


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
    ``directory`` is ``app.state.admin_directory`` (the app's one email-index cache, which the background sweep
    rebuilds) and its ``settings`` is ``app.state.admin_settings`` (the app's one settings cache). Tests replace a
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


def _origins(raw: Any) -> OriginCounts:
    """A stored per-origin map as ``OriginCounts`` (a missing or broken count is 0)."""
    by_origin = raw if isinstance(raw, dict) else {}
    return OriginCounts(**{origin: _count(by_origin.get(origin)) for origin in stats.ORIGINS})


def _reasons(raw: Any) -> dict[str, int]:
    """A stored reason map, reduced to the fixed reasons that have failures."""
    return {r: _count(raw.get(r)) for r in REASONS if _count(raw.get(r)) > 0} if isinstance(raw, dict) else {}


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


def _job_item(doc: Document, email: Optional[str], deleted: bool) -> JobHistoryItem:
    """An ``adminJobs`` record as the contract's ``JobHistoryItem`` (the user's email and «видалений» mark come from
    the caller). The error text and title are the user's text verbatim, cut to the contract's lengths."""
    d = doc.data
    uid = d.get("uid")
    error_text, title = d.get("errorText"), d.get("title")
    return JobHistoryItem(
        id=doc.id, uid=uid, email=email, user_deleted=deleted,
        service=d.get("service") is True or (isinstance(uid, str) and stats.is_service(uid)),
        kind=d.get("kind"), origin=d.get("origin"),
        source_type="youtube" if d.get("sourceType") == "youtube" else "other", status=d.get("status"), reason=d.get("reason"),
        error_text=error_text[:200] if isinstance(error_text, str) else None,
        title=title[:300] if isinstance(title, str) else None,
        accepted_at=_time(d.get("acceptedAt")) or _EPOCH, finished_at=_time(d.get("finishedAt")),
    )


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
    return Overview(
        day=day,
        analyses=_origins(stored.get("analyses")),
        vocals=_count(stored.get("vocals")),
        failed=_count(stored.get("failed")),
        failed_by_reason=_reasons(stored.get("failedByReason")),
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


def _track_page(svc: AdminServices, uid: str, after: Optional[str], limit: int, before: Optional[str] = None) -> TrackMetaPage:
    """``limit`` songs newest first, after the song ``after`` names, or (going back) the ones just newer than the song
    ``before`` names. One extra song is read to know whether another page follows."""
    collection = f"{USERS}/{uid}/tracks"

    def position(cursor: str) -> Document:
        created, track_id = _track_position(cursor)
        return Document(f"{collection}/{track_id}", {"createdAt": created})

    if before:
        docs = svc.db.run_query(collection, order_by=["createdAt"], limit=limit + 1, start_after=position(before))
        has_prev = len(docs) > limit
        docs = docs[:limit][::-1]
        return TrackMetaPage(
            items=[_track_meta(d) for d in docs], has_next=True, has_prev=has_prev,
            next_cursor=_track_cursor(docs[-1]) if docs else None,
        )
    docs = svc.db.run_query(collection, order_by=["-createdAt"], limit=limit + 1,
                            start_after=position(after) if after else None)
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
    hits = svc.directory.search(needle, limit=MAX_RESULTS + 1)
    svc.audit.record_view(AuditEntry(
        action="search", admin_uid=admin_uid, admin_email=_admin_email(svc, admin_uid),
        query=needle, matched_uids=[m.uid for m in hits[:MAX_RESULTS]],
    ))
    return UserSearchResult(
        query=needle,
        items=[UserSearchItem(uid=m.uid, email=m.email, service=stats.is_service(m.uid)) for m in hits[:MAX_RESULTS]],
        truncated=len(hits) > MAX_RESULTS,        # the directory hands back 51 at most: a 51st match means more behind
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
        recent_jobs=[_job_item(j, email or None, False) for j in jobs],
        tracks=_track_page(svc, uid, None, PAGE_SIZE),
    )


@router.get("/users/{uid}/tracks", response_model=TrackMetaPage)
def list_user_tracks(
    uid: str,
    request: Request,
    after: Optional[str] = Query(None, max_length=512),
    before: Optional[str] = Query(None, max_length=512),
    limit: int = Query(PAGE_SIZE, ge=1, le=PAGE_SIZE),
) -> Any:
    """The next pages of a user's songs, 50 at a time, newest first. Not journaled again: the card view that leads to
    them is (api-sync-report notes)."""
    if after is not None and before is not None:
        raise _invalid("before", "use either after or before, not both")
    svc = get_services(request.app)
    if _live_user(svc, uid) is None:
        _refuse("not_found", "User not found")
    return _track_page(svc, uid, after, limit, before)


# --------------------------------------------------------------------------- the period rule (T04, AC-09)


def _period(start: Optional[date], end: Optional[date]) -> None:
    """The shared period rule (T04, AC-09), checked before anything is read. A period given by one end only is fine."""
    if start is None or end is None:
        return
    try:
        StatsPeriod.model_validate({"from": start, "to": end})
    except ValidationError as exc:
        if any(isinstance(e.get("ctx", {}).get("error"), InvalidPeriod) for e in exc.errors()):
            _refuse("invalid_period", PERIOD_RULE)
        raise


def _utc(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, tzinfo=timezone.utc)


# --------------------------------------------------------------------------- job history (US-04, AC-07)


def _job_cursor(doc: Document) -> str:
    return _pack_cursor({"t": doc.data["acceptedAt"], "id": doc.id})


def _job_position(cursor: str) -> Document:
    """The ``adminJobs`` position a cursor stands for: only its sort key and id are read, nothing else is trusted."""
    try:
        raw = _unpack_cursor(cursor)
        when, job_id = parse_time(raw["t"]), raw["id"]
        if when is None or not isinstance(job_id, str) or not job_id or "/" in job_id:
            raise ValueError(cursor)
    except (ValueError, KeyError, TypeError, binascii.Error):
        _refuse("invalid_value", "The page cursor is not valid")
    return Document(f"{JOBS}/{job_id}", {"acceptedAt": when})


class _UserNames:
    """Email and the «видалений» mark of the users on one page: one ``users`` read per distinct uid, plus a tombstone
    read only for a uid that has no user document any more."""

    def __init__(self, db: FirestoreIndex) -> None:
        self._db = db
        self._seen: dict[str, tuple[Optional[str], bool]] = {}

    def of(self, uid: str) -> tuple[Optional[str], bool]:
        if uid not in self._seen:
            user = self._db.get(f"{USERS}/{uid}")
            if user is not None:
                email = user.data.get("email")
                self._seen[uid] = (email if isinstance(email, str) else None, False)
            else:
                self._seen[uid] = (None, self._db.get(f"{TOMBSTONES}/{uid}") is not None)
        return self._seen[uid]


def _counts_by_reason(db: FirestoreIndex, filters: list[Filter], status: Optional[str], reason: Optional[str]) -> dict[str, int]:
    """One ``count()`` per failure reason under the page's filters, the reasons with no job left out. Only failures
    have a reason, so a filter on another result needs none, and a filter on one reason needs just that one."""
    if status not in (None, "error"):
        return {}
    counts: dict[str, int] = {}
    for r in ([reason] if reason else REASONS):
        n = db.count(JOBS, filters=filters if reason else filters + [("reason", "==", r)])
        if n:
            counts[r] = n
    return counts


@router.get("/jobs", response_model=JobHistoryPage)
def list_job_history(
    request: Request,
    status: Optional[HistoryStatus] = None,
    reason: Optional[FailureReason] = None,
    origin: Optional[Origin] = None,
    source_type: Optional[SourceType] = Query(None, alias="sourceType"),
    from_: Optional[date] = Query(None, alias="from"),
    to: Optional[date] = None,
    after: Optional[str] = Query(None, max_length=512),
    before: Optional[str] = Query(None, max_length=512),
    limit: int = Query(PAGE_SIZE, ge=1, le=PAGE_SIZE),
) -> JobHistoryPage:
    """Job history of all users, newest first: combined filters (``adminJobs_{status,reason,origin,sourceType}_acceptedAt``), a
    page of at most 50 and a ``count()`` per failure reason (50 + 7 reads, plus the users' emails)."""
    _period(from_, to)
    if after and before:
        _refuse("invalid_value", "Use either after or before, not both")
    db = database(request)
    filters: list[Filter] = [
        (name, "==", value) for name, value in (("status", status), ("reason", reason), ("origin", origin), ("sourceType", source_type)) if value
    ]
    if from_:
        filters.append(("acceptedAt", ">=", _utc(from_)))
    if to:
        filters.append(("acceptedAt", "<", _utc(to) + timedelta(days=1)))

    marker = after or before
    cursor = _job_position(marker) if marker else None
    backwards = before is not None
    rows = db.run_query(
        JOBS, filters=filters, order_by=["acceptedAt" if backwards else "-acceptedAt"], limit=limit + 1, start_after=cursor,
    )
    more = len(rows) > limit
    rows = rows[:limit]
    if backwards:
        rows.reverse()
    has_next = True if backwards else more  # going back, the page we came from lies ahead
    has_prev = more if backwards else cursor is not None

    names = _UserNames(db)
    return JobHistoryPage(
        items=[_job_item(doc, *names.of(doc.data["uid"])) for doc in rows],
        has_next=has_next,
        has_prev=has_prev,
        next_cursor=_job_cursor(rows[-1]) if rows and has_next else None,
        counts_by_reason=_counts_by_reason(db, filters, status, reason),
    )


# --------------------------------------------------------------------------- daily stats (US-05, AC-08, AC-09)


def _stats_day(day: str, doc: Optional[Document]) -> StatsDay:
    """The contract's ``StatsDay`` of a stored day; a day with no document is a live day of zeros."""
    data = doc.data if doc is not None else {}
    state = data.get("state") if data.get("state") in ("live", "frozen", "restored") else stats.LIVE
    if state == "restored":  # rebuilt from songs: only the songs per source, never failures (AC-08)
        tracks = data.get("restoredTracks") if isinstance(data.get("restoredTracks"), dict) else {}
        return StatsDay(
            day=day, state="restored", analyses=_origins(None), vocals=0, failed=0,
            failed_by_reason={}, active=0, new_users=None,
            restored_tracks=RestoredTracks(**{k: _count(tracks.get(k)) for k in ("youtube", "url", "file")}),
            frozen_at=None,
        )
    new_users = data.get("newUsers")
    return StatsDay(
        day=day, state=state, analyses=_origins(data.get("analyses")),
        vocals=_count(data.get("vocals")), failed=_count(data.get("failed")),
        failed_by_reason=_reasons(data.get("failedByReason")), active=_count(data.get("active")),
        new_users=_count(new_users) if new_users is not None else None, restored_tracks=None,
        frozen_at=parse_time(data.get("frozenAt")),
    )


def _fill_new_users(db: FirestoreIndex, entry: StatsDay, stored: bool) -> None:
    """A live day has no ``newUsers`` yet (it is written at freeze): count the registrations of its UTC day on read."""
    if entry.state != "live" or entry.new_users is not None:
        return
    if not stored and entry.day != models.today_utc().isoformat():
        return  # a quiet past day: nothing to count
    entry.new_users = _registrations(db, entry.day)


@router.get("/stats", response_model=StatsRange)
def get_stats(request: Request, from_: date = Query(alias="from"), to: date = Query()) -> StatsRange:
    """Daily stats of a period of at most 90 days: one ``adminStats/{day}`` read per day. A day without a document is
    omitted (today stays when it has new users); a restored day carries only its songs per source."""
    _period(from_, to)
    db = database(request)
    entries: list[StatsDay] = []
    for n in range((to - from_).days + 1):
        day = (from_ + timedelta(days=n)).isoformat()
        doc = db.get(stats.day_path(day))
        entry = _stats_day(day, doc)
        _fill_new_users(db, entry, doc is not None)
        if doc is None and not entry.new_users:
            continue  # a day with no document is omitted (the UI shows zeros); never a «live» row of zeros
        entries.append(entry)
    return StatsRange(from_=from_.isoformat(), to=to.isoformat(), days=entries)


# --------------------------------------------------------------------------- GET /api/admin/audit (AC-10, AC-10b, AC-11)

_STAMP = "%Y-%m-%dT%H:%M:%S.%fZ"


def _audit_cursor(doc: Document) -> str:
    """The record's sort key (``at``, to the microsecond) and id."""
    at = parse_time(doc.data["at"])
    assert at is not None
    return _pack_cursor({"c": at.astimezone(timezone.utc).strftime(_STAMP), "i": doc.id})


def _audit_position(name: str, cursor: str) -> Document:
    """The record a cursor stands for (just enough of it to resume a query after it); 422 when it is not one of ours."""
    try:
        data = _unpack_cursor(cursor)
        at = datetime.strptime(data["c"], _STAMP).replace(tzinfo=timezone.utc)
        doc_id = data["i"]
        if not isinstance(doc_id, str) or not doc_id or "/" in doc_id:
            raise ValueError(doc_id)
    except (ValueError, KeyError, TypeError, binascii.Error) as exc:
        raise _invalid(name, "not a cursor of this list") from exc
    return Document(f"{AUDIT_COLLECTION}/{doc_id}", {"at": at})


def _target_of(db: FirestoreIndex, people: Directory, uid: str) -> tuple[Optional[str], bool]:
    """(email, deleted) of a journal target. A tombstone wins over the index (a purge writes it first, ADR-0011);
    a uid nobody knows is neither: no email, not deleted."""
    if db.get(f"{TOMBSTONES}/{uid}") is not None:
        return None, True
    return people.email_of(uid), False


def _audit_entry(doc: Document, targets: dict[str, tuple[Optional[str], bool]]) -> models.AuditEntry:
    d = doc.data
    uid: Optional[str] = d.get("targetUid")
    email, deleted = targets.get(uid, (None, False)) if uid else (None, False)
    return models.AuditEntry(
        id=doc.id, at=parse_time(d["at"]), admin_uid=d["adminUid"], admin_email=d["adminEmail"], action=d["action"],
        outcome=d["outcome"], target_uid=uid, target_email=email, target_deleted=deleted, setting=d.get("setting"),
        before=d.get("before"), after=d.get("after"), reject_reason=d.get("rejectReason"), query=d.get("query"),
        ref_id=d.get("refId"), redacted_at=parse_time(d.get("redactedAt")),
    )


@router.get("/audit", response_model=models.AuditPage, operation_id="listAudit")
def list_audit(
    request: Request,
    admin_uid: Annotated[Optional[models.Uid], Query(alias="adminUid")] = None,
    target_uid: Annotated[Optional[models.Uid], Query(alias="targetUid")] = None,
    action: Optional[models.AuditAction] = None,
    after: Optional[models.Cursor] = None,
    before: Optional[models.Cursor] = None,
    limit: Annotated[int, Query(ge=1, le=PAGE_SIZE)] = PAGE_SIZE,
) -> models.AuditPage:
    """The admin action journal, newest first, filtered by admin / user / action. Read-only: there is no route that
    changes or deletes a record (AC-11). The journal is not itself journaled (it holds no personal data beyond what
    the records already hold); a purged target shows ``targetEmail: null, targetDeleted: true``."""
    if after is not None and before is not None:
        raise _invalid("before", "use either after or before, not both")
    db = database(request)
    people = directory(request)
    filters = [(f, "==", v) for f, v in (("adminUid", admin_uid), ("targetUid", target_uid), ("action", action)) if v]
    if before is not None:  # going back: the records just newer than the cursor, then turned to newest first
        docs = db.run_query(AUDIT_COLLECTION, filters=filters, order_by=["at"], limit=limit + 1,
                            start_after=_audit_position("before", before))
        has_prev, has_next = len(docs) > limit, True
        docs = docs[:limit][::-1]
    else:
        docs = db.run_query(AUDIT_COLLECTION, filters=filters, order_by=["-at"], limit=limit + 1,
                            start_after=_audit_position("after", after) if after is not None else None)
        has_next, has_prev = len(docs) > limit, after is not None
        docs = docs[:limit]
    uids = dict.fromkeys(str(d.data["targetUid"]) for d in docs if d.data.get("targetUid"))  # each target once
    targets = {uid: _target_of(db, people, uid) for uid in uids}
    return models.AuditPage(
        items=[_audit_entry(d, targets) for d in docs],
        has_next=has_next,
        has_prev=has_prev,
        next_cursor=_audit_cursor(docs[-1]) if has_next and docs else None,
    )


# --------------------------------------------------------------------------- settings: change them


@router.put("/settings/limits", response_model=Settings, operation_id="setDefaultLimits")
def set_default_limits(body: models.DefaultLimitsIn, request: Request) -> Settings:
    svc = get_services(request.app)
    admin_uid = current_admin_uid(request)
    return actions.set_default_limits(
        svc, admin_uid=admin_uid, admin_email=_admin_email(svc, admin_uid), limits=body
    )


@router.put("/settings/switches/{name}", response_model=Settings, operation_id="setSwitch")
async def set_switch(name: models.SwitchName, body: models.SwitchChange, request: Request) -> Settings:
    if name == "analysesPaused" and body.value:  # only pausing every new analysis asks for a fresh sign-in (AC-34)
        await require_fresh_login(request)
    svc = get_services(request.app)
    admin_uid = current_admin_uid(request)

    def apply() -> Settings:
        return actions.set_switch(
            svc, admin_uid=admin_uid, admin_email=_admin_email(svc, admin_uid), name=name, value=body.value
        )

    return await run_in_threadpool(apply)


@router.put("/settings/banner", response_model=Settings, operation_id="setBanner")
def set_banner(body: models.BannerIn, request: Request) -> Settings:
    svc = get_services(request.app)
    admin_uid = current_admin_uid(request)
    return actions.set_banner(svc, admin_uid=admin_uid, admin_email=_admin_email(svc, admin_uid), banner=body)


# --------------------------------------------------------------------------- user actions: quota reset, personal limit


def _acting_user(request: Request, uid: str) -> tuple[AdminServices, str, str]:
    """(services, who acts, their email) for an action on ``uid``; an unknown or purged account is a 404 and nothing is
    written or journaled."""
    svc = get_services(request.app)
    if _live_user(svc, uid) is None:
        _refuse("not_found", "User not found")
    admin_uid = current_admin_uid(request)
    return svc, admin_uid, _admin_email(svc, admin_uid)


def _forget_account(request: Request, uid: str) -> None:
    """Drop the admission gate's cached state of ``uid``: a changed limit is in force from the next job on this server
    (other instances see it within the cache's minute, AC-24)."""
    admission = getattr(request.app.state, "admission", None)
    if admission is not None:
        admission.invalidate(uid)


@router.post("/users/{uid}/quota/reset", response_model=AccountState, operation_id="resetQuota")
def reset_quota(uid: str, request: Request) -> AccountState:
    """Today's analyses and vocals counters of the user become 0 (the running jobs are untouched). Journal first, under
    the lock admission takes; a failure at either step is 503 ``not_applied``."""
    svc, admin_uid, admin_email = _acting_user(request, uid)
    actions.reset_quota(svc, request.app.state.jobs.quotas, admin_uid=admin_uid, admin_email=admin_email, uid=uid)
    return _account_state(svc, request, uid)


@router.put("/users/{uid}/limit", response_model=AccountState, operation_id="setPersonalLimit")
def set_personal_limit(uid: str, body: models.PersonalLimitIn, request: Request) -> AccountState:
    svc, admin_uid, admin_email = _acting_user(request, uid)
    actions.set_personal_limit(svc, admin_uid=admin_uid, admin_email=admin_email, uid=uid, limit=body, now=utc_now())
    _forget_account(request, uid)
    return _account_state(svc, request, uid)


@router.delete("/users/{uid}/limit", response_model=AccountState, operation_id="removePersonalLimit")
def remove_personal_limit(uid: str, request: Request) -> AccountState:
    svc, admin_uid, admin_email = _acting_user(request, uid)
    actions.remove_personal_limit(svc, admin_uid=admin_uid, admin_email=admin_email, uid=uid)
    _forget_account(request, uid)
    return _account_state(svc, request, uid)


@router.put("/users/{uid}/restriction", response_model=AccountState, operation_id="restrictUser")
def restrict_user(uid: str, body: models.RestrictionIn, request: Request) -> AccountState:
    """Put a cloud restriction on the user (or change its reason). Own account -> 409 ``self_target``, a scheduled
    deletion -> 409 ``deletion_pending`` (both journaled as rejected). New jobs are refused from now on this server and
    within a minute on the others; jobs already accepted are not touched (AC-19)."""
    svc, admin_uid, admin_email = _acting_user(request, uid)
    actions.restrict_user(svc, admin_uid=admin_uid, admin_email=admin_email, uid=uid, reason=body.reason, now=utc_now())
    _forget_account(request, uid)
    return _account_state(svc, request, uid)


@router.delete("/users/{uid}/restriction", response_model=AccountState, operation_id="unrestrictUser")
def unrestrict_user(uid: str, request: Request) -> AccountState:
    """Lift the cloud restriction. A scheduled deletion -> 409 ``deletion_pending`` (journaled as rejected); not
    restricted -> 409 ``not_set`` (nothing journaled)."""
    svc, admin_uid, admin_email = _acting_user(request, uid)
    actions.unrestrict_user(svc, admin_uid=admin_uid, admin_email=admin_email, uid=uid)
    _forget_account(request, uid)
    return _account_state(svc, request, uid)


# --------------------------------------------------------------------------- user actions: scheduled deletion


@router.post(
    "/users/{uid}/deletion", response_model=AccountState, operation_id="scheduleDeletion",
    dependencies=[Depends(require_fresh_login)],
)
def schedule_deletion(uid: str, body: models.DeletionIn, request: Request) -> AccountState:
    """Schedule the final deletion of the account for 7 days from now and restrict it at once. A sign-in older than 15
    minutes -> 401 ``reauth_required``; own account -> 409 ``self_target``, already scheduled -> 409 ``deletion_pending``,
    10 deletions in the last 60 minutes -> 429 ``deletion_rate_limit`` (all journaled as rejected); another e-mail than the
    user's -> 422 ``confirm_email_mismatch`` (not journaled)."""
    svc, admin_uid, admin_email = _acting_user(request, uid)
    actions.schedule_deletion(
        svc, admin_uid=admin_uid, admin_email=admin_email, uid=uid, confirm_email=body.confirm_email, now=utc_now()
    )
    _forget_account(request, uid)
    return _account_state(svc, request, uid)


@router.delete("/users/{uid}/deletion", response_model=AccountState, operation_id="cancelDeletion")
def cancel_deletion(uid: str, request: Request) -> AccountState:
    """Cancel the scheduled deletion within its 7 days: the restriction from before comes back (or none). Nothing
    scheduled, or the purge date passed -> 409 ``not_scheduled`` (journaled as rejected)."""
    svc, admin_uid, admin_email = _acting_user(request, uid)
    actions.cancel_deletion(svc, admin_uid=admin_uid, admin_email=admin_email, uid=uid, now=utc_now())
    _forget_account(request, uid)
    return _account_state(svc, request, uid)

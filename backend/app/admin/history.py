"""Job-history projection (ADR-0004, data-model Aggregate 2): ``adminJobs/{jobId}`` plus the daily counters it feeds.

``Projections.accept(job)`` and ``Projections.finish(job)`` run from the job lifecycle (wired in by ``JobManager``,
T12). Both are one Firestore transaction and idempotent, so a replay is a no-op:

* **accept** creates ``adminJobs/{id}`` (``exists=false``), marks the user active on that day once and counts the job
  into its source (``analyses.<origin>``) or ``vocals``. A job that already exists changes nothing.
* **finish** settles a ``running`` job (``done`` / ``error`` + the failure ``reason``) and, on ``error``, counts one
  failure into the day the job was *accepted* on. A job that is no longer ``running`` changes nothing. A frozen or
  restored day is never touched (``stats.counter_writes``); the job record is still completed.

The service account (``SMOKE_UID``) is recorded with ``service = true`` and left out of every counter.

A projection must never fail the job (SAD §6): a write that fails is appended to the GCS-backed buffer
``<data>/admin/projections-pending.json`` (``{"ops": [{"op", "jobId", "payload", "at"}]}``, guarded by a leaf lock like
``publish-pending.json``). ``replay_pending()`` drains it, in order; it runs before every projection write and from
every sweep, before the nightly reconciliation counts from the history.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

from app.firestore import FirestoreIndex, PreconditionFailed, Transaction
from app.storage import read_json, write_json_atomic

from . import stats
from .models import JobKind, Origin

log = logging.getLogger("chords.admin.history")

JOBS = "adminJobs"
RETENTION = timedelta(days=90)  # `adminJobs.expireAt` = acceptedAt + 90 d (TTL policy, NFR history >= 90 days)
TITLE_CHARS = 300               # = StorageJobRequest.title
ERROR_TEXT_CHARS = 200
PENDING_FILE = "projections-pending.json"

# --------------------------------------------------------------------------- the fixed failure-reason list (AC-07)

REASONS = (
    "youtube_blocked", "download_failed", "unsupported_format", "too_long", "too_large", "analysis_failed", "other",
)
OTHER = "other"
# ErrorCode -> reason. Every other code (internal, cancelled, quota_exceeded, ...) and anything unknown is «Інше».
_REASON_OF_CODE = {
    "download_blocked": "youtube_blocked",
    "download_failed": "download_failed",
    "unsupported_format": "unsupported_format",
    "too_long": "too_long",
    "too_large": "too_large",
    "analysis_failed": "analysis_failed",
}
# The uk / en labels live in the front end's i18n table under these keys (frontend/src/i18n/admin.ts).
REASON_LABEL_KEYS = {reason: f"admin.reason.{reason}" for reason in REASONS}


def reason_for(error_code: Optional[str]) -> str:
    """The failure category of an ``ErrorCode``; a code outside the table (or none) is ``other``."""
    return _REASON_OF_CODE.get(error_code or "", OTHER)


def pending_path(data_dir: Path) -> Path:
    """``<data>/admin/projections-pending.json``."""
    return data_dir / "admin" / PENDING_FILE


# --------------------------------------------------------------------------- the events


@dataclass(frozen=True)
class AcceptedJob:
    """A cloud job the server took on: what the history needs to remember about it."""

    id: str
    uid: str
    kind: JobKind
    origin: Origin
    accepted_at: datetime
    title: Optional[str] = None


@dataclass(frozen=True)
class FinishedJob:
    """How a job ended: ``done`` (with its ``track_id``) or ``error`` (with the ``ErrorCode`` and a short text)."""

    id: str
    status: str  # "done" | "error"
    finished_at: datetime
    error_code: Optional[str] = None
    error_text: Optional[str] = None
    track_id: Optional[str] = None


class JobMissing(Exception):
    """``finish`` found no ``adminJobs`` record: its accept has not landed (yet)."""


def _iso(when: datetime) -> str:
    return when.astimezone(timezone.utc).isoformat()


def _cut(text: Optional[str], limit: int) -> Optional[str]:
    return None if text is None else text[:limit]


_pending_lock = threading.Lock()  # guards every read-modify-write of projections-pending.json (a leaf lock: no Firestore call under it)


class Projections:
    def __init__(
        self,
        db: FirestoreIndex,
        pending: Path,
        *,
        jobs_collection: str = JOBS,
        stats_collection: str = stats.STATS,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self._db = db
        self._pending = pending
        self._jobs = jobs_collection
        self._stats = stats_collection
        self._now = now

    # ----------------------------------------------------------------------- public

    def accept(self, job: AcceptedJob) -> bool:
        """Record an accepted job and count it into its UTC day. True when written; False when it was buffered
        instead. Never raises."""
        self.replay_pending()
        return self._run("accept", job.id, self._accept_payload(job), lambda: self._accept(job))

    def finish(self, job: FinishedJob) -> bool:
        """Settle a job's record and count a failure into the day it was accepted on. True when written; False when
        it was buffered instead. Never raises."""
        self.replay_pending()
        return self._run("finish", job.id, self._finish_payload(job), lambda: self._finish(job))

    def replay_pending(self) -> int:
        """Apply the buffered ops, oldest first. An op that is written (or can never be: a finish whose job is not
        in the history and not waiting in the buffer, or an unreadable op) leaves the buffer; one that fails again
        stays for the next run. Returns how many left the buffer. Never raises."""
        try:
            ops = self._read_pending()
            if not ops:
                return 0
            gone: list[dict[str, Any]] = []
            stuck_accepts: set[str] = set()
            for op in ops:
                try:
                    self._apply(op)
                except JobMissing:
                    if op.get("jobId") in stuck_accepts:
                        continue  # its accept is still waiting: keep the finish behind it
                    log.warning("dropping finish of %s: the job is not in the history", op.get("jobId"))
                except (KeyError, TypeError, ValueError):
                    log.warning("dropping unreadable projection op %r", op, exc_info=True)
                except Exception as exc:
                    log.warning("projection %s of %s still failing (kept): %s", op.get("op"), op.get("jobId"), exc)
                    if op.get("op") == "accept":
                        stuck_accepts.add(str(op.get("jobId")))
                    continue
                gone.append(op)
            if gone:
                self._remove_pending(gone)
                log.info("pending projections: %d drained, %d left", len(gone), len(ops) - len(gone))
            return len(gone)
        except Exception:
            log.warning("could not replay %s", self._pending, exc_info=True)
            return 0

    # ----------------------------------------------------------------------- one write, or the buffer

    def _run(self, op: str, job_id: str, payload: dict[str, Any], action: Callable[[], None]) -> bool:
        try:
            action()
            return True
        except Exception as exc:
            log.warning("projection %s of job %s failed (buffered): %s", op, job_id, exc)
            self._enqueue(op, job_id, payload)
            return False

    def _apply(self, op: dict[str, Any]) -> None:
        payload = op["payload"]
        if op["op"] == "accept":
            self._accept(AcceptedJob(
                id=op["jobId"], uid=payload["uid"], kind=payload["kind"], origin=payload["origin"],
                accepted_at=datetime.fromisoformat(payload["acceptedAt"]), title=payload.get("title"),
            ))
        elif op["op"] == "finish":
            self._finish(FinishedJob(
                id=op["jobId"], status=payload["status"], finished_at=datetime.fromisoformat(payload["finishedAt"]),
                error_code=payload.get("errorCode"), error_text=payload.get("errorText"), track_id=payload.get("trackId"),
            ))
        else:
            raise ValueError(f"unknown projection op {op['op']!r}")

    # ----------------------------------------------------------------------- the transactions

    def _accept(self, job: AcceptedJob) -> None:
        db = self._db
        day = stats.utc_day(job.accepted_at)
        service = stats.is_service(job.uid)
        path = f"{self._jobs}/{job.id}"
        now = self._now()

        def work(tx: Transaction) -> None:
            if tx.get(path) is not None:
                return  # a replay
            doc = {
                "uid": job.uid, "service": service, "kind": job.kind, "origin": job.origin, "status": "running",
                "reason": None, "errorText": None, "title": _cut(job.title, TITLE_CHARS), "trackId": None,
                "acceptedAt": job.accepted_at, "finishedAt": None, "day": day,
                "expireAt": job.accepted_at + RETENTION, "anonymizedAt": None,
            }
            writes = [db.update_op(path, doc, exists=False)]
            if not service:
                day_doc = tx.get(stats.day_path(day, self._stats))
                if stats.is_open(day_doc):
                    deltas: dict[stats.CounterPath, int] = {
                        ("vocals",) if job.kind == "vocals" else ("analyses", job.origin): 1
                    }
                    marker = stats.marker_path(day, job.uid, self._stats)
                    if tx.get(marker) is None:  # the first accepted job of the user on this day
                        writes.append(db.update_op(marker, stats.marker_doc(day, now), exists=False))
                        deltas[("active",)] = 1
                    writes += stats.counter_writes(db, day, day_doc, deltas, now, collection=self._stats)
            tx.commit(writes)

        try:
            db.run_transaction(work)
        except PreconditionFailed:
            pass  # another writer created the record between our read and commit: it is there, that is all we wanted

    def _finish(self, job: FinishedJob) -> None:
        db = self._db
        path = f"{self._jobs}/{job.id}"
        now = self._now()

        def work(tx: Transaction) -> None:
            existing = tx.get(path)
            if existing is None:
                raise JobMissing(job.id)
            if existing.data.get("status") != "running":
                return  # a replay (or a second outcome): the first one stands
            failed = job.status == "error"
            reason = reason_for(job.error_code) if failed else None
            outcome = {
                "status": "error" if failed else "done",
                "reason": reason,
                "errorText": _cut(job.error_text, ERROR_TEXT_CHARS) if failed else None,
                "trackId": None if failed else job.track_id,
                "finishedAt": job.finished_at,
            }
            writes = [db.update_op(path, outcome, mask=list(outcome), exists=True)]
            if failed and not existing.data.get("service"):
                day = existing.data["day"]
                day_doc = tx.get(stats.day_path(day, self._stats))
                writes += stats.counter_writes(
                    db, day, day_doc, {("failed",): 1, ("failedByReason", reason): 1}, now, collection=self._stats
                )
            tx.commit(writes)

        try:
            db.run_transaction(work)
        except PreconditionFailed:
            pass  # the record vanished between our read and commit (a purge): nothing left to settle

    # ----------------------------------------------------------------------- the buffer

    @staticmethod
    def _accept_payload(job: AcceptedJob) -> dict[str, Any]:
        return {"uid": job.uid, "kind": job.kind, "origin": job.origin, "acceptedAt": _iso(job.accepted_at),
                "title": job.title}

    @staticmethod
    def _finish_payload(job: FinishedJob) -> dict[str, Any]:
        return {"status": job.status, "finishedAt": _iso(job.finished_at), "errorCode": job.error_code,
                "errorText": job.error_text, "trackId": job.track_id}

    def _read_pending(self) -> list[dict[str, Any]]:
        with _pending_lock:
            return self._load()

    def _load(self) -> list[dict[str, Any]]:
        try:
            ops = read_json(self._pending).get("ops")
        except FileNotFoundError:
            return []
        except (OSError, ValueError, AttributeError):
            log.warning("ignoring unreadable %s", self._pending)
            return []
        return [op for op in ops if isinstance(op, dict)] if isinstance(ops, list) else []

    def _store(self, ops: list[dict[str, Any]]) -> None:
        if ops:
            write_json_atomic(self._pending, {"ops": ops})
        else:
            self._pending.unlink(missing_ok=True)

    def _enqueue(self, op: str, job_id: str, payload: Mapping[str, Any]) -> None:
        entry = {"op": op, "jobId": job_id, "payload": dict(payload), "at": _iso(self._now())}
        try:
            with _pending_lock:
                self._store(self._load() + [entry])
        except Exception:
            log.error("could not buffer projection %s of job %s: it is lost (reconciliation will not see it)",
                      op, job_id, exc_info=True)

    def _remove_pending(self, gone: list[dict[str, Any]]) -> None:
        with _pending_lock:
            self._store([op for op in self._load() if op not in gone])

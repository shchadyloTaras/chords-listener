"""The background sweep (docs/features/admin T24; ADR-0010; sad §6 «фонові роботи»): ``POST /api/internal/sweep``.

Cloud Scheduler wakes the server at 00:15 and 12:15 UTC with an OIDC token (``AuthMiddleware`` lets only that token
through; everyone else gets the unknown-address 404). The same work also runs on the first natural wake of a UTC day
(``run_wake``, the ``YYYY-MM-DD-wake`` slot).

A sweep claims ``adminSweeps/{slot}`` (create with ``exists=false``; a slot that is done or running is returned as it
is, nothing is redone) and runs its steps in order, recording each in ``steps`` so a retry resumes where the last
attempt stopped:

* ``replay``     drain the projections buffer (``Projections.replay_pending``), so no accepted job is missing;
* ``staleJobs``  ``running`` jobs older than 2 h (an instance restart lost them) close as failures «Інше»;
* ``freeze``     recompute yesterday from ``adminJobs`` (the service account excluded), write the corrected totals and
                 ``newUsers``, log ``stats_mismatch`` when they differ from the live counters, and freeze the day only
                 when no job of it is still running (otherwise the next slot does). Frozen and restored days never
                 change. A day left live two days ago is caught up the same way;
* ``emailIndex`` ``Directory.full_sync``;
* ``purges``     ``deletion.Purger.run``: the accounts whose 7-day window has passed are erased tombstone-first, and
                 interrupted purges are resumed (ADR-0011). A purge that stops raises, so the slot fails and the
                 scheduler's retry resumes it.

A step that raises marks the slot ``failed`` and the endpoint answers 500, so Cloud Scheduler retries (the slot is
taken over and resumed); an instance that died mid-sweep leaves a ``running`` slot that is taken over after 30 min.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.auth import SCHEDULER_KEY, SWEEP_PATH, unknown_endpoint_response
from app.firestore import Document, FirestoreIndex, PreconditionFailed, Transaction, field_path

from . import stats
from .directory import USERS, Directory, parse_time
from .history import JOBS, OTHER, FinishedJob, Projections

log = logging.getLogger("chords.admin")

SWEEPS = "adminSweeps"
FROZEN = "frozen"                       # `adminStats.state` of a closed day
STEPS = ("replay", "staleJobs", "freeze", "emailIndex", "purges")
STALE_AFTER = timedelta(hours=2)        # a job still `running` after this lost its instance
ABANDONED_AFTER = timedelta(minutes=30)  # a `running` slot older than this lost its instance too
SWEEP_RETENTION = timedelta(days=30)    # `adminSweeps.expireAt` = startedAt + 30 d (TTL policy)
STALE_PAGE = 500
STALE_TEXT = "The job did not finish: the server restarted while it was running"
SCHEDULED_MINUTE = 15                   # Cloud Scheduler: 00:15 and 12:15 UTC
CATCH_UP_DAYS = 2                       # yesterday, and the day before if it is still live


class SweepFailed(Exception):
    """A step of the sweep raised; the slot is marked ``failed`` and the scheduler's retry resumes it."""


def _utc(now: datetime) -> datetime:
    return now.astimezone(timezone.utc)


def slot_for(now: datetime) -> str:
    """The scheduled slot ``now`` belongs to: ``YYYY-MM-DDT00:15Z`` before noon UTC, ``...T12:15Z`` after. A call a
    little late (a scheduler retry with back-off) therefore lands in the slot it was meant for."""
    now = _utc(now)
    return f"{now:%Y-%m-%d}T{12 if now.hour >= 12 else 0:02d}:{SCHEDULED_MINUTE:02d}Z"


def wake_slot(now: datetime) -> str:
    """The slot of the first natural wake of ``now``'s UTC day: ``YYYY-MM-DD-wake``."""
    return f"{_utc(now):%Y-%m-%d}-wake"


def _iso(value: Any) -> Optional[str]:
    when = parse_time(value)
    return None if when is None else when.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


class Sweeper:
    """One sweep per slot. ``purge`` is the purge step (``deletion.Purger.run``): a callable run after the index sync."""

    def __init__(
        self,
        db: FirestoreIndex,
        projections: Projections,
        directory: Directory,
        *,
        purge: Optional[Callable[[], Any]] = None,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        sweeps_collection: str = SWEEPS,
        jobs_collection: str = JOBS,
        stats_collection: str = stats.STATS,
        users_collection: str = USERS,
    ) -> None:
        self._db = db
        self._projections = projections
        self._directory = directory
        self._purge: Callable[[], Any] = purge or (lambda: None)
        self._now = now
        self._sweeps = sweeps_collection
        self._jobs = jobs_collection
        self._stats = stats_collection
        self._users = users_collection

    # ----------------------------------------------------------------------- public

    def run(self, slot: Optional[str] = None, *, woke_by: str = "scheduler") -> dict[str, Any]:
        """Sweep ``slot`` (default: the scheduled slot of now) and return its ``SweepRun``. A slot that is done or
        running is returned as it is. Raises ``SweepFailed`` when a step fails (the slot is then ``failed``)."""
        now = self._now()
        slot = slot or slot_for(now)
        log.info("server_wake_by by=%s slot=%s", woke_by, slot)
        record, owned = self._claim(slot, now)
        if not owned:
            return self._run_of(slot, record)
        steps: dict[str, str] = {k: v for k, v in (record.get("steps") or {}).items() if k in STEPS}
        try:
            for name in STEPS:
                if steps.get(name) == "done":
                    continue
                getattr(self, f"_step_{name}")(now)
                self._mark_step(slot, name)
                steps[name] = "done"
            finished = self._now()
            self._db.commit([self._db.update_op(
                f"{self._sweeps}/{slot}", {"state": "done", "finishedAt": finished},
                mask=["state", "finishedAt"], exists=True)])
        except Exception as exc:
            log.error("sweep %s failed after steps %s", slot, sorted(steps), exc_info=True)
            self._mark_failed(slot)
            raise SweepFailed(f"sweep {slot} failed") from exc
        record = self._db.get(f"{self._sweeps}/{slot}")
        return self._run_of(slot, record.data if record else {"state": "done", "steps": steps})

    def run_wake(self) -> Optional[dict[str, Any]]:
        """The sweep of the first natural wake of the UTC day (slot ``YYYY-MM-DD-wake``); a second wake the same
        day just returns the slot. Never raises: None when the sweep failed (the scheduler's slot catches up)."""
        try:
            return self.run(wake_slot(self._now()), woke_by="user")
        except Exception:
            log.warning("the wake sweep failed", exc_info=True)
            return None

    # ----------------------------------------------------------------------- the slot

    def _claim(self, slot: str, now: datetime) -> tuple[dict[str, Any], bool]:
        """Claim ``adminSweeps/{slot}``: create it running (``exists=false``), or take over a failed slot or one
        whose instance died. ``(the slot's record, whether this call owns it)``."""
        path = f"{self._sweeps}/{slot}"
        db = self._db
        fresh = {"state": "running", "steps": {}, "startedAt": now, "finishedAt": None,
                 "expireAt": now + SWEEP_RETENTION}

        def work(tx: Transaction) -> tuple[dict[str, Any], bool]:
            doc = tx.get(path)
            if doc is None:
                tx.commit([db.update_op(path, fresh, exists=False)])
                return dict(fresh), True
            started = parse_time(doc.data.get("startedAt"))
            state = doc.data.get("state")
            abandoned = state == "running" and (started is None or now - started > ABANDONED_AFTER)
            if state == "failed" or abandoned:
                data = {"state": "running", "startedAt": now, "finishedAt": None, "expireAt": now + SWEEP_RETENTION}
                tx.commit([db.update_op(path, data, mask=list(data), exists=True)])
                return {**doc.data, **data}, True
            return doc.data, False

        try:
            return db.run_transaction(work)
        except PreconditionFailed:  # another instance created it between our read and commit
            doc = db.get(path)
            return (doc.data if doc else {}), False

    def _mark_step(self, slot: str, name: str) -> None:
        self._db.commit([self._db.update_op(
            f"{self._sweeps}/{slot}", {"steps": {name: "done"}}, mask=[field_path("steps", name)], exists=True)])

    def _mark_failed(self, slot: str) -> None:
        try:
            self._db.commit([self._db.update_op(
                f"{self._sweeps}/{slot}", {"state": "failed", "finishedAt": self._now()},
                mask=["state", "finishedAt"], exists=True)])
        except Exception:
            log.error("could not mark sweep %s failed (it is taken over after %s)", slot, ABANDONED_AFTER, exc_info=True)

    @staticmethod
    def _run_of(slot: str, data: dict[str, Any]) -> dict[str, Any]:
        """The ``SweepRun`` of the contract."""
        steps = data.get("steps")
        return {
            "slot": slot,
            "state": data.get("state", "running"),
            "steps": {k: v for k, v in steps.items() if k in STEPS} if isinstance(steps, dict) else {},
            "startedAt": _iso(data.get("startedAt")),
            "finishedAt": _iso(data.get("finishedAt")),
        }

    # ----------------------------------------------------------------------- the steps

    def _step_replay(self, now: datetime) -> None:
        self._projections.replay_pending()

    def _step_staleJobs(self, now: datetime) -> None:  # noqa: N802 - named after its step
        cutoff = now - STALE_AFTER
        closed = 0
        while True:
            batch = self._db.run_query(
                self._jobs, filters=[("status", "==", "running"), ("acceptedAt", "<", cutoff)], limit=STALE_PAGE)
            progress = 0
            for doc in batch:
                # `error` + no error code = the reason «Інше»; it counts a failure into a live day, like any failure
                finish = FinishedJob(id=doc.id, status="error", finished_at=now, error_text=STALE_TEXT)
                if self._projections.finish(finish):
                    progress += 1
            closed += progress
            if len(batch) < STALE_PAGE or progress == 0:  # the last page, or Firestore is refusing: the buffer holds the rest
                break
        if closed:
            log.info("closed %d stale job(s) as «other»", closed)

    def _step_freeze(self, now: datetime) -> None:
        today = stats.day_start(stats.utc_day(now))
        for back in range(CATCH_UP_DAYS, 0, -1):
            day = stats.utc_day(today - timedelta(days=back))
            self._reconcile(day, now, create=back == 1)

    def _step_emailIndex(self, now: datetime) -> None:  # noqa: N802
        self._directory.full_sync()

    def _step_purges(self, now: datetime) -> None:
        self._purge()

    # ----------------------------------------------------------------------- reconcile and freeze one day

    def _reconcile(self, day: str, now: datetime, *, create: bool) -> None:
        """Recompute ``day`` from the job history and write it back; freeze it unless a job of it is still running.
        A frozen or restored day is left as it is; a missing one is created only when ``create``."""
        start = stats.day_start(day)
        new_users = self._db.count(
            self._users, filters=[("createdAt", ">=", start), ("createdAt", "<", start + timedelta(days=1))])
        path = stats.day_path(day, self._stats)
        db = self._db

        def work(tx: Transaction) -> Optional[tuple[int, bool]]:
            doc = tx.get(path)
            if doc is None and not create:
                return None
            if doc is not None and doc.data.get("state") != stats.LIVE:
                return None  # frozen (ADR-0010) or restored (AC-08): never changes
            jobs = tx.run_query(self._jobs, filters=[("day", "==", day)])
            totals, running = self._recompute(jobs)
            live = doc.data if doc is not None else {}
            diff = self._diff(live, totals)
            data: dict[str, Any] = {**totals, "newUsers": new_users, "reconciledDiff": diff, "updatedAt": now}
            if not running:
                data.update(state=FROZEN,frozenAt=now)
            if doc is None:
                tx.commit([db.update_op(path, {**stats.empty_day(now), **data}, exists=False)])
            else:
                tx.commit([db.update_op(path, data, mask=list(data), exists=True)])
            return diff, not running

        try:
            outcome = db.run_transaction(work)
        except PreconditionFailed:  # the day appeared (or vanished) under us: the next slot reconciles it
            log.warning("could not reconcile %s: the day changed under the sweep", day)
            return
        if outcome is None:
            return
        diff, frozen = outcome
        if diff:
            log.warning("stats_mismatch day=%s diff=%d", day, diff)
        log.info("reconciled %s (%s, diff=%d)", day, "frozen" if frozen else "left live: a job is still running", diff)

    @staticmethod
    def _recompute(jobs: list[Document]) -> tuple[dict[str, Any], bool]:
        """The day's counters from its job records (the service account excluded), and whether a job still runs."""
        analyses = {origin: 0 for origin in stats.ORIGINS}
        vocals = failed = 0
        by_reason: dict[str, int] = {}
        active: set[str] = set()
        running = False
        for job in jobs:
            data = job.data
            if data.get("service"):
                continue
            if data.get("kind") == "vocals":
                vocals += 1
            elif data.get("origin") in analyses:
                analyses[data["origin"]] += 1
            if data.get("status") == "error":
                failed += 1
                reason = data.get("reason") or OTHER
                by_reason[reason] = by_reason.get(reason, 0) + 1
            running = running or data.get("status") == "running"
            active.add(str(data.get("uid")))
        totals = {"analyses": analyses, "vocals": vocals, "failed": failed, "failedByReason": by_reason,
                  "active": len(active)}
        return totals, running

    @staticmethod
    def _diff(live: dict[str, Any], totals: dict[str, Any]) -> int:
        """Σ |live − recomputed| over every counter."""
        live_analyses = live.get("analyses") if isinstance(live.get("analyses"), dict) else {}
        live_reasons = live.get("failedByReason") if isinstance(live.get("failedByReason"), dict) else {}
        diff = sum(abs(_int(live_analyses.get(o)) - n) for o, n in totals["analyses"].items())
        diff += sum(abs(_int(live_reasons.get(r)) - totals["failedByReason"].get(r, 0))
                    for r in set(live_reasons) | set(totals["failedByReason"]))
        for key in ("vocals", "failed", "active"):
            diff += abs(_int(live.get(key)) - totals[key])
        return diff


# --------------------------------------------------------------------------- the endpoint

internal_router = APIRouter(include_in_schema=False)


@internal_router.post(SWEEP_PATH)
def run_sweep(request: Request) -> Any:
    """Cloud Scheduler's call. Only a request ``AuthMiddleware`` verified as the scheduler gets here; without it (an
    unverified caller, local mode, no sweeper configured) the answer is the unknown-address 404."""
    sweeper: Optional[Sweeper] = getattr(request.app.state, "sweeper", None)
    if sweeper is None or not request.scope.get("state", {}).get(SCHEDULER_KEY):
        return unknown_endpoint_response(request.scope["path"])
    try:
        return JSONResponse(sweeper.run(woke_by="scheduler"))
    except SweepFailed:
        return JSONResponse({"detail": "Internal server error", "code": "internal"}, status_code=500)

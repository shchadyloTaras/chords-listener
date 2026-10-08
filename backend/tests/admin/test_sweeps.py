"""The background sweep (docs/features/admin T24; AC-08, ADR-0010; sad §6 «фонові роботи»).

``POST /api/internal/sweep`` is called by Cloud Scheduler with a Google OIDC token; the same work also runs on the
first natural wake after 00:00 UTC (the ``-wake`` slot). One sweep claims ``adminSweeps/{slot}`` (``exists=false``),
then runs its steps in order: replay the projections buffer, close stale jobs, reconcile and freeze yesterday, sync
the email index, purges (a hook until T25).

The flows run twice: on the in-memory ``MemDb`` and on the
Firestore emulator (skipped unless ``FIRESTORE_EMULATOR_HOST`` is set). Each test uses its own collections.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from admin.fixtures import MemDb
from app.admin import directory as dirmod
from app.admin import history, stats
from app.admin.directory import Directory
from app.admin.history import AcceptedJob, Projections
from app.admin.sweeps import STEPS, SweepFailed, Sweeper, slot_for, wake_slot
from app.auth import AuthError, AuthUnavailable, SchedulerTokenVerifier
from app.firestore import Document, FirestoreIndex
from app.main import create_app
from app.models import Settings
from app.users import SMOKE_UID

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

EMULATOR_HOST = os.environ.get("FIRESTORE_EMULATOR_HOST")
UTC = timezone.utc
NOW = datetime(2026, 10, 8, 0, 15, 30, tzinfo=UTC)   # the 00:15 slot of 2026-10-08
YESTERDAY = "2026-10-07"
SLOT = "2026-10-08T00:15Z"
PROJECT = "build-chords-listener"
SCHEDULER_EMAIL = "chords-scheduler@build-chords-listener.iam.gserviceaccount.com"
AUDIENCE = "https://chords-listener-test.run.app"
LOG = "chords.admin"


# --------------------------------------------------------------------------- the databases


class Clock:
    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta: float) -> None:
        self.now += timedelta(**delta)


class Env:
    def __init__(self, db: FirestoreIndex, tmp_path: Path, tag: str) -> None:
        self.db = db
        self.tag = tag
        self.clock = Clock()
        self.sweeps, self.jobs, self.stats = f"t24_sweeps_{tag}", f"t24_jobs_{tag}", f"t24_stats_{tag}"
        self.users, self.index = f"t24_users_{tag}", f"t24_index_{tag}"
        self.pending = tmp_path / "admin" / "projections-pending.json"
        self.projections = Projections(db, self.pending, jobs_collection=self.jobs, stats_collection=self.stats,
                                       now=self.clock)
        self.directory = Directory(db, users_collection=self.users, index_collection=self.index, now=self.clock)
        self.purges: list[datetime] = []
        self.sweeper = Sweeper(
            db, self.projections, self.directory, purge=lambda: self.purges.append(self.clock()), now=self.clock,
            sweeps_collection=self.sweeps, jobs_collection=self.jobs, stats_collection=self.stats,
            users_collection=self.users,
        )

    @staticmethod
    def groups(tag: str) -> dict[str, str]:
        """This test's collections -> the real ones they stand for (whose indexes apply)."""
        return {f"t24_sweeps_{tag}": "adminSweeps", f"t24_jobs_{tag}": "adminJobs", f"t24_stats_{tag}": "adminStats",
                f"t24_users_{tag}": "users", f"t24_index_{tag}": "adminEmailIndex"}

    # ----- seeding and reading
    def put(self, collection: str, doc_id: str, data: dict[str, Any]) -> None:
        self.db.commit([self.db.update_op(f"{collection}/{doc_id}", data)])

    def job(self, job_id: str, *, uid: str = "u1", at: Optional[datetime] = None, status: str = "done",
            origin: str = "link", kind: str = "analysis", reason: Optional[str] = None,
            service: bool = False, day: Optional[str] = None) -> str:
        at = at or datetime(2026, 10, 7, 12, 0, tzinfo=UTC)
        self.put(self.jobs, job_id, {
            "uid": uid, "service": service, "kind": kind, "origin": origin, "status": status,
            "reason": reason if status == "error" else None, "errorText": None, "title": "Song", "trackId": None,
            "acceptedAt": at, "finishedAt": None if status == "running" else at + timedelta(seconds=30),
            "day": day or stats.utc_day(at), "expireAt": at + timedelta(days=90), "anonymizedAt": None,
        })
        return job_id

    def user(self, uid: str, created: datetime, email: Optional[str] = None) -> None:
        self.put(self.users, uid, {"email": email or f"{uid}@example.test", "createdAt": created})

    def day_doc(self, day: str, state: str = "live", **fields: Any) -> None:
        data = stats.empty_day(datetime(2026, 10, 7, 20, 0, tzinfo=UTC))
        data["state"] = state
        if state == "frozen":
            data["frozenAt"] = datetime(2026, 10, 8, 0, 20, tzinfo=UTC)
        data.update(fields)
        self.put(self.stats, day, data)

    def day(self, day: str = YESTERDAY) -> Optional[dict[str, Any]]:
        d = self.db.get(f"{self.stats}/{day}")
        return d.data if d else None

    def job_doc(self, job_id: str) -> dict[str, Any]:
        d = self.db.get(f"{self.jobs}/{job_id}")
        assert d is not None, job_id
        return d.data

    def sweep_doc(self, slot: str = SLOT) -> Optional[dict[str, Any]]:
        d = self.db.get(f"{self.sweeps}/{slot}")
        return d.data if d else None

    def shards(self) -> list[Document]:
        return self.db.run_query(self.index)


@pytest.fixture(params=["fake", pytest.param("emulator", marks=pytest.mark.skipif(
    not EMULATOR_HOST, reason="needs the Firestore emulator (FIRESTORE_EMULATOR_HOST)"))])
def env(request, tmp_path) -> Env:
    tag = uuid.uuid4().hex[:10]
    # offline, every query and count the sweep makes must be one the deployed indexes serve (T58)
    db: FirestoreIndex = (MemDb(indexed=True, aggregations=("count",), aliases=Env.groups(tag)) if request.param == "fake"
                          else FirestoreIndex(PROJECT, emulator_host=EMULATOR_HOST))
    return Env(db, tmp_path, tag)


def records(caplog: pytest.LogCaptureFixture, text: str) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == LOG and text in r.getMessage()]


# ===================================================================== slots


@pytest.mark.parametrize(("when", "slot"), [
    (datetime(2026, 10, 8, 0, 15, 2, tzinfo=UTC), "2026-10-08T00:15Z"),
    (datetime(2026, 10, 8, 0, 40, tzinfo=UTC), "2026-10-08T00:15Z"),     # a retry with back-off lands in the same slot
    (datetime(2026, 10, 8, 11, 59, tzinfo=UTC), "2026-10-08T00:15Z"),
    (datetime(2026, 10, 8, 12, 15, 1, tzinfo=UTC), "2026-10-08T12:15Z"),
    (datetime(2026, 10, 8, 23, 59, tzinfo=UTC), "2026-10-08T12:15Z"),
    (datetime(2026, 10, 8, 2, 15, tzinfo=timezone(timedelta(hours=2))), "2026-10-08T00:15Z"),  # always UTC
])
def test_the_slot_is_derived_from_the_current_utc_time(when, slot):
    assert slot_for(when) == slot


def test_the_wake_slot_is_one_per_utc_day():
    assert wake_slot(datetime(2026, 10, 8, 3, 0, tzinfo=UTC)) == "2026-10-08-wake"
    assert wake_slot(datetime(2026, 10, 8, 23, 0, tzinfo=UTC)) == "2026-10-08-wake"


def test_the_steps_run_in_the_documented_order():
    assert STEPS == ("replay", "staleJobs", "freeze", "emailIndex", "purges")


# ===================================================================== AC-08: the slot is claimed once


def test_a_sweep_claims_its_slot_and_runs_every_step(env):
    run = env.sweeper.run()
    assert run["slot"] == SLOT and run["state"] == "done"
    assert run["steps"] == {step: "done" for step in STEPS}
    assert run["startedAt"].startswith("2026-10-08T00:15:30") and run["finishedAt"].startswith("2026-10-08T00:15:30")
    doc = env.sweep_doc()
    assert doc["state"] == "done" and doc["steps"] == {step: "done" for step in STEPS}
    assert dirmod.parse_time(doc["expireAt"]) == NOW + timedelta(days=30)   # TTL: startedAt + 30 d


def test_the_second_call_for_the_same_slot_is_a_no_op(env, monkeypatch):
    first = env.sweeper.run()
    calls: list[str] = []
    monkeypatch.setattr(env.directory, "full_sync", lambda: calls.append("full_sync") or 0)
    monkeypatch.setattr(env.projections, "replay_pending", lambda: calls.append("replay") or 0)
    env.clock.advance(minutes=3)                       # Cloud Scheduler retried a little later: same slot
    again = env.sweeper.run()
    assert again == first                              # the state of the slot, untouched
    assert calls == [] and env.purges == [NOW]
    assert env.sweep_doc()["startedAt"] == first["startedAt"]


def test_a_slot_that_is_still_running_is_not_started_again(env):
    env.put(env.sweeps, SLOT, {"state": "running", "steps": {"replay": "done"}, "startedAt": NOW - timedelta(minutes=1),
                               "finishedAt": None, "expireAt": NOW + timedelta(days=30)})
    run = env.sweeper.run()
    assert run["state"] == "running" and run["steps"] == {"replay": "done"} and run["finishedAt"] is None
    assert env.purges == []


def test_a_running_slot_whose_instance_died_is_taken_over(env):
    env.put(env.sweeps, SLOT, {"state": "running", "steps": {"replay": "done"}, "startedAt": NOW - timedelta(hours=2),
                               "finishedAt": None, "expireAt": NOW + timedelta(days=30)})
    run = env.sweeper.run()
    assert run["state"] == "done" and run["steps"] == {step: "done" for step in STEPS}


def test_two_sweeps_at_once_run_the_slot_once(env):
    import threading

    started = threading.Barrier(2)
    calls: list[int] = []
    real = env.directory.full_sync

    def counted() -> int:
        calls.append(1)
        return real()

    env.directory.full_sync = counted  # type: ignore[method-assign]
    out: list[dict[str, Any]] = []

    def go() -> None:
        started.wait()
        out.append(env.sweeper.run())

    threads = [threading.Thread(target=go) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(calls) == 1 and len(out) == 2
    assert {o["state"] for o in out} <= {"done", "running"}


# ===================================================================== AC-08: a failed step is resumed, not redone


def test_a_failing_step_marks_the_slot_failed_and_the_retry_resumes_after_the_last_done_step(env, monkeypatch):
    replays: list[int] = []
    real_replay = env.projections.replay_pending
    monkeypatch.setattr(env.projections, "replay_pending", lambda: replays.append(1) or real_replay())

    def boom() -> int:
        raise RuntimeError("index sync down")

    monkeypatch.setattr(env.directory, "full_sync", boom)
    with pytest.raises(SweepFailed):
        env.sweeper.run()
    doc = env.sweep_doc()
    assert doc["state"] == "failed" and doc["steps"] == {"replay": "done", "staleJobs": "done", "freeze": "done"}
    assert env.purges == []                             # nothing after the failed step ran
    monkeypatch.undo()
    monkeypatch.setattr(env.projections, "replay_pending", lambda: replays.append(1) or real_replay())
    env.clock.advance(minutes=2)
    run = env.sweeper.run()
    assert run["state"] == "done" and run["steps"] == {step: "done" for step in STEPS}
    assert len(replays) == 1                            # the retry did not repeat the finished steps
    assert env.purges != []


# ===================================================================== step 1: replay the projections buffer


def test_the_sweep_replays_the_buffered_projections_before_it_counts_the_day(env):
    accepted = datetime(2026, 10, 7, 9, 0, tzinfo=UTC)
    env.projections._enqueue("accept", "j-buffered", env.projections._accept_payload(
        AcceptedJob(id="j-buffered", uid="u1", kind="analysis", origin="file", accepted_at=accepted)))
    assert env.pending.exists()
    env.sweeper.run()
    assert not env.pending.exists()
    assert env.job_doc("j-buffered")["origin"] == "file"
    # the replayed job is part of the frozen totals of its day
    assert env.day()["analyses"]["file"] == 1


# ===================================================================== step 2: stale jobs


def test_running_jobs_older_than_two_hours_close_as_other(env):
    old = NOW - timedelta(hours=3)
    env.job("stale", at=old, status="running", origin="link", day="2026-10-07")
    env.day_doc("2026-10-07", analyses={"link": 1, "file": 0, "mic": 0, "tab": 0}, active=1)
    env.sweeper.run()
    j = env.job_doc("stale")
    assert j["status"] == "error" and j["reason"] == "other" and j["finishedAt"] is not None
    assert j["errorText"]


def test_a_job_running_for_less_than_two_hours_is_left_alone(env):
    env.job("fresh", at=NOW - timedelta(minutes=119), status="running", day="2026-10-07")
    env.job("edge", at=NOW - timedelta(hours=2, minutes=1), status="running", day="2026-10-07")
    env.sweeper.run()
    assert env.job_doc("fresh")["status"] == "running"
    assert env.job_doc("edge")["status"] == "error"


def test_a_job_that_is_not_running_is_not_touched_by_the_stale_step(env):
    env.job("done", at=NOW - timedelta(hours=9), status="done")
    before = env.job_doc("done")
    env.sweeper.run()
    assert env.job_doc("done") == before


def test_closing_a_stale_job_counts_one_failure_into_the_live_day_it_was_accepted_on(env):
    at = datetime(2026, 10, 8, 0, 5, tzinfo=UTC) - timedelta(hours=3)         # 21:05 on the 7th
    env.projections.accept(AcceptedJob(id="s1", uid="u1", kind="analysis", origin="link", accepted_at=at))
    env.sweeper.run()
    day = env.day("2026-10-07")
    assert env.job_doc("s1")["reason"] == "other"
    assert day["failed"] == 1 and day["failedByReason"] == {"other": 1}
    assert day["state"] == "frozen"                      # nothing is left running: the day is closed in the same sweep


# ===================================================================== step 3: reconcile and freeze yesterday


def seed_busy_day(env: Env) -> None:
    t = datetime(2026, 10, 7, 10, 0, tzinfo=UTC)
    env.job("a1", uid="u1", at=t, origin="link")
    env.job("a2", uid="u1", at=t + timedelta(hours=1), origin="link")
    env.job("a3", uid="u2", at=t + timedelta(hours=2), origin="file")
    env.job("a4", uid="u3", at=t + timedelta(hours=3), origin="mic", status="error", reason="too_long")
    env.job("a5", uid="u3", at=t + timedelta(hours=4), origin="tab", status="error", reason="youtube_blocked")
    env.job("v1", uid="u2", at=t + timedelta(hours=5), kind="vocals", origin="file")
    env.job("svc", uid=SMOKE_UID, at=t + timedelta(hours=6), origin="link", service=True)   # never counted
    env.job("svc2", uid=SMOKE_UID, at=t + timedelta(hours=7), origin="link", status="error", reason="other",
            service=True)
    env.job("other-day", uid="u9", at=datetime(2026, 10, 6, 23, 59, tzinfo=UTC), origin="link")
    env.user("n1", datetime(2026, 10, 7, 0, 0, tzinfo=UTC))        # the day starts: counted
    env.user("n2", datetime(2026, 10, 7, 23, 59, tzinfo=UTC))
    env.user("old", datetime(2026, 10, 6, 23, 59, tzinfo=UTC))
    env.user("tomorrow", datetime(2026, 10, 8, 0, 0, tzinfo=UTC))   # the day ends: not counted


def test_yesterday_is_recomputed_from_the_job_history_and_frozen(env):
    seed_busy_day(env)
    env.day_doc(YESTERDAY, analyses={"link": 9, "file": 0, "mic": 0, "tab": 0}, active=9)   # the live counters drifted
    env.sweeper.run()
    day = env.day()
    assert day["state"] == "frozen"
    assert day["analyses"] == {"link": 2, "file": 1, "mic": 1, "tab": 1}
    assert day["vocals"] == 1
    assert day["failed"] == 2 and day["failedByReason"] == {"too_long": 1, "youtube_blocked": 1}
    assert day["active"] == 3                                   # u1, u2, u3: the service account is not a user
    assert day["newUsers"] == 2
    assert day["frozenAt"] is not None and dirmod.parse_time(day["frozenAt"]) == NOW
    # |live - recomputed| summed over every counter: link 7, file 1, mic 1, tab 1, vocals 1, failed 2,
    # failedByReason 1 + 1, active 6
    assert day["reconciledDiff"] == 21


def test_the_service_account_is_excluded_from_the_recomputed_day(env):
    env.job("svc", uid=SMOKE_UID, origin="link", service=True)
    env.job("svc-running", uid=SMOKE_UID, origin="link", status="running", service=True,
            at=datetime(2026, 10, 7, 23, 59, tzinfo=UTC))
    env.sweeper.run()
    day = env.day()
    assert day["analyses"] == {"link": 0, "file": 0, "mic": 0, "tab": 0} and day["active"] == 0
    assert day["state"] == "frozen"                              # a running service job does not hold the day open


def test_yesterday_without_a_stats_document_is_created_frozen_from_the_history(env):
    env.job("a1", origin="file")
    assert env.day() is None
    env.sweeper.run()
    day = env.day()
    assert day["state"] == "frozen" and day["analyses"]["file"] == 1 and day["active"] == 1


def test_a_quiet_yesterday_is_frozen_with_zeros(env):
    env.sweeper.run()
    day = env.day()
    assert day["state"] == "frozen" and day["active"] == 0 and day["failed"] == 0 and day["newUsers"] == 0
    assert day["reconciledDiff"] == 0


def test_a_day_with_a_job_still_running_gets_corrected_totals_but_stays_live(env):
    late = datetime(2026, 10, 7, 23, 50, tzinfo=UTC)               # 25 min before the sweep: not stale yet
    env.job("late", uid="u1", at=late, status="running", origin="link")
    env.job("early", uid="u2", at=datetime(2026, 10, 7, 8, 0, tzinfo=UTC), origin="file")
    env.day_doc(YESTERDAY, analyses={"link": 1, "file": 1, "mic": 0, "tab": 0}, active=2)
    env.sweeper.run()
    day = env.day()
    assert day["state"] == "live" and day["frozenAt"] is None
    assert day["analyses"] == {"link": 1, "file": 1, "mic": 0, "tab": 0} and day["active"] == 2


def test_the_next_slot_freezes_the_day_once_the_late_job_has_failed(env):
    env.projections.accept(AcceptedJob(id="late", uid="u1", kind="analysis", origin="link",
                                       accepted_at=datetime(2026, 10, 7, 23, 50, tzinfo=UTC)))
    env.sweeper.run()
    assert env.day()["state"] == "live"
    env.clock.now = datetime(2026, 10, 8, 12, 15, 5, tzinfo=UTC)    # the 12:15 slot: the job is now 12 h old
    run = env.sweeper.run()
    assert run["slot"] == "2026-10-08T12:15Z"
    day = env.day()
    assert day["state"] == "frozen"
    assert day["failed"] == 1 and day["failedByReason"] == {"other": 1}   # the late failure is not lost from its day


def test_stats_mismatch_is_logged_when_the_totals_differ(env, caplog):
    env.job("a1", origin="link")
    env.day_doc(YESTERDAY, analyses={"link": 3, "file": 0, "mic": 0, "tab": 0}, active=1)
    with caplog.at_level(logging.INFO, logger=LOG):
        env.sweeper.run()
    found = records(caplog, "stats_mismatch")
    assert len(found) == 1 and YESTERDAY in found[0].getMessage() and "diff=2" in found[0].getMessage()
    assert found[0].levelno >= logging.WARNING
    assert env.day()["reconciledDiff"] == 2


def test_no_stats_mismatch_is_logged_when_the_totals_agree(env, caplog):
    env.job("a1", origin="link")
    env.day_doc(YESTERDAY, analyses={"link": 1, "file": 0, "mic": 0, "tab": 0}, active=1)
    with caplog.at_level(logging.INFO, logger=LOG):
        env.sweeper.run()
    assert records(caplog, "stats_mismatch") == []
    assert env.day()["reconciledDiff"] == 0


def test_a_frozen_day_does_not_change_after_a_later_delete(env):
    seed_busy_day(env)
    env.sweeper.run()
    frozen = env.day()
    # the user is deleted later: their jobs go (or are anonymized), their account leaves the users collection
    for job_id in ("a1", "a2", "a4"):
        env.db.commit([env.db.delete_op(f"{env.jobs}/{job_id}")])
    env.db.commit([env.db.delete_op(f"{env.users}/n1")])
    env.clock.now = datetime(2026, 10, 8, 12, 15, 5, tzinfo=UTC)
    env.sweeper.run()                                              # the 12:15 slot looks at yesterday again
    assert env.day() == frozen


def test_a_restored_day_is_never_reconciled(env):
    env.day_doc(YESTERDAY, state="restored", analyses={"link": 0, "file": 4, "mic": 0, "tab": 0},
                restoredTracks={"youtube": 1, "url": 1, "file": 2})
    env.job("a1", origin="link")
    before = env.day()
    env.sweeper.run()
    assert env.day() == before


def test_a_day_left_live_two_days_ago_is_caught_up(env):
    env.job("old", at=datetime(2026, 10, 6, 10, 0, tzinfo=UTC), origin="tab", day="2026-10-06")
    env.day_doc("2026-10-06", analyses={"link": 0, "file": 0, "mic": 0, "tab": 1}, active=1)
    env.sweeper.run()
    assert env.day("2026-10-06")["state"] == "frozen"


def test_today_is_never_frozen(env):
    env.day_doc("2026-10-08", analyses={"link": 2, "file": 0, "mic": 0, "tab": 0}, active=1)
    before = env.day("2026-10-08")
    env.sweeper.run()
    assert env.day("2026-10-08") == before


def test_reconciliation_reads_the_job_history_not_the_live_counters_so_a_second_run_changes_nothing(env):
    seed_busy_day(env)
    env.sweeper.run()
    frozen = env.day()
    env.clock.now = datetime(2026, 10, 8, 12, 15, 5, tzinfo=UTC)
    env.sweeper.run()
    assert env.day() == frozen


# ===================================================================== steps 4-5: the email index and the purge hook


def test_the_sweep_rebuilds_the_email_index(env):
    env.user("u1", datetime(2026, 10, 1, tzinfo=UTC), email="Alice@Example.Test")
    env.user("u2", datetime(2026, 10, 2, tzinfo=UTC), email="bob@example.test")
    env.sweeper.run()
    shards = env.shards()
    assert len(shards) == 1
    assert shards[0].data["entries"] == {"u1": "alice@example.test", "u2": "bob@example.test"}


def test_the_purge_step_runs_last_and_defaults_to_a_no_op(env):
    order: list[str] = []
    real = env.directory.full_sync
    env.directory.full_sync = lambda: order.append("emailIndex") or real()  # type: ignore[method-assign]
    env.sweeper._purge = lambda: order.append("purges")
    run = env.sweeper.run()
    assert order == ["emailIndex", "purges"] and run["steps"]["purges"] == "done"
    bare = Sweeper(env.db, env.projections, env.directory, now=env.clock, sweeps_collection=env.sweeps + "b",
                   jobs_collection=env.jobs, stats_collection=env.stats, users_collection=env.users)
    assert bare.run()["steps"]["purges"] == "done"


# ===================================================================== server_wake_by and the wake slot


def test_server_wake_by_is_logged_for_a_scheduler_sweep(env, caplog):
    with caplog.at_level(logging.INFO, logger=LOG):
        env.sweeper.run(woke_by="scheduler")
    found = records(caplog, "server_wake_by")
    assert len(found) == 1 and "by=scheduler" in found[0].getMessage() and f"slot={SLOT}" in found[0].getMessage()


def test_the_first_natural_wake_runs_the_wake_slot_once_a_day(env, caplog):
    env.clock.now = datetime(2026, 10, 8, 6, 30, tzinfo=UTC)
    with caplog.at_level(logging.INFO, logger=LOG):
        run = env.sweeper.run_wake()
    assert run is not None and run["slot"] == "2026-10-08-wake" and run["state"] == "done"
    assert "by=user" in records(caplog, "server_wake_by")[0].getMessage()
    env.clock.advance(hours=3)                                       # a second wake the same day: nothing to do
    assert env.sweeper.run_wake()["state"] == "done"
    assert env.purges == [datetime(2026, 10, 8, 6, 30, tzinfo=UTC)]
    env.clock.now = datetime(2026, 10, 9, 0, 5, tzinfo=UTC)         # the next day's first wake runs its own slot
    assert env.sweeper.run_wake()["slot"] == "2026-10-09-wake"
    assert len(env.purges) == 2


def test_a_wake_sweep_that_fails_does_not_raise(env, monkeypatch):
    monkeypatch.setattr(env.directory, "full_sync", lambda: (_ for _ in ()).throw(RuntimeError("down")))
    assert env.sweeper.run_wake() is None
    assert env.sweep_doc("2026-10-08-wake")["state"] == "failed"


# ===================================================================== the OIDC token check


@pytest.fixture(scope="module")
def keys() -> SimpleNamespace:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    def make() -> tuple[str, str]:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        private = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                    serialization.NoEncryption()).decode()
        public = key.public_key().public_bytes(serialization.Encoding.PEM,
                                               serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        return private, public

    (p1, k1), (p2, k2) = make(), make()
    return SimpleNamespace(private=p1, public=k1, other_private=p2)


def oidc_claims(now: float, **over: Any) -> dict[str, Any]:
    claims = {"iss": "https://accounts.google.com", "aud": AUDIENCE, "sub": "1234567890", "email": SCHEDULER_EMAIL,
              "email_verified": True, "iat": int(now) - 10, "exp": int(now) + 3600}
    claims.update(over)
    return {k: v for k, v in claims.items() if v is not ...}


def sign(private_pem: str, claims: dict[str, Any], kid: str = "k1") -> str:
    from google.auth import crypt, jwt

    return jwt.encode(crypt.RSASigner.from_string(private_pem, key_id=kid), claims).decode()


def test_the_scheduler_token_verifier_accepts_only_the_scheduler_account(keys):
    now = time.time()
    fetches: list[int] = []

    def fetch() -> tuple[dict[str, str], float]:
        fetches.append(1)
        return {"k1": keys.public}, 600.0

    v = SchedulerTokenVerifier(AUDIENCE, SCHEDULER_EMAIL, fetch_certs=fetch, clock=lambda: now)
    assert v.verify(sign(keys.private, oidc_claims(now))) == SCHEDULER_EMAIL
    assert v.verify(sign(keys.private, oidc_claims(now, iss="accounts.google.com"))) == SCHEDULER_EMAIL
    assert v.verify(sign(keys.private, oidc_claims(now, email=SCHEDULER_EMAIL.upper()))) == SCHEDULER_EMAIL
    assert len(fetches) == 1                                         # the certificates are cached
    good = sign(keys.private, oidc_claims(now))
    head, payload, sig = good.split(".")
    forged = json.loads(base64.urlsafe_b64decode(payload + "=="))
    forged["email"] = "attacker@example.test"
    forged_token = f"{head}.{base64.urlsafe_b64encode(json.dumps(forged).encode()).decode().rstrip('=')}.{sig}"
    bad = [
        sign(keys.private, oidc_claims(now, email="someone@example.test")),                # another account
        sign(keys.private, oidc_claims(now, email="x" + SCHEDULER_EMAIL)),
        sign(keys.private, oidc_claims(now, email=...)),                                    # no email at all
        sign(keys.private, oidc_claims(now, email_verified=False)),
        sign(keys.private, oidc_claims(now, email_verified="true")),
        sign(keys.private, oidc_claims(now, aud="https://other.run.app")),                  # another audience
        sign(keys.private, oidc_claims(now, iss="https://securetoken.google.com/" + PROJECT)),   # a Firebase ID token
        sign(keys.private, oidc_claims(now, iss="https://evil.example")),
        sign(keys.private, oidc_claims(now, exp=int(now) - 3600, iat=int(now) - 7200)),    # expired
        sign(keys.private, oidc_claims(now), kid="unknown"),
        sign(keys.other_private, oidc_claims(now)),                                         # signed by another key
        forged_token,
        "not.a.token",
        "",
    ]
    for token in bad:
        with pytest.raises(AuthError):
            v.verify(token)


def test_a_scheduler_verifier_without_an_audience_or_email_accepts_nothing(keys):
    now = time.time()
    for audience, email in (("", SCHEDULER_EMAIL), (AUDIENCE, "")):
        v = SchedulerTokenVerifier(audience, email, fetch_certs=lambda: ({"k1": keys.public}, 600.0), clock=lambda: now)
        with pytest.raises(AuthError):
            v.verify(sign(keys.private, oidc_claims(now, aud=audience or "", email=email or SCHEDULER_EMAIL)))


def test_unreachable_google_certificates_are_unavailable_not_invalid(keys):
    now = time.time()

    def down() -> tuple[dict[str, str], float]:
        raise OSError("down")

    v = SchedulerTokenVerifier(AUDIENCE, SCHEDULER_EMAIL, fetch_certs=down, clock=lambda: now)
    with pytest.raises(AuthUnavailable):
        v.verify(sign(keys.private, oidc_claims(now)))


# ===================================================================== the endpoint


class FakeScheduler:
    """``Bearer sched-ok`` is the scheduler; ``sched-down`` makes the certificates unreachable."""

    def verify(self, token: str) -> str:
        if token == "sched-ok":
            return SCHEDULER_EMAIL
        if token == "sched-down":
            raise AuthUnavailable("certs unreachable")
        raise AuthError("not the scheduler")


class FakeFirebase:
    def verify(self, token: str) -> str:
        if token.startswith("tok-"):
            return token[4:]
        raise AuthError("Invalid token")


def unknown(path: str = "/api/internal/sweep") -> dict[str, str]:
    return {"detail": f"Unknown API endpoint: {path}", "code": "not_found"}


@pytest.fixture
def client(env, tmp_path):
    def make(*, cloud: bool = True, scheduler: Any = FakeScheduler(), sweeper: Any = ...) -> TestClient:
        settings = Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist",
                            auth="firebase" if cloud else "off", signing_key="test-signing-key-0123456789abcdef",
                            publish=False, allowed_hosts=("testserver", "localhost"))
        app = create_app(settings, analyzer=lambda *_a, **_k: {}, engine_info_fn=lambda: {"name": "f", "version": "1",
                                                                                      "features": {}},
                         token_verifier=FakeFirebase(), admin_db=env.db,
                         sweeper=env.sweeper if sweeper is ... else sweeper, scheduler_verifier=scheduler)
        return TestClient(app, raise_server_exceptions=False)

    return make


def test_the_scheduler_token_runs_the_sweep(env, client):
    res = client().post("/api/internal/sweep", headers={"Authorization": "Bearer sched-ok"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body) == {"slot", "state", "steps", "startedAt", "finishedAt"}      # the SweepRun of the contract
    assert body["slot"] == SLOT and body["state"] == "done" and body["steps"] == {s: "done" for s in STEPS}
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z", body["startedAt"])
    assert env.sweep_doc()["state"] == "done"


def test_a_repeated_call_returns_the_state_of_the_slot(env, client):
    c = client()
    first = c.post("/api/internal/sweep", headers={"Authorization": "Bearer sched-ok"}).json()
    second = c.post("/api/internal/sweep", headers={"Authorization": "Bearer sched-ok"})
    assert second.status_code == 200 and second.json() == first
    assert len(env.purges) == 1


@pytest.mark.parametrize("headers", [
    {},                                                    # no credentials
    {"Authorization": "Bearer tok-alice"},                 # an ordinary signed-in user
    {"Authorization": "Bearer tok-admin-1"},               # even an admin
    {"Authorization": "Bearer sched-bad"},                 # a token that is not the scheduler's
    {"Authorization": "Basic c2NoZWQ6b2s="},
    {"Authorization": "Bearer"},
    {"X-Smoke-Key": "x" * 20},
])
def test_a_non_scheduler_caller_gets_the_unknown_route_404(env, client, headers):
    res = client().post("/api/internal/sweep", headers=headers)
    assert res.status_code == 404 and res.json() == unknown()
    assert env.sweep_doc() is None                         # and nothing ran


def test_the_404_for_a_non_scheduler_is_the_one_an_unknown_address_gets(env, client):
    c = client()
    nothing = c.get("/api/internal/nothing-here", headers={"Authorization": "Bearer tok-alice"})
    denied = c.post("/api/internal/sweep", headers={"Authorization": "Bearer tok-alice"})
    assert nothing.status_code == denied.status_code == 404
    assert denied.json() == {**nothing.json(), "detail": nothing.json()["detail"].replace("nothing-here", "sweep")}
    assert denied.headers["content-type"] == nothing.headers["content-type"]


def test_other_methods_on_the_sweep_path_are_hidden_too(env, client):
    c = client()
    assert c.get("/api/internal/sweep", headers={"Authorization": "Bearer tok-alice"}).json() == unknown()
    assert c.get("/api/internal/sweep").status_code == 404
    assert env.sweep_doc() is None


def test_a_scheduler_token_is_not_a_sign_in_for_the_rest_of_the_api(env, client):
    res = client().get("/api/me", headers={"Authorization": "Bearer sched-ok"})
    assert res.status_code == 401


def test_without_a_scheduler_verifier_the_endpoint_does_not_exist(env, client):
    res = client(scheduler=None).post("/api/internal/sweep", headers={"Authorization": "Bearer sched-ok"})
    assert res.status_code == 404 and res.json() == unknown()


def test_in_local_mode_the_endpoint_does_not_exist(env, client):
    res = client(cloud=False).post("/api/internal/sweep", headers={"Authorization": "Bearer sched-ok"})
    assert res.status_code == 404 and res.json() == unknown()


def test_without_a_sweeper_the_scheduler_gets_the_404_too(env, client):
    res = client(sweeper=None).post("/api/internal/sweep", headers={"Authorization": "Bearer sched-ok"})
    assert res.status_code == 404


def test_unreachable_certificates_answer_503_so_the_scheduler_retries(env, client):
    res = client().post("/api/internal/sweep", headers={"Authorization": "Bearer sched-down"})
    assert res.status_code == 503 and res.json()["code"] == "internal"
    assert env.sweep_doc() is None


def test_a_failed_step_answers_500_and_the_retry_finishes_the_slot(env, client, monkeypatch):
    c = client()
    monkeypatch.setattr(env.directory, "full_sync", lambda: (_ for _ in ()).throw(RuntimeError("secret detail")))
    res = c.post("/api/internal/sweep", headers={"Authorization": "Bearer sched-ok"})
    assert res.status_code == 500 and res.json() == {"detail": "Internal server error", "code": "internal"}
    assert env.sweep_doc()["state"] == "failed"
    monkeypatch.undo()
    res = c.post("/api/internal/sweep", headers={"Authorization": "Bearer sched-ok"})
    assert res.status_code == 200 and res.json()["state"] == "done"


def test_the_sweep_endpoint_is_not_in_the_public_openapi_document(env, client):
    assert "/api/internal" not in client().get("/api/openapi.json").text


def test_create_app_builds_the_sweeper_from_the_admin_database(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist", auth="firebase",
                        signing_key="test-signing-key-0123456789abcdef", publish=False)
    app = create_app(settings, analyzer=lambda *_a, **_k: {}, token_verifier=FakeFirebase(), admin_db=MemDb(indexed=True))
    assert isinstance(app.state.sweeper, Sweeper)
    local = create_app(Settings(data_dir=tmp_path / "d2", frontend_dist=tmp_path / "no-dist", publish=False),
                       analyzer=lambda *_a, **_k: {})
    assert local.state.sweeper is None


def test_the_default_sweeper_shares_the_jobs_projections_and_the_admin_routes_directory(tmp_path):
    from app.admin.router import get_services

    settings = Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist", auth="firebase",
                        signing_key="test-signing-key-0123456789abcdef", publish=False)
    app = create_app(settings, analyzer=lambda *_a, **_k: {}, token_verifier=FakeFirebase(), admin_db=MemDb(indexed=True))
    sweeper = app.state.sweeper
    assert app.state.jobs.projections is not None
    assert sweeper._projections is app.state.jobs.projections      # one owner of projections-pending.json
    assert sweeper._directory is app.state.admin_directory is get_services(app).directory   # one email-index cache

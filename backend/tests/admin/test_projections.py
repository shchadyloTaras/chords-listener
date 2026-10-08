"""Job-history and daily-stats projections (ADR-0004, ADR-0010; data-model Aggregates 2-3).

Every flow runs twice: on ``MemDb``, an in-memory stand-in for ``FirestoreIndex`` that applies the real REST write
bodies (preconditions, masks, increment transforms), and on the Firestore emulator (skipped unless
``FIRESTORE_EMULATOR_HOST`` is set). Each test uses its own collections, so nothing needs cleaning up.
"""
from __future__ import annotations

import copy
import json
import os
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional, get_args

import pytest

from admin.fixtures import make_stats_day
from app.admin import history, stats
from app.admin.history import AcceptedJob, FinishedJob, Projections
from app.firestore import Document, FirestoreIndex, IndexError_, PreconditionFailed, from_value
from app.models import ErrorCode
from app.users import SMOKE_UID

EMULATOR_HOST = os.environ.get("FIRESTORE_EMULATOR_HOST")
UTC = timezone.utc
NOON = datetime(2026, 10, 8, 12, 0, 0, tzinfo=UTC)
ANALYSES = ("link", "file", "mic", "tab")


def split_path(path: str) -> list[str]:
    """``failedByReason.`a.b```  ->  ["failedByReason", "a.b"] (the inverse of app.firestore.field_path)."""
    return [re.sub(r"\\(.)", r"\1", m.group(1)) if m.group(1) is not None else m.group(2)
            for m in re.finditer(r"`((?:\\.|[^`\\])*)`|([^.`]+)", path)]


class MemDb(FirestoreIndex):
    """In-memory Firestore: documents by path, decoded the way ``FirestoreIndex`` returns them. ``commit`` is atomic
    and honours ``currentDocument`` preconditions, ``updateMask`` and ``increment`` / ``REQUEST_TIME`` transforms.
    """

    def __init__(self) -> None:
        super().__init__("p1", session_factory=lambda: None)
        self.docs: dict[str, dict[str, Any]] = {}
        self.commits = 0
        self._tx = 0

    def get(self, path: str) -> Optional[Document]:
        return Document(path, copy.deepcopy(self.docs[path])) if path in self.docs else None

    def _post(self, path: str, body: dict) -> Any:
        if path == ":beginTransaction":
            self._tx += 1
            return {"transaction": f"tx{self._tx}"}
        if path == ":rollback":
            return {}
        if path == ":batchGet":
            rows = []
            for name in body["documents"]:
                p = name.split("/documents/", 1)[1]
                rows.append({"found": {"name": name, "fields": _typed(self.docs[p])}} if p in self.docs
                            else {"missing": name})
            return rows
        if path == ":commit":
            self.commit(body["writes"])
            return {}
        raise AssertionError(f"MemDb does not serve {path}")

    def commit(self, writes, *, transaction=None) -> None:
        staged = copy.deepcopy(self.docs)
        for w in writes:
            target = w["delete"] if "delete" in w else w["update"]["name"]
            path = target.split("/documents/", 1)[1]
            cond = w.get("currentDocument")
            if cond and "exists" in cond and (path in staged) != cond["exists"]:
                raise PreconditionFailed(f"precondition on {path}")
            if "delete" in w:
                staged.pop(path, None)
                continue
            fields = {k: from_value(v) for k, v in w["update"].get("fields", {}).items()}
            if "updateMask" not in w:
                staged[path] = fields
            else:
                doc = staged.setdefault(path, {})
                for fp in w["updateMask"]["fieldPaths"]:
                    parts = split_path(fp)
                    src: Any = fields
                    for part in parts:
                        src = src.get(part, _MISSING) if isinstance(src, dict) else _MISSING
                    dst = doc
                    for part in parts[:-1]:
                        dst = dst.setdefault(part, {})
                    if src is _MISSING:
                        dst.pop(parts[-1], None)
                    else:
                        dst[parts[-1]] = src
            doc = staged.setdefault(path, {})
            for t in w.get("updateTransforms", []):
                parts = split_path(t["fieldPath"])
                dst = doc
                for part in parts[:-1]:
                    dst = dst.setdefault(part, {})
                if "increment" in t:
                    dst[parts[-1]] = dst.get(parts[-1], 0) + from_value(t["increment"])
                else:
                    dst[parts[-1]] = NOON.isoformat().replace("+00:00", "Z")
        self.docs = staged
        self.commits += 1


_MISSING = object()


def _typed(data: dict[str, Any]) -> dict[str, Any]:
    from app.firestore import to_value
    return {k: to_value(v) for k, v in data.items()}


class Env:
    """What a test sees: the database, the projections under test and the collections they use."""

    def __init__(self, db: FirestoreIndex, projections: Projections, jobs: str, stats_coll: str, pending: Path) -> None:
        self.db, self.p, self.jobs, self.stats, self.pending = db, projections, jobs, stats_coll, pending

    def job(self, job_id: str) -> Optional[dict[str, Any]]:
        d = self.db.get(f"{self.jobs}/{job_id}")
        return d.data if d else None

    def day(self, day: str) -> Optional[dict[str, Any]]:
        d = self.db.get(f"{self.stats}/{day}")
        return d.data if d else None

    def marker(self, day: str, uid: str) -> Optional[dict[str, Any]]:
        d = self.db.get(f"{self.stats}/{day}/activeUsers/{uid}")
        return d.data if d else None

    def buffered(self) -> list[dict[str, Any]]:
        try:
            return json.loads(self.pending.read_text("utf-8"))["ops"]
        except FileNotFoundError:
            return []


@pytest.fixture(params=["fake", pytest.param("emulator", marks=pytest.mark.skipif(
    not EMULATOR_HOST, reason="needs the Firestore emulator (FIRESTORE_EMULATOR_HOST)"))])
def env(request, tmp_path) -> Env:
    tag = uuid.uuid4().hex[:10]
    jobs, stats_coll, tombs = f"t11_jobs_{tag}", f"t11_stats_{tag}", f"t11_tombs_{tag}"
    db: FirestoreIndex = MemDb() if request.param == "fake" else FirestoreIndex("build-chords-listener", emulator_host=EMULATOR_HOST)
    pending = tmp_path / "admin" / "projections-pending.json"
    proj = Projections(db, pending, jobs_collection=jobs, stats_collection=stats_coll,
                       tombstones_collection=tombs, now=lambda: NOON)
    return Env(db, proj, jobs, stats_coll, pending)


def job(job_id: str = "j1", uid: str = "u1", *, kind: str = "analysis", origin: str = "link",
        at: datetime = NOON, title: Optional[str] = "Some song") -> AcceptedJob:
    return AcceptedJob(id=job_id, uid=uid, kind=kind, origin=origin, accepted_at=at, title=title)


def failed(job_id: str = "j1", code: Optional[str] = "download_blocked", text: Optional[str] = "boom") -> FinishedJob:
    return FinishedJob(id=job_id, status="error", finished_at=NOON + timedelta(seconds=30), error_code=code, error_text=text)


def done(job_id: str = "j1", track_id: Optional[str] = "t1") -> FinishedJob:
    return FinishedJob(id=job_id, status="done", finished_at=NOON + timedelta(seconds=30), track_id=track_id)


DAY = "2026-10-08"


def outage(env: Env, down: bool) -> None:
    """Make every Firestore transaction fail (``down``) or work again, on whichever database the test runs on."""
    def refuse(*_args: Any, **_kwargs: Any) -> Any:
        raise IndexError_("Firestore is down", retryable=True)

    if down:
        env.db.run_transaction = refuse  # type: ignore[method-assign]
    else:
        env.db.__dict__.pop("run_transaction", None)


# ===================================================================== AC-01: accept


def test_accept_records_the_source_type_of_the_job(env):
    env.p.accept(AcceptedJob(id="j1", uid="u1", kind="analysis", origin="link", accepted_at=NOON, source_type="youtube"))
    env.p.accept(job("j2"))
    assert env.job("j1")["sourceType"] == "youtube" and env.job("j2")["sourceType"] == "other"


def test_a_buffered_accept_keeps_its_source_type(env):
    outage(env, True)
    env.p.accept(AcceptedJob(id="j1", uid="u1", kind="analysis", origin="link", accepted_at=NOON, source_type="youtube"))
    assert env.buffered()[0]["payload"]["sourceType"] == "youtube"
    outage(env, False)
    assert env.p.replay_pending() == 1
    assert env.job("j1")["sourceType"] == "youtube"


def test_accept_records_the_job_and_counts_it_into_its_utc_day(env):
    assert env.p.accept(job()) is True
    j = env.job("j1")
    assert (j["uid"], j["kind"], j["origin"], j["status"]) == ("u1", "analysis", "link", "running")
    assert (j["service"], j["reason"], j["errorText"], j["trackId"], j["finishedAt"]) == (False, None, None, None, None)
    assert j["title"] == "Some song" and j["day"] == DAY and j["anonymizedAt"] is None
    assert j["acceptedAt"].startswith("2026-10-08T12:00:00") and j["expireAt"].startswith("2027-01-06T12:00:00")
    d = env.day(DAY)
    assert d["state"] == "live"
    assert d["analyses"] == {"link": 1, "file": 0, "mic": 0, "tab": 0}
    assert (d["vocals"], d["failed"], d["failedByReason"], d["active"]) == (0, 0, {}, 1)
    assert d["newUsers"] is None and d["frozenAt"] is None
    assert env.marker(DAY, "u1")["expireAt"].startswith("2026-10-11T00:00:00")   # the day + 3 d, a disposable marker


def test_a_second_job_of_the_same_user_does_not_count_a_second_active_user(env):
    env.p.accept(job("j1", "u1", origin="link"))
    env.p.accept(job("j2", "u1", origin="mic"))
    env.p.accept(job("j3", "u2", origin="link"))
    d = env.day(DAY)
    assert d["analyses"] == {"link": 2, "file": 0, "mic": 1, "tab": 0}
    assert d["active"] == 2


def test_a_vocals_job_counts_as_a_transcription_not_an_analysis(env):
    env.p.accept(job("j1", "u1", kind="vocals", origin="file"))
    d = env.day(DAY)
    assert d["vocals"] == 1 and d["analyses"] == {"link": 0, "file": 0, "mic": 0, "tab": 0} and d["active"] == 1


@pytest.mark.parametrize("origin", ANALYSES)
def test_every_source_has_its_own_counter(env, origin):
    env.p.accept(job(origin=origin))
    assert env.day(DAY)["analyses"][origin] == 1 and sum(env.day(DAY)["analyses"].values()) == 1


def test_totals_roll_over_at_utc_midnight(env):
    late = datetime(2026, 10, 8, 23, 59, 59, tzinfo=UTC)
    midnight = datetime(2026, 10, 9, 0, 0, 0, tzinfo=UTC)
    env.p.accept(job("j1", "u1", at=late))
    env.p.accept(job("j2", "u1", at=midnight))
    assert env.job("j1")["day"] == "2026-10-08" and env.job("j2")["day"] == "2026-10-09"
    assert env.day("2026-10-08")["analyses"]["link"] == 1 and env.day("2026-10-08")["active"] == 1
    assert env.day("2026-10-09")["analyses"]["link"] == 1 and env.day("2026-10-09")["active"] == 1   # active again on the new day


def test_the_day_is_utc_whatever_the_timezone_of_the_timestamp(env):
    kyiv = timezone(timedelta(hours=3))
    env.p.accept(job("j1", at=datetime(2026, 10, 9, 2, 30, tzinfo=kyiv)))   # 23:30 UTC on the 8th
    assert env.job("j1")["day"] == "2026-10-08" and env.day("2026-10-08")["analyses"]["link"] == 1


def test_replaying_an_accept_is_a_no_op(env):
    env.p.accept(job())
    before_job, before_day = env.job("j1"), env.day(DAY)
    assert env.p.accept(job()) is True
    assert env.job("j1") == before_job and env.day(DAY) == before_day


def test_user_text_is_stored_as_plain_text_and_cut_to_its_limits(env):
    hostile = "<script>alert(1)</script>" + "A" * 400
    env.p.accept(job(title=hostile))
    assert env.job("j1")["title"] == hostile[:300]
    env.p.finish(failed(text="<img src=x onerror=alert(1)>" * 20))
    assert env.job("j1")["errorText"] == ("<img src=x onerror=alert(1)>" * 20)[:200]


# ===================================================================== AC-07: finish and the reason map


def test_finish_with_an_error_records_the_reason_and_counts_one_failure(env):
    env.p.accept(job())
    assert env.p.finish(failed(code="download_blocked", text="Sign in to confirm")) is True
    j = env.job("j1")
    assert (j["status"], j["reason"], j["errorText"]) == ("error", "youtube_blocked", "Sign in to confirm")
    assert j["finishedAt"].startswith("2026-10-08T12:00:30")
    d = env.day(DAY)
    assert d["failed"] == 1 and d["failedByReason"] == {"youtube_blocked": 1}
    assert d["analyses"]["link"] == 1               # the accepted count is untouched by the outcome


def test_finish_done_records_the_track_and_counts_no_failure(env):
    env.p.accept(job())
    env.p.finish(done(track_id="abc123"))
    j = env.job("j1")
    assert (j["status"], j["reason"], j["errorText"], j["trackId"]) == ("done", None, None, "abc123")
    assert env.day(DAY)["failed"] == 0 and env.day(DAY)["failedByReason"] == {}


def test_failures_are_counted_per_reason(env):
    for i, code in enumerate(["download_blocked", "download_blocked", "too_long", "internal", "cancelled"]):
        env.p.accept(job(f"j{i}", f"u{i}"))
        env.p.finish(failed(f"j{i}", code))
    d = env.day(DAY)
    assert d["failed"] == 5
    assert d["failedByReason"] == {"youtube_blocked": 2, "too_long": 1, "other": 2}


def test_replaying_a_finish_is_a_no_op(env):
    env.p.accept(job())
    env.p.finish(failed())
    before_job, before_day = env.job("j1"), env.day(DAY)
    assert env.p.finish(failed()) is True
    assert env.p.finish(done()) is True               # a late, different outcome does not rewrite a settled job either
    assert env.job("j1") == before_job and env.day(DAY) == before_day


def test_the_failure_counts_into_the_day_of_acceptance_not_the_day_of_finishing(env):
    env.p.accept(job("j1", at=datetime(2026, 10, 8, 23, 59, 50, tzinfo=UTC)))
    env.p.finish(FinishedJob(id="j1", status="error", finished_at=datetime(2026, 10, 9, 0, 0, 20, tzinfo=UTC),
                             error_code="analysis_failed", error_text="x"))
    assert env.day("2026-10-08")["failedByReason"] == {"analysis_failed": 1}
    assert env.day("2026-10-09") is None


# ===================================================================== a frozen day never changes (ADR-0010)


@pytest.mark.parametrize("state", ["frozen", "restored"])
def test_finish_on_a_closed_day_updates_the_job_but_changes_no_counter(env, state):
    env.p.accept(job())
    env.db.commit([env.db.update_op(f"{env.stats}/{DAY}", make_stats_day(DAY, state, failed=3, active=7).data)])
    before = env.day(DAY)
    assert env.p.finish(failed()) is True
    assert env.job("j1")["status"] == "error" and env.job("j1")["reason"] == "youtube_blocked"   # the history is kept
    assert env.day(DAY) == before                                                              # the day is not


@pytest.mark.parametrize("state", ["frozen", "restored"])
def test_accept_on_a_closed_day_records_the_job_but_changes_no_counter(env, state):
    env.db.commit([env.db.update_op(f"{env.stats}/{DAY}", make_stats_day(DAY, state, active=7).data)])
    before = env.day(DAY)
    env.p.accept(job())
    assert env.job("j1")["status"] == "running"
    assert env.day(DAY) == before and env.marker(DAY, "u1") is None


# ===================================================================== the service account (smoke test)


def test_the_smoke_uid_is_flagged_service_and_excluded_from_the_stats(env):
    env.p.accept(job("s1", SMOKE_UID))
    assert env.job("s1")["service"] is True
    assert env.day(DAY) is None and env.marker(DAY, SMOKE_UID) is None
    env.p.finish(failed("s1"))
    assert env.job("s1")["status"] == "error" and env.job("s1")["service"] is True
    assert env.day(DAY) is None


def test_a_service_job_does_not_move_the_counters_of_real_users(env):
    env.p.accept(job("j1", "u1"))
    before = env.day(DAY)
    env.p.accept(job("s1", SMOKE_UID))
    env.p.finish(failed("s1"))
    assert env.day(DAY) == before
    assert stats.is_service(SMOKE_UID) is True and stats.is_service("u1") is False


# ===================================================================== AC-07: the fixed reason list


REASONS = ["youtube_blocked", "download_failed", "unsupported_format", "too_long", "too_large", "analysis_failed", "other"]


def test_the_reason_list_is_the_fixed_seven():
    assert list(history.REASONS) == REASONS
    assert history.REASON_LABEL_KEYS == {r: f"admin.reason.{r}" for r in REASONS}


@pytest.mark.parametrize("code, reason", [
    ("download_blocked", "youtube_blocked"),
    ("download_failed", "download_failed"),
    ("unsupported_format", "unsupported_format"),
    ("too_long", "too_long"),
    ("too_large", "too_large"),
    ("analysis_failed", "analysis_failed"),
    ("internal", "other"),
    ("cancelled", "other"),
    ("not_found", "other"),
    ("invalid_url", "other"),
    ("quota_exceeded", "other"),
])
def test_known_error_codes_map_to_their_category(code, reason):
    assert history.reason_for(code) == reason


def test_every_error_code_maps_into_the_fixed_list():
    for code in get_args(ErrorCode):
        assert history.reason_for(code) in REASONS, code


def test_an_unknown_or_missing_error_code_is_other():
    assert history.reason_for("something_new") == "other"
    assert history.reason_for(None) == "other"
    assert history.reason_for("") == "other"


def test_the_reason_ids_match_the_contract_enum():
    from app.admin.models import FailureReason
    assert list(get_args(FailureReason)) == REASONS


# ===================================================================== write failure -> pending buffer -> replay


def test_a_failed_accept_is_buffered_and_does_not_raise(env):
    outage(env, True)
    assert env.p.accept(job("j1", "u1", origin="tab")) is False
    ops = env.buffered()
    assert [o["op"] for o in ops] == ["accept"] and ops[0]["jobId"] == "j1"
    assert ops[0]["payload"]["uid"] == "u1" and ops[0]["payload"]["origin"] == "tab" and ops[0]["at"]
    assert env.job("j1") is None and env.day(DAY) is None


def test_replay_pending_drains_the_buffer_and_applies_each_op_once(env):
    outage(env, True)
    env.p.accept(job("j1", "u1"))
    env.p.finish(failed("j1"))                       # its accept is still buffered: buffered behind it
    assert [o["op"] for o in env.buffered()] == ["accept", "finish"]
    assert env.p.replay_pending() == 0 and len(env.buffered()) == 2      # still down: nothing is lost, nothing applied

    outage(env, False)
    assert env.p.replay_pending() == 2
    assert env.buffered() == [] and not env.pending.exists()
    j, d = env.job("j1"), env.day(DAY)
    assert (j["status"], j["reason"]) == ("error", "youtube_blocked")
    assert d["analyses"]["link"] == 1 and d["failed"] == 1 and d["failedByReason"] == {"youtube_blocked": 1} and d["active"] == 1
    assert env.p.replay_pending() == 0                                        # an empty buffer is a no-op
    assert env.day(DAY) == d


def test_a_replay_that_already_landed_is_a_no_op(env):
    """The write succeeded but its reply was lost, so the op was buffered anyway: replaying changes nothing."""
    env.p.accept(job("j1", "u1"))
    env.p._enqueue("accept", "j1", env.p._accept_payload(job("j1", "u1")))     # noqa: SLF001 - simulate the lost reply
    before = env.day(DAY)
    assert env.p.replay_pending() == 1
    assert env.day(DAY) == before and env.buffered() == []


def test_s2_3_a_replay_after_the_purge_does_not_restore_the_title(env):
    outage(env, True)
    env.p.accept(job("j1", "u1", title="Secret song"))
    env.p.finish(done("j1", "t1"))
    env.db.commit([env.db.update_op(f"{env.p._tombstones}/u1", {"status": "done"})])    # noqa: SLF001 - the purge ran meanwhile
    outage(env, False)
    assert env.p.replay_pending() == 2
    j = env.job("j1")
    assert j["title"] is None and j["trackId"] is None and j["anonymizedAt"] is not None


def test_the_next_projection_write_replays_the_buffer_first(env):
    outage(env, True)
    env.p.accept(job("j1", "u1"))
    outage(env, False)
    assert env.p.accept(job("j2", "u2")) is True      # this write replays j1 first
    assert env.job("j1") is not None and env.job("j2") is not None and env.buffered() == []
    assert env.day(DAY)["analyses"]["link"] == 2 and env.day(DAY)["active"] == 2


def test_a_finish_whose_job_never_reached_the_history_is_dropped_on_replay(env):
    env.p.finish(failed("ghost"))                     # no accept, none buffered: the job is unknown
    assert [o["op"] for o in env.buffered()] == ["finish"]
    assert env.p.replay_pending() == 1                # dropped, not retried for ever
    assert env.buffered() == [] and env.day(DAY) is None


def test_a_broken_buffer_file_is_ignored_and_does_not_stop_the_projection(env):
    env.pending.parent.mkdir(parents=True)
    env.pending.write_text("{not json", "utf-8")
    assert env.p.accept(job()) is True
    assert env.job("j1") is not None


def test_the_buffer_is_written_under_a_leaf_lock_from_many_threads(env):
    outage(env, True)
    threads = [threading.Thread(target=env.p.accept, args=(job(f"j{i}", f"u{i}"),)) for i in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(o["jobId"] for o in env.buffered()) == sorted(f"j{i}" for i in range(12))


def test_the_pending_path_lives_under_the_data_dir():
    assert history.pending_path(Path("/data")) == Path("/data/admin/projections-pending.json")

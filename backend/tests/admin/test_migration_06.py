"""Migration 06 (restore pre-launch daily stats from tracks, AC-08), run against the Firestore emulator.

Like test_migrations_04_05.py: the staged scripts under docs/features/admin/migrations/ are the canonical copies;
the tests run ``main()`` in-process against a uniquely named emulator project. Skipped without
FIRESTORE_EMULATOR_HOST.
"""
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import pytest

from app.firestore import FirestoreIndex
from app.users import SMOKE_UID

EMULATOR_HOST = os.environ.get("FIRESTORE_EMULATOR_HOST")
pytestmark = pytest.mark.skipif(not EMULATOR_HOST, reason="needs the Firestore emulator (FIRESTORE_EMULATOR_HOST)")

MIGRATIONS = Path(__file__).resolve().parents[3] / "docs" / "features" / "admin" / "migrations"
LAUNCH = "2026-10-10"
PRE_LAUNCH = [f"2026-10-{d:02d}" for d in range(1, 10)]   # the first track's day up to the launch, quiet days too
UP, DOWN = "06_restore_stats_from_tracks.up.py", "06_restore_stats_from_tracks.down.py"


def load(name: str):
    path = MIGRATIONS / name
    assert path.is_file(), f"{name} is missing from {MIGRATIONS}"
    if str(MIGRATIONS) not in sys.path:
        sys.path.insert(0, str(MIGRATIONS))
    spec = importlib.util.spec_from_file_location(f"mig_{path.stem.replace('.', '_')}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def project(monkeypatch) -> str:
    name = f"mig-{uuid.uuid4().hex[:10]}"
    monkeypatch.setenv("CHORDS_FIREBASE_PROJECT", name)
    return name


@pytest.fixture
def db(project) -> FirestoreIndex:
    return FirestoreIndex(project, emulator_host=EMULATOR_HOST)


def run(name: str, *args: str) -> int:
    old = sys.argv
    sys.argv = [name, *args]
    try:
        return load(name).main()
    finally:
        sys.argv = old


def put_tracks(db: FirestoreIndex, uid: str, rows: list[tuple[str, Optional[str], Optional[str]]]) -> None:
    """rows: (track id, createdAt ISO string, source.type)."""
    ops = []
    for tid, created, kind in rows:
        data: dict[str, Any] = {"title": tid}
        if created is not None:
            data["createdAt"] = created
        if kind is not None:
            data["source"] = {"type": kind}
        ops.append(db.update_op(f"users/{uid}/tracks/{tid}", data))
    db.commit(ops)


def stats(db: FirestoreIndex) -> dict[str, dict[str, Any]]:
    return {d.id: d.data for d in db.run_query("adminStats")}


def seed(db: FirestoreIndex) -> None:
    put_tracks(db, "alice", [
        ("a1", "2026-10-01T08:00:00Z", "youtube"), ("a2", "2026-10-01T23:59:59Z", "youtube"),
        ("a3", "2026-10-01T10:00:00Z", "file"), ("a4", "2026-10-02T00:00:00Z", "url"),
        ("a5", "2026-10-09T12:00:00Z", "file"),
        ("a6", "2026-10-10T00:00:01Z", "youtube"),        # the launch day itself is not restored
        ("a7", "2026-10-12T09:00:00Z", "file"),           # after launch
    ])
    put_tracks(db, "bob", [("b1", "2026-10-01T12:00:00Z", "url"), ("b2", "2026-10-02T12:00:00Z", "file")])


def test_up_builds_restored_days_with_counts_by_source_type_only(db):
    seed(db)

    assert run(UP, "--before", LAUNCH) == 0

    built = stats(db)
    assert sorted(built) == PRE_LAUNCH                                          # only days before the launch day
    day = built["2026-10-01"]
    assert day["state"] == "restored"
    assert day["restoredTracks"] == {"youtube": 2, "url": 1, "file": 1}        # raw source.type, all users summed
    assert built["2026-10-02"]["restoredTracks"] == {"youtube": 0, "url": 1, "file": 1}
    assert built["2026-10-09"]["restoredTracks"] == {"youtube": 0, "url": 0, "file": 1}


def test_quiet_pre_launch_days_are_restored_with_no_songs(db):
    """AC-08: every day before the launch reads «відновлено з пісень», a day nobody added a song on too (it would
    otherwise show as an ordinary day of zeros)."""
    seed(db)
    run(UP, "--before", LAUNCH)

    built = stats(db)
    for day in ("2026-10-03", "2026-10-05", "2026-10-08"):
        assert built[day]["state"] == "restored"
        assert built[day]["restoredTracks"] == {"youtube": 0, "url": 0, "file": 0}
    assert "2026-09-30" not in built                                            # nothing before the first song


def test_no_tracks_restores_no_day(db):
    assert run(UP, "--before", LAUNCH) == 0
    assert stats(db) == {}


def test_restored_days_have_no_failure_or_active_counters(db):
    seed(db)
    run(UP, "--before", LAUNCH)

    for day in stats(db).values():
        assert day["failed"] == 0 and day["failedByReason"] == {} and day["active"] == 0
        assert day["analyses"] == {"link": 0, "file": 0, "mic": 0, "tab": 0} and day["vocals"] == 0
        assert day["newUsers"] is None and day["reconciledDiff"] is None and day["frozenAt"] is None
        assert day["updatedAt"]


def test_counts_equal_the_seeded_tracks_per_day(db):
    seed(db)
    run(UP, "--before", "2026-10-31")

    built = stats(db)
    for day, expected in {"2026-10-10": (1, 0, 0), "2026-10-12": (0, 0, 1)}.items():
        assert tuple(built[day]["restoredTracks"][k] for k in ("youtube", "url", "file")) == expected
    total = sum(sum(d["restoredTracks"].values()) for d in built.values())
    assert total == 9                                                          # every seeded track counted once


def test_a_live_or_frozen_day_for_the_same_date_is_left_untouched(db):
    seed(db)
    now = datetime(2026, 10, 9, tzinfo=timezone.utc)
    live = {"state": "live", "analyses": {"link": 4, "file": 1, "mic": 0, "tab": 0}, "vocals": 2, "failed": 1,
            "failedByReason": {"timeout": 1}, "active": 3, "newUsers": None, "restoredTracks": None,
            "reconciledDiff": None, "frozenAt": None, "updatedAt": now}
    frozen = {**live, "state": "frozen", "newUsers": 5, "reconciledDiff": 0, "frozenAt": now}
    db.commit([db.update_op("adminStats/2026-10-01", live), db.update_op("adminStats/2026-10-02", frozen)])

    assert run(UP, "--before", LAUNCH) == 0

    built = stats(db)
    stamp = "2026-10-09T00:00:00Z"                                              # a timestamp reads back as a string
    assert built["2026-10-01"] == {**live, "updatedAt": stamp}
    assert built["2026-10-02"] == {**frozen, "updatedAt": stamp, "frozenAt": stamp}
    assert built["2026-10-09"]["state"] == "restored"                           # the free day is still restored


def test_rerun_is_idempotent_and_keeps_an_existing_restored_day(db):
    seed(db)
    run(UP, "--before", LAUNCH)
    first = stats(db)
    put_tracks(db, "carol", [("c1", "2026-10-01T05:00:00Z", "file")])           # a later track must not rewrite the day

    assert run(UP, "--before", LAUNCH) == 0

    assert stats(db) == first


def test_the_smoke_test_account_and_malformed_tracks_are_ignored(db):
    put_tracks(db, SMOKE_UID, [("s1", "2026-10-01T08:00:00Z", "youtube")])
    put_tracks(db, "dave", [("d1", "2026-10-03T08:00:00Z", "youtube"),
                            ("d2", None, "youtube"),                              # no createdAt
                            ("d3", "not-a-date", "youtube"),
                            ("d4", "2026-10-03T09:00:00Z", None),                 # no source
                            ("d5", "2026-10-03T09:00:00Z", "dropbox")])           # unknown source type

    run(UP, "--before", LAUNCH)

    assert sorted(stats(db)) == PRE_LAUNCH[2:]                                  # from the first counted song (10-03)
    assert stats(db)["2026-10-03"]["restoredTracks"] == {"youtube": 1, "url": 0, "file": 0}
    assert stats(db)["2026-10-04"]["restoredTracks"] == {"youtube": 0, "url": 0, "file": 0}


def test_dry_run_writes_nothing(db):
    seed(db)
    assert run(UP, "--before", LAUNCH, "--dry-run") == 0
    assert stats(db) == {}


def test_up_requires_a_valid_before_day(db):
    with pytest.raises(SystemExit):
        run(UP)
    with pytest.raises(SystemExit):
        run(UP, "--before", "10/10/2026")
    with pytest.raises(SystemExit):
        run(UP, "--before", "2026-13-45")                                       # shaped like a day, but none
    assert stats(db) == {}


def test_down_removes_only_restored_days(db):
    seed(db)
    now = datetime(2026, 10, 9, tzinfo=timezone.utc)
    base = {"analyses": {"link": 1, "file": 0, "mic": 0, "tab": 0}, "vocals": 0, "failed": 0, "failedByReason": {},
            "active": 1, "newUsers": None, "restoredTracks": None, "reconciledDiff": None, "frozenAt": None,
            "updatedAt": now}
    db.commit([db.update_op("adminStats/2026-10-11", {**base, "state": "live"}),
               db.update_op("adminStats/2026-10-08", {**base, "state": "frozen"})])
    run(UP, "--before", LAUNCH)
    assert len(stats(db)) == 10                                                 # 8 restored days + the live and frozen ones

    assert run(DOWN) == 0

    assert sorted(stats(db)) == ["2026-10-08", "2026-10-11"]
    assert {d["state"] for d in stats(db).values()} == {"live", "frozen"}
    assert db.get("users/alice/tracks/a1") is not None                          # tracks are never touched
    assert run(DOWN) == 0                                                       # repeatable


def test_down_dry_run_deletes_nothing(db):
    seed(db)
    run(UP, "--before", LAUNCH)
    assert run(DOWN, "--dry-run") == 0
    assert len(stats(db)) == len(PRE_LAUNCH)


def test_script_runs_as_documented_from_backend_with_the_migrations_dir_on_the_path(db, project):
    seed(db)
    backend = Path(__file__).resolve().parents[2]
    env = {**os.environ, "PYTHONPATH": f".{os.pathsep}{MIGRATIONS}", "CHORDS_FIREBASE_PROJECT": project}

    def script(name: str, *args: str) -> str:
        res = subprocess.run([sys.executable, str(MIGRATIONS / name), *args], cwd=backend, env=env,
                             capture_output=True, text=True, timeout=60)
        assert res.returncode == 0, res.stderr
        return res.stdout

    assert "9 day(s) found, 9 restored, 0 already present" in script(UP, "--before", LAUNCH)
    assert "9 restored day(s) deleted" in script(DOWN)

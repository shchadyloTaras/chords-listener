"""Migrations 04 (seed runtime config + public status) and 05 (email index), run against the Firestore emulator.

The staged scripts under docs/features/admin/migrations/ are the canonical copies (there is no live migrations
tree); the tests load them from there, run ``main()`` in-process against a uniquely named emulator project (so
nothing leaks between tests or to other agents' data) and read the documents back. Skipped without
FIRESTORE_EMULATOR_HOST.
"""
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import pytest

from app.admin.directory import Directory
from app.firestore import FirestoreIndex

EMULATOR_HOST = os.environ.get("FIRESTORE_EMULATOR_HOST")
pytestmark = pytest.mark.skipif(not EMULATOR_HOST, reason="needs the Firestore emulator (FIRESTORE_EMULATOR_HOST)")

MIGRATIONS = Path(__file__).resolve().parents[3] / "docs" / "features" / "admin" / "migrations"
NOW = datetime(2026, 10, 7, 12, 0, 0, tzinfo=timezone.utc)


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
    for var in ("CHORDS_QUOTA_ANALYSES", "CHORDS_QUOTA_VOCALS", "CHORDS_QUOTA_JOBS",
                "CHORDS_MAX_DURATION_MIN", "CHORDS_MAX_UPLOAD_MB"):
        monkeypatch.delenv(var, raising=False)
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


def put_users(db: FirestoreIndex, users: list[tuple[str, Optional[str], datetime]]) -> None:
    db.commit([db.update_op(f"users/{uid}", {"email": e, "createdAt": at, "settings": {"theme": "dark"}}
                            if e else {"createdAt": at})
               for uid, e, at in users])


def shards(db: FirestoreIndex) -> dict[str, dict[str, Any]]:
    return {d.id: d.data for d in db.run_query("adminEmailIndex")}


def test_scripts_run_as_documented_from_backend_with_the_migrations_dir_on_the_path(db, project):
    """``PYTHONPATH=.:<migrations dir> python <script>`` from backend/ (the Cloud Run job invocation)."""
    backend = Path(__file__).resolve().parents[2]
    env = {**os.environ, "PYTHONPATH": f".{os.pathsep}{MIGRATIONS}", "CHORDS_FIREBASE_PROJECT": project}

    def script(name: str) -> str:
        res = subprocess.run([sys.executable, str(MIGRATIONS / name)], cwd=backend, env=env,
                             capture_output=True, text=True, timeout=60)
        assert res.returncode == 0, res.stderr
        return res.stdout

    assert "created adminConfig/settings" in script("04_seed_runtime_config.up.py")
    assert "already exists" in script("04_seed_runtime_config.up.py")
    assert "deleted" in script("04_seed_runtime_config.down.py")
    assert db.get("adminConfig/settings") is None
    put_users(db, [("u1", "a@example.test", NOW)])
    assert "1 email(s) in 1 shard(s)" in script("05_build_email_index.up.py")
    assert "1 shard(s) deleted" in script("05_build_email_index.down.py")


# ---------------------------------------------------------------------------------------------- 04


def test_04_seeds_settings_from_env_and_the_public_mirror_with_only_the_allowed_fields(db, monkeypatch):
    monkeypatch.setenv("CHORDS_QUOTA_ANALYSES", "30")        # AC-24: the default limit comes from the env first
    monkeypatch.setenv("CHORDS_QUOTA_VOCALS", "9")
    monkeypatch.setenv("CHORDS_QUOTA_JOBS", "3")
    monkeypatch.setenv("CHORDS_MAX_DURATION_MIN", "20")
    monkeypatch.setenv("CHORDS_MAX_UPLOAD_MB", "100")

    assert run("04_seed_runtime_config.up.py") == 0

    settings = db.get("adminConfig/settings").data
    assert settings["limits"] == {"analyses": 30, "vocals": 9, "jobs": 3, "maxDurationMin": 20, "maxUploadMb": 100}
    # AC-26: nothing is paused, every service is on
    assert settings["switches"] == {"analysesPaused": False, "youtubeEnabled": True, "vocalsEnabled": True}
    assert settings["updatedBy"] is None and settings["updatedAt"]

    status = db.get("publicStatus/current").data
    assert set(status) == {"banner", "switches", "updatedAt"}                      # data-model: the allowlist, exactly
    assert status["banner"] == {"enabled": False, "uk": "", "en": ""}              # AC-29: banner off until published
    assert status["switches"] == settings["switches"]


def test_04_default_env_gives_the_documented_defaults(db):
    run("04_seed_runtime_config.up.py")
    limits = db.get("adminConfig/settings").data["limits"]
    assert limits["analyses"] == 40 and limits["vocals"] == 15 and limits["jobs"] == 2


def test_04_clamps_an_env_value_outside_the_admin_ranges(db, monkeypatch):
    monkeypatch.setenv("CHORDS_QUOTA_ANALYSES", "5000")
    monkeypatch.setenv("CHORDS_QUOTA_JOBS", "9")
    run("04_seed_runtime_config.up.py")
    limits = db.get("adminConfig/settings").data["limits"]
    assert limits["analyses"] == 1000 and limits["jobs"] == 4


def test_04_rerun_is_a_noop_and_keeps_what_an_admin_changed(db):
    run("04_seed_runtime_config.up.py")
    db.commit([
        db.update_op("adminConfig/settings", {"limits": {"analyses": 25}}, exists=True, mask=["limits.analyses"]),
        db.update_op("publicStatus/current", {"banner": {"enabled": True, "uk": "Профілактика", "en": "Maintenance"}},
                     exists=True, mask=["banner"]),
    ])
    before = (db.get("adminConfig/settings").data, db.get("publicStatus/current").data)

    assert run("04_seed_runtime_config.up.py") == 0

    assert (db.get("adminConfig/settings").data, db.get("publicStatus/current").data) == before
    assert before[0]["limits"]["analyses"] == 25 and before[1]["banner"]["enabled"] is True


def test_04_dry_run_writes_nothing(db):
    run("04_seed_runtime_config.up.py", "--dry-run")
    assert db.get("adminConfig/settings") is None and db.get("publicStatus/current") is None


def test_04_down_removes_both_documents_and_is_repeatable(db):
    run("04_seed_runtime_config.up.py")
    assert db.get("adminConfig/settings") and db.get("publicStatus/current")

    assert run("04_seed_runtime_config.down.py") == 0
    assert db.get("adminConfig/settings") is None and db.get("publicStatus/current") is None
    assert run("04_seed_runtime_config.down.py") == 0           # nothing left: still fine


# ---------------------------------------------------------------------------------------------- 05


def test_05_builds_shards_that_match_users_and_the_directory_finds_them(db):
    put_users(db, [("u1", "Ivan.P@Example.Test", NOW - timedelta(days=3)),
                   ("u2", "John.Ivanov@example.test", NOW - timedelta(days=2)),
                   ("u3", None, NOW - timedelta(days=1)),                       # no email: not indexed
                   ("u4", "other@example.test", NOW - timedelta(hours=1))])

    assert run("05_build_email_index.up.py") == 0

    built = shards(db)
    assert list(built) == ["s000"]
    shard = built["s000"]
    assert shard["entries"] == {"u1": "ivan.p@example.test", "u2": "john.ivanov@example.test",
                                "u4": "other@example.test"}
    assert shard["count"] == 3
    assert sorted(m.email for m in Directory(db).search("ivan")) == [
        "ivan.p@example.test", "john.ivanov@example.test"]                      # AC-03: match anywhere, any case
    # the cursor is the newest users.createdAt, so the first catch-up reads nothing that is already in
    assert shard["syncedThrough"].startswith("2026-10-07T11:00:00") and shard["fullSyncAt"]


def test_05_rerun_rebuilds_to_the_current_users_and_drops_stale_shards(db):
    put_users(db, [("u1", "a@example.test", NOW - timedelta(days=1))])
    run("05_build_email_index.up.py")
    db.commit([db.update_op("adminEmailIndex/s007", {"entries": {"ghost": "ghost@example.test"}, "count": 1})])
    put_users(db, [("u2", "b@example.test", NOW)])
    db.commit([db.delete_op("users/u1")])

    assert run("05_build_email_index.up.py") == 0

    built = shards(db)
    assert list(built) == ["s000"]
    assert built["s000"]["entries"] == {"u2": "b@example.test"} and built["s000"]["count"] == 1


def test_05_splits_into_shards_of_at_most_shard_size(db, monkeypatch):
    module = load("05_build_email_index.up.py")
    monkeypatch.setattr(module, "SHARD_SIZE", 2)
    put_users(db, [(f"u{i}", f"user{i}@example.test", NOW - timedelta(minutes=i)) for i in range(5)])
    old = sys.argv
    sys.argv = ["05"]
    try:
        assert module.main() == 0
    finally:
        sys.argv = old

    built = shards(db)
    assert sorted(built) == ["s000", "s001", "s002"]
    assert [built[s]["count"] for s in sorted(built)] == [2, 2, 1]
    merged = {u: e for s in built.values() for u, e in s["entries"].items()}
    assert merged == {f"u{i}": f"user{i}@example.test" for i in range(5)}


def test_05_with_no_users_still_writes_one_empty_shard(db):
    run("05_build_email_index.up.py")
    built = shards(db)
    assert list(built) == ["s000"] and built["s000"]["count"] == 0


def test_05_dry_run_writes_nothing(db):
    put_users(db, [("u1", "a@example.test", NOW)])
    run("05_build_email_index.up.py", "--dry-run")
    assert shards(db) == {}


def test_05_down_removes_the_shards_and_leaves_users_alone(db):
    put_users(db, [("u1", "a@example.test", NOW)])
    run("05_build_email_index.up.py")
    assert shards(db)

    assert run("05_build_email_index.down.py") == 0

    assert shards(db) == {}
    assert db.get("users/u1").data["email"] == "a@example.test"
    assert run("05_build_email_index.down.py") == 0              # repeatable

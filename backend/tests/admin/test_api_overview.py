"""GET /api/admin/overview and GET /api/admin/settings (AC-01, US-01; docs/features/admin/contracts/openapi.yaml).

Unit tests run through the real app on ``DirectoryDb``, an in-memory stand-in for ``FirestoreIndex`` (the shared ``MemDb`` through
``DirectoryDb``). The last test runs the same flow on the Firestore emulator (only when
FIRESTORE_EMULATOR_HOST is set) and checks the read budget of the screen (NFR: at most 200 reads).
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from admin.fixtures import (
    ENGINE_INFO,
    DirectoryDb,
    Seed,
    iso,
    make_admin,
    make_stats_day,
    make_user,
    never,
    seed,
    seed_synthetic_users,
    settings_for,
)
from app.admin import router as router_mod
from app.admin.authz import AdminAuthz
from app.main import create_app
from app.users import SMOKE_UID

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

NOW = datetime(2026, 10, 8, 9, 45, 0, tzinfo=timezone.utc)
DAY = "2026-10-08"
ADMIN = "admin-1"
SETTINGS = "adminConfig/settings"
PUBLIC = "publicStatus/current"
STAMP = "2026-10-08T08:00:00Z"
LIMITS = {"analyses": 40, "vocals": 15, "jobs": 2, "maxDurationMin": 20, "maxUploadMb": 500}
SWITCHES = {"analysesPaused": False, "youtubeEnabled": True, "vocalsEnabled": True}
HEADERS = {"Authorization": f"Bearer tok-{ADMIN}"}

TODAY_COUNTERS: dict[str, Any] = {
    "analyses": {"link": 12, "file": 5, "mic": 1, "tab": 3},
    "vocals": 4,
    "failed": 2,
    "failedByReason": {"youtube_blocked": 1, "other": 1},
    "active": 7,
}


class Verifier:
    def verify_claims(self, token: str) -> tuple[str, Optional[float]]:
        return token.removeprefix("tok-"), time.time()

    def verify(self, token: str) -> str:
        return self.verify_claims(token)[0]


def put(db: DirectoryDb, s: Seed) -> None:
    """Store a fixture document the way ``DirectoryDb`` holds one read back (timestamps as ISO strings)."""
    db.docs[s.path] = {k: iso(v) if isinstance(v, datetime) else v for k, v in s.data.items()}


def seed_config(db: DirectoryDb, **switches: bool) -> None:
    db.docs[SETTINGS] = {"limits": dict(LIMITS), "switches": {**SWITCHES, **switches}, "updatedBy": ADMIN, "updatedAt": STAMP}
    db.docs[PUBLIC] = {
        "banner": {"enabled": False, "uk": "Технічні роботи", "en": "Maintenance"},
        "switches": {**SWITCHES, **switches},
        "updatedAt": STAMP,
    }


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> dict[str, datetime]:
    now = {"at": NOW}
    monkeypatch.setattr(router_mod, "utc_now", lambda: now["at"])
    return now


@pytest.fixture
def make_client(tmp_path: Path):
    clients: list[TestClient] = []

    def make(db: Any) -> TestClient:
        app = create_app(
            settings_for(tmp_path),
            analyzer=never,
            engine_info_fn=lambda: ENGINE_INFO,
            token_verifier=Verifier(),
            admin_db=db,
            admin_authz=AdminAuthz(db),
        )
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client

    yield make
    for c in clients:
        c.__exit__(None, None, None)


@pytest.fixture
def db() -> DirectoryDb:
    d = DirectoryDb()
    put(d, make_admin(ADMIN))
    seed_config(d)
    return d


def add_running(client: TestClient, uid: str, accepted_at: datetime, *, source: dict[str, Any], kind: str = "url") -> Any:
    """A job the server accepted and has not finished (nothing is run: the record is put in the manager)."""
    jobs = client.app.state.jobs
    rec = jobs._new_record(kind, {}, keys=set(), uid=uid, source=source)
    rec.created_ts = accepted_at.timestamp()
    return rec


YOUTUBE = {"type": "youtube", "url": "https://youtu.be/abc", "videoId": "abc", "filename": None}
UPLOAD = {"type": "file", "url": None, "videoId": None, "filename": "song.wav"}


# ===================================================================== AC-01: the overview


def test_overview_shows_current_utc_day_totals_running_jobs_and_switch_states(db, make_client, clock) -> None:
    put(db, make_stats_day(DAY, **TODAY_COUNTERS))
    put(db, make_stats_day("2026-10-07", vocals=99))                      # another day never leaks in
    db.add_user("u-early", "early@example.test", datetime(2026, 10, 8, 0, 0, 0, tzinfo=timezone.utc))  # first second counts
    db.add_user("u-morning", "morning@example.test", datetime(2026, 10, 8, 8, 0, 0, tzinfo=timezone.utc))
    db.add_user("u-late", "late@example.test", datetime(2026, 10, 7, 23, 59, 59, tzinfo=timezone.utc))  # yesterday
    db.docs["adminEmailIndex/s000"] = {
        "entries": {"u-morning": "morning@example.test"}, "count": 1, "syncedThrough": STAMP, "fullSyncAt": STAMP,
    }
    seed_config(db, youtubeEnabled=False)
    client = make_client(db)
    add_running(client, "u-morning", datetime(2026, 10, 8, 9, 41, 0, tzinfo=timezone.utc), source=YOUTUBE)
    add_running(client, SMOKE_UID, datetime(2026, 10, 8, 9, 43, 0, tzinfo=timezone.utc), source=UPLOAD, kind="upload")
    add_running(client, "u-morning", datetime(2026, 10, 8, 9, 44, 0, tzinfo=timezone.utc), source=UPLOAD, kind="vocals")
    done = add_running(client, "u-morning", datetime(2026, 10, 8, 9, 30, 0, tzinfo=timezone.utc), source=YOUTUBE)
    done.status = "done"                                                  # finished: not "running now"
    cancelled = add_running(client, "u-morning", datetime(2026, 10, 8, 9, 31, 0, tzinfo=timezone.utc), source=YOUTUBE)
    cancelled.cancel.set()

    res = client.get("/api/admin/overview", headers=HEADERS)

    assert res.status_code == 200, res.text
    body = res.json()
    jobs = body.pop("runningJobs")
    assert body == {
        "day": DAY,
        "analyses": {"link": 12, "file": 5, "mic": 1, "tab": 3},
        "vocals": 4,
        "failed": 2,
        "failedByReason": {"youtube_blocked": 1, "other": 1},
        "active": 7,
        "newUsers": 2,
        "switches": {"analysesPaused": False, "youtubeEnabled": False, "vocalsEnabled": True},
    }
    for job in jobs:
        assert isinstance(job.pop("id"), str) and len(job["uid"]) > 0
    assert jobs == [
        {"uid": "u-morning", "email": "morning@example.test", "service": False, "kind": "analysis", "origin": "link",
         "acceptedAt": "2026-10-08T09:41:00Z"},
        {"uid": SMOKE_UID, "email": None, "service": True, "kind": "analysis", "origin": "file",
         "acceptedAt": "2026-10-08T09:43:00Z"},
        {"uid": "u-morning", "email": "morning@example.test", "service": False, "kind": "vocals", "origin": "file",
         "acceptedAt": "2026-10-08T09:44:00Z"},
    ]


def test_overview_of_a_day_without_events_is_all_zeros(db, make_client, clock) -> None:
    client = make_client(db)

    body = client.get("/api/admin/overview", headers=HEADERS).json()

    assert body == {
        "day": DAY,
        "analyses": {"link": 0, "file": 0, "mic": 0, "tab": 0},
        "vocals": 0,
        "failed": 0,
        "failedByReason": {},
        "active": 0,
        "newUsers": 0,
        "runningJobs": [],
        "switches": SWITCHES,
    }


def test_overview_follows_the_utc_day_at_midnight(db, make_client, clock) -> None:
    put(db, make_stats_day("2026-10-07", vocals=3))
    put(db, make_stats_day(DAY, vocals=8))
    client = make_client(db)

    clock["at"] = datetime(2026, 10, 7, 23, 59, 59, tzinfo=timezone.utc)
    before = client.get("/api/admin/overview", headers=HEADERS).json()
    clock["at"] = datetime(2026, 10, 8, 0, 0, 0, tzinfo=timezone.utc)
    after = client.get("/api/admin/overview", headers=HEADERS).json()

    assert (before["day"], before["vocals"]) == ("2026-10-07", 3)
    assert (after["day"], after["vocals"]) == (DAY, 8)


def test_overview_reads_one_stats_document_and_counts_new_users_server_side(db, make_client, clock) -> None:
    put(db, make_stats_day(DAY, **TODAY_COUNTERS))
    for i in range(300):
        db.add_user(f"u{i:03d}", f"u{i:03d}@example.test", NOW - timedelta(minutes=i))
    client = make_client(db)
    db.reset_counters()

    res = client.get("/api/admin/overview", headers=HEADERS)

    assert res.status_code == 200
    assert db.reads.get("adminStats") == 1
    assert db.reads.get("count:users") == 1
    assert "users" not in db.reads                                         # no user document is read to count


# ===================================================================== getSettings


def test_settings_returns_limits_switches_and_banner(db, make_client, clock) -> None:
    seed_config(db, vocalsEnabled=False)
    db.docs[PUBLIC]["banner"] = {"enabled": True, "uk": "Профілактика", "en": "Maintenance"}
    client = make_client(db)

    res = client.get("/api/admin/settings", headers=HEADERS)

    assert res.status_code == 200, res.text
    assert res.json() == {
        "limits": LIMITS,
        "switches": {"analysesPaused": False, "youtubeEnabled": True, "vocalsEnabled": False},
        "banner": {"enabled": True, "uk": "Профілактика", "en": "Maintenance"},
        "updatedAt": STAMP,
        "updatedBy": ADMIN,
    }


# ===================================================================== NFR: read budget, on the emulator

EMULATOR_DAY = "2031-03-04"
EMULATOR_NOW = datetime(2031, 3, 4, 10, 0, 0, tzinfo=timezone.utc)


def test_overview_on_the_emulator_stays_within_200_reads(admin_db, read_counter, make_client, clock) -> None:
    clock["at"] = EMULATOR_NOW
    seed_synthetic_users(admin_db, 500, prefix="ovw")                      # older users + the email index
    seeds = [
        make_admin(ADMIN),
        make_user("ovw-today-1", created_at=EMULATOR_NOW - timedelta(hours=5)),
        make_user("ovw-today-2", created_at=EMULATOR_NOW - timedelta(hours=1)),
        make_stats_day(EMULATOR_DAY, **TODAY_COUNTERS),
        Seed(SETTINGS, {"limits": dict(LIMITS), "switches": dict(SWITCHES), "updatedBy": ADMIN, "updatedAt": NOW}),
        Seed(PUBLIC, {"banner": {"enabled": False, "uk": "Технічні роботи", "en": "Maintenance"},
                      "switches": dict(SWITCHES), "updatedAt": NOW}),
    ]
    seeds += [make_stats_day(f"2031-02-{d:02d}", "frozen", vocals=d) for d in range(1, 28)]
    seed(admin_db, seeds)
    client = make_client(admin_db)
    add_running(client, "ovw-000007", EMULATOR_NOW - timedelta(minutes=4), source=YOUTUBE)
    add_running(client, "ovw-000008", EMULATOR_NOW - timedelta(minutes=2), source=UPLOAD, kind="upload")

    with read_counter.measure() as reads:
        overview = client.get("/api/admin/overview", headers=HEADERS)
        settings = client.get("/api/admin/settings", headers=HEADERS)

    assert overview.status_code == 200, overview.text
    assert settings.status_code == 200, settings.text
    body = overview.json()
    assert (body["day"], body["vocals"], body["active"], body["newUsers"]) == (EMULATOR_DAY, 4, 7, 2)
    assert body["analyses"] == {"link": 12, "file": 5, "mic": 1, "tab": 3}
    assert [(j["uid"], j["email"], j["origin"]) for j in body["runningJobs"]] == [
        ("ovw-000007", "ovw-000007@example.test", "link"),
        ("ovw-000008", "ovw-000008@example.test", "file"),
    ]
    assert settings.json()["limits"] == LIMITS
    assert reads.reads <= 200, f"{reads.reads} reads"

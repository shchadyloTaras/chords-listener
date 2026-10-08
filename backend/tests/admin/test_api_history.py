"""``GET /api/admin/jobs`` and ``GET /api/admin/stats`` (docs/features/admin: AC-07, AC-08, AC-09; T18).

The handlers run in the real app (default admin router, real allowlist check) over ``MemDb``, an in-memory stand-in
for ``FirestoreIndex`` that serves ``get`` / ``run_query`` / ``count`` and tallies the document reads the way
Firestore bills them. The tests at the bottom run the same flows on the Firestore emulator (skipped unless
FIRESTORE_EMULATOR_HOST is set); each of them uses a year of its own, so nothing needs cleaning up.
"""
from __future__ import annotations

import copy
import operator
import random
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from admin.fixtures import HOSTILE_STRINGS, Seed, make_job, make_stats_day, make_user, seed
from admin.test_authz import ENGINE_INFO, Clock, FakeVerifier, H, never, settings_for
from app.admin import models
from app.admin.authz import AdminAuthz
from app.admin.history import REASONS
from app.admin.directory import parse_time
from app.firestore import Document, FirestoreIndex
from app.main import create_app

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

UTC = timezone.utc
ADMIN = "admin-1"
PAGE = 50
READ_BUDGET = 200  # NFR: at most 200 document reads per screen / list page


# --------------------------------------------------------------------------- an in-memory Firestore


class MemDb(FirestoreIndex):
    """Documents by path, as ``FirestoreIndex`` reads them back (a timestamp is its ISO string). ``reads`` counts
    the documents each call returns (a miss and a ``count`` cost 1), which is what Firestore bills."""

    def __init__(self) -> None:
        super().__init__("p1", session_factory=lambda: None)
        self.docs: dict[str, dict[str, Any]] = {}
        self.reads = 0
        self.touched: list[str] = []  # collections read, in order

    def put(self, *seeds: Seed) -> None:
        for s in seeds:
            self.docs[s.path] = copy.deepcopy(s.data)

    @staticmethod
    def _out(data: dict[str, Any]) -> dict[str, Any]:
        def conv(v: Any) -> Any:
            if isinstance(v, datetime):
                return v.astimezone(UTC).isoformat().replace("+00:00", "Z")
            if isinstance(v, dict):
                return {k: conv(x) for k, x in v.items()}
            return copy.deepcopy(v)

        return conv(data)

    def get(self, path: str) -> Optional[Document]:
        self.touched.append(path.rsplit("/", 1)[0])
        self.reads += 1
        return Document(path, self._out(self.docs[path])) if path in self.docs else None

    @staticmethod
    def _cmp(a: Any, b: Any) -> Any:
        return (parse_time(a), parse_time(b)) if isinstance(a, (str, datetime)) and isinstance(b, (str, datetime)) and \
            (isinstance(a, datetime) or isinstance(b, datetime)) else (a, b)

    def _match(self, collection: str, filters: Any) -> list[tuple[str, dict[str, Any]]]:
        rows = [(p, d) for p, d in self.docs.items() if p.rsplit("/", 1)[0] == collection]
        for field, op, value in filters or []:
            def keep(d: dict[str, Any]) -> bool:
                if field not in d:
                    return False
                x, y = self._cmp(d[field], value)
                return {"==": operator.eq, ">=": operator.ge, ">": operator.gt, "<": operator.lt, "<=": operator.le}[op](x, y)

            rows = [(p, d) for p, d in rows if keep(d)]
        return rows

    def run_query(self, collection, *, filters=None, order_by=None, limit=None, start_after=None,
                  collection_group=False, transaction=None) -> list[Document]:
        self.touched.append(collection)
        rows = self._match(collection, filters)
        order = list(order_by or [])
        assert len(order) <= 1
        desc = bool(order) and order[0].startswith("-")
        field = order[0].lstrip("-") if order else None

        def key(path: str, data: dict[str, Any]) -> Any:
            return (parse_time(data[field]) if field else 0, path)

        if field:
            rows = [(p, d) for p, d in rows if field in d]
        rows.sort(key=lambda r: key(*r), reverse=desc)
        if start_after is not None:
            marker = key(start_after.path, start_after.data)
            rows = [r for r in rows if (key(*r) < marker if desc else key(*r) > marker)]
        if limit is not None:
            rows = rows[:limit]
        self.reads += max(1, len(rows))
        return [Document(p, self._out(d)) for p, d in rows]

    def count(self, collection, *, filters=None, collection_group=False) -> int:
        self.touched.append(collection)
        self.reads += 1
        return len(self._match(collection, filters))


# --------------------------------------------------------------------------- the app


class Env:
    def __init__(self, client: TestClient, db: Any, admin: str = ADMIN) -> None:
        self.client, self.db, self.admin = client, db, admin
        self.year = 0

    def get(self, path: str, **params: Any) -> Any:
        return self.client.get(path, params=params, headers=H(self.admin))


@pytest.fixture
def make_env(tmp_path: Path):
    clients: list[TestClient] = []

    def build(db: Any, admin: str = ADMIN) -> Env:
        clock = Clock()
        app = create_app(
            settings_for(tmp_path),
            analyzer=never,
            engine_info_fn=lambda: ENGINE_INFO,
            token_verifier=FakeVerifier(clock),
            admin_db=db,
            admin_authz=AdminAuthz(_Allow(admin), clock=clock),
        )
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return Env(client, db, admin)

    yield build
    for c in clients:
        c.__exit__(None, None, None)


class _Allow:
    """The allowlist, apart from the data: the data db's reads are counted per request."""

    def __init__(self, *uids: str) -> None:
        self.uids = set(uids)

    def get(self, path: str) -> Optional[Document]:
        return Document(path, {}) if path.rsplit("/", 1)[-1] in self.uids else None


@pytest.fixture
def mem() -> MemDb:
    return MemDb()


@pytest.fixture
def env(make_env, mem: MemDb) -> Env:
    return make_env(mem)


def at(day: str, hh: int = 9, mm: int = 0) -> datetime:
    return datetime.fromisoformat(day).replace(hour=hh, minute=mm, tzinfo=UTC)


def ids(body: dict[str, Any]) -> list[str]:
    return [item["id"] for item in body["items"]]


# --------------------------------------------------------------------------- AC-07: the history


def seed_week(db: MemDb) -> dict[str, str]:
    """Jobs of 2026-10-02 .. 2026-10-08: errors of several reasons and sources, plus jobs that did not fail."""
    db.put(make_user("u1", "user-1@example.test"), make_user("u2", "user-2@example.test"))
    jobs = {
        "yt-blocked-1": make_job("u1", "error", "youtube_blocked", "link", at("2026-10-08", 9), job_id="yt-blocked-1"),
        "yt-blocked-2": make_job("u2", "error", "youtube_blocked", "link", at("2026-10-07", 9), job_id="yt-blocked-2"),
        "yt-failed": make_job("u1", "error", "download_failed", "link", at("2026-10-05", 9), job_id="yt-failed"),
        "yt-other": make_job("u2", "error", "other", "link", at("2026-10-03", 9), job_id="yt-other"),
        "file-bad": make_job("u1", "error", "unsupported_format", "file", at("2026-10-06", 9), job_id="file-bad"),
        "mic-bad": make_job("u2", "error", "analysis_failed", "mic", at("2026-10-04", 9), job_id="mic-bad"),
        "link-done": make_job("u1", "done", None, "link", at("2026-10-06", 12), job_id="link-done"),
        "link-running": make_job("u2", "running", None, "link", at("2026-10-08", 10), job_id="link-running"),
        "too-old": make_job("u1", "error", "youtube_blocked", "link", at("2026-09-20", 9), job_id="too-old"),
    }
    db.put(*jobs.values())
    return {k: v.path for k, v in jobs.items()}


def test_history_filtered_by_error_and_link_returns_only_such_jobs_with_per_reason_counts(env: Env, mem: MemDb) -> None:
    seed_week(mem)

    r = env.get("/api/admin/jobs", status="error", origin="link", **{"from": "2026-10-02", "to": "2026-10-08"})

    assert r.status_code == 200, r.text
    body = r.json()
    assert ids(body) == ["yt-blocked-1", "yt-blocked-2", "yt-failed", "yt-other"]  # newest first
    assert all(i["status"] == "error" and i["origin"] == "link" for i in body["items"])
    assert body["countsByReason"] == {"youtube_blocked": 2, "download_failed": 1, "other": 1}
    assert body["hasNext"] is False and body["hasPrev"] is False and body["nextCursor"] is None
    first = body["items"][0]
    assert first == {
        "id": "yt-blocked-1", "uid": "u1", "email": "user-1@example.test", "userDeleted": False, "service": False,
        "kind": "analysis", "origin": "link", "status": "error", "reason": "youtube_blocked",
        "errorText": "Download failed", "title": "Test song",
        "acceptedAt": "2026-10-08T09:00:00Z", "finishedAt": "2026-10-08T09:00:30Z",
    }


def test_history_without_filters_lists_every_job_in_the_period_and_counts_only_failures(env: Env, mem: MemDb) -> None:
    seed_week(mem)

    body = env.get("/api/admin/jobs", **{"from": "2026-10-02", "to": "2026-10-08"}).json()

    assert len(body["items"]) == 8  # the job of 2026-09-20 is outside the period
    assert body["countsByReason"] == {
        "youtube_blocked": 2, "download_failed": 1, "other": 1, "unsupported_format": 1, "analysis_failed": 1,
    }
    done = next(i for i in body["items"] if i["id"] == "link-done")
    running = next(i for i in body["items"] if i["id"] == "link-running")
    assert done["reason"] is None and done["errorText"] is None
    assert running["finishedAt"] is None


def test_history_filtered_by_reason_and_period_ends_are_whole_days(env: Env, mem: MemDb) -> None:
    seed_week(mem)
    mem.put(make_job("u1", "error", "youtube_blocked", "link", at("2026-10-08", 23, 59), job_id="last-minute"))
    mem.put(make_job("u1", "error", "youtube_blocked", "link", at("2026-10-09", 0, 0), job_id="next-day"))

    body = env.get("/api/admin/jobs", reason="youtube_blocked", **{"from": "2026-10-07", "to": "2026-10-08"}).json()

    assert ids(body) == ["last-minute", "yt-blocked-1", "yt-blocked-2"]
    assert body["countsByReason"] == {"youtube_blocked": 3}


def test_history_with_no_match_is_empty_with_zero_counts(env: Env, mem: MemDb) -> None:
    seed_week(mem)

    body = env.get("/api/admin/jobs", status="error", origin="tab", **{"from": "2026-10-02", "to": "2026-10-08"}).json()

    assert body == {"items": [], "hasNext": False, "hasPrev": False, "nextCursor": None, "countsByReason": {}}


def test_history_shows_a_purged_user_as_deleted_without_email_or_title(env: Env, mem: MemDb) -> None:
    mem.put(
        make_job("gone", "error", "other", "link", at("2026-10-08"), job_id="j1", title=None),
        Seed("adminTombstones/gone", {"status": "done"}),
        make_job("never-seen", "done", None, "file", at("2026-10-08", 8), job_id="j2"),
    )

    items = {i["id"]: i for i in env.get("/api/admin/jobs").json()["items"]}

    assert items["j1"]["email"] is None and items["j1"]["userDeleted"] is True and items["j1"]["title"] is None
    assert items["j2"]["email"] is None and items["j2"]["userDeleted"] is False  # no tombstone: only the email is unknown


def test_history_marks_the_service_account_and_returns_user_text_verbatim(env: Env, mem: MemDb) -> None:
    mem.put(
        make_user("smoke", "smoke@example.test"),
        make_job("smoke", "error", "other", "link", at("2026-10-08"), job_id="s1", service=True,
                 errorText=HOSTILE_STRINGS[0], title=HOSTILE_STRINGS[1]),
    )

    item = env.get("/api/admin/jobs").json()["items"][0]

    assert item["service"] is True
    assert item["errorText"] == HOSTILE_STRINGS[0] and item["title"] == HOSTILE_STRINGS[1]


def test_history_pages_of_50_by_cursor_forwards_and_back_without_gaps_or_repeats(env: Env, mem: MemDb) -> None:
    mem.put(make_user("u1", "user-1@example.test"))
    base = at("2026-10-01", 0, 0)
    for n in range(120):  # n=119 is the newest; three share every minute so the ties are broken by id
        mem.put(make_job("u1", "done", None, "file", base + timedelta(minutes=n // 3), job_id=f"job-{n:03d}"))
    expected = [f"job-{n:03d}" for n in sorted(range(120), key=lambda n: (n // 3, f"job-{n:03d}"), reverse=True)]

    seen: list[str] = []
    pages: list[dict[str, Any]] = []
    cursor: Optional[str] = None
    while True:
        mem.reads = 0
        params = {"after": cursor} if cursor else {}
        body = env.get("/api/admin/jobs", **params).json()
        assert mem.reads <= READ_BUDGET, mem.reads
        assert len(body["items"]) <= PAGE
        pages.append(body)
        seen += ids(body)
        cursor = body["nextCursor"]
        assert body["hasNext"] is (cursor is not None)
        if not cursor:
            break

    assert [len(p["items"]) for p in pages] == [50, 50, 20]
    assert seen == expected
    assert [p["hasPrev"] for p in pages] == [False, True, True]

    # going back: the page that ends right before the last job of page 2 (index 99) is jobs 49 .. 98
    back = env.get("/api/admin/jobs", before=pages[1]["nextCursor"]).json()
    assert ids(back) == expected[49:99]
    assert back["hasNext"] is True and back["hasPrev"] is True
    assert back["nextCursor"] is not None
    start = env.get("/api/admin/jobs", before=pages[0]["nextCursor"]).json()  # before job 49: jobs 0 .. 48
    assert ids(start) == expected[:49] and start["hasPrev"] is False and start["hasNext"] is True


def test_history_limit_and_cursor_are_validated(env: Env, mem: MemDb) -> None:
    seed_week(mem)

    assert len(env.get("/api/admin/jobs", limit=2).json()["items"]) == 2
    for params in ({"limit": 0}, {"limit": 51}, {"status": "weird"}, {"reason": "nope"}, {"origin": "email"}):
        r = env.get("/api/admin/jobs", **params)
        assert (r.status_code, r.json()["code"]) == (422, "invalid_value"), params
    r = env.get("/api/admin/jobs", after="not-a-cursor")
    assert (r.status_code, r.json()["code"]) == (422, "invalid_value")


def test_history_page_stays_within_the_read_budget_on_a_worst_case_page(env: Env, mem: MemDb) -> None:
    """50 jobs of 50 different, purged users: 50 + 50 users + 50 tombstones + 7 counts is still <= 200."""
    for n in range(60):
        mem.put(make_job(f"gone-{n}", "error", REASONS[n % 7], "link", at("2026-10-08", 0, n), job_id=f"j{n:02d}"))
    mem.reads = 0

    body = env.get("/api/admin/jobs", status="error").json()

    assert len(body["items"]) == 50
    assert sum(body["countsByReason"].values()) == 60
    assert mem.reads <= READ_BUDGET, mem.reads


# --------------------------------------------------------------------------- AC-09: an invalid period


@pytest.mark.parametrize("path", ["/api/admin/jobs", "/api/admin/stats"])
@pytest.mark.parametrize(
    ("start", "end"),
    [("2026-10-08", "2026-10-07"), ("2026-07-01", "2026-10-08"), ("2026-07-10", "2026-10-08")],  # reversed, 100 d, 91 d
)
def test_an_invalid_period_is_refused_with_the_rule_and_nothing_is_read(env: Env, mem: MemDb, path: str, start: str, end: str) -> None:
    seed_week(mem)
    mem.reads = 0

    r = env.get(path, **{"from": start, "to": end})

    assert r.status_code == 422
    body = r.json()
    assert body["code"] == "invalid_period"
    assert "90" in body["detail"] and "no earlier" in body["detail"]
    assert mem.reads == 0 and mem.touched == []


@pytest.mark.parametrize("path", ["/api/admin/jobs", "/api/admin/stats"])
def test_a_period_of_exactly_90_days_and_a_single_day_are_accepted(env: Env, path: str) -> None:
    assert env.get(path, **{"from": "2026-07-11", "to": "2026-10-08"}).status_code == 200  # 90 days, both ends in
    assert env.get(path, **{"from": "2026-10-08", "to": "2026-10-08"}).status_code == 200


def test_stats_needs_both_ends_and_real_days(env: Env) -> None:
    for params in ({}, {"from": "2026-10-01"}, {"to": "2026-10-08"}, {"from": "yesterday", "to": "2026-10-08"},
                   {"from": "2026-02-30", "to": "2026-03-02"}):
        r = env.get("/api/admin/stats", **params)
        assert (r.status_code, r.json()["code"]) == (422, "invalid_value"), params


# --------------------------------------------------------------------------- AC-08: the stats


def seed_month(db: MemDb) -> None:
    """2026-09-09 .. 2026-10-08. Restored through 09-15, then live days with some quiet ones, 10-07 frozen, 10-08 live."""
    for n in range(7):
        day = (date(2026, 9, 9) + timedelta(days=n)).isoformat()
        db.put(make_stats_day(day, "restored", restoredTracks={"youtube": n, "url": 1, "file": 2}))
    db.put(
        make_stats_day("2026-09-20", analyses={"link": 4, "file": 3, "mic": 1, "tab": 0}, vocals=2, failed=2,
                       failedByReason={"youtube_blocked": 1, "other": 1}, active=5),
        make_stats_day("2026-10-07", "frozen", analyses={"link": 12, "file": 5, "mic": 1, "tab": 3}, vocals=4,
                       failed=1, failedByReason={"youtube_blocked": 1}, active=7, newUsers=2),
        make_stats_day("2026-10-08", analyses={"link": 1, "file": 0, "mic": 0, "tab": 0}, active=1),
        make_user("n1", created_at=at("2026-10-08", 7)),
        make_user("n2", created_at=at("2026-10-08", 8)),
        make_user("old", created_at=at("2026-10-07", 8)),
    )


def test_a_30_day_range_returns_one_entry_per_day_with_restored_days_flagged(env: Env, mem: MemDb, monkeypatch: Any) -> None:
    monkeypatch.setattr(models, "today_utc", lambda: date(2026, 10, 8))
    seed_month(mem)

    r = env.get("/api/admin/stats", **{"from": "2026-09-09", "to": "2026-10-08"})

    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["from"], body["to"]) == ("2026-09-09", "2026-10-08")
    days = body["days"]
    assert len(days) == 30
    assert [d["day"] for d in days] == [(date(2026, 9, 9) + timedelta(days=n)).isoformat() for n in range(30)]
    by_day = {d["day"]: d for d in days}

    restored = by_day["2026-09-12"]  # restored: only the songs per source, no failures
    assert restored["state"] == "restored"
    assert restored["restoredTracks"] == {"youtube": 3, "url": 1, "file": 2}
    assert restored["failed"] == 0 and restored["failedByReason"] == {} and restored["frozenAt"] is None
    assert restored["analyses"] == {"link": 0, "file": 0, "mic": 0, "tab": 0}
    assert restored["vocals"] == 0 and restored["active"] == 0 and restored["newUsers"] is None
    assert [d["state"] for d in days[:7]] == ["restored"] * 7 and all(d["state"] != "restored" for d in days[7:])

    busy = by_day["2026-09-20"]
    assert busy["state"] == "live" and busy["restoredTracks"] is None
    assert busy["analyses"] == {"link": 4, "file": 3, "mic": 1, "tab": 0}
    assert busy["failed"] == 2 and busy["failedByReason"] == {"youtube_blocked": 1, "other": 1}
    assert busy["vocals"] == 2 and busy["active"] == 5

    frozen = by_day["2026-10-07"]
    assert frozen["state"] == "frozen" and frozen["frozenAt"] == "2026-03-01T12:00:00Z" and frozen["newUsers"] == 2

    today = by_day["2026-10-08"]
    assert today["state"] == "live" and today["newUsers"] == 2  # a live day counts its new users on read


def test_a_day_without_activity_is_zeros(env: Env, mem: MemDb, monkeypatch: Any) -> None:
    monkeypatch.setattr(models, "today_utc", lambda: date(2026, 10, 8))
    seed_month(mem)

    quiet = {d["day"]: d for d in env.get("/api/admin/stats", **{"from": "2026-09-09", "to": "2026-10-08"}).json()["days"]}["2026-09-25"]

    assert quiet == {
        "day": "2026-09-25", "state": "live", "analyses": {"link": 0, "file": 0, "mic": 0, "tab": 0}, "vocals": 0,
        "failed": 0, "failedByReason": {}, "active": 0, "newUsers": None, "restoredTracks": None, "frozenAt": None,
    }


def test_stats_reads_one_document_per_day_and_never_more_than_90(env: Env, mem: MemDb) -> None:
    for n in range(90):
        mem.put(make_stats_day((date(2026, 7, 11) + timedelta(days=n)).isoformat(), "frozen"))
    mem.reads = 0

    body = env.get("/api/admin/stats", **{"from": "2026-07-11", "to": "2026-10-08"}).json()

    assert len(body["days"]) == 90
    assert mem.reads <= 90 + 2  # the days, plus a new-users count for a live today at most
    assert READ_BUDGET > mem.reads


def test_stats_of_a_frozen_day_do_not_move_when_the_live_counters_do(env: Env, mem: MemDb) -> None:
    mem.put(make_stats_day("2026-10-07", "frozen", vocals=4))
    first = env.get("/api/admin/stats", **{"from": "2026-10-07", "to": "2026-10-07"}).json()
    again = env.get("/api/admin/stats", **{"from": "2026-10-07", "to": "2026-10-07"}).json()
    assert first == again and first["days"][0]["vocals"] == 4


# --------------------------------------------------------------------------- access


@pytest.mark.parametrize("path", ["/api/admin/jobs", "/api/admin/stats"])
def test_a_non_admin_gets_the_unknown_address_answer_and_nothing_is_read(make_env, mem: MemDb, path: str) -> None:
    seed_week(mem)
    env = make_env(mem, admin="somebody-else")
    mem.reads = 0

    r = env.client.get(path, params={"from": "2026-10-01", "to": "2026-10-08"}, headers=H("not-an-admin"))

    assert r.status_code == 404 and r.json()["code"] == "not_found"
    assert mem.reads == 0


def test_the_admin_routes_are_left_out_of_the_public_openapi(env: Env) -> None:
    paths = env.client.get("/api/openapi.json").json().get("paths", {})
    assert not [p for p in paths if p.startswith("/api/admin")]


# --------------------------------------------------------------------------- Firestore emulator


@pytest.fixture
def emu(admin_db: FirestoreIndex, make_env, read_counter) -> Env:
    """The app over the emulator, signed in as a fresh admin; ``year`` keeps this test's documents apart."""
    env = make_env(admin_db, admin=f"admin-{random.randrange(10**9)}")
    env.year = random.randrange(3000, 9000)
    return env


def test_emulator_history_filters_combine_and_count_per_reason(emu: Env, read_counter: Any) -> None:
    y = emu.year
    day = lambda d: f"{y}-10-{d:02d}"  # noqa: E731
    uid = f"u-{random.randrange(10**9)}"
    seeds = [make_user(uid, "emu-user@example.test")]
    for d, reason, origin in [(8, "youtube_blocked", "link"), (7, "youtube_blocked", "link"), (6, "other", "link"),
                              (5, "unsupported_format", "file"), (4, "youtube_blocked", "tab")]:
        seeds.append(make_job(uid, "error", reason, origin, at(day(d)), job_id=f"{y}-{d}"))
    seeds.append(make_job(uid, "done", None, "link", at(day(8), 12), job_id=f"{y}-done"))
    seed(emu.db, seeds)

    with read_counter.measure() as m:
        r = emu.get("/api/admin/jobs", status="error", origin="link", **{"from": day(1), "to": day(9)})

    assert r.status_code == 200, r.text
    body = r.json()
    assert ids(body) == [f"{y}-8", f"{y}-7", f"{y}-6"]
    assert body["countsByReason"] == {"youtube_blocked": 2, "other": 1}
    assert body["items"][0]["email"] == "emu-user@example.test"
    assert m.reads <= READ_BUDGET


def test_emulator_history_pages_by_cursor(emu: Env) -> None:
    y = emu.year
    uid = f"u-{random.randrange(10**9)}"
    seed(emu.db, [make_job(uid, "done", None, "file", at(f"{y}-10-01") + timedelta(minutes=n), job_id=f"{y}-{n:03d}")
                  for n in range(75)])
    params = {"from": f"{y}-10-01", "to": f"{y}-10-01"}

    first = emu.get("/api/admin/jobs", **params).json()
    second = emu.get("/api/admin/jobs", after=first["nextCursor"], **params).json()

    assert (len(first["items"]), first["hasNext"]) == (50, True)
    assert (len(second["items"]), second["hasNext"], second["hasPrev"]) == (25, False, True)
    assert ids(first) + ids(second) == [f"{y}-{n:03d}" for n in range(74, -1, -1)]


def test_emulator_a_30_day_range_has_one_entry_per_day_and_restored_days_are_flagged(emu: Env, read_counter: Any) -> None:
    y = emu.year
    start = date(y, 9, 9)
    docs = [make_stats_day((start + timedelta(days=n)).isoformat(), "restored", restoredTracks={"youtube": 2, "url": 0, "file": 1})
            for n in range(5)]
    docs.append(make_stats_day((start + timedelta(days=12)).isoformat(), "frozen", vocals=3, active=2))
    seed(emu.db, docs)

    with read_counter.measure() as m:
        r = emu.get("/api/admin/stats", **{"from": start.isoformat(), "to": (start + timedelta(days=29)).isoformat()})

    assert r.status_code == 200, r.text
    days = r.json()["days"]
    assert len(days) == 30
    assert [d["state"] for d in days[:5]] == ["restored"] * 5
    assert days[0]["restoredTracks"] == {"youtube": 2, "url": 0, "file": 1} and days[0]["failed"] == 0
    assert days[12]["vocals"] == 3 and days[20]["state"] == "live" and days[20]["active"] == 0
    assert m.reads <= 90


def test_emulator_an_invalid_period_reads_nothing(emu: Env, read_counter: Any) -> None:
    with read_counter.measure() as m:
        r = emu.get("/api/admin/stats", **{"from": "2026-10-08", "to": "2026-10-01"})
    assert (r.status_code, r.json()["code"]) == (422, "invalid_period")
    assert m.reads == 0

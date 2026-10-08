"""NFR and security verification of the admin console (docs/features/admin T38; SAD §10 QG-1/QG-2/QG-3;
AC-02, AC-05, AC-24, AC-29, AC-32; test-plan "NFR validation").

Everything here runs on the Firestore emulator (``FIRESTORE_EMULATOR_HOST``; skipped without one) with the real
app, the real ``FirestoreIndex`` and real documents, so the numbers are the ones the cloud bills:

* ``TestReadBudget1000x20`` / ``TestReadBudget1x1000`` - at most 200 document reads for every admin endpoint on a
  store with 1 000 users x 20 songs and on one user with 1 000 songs. A new admin route without an entry in
  ``ENDPOINTS`` fails ``test_every_admin_route_has_a_read_budget_check``.
* ``TestSearchAt10000Users`` - user search p95 <= 1 s on 10 000 users.
* ``TestPropagation`` - a change made by one instance is seen by another within 60 s (revoked admin AC-32, default
  limit AC-24, switches, an account restriction). Time is simulated by default (one ``tick`` = one second, every
  cache clock is the same simulated clock), so CI does not wait; ``CHORDS_NFR_REALTIME=1`` runs the same checks in
  real time (scheduled / pre-release runs, test-plan "CI placement").
* ``TestPublicBanner`` - the banner reaches the public mirror the site reads without waking the server (AC-29).
* ``TestStoredText`` - text from users leaves the API as inert JSON (AC-05; the page side is frontend/e2e).

Cold-start p95 <= 15 s and warm p95 <= 2 s are measured on real Cloud Run after a deploy (manual, see
docs/features/admin/test-plan.md): they cannot be measured here.

Every address is on ``example.test``; no real personal data.
"""
from __future__ import annotations

import itertools
import math
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit
from typing import Any, Callable, Optional

import pytest
import requests
from fastapi.testclient import TestClient

from admin.fixtures import (
    ADMIN_EMAIL,
    EPOCH,
    HOSTILE_STRINGS,
    make_account_state,
    make_admin,
    make_audit,
    make_job,
    make_stats_day,
    make_tracks,
    make_user,
    seed,
    seed_synthetic_users,
)
from admin.test_api_users import encode_cursor
from admin.test_authz import ENGINE_INFO, FakeVerifier, H, never, settings_for
from app.admin.authz import ALLOWLIST_TTL_S
from app.admin.history import REASONS
from app.admin.router import get_services
from app.admin.router import router as admin_router
from app.admin.settings import CACHE_TTL_S, PUBLIC_FIELDS
from app.admission import STATE_TTL_S
from app.firestore import FirestoreIndex
from app.main import create_app

pytestmark = [
    pytest.mark.filterwarnings("ignore::DeprecationWarning"),
    pytest.mark.skipif(not os.environ.get("FIRESTORE_EMULATOR_HOST"), reason="needs the Firestore emulator (FIRESTORE_EMULATOR_HOST)"),
]

PROJECT = "build-chords-listener"
BOSS = "boss"
READ_BUDGET = 200  # spec §6: storage reads per screen or list page
SEARCH_P95_S = 1.0  # spec §6: user search at 10 000 users
PROPAGATION_S = 60  # spec §6: a change made by an admin is in force within a minute
LOGIN_AT = datetime(2026, 10, 7, 18, 20, tzinfo=timezone.utc)
REAL_TIME = os.environ.get("CHORDS_NFR_REALTIME") == "1"


# =========================================================================== harness


def emulator_db() -> FirestoreIndex:
    return FirestoreIndex(PROJECT, emulator_host=os.environ["FIRESTORE_EMULATOR_HOST"])


def wipe() -> None:
    """Empty the emulator (its own REST call): the big suites leave nothing behind for the tests after them."""
    host = os.environ["FIRESTORE_EMULATOR_HOST"]
    requests.delete(f"http://{host}/emulator/v1/projects/{PROJECT}/databases/(default)/documents", timeout=60).raise_for_status()


def percentile(samples: list[float], p: float) -> float:
    """Nearest rank: the smallest sample that at least ``p`` of the samples do not exceed."""
    ordered = sorted(samples)
    return ordered[max(0, math.ceil(p * len(ordered)) - 1)]


class Seconds:
    """Time for the propagation checks. Simulated: a mutable clock that ``tick`` advances. Real: ``tick`` sleeps."""

    def __init__(self, start: float = 1_800_000_000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return time.time() if REAL_TIME else self.now

    def tick(self, seconds: float = 1.0) -> None:
        if REAL_TIME:
            time.sleep(seconds)
        else:
            self.now += seconds


def build_app(tmp_path: Path, db: FirestoreIndex, clock: Optional[Seconds] = None) -> Any:
    """One server instance on the emulator. ``clock`` replaces the time of every admin cache of this instance."""
    app = create_app(
        settings_for(tmp_path), analyzer=never, engine_info_fn=lambda: ENGINE_INFO,
        token_verifier=FakeVerifier(clock or Seconds()), admin_db=db,
    )
    services = get_services(app)
    services.last_login = lambda _uid: LOGIN_AT
    if clock is not None and not REAL_TIME:
        app.state.admin_authz.clock = clock
        app.state.admin_authz.limiter._clock = clock
        services.settings._monotonic = clock
        app.state.admission._monotonic = clock
    return app


def days_back(n: int) -> list[str]:
    today = datetime.now(timezone.utc).date()
    return [(today - timedelta(days=i)).isoformat() for i in range(n)]


def timed(call: Callable[[], Any]) -> float:
    started = time.perf_counter()
    call()
    return time.perf_counter() - started


# =========================================================================== QG-2: ≤ 200 reads per endpoint


def seed_admin(db: FirestoreIndex) -> None:
    seed(db, [make_admin(BOSS), make_user(BOSS, ADMIN_EMAIL, created_at=EPOCH - timedelta(days=1))])


def seed_history(db: FirestoreIndex, uids: list[str], *, jobs: int, audits: int, days: int) -> None:
    """The collections whose pages the read budget is about: jobs of every status / reason / origin, the journal with a
    different target on every row (the worst case for the per-target lookup) and ``days`` stored live stats days."""
    now = datetime.now(timezone.utc).replace(microsecond=0)
    reasons = itertools.cycle(REASONS)
    origins = itertools.cycle(("link", "file", "mic", "tab"))
    statuses = itertools.cycle(("error", "done", "error", "running"))
    seed(db, [
        make_job(uids[i % len(uids)], status=(status := next(statuses)), reason=next(reasons), origin=next(origins),
                 accepted_at=now - timedelta(minutes=i), job_id=f"nfr-{i:05d}")
        for i in range(jobs)
    ])
    seed(db, [make_audit("view_card", admin_uid=BOSS, target_uid=uids[i % len(uids)], at=now - timedelta(seconds=i)) for i in range(audits)])
    seed(db, [make_stats_day(day, "live", vocals=3, failed=2, active=5, failedByReason={"other": 2}) for day in days_back(days)])


def endpoint_cases(uid: str, cursor: str) -> dict[tuple[str, str], list[tuple[str, Optional[dict]]]]:
    """(method, route template) -> the requests whose cost is measured: (url, json body). Several per route where the
    cost differs (a search against a card, the first page against a later one, filters)."""
    first, last = days_back(90)[-1], days_back(1)[0]
    p = "/api/admin"
    return {
        ("GET", f"{p}/overview"): [(f"{p}/overview", None)],
        ("GET", f"{p}/settings"): [(f"{p}/settings", None)],
        ("GET", f"{p}/users"): [(f"{p}/users?q=big-", None), (f"{p}/users?q=000123", None), (f"{p}/users?q=nobody-here", None)],
        ("GET", f"{p}/users/{{uid}}"): [(f"{p}/users/{uid}", None)],
        ("GET", f"{p}/users/{{uid}}/tracks"): [(f"{p}/users/{uid}/tracks", None), (f"{p}/users/{uid}/tracks?after={cursor}", None)],
        ("GET", f"{p}/jobs"): [
            (f"{p}/jobs", None), (f"{p}/jobs?status=error", None),
            (f"{p}/jobs?status=error&reason=other&origin=link&from={first}&to={last}", None),
        ],
        ("GET", f"{p}/stats"): [(f"{p}/stats?from={first}&to={last}", None)],  # the widest period: 90 stored live days
        ("GET", f"{p}/audit"): [(f"{p}/audit", None), (f"{p}/audit?action=view_card&adminUid={BOSS}", None)],
        ("PUT", f"{p}/settings/limits"): [(f"{p}/settings/limits", {"analyses": 30, "vocals": 15, "jobs": 2, "maxDurationMin": 15, "maxUploadMb": 50})],
        ("PUT", f"{p}/settings/switches/{{name}}"): [(f"{p}/settings/switches/youtubeEnabled", {"value": False})],
        ("PUT", f"{p}/settings/banner"): [(f"{p}/settings/banner", {"enabled": True, "uk": "Технічні роботи", "en": "Maintenance"})],
        ("POST", f"{p}/users/{{uid}}/quota/reset"): [(f"{p}/users/{uid}/quota/reset", None)],
        # set before remove: the removal needs a stored limit (the cases run in this order on the same user)
        ("PUT", f"{p}/users/{{uid}}/limit"): [(f"{p}/users/{uid}/limit", {"analyses": 5, "vocals": 2, "jobs": 1})],
        ("DELETE", f"{p}/users/{{uid}}/limit"): [(f"{p}/users/{uid}/limit", None)],
        # restrict before lift: lifting needs a stored restriction
        ("PUT", f"{p}/users/{{uid}}/restriction"): [(f"{p}/users/{uid}/restriction", {"reason": "automated mass requests"})],
        ("DELETE", f"{p}/users/{{uid}}/restriction"): [(f"{p}/users/{uid}/restriction", None)],
    }


ENDPOINTS_SEEN = {(next(iter(r.methods - {"HEAD", "OPTIONS"})), r.path) for r in admin_router.routes}


def measure(tmp_path: Path, db: FirestoreIndex, read_counter: Any, method: str, url: str, body: Optional[dict]) -> tuple[int, int]:
    """Reads of ONE request on a freshly started instance (nothing cached: the worst case) -> (status, reads)."""
    app = build_app(tmp_path, db)
    with TestClient(app) as client:
        with read_counter.measure() as cost:
            res = client.request(method, url, json=body, headers=H(BOSS))
    return res.status_code, cost.reads


def assert_within_budget(tmp_path: Path, db: FirestoreIndex, read_counter: Any, cases: dict[tuple[str, str], list[tuple[str, Optional[dict]]]]) -> None:
    over: list[str] = []
    for (method, _template), requests_ in cases.items():
        for url, body in requests_:
            status, reads = measure(tmp_path, db, read_counter, method, url, body)
            assert status == 200, (method, url, status)
            if reads > READ_BUDGET:
                over.append(f"{method} {url}: {reads} reads")
    assert not over, "over the budget of 200 reads: " + "; ".join(over)


class TestReadBudget1000x20:
    """1 000 users x 20 songs, 300 jobs, 120 journal rows by different targets, 90 stored days."""

    @pytest.fixture(scope="class")
    def store(self):
        db = emulator_db()
        wipe()
        seed_admin(db)
        uids = seed_synthetic_users(db, 1000, prefix="big")
        seed(db, itertools.chain.from_iterable(make_tracks(uid, 20) for uid in uids))
        seed_history(db, uids, jobs=300, audits=120, days=90)
        yield SimpleNamespace(db=db, uids=uids)
        wipe()

    def test_every_admin_route_has_a_read_budget_check(self) -> None:
        covered = set(endpoint_cases("u", "c"))
        assert ENDPOINTS_SEEN == covered, f"admin routes without a read-budget case: {sorted(ENDPOINTS_SEEN - covered)}; stale cases: {sorted(covered - ENDPOINTS_SEEN)}"

    def test_every_endpoint_reads_at_most_200_documents(self, store: SimpleNamespace, read_counter: Any, tmp_path: Path) -> None:
        uid = store.uids[500]
        after_the_tenth = encode_cursor("2026-03-01T12:10:00Z", f"{10:012x}")  # a position inside the 20 songs of the user
        assert_within_budget(tmp_path, store.db, read_counter, endpoint_cases(uid, after_the_tenth))

    def test_the_cost_does_not_grow_with_the_number_of_users(self, store: SimpleNamespace, read_counter: Any, tmp_path: Path) -> None:
        # the same screens on 1 user instead of 1 000 cost about the same: nothing scans the users
        _, overview = measure(tmp_path, store.db, read_counter, "GET", "/api/admin/overview", None)
        _, settings = measure(tmp_path, store.db, read_counter, "GET", "/api/admin/settings", None)
        assert overview < 20 and settings < 20, (overview, settings)


class TestReadBudget1x1000:
    """One user with 1 000 songs: the card and every page of the song list."""

    UID = "solo-user"

    @pytest.fixture(scope="class")
    def store(self):
        db = emulator_db()
        wipe()
        seed_admin(db)
        seed(db, [make_user(self.UID, "solo@example.test"), *make_tracks(self.UID, 1000)])
        seed_history(db, [self.UID], jobs=60, audits=30, days=3)
        yield SimpleNamespace(db=db)
        wipe()

    def test_the_card_and_every_page_of_songs_read_at_most_200_documents(self, store: SimpleNamespace, read_counter: Any, tmp_path: Path) -> None:
        reads: list[tuple[str, int]] = []
        status, card_reads = measure(tmp_path, store.db, read_counter, "GET", f"/api/admin/users/{self.UID}", None)
        assert status == 200
        reads.append(("card", card_reads))
        app = build_app(tmp_path, store.db)
        with TestClient(app) as client:
            cursor: Optional[str] = client.get(f"/api/admin/users/{self.UID}", headers=H(BOSS)).json()["tracks"]["nextCursor"]
            pages = 0
            while cursor:
                pages += 1
                with read_counter.measure() as cost:
                    page = client.get(f"/api/admin/users/{self.UID}/tracks", params={"after": cursor}, headers=H(BOSS))
                assert page.status_code == 200
                reads.append((f"page {pages + 1}", cost.reads))
                cursor = page.json()["nextCursor"]
        assert pages == 19  # 1 000 songs = 20 pages of 50: the first one comes with the card
        assert [name for name, n in reads if n > READ_BUDGET] == [], reads


# =========================================================================== QG-2: search p95 at 10 000 users


QUERIES = (
    ["syn", "synt", "synth", "synthetic-0", "synthetic-00", "ETIC-00", "example", ".test", "@example.test"]
    + [f"synthetic-{n:06d}@example" for n in (0, 41, 777, 4217, 9999)]
    + [f"{n:05d}" for n in (7, 99, 1234, 5678, 9876)]
    + ["zzzzzz", "no-such-user-at-all", "ivan.petrenko"]
)


class TestSearchAt10000Users:
    @pytest.fixture(scope="class")
    def store(self):
        db = emulator_db()
        wipe()
        seed_admin(db)
        seed_synthetic_users(db, 10_000)
        yield SimpleNamespace(db=db)
        wipe()

    def test_search_p95_is_at_most_a_second(self, store: SimpleNamespace, tmp_path: Path) -> None:
        with TestClient(build_app(tmp_path, store.db)) as client:
            samples: list[float] = []
            for _round in range(3):  # 3 x 22 requests; the very first one finds the index cold
                for q in QUERIES:
                    def search(q: str = q) -> None:
                        res = client.get("/api/admin/users", params={"q": q}, headers=H(BOSS))
                        assert res.status_code == 200, res.text

                    samples.append(timed(search))
        assert len(samples) >= 60
        p95 = percentile(samples, 0.95)
        assert p95 <= SEARCH_P95_S, f"p95 {p95:.3f}s (max {max(samples):.3f}s, cold {samples[0]:.3f}s)"
        assert samples[0] <= 5 * SEARCH_P95_S, f"the cold first search took {samples[0]:.3f}s"

    def test_a_search_over_10000_users_still_reads_at_most_200_documents(self, store: SimpleNamespace, read_counter: Any, tmp_path: Path) -> None:
        status, reads = measure(tmp_path, store.db, read_counter, "GET", "/api/admin/users?q=synthetic-00", None)
        assert status == 200
        assert reads <= READ_BUDGET, reads


# =========================================================================== QG-1 / QG-3: a change takes effect ≤ 60 s


def first_second(clock: Seconds, seen: Callable[[], bool], limit: int = PROPAGATION_S) -> Optional[int]:
    """Seconds after the change until ``seen()`` is true, checking every second; None if not within ``limit``."""
    for elapsed in range(limit + 1):
        if seen():
            return elapsed
        clock.tick(1)
    return None


class TestPropagation:
    @pytest.fixture
    def db(self):
        db = emulator_db()
        wipe()
        seed_admin(db)
        seed(db, [make_user("u1", "u1@example.test")])
        yield db
        wipe()

    def test_a_revoked_admin_is_refused_everywhere_within_a_minute(self, db: FirestoreIndex, tmp_path: Path) -> None:
        """AC-32: the allowlist mark is removed; the already open admin page is refused on every route and for data."""
        clock = Seconds()
        seed(db, [make_admin("trusted"), make_user("trusted", "trusted@example.test")])
        with TestClient(build_app(tmp_path, db, clock)) as client:
            as_trusted = H("trusted")
            assert client.get("/api/admin/overview", headers=as_trusted).status_code == 200  # the allowlist is now cached
            clock.tick(1)
            db.commit([db.delete_op("adminAllowlist/trusted")])
            refused_after = first_second(clock, lambda: client.get("/api/admin/overview", headers=as_trusted).status_code == 404)
            assert refused_after is not None and refused_after <= PROPAGATION_S, refused_after
            unknown = client.get("/api/admin/no-such-route", headers=as_trusted)
            assert unknown.status_code == 404 and unknown.json()["code"] == "not_found"
            for method, url, body in [
                ("GET", "/api/admin/overview", None), ("GET", "/api/admin/settings", None),
                ("GET", "/api/admin/users?q=u1@", None), ("GET", "/api/admin/users/u1", None),
                ("GET", "/api/admin/users/u1/tracks", None), ("GET", "/api/admin/jobs", None),
                ("GET", "/api/admin/stats?from=2026-10-01&to=2026-10-02", None), ("GET", "/api/admin/audit", None),
                ("PUT", "/api/admin/settings/limits", {"analyses": 1, "vocals": 1, "jobs": 1, "maxDurationMin": 1, "maxUploadMb": 1}),
                ("PUT", "/api/admin/settings/switches/analysesPaused", {"value": True}),
                ("PUT", "/api/admin/settings/banner", {"enabled": True, "uk": "x", "en": "y"}),
                ("POST", "/api/admin/users/u1/quota/reset", None),
                ("PUT", "/api/admin/users/u1/limit", {"analyses": 5}),
                ("DELETE", "/api/admin/users/u1/limit", None),
                ("PUT", "/api/admin/users/u1/restriction", {"reason": "abuse"}),
                ("DELETE", "/api/admin/users/u1/restriction", None),
            ]:
                res = client.request(method, url, json=body, headers=as_trusted)
                assert res.status_code == unknown.status_code == 404, (method, url, res.status_code)
                # the same answer as for an address that was never there (only the echoed path differs)
                assert res.json() == {**unknown.json(), "detail": f"Unknown API endpoint: {urlsplit(url).path}"}, (method, url)
                assert dict(res.headers).keys() == dict(unknown.headers).keys(), (method, url)
            assert "u1@example.test" not in client.get("/api/admin/users?q=u1@", headers=as_trusted).text
        assert ALLOWLIST_TTL_S <= PROPAGATION_S

    def test_a_default_limit_changed_on_one_instance_applies_on_another_within_a_minute(self, db: FirestoreIndex, tmp_path: Path) -> None:
        """AC-24: 40 -> 30 on the instance the admin talks to; another instance, with the old value cached, follows."""
        clock = Seconds()
        seed(db, [make_user("u2", "u2@example.test")])
        limits = {"analyses": 40, "vocals": 15, "jobs": 2, "maxDurationMin": 15, "maxUploadMb": 50}
        with TestClient(build_app(tmp_path, db, clock)) as acting, TestClient(build_app(tmp_path, db, clock)) as other:
            assert acting.put("/api/admin/settings/limits", json=limits, headers=H(BOSS)).status_code == 200
            other_admission = other.app.state.admission
            assert other_admission.defaults().analyses == 40 and other_admission.personal("u2") is None  # cached on 'other'
            clock.tick(1)
            changed = acting.put("/api/admin/settings/limits", json={**limits, "analyses": 30}, headers=H(BOSS))
            assert changed.status_code == 200 and changed.json()["limits"]["analyses"] == 30
            seen_after = first_second(clock, lambda: other_admission.defaults().analyses == 30)
            assert seen_after is not None and seen_after <= PROPAGATION_S, seen_after
            assert other.get("/api/admin/settings", headers=H(BOSS)).json()["limits"]["analyses"] == 30
            assert other_admission.personal("u2") is None  # no personal limit: the new default applies to this user
        entries = [d for d in db.run_query("adminAudit", filters=[("action", "==", "defaults_changed")], order_by=["at"])]
        assert entries[-1].data["before"]["analyses"] == 40 and entries[-1].data["after"]["analyses"] == 30
        assert CACHE_TTL_S <= PROPAGATION_S

    def test_a_switch_flipped_on_one_instance_applies_on_another_within_a_minute(self, db: FirestoreIndex, tmp_path: Path) -> None:
        clock = Seconds()
        with TestClient(build_app(tmp_path, db, clock)) as acting, TestClient(build_app(tmp_path, db, clock)) as other:
            assert acting.put("/api/admin/settings/switches/vocalsEnabled", json={"value": True}, headers=H(BOSS)).status_code == 200
            other_settings = get_services(other.app).settings
            assert other_settings.current().switches.vocals_enabled is True
            clock.tick(1)
            assert acting.put("/api/admin/settings/switches/vocalsEnabled", json={"value": False}, headers=H(BOSS)).status_code == 200
            seen_after = first_second(clock, lambda: other_settings.current().switches.vocals_enabled is False)
            assert seen_after is not None and seen_after <= PROPAGATION_S, seen_after

    def test_a_restriction_set_on_one_instance_applies_on_another_within_a_minute(self, db: FirestoreIndex, tmp_path: Path) -> None:
        clock = Seconds()
        with TestClient(build_app(tmp_path, db, clock)) as other:
            admission = other.app.state.admission
            assert admission.state("u1").restricted is False  # cached
            clock.tick(1)
            seed(db, [make_account_state("u1", restriction={"reason": "abuse", "since": EPOCH, "byAdminUid": BOSS})])
            seen_after = first_second(clock, lambda: admission.state("u1").restricted)
            assert seen_after is not None and seen_after <= PROPAGATION_S, seen_after
        assert STATE_TTL_S <= PROPAGATION_S


# =========================================================================== AC-29: the banner needs no server


class TestPublicBanner:
    def test_the_published_banner_is_in_the_document_the_site_reads_and_leaves_with_a_switch_off(self, tmp_path: Path) -> None:
        db = emulator_db()
        wipe()
        try:
            seed_admin(db)
            with TestClient(build_app(tmp_path, db)) as client:
                texts = {"enabled": True, "uk": "Технічні роботи до 18:00", "en": "Maintenance until 18:00"}
                assert client.put("/api/admin/settings/banner", json=texts, headers=H(BOSS)).status_code == 200
                public = db.get("publicStatus/current")
                assert public is not None
                assert set(public.data) <= PUBLIC_FIELDS, f"the public mirror leaks {sorted(set(public.data) - PUBLIC_FIELDS)}"
                assert public.data["banner"] == texts
                assert client.put("/api/admin/settings/banner", json={**texts, "enabled": False}, headers=H(BOSS)).status_code == 200
                gone = db.get("publicStatus/current")
                assert gone is not None and gone.data["banner"]["enabled"] is False  # the next visit of a guest shows nothing
                audits = db.run_query("adminAudit", filters=[("action", "==", "banner_changed")], order_by=["at"])
                assert [a.data["after"]["enabled"] for a in audits] == [True, False]
        finally:
            wipe()


# =========================================================================== AC-05: user text leaves the API as inert data


class TestStoredText:
    def test_hostile_strings_come_back_verbatim_as_json_and_never_as_a_page(self, tmp_path: Path) -> None:
        db = emulator_db()
        wipe()
        try:
            seed_admin(db)
            seed(db, [make_user("mallory", "x+<b>@example.test"), *make_tracks("mallory", len(HOSTILE_STRINGS), titles=HOSTILE_STRINGS)])
            seed(db, [make_job("mallory", status="error", reason="other", job_id="hostile-job", errorText=HOSTILE_STRINGS[0], title=HOSTILE_STRINGS[1])])
            with TestClient(build_app(tmp_path, db)) as client:
                res = client.get("/api/admin/users/mallory", headers=H(BOSS))
                assert res.status_code == 200, res.text
                assert res.headers["content-type"].startswith("application/json")  # never text/html: opening the URL shows data
                card = res.json()
                titles = {t["title"] for t in card["tracks"]["items"]}
                assert {s[:300] for s in HOSTILE_STRINGS} == titles
                assert card["profile"]["email"] == "x+<b>@example.test"
                job = card["recentJobs"][0]
                assert job["errorText"] == HOSTILE_STRINGS[0] and job["title"] == HOSTILE_STRINGS[1]
        finally:
            wipe()

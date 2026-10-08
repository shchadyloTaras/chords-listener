"""The admin test fixtures themselves (T02, AC-05): factories, hostile strings, the seeder and the read counter.

Offline tests pin the shapes and the PII guard; the emulator tests (they run only when FIRESTORE_EMULATOR_HOST
is set) prove the seeder and the read counter against a real Firestore.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from admin import fixtures as fx
from app.firestore import FirestoreIndex

EMULATOR = pytest.mark.skipif(not os.environ.get("FIRESTORE_EMULATOR_HOST"), reason="needs the Firestore emulator")
T0 = datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc)


def strings(value: Any):
    """Every string inside nested dicts / lists / Seeds."""
    if isinstance(value, fx.Seed):
        yield value.path
        yield from strings(value.data)
    elif isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield str(k)
            yield from strings(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            yield from strings(v)


# ----------------------------------------------------------------------------- factories


def test_make_admin_is_an_allowlist_entry_with_an_example_test_email():
    seed = fx.make_admin()
    assert seed.path == "adminAllowlist/admin-1"
    assert set(seed.data) == {"grantedAt", "note"}
    assert fx.ADMIN_EMAIL == "admin@example.test"
    assert fx.make_admin("admin-7").path == "adminAllowlist/admin-7"


def test_make_user_has_the_users_shape_with_default_settings():
    seed = fx.make_user("u1", created_at=T0)
    assert seed.path == "users/u1"
    assert seed.data["email"] == "user-u1@example.test"
    assert seed.data["createdAt"] == T0
    assert set(seed.data) == {"email", "createdAt", "updatedAt", "settings"}
    # exactly the 11 keys firestore.rules allows
    assert set(seed.data["settings"]) == {
        "simplify", "accidentals", "instrument", "view", "barsPerLine", "follow", "showDiagrams",
        "copyFormat", "theme", "lang", "showVideo",
    }
    assert fx.make_user("u2", email="Mixed@example.test").data["email"] == "Mixed@example.test"
    assert fx.make_user().path != fx.make_user().path  # a fresh uid each time


def test_make_tracks_builds_n_documents_under_the_user():
    seeds = fx.make_tracks("u1", 3, start=T0, origin="link", size=42)
    assert [s.path for s in seeds] == [f"users/u1/tracks/{i:012x}" for i in range(3)]
    first = seeds[0].data
    assert first["sizeBytes"] == 42
    assert first["source"]["type"] == "youtube"
    assert first["createdAt"] == "2026-03-01T12:00:00Z"          # an ISO-8601 Z string, like the real tracks
    assert [s.data["createdAt"] for s in seeds] == sorted(s.data["createdAt"] for s in seeds)
    assert fx.make_tracks("u1", 1, origin="file")[0].data["source"]["type"] == "file"
    assert fx.make_tracks("u1", 0) == []


def test_make_tracks_takes_titles_so_hostile_text_can_be_planted():
    seeds = fx.make_tracks("u1", 5, titles=["a", "b"])
    assert [s.data["title"] for s in seeds] == ["a", "b", "a", "b", "a"]


def test_make_account_state_is_sparse_admin_state():
    restriction = {"reason": "spam", "since": T0, "byAdminUid": "admin-1"}
    seed = fx.make_account_state("u1", restriction=restriction)
    assert seed.path == "adminAccounts/u1"
    assert seed.data["restriction"] == restriction
    assert seed.data["deletion"] is None and seed.data["personalLimit"] is None
    assert "updatedAt" in seed.data


def test_make_job_defaults_to_a_youtube_block_and_derives_day_and_expiry():
    seed = fx.make_job("u1", accepted_at=T0, job_id="j1")
    assert seed.path == "adminJobs/j1"
    d = seed.data
    assert (d["uid"], d["status"], d["reason"], d["origin"]) == ("u1", "error", "youtube_blocked", "link")
    assert d["day"] == "2026-03-01" and d["acceptedAt"] == T0
    assert (d["expireAt"] - T0).days == 90
    assert d["service"] is False and d["kind"] == "analysis"
    ok = fx.make_job("u1", status="done", reason=None).data
    assert ok["reason"] is None and ok["errorText"] is None and ok["finishedAt"] is not None
    running = fx.make_job("u1", status="running", reason=None).data
    assert running["finishedAt"] is None
    assert fx.make_job("u1", title="<b>x</b>").data["title"] == "<b>x</b>"


def test_make_stats_day_defaults_to_zero_counters():
    seed = fx.make_stats_day("2026-03-01")
    assert seed.path == "adminStats/2026-03-01"
    assert seed.data["state"] == "live"
    assert seed.data["analyses"] == {"link": 0, "file": 0, "mic": 0, "tab": 0}
    assert (seed.data["vocals"], seed.data["failed"], seed.data["active"]) == (0, 0, 0)
    d = fx.make_stats_day("2026-03-02", state="frozen", vocals=4, failed=2).data
    assert d["state"] == "frozen" and d["vocals"] == 4 and d["failed"] == 2 and d["frozenAt"] is not None


def test_make_audit_records_who_did_what():
    seed = fx.make_audit("restrict", target_uid="u1", at=T0, before={"a": 1})
    assert seed.path.startswith("adminAudit/") and len(seed.path) > len("adminAudit/")
    d = seed.data
    assert (d["action"], d["outcome"], d["adminUid"], d["targetUid"]) == ("restrict", "applied", "admin-1", "u1")
    assert d["adminEmail"] == fx.ADMIN_EMAIL and d["at"] == T0 and d["before"] == {"a": 1}
    assert (d["expireAt"] - T0).days == 400
    assert fx.make_audit("search", query="abc", matched_uids=["u1"]).data["matchedUids"] == ["u1"]
    assert fx.make_audit("x").path != fx.make_audit("x").path


# ----------------------------------------------------------------------------- PII guard + hostile strings


def test_every_factory_uses_example_test_addresses_only():
    seeds = [
        fx.make_admin(), fx.make_user("u1"), *fx.make_tracks("u1", 2), fx.make_account_state("u1"),
        fx.make_job("u1"), fx.make_stats_day("2026-03-01"), fx.make_audit("view_card", target_uid="u1"),
        *fx.synthetic_users(5),
    ]
    domains = {d for s in strings(seeds) for d in re.findall(r"@[A-Za-z0-9.-]+", s)}
    assert domains == {"@example.test"}


def test_hostile_strings_cover_markup_urls_bidi_and_length():
    h = fx.HOSTILE_STRINGS
    assert "<script>alert(1)</script>" in h
    assert '"><img src=x onerror=alert(1)>' in h
    assert "javascript:alert(1)" in h
    assert any("‮" in s for s in h)                       # right-to-left override
    assert any(len(s) >= 300 for s in h)
    assert "x+<b>@example.test" in fx.HOSTILE_EMAILS
    assert all(e.endswith("@example.test") for e in fx.HOSTILE_EMAILS)
    assert len(set(h)) == len(h)


# ----------------------------------------------------------------------------- the seeder (offline)


class RecordingSession:
    def __init__(self):
        self.commits: list[list[dict]] = []

    def request(self, method, url, json=None, headers=None, timeout=None):
        assert url.endswith(":commit") and method == "POST"
        self.commits.append(json["writes"])
        return SimpleNamespace(status_code=200, text="{}", content=b"{}", json=lambda: {})


def recording_db():
    s = RecordingSession()
    return FirestoreIndex("p1", session_factory=lambda: s), s


def test_synthetic_users_are_deterministic_and_unique():
    a, b = fx.synthetic_users(4), fx.synthetic_users(4)
    assert a == b and len({s.path for s in a}) == 4
    assert a[0].path == "users/synthetic-000000" and a[0].data["email"] == "synthetic-000000@example.test"


def test_seed_commits_in_batches_under_the_firestore_limit():
    db, s = recording_db()
    fx.seed(db, [fx.make_admin(f"a{i}") for i in range(1050)], batch=400)
    assert [len(c) for c in s.commits] == [400, 400, 250]
    assert all("update" in w for c in s.commits for w in c)


def test_seed_synthetic_users_writes_users_and_one_email_shard():
    db, s = recording_db()
    uids = fx.seed_synthetic_users(db, 1000)
    assert len(uids) == 1000 and uids[0] == "synthetic-000000"
    writes = [w for c in s.commits for w in c]
    assert len(writes) == 1000 + 1
    shard = next(w for w in writes if w["update"]["name"].endswith("/adminEmailIndex/s000"))
    fields = shard["update"]["fields"]
    assert fields["count"] == {"integerValue": "1000"}
    entries = fields["entries"]["mapValue"]["fields"]
    assert entries["synthetic-000000"] == {"stringValue": "synthetic-000000@example.test"}
    assert max(len(c) for c in s.commits) <= 500


def test_seed_synthetic_users_shards_big_populations():
    db, s = recording_db()
    fx.seed_synthetic_users(db, 25, shard_size=10)
    names = [w["update"]["name"].rsplit("/", 1)[1] for c in s.commits for w in c
             if "adminEmailIndex" in w["update"]["name"]]
    assert names == ["s000", "s001", "s002"]


# ----------------------------------------------------------------------------- the read counter


def test_count_reads_follows_firestore_billing():
    def ok(body, status=200):
        return SimpleNamespace(status_code=status, json=lambda: body)

    doc = "https://h/v1/projects/p/databases/(default)/documents"
    assert fx.count_reads("GET", f"{doc}/users/u1", ok({})) == 1
    assert fx.count_reads("GET", f"{doc}/users/u1", ok({}, 404)) == 1                       # a miss is billed
    assert fx.count_reads("POST", f"{doc}:batchGet", ok([{"found": {}}, {"missing": "x"}])) == 2
    assert fx.count_reads("POST", f"{doc}/users/u1:runQuery",
                          ok([{"document": {}}, {"document": {}}, {"readTime": "t"}])) == 2
    assert fx.count_reads("POST", f"{doc}:runQuery", ok([{"readTime": "t"}])) == 1          # empty result: billed 1
    assert fx.count_reads("POST", f"{doc}:runAggregationQuery", ok([{"result": {}}])) == 1
    for write in (":commit", ":beginTransaction", ":rollback"):
        assert fx.count_reads("POST", f"{doc}{write}", ok({})) == 0
    assert fx.count_reads("PATCH", f"{doc}/users/u1", ok({})) == 0


def test_read_counter_fixture_counts_reads_of_every_client(read_counter):
    rows = [{"document": {"name": "projects/p/databases/(default)/documents/c/1", "fields": {}}}]
    session = SimpleNamespace(request=lambda method, url, json=None, headers=None, timeout=None: SimpleNamespace(
        status_code=200, text="[]", content=b"[]", json=lambda: rows))
    db = FirestoreIndex("p", session_factory=lambda: session)
    with read_counter.measure() as m:
        db.run_query("c")
        db.run_query("c")
    assert m.reads == 2 and read_counter.reads == 2
    read_counter.reset()
    assert read_counter.reads == 0


# ----------------------------------------------------------------------------- the query guard of MemDb (T58)


def test_the_guard_is_off_by_default():
    db = fx.MemDb()
    db.run_query("adminJobs", filters=[("uid", "==", "u1")], order_by=["title", "-acceptedAt"])   # no index: served all the same


@pytest.mark.parametrize("filters, order_by", [
    ([("status", "==", "error")], ["-acceptedAt"]),                                      # one composite index
    ([("status", "==", "error"), ("reason", "==", "other")], ["-acceptedAt"]),           # two of them, merged
    ([("status", "==", "error"), ("acceptedAt", ">=", T0)], ["-acceptedAt"]),            # the range on the ordered field
    ([("day", "==", "2026-03-01")], []),                                                 # equalities: single-field indexes
    ([], ["-acceptedAt"]),                                                               # one field: its single-field index
])
def test_the_guard_serves_what_an_index_serves(filters, order_by):
    fx.MemDb(indexed=True).run_query("adminJobs", filters=filters, order_by=order_by)


@pytest.mark.parametrize("collection, filters, order_by", [
    ("adminJobs", [("uid", "==", "u1")], ["title"]),                                    # no composite index (uid, title)
    ("adminJobs", [], ["acceptedAt", "status"]),                                        # two orders, no index of them
    ("adminJobs", [("acceptedAt", ">=", T0)], ["status"]),                              # a range must be ordered first
    ("adminJobs", [("acceptedAt", ">=", T0), ("finishedAt", "<", T0)], []),             # ranges on two fields
    ("adminJobs", [("errorText", "==", "x")], []),                                      # exempt from indexing
    ("adminAudit", [("adminUid", "==", "a"), ("status", "==", "x")], ["-at"]),          # no (status, at) index to merge
])
def test_the_guard_refuses_what_no_index_serves(collection, filters, order_by):
    db = fx.MemDb(indexed=True)
    with pytest.raises(AssertionError, match="firestore.indexes.json"):
        db.run_query(collection, filters=filters, order_by=order_by)


def indexes_file(tmp_path: Path, *indexes: tuple[str, list[tuple[str, str]]]) -> Path:
    """A ``firestore.indexes.json`` holding just ``indexes``: (collection group, [(field, ASCENDING | DESCENDING)])."""
    spec = {"indexes": [{"collectionGroup": group, "queryScope": "COLLECTION",
                         "fields": [{"fieldPath": f, "order": o} for f, o in fields]} for group, fields in indexes],
            "fieldOverrides": []}
    path = tmp_path / "firestore.indexes.json"
    path.write_text(json.dumps(spec))
    return path


def test_the_guard_reads_an_index_only_in_its_declared_direction(tmp_path):
    """Production, 2026-10-08: with (uid ASC, acceptedAt DESC) deployed, ``uid == x`` ordered by acceptedAt DESC is
    served and ASC is FAILED_PRECONDITION "The query requires an index" (T64)."""
    guard = fx.IndexGuard(indexes_file(tmp_path, ("adminJobs", [("uid", "ASCENDING"), ("acceptedAt", "DESCENDING")])))
    guard.check("adminJobs", [("uid", "==", "u1")], ["-acceptedAt"])                   # as declared
    with pytest.raises(AssertionError, match="firestore.indexes.json"):
        guard.check("adminJobs", [("uid", "==", "u1")], ["acceptedAt"])                # the reversed sort
    with pytest.raises(AssertionError, match="firestore.indexes.json"):
        guard.check("adminJobs", [("uid", "==", "u1"), ("acceptedAt", "<", T0)], [])   # a range sorts ascending
    with pytest.raises(AssertionError, match="firestore.indexes.json"):
        guard.check("adminJobs", [("uid", "==", "u1"), ("acceptedAt", "<", T0)], None)  # an aggregation too


def test_merged_indexes_must_each_sort_in_the_direction_of_the_query(tmp_path):
    guard = fx.IndexGuard(indexes_file(
        tmp_path,
        ("adminJobs", [("status", "ASCENDING"), ("acceptedAt", "DESCENDING")]),
        ("adminJobs", [("reason", "ASCENDING"), ("acceptedAt", "DESCENDING")]),
        ("adminJobs", [("status", "ASCENDING"), ("acceptedAt", "ASCENDING")]),
    ))
    both = [("status", "==", "error"), ("reason", "==", "other")]
    guard.check("adminJobs", both, ["-acceptedAt"])                                     # both indexes sort this way
    guard.check("adminJobs", [both[0]], ["acceptedAt"])                                 # its own ascending index
    with pytest.raises(AssertionError, match="firestore.indexes.json"):
        guard.check("adminJobs", both, ["acceptedAt"])                                  # reason has no ascending one


def test_a_range_without_an_order_sorts_ascending_and_an_aggregation_needs_the_same_index(tmp_path):
    """Production, 2026-10-08: ``status == running AND acceptedAt < t`` with no orderBy (the sweep's stale jobs) and
    ``count()`` of ``reason == x AND acceptedAt >= t`` were FAILED_PRECONDITION against the descending indexes alone:
    the implicit order of an inequality is that field ascending, and an aggregation needs the query's index (T64)."""
    stale = [("status", "==", "running"), ("acceptedAt", "<", T0)]
    only_desc = fx.IndexGuard(indexes_file(tmp_path, ("adminJobs", [("status", "ASCENDING"), ("acceptedAt", "DESCENDING")])))
    for order in ([], None):
        with pytest.raises(AssertionError, match="firestore.indexes.json"):
            only_desc.check("adminJobs", stale, order)
    only_desc.check("adminJobs", stale, ["-acceptedAt"])                                   # the declared sort
    only_desc.check("adminJobs", [("acceptedAt", ">=", T0)], None)                         # a range alone: single-field
    asc = fx.IndexGuard(indexes_file(tmp_path, ("adminJobs", [("status", "ASCENDING"), ("acceptedAt", "ASCENDING")])))
    asc.check("adminJobs", stale, [])
    asc.check("adminJobs", stale, None)


def test_memdb_checks_a_count_like_the_query_it_counts(tmp_path, monkeypatch):
    monkeypatch.setattr(fx, "INDEXES_FILE", indexes_file(
        tmp_path, ("adminJobs", [("reason", "ASCENDING"), ("acceptedAt", "DESCENDING")])))
    db = fx.MemDb(indexed=True)
    db.run_query("adminJobs", filters=[("reason", "==", "other"), ("acceptedAt", ">=", T0)], order_by=["-acceptedAt"])
    with pytest.raises(AssertionError, match="firestore.indexes.json"):
        db.count("adminJobs", filters=[("reason", "==", "other"), ("acceptedAt", ">=", T0)])


def test_the_guard_checks_aggregations_and_their_kinds():
    db = fx.MemDb(indexed=True, aggregations=("count",))
    assert db.count("users", filters=[("createdAt", ">=", T0), ("createdAt", "<", T0)]) == 0
    with pytest.raises(AssertionError, match="sum"):
        db.aggregate("users/u1/tracks", {"n": "count", "b": ("sum", "sizeBytes")})
    with pytest.raises(AssertionError, match="firestore.indexes.json"):
        db.count("adminJobs", filters=[("uid", "==", "u1"), ("finishedAt", "<", T0)])


# ----------------------------------------------------------------------------- where shared fakes live (T63)


def test_no_admin_test_module_imports_another_test_module():
    """The admin feature's shared fakes, helpers and fixtures live in ``fixtures`` modules and ``conftest.py``: a test
    module that imports another one runs (and depends on) that module's setup, and a rename there breaks unrelated
    tests. Checked over the admin tests, the admission and grant tests and the cloud fixtures they share."""
    tests = Path(__file__).resolve().parents[1]
    files = [*sorted((tests / "admin").glob("*.py")), tests / "test_admission.py", tests / "test_admin_grant.py",
             tests / "cloud_fixtures.py"]
    importing = re.compile(r"^\s*(?:from|import)\s+(?:tests\.)?(?:admin\.)?test_\w+", re.MULTILINE)
    offenders = [f"{path.relative_to(tests)}: {m.group(0).strip()}"
                 for path in files for m in importing.finditer(path.read_text(encoding="utf-8"))]
    assert offenders == []


# ----------------------------------------------------------------------------- against the emulator


@EMULATOR
def test_read_counter_reports_the_reads_of_one_request(admin_db, read_counter):
    fx.seed(admin_db, [fx.make_user("t02-reader"), *fx.make_tracks("t02-reader", 5)])
    with read_counter.measure() as m:
        assert admin_db.get("users/t02-reader") is not None                          # 1
        assert admin_db.get("users/t02-nobody") is None                              # 1 (a miss is billed)
        assert len(admin_db.run_query("users/t02-reader/tracks", limit=3)) == 3      # 3
        assert admin_db.count("users/t02-reader/tracks") == 5                        # 1
    assert m.reads == 6


@EMULATOR
def test_smoke_seeds_1000_users_with_20_tracks_each(admin_db):
    uids = fx.seed_synthetic_users(admin_db, 1000, prefix="t02-smoke")
    fx.seed(admin_db, [t for u in uids for t in fx.make_tracks(u, 20)])
    assert admin_db.count("users/t02-smoke-000999/tracks") == 20
    assert admin_db.aggregate("users/t02-smoke-000000/tracks", {"n": "count", "b": ("sum", "sizeBytes")}) == {
        "n": 20, "b": 20_000_000}
    shard = admin_db.get("adminEmailIndex/s000")
    assert shard.data["entries"]["t02-smoke-000500"] == "t02-smoke-000500@example.test"


@EMULATOR
def test_seed_synthetic_users_10000_completes(admin_db):
    uids = fx.seed_synthetic_users(admin_db, 10_000, prefix="t02-big")
    assert len(uids) == 10_000
    assert admin_db.get("users/t02-big-009999") is not None
    assert admin_db.get("adminEmailIndex/s000").data["count"] == 10_000

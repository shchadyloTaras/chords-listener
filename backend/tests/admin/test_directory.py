"""The email-index directory (ADR-0009, data-model Aggregate 5): shard load, incremental catch-up, full sync and
in-memory substring search. Unit tests run against ``FakeDb``, an in-memory stand-in for ``FirestoreIndex`` that
applies the real REST write bodies; the tests at the bottom run the same flows on the Firestore emulator
(only when FIRESTORE_EMULATOR_HOST is set)."""
from __future__ import annotations

import copy
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import pytest

from admin.fixtures import MemDb
from app.admin import directory as dirmod
from app.admin.directory import Directory
from app.firestore import FirestoreIndex

T0 = datetime(2026, 10, 7, 12, 0, 0, tzinfo=timezone.utc)
INDEX = "adminEmailIndex"


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_ts(v: Any) -> datetime:
    return v if isinstance(v, datetime) else datetime.fromisoformat(v.replace("Z", "+00:00"))


class FakeDb(MemDb):
    """The shared ``MemDb`` plus the seeding helpers of the directory tests."""

    def add_user(self, uid: str, email: Optional[str], created: Optional[datetime]) -> None:
        data: dict[str, Any] = {"settings": {"theme": "dark"}}
        if email is not None:
            data["email"] = email
        if created is not None:
            data["createdAt"] = iso(created)
        self.docs[f"users/{uid}"] = data

    def shard_ids(self) -> list[str]:
        return sorted(p.split("/")[1] for p in self.docs if p.startswith(f"{INDEX}/"))


def email_of_user(i: int) -> str:
    return f"User{i}@Example.Test"


@pytest.fixture
def db() -> FakeDb:
    return FakeDb()


@pytest.fixture
def clock():
    class Clock:
        def __init__(self):
            self.now = T0
            self.mono = 1000.0

        def advance(self, seconds: float) -> None:
            self.now += timedelta(seconds=seconds)
            self.mono += seconds

    return Clock()


@pytest.fixture
def make_dir(db, clock):
    def make(**kw) -> Directory:
        return Directory(db, now=lambda: clock.now, monotonic=lambda: clock.mono, **kw)

    return make


def seed_ivans(db: FakeDb) -> None:
    db.add_user("u1", "Ivan.P@Example.Test", T0 - timedelta(days=3))
    db.add_user("u2", "John.Ivanov@example.test", T0 - timedelta(days=2))
    db.add_user("u3", "maria@example.test", T0 - timedelta(days=1))


def emails(matches) -> list[str]:
    return [m.email for m in matches]


# ===================================================================== AC-03 / AC-04: search


def test_email_search_matches_substring_anywhere_case_insensitively(db, make_dir):
    seed_ivans(db)
    d = make_dir()
    d.full_sync()
    for q in ("ivan", "IVAN", "  Ivan "):
        found = d.search(q)
        assert sorted(emails(found)) == ["ivan.p@example.test", "john.ivanov@example.test"], q
        assert sorted(m.uid for m in found) == ["u1", "u2"]
    assert emails(d.search("example.test")) == ["ivan.p@example.test", "john.ivanov@example.test", "maria@example.test"]
    assert emails(d.search("hn.iv")) == ["john.ivanov@example.test"]       # the middle of the address


def test_search_returns_matches_in_a_stable_order_by_email(db, make_dir):
    for i, e in enumerate(["c@x.test", "a@x.test", "b@x.test"]):
        db.add_user(f"u{i}", e, T0)
    d = make_dir()
    d.full_sync()
    assert emails(d.search("@x.test")) == ["a@x.test", "b@x.test", "c@x.test"]


def test_search_shorter_than_three_characters_is_not_executed(db, make_dir):
    seed_ivans(db)
    d = make_dir()
    d.full_sync()
    db.reset_counters()
    for q in ("", "iv", "  iv  ", "  "):
        with pytest.raises(ValueError):
            d.search(q)
    assert db.reads == {} and db.queries == []        # nothing was read: the search did not run


def test_search_with_no_match_is_empty(db, make_dir):
    seed_ivans(db)
    d = make_dir()
    d.full_sync()
    assert d.search("zzz-nobody") == []


def test_search_returns_at_most_fifty_results(db, make_dir):
    for i in range(80):
        db.add_user(f"u{i:03d}", f"match{i:03d}@example.test", T0 - timedelta(days=1))
    d = make_dir()
    d.full_sync()
    found = d.search("match")
    assert len(found) == dirmod.MAX_RESULTS == 50
    assert emails(found) == [f"match{i:03d}@example.test" for i in range(50)]


# ===================================================================== NFR: 10 000 users


def test_search_at_10000_users_is_fast_and_reads_few_shards(db, make_dir):
    for i in range(10_000):
        db.add_user(f"uid{i:05d}", email_of_user(i), T0 - timedelta(days=1, seconds=i))
    db.add_user("uid-ivan", "Ivan.Petrenko@Example.Test", T0 - timedelta(days=1))
    d = make_dir()
    d.full_sync()
    db.reset_counters()

    times = []
    for n in range(60):
        d_n = make_dir()                          # a cold instance every time: the shards are read from Firestore
        start = time.perf_counter()
        found = d_n.search("iVaN.pet")
        times.append(time.perf_counter() - start)
        assert emails(found) == ["ivan.petrenko@example.test"]
    times.sort()
    assert times[int(len(times) * 0.95) - 1] <= 1.0
    assert db.reads[INDEX] <= 10 * len(times)     # at most 10 shard reads per search (here: 1)
    assert db.reads[INDEX] // len(times) <= 10
    assert len(db.shard_ids()) == 1


# ===================================================================== catch-up


def test_a_new_registration_is_found_without_a_full_sync(db, make_dir, clock):
    seed_ivans(db)
    d = make_dir()
    d.full_sync()
    clock.advance(600)
    db.add_user("u4", "Ivanka@Example.Test", clock.now - timedelta(minutes=1))

    found = d.search("ivan")
    assert sorted(m.uid for m in found) == ["u1", "u2", "u4"]
    assert db.docs[f"{INDEX}/s000"]["entries"]["u4"] == "ivanka@example.test"
    assert db.docs[f"{INDEX}/s000"]["count"] == 4
    assert parse_ts(db.docs[f"{INDEX}/s000"]["syncedThrough"]) == clock.now - timedelta(minutes=1)

    other = make_dir()                              # another instance: the user is in the shards, nothing to catch up
    assert sorted(m.uid for m in other.search("ivan")) == ["u1", "u2", "u4"]


def test_catch_up_reads_only_users_created_after_the_cursor(db, make_dir, clock):
    for i in range(200):
        db.add_user(f"old{i}", f"old{i}@example.test", T0 - timedelta(days=5))
    d = make_dir()
    d.full_sync()
    clock.advance(3600)
    db.add_user("new1", "fresh@example.test", clock.now - timedelta(minutes=5))
    db.reset_counters()

    assert d.catch_up() == 1
    assert db.reads["users"] == 1                    # not the 200 old users
    filters = [f for c, f in db.queries if c == "users"]
    assert filters and filters[0][0][:2] == ("createdAt", ">")


def test_catch_up_with_nobody_new_changes_nothing(db, make_dir):
    seed_ivans(db)
    d = make_dir()
    d.full_sync()
    before = copy.deepcopy(db.docs)
    assert d.catch_up() == 0
    assert db.docs == before


def test_catch_up_fills_the_last_shard_then_opens_a_new_one(db, make_dir, clock):
    for i in range(4):
        db.add_user(f"u{i}", f"u{i}@x.test", T0 - timedelta(days=1))
    d = make_dir(shard_size=3)
    d.full_sync()
    assert db.shard_ids() == ["s000", "s001"] and db.docs[f"{INDEX}/s001"]["count"] == 1
    for i in range(4, 8):
        db.add_user(f"u{i}", f"u{i}@x.test", T0 + timedelta(minutes=i))
    clock.advance(3600)
    assert d.catch_up() == 4
    assert db.shard_ids() == ["s000", "s001", "s002"]
    assert [db.docs[f"{INDEX}/{s}"]["count"] for s in db.shard_ids()] == [3, 3, 2]
    assert sorted(m.uid for m in d.search("@x.test")) == [f"u{i}" for i in range(8)]
    cursors = {parse_ts(db.docs[f"{INDEX}/{s}"]["syncedThrough"]) for s in db.shard_ids()}
    assert cursors == {T0 + timedelta(minutes=7)}    # every shard moved to the newest createdAt folded in


def test_catch_up_pages_through_many_new_users(db, make_dir, clock, monkeypatch):
    monkeypatch.setattr(dirmod, "CATCH_UP_PAGE", 7)
    d = make_dir()
    db.add_user("seed", "seed@x.test", T0 - timedelta(days=1))
    d.full_sync()
    same_instant = T0 + timedelta(minutes=1)         # ties on createdAt must not be skipped at a page boundary
    for i in range(20):
        db.add_user(f"n{i:02d}", f"n{i:02d}@x.test", same_instant)
    clock.advance(3600)
    assert d.catch_up() == 20
    assert len(d.search("@x.test")) == 21


def test_catch_up_on_an_empty_index_builds_it(db, make_dir):
    seed_ivans(db)
    d = make_dir()
    assert sorted(emails(d.search("example"))) == ["ivan.p@example.test", "john.ivanov@example.test",
                                                   "maria@example.test"]
    assert db.shard_ids() == ["s000"]


# ===================================================================== full sync


def test_full_sync_rebuilds_shards_of_at_most_20000_entries(db, make_dir):
    assert dirmod.SHARD_SIZE == 20_000
    for i in range(20_001):
        db.add_user(f"u{i:05d}", f"u{i}@example.test", T0 - timedelta(days=2))
    d = make_dir()
    assert d.full_sync() == 20_001
    assert db.shard_ids() == ["s000", "s001"]
    for s in db.shard_ids():
        doc = db.docs[f"{INDEX}/{s}"]
        assert doc["count"] == len(doc["entries"]) <= 20_000
        assert set(doc) == {"entries", "count", "syncedThrough", "fullSyncAt"}
    assert sum(db.docs[f"{INDEX}/{s}"]["count"] for s in db.shard_ids()) == 20_001
    assert len(d.search("u20000@")) == 1


def test_full_sync_lowercases_skips_users_without_email_and_stamps_the_run(db, make_dir, clock):
    db.add_user("a", "Mixed.Case@Example.TEST", T0 - timedelta(days=1))
    db.add_user("b", None, T0 - timedelta(days=1))                    # a user with no email is not indexed
    db.add_user("c", "", T0 - timedelta(days=1))
    d = make_dir()
    assert d.full_sync() == 1
    doc = db.docs[f"{INDEX}/s000"]
    assert doc["entries"] == {"a": "mixed.case@example.test"}
    assert parse_ts(doc["fullSyncAt"]) == clock.now
    assert parse_ts(doc["syncedThrough"]) <= clock.now


def test_full_sync_converges_to_users_and_drops_leftover_shards(db, make_dir, clock):
    for i in range(5):
        db.add_user(f"u{i}", f"u{i}@x.test", T0 - timedelta(days=1))
    d = make_dir(shard_size=2)
    d.full_sync()
    assert db.shard_ids() == ["s000", "s001", "s002"]
    del db.docs["users/u3"], db.docs["users/u4"]
    db.add_user("u0", "renamed@x.test", T0 - timedelta(days=1))       # an email change lands at the next full sync
    clock.advance(43_200)
    assert d.full_sync() == 3
    assert db.shard_ids() == ["s000", "s001"]
    assert emails(d.search("renamed")) == ["renamed@x.test"] and d.search("u0@") == []
    assert d.search("u3@") == []


def test_full_sync_does_not_lose_a_user_registered_while_it_ran(db, make_dir, clock):
    """The cursor it leaves is the sync's start (minus a skew margin), not the newest createdAt it happened to read."""
    seed_ivans(db)
    d = make_dir()
    db.add_user("late", "latecomer@example.test", T0 - timedelta(seconds=30))   # created just before the sync started...
    # ...but, say, committed after the scan passed its email: simulate by hiding it from the scan.
    hidden = db.docs.pop("users/late")
    d.full_sync()
    db.docs["users/late"] = hidden
    assert emails(d.search("latecomer")) == ["latecomer@example.test"]


def test_s2_2_a_purged_uid_is_not_indexed_again_by_a_full_sync_or_a_catch_up(db, make_dir, clock):
    """A purged user's still-valid token can write ``users/{uid}`` back; the tombstone keeps it out of the index."""
    seed_ivans(db)
    d = make_dir()
    d.full_sync()
    db.add_user("back", "back@example.test", T0 - timedelta(days=2))
    db.docs["adminTombstones/back"] = {"status": "done"}
    d.full_sync()
    assert d.search("back@") == [] and d.email_of("back") is None
    db.add_user("back2", "back2@example.test", T0 + timedelta(seconds=5))
    db.docs["adminTombstones/back2"] = {"status": "purging"}
    clock.advance(3600)
    d.catch_up()
    assert d.search("back2@") == []


# ===================================================================== remove / email_of


def test_remove_takes_the_email_out_of_search_and_the_shard(db, make_dir):
    seed_ivans(db)
    d = make_dir()
    d.full_sync()
    assert d.remove("u1") is True
    assert emails(d.search("ivan")) == ["john.ivanov@example.test"]
    doc = db.docs[f"{INDEX}/s000"]
    assert "u1" not in doc["entries"] and doc["count"] == 2
    assert "ivan.p" not in repr(db.docs[f"{INDEX}/s000"])             # no trace of the address left
    assert d.remove("u1") is False                                    # already gone: nothing to do
    assert make_dir().search("ivan.p") == []                          # and a fresh instance agrees


def test_remove_handles_a_uid_with_awkward_characters(db, make_dir):
    db.add_user("a.b`c d", "weird@example.test", T0 - timedelta(days=1))
    db.add_user("plain", "plain@example.test", T0 - timedelta(days=1))
    d = make_dir()
    d.full_sync()
    assert d.remove("a.b`c d") is True
    assert db.docs[f"{INDEX}/s000"]["entries"] == {"plain": "plain@example.test"}


def test_email_of_resolves_uids_for_the_audit_list(db, make_dir, clock):
    seed_ivans(db)
    d = make_dir()
    d.full_sync()
    assert d.email_of("u2") == "john.ivanov@example.test"
    assert d.email_of("nobody") is None
    clock.advance(600)
    db.add_user("u9", "New.Person@Example.Test", clock.now - timedelta(minutes=1))
    assert d.email_of("u9") == "new.person@example.test"              # not indexed yet: caught up on demand
    d.remove("u2")
    assert d.email_of("u2") is None                                   # tombstoned / purged


# ===================================================================== cache


def test_shards_are_cached_between_searches_and_reloaded_after_the_ttl(db, make_dir, clock):
    seed_ivans(db)
    d = make_dir()
    d.full_sync()
    db.reset_counters()
    d.search("ivan")
    d.search("maria")
    assert db.reads.get(INDEX, 0) == 0                                # the full sync left the cache warm
    clock.advance(dirmod.CACHE_TTL_S + 1)
    d.search("ivan")
    assert db.reads[INDEX] == 1
    d.search("ivan")
    assert db.reads[INDEX] == 1


def test_a_removal_by_another_instance_is_seen_after_the_ttl(db, make_dir, clock):
    seed_ivans(db)
    a, b = make_dir(), make_dir()
    a.full_sync()
    assert emails(b.search("maria")) == ["maria@example.test"]
    a.remove("u3")
    clock.advance(dirmod.CACHE_TTL_S + 1)
    assert b.search("maria") == []


# ===================================================================== against the Firestore emulator

EMULATOR_HOST = os.environ.get("FIRESTORE_EMULATOR_HOST")
emulator = pytest.mark.skipif(not EMULATOR_HOST, reason="needs the Firestore emulator (FIRESTORE_EMULATOR_HOST)")


@pytest.fixture
def live():
    """(FirestoreIndex, Directory) over fresh, uniquely named collections: nothing to clean up."""
    real = FirestoreIndex("build-chords-listener", emulator_host=EMULATOR_HOST)
    tag = uuid.uuid4().hex[:10]
    d = Directory(real, users_collection=f"t16_users_{tag}", index_collection=f"t16_index_{tag}")
    return real, d, f"t16_users_{tag}", f"t16_index_{tag}"


def put_users(real: FirestoreIndex, coll: str, users: list[tuple[str, Optional[str], datetime]]) -> None:
    for i in range(0, len(users), 400):
        real.commit([real.update_op(f"{coll}/{uid}", {"email": e, "createdAt": at, "settings": {"x": 1}}
                                    if e else {"createdAt": at})
                     for uid, e, at in users[i:i + 400]])


@emulator
def test_emulator_full_sync_catch_up_search_and_remove(live):
    real, d, users, index = live
    now = datetime.now(timezone.utc)
    put_users(real, users, [("u1", "Ivan.P@Example.Test", now - timedelta(days=3)),
                            ("u2", "John.Ivanov@example.test", now - timedelta(days=2)),
                            ("u3", None, now - timedelta(days=1)),
                            ("a.b`c", "weird@example.test", now - timedelta(days=1))])
    assert d.full_sync() == 3
    assert sorted(emails(d.search("IVAN"))) == ["ivan.p@example.test", "john.ivanov@example.test"]

    put_users(real, users, [("u4", "Ivanka@Example.Test", now + timedelta(seconds=1))])
    fresh = Directory(real, users_collection=users, index_collection=index)       # a cold instance catches up itself
    assert sorted(m.uid for m in fresh.search("ivan")) == ["u1", "u2", "u4"]
    stored = real.get(f"{index}/s000").data
    assert stored["count"] == 4 and stored["entries"]["u4"] == "ivanka@example.test"

    assert fresh.remove("a.b`c") is True and fresh.remove("u1") is True
    stored = real.get(f"{index}/s000").data
    assert stored["count"] == 2 and set(stored["entries"]) == {"u2", "u4"}
    assert Directory(real, users_collection=users, index_collection=index).search("weird") == []


@emulator
def test_emulator_ten_thousand_users_search_latency(live):
    real, d, users, index = live
    now = datetime.now(timezone.utc)
    put_users(real, users, [(f"uid{i:05d}", email_of_user(i), now - timedelta(days=1, seconds=i)) for i in range(10_000)]
              + [("uid-ivan", "Ivan.Petrenko@Example.Test", now - timedelta(days=1))])
    assert d.full_sync() == 10_001
    times = []
    for _ in range(40):
        cold = Directory(real, users_collection=users, index_collection=index)
        start = time.perf_counter()
        found = cold.search("iVaN.pet")
        times.append(time.perf_counter() - start)
        assert emails(found) == ["ivan.petrenko@example.test"]
    times.sort()
    assert times[int(len(times) * 0.95) - 1] <= 1.0

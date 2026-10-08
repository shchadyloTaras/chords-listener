"""The final deletion of an account (docs/features/admin T25; AC-22, AC-11; ADR-0011; sad §6 «Critical flow 3»).

Per due uid the purge writes the tombstone first (``adminTombstones/{uid}``, ``purging``), erases the user's files
(the bucket mount and the bucket objects), then its Firestore data (tracks, ``users``, ``adminAccounts``, the e-mail
index), anonymizes ``adminJobs`` and redacts ``adminAudit``, deletes the Firebase Auth account and marks the tombstone
``done``. Every step is idempotent and an interrupted purge is resumed by the next sweep (``status == purging``).

The flows run twice: on ``PurgeDb`` (the in-memory Firestore of the sweep tests plus dotted-field and array filters,
with a fake Firebase Auth) and on the Firestore and Auth emulators (skipped unless ``FIRESTORE_EMULATOR_HOST`` and
``FIREBASE_AUTH_EMULATOR_HOST`` are set). Each test uses its own collections and a fresh uid, so nothing needs cleaning.
"""
from __future__ import annotations

import copy
import json
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Optional

import pytest
import requests

from admin.test_projections import MemDb  # noqa: F401  (documents what PurgeDb builds on)
from admin.test_sweeps import QueryDb, _ts
from app.admin.deletion import AuthAdmin, AuthDeleteFailed, BucketEraser, PurgeFailed, Purger
from app.admin.directory import Directory, parse_time
from app.admin.history import Projections
from app.admin.sweeps import Sweeper
from app.firestore import FirestoreIndex, IndexError_
from app.models import Settings
from app.publish import Publisher
from app.storage import TrackStore, write_json_atomic
from tests.test_cloud import BUCKET, FakeGcs, FakeIndex

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

FS_HOST = os.environ.get("FIRESTORE_EMULATOR_HOST")
AUTH_HOST = os.environ.get("FIREBASE_AUTH_EMULATOR_HOST")
PROJECT = "build-chords-listener"
UTC = timezone.utc
NOW = datetime(2026, 10, 8, 12, 15, 0, tzinfo=UTC)
DUE = NOW - timedelta(hours=1)               # the 7-day window ended an hour ago
LOG = "chords.admin"
FROZEN_DAY = "2026-10-07"


# --------------------------------------------------------------------------- the databases and Firebase Auth


def _dig(data: Any, path: str) -> Any:
    for part in path.split("."):
        if not isinstance(data, dict) or part not in data:
            return None
        data = data[part]
    return data


class PurgeDb(QueryDb):
    """``QueryDb`` that also filters on dotted field paths (``deletion.purgeAfter``) and ``array-contains``."""

    def _rows(self, collection, filters):
        rows = [(p, d) for p, d in self.docs.items() if p.rsplit("/", 1)[0] == collection]
        for field, op, value in filters or []:
            def keep(doc: dict[str, Any]) -> bool:
                got = _dig(doc, field)
                if got is None:
                    return False
                if op == "array-contains":
                    return isinstance(got, list) and value in got
                got, want = _ts(got), _ts(value)
                return {"==": got == want, "<": got < want, "<=": got <= want, ">": got > want,
                        ">=": got >= want}[op]

            rows = [(p, d) for p, d in rows if keep(d)]
        return rows


class FakeAuth:
    """Firebase Auth as the purge sees it: ``delete_user(uid)``; a missing account counts as deleted."""

    def __init__(self) -> None:
        self.accounts: set[str] = set()
        self.deleted: list[str] = []

    def delete_user(self, uid: str) -> None:
        self.accounts.discard(uid)
        self.deleted.append(uid)


class FakeBucket:
    """The bucket client the purge erases objects with: ``list_blobs(bucket, prefix=...)`` -> blobs with ``delete()``."""

    def __init__(self) -> None:
        self.names: set[str] = set()
        self.listed: list[tuple[str, str]] = []

    def list_blobs(self, bucket: str, prefix: str = "") -> list[Any]:
        self.listed.append((bucket, prefix))
        return [SimpleNamespace(name=n, delete=lambda n=n: self.names.discard(n))
                for n in sorted(self.names) if n.startswith(prefix)]


# --------------------------------------------------------------------------- the world


class Env:
    def __init__(self, db: FirestoreIndex, tmp_path: Path, tag: str, mode: str) -> None:
        self.db, self.tag, self.mode = db, tag, mode
        self.users, self.accounts, self.tombstones = f"t25_users_{tag}", f"t25_accounts_{tag}", f"t25_tombs_{tag}"
        self.jobs, self.audit, self.index, self.stats = (f"t25_jobs_{tag}", f"t25_audit_{tag}", f"t25_index_{tag}",
                                                         f"t25_stats_{tag}")
        self.sweeps = f"t25_sweeps_{tag}"
        self.data_dir = tmp_path / "data"
        self.users_dir = self.data_dir / "users"
        self.clock = lambda: NOW
        self.fake_auth = FakeAuth()
        self.bucket = FakeBucket()
        if mode == "emulator":
            self.auth: Any = AuthAdmin(PROJECT, emulator_host=AUTH_HOST)
        else:
            self.auth = self.fake_auth
        self.directory = Directory(db, users_collection=self.users, index_collection=self.index, now=self.clock)
        self.purger = self.new_purger()
        self.gone_email = f"alice.gone.{tag}@example.test"    # the emulator's Auth keeps accounts across tests
        self.stay_email = f"bob.stay.{tag}@example.test"
        self.uid = self.sign_up(self.gone_email)
        self.other = self.sign_up(self.stay_email)

    def new_purger(self, **over: Any) -> Purger:
        kwargs: dict[str, Any] = dict(
            users_dir=self.users_dir, auth=self.auth, directory=self.directory,
            erase_objects=BucketEraser(BUCKET, lambda: self.bucket).erase, now=self.clock,
            users_collection=self.users, accounts_collection=self.accounts, tombstones_collection=self.tombstones,
            jobs_collection=self.jobs, audit_collection=self.audit)
        kwargs.update(over)
        return Purger(self.db, **kwargs)

    # ----- Firebase Auth
    def sign_up(self, email: str) -> str:
        if self.mode == "emulator":
            res = requests.post(f"http://{AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake",
                                json={"email": email, "password": "not-a-real-secret-1"}, timeout=10)
            assert res.status_code == 200, res.text
            return res.json()["localId"]
        uid = f"u{len(self.fake_auth.accounts)}-{self.tag}"      # a uid says nothing about the person
        self.fake_auth.accounts.add(uid)
        return uid

    def account_exists(self, uid: str) -> bool:
        if self.mode == "emulator":
            res = requests.post(
                f"http://{AUTH_HOST}/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:lookup",
                json={"localId": [uid]}, headers={"Authorization": "Bearer owner"}, timeout=10)
            return bool(res.json().get("users"))
        return uid in self.fake_auth.accounts

    # ----- Firestore
    def put(self, path: str, data: dict[str, Any]) -> None:
        self.db.commit([self.db.update_op(path, data)])

    def get(self, path: str) -> Optional[dict[str, Any]]:
        doc = self.db.get(path)
        return doc.data if doc else None

    def tombstone(self, uid: Optional[str] = None) -> Optional[dict[str, Any]]:
        return self.get(f"{self.tombstones}/{uid or self.uid}")

    def dump(self) -> dict[str, Any]:
        """Every document of every collection the purge can touch, by path."""
        out: dict[str, Any] = {}
        for collection in (self.users, f"{self.users}/{self.uid}/tracks", f"{self.users}/{self.other}/tracks",
                           self.accounts, self.tombstones, self.jobs, self.audit, self.index, self.stats):
            for doc in self.db.run_query(collection):
                out[doc.path] = copy.deepcopy(doc.data)
        return out

    # ----- the seed: a user who is due, and a bystander who must not be touched
    def seed(self, *, purge_after: datetime = DUE, deletion: bool = True) -> None:
        for uid, email in ((self.uid, self.gone_email), (self.other, self.stay_email)):
            self.put(f"{self.users}/{uid}", {"email": email, "createdAt": NOW - timedelta(days=30),
                                             "settings": {"lang": "uk"}})
            for n in range(3 if uid == self.uid else 1):
                self.put(f"{self.users}/{uid}/tracks/t{n}", {"id": f"t{n}", "title": f"Secret Song {n}",
                                                            "sizeBytes": 1000 + n})
            track = self.users_dir / uid / "tracks" / "t0"
            track.mkdir(parents=True)
            (track / "audio.mp3").write_bytes(b"\xff\xfb" + b"\x00" * 64)
            (track / "track.json").write_text('{"title": "Secret Song 0"}', "utf-8")
            (self.users_dir / uid / "quota.json").write_text('{"analyses": 3}', "utf-8")
            self.bucket.names |= {f"users/{uid}/tracks/t0/audio.mp3", f"users/{uid}/uploads/up1/song.wav"}
        write_json_atomic(self.users_dir / self.uid / "publish-pending.json", {"ids": {"t0": "publish"}})
        account: dict[str, Any] = {
            "restriction": {"reason": "Scheduled deletion", "since": NOW - timedelta(days=7), "byAdminUid": "admin-1"},
            "personalLimit": {"analyses": 100, "setAt": NOW - timedelta(days=9), "byAdminUid": "admin-1"},
            "updatedAt": NOW - timedelta(days=7)}
        if deletion:
            account["deletion"] = {
                "scheduledAt": purge_after - timedelta(days=7), "purgeAfter": purge_after, "byAdminUid": "admin-1",
                "priorRestriction": {"reason": "spam links", "since": NOW - timedelta(days=20),
                                     "byAdminUid": "admin-1"}}
        self.put(f"{self.accounts}/{self.uid}", account)
        self.put(f"{self.accounts}/{self.other}", {"personalLimit": {"jobs": 3}, "updatedAt": NOW})
        self.directory.full_sync()
        accepted = NOW - timedelta(days=2)
        for job_id, uid, status in (("j1", self.uid, "done"), ("j2", self.uid, "error"), ("j3", self.other, "done")):
            self.put(f"{self.jobs}/{job_id}", {
                "uid": uid, "service": False, "kind": "analysis", "origin": "link", "status": status,
                "reason": "download_failed" if status == "error" else None,
                "errorText": "download failed" if status == "error" else None,
                "title": f"Secret Song of {job_id}", "trackId": "t0", "acceptedAt": accepted,
                "finishedAt": accepted + timedelta(seconds=30), "day": "2026-10-06",
                "expireAt": accepted + timedelta(days=90), "anonymizedAt": None})
        admin = {"adminUid": "admin-1", "adminEmail": "admin@example.test", "outcome": "applied", "setting": None,
                 "rejectReason": None, "refId": None, "expireAt": NOW + timedelta(days=300), "redactedAt": None}
        entries = {
            "a1": {"action": "restrict", "targetUid": self.uid, "before": None,
                   "after": {"reason": "spam links", "since": "2026-09-01T00:00:00Z"}, "query": None,
                   "matchedUids": None},
            "a2": {"action": "deletion_scheduled", "targetUid": self.uid,
                   "before": {"reason": "spam links", "since": "2026-09-01T00:00:00Z"},
                   "after": {"reason": "Scheduled deletion", "since": "2026-10-01T00:00:00Z",
                             "purgeAfter": "2026-10-08T11:15:00Z"}, "query": None, "matchedUids": None},
            "a3": {"action": "search", "targetUid": None, "before": None, "after": None, "query": "alice.gone",
                   "matchedUids": [self.uid, self.other]},
            "a4": {"action": "search", "targetUid": None, "before": None, "after": None, "query": "bob.stay",
                   "matchedUids": [self.other]},
            "a5": {"action": "restrict", "targetUid": self.other, "before": None,
                   "after": {"reason": "other reason", "since": "2026-09-01T00:00:00Z"}, "query": None,
                   "matchedUids": None},
            "a6": {"action": "view_card", "targetUid": self.uid, "before": None, "after": None, "query": None,
                   "matchedUids": None},
        }
        for n, (entry_id, body) in enumerate(entries.items()):
            self.put(f"{self.audit}/{entry_id}", {**admin, **body, "at": NOW - timedelta(hours=10 - n)})
        self.put(f"{self.stats}/{FROZEN_DAY}", {
            "state": "frozen", "analyses": {"link": 2, "file": 0, "mic": 0, "tab": 0}, "vocals": 0, "failed": 1,
            "failedByReason": {"download_failed": 1}, "active": 2, "newUsers": 1, "reconciledDiff": 0,
            "frozenAt": NOW - timedelta(hours=12), "updatedAt": NOW - timedelta(hours=12)})


@pytest.fixture(params=["fake", pytest.param("emulator", marks=pytest.mark.skipif(
    not (FS_HOST and AUTH_HOST), reason="needs the Firestore and Auth emulators"))])
def env(request, tmp_path) -> Env:
    db: FirestoreIndex = PurgeDb() if request.param == "fake" else FirestoreIndex(PROJECT, emulator_host=FS_HOST)
    e = Env(db, tmp_path, uuid.uuid4().hex[:10], request.param)
    e.seed()
    return e


def records(caplog: pytest.LogCaptureFixture, text: str) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == LOG and text in r.getMessage()]


def raising(message: str = "down") -> Callable[..., Any]:
    def fail(*_a: Any, **_k: Any) -> Any:
        raise IndexError_(message, retryable=True)

    return fail


# ===================================================================== AC-22: a due account is erased


def test_a_due_account_is_purged_everywhere(env):
    report = env.purger.run()
    assert report.purged == [env.uid] and report.failed == []
    # bucket: the user's directory (tracks, audio, quota, pending retry) and every object under its prefix
    assert not (env.users_dir / env.uid).exists()
    assert env.bucket.names == {f"users/{env.other}/tracks/t0/audio.mp3", f"users/{env.other}/uploads/up1/song.wav"}
    # Firestore: library, profile, admin state, index entry
    assert env.db.run_query(f"{env.users}/{env.uid}/tracks") == []
    assert env.get(f"{env.users}/{env.uid}") is None
    assert env.get(f"{env.accounts}/{env.uid}") is None
    assert env.directory.search("alice") == [] and env.directory.email_of(env.uid) is None
    # Firebase Auth: the person cannot sign in
    assert not env.account_exists(env.uid)
    # the tombstone is the only trace, and it carries no personal data
    tomb = env.tombstone()
    assert set(tomb) == {"status", "purgeAfter", "startedAt", "doneAt"} and tomb["status"] == "done"
    assert parse_time(tomb["purgeAfter"]) == DUE and parse_time(tomb["doneAt"]) == NOW


def test_nothing_of_the_purged_user_is_left_anywhere_and_the_bystander_is_untouched(env):
    before = env.dump()
    env.purger.run()
    after = env.dump()
    text = json.dumps(after, default=str)
    assert "alice.gone" not in text and env.gone_email not in text         # no e-mail, incl. the index and the searches
    assert "Secret Song 0" not in json.dumps({k: v for k, v in after.items() if f"/{env.uid}/" in k or "jobs" in k})
    for path, data in before.items():     # the other user's documents are as they were
        if env.other in path or path.startswith((f"{env.jobs}/j3", f"{env.audit}/a4", f"{env.audit}/a5")) \
                or path.startswith(f"{env.stats}/"):
            assert after[path] == data, path
    assert env.directory.search("bob.stay")[0].uid == env.other
    assert (env.users_dir / env.other / "quota.json").exists() and (env.users_dir / env.other / "tracks").is_dir()
    assert env.account_exists(env.other)


def test_job_history_is_anonymized_but_keeps_the_uid_and_the_counted_facts(env):
    env.purger.run()
    for job_id in ("j1", "j2"):
        job = env.get(f"{env.jobs}/{job_id}")
        assert job["uid"] == env.uid and job["title"] is None and job["trackId"] is None
        assert parse_time(job["anonymizedAt"]) == NOW
        assert job["day"] == "2026-10-06" and job["kind"] == "analysis" and job["origin"] == "link"
    assert env.get(f"{env.jobs}/j2")["reason"] == "download_failed" and env.get(f"{env.jobs}/j2")["status"] == "error"
    assert env.get(f"{env.jobs}/j3")["title"] == "Secret Song of j3" and env.get(f"{env.jobs}/j3")["anonymizedAt"] is None


def test_the_journal_stays_but_reasons_and_matching_search_queries_are_redacted(env):
    env.purger.run()
    assert len(env.db.run_query(env.audit)) == 6                         # AC-11: nothing is deleted
    a1, a2, a6 = (env.get(f"{env.audit}/{n}") for n in ("a1", "a2", "a6"))
    for entry in (a1, a2, a6):
        assert entry["targetUid"] == env.uid and parse_time(entry["redactedAt"]) == NOW   # shown as «видалений»
    assert "reason" not in a1["after"] and a1["after"]["since"] == "2026-09-01T00:00:00Z"
    assert "reason" not in a2["before"] and "reason" not in a2["after"] and a2["after"]["purgeAfter"]
    a3 = env.get(f"{env.audit}/a3")
    assert a3["query"] is None and a3["matchedUids"] == [env.other] and parse_time(a3["redactedAt"]) == NOW
    a4, a5 = env.get(f"{env.audit}/a4"), env.get(f"{env.audit}/a5")
    assert a4["query"] == "bob.stay" and a4["matchedUids"] == [env.other] and a4["redactedAt"] is None
    assert a5["after"]["reason"] == "other reason" and a5["redactedAt"] is None


def test_frozen_days_do_not_change(env):
    before = env.get(f"{env.stats}/{FROZEN_DAY}")
    env.purger.run()
    assert env.get(f"{env.stats}/{FROZEN_DAY}") == before


def test_a_second_run_is_a_no_op(env):
    env.purger.run()
    settled = env.dump()
    deleted = list(env.fake_auth.deleted)
    again = env.purger.run()
    assert again.purged == [] and again.failed == []
    assert env.dump() == settled
    assert env.fake_auth.deleted == deleted
    assert env.tombstone()["status"] == "done"


# ===================================================================== ADR-0011: the order of the steps


def test_the_tombstone_comes_first_and_the_auth_account_goes_after_all_the_data(env, monkeypatch):
    seen: dict[str, Any] = {}
    real_erase = env.purger._erase_objects

    def erase(prefix: str) -> int:
        seen.setdefault("at_erase", (env.tombstone() or {}).get("status"))
        seen.setdefault("user_doc_then", env.get(f"{env.users}/{env.uid}") is not None)
        return real_erase(prefix)

    env.purger._erase_objects = erase
    real_delete = env.auth.delete_user

    def delete_user(uid: str) -> None:
        seen["files"] = (env.users_dir / uid).exists()
        seen["library"] = (env.get(f"{env.users}/{uid}"), env.db.run_query(f"{env.users}/{uid}/tracks"),
                           env.get(f"{env.accounts}/{uid}"))
        seen["jobs"] = env.get(f"{env.jobs}/j1")["title"]
        seen["audit"] = env.get(f"{env.audit}/a3")["query"]
        seen["tombstone"] = env.tombstone()["status"]
        real_delete(uid)

    monkeypatch.setattr(env.auth, "delete_user", delete_user)
    env.purger.run()
    assert seen["at_erase"] == "purging" and seen["user_doc_then"] is True    # the tombstone, then the erasing
    assert seen["files"] is False and seen["library"] == (None, [], None)
    assert seen["jobs"] is None and seen["audit"] is None                       # anonymized before the account goes
    assert seen["tombstone"] == "purging"                                       # done only after the account


@pytest.mark.parametrize("where", ["objects", "index", "auth"])
def test_an_interrupted_purge_is_resumed_by_the_next_run(env, monkeypatch, where):
    started = None
    if where == "objects":
        monkeypatch.setattr(env.purger, "_erase_objects", raising())
    elif where == "index":
        monkeypatch.setattr(env.directory, "remove", raising())
    else:
        monkeypatch.setattr(env.auth, "delete_user", raising())
    first = env.purger.run(raise_on_failure=False)
    assert first.purged == [] and first.failed == [env.uid]
    tomb = env.tombstone()
    assert tomb["status"] == "purging" and tomb["doneAt"] is None
    started = tomb["startedAt"]
    monkeypatch.undo()
    second = env.purger.run()
    assert second.purged == [env.uid] and second.failed == []
    done = env.tombstone()
    assert done["status"] == "done" and done["startedAt"] == started          # the resume keeps the first start
    assert not (env.users_dir / env.uid).exists() and env.get(f"{env.users}/{env.uid}") is None
    assert env.get(f"{env.accounts}/{env.uid}") is None and env.directory.search("alice") == []
    assert not env.account_exists(env.uid)
    assert env.get(f"{env.jobs}/j1")["title"] is None and env.get(f"{env.audit}/a3")["query"] is None


def test_a_purge_that_lost_its_account_document_still_finishes(env):
    """The crash came after ``adminAccounts`` was erased: the tombstone alone says what is left to do."""
    env.put(f"{env.tombstones}/{env.uid}", {"status": "purging", "purgeAfter": DUE,
                                             "startedAt": NOW - timedelta(hours=3), "doneAt": None})
    env.db.commit([env.db.delete_op(f"{env.accounts}/{env.uid}")])
    report = env.purger.run()
    assert report.purged == [env.uid]
    tomb = env.tombstone()
    assert tomb["status"] == "done" and parse_time(tomb["startedAt"]) == NOW - timedelta(hours=3)
    assert not env.account_exists(env.uid) and env.get(f"{env.users}/{env.uid}") is None


def test_a_failed_purge_does_not_stop_the_other_accounts(env):
    third = env.sign_up("carol.gone@example.test")
    env.put(f"{env.users}/{third}", {"email": "carol.gone@example.test", "createdAt": NOW - timedelta(days=9)})
    env.put(f"{env.accounts}/{third}", {"deletion": {"scheduledAt": DUE - timedelta(days=7), "purgeAfter": DUE,
                                                      "byAdminUid": "admin-1", "priorRestriction": None}})
    real = env.auth.delete_user

    def flaky(uid: str) -> None:
        if uid == env.uid:
            raise IndexError_("down", retryable=True)
        real(uid)

    env.auth.delete_user = flaky  # type: ignore[method-assign]
    with pytest.raises(PurgeFailed) as failure:
        env.purger.run()
    assert failure.value.uids == [env.uid]
    assert env.tombstone(third)["status"] == "done" and env.tombstone()["status"] == "purging"


# ===================================================================== who is purged, and when


def test_an_account_whose_window_has_not_passed_is_left_alone(env):
    env.put(f"{env.accounts}/{env.uid}", {"deletion": {"scheduledAt": NOW, "purgeAfter": NOW + timedelta(seconds=1),
                                                        "byAdminUid": "admin-1", "priorRestriction": None}})
    before = env.dump()
    report = env.purger.run()
    assert report.purged == [] and env.dump() == before
    assert (env.users_dir / env.uid).exists() and env.account_exists(env.uid)


def test_a_cancelled_deletion_is_not_purged(env):
    env.put(f"{env.accounts}/{env.uid}", {"personalLimit": {"analyses": 5}})     # no `deletion` any more
    before = env.dump()
    assert env.purger.run().purged == []
    assert env.dump() == before and env.tombstone() is None


def test_the_deletion_is_checked_again_when_the_purge_starts(env):
    """Between finding the account and writing the tombstone an admin cancelled: no tombstone, nothing erased."""
    env.put(f"{env.accounts}/{env.uid}", {"personalLimit": {"analyses": 5}})
    assert env.purger.purge(env.uid) is False
    assert env.tombstone() is None and (env.users_dir / env.uid).exists()


def test_a_finished_purge_is_never_started_again(env):
    env.put(f"{env.tombstones}/{env.uid}", {"status": "done", "purgeAfter": DUE, "startedAt": DUE, "doneAt": DUE})
    assert env.purger.purge(env.uid) is False
    assert (env.users_dir / env.uid).exists()


# ===================================================================== NFR: overdue metric, logs


def test_a_purge_not_finished_a_day_after_its_window_logs_deletion_overdue(env, monkeypatch, caplog):
    env.put(f"{env.accounts}/{env.uid}", {"deletion": {"scheduledAt": NOW - timedelta(days=9),
                                                        "purgeAfter": NOW - timedelta(hours=25),
                                                        "byAdminUid": "admin-1", "priorRestriction": None}})
    monkeypatch.setattr(env.auth, "delete_user", raising())
    with caplog.at_level(logging.INFO, logger=LOG):
        report = env.purger.run(raise_on_failure=False)
    assert report.overdue == 1
    overdue = records(caplog, "deletion_overdue")
    assert len(overdue) == 1 and overdue[0].levelno >= logging.ERROR and "count=1" in overdue[0].getMessage()


def test_a_purge_inside_its_first_day_is_not_overdue(env, monkeypatch, caplog):
    monkeypatch.setattr(env.auth, "delete_user", raising())
    with caplog.at_level(logging.INFO, logger=LOG):
        report = env.purger.run(raise_on_failure=False)
    assert report.failed == [env.uid] and report.overdue == 0
    assert records(caplog, "deletion_overdue") == []


def test_the_logs_carry_the_uid_and_no_email_or_title(env, monkeypatch, caplog):
    monkeypatch.setattr(env.directory, "remove", raising(f"boom for {env.gone_email}"))
    with caplog.at_level(logging.DEBUG):
        env.purger.run(raise_on_failure=False)
        monkeypatch.undo()
        env.purger.run()
    text = "\n".join(r.getMessage() + (str(r.exc_info[1]) if r.exc_info else "") for r in caplog.records)
    assert env.uid in text
    assert "alice" not in text and env.gone_email not in text and "Secret Song" not in text


# ===================================================================== the sweep runs the purge


def test_the_sweep_runs_the_purge_as_its_last_step(env):
    projections = Projections(env.db, env.data_dir / "admin" / "pending.json", jobs_collection=env.jobs,
                              stats_collection=env.stats, now=env.clock)
    sweeper = Sweeper(env.db, projections, env.directory, purge=env.purger.run, now=env.clock,
                      sweeps_collection=env.sweeps, jobs_collection=env.jobs, stats_collection=env.stats,
                      users_collection=env.users)
    run = sweeper.run()
    assert run["state"] == "done" and run["steps"]["purges"] == "done"
    assert env.tombstone()["status"] == "done" and not env.account_exists(env.uid)


def test_a_failed_purge_fails_the_sweep_so_the_scheduler_retries(env, monkeypatch):
    from app.admin.sweeps import SweepFailed

    projections = Projections(env.db, env.data_dir / "admin" / "pending.json", jobs_collection=env.jobs,
                              stats_collection=env.stats, now=env.clock)
    sweeper = Sweeper(env.db, projections, env.directory, purge=env.purger.run, now=env.clock,
                      sweeps_collection=env.sweeps, jobs_collection=env.jobs, stats_collection=env.stats,
                      users_collection=env.users)
    monkeypatch.setattr(env.auth, "delete_user", raising())
    with pytest.raises(SweepFailed):
        sweeper.run()
    monkeypatch.undo()
    assert sweeper.run()["state"] == "done" and env.tombstone()["status"] == "done"


def test_the_apps_sweeper_purges(env, monkeypatch, tmp_path):
    """``create_app`` hands the sweeper a purger on the app's own database and e-mail index."""
    from app.main import create_app

    if env.mode == "emulator":
        pytest.skip("the app's collections are the real ones")
    settings = Settings(data_dir=env.data_dir, frontend_dist=tmp_path / "no-dist", auth="firebase",
                        upload_bucket=BUCKET, scratch_dir=tmp_path / "scratch",
                        allowed_hosts=("testserver", "localhost"))
    deleted: list[str] = []
    monkeypatch.setattr(AuthAdmin, "delete_user", lambda self, uid: deleted.append(uid))
    db = PurgeDb()
    db.commit([
        db.update_op(f"users/{env.uid}", {"email": env.gone_email, "createdAt": NOW - timedelta(days=9)}),
        db.update_op(f"adminAccounts/{env.uid}", {"deletion": {
            "scheduledAt": DUE - timedelta(days=7), "purgeAfter": DUE, "byAdminUid": "admin-1",
            "priorRestriction": None}})])
    app = create_app(settings, admin_db=db, token_verifier=SimpleNamespace(verify=lambda t: "x"),
                     gcs_client_factory=lambda: env.bucket, wake_sweep=False)
    app.state.sweeper._now = env.clock
    app.state.sweeper.run()
    assert db.docs[f"adminTombstones/{env.uid}"]["status"] == "done" and deleted == [env.uid]
    assert f"users/{env.uid}" not in db.docs and f"adminAccounts/{env.uid}" not in db.docs


# ===================================================================== Firebase Auth deletion (the REST call)


class Session:
    def __init__(self, status: int = 200, body: Any = None) -> None:
        self.status, self.body, self.calls = status, body if body is not None else {}, []

    def post(self, url: str, json: Any = None, headers: Any = None, timeout: Any = None) -> Any:
        self.calls.append((url, json, headers))
        return SimpleNamespace(status_code=self.status, json=lambda: self.body, text=str(self.body))


def test_auth_delete_calls_accounts_delete_for_the_project(monkeypatch):
    monkeypatch.delenv("FIREBASE_AUTH_EMULATOR_HOST", raising=False)
    session = Session()
    AuthAdmin("p1", session_factory=lambda: session, emulator_host=None).delete_user("u1")
    url, body, _ = session.calls[0]
    assert url == "https://identitytoolkit.googleapis.com/v1/projects/p1/accounts:delete" and body == {"localId": "u1"}


def test_auth_delete_in_the_emulator_uses_the_owner_token():
    session = Session()
    AuthAdmin("p1", session_factory=lambda: session, emulator_host="127.0.0.1:9099").delete_user("u1")
    url, _, headers = session.calls[0]
    assert url == "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/p1/accounts:delete"
    assert headers == {"Authorization": "Bearer owner"}


def test_an_account_that_is_already_gone_counts_as_deleted(monkeypatch):
    monkeypatch.delenv("FIREBASE_AUTH_EMULATOR_HOST", raising=False)
    session = Session(400, {"error": {"code": 400, "message": "USER_NOT_FOUND"}})
    AuthAdmin("p1", session_factory=lambda: session, emulator_host=None).delete_user("u1")


@pytest.mark.parametrize("status", [401, 403, 500, 503])
def test_any_other_answer_from_auth_is_a_failure(status, monkeypatch):
    monkeypatch.delenv("FIREBASE_AUTH_EMULATOR_HOST", raising=False)
    session = Session(status, {"error": {"code": status, "message": "NOPE"}})
    with pytest.raises(AuthDeleteFailed):
        AuthAdmin("p1", session_factory=lambda: session, emulator_host=None).delete_user("u1")


# ===================================================================== the publish path checks the tombstone


@pytest.fixture
def pub_world(tmp_path: Path):
    settings = Settings(data_dir=tmp_path / "pub", frontend_dist=tmp_path / "no-dist", auth="firebase",
                        upload_bucket=BUCKET, scratch_dir=tmp_path / "scratch")
    store = TrackStore(settings)
    store.init()
    index, gcs, tombstoned = FakeIndex(), FakeGcs(), set()
    pub = Publisher(store, index, bucket=BUCKET, gcs_client_factory=lambda: gcs, attempts=1, backoff_s=0,
                    is_tombstoned=lambda uid: uid in tombstoned)
    return SimpleNamespace(store=store, index=index, pub=pub, tombstoned=tombstoned)


def queue(w: SimpleNamespace, uid: str, kind: str = "publish") -> Path:
    path = w.store.user_dir(uid) / "publish-pending.json"
    write_json_atomic(path, {"ids": {"t1": kind}})
    return path


def test_a_publish_retry_for_a_purged_uid_is_dropped(pub_world):
    w = pub_world
    path = queue(w, "u-gone")
    w.tombstoned.add("u-gone")
    assert w.pub.sweep_pending() == 0
    assert w.index.calls == 0 and w.index.docs == {}                     # nothing was written for the purged uid
    assert not path.exists()                                             # and the retry is off the queue


def test_publishing_for_a_purged_uid_writes_nothing_and_queues_nothing(pub_world):
    w = pub_world
    w.tombstoned.add("u-gone")
    w.index.fail = 5                                                     # even a failing index must not queue a retry
    assert w.pub.publish("u-gone", "t1") is True
    assert w.pub.unpublish("u-gone", "t1") is True
    assert w.pub.ensure_published("u-gone", "t1") is True
    assert w.index.calls == 0 and not (w.store.settings.users_dir / "u-gone").exists()


def test_a_user_without_a_tombstone_still_queues_a_failed_publish(pub_world):
    w = pub_world
    w.index.fail = 1
    assert w.pub.unpublish("u-here", "t1") is False
    assert (w.store.user_dir("u-here") / "publish-pending.json").exists()


def test_the_apps_publisher_checks_the_tombstone_in_the_admin_database(tmp_path):
    from app.main import create_app

    db = PurgeDb()
    db.commit([db.update_op("adminTombstones/u-gone", {"status": "purging", "purgeAfter": DUE, "startedAt": NOW,
                                                      "doneAt": None})])
    settings = Settings(data_dir=tmp_path / "d", frontend_dist=tmp_path / "no-dist", auth="firebase",
                        upload_bucket=BUCKET, scratch_dir=tmp_path / "scratch", allowed_hosts=("testserver",))
    app = create_app(settings, admin_db=db, token_verifier=SimpleNamespace(verify=lambda t: "x"),
                     gcs_client_factory=lambda: FakeGcs(), wake_sweep=False)
    publisher = app.state.publisher
    assert isinstance(publisher, Publisher)
    assert publisher.publish("u-gone", "t1") is True
    assert not (settings.users_dir / "u-gone").exists()


# ===================================================================== the bucket eraser


def test_the_bucket_eraser_deletes_every_object_under_the_prefix_only():
    bucket = FakeBucket()
    bucket.names = {"users/u1/uploads/a.wav", "users/u1/tracks/t/audio.mp3", "users/u10/tracks/t/audio.mp3"}
    assert BucketEraser("b", lambda: bucket).erase("users/u1/") == 2
    assert bucket.names == {"users/u10/tracks/t/audio.mp3"} and bucket.listed == [("b", "users/u1/")]


def test_a_purge_without_a_bucket_client_still_removes_the_directory(env):
    purger = env.new_purger(erase_objects=None)
    purger.run()
    assert not (env.users_dir / env.uid).exists()

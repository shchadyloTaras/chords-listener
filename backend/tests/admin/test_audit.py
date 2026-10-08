"""The admin audit writer (docs/features/admin: AC-10b, AC-33, AC-33b; ADR-0007).

Offline: ``FakeDb`` applies the real REST write bodies (``update_op`` / ``delete_op``) atomically and can be told to
fail the next commit, so "a failed audit write leaves state unchanged" is checked on the data, not on a mock call.
The tests at the bottom run the same flows on the Firestore emulator (skipped when FIRESTORE_EMULATOR_HOST is unset).
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from admin.fixtures import MemDb
from app.admin import audit as auditmod
from app.admin.audit import (
    EXPIRE_AFTER,
    Audit,
    AuditEntry,
    AuditUnavailable,
    NotApplied,
)
from app.admin.authz import AdminAuthz
from app.admin.router import new_admin_router
from app.firestore import Aborted, Document, FirestoreIndex, IndexError_, PreconditionFailed
from app.main import create_app
from app.models import Settings

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

T0 = datetime(2026, 10, 7, 12, 0, 0, tzinfo=timezone.utc)
ADMIN_EMAIL = "admin@example.test"
TARGET_EMAIL = "victim@example.test"
COLLECTION = "adminAudit"


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


# --------------------------------------------------------------------------- fakes


class FakeDb(MemDb):
    """The shared ``MemDb`` (``commit_log`` records every attempted commit, ``fail_next`` breaks the next ones)."""

    def audit_docs(self) -> list[tuple[str, dict[str, Any]]]:
        return [(p, d) for p, d in self.docs.items() if p.startswith(COLLECTION + "/")]


class FakeTx:
    """What ``Transaction`` offers a handler: ``commit(writes)`` (``Aborted`` when it lost a race)."""

    def __init__(self, db: FakeDb) -> None:
        self.db = db

    def commit(self, writes: list[dict[str, Any]]) -> None:
        self.db.commit(writes)


@pytest.fixture
def db() -> FakeDb:
    return FakeDb()


@pytest.fixture
def audit(db: FakeDb) -> Audit:
    return Audit(db, now=lambda: T0)


def entry(action: str = "limit_set", **kw: Any) -> AuditEntry:
    kw.setdefault("admin_uid", "admin-1")
    kw.setdefault("admin_email", ADMIN_EMAIL)
    return AuditEntry(action=action, **kw)  # type: ignore[arg-type]


def effect_write(db: FakeDb, value: int = 1) -> dict[str, Any]:
    return db.update_op("adminAccounts/victim-1", {"limit": value})


def only_audit_doc(db: FakeDb) -> dict[str, Any]:
    docs = db.audit_docs()
    assert len(docs) == 1, docs
    return docs[0][1]


def metric_lines(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "chords.admin" and "audit_write_failed" in r.getMessage()]


# --------------------------------------------------------------------------- AC-33: change + record in one commit


def test_record_with_writes_the_change_and_the_record_in_one_commit(db: FakeDb, audit: Audit) -> None:
    ref = audit.record_with(
        [effect_write(db, 100)],
        entry(target_uid="victim-1", setting="limits", before={"analyses": 40}, after={"analyses": 100}),
    )
    assert len(db.commit_log) == 1, "the change and its record must share one commit"
    assert db.docs["adminAccounts/victim-1"] == {"limit": 100}
    doc = db.docs[f"{COLLECTION}/{ref}"]
    assert doc["action"] == "limit_set" and doc["outcome"] == "applied"
    assert doc["adminUid"] == "admin-1" and doc["adminEmail"] == ADMIN_EMAIL
    assert doc["targetUid"] == "victim-1" and doc["setting"] == "limits"
    assert doc["before"] == {"analyses": 40} and doc["after"] == {"analyses": 100}


def test_a_broken_commit_changes_nothing_and_answers_not_applied(
    db: FakeDb, audit: Audit, caplog: pytest.LogCaptureFixture
) -> None:
    db.docs["adminAccounts/victim-1"] = {"limit": 40}
    db.fail_next = [IndexError_("firestore down", retryable=True)]
    with caplog.at_level(logging.WARNING, logger="chords.admin"):
        with pytest.raises(NotApplied) as caught:
            audit.record_with([effect_write(db, 100)], entry(target_uid="victim-1"))
    assert caught.value.status == 503 and caught.value.code == "not_applied"
    assert db.docs == {"adminAccounts/victim-1": {"limit": 40}}, "state must be exactly as before"
    assert db.audit_docs() == []
    assert len(metric_lines(caplog)) == 1


def test_a_failed_precondition_of_the_change_is_not_an_audit_failure(db: FakeDb, audit: Audit) -> None:
    """The caller's own precondition (the doc must exist ...) breaking is the caller's business: nothing is
    written, and the error comes back as it is so the handler can answer its own domain error."""
    with pytest.raises(PreconditionFailed):
        audit.record_with([db.update_op("adminAccounts/gone", {"x": 1}, exists=True)], entry())
    assert db.docs == {}


def test_record_with_inside_a_transaction_commits_through_it_and_lets_aborted_through(db: FakeDb, audit: Audit) -> None:
    tx = FakeTx(db)
    audit.record_with([effect_write(db)], entry(), tx=tx)
    assert len(db.audit_docs()) == 1 and "adminAccounts/victim-1" in db.docs

    db.fail_next = [Aborted("lost the race")]
    with pytest.raises(Aborted):  # run_transaction retries on this one: it must not turn into not_applied
        audit.record_with([effect_write(db, 2)], entry(), tx=tx)
    assert len(db.audit_docs()) == 1 and db.docs["adminAccounts/victim-1"] == {"limit": 1}

    db.fail_next = [IndexError_("boom", retryable=False)]
    with pytest.raises(NotApplied):
        audit.record_with([effect_write(db, 3)], entry(), tx=tx)
    assert db.docs["adminAccounts/victim-1"] == {"limit": 1}


# --------------------------------------------------------------------------- AC-33: journal first


def test_record_first_journals_the_attempt_and_returns_its_reference(db: FakeDb, audit: Audit) -> None:
    ref = audit.record_first(entry("quota_reset", target_uid="victim-1", before={"analyses": 40, "vocals": 5}))
    assert len(db.audit_docs()) == 1 and f"{COLLECTION}/{ref}" in db.docs
    assert db.docs[f"{COLLECTION}/{ref}"]["before"] == {"analyses": 40, "vocals": 5}


def test_record_first_failure_answers_not_applied_so_the_effect_never_runs(
    db: FakeDb, audit: Audit, caplog: pytest.LogCaptureFixture
) -> None:
    db.fail_next = [IndexError_("down", retryable=True)]
    ran: list[str] = []
    with caplog.at_level(logging.WARNING, logger="chords.admin"):
        with pytest.raises(NotApplied):
            audit.apply_first(entry("quota_reset"), lambda: ran.append("effect"))
    assert ran == [] and db.audit_docs() == []
    assert len(metric_lines(caplog)) == 1


def test_the_effect_runs_after_its_record_is_stored(db: FakeDb, audit: Audit) -> None:
    seen: list[int] = []
    audit.apply_first(entry("quota_reset"), lambda: seen.append(len(db.audit_docs())))
    assert seen == [1]


def test_a_failed_effect_after_the_journal_writes_a_not_applied_followup_with_ref_id(db: FakeDb, audit: Audit) -> None:
    first = entry("quota_reset", target_uid="victim-1", before={"analyses": 40, "vocals": 5})

    def effect() -> None:
        raise OSError("quota.json is not writable")

    with pytest.raises(NotApplied) as caught:
        audit.apply_first(first, effect)
    assert caught.value.code == "not_applied" and caught.value.status == 503
    docs = dict(db.audit_docs())
    assert len(docs) == 2
    applied_path = next(p for p, d in docs.items() if d["outcome"] == "applied")
    followup = next(d for d in docs.values() if d["outcome"] == "not_applied")
    assert followup["refId"] == applied_path.split("/", 1)[1]
    assert followup["action"] == "quota_reset" and followup["targetUid"] == "victim-1"
    assert followup["adminUid"] == "admin-1" and followup["adminEmail"] == ADMIN_EMAIL
    assert followup["expireAt"] is not None


def test_a_successful_effect_leaves_one_applied_record_and_returns_the_effect_result(db: FakeDb, audit: Audit) -> None:
    out = audit.apply_first(entry("quota_reset"), lambda: {"analyses": 0})
    assert out == {"analyses": 0}
    assert [d["outcome"] for _, d in db.audit_docs()] == ["applied"]


def test_mark_not_applied_never_raises_when_even_the_followup_cannot_be_written(
    db: FakeDb, audit: Audit, caplog: pytest.LogCaptureFixture
) -> None:
    ref = audit.record_first(entry("quota_reset"))
    db.fail_next = [IndexError_("down", retryable=True)]
    with caplog.at_level(logging.WARNING, logger="chords.admin"):
        assert audit.mark_not_applied(ref, entry("quota_reset")) is False
    assert len(metric_lines(caplog)) == 1
    assert audit.mark_not_applied(ref, entry("quota_reset")) is True
    assert sorted(d["outcome"] for _, d in db.audit_docs()) == ["applied", "not_applied"]


# --------------------------------------------------------------------------- AC-33b: views are journaled before the answer


def test_record_view_writes_the_search_with_its_query_and_matches(db: FakeDb, audit: Audit) -> None:
    audit.record_view(entry("search", query="ivan", matched_uids=["u1", "u2"]))
    doc = only_audit_doc(db)
    assert doc["action"] == "search" and doc["outcome"] == "applied"
    assert doc["query"] == "ivan" and doc["matchedUids"] == ["u1", "u2"]
    assert doc["targetUid"] is None


def test_record_view_writes_the_card_view_over_the_target(db: FakeDb, audit: Audit) -> None:
    audit.record_view(entry("view_card", target_uid="victim-1"))
    doc = only_audit_doc(db)
    assert doc["action"] == "view_card" and doc["targetUid"] == "victim-1" and doc["query"] is None


def test_a_failed_view_journal_withholds_the_data(db: FakeDb, audit: Audit, caplog: pytest.LogCaptureFixture) -> None:
    db.fail_next = [IndexError_("down", retryable=True)]
    with caplog.at_level(logging.WARNING, logger="chords.admin"):
        with pytest.raises(AuditUnavailable) as caught:
            audit.record_view(entry("search", query="ivan", matched_uids=["u1"]))
    assert caught.value.status == 503 and caught.value.code == "audit_unavailable"
    assert db.audit_docs() == []
    assert len(metric_lines(caplog)) == 1


def test_record_view_takes_only_views(audit: Audit) -> None:
    with pytest.raises(ValueError):
        audit.record_view(entry("limit_set"))


# --------------------------------------------------------------------------- AC-10b: rejected attempts, nothing else


def test_a_rejected_attempt_is_journaled_with_its_reason(db: FakeDb, audit: Audit) -> None:
    audit.record_first(entry("restrict", outcome="rejected", reject_reason="self_target", target_uid="admin-1"))
    doc = only_audit_doc(db)
    assert doc["outcome"] == "rejected" and doc["rejectReason"] == "self_target"
    assert doc["targetUid"] == "admin-1"


@pytest.mark.parametrize(
    "kw",
    [
        {"outcome": "rejected"},  # no reason
        {"outcome": "applied", "reject_reason": "self_target"},  # a reason on an accepted action
        {"outcome": "invalid"},  # form validation errors are not an outcome: never journaled
        {"action": "invalid_value"},
        {"action": "limit_set", "query": "ivan"},  # query only on search
        {"action": "search", "query": "iv"},  # shorter than 3
        {"action": "search", "query": "x" * 255},
        {"action": "search", "query": "ivan", "matched_uids": [f"u{i}" for i in range(51)]},
        {"action": "limit_set", "matched_uids": ["u1"]},
        {"outcome": "applied", "ref_id": "abc"},  # refId belongs to a not_applied follow-up
        {"admin_uid": ""},
        {"admin_email": ""},
    ],
)
def test_malformed_entries_are_refused_before_any_write(db: FakeDb, audit: Audit, kw: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        audit.record_first(entry(**kw))
    assert db.commit_log == []


def test_a_search_with_exactly_fifty_matches_is_accepted(db: FakeDb, audit: Audit) -> None:
    audit.record_view(entry("search", query="abc", matched_uids=[f"u{i}" for i in range(50)]))
    assert len(only_audit_doc(db)["matchedUids"]) == 50


# --------------------------------------------------------------------------- record shape: expireAt, no target email


def test_every_record_expires_400_days_after_it_was_written(db: FakeDb, audit: Audit) -> None:
    assert EXPIRE_AFTER == timedelta(days=400)
    audit.record_view(entry("view_card", target_uid="victim-1"))
    doc = only_audit_doc(db)
    at, expire = parse_ts(doc["at"]), parse_ts(doc["expireAt"])
    assert at == T0 and expire - at == timedelta(days=400)


def test_a_record_carries_the_admins_email_and_never_the_targets(db: FakeDb, audit: Audit) -> None:
    audit.record_with(
        [effect_write(db)],
        entry("restrict", target_uid="victim-1", before=None, after={"state": "restricted"}),
    )
    audit.record_view(entry("search", query="victim", matched_uids=["victim-1"]))
    audit.record_view(entry("view_card", target_uid="victim-1"))
    audit.record_first(entry("restrict", outcome="rejected", reject_reason="self_target", target_uid="admin-1"))
    assert len(db.audit_docs()) == 4
    for _, doc in db.audit_docs():
        assert doc["adminEmail"] == ADMIN_EMAIL
        assert TARGET_EMAIL not in repr(doc)
        assert set(doc) == {
            "at", "adminUid", "adminEmail", "action", "outcome", "targetUid", "setting", "before", "after",
            "rejectReason", "query", "matchedUids", "refId", "expireAt", "redactedAt",
        }
        assert doc["redactedAt"] is None


def test_each_record_is_a_new_document_and_never_overwrites_one(db: FakeDb, audit: Audit) -> None:
    ref = audit.record_first(entry())
    assert [w["currentDocument"] for c in db.commit_log for w in c] == [{"exists": False}]
    with pytest.raises(NotApplied):  # the same id again would be an overwrite: the precondition refuses it
        Audit(db, now=lambda: T0, new_id=lambda: ref).record_first(entry())
    assert len(db.audit_docs()) == 1


def test_the_writer_has_no_way_to_update_or_delete_a_record() -> None:
    public = {n for n in dir(Audit) if not n.startswith("_")}
    assert public == {"record_with", "record_first", "apply_first", "mark_not_applied", "record_view"}
    assert not [n for n in dir(auditmod) if n.startswith(("update_", "delete_", "remove_"))]


def test_the_writer_only_touches_the_audit_collection_itself(db: FakeDb, audit: Audit) -> None:
    audit.record_view(entry("view_card", target_uid="victim-1"))
    audit.record_first(entry("quota_reset"))
    for commit in db.commit_log:
        for w in commit:
            assert w["update"]["name"].split("/documents/", 1)[1].startswith(COLLECTION + "/")


# --------------------------------------------------------------------------- the 503 answers over HTTP


def test_the_two_failures_render_as_503_with_the_contract_codes(tmp_path: Path) -> None:
    failing = FakeDb()
    audit = Audit(failing, now=lambda: T0)
    router: APIRouter = new_admin_router()

    @router.put("/change")
    def change() -> dict[str, Any]:
        failing.fail_next = [IndexError_("down", retryable=True)]
        audit.record_with([failing.update_op("adminAccounts/u", {"a": 1})], entry())
        return {"ok": True}

    @router.get("/view")
    def view() -> dict[str, Any]:
        failing.fail_next = [IndexError_("down", retryable=True)]
        audit.record_view(entry("view_card", target_uid="u"))
        return {"secret": "personal data"}

    class Verifier:
        def verify_claims(self, token: str) -> tuple[str, Optional[float]]:
            return "boss", 0.0

        def verify(self, token: str) -> str:
            return "boss"

    class AllowDb:
        def get(self, path: str) -> Document:
            return Document(path, {})

    settings = Settings(
        data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist", auth="firebase",
        signing_key="test-signing-key-0123456789abcdef", publish=False, allowed_hosts=("testserver", "localhost"),
    )
    app = create_app(
        settings, analyzer=lambda *a, **k: {}, engine_info_fn=lambda: {"name": "fake", "version": "1", "features": {}},
        token_verifier=Verifier(), admin_router=router, admin_authz=AdminAuthz(AllowDb()),
    )
    headers = {"Authorization": "Bearer tok-boss"}
    with TestClient(app) as client:
        res = client.put("/api/admin/change", headers=headers)
        assert res.status_code == 503 and res.json()["code"] == "not_applied"
        assert set(res.json()) == {"detail", "code"}
        res = client.get("/api/admin/view", headers=headers)
        assert res.status_code == 503 and res.json()["code"] == "audit_unavailable"
        assert "personal data" not in res.text
    assert failing.audit_docs() == []


# --------------------------------------------------------------------------- Firestore emulator


@pytest.fixture
def emulator_audit(admin_db: FirestoreIndex) -> SimpleNamespace:
    return SimpleNamespace(db=admin_db, audit=Audit(admin_db))


def test_emulator_change_and_record_land_together_or_not_at_all(emulator_audit: SimpleNamespace) -> None:
    db, audit = emulator_audit.db, emulator_audit.audit
    uid = f"t10-{secrets.token_hex(4)}"
    path = f"adminAccounts/{uid}"
    db.commit([db.update_op(path, {"limit": 40}, exists=False)])
    ref = audit.record_with([db.update_op(path, {"limit": 100}, exists=True)], entry(target_uid=uid, setting="limits"))
    assert db.get(path).data == {"limit": 100}
    saved = db.get(f"{COLLECTION}/{ref}").data
    assert saved["targetUid"] == uid and saved["outcome"] == "applied"
    assert parse_ts(saved["expireAt"]) - parse_ts(saved["at"]) == timedelta(days=400)

    before = db.count(COLLECTION, filters=[("targetUid", "==", uid)])
    with pytest.raises(PreconditionFailed):  # the change's own precondition fails: the record must not land either
        audit.record_with([db.update_op(f"{path}-missing", {"limit": 1}, exists=True)], entry(target_uid=uid))
    assert db.count(COLLECTION, filters=[("targetUid", "==", uid)]) == before
    assert db.get(path).data == {"limit": 100}


def test_emulator_not_applied_followup_points_at_its_record(emulator_audit: SimpleNamespace) -> None:
    db, audit = emulator_audit.db, emulator_audit.audit
    first = entry("quota_reset", target_uid="t10-quota")
    ref = audit.record_first(first)
    assert audit.mark_not_applied(ref, first) is True
    rows = db.run_query(COLLECTION, filters=[("refId", "==", ref)])
    assert len(rows) == 1 and rows[0].data["outcome"] == "not_applied"

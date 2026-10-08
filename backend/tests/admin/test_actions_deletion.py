"""scheduleDeletion and cancelDeletion (docs/features/admin: AC-17, AC-20, AC-21, AC-23, AC-34, AC-35; ADR-0005,
ADR-0007; contracts/openapi.yaml ``/api/admin/users/{uid}/deletion``).

The tests run the real app (admin router, authz, audit writer, admission gate) over ``UsersDb``, an in-memory Firestore
that applies the real REST write bodies and serves ``count``. Scheduling is one Firestore transaction on
``adminAccounts/<uid>`` with its journal record in the same commit. The order of the checks is the contract's: fresh
login, own account, already scheduled, typed e-mail, the cap of 10 per 60 minutes. Only the e-mail mismatch is an input
error that is not journaled (like a form validation error); every other refusal is a journaled rejected attempt.
"""
from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from admin.fixtures import (
    ADMIN_EMAIL,
    BOSS,
    ENGINE_INFO,
    REASON,
    SCHEDULED,
    SINCE,
    Clock,
    FakeVerifier,
    H,
    admit,
    counting,
    deletion,
    journal,
    make_account_state,
    make_admin,
    make_audit,
    make_user,
    never,
    restriction,
    seed_account,
    settings_for,
    snapshot,
)
from app.admin.actions import DELETION_CAP, emails_match
from app.admin.router import get_services
from app.firestore import Aborted, FirestoreIndex
from app.main import create_app
from app.sources import SourceError

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

UID = "u1"
EMAIL = "Ivan.P@example.test"        # as stored on ``users/u1`` (``seed`` creates it)
URL = f"/api/admin/users/{UID}/deletion"
SELF_URL = f"/api/admin/users/{BOSS}/deletion"
FIXED_REASON = "Scheduled deletion"
OTHER = "boss2"


def schedule(w: SimpleNamespace, email: Any = EMAIL, url: str = URL, who: str = BOSS, age_s: Optional[float] = None):
    return w.client.post(url, json={"confirmEmail": email}, headers=H(who, age_s))


def cancel(w: SimpleNamespace, url: str = URL, who: str = BOSS, age_s: Optional[float] = None):
    return w.client.delete(url, headers=H(who, age_s))


def pin_clock(w: SimpleNamespace) -> None:
    """The authz clock reads ``T0``, the moment ``FakeVerifier`` signs everybody in (``age_s`` is then exact)."""
    w.app.state.admin_authz.clock = Clock()


def in_the_window(w: SimpleNamespace, n: int, *, minutes_ago: float = 5, admin: str = "other-admin", **record: Any) -> None:
    """``n`` journal records of scheduled deletions that happened ``minutes_ago`` ago (by any admin)."""
    now = datetime.now(timezone.utc)
    w.db.put(*(make_audit("deletion_scheduled", admin_uid=admin, target_uid=f"gone-{i}", at=now - timedelta(minutes=minutes_ago, seconds=i),
                          **record) for i in range(n)))


def state(w: SimpleNamespace) -> dict[str, Any]:
    """Everything but the journal (the journal grows with every attempt)."""
    return {p: d for p, d in snapshot(w).items() if not p.startswith("adminAudit/")}


def second_admin(w: SimpleNamespace) -> None:
    w.db.put(make_admin(OTHER), make_user(OTHER, "second.admin@example.test"))


# =========================================================================== AC-20: scheduleDeletion


def test_schedule_sets_purge_after_seven_days_and_restricts_at_once_in_one_commit(world) -> None:
    w = world()
    seed_account(w)
    commits = counting(w)

    res = schedule(w)

    assert res.status_code == 200, res.text
    assert commits[0] == 1                                        # deletion, restriction and record: one commit
    body = res.json()
    assert body["uid"] == UID and body["status"] == "deletion_scheduled"
    scheduled_at = datetime.fromisoformat(body["deletion"]["scheduledAt"].replace("Z", "+00:00"))
    purge_after = datetime.fromisoformat(body["deletion"]["purgeAfter"].replace("Z", "+00:00"))
    assert purge_after - scheduled_at == timedelta(days=7) and body["deletion"]["byAdminUid"] == BOSS
    assert abs(scheduled_at - datetime.now(timezone.utc)) < timedelta(minutes=1)
    assert body["restriction"]["reason"] == FIXED_REASON and body["restriction"]["byAdminUid"] == BOSS
    stored = w.db.docs[f"adminAccounts/{UID}"]
    assert stored["deletion"]["purgeAfter"] and stored["deletion"]["priorRestriction"] is None
    assert stored["restriction"]["reason"] == FIXED_REASON and stored["restriction"]["byAdminUid"] == BOSS
    assert stored["restriction"]["since"] == stored["deletion"]["scheduledAt"]
    [record] = journal(w)
    assert record["action"] == "deletion_scheduled" and record["outcome"] == "applied" and record["rejectReason"] is None
    assert record["targetUid"] == UID and record["adminUid"] == BOSS and record["adminEmail"] == ADMIN_EMAIL
    assert record["before"] is None
    assert record["after"]["purgeAfter"] == stored["deletion"]["purgeAfter"]
    assert EMAIL.lower() not in str(record).lower()                # the journal never keeps the target's e-mail


def test_the_card_shows_the_scheduled_deletion_with_its_date(world) -> None:
    w = world()
    seed_account(w)
    assert schedule(w).status_code == 200
    account = w.client.get(f"/api/admin/users/{UID}", headers=H(BOSS)).json()["account"]
    assert account["status"] == "deletion_scheduled"
    assert account["deletion"]["purgeAfter"] and account["restriction"]["reason"] == FIXED_REASON


def test_the_prior_restriction_is_kept_inside_the_deletion_and_replaced_by_the_fixed_one(world) -> None:
    w = world()
    held = restriction(reason="автоматичні масові запити", by="someone")
    seed_account(w, restriction=held)

    res = schedule(w)

    assert res.status_code == 200, res.text
    stored = w.db.docs[f"adminAccounts/{UID}"]
    assert stored["deletion"]["priorRestriction"] == {"reason": held["reason"], "since": "2026-10-01T09:00:00Z", "byAdminUid": "someone"}
    assert stored["restriction"]["reason"] == FIXED_REASON
    assert "priorRestriction" not in res.text                      # deliberately not exposed (api-sync-report)
    [record] = journal(w)
    assert record["before"]["reason"] == held["reason"] and record["before"]["since"] == "2026-10-01T09:00:00Z"
    assert record["after"]["reason"] == FIXED_REASON


def test_new_cloud_jobs_are_refused_at_once_on_this_server(world) -> None:
    w = world()
    seed_account(w)
    admit(w)                                                      # the gate has cached "not restricted"
    assert schedule(w).status_code == 200
    for kind in ("analysis", "reanalysis", "vocals"):
        with pytest.raises(SourceError) as info:
            admit(w, kind)
        assert info.value.code == "cloud_restricted"


def test_scheduling_touches_only_the_account_state_and_the_journal(world) -> None:
    w = world()
    seed_account(w, personal_limit={"analyses": 7, "setAt": SINCE, "byAdminUid": "x"})
    seed_account(w, "u2")
    before = state(w)

    assert schedule(w).status_code == 200

    after = state(w)
    assert {p for p in after if after[p] != before.get(p)} == {f"adminAccounts/{UID}"}
    assert after[f"adminAccounts/{UID}"]["personalLimit"] == before[f"adminAccounts/{UID}"]["personalLimit"]
    assert len(journal(w)) == 1


# =========================================================================== AC-21: the typed e-mail


def test_the_email_rule_ignores_case_and_surrounding_spaces_and_nothing_else() -> None:
    assert emails_match("Ivan.P@example.test", "Ivan.P@example.test")
    assert emails_match("ivan.p@EXAMPLE.test", "Ivan.P@example.test")
    assert emails_match("  ivan.p@example.test\t", "Ivan.P@example.test")
    assert not emails_match("ivan@example.test", "Ivan.P@example.test")           # a part of it
    assert not emails_match("ivan.p@example.test.", "Ivan.P@example.test")
    assert not emails_match("iv an.p@example.test", "Ivan.P@example.test")        # inner spaces count
    assert not emails_match("", "Ivan.P@example.test")
    assert not emails_match("ivan.p@example.test", None)                           # an account without an e-mail


@pytest.mark.parametrize("typed", ["ivan.p@example.test", "IVAN.P@EXAMPLE.TEST", "  Ivan.P@example.test  "])
def test_the_typed_email_is_compared_without_case_or_spaces(world, typed: str) -> None:
    w = world()
    seed_account(w)
    res = schedule(w, typed)
    assert res.status_code == 200, res.text


@pytest.mark.parametrize("typed", ["maria@example.test", "ivan@example.test", "ivan.p@example.test.", "u1", "Ivan P@example.test"])
def test_a_mismatched_email_does_not_schedule_and_is_not_journaled(world, typed: str) -> None:
    w = world()
    seed_account(w)
    before, commits = snapshot(w), counting(w)

    res = schedule(w, typed)

    assert res.status_code == 422 and res.json()["code"] == "confirm_email_mismatch"
    assert "email" in res.json()["detail"].lower()                # says to type this user's e-mail
    assert commits[0] == 0 and w.db.docs == before and not journal(w)


def test_the_email_is_not_taken_from_another_user(world) -> None:
    w = world()
    seed_account(w)
    seed_account(w, "u2")
    w.db.put(make_user("u2", "other@example.test"))
    assert schedule(w, "other@example.test").status_code == 422
    assert f"adminAccounts/{UID}" not in w.db.docs or not w.db.docs[f"adminAccounts/{UID}"].get("deletion")


@pytest.mark.parametrize("body", [{}, {"confirmEmail": ""}, {"confirmEmail": "   "}, {"confirmEmail": 5}])
def test_a_missing_or_blank_confirmation_is_an_invalid_form_not_journaled(world, body: dict) -> None:
    w = world()
    seed_account(w)
    res = w.client.post(URL, json=body, headers=H(BOSS))
    assert res.status_code == 422 and res.json()["code"] == "invalid_value"
    assert not journal(w) and not w.db.docs.get(f"adminAccounts/{UID}")


# =========================================================================== AC-17 and the other refusals


def test_an_admin_cannot_schedule_the_deletion_of_their_own_account_and_the_attempt_is_journaled(world) -> None:
    w = world()
    before, commits = snapshot(w), counting(w)

    res = schedule(w, ADMIN_EMAIL, url=SELF_URL)               # even with the right e-mail

    assert res.status_code == 409 and res.json()["code"] == "self_target"
    assert "own account" in res.json()["detail"]
    assert commits[0] == 1                                       # only the record
    assert {p: d for p, d in w.db.docs.items() if not p.startswith("adminAudit/")} == {
        p: d for p, d in before.items() if not p.startswith("adminAudit/")}
    [record] = journal(w)
    assert record["action"] == "deletion_scheduled" and record["outcome"] == "rejected"
    assert record["rejectReason"] == "self_target" and record["targetUid"] == BOSS and record["adminUid"] == BOSS


def test_self_target_is_decided_before_the_email_is_looked_at(world) -> None:
    w = world()
    res = schedule(w, "wrong@example.test", url=SELF_URL)
    assert res.status_code == 409 and res.json()["code"] == "self_target"
    assert [r["rejectReason"] for r in journal(w)] == ["self_target"]


def test_an_already_scheduled_deletion_is_refused_and_journaled(world) -> None:
    w = world()
    seed_account(w, restriction=restriction(reason=FIXED_REASON, since=SCHEDULED), deletion=deletion(None))
    before = state(w)

    res = schedule(w)

    assert res.status_code == 409 and res.json()["code"] == "deletion_pending"
    assert state(w) == before                                    # the first date stands
    [record] = journal(w)
    assert record["action"] == "deletion_scheduled" and record["outcome"] == "rejected"
    assert record["rejectReason"] == "deletion_pending" and record["targetUid"] == UID


def test_deletion_pending_is_decided_before_the_email(world) -> None:
    w = world()
    seed_account(w, restriction=restriction(reason=FIXED_REASON, since=SCHEDULED), deletion=deletion(None))
    res = schedule(w, "wrong@example.test")
    assert res.status_code == 409 and res.json()["code"] == "deletion_pending"


def test_a_deletion_scheduled_meanwhile_is_seen_when_the_transaction_runs_again(world) -> None:
    w = world()
    seed_account(w)
    real = w.db.commit
    calls: list[int] = []

    def contended(writes, *, transaction=None):
        if transaction is not None and not calls:
            calls.append(1)
            w.db.put(make_account_state(UID, restriction=restriction(reason=FIXED_REASON), deletion=deletion(None)))
            raise Aborted("another writer got there first")
        real(writes, transaction=transaction)

    w.db.commit = contended  # type: ignore[method-assign]

    res = schedule(w)

    assert res.status_code == 409 and res.json()["code"] == "deletion_pending"
    assert [r["outcome"] for r in journal(w)] == ["rejected"]


def test_an_aborted_commit_is_retried_and_journaled_once(world) -> None:
    w = world()
    seed_account(w)
    real = w.db.commit
    calls: list[int] = []

    def contended(writes, *, transaction=None):
        if transaction is not None and not calls:
            calls.append(1)
            raise Aborted("contention")
        real(writes, transaction=transaction)

    w.db.commit = contended  # type: ignore[method-assign]

    assert schedule(w).status_code == 200
    assert [r["action"] for r in journal(w)] == ["deletion_scheduled"]


# =========================================================================== AC-34: a fresh sign-in


def test_a_stale_login_does_not_schedule_until_the_admin_signs_in_again(world) -> None:
    w = world()
    pin_clock(w)
    seed_account(w)
    before, commits = snapshot(w), counting(w)

    res = schedule(w, age_s=15 * 60 + 1)

    assert res.status_code == 401
    assert res.json() == {"detail": "Sign in again to confirm this action", "code": "reauth_required"}
    assert commits[0] == 0 and w.db.docs == before and not journal(w)     # not done, not journaled

    res = schedule(w, age_s=60)                                           # signed in again

    assert res.status_code == 200, res.text
    assert [(r["action"], r["outcome"]) for r in journal(w)] == [("deletion_scheduled", "applied")]


def test_a_login_just_inside_15_minutes_is_fresh(world) -> None:
    w = world()
    pin_clock(w)
    seed_account(w)
    assert schedule(w, age_s=14 * 60 + 59).status_code == 200


def test_the_fresh_login_is_checked_before_the_user_is_looked_at(world) -> None:
    w = world()
    pin_clock(w)
    res = schedule(w, url="/api/admin/users/nobody/deletion", age_s=3600)
    assert res.status_code == 401 and res.json()["code"] == "reauth_required"
    res = schedule(w, url=SELF_URL, age_s=3600)
    assert res.status_code == 401 and not journal(w)                      # not even the own-account refusal is journaled


def test_cancelling_needs_no_fresh_login(world) -> None:
    w = world()
    pin_clock(w)
    seed_account(w, restriction=restriction(reason=FIXED_REASON, since=SCHEDULED), deletion=deletion(None))
    res = cancel(w, age_s=3 * 3600)
    assert res.status_code == 200, res.text


# =========================================================================== AC-35: 10 per 60 minutes, all admins


def test_the_cap_is_ten() -> None:
    assert DELETION_CAP == 10


def test_the_11th_deletion_in_60_minutes_is_refused_and_journaled(world) -> None:
    w = world()
    seed_account(w)
    in_the_window(w, 10)
    before, commits = state(w), counting(w)

    res = schedule(w)

    assert res.status_code == 429 and res.json()["code"] == "deletion_rate_limit"
    assert "10" in res.json()["detail"] and "60" in res.json()["detail"]
    assert commits[0] == 1 and state(w) == before                         # only the record of the attempt
    rejected = [r for r in journal(w) if r["outcome"] == "rejected"]
    assert len(rejected) == 1
    assert rejected[0]["action"] == "deletion_scheduled" and rejected[0]["rejectReason"] == "deletion_rate_limit"
    assert rejected[0]["targetUid"] == UID and rejected[0]["adminUid"] == BOSS


def test_the_tenth_is_accepted(world) -> None:
    w = world()
    seed_account(w)
    in_the_window(w, 9)
    assert schedule(w).status_code == 200


def test_two_admins_together_fill_the_cap(world) -> None:
    w = world()
    second_admin(w)
    for i in range(10):
        seed_account(w, f"v{i}")
        w.db.put(make_user(f"v{i}", f"v{i}@example.test"))
    seed_account(w)
    for i in range(5):
        assert schedule(w, f"v{i}@example.test", f"/api/admin/users/v{i}/deletion", who=BOSS).status_code == 200
        assert schedule(w, f"v{i + 5}@example.test", f"/api/admin/users/v{i + 5}/deletion", who=OTHER).status_code == 200

    res = schedule(w, who=OTHER)                                           # either admin: the 11th

    assert res.status_code == 429 and res.json()["code"] == "deletion_rate_limit"
    res = schedule(w, who=BOSS)
    assert res.status_code == 429
    assert not w.db.docs.get(f"adminAccounts/{UID}", {}).get("deletion")
    assert sorted(r["adminUid"] for r in journal(w) if r["outcome"] == "rejected") == [BOSS, OTHER]


def test_the_oldest_leaving_the_window_frees_a_place(world) -> None:
    w = world()
    seed_account(w)
    in_the_window(w, 9)
    in_the_window(w, 1, minutes_ago=59)                                    # the 10th is still inside the window
    assert schedule(w).status_code == 429
    w2 = world()
    seed_account(w2)
    in_the_window(w2, 9)
    in_the_window(w2, 1, minutes_ago=61)                                   # the 10th has left it
    assert schedule(w2).status_code == 200, "an old deletion must not count"


def test_only_applied_deletions_count(world) -> None:
    w = world()
    seed_account(w)
    in_the_window(w, 10, outcome="rejected", rejectReason="deletion_pending")      # attempts are not deletions
    in_the_window(w, 3, outcome="not_applied", refId="x")
    w.db.put(*(make_audit("deletion_cancelled", admin_uid="x", target_uid=f"c{i}", at=datetime.now(timezone.utc)) for i in range(10)))
    w.db.put(*(make_audit("restrict", admin_uid="x", target_uid=f"r{i}", at=datetime.now(timezone.utc)) for i in range(10)))
    assert schedule(w).status_code == 200


def test_refusals_before_the_cap_do_not_need_a_free_place(world) -> None:
    w = world()
    in_the_window(w, 10)
    seed_account(w, restriction=restriction(reason=FIXED_REASON, since=SCHEDULED), deletion=deletion(None))
    assert schedule(w).json()["code"] == "deletion_pending"                # decided before the cap
    seed_account(w, "u3")
    w.db.put(make_user("u3", "three@example.test"))
    res = schedule(w, "wrong@example.test", "/api/admin/users/u3/deletion")
    assert res.status_code == 422 and res.json()["code"] == "confirm_email_mismatch"
    assert schedule(w, ADMIN_EMAIL, SELF_URL).json()["code"] == "self_target"


def test_a_refused_attempt_does_not_use_up_a_place(world) -> None:
    w = world()
    seed_account(w)
    in_the_window(w, 8)
    for _ in range(5):
        assert schedule(w, "wrong@example.test").status_code == 422
    assert schedule(w, ADMIN_EMAIL, SELF_URL).status_code == 409
    assert schedule(w).status_code == 200                                  # 9th
    seed_account(w, "u2")
    w.db.put(make_user("u2", "two@example.test"))
    assert schedule(w, "two@example.test", "/api/admin/users/u2/deletion").status_code == 200   # 10th
    seed_account(w, "u4")
    w.db.put(make_user("u4", "four@example.test"))
    assert schedule(w, "four@example.test", "/api/admin/users/u4/deletion").status_code == 429


def test_concurrent_requests_cannot_both_take_the_last_place(world) -> None:
    w = world()
    in_the_window(w, 9)
    for i in range(6):
        seed_account(w, f"c{i}")
        w.db.put(make_user(f"c{i}", f"c{i}@example.test"))
    codes: list[int] = []
    start = threading.Barrier(6)

    def go(i: int) -> None:
        start.wait()
        codes.append(schedule(w, f"c{i}@example.test", f"/api/admin/users/c{i}/deletion").status_code)

    threads = [threading.Thread(target=go, args=(i,)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sorted(codes) == [200, 429, 429, 429, 429, 429]


# =========================================================================== AC-33: journal first


def test_a_failed_journal_write_leaves_the_account_unchanged(world) -> None:
    w = world()
    seed_account(w)
    before = snapshot(w)
    w.db.fail_audit = True

    res = schedule(w)

    assert res.status_code == 503 and res.json()["code"] == "not_applied"
    assert w.db.docs == before and not journal(w)
    admit(w)                                                                # still not restricted
    w.db.fail_audit = False
    assert schedule(w).status_code == 200                                   # and a retry works


def test_a_refusal_that_cannot_be_journaled_is_not_applied(world) -> None:
    w = world()
    w.db.fail_audit = True
    res = schedule(w, ADMIN_EMAIL, SELF_URL)
    assert res.status_code == 503 and res.json()["code"] == "not_applied"


def test_a_database_that_fails_while_reading_is_not_applied(world) -> None:
    w = world()
    seed_account(w)
    before = snapshot(w)
    from app.firestore import IndexError_

    def down(path: str, body: dict) -> Any:
        raise IndexError_("Firestore is down", retryable=True)

    w.db._post = down  # type: ignore[method-assign]
    res = schedule(w)
    assert res.status_code == 503 and res.json()["code"] == "not_applied"
    assert w.db.docs == before


def test_a_non_admin_cannot_schedule_or_cancel(world) -> None:
    w = world()
    seed_account(w, restriction=restriction(reason=FIXED_REASON, since=SCHEDULED), deletion=deletion(None))
    before = snapshot(w)
    assert schedule(w, who="mallory").status_code == 404
    assert cancel(w, who="mallory").status_code == 404
    assert w.db.docs == before and not journal(w)


def test_an_unknown_user_is_a_404_and_leaves_no_record(world) -> None:
    w = world()
    for res in (schedule(w, url="/api/admin/users/nobody/deletion"), cancel(w, url="/api/admin/users/nobody/deletion")):
        assert res.status_code == 404 and res.json()["code"] == "not_found"
    assert not journal(w) and "adminAccounts/nobody" not in w.db.docs


def test_a_purged_user_is_a_404(world) -> None:
    w = world()
    seed_account(w)
    w.db.docs[f"adminTombstones/{UID}"] = {"purgedAt": "2026-10-01T00:00:00Z"}
    assert schedule(w).status_code == 404 and cancel(w).status_code == 404
    assert not journal(w)


# =========================================================================== AC-23: cancelDeletion


def test_cancelling_without_a_prior_restriction_returns_to_the_normal_state(world) -> None:
    w = world()
    seed_account(w)
    assert schedule(w).status_code == 200
    commits = counting(w)

    res = cancel(w)

    assert res.status_code == 200, res.text
    assert commits[0] == 1
    body = res.json()
    assert body["status"] == "normal" and body["restriction"] is None and body["deletion"] is None
    stored = w.db.docs[f"adminAccounts/{UID}"]
    assert not stored.get("restriction") and not stored.get("deletion")
    records = journal(w)
    assert [(r["action"], r["outcome"]) for r in records] == [("deletion_scheduled", "applied"), ("deletion_cancelled", "applied")]
    last = records[-1]
    assert last["targetUid"] == UID and last["adminUid"] == BOSS and last["rejectReason"] is None
    assert last["before"]["reason"] == FIXED_REASON and last["after"] is None
    admit(w)                                                                # cloud analysis is allowed again


def test_cancelling_restores_the_prior_restriction_exactly(world) -> None:
    w = world()
    held = restriction(reason="автоматичні масові запити", by="someone")
    seed_account(w, restriction=held)
    before = w.db.docs[f"adminAccounts/{UID}"]["restriction"]
    assert schedule(w).status_code == 200
    assert w.db.docs[f"adminAccounts/{UID}"]["restriction"]["reason"] == FIXED_REASON

    res = cancel(w)

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "restricted" and body["deletion"] is None
    assert body["restriction"]["reason"] == held["reason"] and body["restriction"]["byAdminUid"] == "someone"
    assert w.db.docs[f"adminAccounts/{UID}"]["restriction"] == before      # the same reason, date and admin
    assert not w.db.docs[f"adminAccounts/{UID}"].get("deletion")
    last = journal(w)[-1]
    assert last["action"] == "deletion_cancelled" and last["after"]["reason"] == held["reason"]
    with pytest.raises(SourceError) as info:
        admit(w)
    assert info.value.code == "cloud_restricted"                            # the old restriction is in force


def test_a_restriction_put_on_through_the_api_comes_back_the_same(world) -> None:
    w = world()
    seed_account(w)
    assert w.client.put(f"/api/admin/users/{UID}/restriction", json={"reason": REASON}, headers=H(BOSS)).status_code == 200
    before = w.db.docs[f"adminAccounts/{UID}"]["restriction"]
    assert schedule(w).status_code == 200 and cancel(w).status_code == 200
    assert w.db.docs[f"adminAccounts/{UID}"]["restriction"] == before


def test_after_cancelling_the_restriction_can_be_changed_again(world) -> None:
    w = world()
    seed_account(w)
    assert schedule(w).status_code == 200 and cancel(w).status_code == 200
    assert w.client.put(f"/api/admin/users/{UID}/restriction", json={"reason": "x"}, headers=H(BOSS)).status_code == 200


def test_cancelling_keeps_the_personal_limit_and_the_counters_untouched(world) -> None:
    w = world()
    limit = {"analyses": 7, "setAt": SINCE, "byAdminUid": "x"}
    seed_account(w, personal_limit=limit)
    assert schedule(w).status_code == 200
    stored = w.db.docs[f"adminAccounts/{UID}"]["personalLimit"]
    assert cancel(w).status_code == 200
    assert w.db.docs[f"adminAccounts/{UID}"]["personalLimit"] == stored


def test_nothing_to_cancel_is_not_scheduled_and_journaled(world) -> None:
    w = world()
    seed_account(w, restriction=restriction())
    before = state(w)

    res = cancel(w)

    assert res.status_code == 409 and res.json()["code"] == "not_scheduled"
    assert state(w) == before
    [record] = journal(w)
    assert record["action"] == "deletion_cancelled" and record["outcome"] == "rejected"
    assert record["rejectReason"] == "not_scheduled" and record["targetUid"] == UID


def test_a_user_with_no_admin_state_at_all_is_not_scheduled(world) -> None:
    w = world()
    seed_account(w)
    res = cancel(w)
    assert res.status_code == 409 and res.json()["code"] == "not_scheduled"
    assert [r["rejectReason"] for r in journal(w)] == ["not_scheduled"]
    assert f"adminAccounts/{UID}" not in w.db.docs                          # a refusal creates no state


def test_cancelling_after_the_window_has_passed_is_not_scheduled(world) -> None:
    w = world()
    past = datetime.now(timezone.utc) - timedelta(minutes=1)
    held = {"scheduledAt": past - timedelta(days=7), "purgeAfter": past, "byAdminUid": "someone", "priorRestriction": None}
    seed_account(w, restriction=restriction(reason=FIXED_REASON, since=past - timedelta(days=7)), deletion=held)
    before = state(w)

    res = cancel(w)

    assert res.status_code == 409 and res.json()["code"] == "not_scheduled"
    assert state(w) == before                                               # the purge goes on
    assert [(r["outcome"], r["rejectReason"]) for r in journal(w)] == [("rejected", "not_scheduled")]


def test_cancelling_on_the_last_day_still_works(world) -> None:
    w = world()
    soon = datetime.now(timezone.utc) + timedelta(hours=1)
    held = {"scheduledAt": soon - timedelta(days=7), "purgeAfter": soon, "byAdminUid": "someone", "priorRestriction": None}
    seed_account(w, restriction=restriction(reason=FIXED_REASON, since=soon - timedelta(days=7)), deletion=held)
    assert cancel(w).status_code == 200


def test_a_failed_journal_write_leaves_the_scheduled_deletion_in_place(world) -> None:
    w = world()
    seed_account(w)
    assert schedule(w).status_code == 200
    before = snapshot(w)
    w.db.fail_audit = True

    res = cancel(w)

    assert res.status_code == 503 and res.json()["code"] == "not_applied"
    assert w.db.docs == before
    w.db.fail_audit = False
    assert cancel(w).status_code == 200


def test_cancelling_twice_the_second_time_is_not_scheduled(world) -> None:
    w = world()
    seed_account(w)
    assert schedule(w).status_code == 200 and cancel(w).status_code == 200
    assert cancel(w).json()["code"] == "not_scheduled"


# =========================================================================== T45: review S2-1 / S2-4


def test_s2_1_admin_actions_work_when_the_profile_document_is_missing(world) -> None:
    """The rules let a user delete their own ``users/{uid}``; the account is still known from ``adminAccounts``."""
    w = world()
    seed_account(w, restriction=restriction(reason=FIXED_REASON), deletion=deletion())
    del w.db.docs[f"users/{UID}"]
    w.db.docs[f"adminAccounts/{UID}"]["deletion"]["purgeAfter"] = datetime.now(timezone.utc) + timedelta(days=3)

    assert cancel(w).status_code == 200                                      # the deletion can still be cancelled
    assert "deletion" not in w.db.docs[f"adminAccounts/{UID}"]
    assert w.client.put(f"/api/admin/users/{UID}/restriction", json={"reason": "x"}, headers=H(BOSS)).status_code == 200


def test_s2_1_a_uid_nobody_knows_is_still_a_404(world) -> None:
    w = world()
    assert cancel(w, url="/api/admin/users/ghost/deletion").status_code == 404


def test_s2_4_cancel_refuses_once_the_tombstone_exists_inside_the_transaction(world) -> None:
    from app.admin import actions

    w = world()
    soon = datetime.now(timezone.utc) + timedelta(days=1)
    seed_account(w, restriction=restriction(reason=FIXED_REASON), deletion={**deletion(), "purgeAfter": soon})
    w.db.docs[f"adminTombstones/{UID}"] = {"status": "purging"}              # the purge began after the request's check
    before = state(w)

    with pytest.raises(SourceError) as err:
        actions.cancel_deletion(w.services, admin_uid=BOSS, admin_email=ADMIN_EMAIL, uid=UID,
                                now=datetime.now(timezone.utc) - timedelta(days=2))

    assert err.value.code == "not_scheduled"
    assert state(w) == before


def test_s2_4_cancel_uses_the_time_of_the_commit_not_the_time_of_the_request(world) -> None:
    from app.admin import actions

    w = world()
    past = datetime.now(timezone.utc) - timedelta(minutes=1)
    seed_account(w, restriction=restriction(reason=FIXED_REASON), deletion={**deletion(), "purgeAfter": past})
    with pytest.raises(SourceError) as err:
        actions.cancel_deletion(w.services, admin_uid=BOSS, admin_email=ADMIN_EMAIL, uid=UID,
                                now=past - timedelta(hours=1))               # a stale ``now``
    assert err.value.code == "not_scheduled"


# =========================================================================== the Firestore emulator (when there is one)


def test_emulator_deletion_is_a_real_transaction_with_its_journal_record_and_the_cap(admin_db: FirestoreIndex, tmp_path: Path) -> None:
    from admin.fixtures import seed as seed_docs

    boss, uid, other = "t22-boss", "t22-user", "t22-other"
    since = datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc)
    seed_docs(admin_db, [
        make_admin(boss), make_user(boss, ADMIN_EMAIL), make_user(uid, "T22@example.test"),
        make_user(other, "t22-o@example.test"), make_account_state(other, restriction=restriction(since=since, reason="spam")),
    ])
    app = create_app(settings_for(tmp_path), analyzer=never, engine_info_fn=lambda: ENGINE_INFO,
                     token_verifier=FakeVerifier(Clock()), admin_db=admin_db)
    get_services(app).last_login = lambda _uid: None
    app.state.admin_authz.clock = Clock()
    url = f"/api/admin/users/{uid}/deletion"

    def records(target: str) -> list[dict[str, Any]]:
        docs = admin_db.run_query("adminAudit", filters=[("targetUid", "==", target)])
        return sorted((d.data for d in docs), key=lambda r: r["at"])

    with TestClient(app) as client:
        assert client.post(url, json={"confirmEmail": "nope"}, headers=H(boss)).json()["code"] == "confirm_email_mismatch"
        assert client.post(url, json={"confirmEmail": "t22@EXAMPLE.test"}, headers=H(boss, 3600)).json()["code"] == "reauth_required"
        res = client.post(url, json={"confirmEmail": "t22@EXAMPLE.test"}, headers=H(boss))
        assert res.status_code == 200 and res.json()["status"] == "deletion_scheduled"
        stored = admin_db.get(f"adminAccounts/{uid}").data
        assert stored["deletion"]["purgeAfter"] and stored["restriction"]["reason"] == FIXED_REASON and stored["updatedAt"]
        assert client.post(url, json={"confirmEmail": "t22@example.test"}, headers=H(boss)).json()["code"] == "deletion_pending"
        assert client.delete(url, headers=H(boss)).json()["status"] == "normal"
        assert [(r["action"], r["outcome"]) for r in records(uid)] == [
            ("deletion_scheduled", "applied"), ("deletion_scheduled", "rejected"), ("deletion_cancelled", "applied")]

        other_url = f"/api/admin/users/{other}/deletion"
        assert client.post(other_url, json={"confirmEmail": "t22-o@example.test"}, headers=H(boss)).status_code == 200
        held = admin_db.get(f"adminAccounts/{other}").data
        assert held["deletion"]["priorRestriction"]["reason"] == "spam"
        assert client.delete(other_url, headers=H(boss)).json()["restriction"]["reason"] == "spam"
        restored = admin_db.get(f"adminAccounts/{other}").data["restriction"]
        assert restored["reason"] == "spam" and restored["since"].startswith("2026-10-01T09:00:00")
        assert not admin_db.get(f"adminAccounts/{other}").data.get("deletion")

"""restrictUser and unrestrictUser (docs/features/admin: AC-10b, AC-16, AC-17, AC-19, AC-23b, AC-33; ADR-0005,
ADR-0007; contracts/openapi.yaml ``/api/admin/users/{uid}/restriction``).

The tests run the real app (admin router, authz, audit writer, admission gate) over ``UsersDb``, an in-memory
Firestore that applies the real REST write bodies. The restriction is one Firestore transaction on
``adminAccounts/<uid>`` with its journal record in the same commit, so the tests count the commits and make the first
commit abort (contention) to see the transaction read again. ``fail_audit`` makes every journal write fail.
"""
from __future__ import annotations

import copy
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient

from admin.fixtures import (
    ACCOUNT_UID,
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
    make_tracks,
    make_user,
    never,
    restriction,
    seed_account,
    settings_for,
    snapshot,
    write_quota,
)
from app.admission import STATE_TTL_S, Admission
from app.admin.router import get_services
from app.firestore import Aborted, FirestoreIndex
from app.main import create_app
from app.quotas import QuotaExceeded
from app.sources import SourceError

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

UID = ACCOUNT_UID
URL = f"/api/admin/users/{UID}/restriction"
SELF_URL = f"/api/admin/users/{BOSS}/restriction"


def restrict(w: SimpleNamespace, reason: Any = REASON, url: str = URL, who: str = BOSS):
    return w.client.put(url, json={"reason": reason}, headers=H(who))


def lift(w: SimpleNamespace, url: str = URL, who: str = BOSS):
    return w.client.delete(url, headers=H(who))


# =========================================================================== AC-16: restrictUser


def test_restriction_is_stored_with_reason_since_and_admin_and_journaled_in_one_commit(world) -> None:
    w = world()
    seed_account(w)
    commits = counting(w)

    res = restrict(w)

    assert res.status_code == 200, res.text
    assert commits[0] == 1                                        # the state and its record: one commit
    body = res.json()
    assert body["uid"] == UID and body["status"] == "restricted" and body["deletion"] is None
    assert body["restriction"]["reason"] == REASON and body["restriction"]["byAdminUid"] == BOSS
    assert body["restriction"]["since"]
    stored = w.db.docs[f"adminAccounts/{UID}"]["restriction"]
    assert stored["reason"] == REASON and stored["byAdminUid"] == BOSS and stored["since"]
    [record] = journal(w)
    assert record["action"] == "restrict" and record["outcome"] == "applied" and record["rejectReason"] is None
    assert record["targetUid"] == UID and record["adminUid"] == BOSS and record["adminEmail"] == ADMIN_EMAIL
    assert record["before"] is None
    assert record["after"]["reason"] == REASON and record["after"]["since"] == stored["since"]


def test_the_card_shows_the_restricted_state_with_reason_and_date(world) -> None:
    w = world()
    seed_account(w)
    assert restrict(w).status_code == 200
    account = w.client.get(f"/api/admin/users/{UID}", headers=H(BOSS)).json()["account"]
    assert account["status"] == "restricted"
    assert account["restriction"]["reason"] == REASON and account["restriction"]["since"]


def test_the_reason_is_trimmed(world) -> None:
    w = world()
    seed_account(w)
    assert restrict(w, f"  {REASON}\n").json()["restriction"]["reason"] == REASON


def test_restricting_keeps_the_personal_limit_and_the_counters(world) -> None:
    w = world()
    seed_account(w, personal_limit={"analyses": 100, "setAt": SINCE, "byAdminUid": "someone"})
    write_quota(w, UID, analyses=12, vocals=3)
    assert restrict(w).status_code == 200
    assert w.db.docs[f"adminAccounts/{UID}"]["personalLimit"]["analyses"] == 100
    quotas = w.app.state.jobs.quotas
    assert quotas.usage(UID)["analyses"]["used"] == 12 and quotas.usage(UID)["vocals"]["used"] == 3


def test_restricting_again_changes_the_reason_and_journals_the_old_one(world) -> None:
    w = world()
    seed_account(w, restriction=restriction(reason="spam"))

    res = restrict(w, "bots")

    assert res.status_code == 200, res.text
    assert res.json()["restriction"]["reason"] == "bots" and res.json()["status"] == "restricted"
    [record] = journal(w)
    assert record["action"] == "restrict" and record["outcome"] == "applied"
    assert record["before"]["reason"] == "spam" and record["after"]["reason"] == "bots"


def test_a_restricted_users_new_cloud_jobs_are_refused_at_once_on_this_server(world) -> None:
    w = world()
    seed_account(w)
    admit(w)                                                      # the gate has cached "not restricted"
    assert restrict(w).status_code == 200
    for kind in ("analysis", "reanalysis", "vocals"):
        with pytest.raises(SourceError) as info:
            admit(w, kind)
        assert info.value.code == "cloud_restricted"


def test_another_server_instance_refuses_within_a_minute(world) -> None:
    """A second instance keeps its own cache of the account (60 s): it refuses by then, not before it must."""
    w = world()
    seed_account(w)
    mono = [1000.0]
    other = Admission(w.db, w.services.settings, monotonic=lambda: mono[0])
    quotas = w.app.state.jobs.quotas
    other.check(UID, "analysis", "file", running=0, quotas=quotas)   # cached: not restricted

    assert restrict(w).status_code == 200

    mono[0] += STATE_TTL_S + 1
    with pytest.raises(SourceError) as info:
        other.check(UID, "analysis", "file", running=0, quotas=quotas)
    assert info.value.code == "cloud_restricted"


def test_the_reason_never_reaches_the_user(world) -> None:
    w = world()
    secret = "secret-reason-for-admins-only"
    seed_account(w)
    assert restrict(w, secret).status_code == 200
    with pytest.raises(SourceError) as info:
        admit(w)
    assert secret not in str(info.value) and secret not in info.value.message
    # the client-owned profile and the library hold no trace of it
    for path, doc in w.db.docs.items():
        if path.startswith(("adminAccounts/", "adminAudit/")):
            continue
        assert secret not in repr(doc), path
    # and a person who is not an admin cannot read it from the admin API
    assert w.client.get(f"/api/admin/users/{UID}", headers=H(UID)).status_code == 404


# =========================================================================== AC-19: accepted jobs, lifting


def test_restricting_touches_only_the_account_state_and_the_journal(world) -> None:
    """Accepted jobs keep running: nothing about jobs, songs or counters is written or stopped by a restriction."""
    w = world()
    seed_account(w)
    w.db.put(*make_tracks(UID, 3))
    before = snapshot(w)
    assert restrict(w).status_code == 200
    changed = {p for p in w.db.docs if p not in before or w.db.docs[p] != before[p]}
    assert all(p.startswith(("adminAccounts/", "adminAudit/")) for p in changed), changed
    assert {p: d for p, d in w.db.docs.items() if p.startswith(f"users/{UID}")} == \
           {p: d for p, d in before.items() if p.startswith(f"users/{UID}")}


def test_lifting_restores_cloud_analysis_and_loses_nothing(world) -> None:
    w = world()
    seed_account(w, restriction=restriction())
    w.db.put(*make_tracks(UID, 3))
    library = {p: copy.deepcopy(d) for p, d in w.db.docs.items() if p.startswith(f"users/{UID}")}
    with pytest.raises(SourceError):
        admit(w)                                                  # restricted (and cached by the gate)

    res = lift(w)

    assert res.status_code == 200, res.text
    assert res.json()["status"] == "normal" and res.json()["restriction"] is None
    assert w.db.docs[f"adminAccounts/{UID}"].get("restriction") is None
    admit(w)                                                      # the next analysis is accepted
    assert {p: d for p, d in w.db.docs.items() if p.startswith(f"users/{UID}")} == library
    [record] = journal(w)
    assert record["action"] == "unrestrict" and record["outcome"] == "applied" and record["targetUid"] == UID
    assert record["before"]["reason"] == REASON and record["after"] is None


def test_lifting_keeps_the_personal_limit(world) -> None:
    w = world()
    seed_account(w, restriction=restriction(), personal_limit={"analyses": 100, "setAt": SINCE, "byAdminUid": "someone"})
    commits = counting(w)
    assert lift(w).status_code == 200
    assert commits[0] == 1
    assert w.db.docs[f"adminAccounts/{UID}"]["personalLimit"]["analyses"] == 100


def test_lifting_when_not_restricted_is_not_set_and_not_journaled(world) -> None:
    for account in ({}, {"restriction": None}):
        w = world()
        seed_account(w, **account)
        before, commits = snapshot(w), counting(w)

        res = lift(w)

        assert res.status_code == 409 and res.json()["code"] == "not_set"
        assert commits[0] == 0 and w.db.docs == before and not journal(w)


# =========================================================================== AC-17 / AC-10b: the admin's own account


def test_an_admin_cannot_restrict_their_own_account_and_the_attempt_is_journaled(world) -> None:
    w = world()
    before = snapshot(w)

    res = restrict(w, url=SELF_URL)

    assert res.status_code == 409 and res.json()["code"] == "self_target"
    assert "own account" in res.json()["detail"]
    assert f"adminAccounts/{BOSS}" not in w.db.docs
    assert {p: d for p, d in w.db.docs.items() if not p.startswith("adminAudit/")} == before
    [record] = journal(w)
    assert record["action"] == "restrict" and record["outcome"] == "rejected" and record["rejectReason"] == "self_target"
    assert record["adminUid"] == BOSS and record["targetUid"] == BOSS and record["adminEmail"] == ADMIN_EMAIL
    assert record["before"] is None and record["after"] is None


def test_the_journal_shows_the_search_the_card_view_and_the_refused_attempt(world) -> None:
    w = world()
    seed_account(w)
    assert w.get("/api/admin/users", params={"q": "ivan"}).status_code == 200
    assert w.get(f"/api/admin/users/{UID}").status_code == 200
    assert restrict(w, url=SELF_URL).status_code == 409

    items = w.get("/api/admin/audit").json()["items"]

    assert [(i["action"], i["outcome"]) for i in items] == [
        ("restrict", "rejected"), ("view_card", "applied"), ("search", "applied"),
    ]
    assert items[0]["rejectReason"] == "self_target" and items[0]["targetUid"] == BOSS
    assert items[1]["targetUid"] == UID and items[2]["query"] == "ivan"


# =========================================================================== AC-23b: a scheduled deletion


@pytest.mark.parametrize("call", [restrict, lift], ids=["restrict", "unrestrict"])
def test_restriction_changes_are_refused_while_deletion_is_scheduled_and_journaled(world, call: Callable) -> None:
    w = world()
    held = restriction(reason="deletion scheduled", since=SCHEDULED)
    seed_account(w, restriction=held, deletion=deletion(None))
    before, commits = snapshot(w), counting(w)

    res = call(w)

    assert res.status_code == 409 and res.json()["code"] == "deletion_pending"
    assert "deletion" in res.json()["detail"]
    assert commits[0] == 1                                        # only the journal record
    assert {p: d for p, d in w.db.docs.items() if not p.startswith("adminAudit/")} == before
    [record] = journal(w)
    assert record["action"] == ("restrict" if call is restrict else "unrestrict")
    assert record["outcome"] == "rejected" and record["rejectReason"] == "deletion_pending" and record["targetUid"] == UID


def test_a_deletion_scheduled_meanwhile_is_seen_when_the_transaction_runs_again(world) -> None:
    """Contention aborts the first commit; the retry reads the account again, finds the deletion and refuses."""
    w = world()
    seed_account(w)
    real = w.db.commit
    calls: list[int] = []

    def contended(writes, *, transaction=None):
        if transaction is not None and not calls:
            calls.append(1)
            w.db.put(make_account_state(UID, restriction=restriction(), deletion=deletion(None)))
            raise Aborted("another writer got there first")
        real(writes, transaction=transaction)

    w.db.commit = contended  # type: ignore[method-assign]

    res = restrict(w)

    assert res.status_code == 409 and res.json()["code"] == "deletion_pending"
    assert w.db.docs[f"adminAccounts/{UID}"]["restriction"]["reason"] == REASON    # still the one the deletion set
    assert [r["outcome"] for r in journal(w)] == ["rejected"]


def test_an_aborted_commit_is_retried_and_journaled_once(world) -> None:
    w = world()
    seed_account(w)
    real = w.db.commit
    attempts: list[int] = []

    def contended(writes, *, transaction=None):
        if transaction is not None and not attempts:
            attempts.append(1)
            raise Aborted("another writer got there first")
        real(writes, transaction=transaction)

    w.db.commit = contended  # type: ignore[method-assign]

    res = restrict(w)

    assert res.status_code == 200, res.text
    [record] = journal(w)
    assert record["action"] == "restrict" and record["outcome"] == "applied"
    assert w.db.docs[f"adminAccounts/{UID}"]["restriction"]["reason"] == REASON


# =========================================================================== AC-10b: form errors are not journaled


@pytest.mark.parametrize("body", [{}, {"reason": ""}, {"reason": "   "}, {"reason": "x" * 501}, {"reason": 5}, {"why": "x"}])
def test_an_invalid_reason_is_not_saved_and_not_journaled(world, body: dict) -> None:
    w = world()
    seed_account(w)
    before, commits = snapshot(w), counting(w)

    res = w.client.put(URL, json=body, headers=H(BOSS))

    assert res.status_code == 422 and res.json()["code"] == "invalid_value"
    assert commits[0] == 0 and w.db.docs == before and not journal(w)


def test_the_longest_reason_is_accepted(world) -> None:
    w = world()
    seed_account(w)
    assert restrict(w, "я" * 500).status_code == 200


# =========================================================================== AC-33: journal first


@pytest.mark.parametrize("account, call", [
    ({}, restrict),
    ({"restriction": restriction()}, lift),
], ids=["restrict", "unrestrict"])
def test_a_failed_journal_write_leaves_the_state_unchanged(world, account: dict, call: Callable) -> None:
    w = world()
    seed_account(w, **account)
    before = snapshot(w)
    w.db.fail_audit = True

    res = call(w)

    assert res.status_code == 503 and res.json()["code"] == "not_applied"
    assert w.db.docs == before and not journal(w)
    w.db.fail_audit = False
    assert call(w).status_code == 200                              # and a retry works


def test_a_user_the_admin_restricted_without_a_journal_is_still_admitted(world) -> None:
    w = world()
    seed_account(w)
    w.db.fail_audit = True
    assert restrict(w).status_code == 503
    admit(w)                                                       # nothing changed: the user is not refused


def test_a_refused_attempt_that_cannot_be_journaled_is_not_applied(world) -> None:
    w = world()
    w.db.fail_audit = True
    res = restrict(w, url=SELF_URL)
    assert res.status_code == 503 and res.json()["code"] == "not_applied"
    assert not journal(w)


def test_a_database_that_fails_while_reading_is_not_applied(world) -> None:
    w = world()
    seed_account(w)
    before = snapshot(w)
    from app.firestore import IndexError_

    def down(path: str, body: dict) -> Any:
        raise IndexError_("Firestore is down", retryable=True)

    w.db._post = down  # the transaction cannot even begin
    res = restrict(w)
    assert res.status_code == 503 and res.json()["code"] == "not_applied"
    assert w.db.docs == before


# =========================================================================== who and what


@pytest.mark.parametrize("call", [restrict, lift], ids=["restrict", "unrestrict"])
def test_an_unknown_user_is_a_404_and_leaves_no_record(world, call: Callable) -> None:
    w = world()
    res = call(w, url="/api/admin/users/nobody/restriction")
    assert res.status_code == 404 and res.json()["code"] == "not_found" and res.json()["detail"] == "User not found"
    assert not journal(w) and "adminAccounts/nobody" not in w.db.docs


@pytest.mark.parametrize("call", [restrict, lift], ids=["restrict", "unrestrict"])
def test_a_non_admin_cannot_change_a_restriction(world, call: Callable) -> None:
    w = world()
    seed_account(w, restriction=restriction())
    before = snapshot(w)
    res = call(w, who="mallory")
    assert res.status_code == 404
    assert w.db.docs == before and not journal(w)


def test_a_purged_user_is_a_404(world) -> None:
    w = world()
    seed_account(w)
    w.db.docs[f"adminTombstones/{UID}"] = {"purgedAt": "2026-10-01T00:00:00Z"}
    res = restrict(w)
    assert res.status_code == 404 and not journal(w)


def test_restricting_one_user_leaves_the_others_alone(world) -> None:
    w = world()
    seed_account(w)
    seed_account(w, "u2")
    assert restrict(w).status_code == 200
    admit(w, uid="u2")
    assert "restriction" not in (w.db.docs.get("adminAccounts/u2") or {})


def test_the_day_counters_are_not_touched_by_lifting(world) -> None:
    w = world()
    seed_account(w, restriction=restriction())
    write_quota(w, UID, analyses=40, vocals=0)
    assert lift(w).status_code == 200
    with pytest.raises(QuotaExceeded):
        admit(w)                                                   # lifting is not a quota reset: 40 of 40 is still spent


# =========================================================================== the Firestore emulator (when there is one)


def test_emulator_restriction_is_a_real_transaction_with_its_journal_record(admin_db: FirestoreIndex, tmp_path: Path) -> None:
    from admin.fixtures import make_admin, seed as seed_docs

    boss, uid, scheduled = "t21-boss", "t21-user", "t21-scheduled"
    seed_docs(admin_db, [
        make_admin(boss), make_user(boss, ADMIN_EMAIL), make_user(uid, "t21@example.test"),
        make_user(scheduled, "t21-s@example.test"),
        make_account_state(scheduled, restriction=restriction(), deletion=deletion(restriction())),
    ])
    app = create_app(settings_for(tmp_path), analyzer=never, engine_info_fn=lambda: ENGINE_INFO,
                     token_verifier=FakeVerifier(Clock()), admin_db=admin_db)
    get_services(app).last_login = lambda _uid: None
    url = f"/api/admin/users/{uid}/restriction"

    def records(target: str) -> list[dict[str, Any]]:
        docs = admin_db.run_query("adminAudit", filters=[("targetUid", "==", target)])
        return sorted((d.data for d in docs), key=lambda r: r["at"])

    with TestClient(app) as client:
        assert client.put(url, json={"reason": REASON}, headers=H(boss)).json()["status"] == "restricted"
        stored = admin_db.get(f"adminAccounts/{uid}").data
        assert stored["restriction"]["reason"] == REASON and stored["restriction"]["byAdminUid"] == boss
        assert stored["restriction"]["since"] and stored["updatedAt"]
        with pytest.raises(SourceError) as info:
            app.state.admission.check(uid, "analysis", "file", running=0, quotas=app.state.jobs.quotas)
        assert info.value.code == "cloud_restricted"

        res = client.delete(url, headers=H(boss))
        assert res.status_code == 200 and res.json()["status"] == "normal"
        assert not admin_db.get(f"adminAccounts/{uid}").data.get("restriction")
        assert client.delete(url, headers=H(boss)).json()["code"] == "not_set"
        assert [(r["action"], r["outcome"]) for r in records(uid)] == [("restrict", "applied"), ("unrestrict", "applied")]

        for call in (client.put, client.delete):
            kwargs = {"json": {"reason": "again"}} if call == client.put else {}
            res = call(f"/api/admin/users/{scheduled}/restriction", headers=H(boss), **kwargs)
            assert res.status_code == 409 and res.json()["code"] == "deletion_pending"
        assert [(r["action"], r["outcome"], r["rejectReason"]) for r in records(scheduled)] == [
            ("restrict", "rejected", "deletion_pending"), ("unrestrict", "rejected", "deletion_pending"),
        ]
        assert client.put(f"/api/admin/users/{boss}/restriction", json={"reason": "me"}, headers=H(boss)).json()["code"] == "self_target"
        assert [(r["action"], r["outcome"], r["rejectReason"]) for r in records(boss)] == [("restrict", "rejected", "self_target")]

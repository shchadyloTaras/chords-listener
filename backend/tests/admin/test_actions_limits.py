"""resetQuota, setPersonalLimit and removePersonalLimit (docs/features/admin: AC-12, AC-12b, AC-13, AC-14, AC-15, AC-33;
ADR-0007; contracts/openapi.yaml ``/api/admin/users/{uid}/quota/reset`` and ``/limit``).

The tests run the real app (admin router, authz, audit writer, admission gate, quotas over a real ``quota.json``)
over ``UsersDb``, an in-memory Firestore that applies the real REST write bodies. They count the commits, so "one
batched write with its audit record" is checked, not assumed; ``fail_audit`` makes every journal write fail.
"""
from __future__ import annotations

import calendar
import json
import threading
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from admin.fixtures import ADMIN_EMAIL, make_account_state, make_user
from admin.test_api_users import BOSS, H, utc_today, world, write_quota  # noqa: F401  (``world`` is a fixture)
from app import quotas as quotas_module
from app.admin import actions
from app.quotas import QuotaExceeded
from app.sources import SourceError

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

UID = "u1"
RESET_URL = f"/api/admin/users/{UID}/quota/reset"
LIMIT_URL = f"/api/admin/users/{UID}/limit"


def seed(w: SimpleNamespace, uid: str = UID, **account: Any) -> None:
    w.db.put(make_user(uid, "Ivan.P@example.test", created_at=datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc)))
    if account:
        w.db.put(make_account_state(uid, **account))


def counting(w: SimpleNamespace) -> list[int]:
    """A one-element list that holds the number of commits made so far."""
    n = [0]
    real = w.db.commit

    def commit(writes, *, transaction=None):
        real(writes, transaction=transaction)
        n[0] += 1

    w.db.commit = commit  # type: ignore[method-assign]
    return n


def post(w: SimpleNamespace, url: str = RESET_URL, who: str = BOSS):
    return w.client.post(url, headers=H(who))


def put_limit(w: SimpleNamespace, body: Any, url: str = LIMIT_URL):
    return w.client.put(url, json=body, headers=H(BOSS))


def delete_limit(w: SimpleNamespace, url: str = LIMIT_URL):
    return w.client.delete(url, headers=H(BOSS))


def quotas(w: SimpleNamespace):
    return w.app.state.jobs.quotas


def admit(w: SimpleNamespace, kind: str = "analysis", *, uid: str = UID, running: int = 0) -> None:
    w.app.state.admission.check(uid, kind, "file", running=running, quotas=quotas(w))


def used(w: SimpleNamespace, kind: str = "analyses", uid: str = UID) -> int:
    return quotas(w).usage(uid)[kind]["used"]


def stored_quota(w: SimpleNamespace, uid: str = UID) -> dict[str, Any]:
    return json.loads((w.app.state.store.user_dir(uid) / "quota.json").read_text())


def journal(w: SimpleNamespace) -> list[dict[str, Any]]:
    return w.db.audit_docs()


def end_of_month() -> date:
    today = utc_today()
    return today.replace(day=calendar.monthrange(today.year, today.month)[1])


# =========================================================================== AC-12: resetQuota


def test_quota_reset_zeroes_both_counters_and_keeps_running_job_in_concurrency(world) -> None:
    w = world()
    seed(w)
    write_quota(w, UID, analyses=40, vocals=5)
    w.app.state.jobs.running_count = lambda uid=None: 1 if uid == UID else 0   # one job is running right now
    with pytest.raises(QuotaExceeded):
        admit(w, running=1)                                                     # 40 of 40: spent

    res = post(w)

    assert res.status_code == 200, res.text
    quota = res.json()["quota"]
    assert quota["analyses"] == {"used": 0, "limit": 40} and quota["vocals"] == {"used": 0, "limit": 15}
    assert quota["jobs"] == {"used": 1, "limit": 2}                             # the running job still counts
    assert stored_quota(w)["analyses"] == 0 and stored_quota(w)["vocals"] == 0
    admit(w, running=1)                                                         # a new analysis is accepted at once
    assert used(w) == 1
    with pytest.raises(SourceError) as info:                                    # ... and the limit of parallel jobs holds
        admit(w, running=2)
    assert "in progress" in str(info.value)
    [record] = journal(w)
    assert record["action"] == "quota_reset" and record["outcome"] == "applied"
    assert record["targetUid"] == UID and record["adminUid"] == BOSS and record["adminEmail"] == ADMIN_EMAIL
    assert record["before"] == {"analyses": 40, "vocals": 5}                    # the old values of both counters
    assert record["after"] == {"analyses": 0, "vocals": 0}


def test_a_reset_leaves_other_users_alone(world) -> None:
    w = world()
    seed(w)
    seed(w, "u2")
    write_quota(w, UID, analyses=3, vocals=1)
    write_quota(w, "u2", analyses=7, vocals=2)
    assert post(w).status_code == 200
    assert used(w, uid="u2") == 7 and used(w, "vocals", uid="u2") == 2


def test_a_repeated_reset_is_harmless_and_writes_a_second_journal_record(world) -> None:
    w = world()
    seed(w)
    write_quota(w, UID, analyses=2, vocals=1)
    assert post(w).status_code == 200
    assert post(w).status_code == 200
    first, second = journal(w)
    assert first["before"] == {"analyses": 2, "vocals": 1}
    assert second["before"] == {"analyses": 0, "vocals": 0}
    assert used(w) == 0


def test_resetting_an_unknown_user_is_a_404_and_leaves_no_record(world) -> None:
    w = world()
    res = post(w, "/api/admin/users/nobody/quota/reset")
    assert res.status_code == 404 and res.json()["code"] == "not_found" and res.json()["detail"] == "User not found"
    assert not journal(w)


def test_a_non_admin_cannot_reset_a_quota(world) -> None:
    w = world()
    seed(w)
    write_quota(w, UID, analyses=5, vocals=0)
    res = post(w, who="mallory")
    assert res.status_code == 404
    assert used(w) == 5 and not journal(w)


# =========================================================================== AC-12b: reset against a concurrent admission


def test_quota_reset_and_concurrent_admission_never_lose_an_analysis(world, monkeypatch) -> None:
    """Many analyses are admitted while a reset runs: whatever the interleaving, the use of the quota ends equal to
    the analyses admitted after the reset (what ``quota.json`` says too)."""
    w = world()
    seed(w)
    write_quota(w, UID, analyses=5, vocals=0)
    q = quotas(w)
    order: list[int] = []    # the analyses counter as written to quota.json, in lock order; 0 is the reset
    real_write = quotas_module.write_json_atomic

    def spy_write(path, data):
        order.append(data["analyses"])
        real_write(path, data)

    monkeypatch.setattr(quotas_module, "write_json_atomic", spy_write)
    start = threading.Barrier(9)
    errors: list[Exception] = []

    def admit_three() -> None:
        start.wait()
        for _ in range(3):
            admit(w)

    def reset() -> None:
        start.wait()
        try:
            actions.reset_quota(w.services, q, admin_uid=BOSS, admin_email=ADMIN_EMAIL, uid=UID)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=admit_three) for _ in range(8)] + [threading.Thread(target=reset)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(15)

    assert not errors
    resets = [i for i, v in enumerate(order) if v == 0]
    assert len(resets) == 1 and len(order) == 24 + 1
    after_reset = len(order) - 1 - resets[0]
    assert used(w) == after_reset
    assert stored_quota(w)["analyses"] == after_reset
    [record] = journal(w)
    assert record["before"]["analyses"] == 5 + resets[0]       # the 5 it started with plus those admitted before it


def test_an_analysis_admitted_while_the_reset_is_journaled_is_counted_after_it(world) -> None:
    """The journal record is written under the lock admission takes, so an admission that arrives meanwhile waits and
    lands after the reset: the reset neither loses it nor erases it."""
    w = world()
    seed(w)
    write_quota(w, UID, analyses=10, vocals=0)
    inside, release, admitted = threading.Event(), threading.Event(), threading.Event()
    real_commit = w.db.commit

    def slow_commit(writes, *, transaction=None):
        if any("/adminAudit/" in x.get("update", {}).get("name", "") for x in writes):
            inside.set()
            assert release.wait(10)
        real_commit(writes, transaction=transaction)

    w.db.commit = slow_commit  # type: ignore[method-assign]
    result: dict[str, Any] = {}
    resetter = threading.Thread(target=lambda: result.update(res=post(w)))
    resetter.start()
    assert inside.wait(10)

    def late_admission() -> None:
        admit(w)
        admitted.set()

    admitter = threading.Thread(target=late_admission)
    admitter.start()
    assert not admitted.wait(0.5), "the admission must wait for the reset"
    release.set()
    resetter.join(10)
    admitter.join(10)

    assert result["res"].status_code == 200
    assert admitted.is_set()
    assert used(w) == 1                                  # exactly the analysis accepted after the reset
    assert stored_quota(w)["analyses"] == 1
    [record] = journal(w)
    assert record["before"]["analyses"] == 10


# =========================================================================== AC-33: journal first for the reset


def test_a_failed_journal_write_leaves_the_counters_unchanged(world) -> None:
    w = world()
    seed(w)
    write_quota(w, UID, analyses=40, vocals=5)
    before = (used(w), used(w, "vocals"))
    w.db.fail_audit = True

    res = post(w)

    assert res.status_code == 503 and res.json()["code"] == "not_applied"
    assert (used(w), used(w, "vocals")) == before == (40, 5)
    assert stored_quota(w)["analyses"] == 40 and stored_quota(w)["vocals"] == 5
    assert not journal(w)
    w.db.fail_audit = False
    assert post(w).status_code == 200                    # and a retry works
    assert used(w) == 0


def test_a_failed_quota_write_keeps_the_counters_and_leaves_a_not_applied_follow_up(world, monkeypatch) -> None:
    w = world()
    seed(w)
    write_quota(w, UID, analyses=40, vocals=5)

    def broken(path, data):
        raise OSError("disk full")

    monkeypatch.setattr(quotas_module, "write_json_atomic", broken)

    res = post(w)

    assert res.status_code == 503 and res.json()["code"] == "not_applied"
    assert used(w) == 40 and used(w, "vocals") == 5      # what the user is held to did not change
    first, follow_up = journal(w)
    assert first["outcome"] == "applied" and first["action"] == "quota_reset"
    assert follow_up["outcome"] == "not_applied" and follow_up["action"] == "quota_reset"
    assert follow_up["targetUid"] == UID and follow_up["refId"]
    assert follow_up["refId"] in {p.split("/", 1)[1] for p in w.db.docs if p.startswith("adminAudit/")}


# =========================================================================== AC-13: setPersonalLimit


def test_personal_limit_lets_the_user_run_up_to_100_analyses(world) -> None:
    w = world()
    seed(w)
    write_quota(w, UID, analyses=40, vocals=0)
    with pytest.raises(QuotaExceeded):
        admit(w)                                          # the default limit 40 is spent (and cached by the gate)
    commits = counting(w)
    until = end_of_month()

    res = put_limit(w, {"analyses": 100, "until": until.isoformat()})

    assert res.status_code == 200, res.text
    assert commits[0] == 1                                 # the limit and its journal record: one batched write
    account = res.json()
    assert account["status"] == "normal"
    limit = account["personalLimit"]
    assert limit["analyses"] == 100 and limit["vocals"] is None and limit["jobs"] is None
    assert limit["until"] == until.isoformat() and limit["expired"] is False and limit["byAdminUid"] == BOSS
    assert account["quota"]["analyses"] == {"used": 40, "limit": 100}
    assert account["quota"]["vocals"]["limit"] == 15 and account["quota"]["jobs"]["limit"] == 2   # still the defaults
    stored = w.db.docs[f"adminAccounts/{UID}"]["personalLimit"]
    assert stored["analyses"] == 100 and stored["until"] == until.isoformat() and stored["byAdminUid"] == BOSS
    assert "vocals" not in stored and "jobs" not in stored       # a number that is not set is absent: it follows the default
    for _ in range(60):                                    # the 41st ... 100th analysis are accepted at once
        admit(w)
    assert used(w) == 100
    with pytest.raises(QuotaExceeded):                     # the 101st is not
        admit(w)
    [record] = journal(w)
    assert record["action"] == "limit_set" and record["outcome"] == "applied" and record["targetUid"] == UID
    assert record["before"] is None
    assert record["after"] == {"analyses": 100, "vocals": None, "jobs": None, "until": until.isoformat()}


def test_the_card_shows_the_new_limit_and_its_end_date(world) -> None:
    w = world()
    seed(w)
    until = end_of_month()
    assert put_limit(w, {"analyses": 100, "until": until.isoformat()}).status_code == 200
    card = w.client.get(f"/api/admin/users/{UID}", headers=H(BOSS)).json()["account"]
    assert card["personalLimit"]["analyses"] == 100 and card["personalLimit"]["until"] == until.isoformat()
    assert card["quota"]["analyses"]["limit"] == 100


def test_setting_a_limit_replaces_the_whole_previous_one(world) -> None:
    w = world()
    until = utc_today() + timedelta(days=3)
    seed(w, personal_limit={"analyses": 5, "jobs": 3, "until": until.isoformat(),
                            "setAt": datetime(2026, 10, 1, tzinfo=timezone.utc), "byAdminUid": "someone"})

    res = put_limit(w, {"vocals": 9})

    assert res.status_code == 200, res.text
    stored = w.db.docs[f"adminAccounts/{UID}"]["personalLimit"]
    assert stored["vocals"] == 9 and "analyses" not in stored and "jobs" not in stored and "until" not in stored
    assert stored["byAdminUid"] == BOSS
    assert res.json()["personalLimit"]["until"] is None
    assert res.json()["quota"]["analyses"]["limit"] == 40            # follows the default again
    [record] = journal(w)
    assert record["before"] == {"analyses": 5, "vocals": None, "jobs": 3, "until": until.isoformat()}
    assert record["after"] == {"analyses": None, "vocals": 9, "jobs": None, "until": None}


def test_setting_a_limit_keeps_the_restriction_and_the_deletion_of_the_account(world) -> None:
    w = world()
    restriction = {"reason": "abuse", "since": datetime(2026, 10, 1, tzinfo=timezone.utc), "byAdminUid": "someone"}
    seed(w, restriction=restriction)
    assert put_limit(w, {"analyses": 7}).status_code == 200
    doc = w.db.docs[f"adminAccounts/{UID}"]
    assert doc["restriction"]["reason"] == "abuse" and doc["personalLimit"]["analyses"] == 7


# =========================================================================== AC-14: invalid personal limit


@pytest.mark.parametrize("body", [
    {},
    {"until": "2099-01-01"},
    {"analyses": 1.5},
    {"analyses": "40"},
    {"analyses": 0},
    {"analyses": 1001},
    {"vocals": 0},
    {"vocals": 151},
    {"jobs": 0},
    {"jobs": 5},
    {"analyses": 10, "until": (utc_today() - timedelta(days=1)).isoformat()},
    {"analyses": 10, "until": "not a date"},
])
def test_invalid_personal_limit_is_not_saved(world, body: dict) -> None:
    w = world()
    seed(w)
    before = {k: dict(v) for k, v in w.db.docs.items()}
    commits = counting(w)

    res = put_limit(w, body)

    assert res.status_code == 422 and res.json()["code"] == "invalid_value"
    assert res.json()["details"]                          # each field says what is allowed
    assert commits[0] == 0
    assert w.db.docs == before                            # the limit is not changed ...
    assert not journal(w)                                 # ... and a form error is never journaled (AC-10b)


@pytest.mark.parametrize("body", [
    {"analyses": 1}, {"analyses": 1000}, {"vocals": 1}, {"vocals": 150}, {"jobs": 1}, {"jobs": 4},
    {"analyses": 10, "until": utc_today().isoformat()}, {"analyses": 10, "until": None},
])
def test_the_range_limits_and_today_are_accepted(world, body: dict) -> None:
    w = world()
    seed(w)
    assert put_limit(w, body).status_code == 200


# =========================================================================== AC-15: the end date


def test_expired_personal_limit_falls_back_to_default_and_card_shows_it_ended(world) -> None:
    w = world()
    yesterday = utc_today() - timedelta(days=1)
    seed(w, personal_limit={"analyses": 100, "until": yesterday.isoformat(),
                            "setAt": datetime(2026, 9, 1, tzinfo=timezone.utc), "byAdminUid": BOSS})
    write_quota(w, UID, analyses=40, vocals=0)

    with pytest.raises(QuotaExceeded):
        admit(w)                                          # the 41st analysis today is refused: the default 40 applies

    account = w.client.get(f"/api/admin/users/{UID}", headers=H(BOSS)).json()["account"]
    assert account["personalLimit"]["expired"] is True
    assert account["quota"]["analyses"] == {"used": 40, "limit": 40}


def test_the_last_day_still_counts_as_in_force(world) -> None:
    w = world()
    seed(w)
    write_quota(w, UID, analyses=40, vocals=0)
    assert put_limit(w, {"analyses": 100, "until": utc_today().isoformat()}).json()["personalLimit"]["expired"] is False
    admit(w)                                              # today is the last day: 100 applies
    assert used(w) == 41


# =========================================================================== removePersonalLimit


def test_removing_the_limit_is_one_batched_write_with_its_record(world) -> None:
    w = world()
    until = end_of_month()
    seed(w, personal_limit={"analyses": 100, "until": until.isoformat(),
                            "setAt": datetime(2026, 10, 1, tzinfo=timezone.utc), "byAdminUid": "someone"})
    write_quota(w, UID, analyses=40, vocals=0)
    admit(w)                                              # the gate caches the personal limit (100)
    commits = counting(w)

    res = delete_limit(w)

    assert res.status_code == 200, res.text
    assert commits[0] == 1
    assert res.json()["personalLimit"] is None
    assert res.json()["quota"]["analyses"]["limit"] == 40
    assert w.db.docs[f"adminAccounts/{UID}"].get("personalLimit") is None
    with pytest.raises(QuotaExceeded):                    # in force at once: the default 40 applies again
        admit(w)
    [record] = journal(w)
    assert record["action"] == "limit_removed" and record["outcome"] == "applied" and record["targetUid"] == UID
    assert record["before"] == {"analyses": 100, "vocals": None, "jobs": None, "until": until.isoformat()}
    assert record["after"] is None


@pytest.mark.parametrize("account", [{}, {"personal_limit": None}])
def test_removing_when_no_limit_is_set_is_not_set_and_not_journaled(world, account: dict) -> None:
    w = world()
    seed(w, **account)
    before = {k: dict(v) for k, v in w.db.docs.items()}
    commits = counting(w)

    res = delete_limit(w)

    assert res.status_code == 409 and res.json()["code"] == "not_set"
    assert commits[0] == 0 and w.db.docs == before and not journal(w)


# =========================================================================== AC-33: journal first for the limits


def test_failed_audit_write_leaves_the_limit_unchanged(world) -> None:
    w = world()
    seed(w)
    before = {k: dict(v) for k, v in w.db.docs.items()}
    w.db.fail_audit = True

    res = put_limit(w, {"analyses": 100})

    assert res.status_code == 503 and res.json()["code"] == "not_applied"
    assert w.db.docs == before and not journal(w)
    write_quota(w, UID, analyses=40, vocals=0)
    with pytest.raises(QuotaExceeded):
        admit(w)                                          # the user is not let through on a change that was not applied


def test_failed_audit_write_leaves_the_limit_in_place_on_removal(world) -> None:
    w = world()
    seed(w, personal_limit={"analyses": 100, "setAt": datetime(2026, 10, 1, tzinfo=timezone.utc), "byAdminUid": "someone"})
    before = {k: dict(v) for k, v in w.db.docs.items()}
    w.db.fail_audit = True

    res = delete_limit(w)

    assert res.status_code == 503 and res.json()["code"] == "not_applied"
    assert w.db.docs == before


@pytest.mark.parametrize("call", [
    lambda w: put_limit(w, {"analyses": 100}, "/api/admin/users/nobody/limit"),
    lambda w: delete_limit(w, "/api/admin/users/nobody/limit"),
])
def test_an_unknown_user_is_a_404_and_leaves_no_record(world, call) -> None:
    w = world()
    res = call(w)
    assert res.status_code == 404 and res.json()["code"] == "not_found" and res.json()["detail"] == "User not found"
    assert not journal(w) and "adminAccounts/nobody" not in w.db.docs


def test_a_non_admin_cannot_change_a_limit(world) -> None:
    w = world()
    seed(w)
    res = w.client.put(LIMIT_URL, json={"analyses": 100}, headers=H("mallory"))
    assert res.status_code == 404
    assert f"adminAccounts/{UID}" not in w.db.docs and not journal(w)


def test_a_limit_change_does_not_touch_the_counters(world) -> None:
    w = world()
    seed(w)
    write_quota(w, UID, analyses=12, vocals=3)
    assert put_limit(w, {"analyses": 50}).status_code == 200
    assert delete_limit(w).status_code == 200
    assert (used(w), used(w, "vocals")) == (12, 3)

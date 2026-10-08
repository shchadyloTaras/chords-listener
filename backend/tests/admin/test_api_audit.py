"""GET /api/admin/audit - the journal list (docs/features/admin: AC-10, AC-10b, AC-11; ADR-0007; data-model Aggregate 4).

Offline: ``FakeDb`` is the shared in-memory Firestore (``MemDb``), made read-only: it counts the documents it hands out. The tests at the bottom run the same list on the Firestore emulator (only when
FIRESTORE_EMULATOR_HOST is set).
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from admin.fixtures import ADMIN_EMAIL, MemDb, Seed, make_admin, make_audit, make_user, seed
from app.admin.audit import Audit, AuditEntry
from app.admin.authz import AdminAuthz
from app.admin.router import router as admin_router
from app.firestore import FirestoreIndex
from app.main import create_app
from app.models import Settings

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

ENGINE_INFO = {"name": "fake", "version": "1.0", "features": {}}
T0 = datetime(2026, 10, 7, 12, 0, 0, tzinfo=timezone.utc)
ADMIN = "admin-1"
OTHER_ADMIN = "admin-2"
VICTIM = "u-victim"
PURGED = "u-purged"
HEADERS = {"Authorization": f"Bearer tok-{ADMIN}"}
AUDIT_URL = "/api/admin/audit"
CONTRACT = Path(__file__).resolve().parents[3] / "docs" / "features" / "admin" / "contracts" / "openapi.yaml"


def minutes(n: int) -> datetime:
    return T0 + timedelta(minutes=n)


# --------------------------------------------------------------------------- fakes


class FakeDb(MemDb):
    """The shared ``MemDb`` for a read-only API: a commit is counted and refused."""

    def commit(self, writes: list[dict[str, Any]], *, transaction: Optional[str] = None) -> None:
        self.commits += 1
        raise AssertionError("listing the journal must not write anything")


class FakeVerifier:
    def verify_claims(self, token: str) -> tuple[str, Optional[float]]:
        return token[4:], 0.0

    def verify(self, token: str) -> str:
        return token[4:]


def build_client(tmp_path: Path, db: FirestoreIndex) -> TestClient:
    settings = Settings(
        data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist", auth="firebase",
        signing_key="test-signing-key-0123456789abcdef", publish=False, allowed_hosts=("testserver", "localhost"),
    )
    app = create_app(
        settings, analyzer=lambda *a, **k: {}, engine_info_fn=lambda: ENGINE_INFO, token_verifier=FakeVerifier(),
        admin_db=db, admin_authz=AdminAuthz(db),
    )
    client = TestClient(app)
    client.__enter__()
    return client


def index_shard(emails: dict[str, str]) -> Seed:
    return Seed("adminEmailIndex/s000", {
        "entries": emails, "count": len(emails), "syncedThrough": T0 + timedelta(days=1), "fullSyncAt": T0,
    })


def tombstone(uid: str) -> Seed:
    return Seed(f"adminTombstones/{uid}", {
        "status": "done", "purgeAfter": T0, "startedAt": T0, "doneAt": T0 + timedelta(minutes=1),
    })


@pytest.fixture
def db() -> FakeDb:
    d = FakeDb()
    d.put_all([
        make_admin(ADMIN),
        index_shard({VICTIM: "victim@example.test", "u-other": "other@example.test"}),
    ])
    return d


@pytest.fixture
def client(tmp_path: Path, db: FakeDb):
    c = build_client(tmp_path, db)
    yield c
    c.__exit__(None, None, None)


def listed(client: TestClient, **params: Any) -> dict[str, Any]:
    res = client.get(AUDIT_URL, params=params, headers=HEADERS)
    assert res.status_code == 200, res.text
    return res.json()


# --------------------------------------------------------------------------- AC-10: newest first, who/when/target/before/after


def test_audit_list_shows_actions_newest_first_with_who_when_target_before_and_after(db: FakeDb, client: TestClient) -> None:
    db.put_all([
        make_audit("quota_reset", target_uid=VICTIM, at=minutes(1), before={"analyses": 40, "vocals": 5},
                   after={"analyses": 0, "vocals": 0}),
        make_audit("defaults_changed", admin_uid=OTHER_ADMIN, at=minutes(2), setting="limits",
                   before={"analyses": 40}, after={"analyses": 60}),
    ])
    page = listed(client)
    assert [e["action"] for e in page["items"]] == ["defaults_changed", "quota_reset"]  # newest first
    newest, oldest = page["items"]
    assert newest["adminUid"] == OTHER_ADMIN and newest["adminEmail"] == ADMIN_EMAIL
    assert newest["at"].startswith("2026-10-07T12:02:00")
    assert newest["setting"] == "limits" and newest["targetUid"] is None and newest["targetEmail"] is None
    assert newest["targetDeleted"] is False
    assert newest["before"] == {"analyses": 40} and newest["after"] == {"analyses": 60}
    assert oldest["adminUid"] == ADMIN and oldest["targetUid"] == VICTIM
    assert oldest["targetEmail"] == "victim@example.test" and oldest["targetDeleted"] is False
    assert oldest["before"] == {"analyses": 40, "vocals": 5} and oldest["after"] == {"analyses": 0, "vocals": 0}
    assert oldest["outcome"] == "applied" and oldest["id"]
    assert page == {**page, "hasNext": False, "hasPrev": False, "nextCursor": None}


def test_audit_entry_has_exactly_the_contract_fields(db: FakeDb, client: TestClient) -> None:
    db.put_all([make_audit("quota_reset", target_uid=VICTIM, at=minutes(1))])
    (entry,) = listed(client)["items"]
    assert set(entry) == {
        "id", "at", "adminUid", "adminEmail", "action", "outcome", "targetUid", "targetEmail", "targetDeleted",
        "setting", "before", "after", "rejectReason", "query", "refId", "redactedAt",
    }  # no matchedUids, no expireAt


def test_empty_journal_is_an_empty_page(client: TestClient) -> None:
    assert listed(client) == {"items": [], "hasNext": False, "hasPrev": False, "nextCursor": None}


def test_filters_by_admin_user_and_action(db: FakeDb, client: TestClient) -> None:
    db.put_all([
        make_audit("quota_reset", target_uid=VICTIM, at=minutes(1)),
        make_audit("limit_set", target_uid=VICTIM, admin_uid=OTHER_ADMIN, at=minutes(2)),
        make_audit("quota_reset", target_uid="u-other", admin_uid=OTHER_ADMIN, at=minutes(3)),
        make_audit("banner_changed", setting="banner", at=minutes(4)),
    ])
    assert [e["action"] for e in listed(client, adminUid=OTHER_ADMIN)["items"]] == ["quota_reset", "limit_set"]
    assert [e["action"] for e in listed(client, targetUid=VICTIM)["items"]] == ["limit_set", "quota_reset"]
    assert [e["targetUid"] for e in listed(client, action="quota_reset")["items"]] == ["u-other", VICTIM]
    both = listed(client, adminUid=OTHER_ADMIN, targetUid=VICTIM, action="limit_set")["items"]
    assert [(e["adminUid"], e["targetUid"], e["action"]) for e in both] == [(OTHER_ADMIN, VICTIM, "limit_set")]
    assert listed(client, adminUid="nobody")["items"] == []


def test_invalid_filter_values_are_422_form_errors(db: FakeDb, client: TestClient) -> None:
    for params in ({"action": "format_disk"}, {"adminUid": "bad uid!"}, {"limit": 0}, {"limit": 51}, {"limit": "x"}):
        res = client.get(AUDIT_URL, params=params, headers=HEADERS)
        assert res.status_code == 422 and res.json()["code"] == "invalid_value", params
    res = client.get(AUDIT_URL, params={"after": "not-a-cursor"}, headers=HEADERS)
    assert res.status_code == 422 and res.json()["code"] == "invalid_value"


# --------------------------------------------------------------------------- AC-10b: views and refusals are in the journal


def test_search_card_view_and_refused_attempt_are_listed(db: FakeDb, client: TestClient) -> None:
    db.put_all([
        make_audit("search", at=minutes(1), query="victim@exa", matched_uids=[VICTIM]),
        make_audit("view_card", target_uid=VICTIM, at=minutes(2)),
        make_audit("restrict", outcome="rejected", target_uid=ADMIN, at=minutes(3), rejectReason="self_target"),
        make_audit("limit_set", outcome="not_applied", target_uid=VICTIM, at=minutes(4), refId="Xk2fP0aQ9rT1"),
    ])
    items = listed(client)["items"]
    assert [(e["action"], e["outcome"]) for e in items] == [
        ("limit_set", "not_applied"), ("restrict", "rejected"), ("view_card", "applied"), ("search", "applied"),
    ]
    follow_up, refused, card, search = items
    assert follow_up["refId"] == "Xk2fP0aQ9rT1"
    assert refused["rejectReason"] == "self_target" and refused["targetUid"] == ADMIN
    assert card["targetUid"] == VICTIM and card["targetEmail"] == "victim@example.test"
    assert search["query"] == "victim@exa" and search["targetUid"] is None
    assert "matchedUids" not in search  # exists to drive the purge redaction, not for the screen


def test_listing_the_journal_writes_nothing(db: FakeDb, client: TestClient) -> None:
    db.put_all([make_audit("quota_reset", target_uid=VICTIM, at=minutes(1))])
    listed(client)
    listed(client, action="quota_reset")
    assert db.commits == 0  # FakeDb.commit raises if anything tried


# --------------------------------------------------------------------------- AC-11: purged users and an append-only journal


def test_audit_entries_of_a_purged_user_remain_and_show_deleted(db: FakeDb, client: TestClient) -> None:
    db.put_all([
        tombstone(PURGED),  # the purge also removed the email from the index: PURGED is not in the shard
        make_audit("quota_reset", target_uid=PURGED, at=minutes(1), before={"analyses": 3}, after={"analyses": 0}),
        make_audit("view_card", target_uid=VICTIM, at=minutes(2)),
        make_audit("limit_set", target_uid=PURGED, at=minutes(3), redactedAt=minutes(5),
                   before={"analyses": 10}, after={"analyses": 20}),
    ])
    items = {e["action"]: e for e in listed(client)["items"]}
    assert len(items) == 3  # the records are in place
    for action in ("quota_reset", "limit_set"):
        gone = items[action]
        assert gone["targetUid"] == PURGED and gone["targetEmail"] is None and gone["targetDeleted"] is True
    assert items["quota_reset"]["before"] == {"analyses": 3}  # what happened stays readable
    assert items["limit_set"]["redactedAt"].startswith("2026-10-07T12:05:00")
    assert items["view_card"]["targetEmail"] == "victim@example.test" and items["view_card"]["targetDeleted"] is False
    assert "purged@example.test" not in str(items)  # no address of the purged user anywhere


def test_a_tombstone_wins_over_a_stale_index_entry(db: FakeDb, client: TestClient) -> None:
    """A purge in progress: the tombstone is written first (ADR-0011), the index entry may still be there."""
    db.put_all([tombstone(VICTIM), make_audit("view_card", target_uid=VICTIM, at=minutes(1))])
    (entry,) = listed(client)["items"]
    assert entry["targetEmail"] is None and entry["targetDeleted"] is True


def test_a_target_the_index_does_not_know_is_not_called_deleted(db: FakeDb, client: TestClient) -> None:
    db.put_all([make_audit("view_card", target_uid="u-stranger", at=minutes(1))])
    (entry,) = listed(client)["items"]
    assert entry["targetEmail"] is None and entry["targetDeleted"] is False


def test_each_target_is_resolved_once_per_page(db: FakeDb, client: TestClient) -> None:
    db.put_all([tombstone(PURGED)] + [make_audit("view_card", target_uid=PURGED, at=minutes(i)) for i in range(1, 31)])
    assert all(e["targetDeleted"] for e in listed(client)["items"])
    assert db.gets.count(f"adminTombstones/{PURGED}") == 1


def test_there_is_no_route_that_changes_or_deletes_a_journal_record(db: FakeDb, client: TestClient) -> None:
    db.put_all([make_audit("quota_reset", target_uid=VICTIM, at=minutes(1))])
    (entry,) = listed(client)["items"]
    shipped = [r for r in admin_router.routes if isinstance(r, APIRoute) and "audit" in r.path]
    assert shipped, "the journal route must be on the router"
    assert {m for r in shipped for m in r.methods} <= {"GET", "HEAD"}
    for url in (AUDIT_URL, f"{AUDIT_URL}/{entry['id']}"):
        for method in ("PUT", "PATCH", "DELETE", "POST"):
            res = client.request(method, url, headers=HEADERS, json={"action": "search"})
            assert res.status_code in (404, 405), (method, url, res.status_code)
    assert listed(client)["items"] == [entry]  # still there, unchanged


def test_the_contract_offers_no_write_on_the_journal() -> None:
    yaml = pytest.importorskip("yaml")
    if not CONTRACT.exists():
        pytest.skip("contract not in this checkout")
    paths = yaml.safe_load(CONTRACT.read_text(encoding="utf-8"))["paths"]
    audit_paths = {p: ops for p, ops in paths.items() if "audit" in p}
    assert set(audit_paths) == {AUDIT_URL}
    assert set(audit_paths[AUDIT_URL]) - {"parameters", "summary", "description"} == {"get"}


# --------------------------------------------------------------------------- paging


def test_pages_of_fifty_chain_by_cursor_without_gaps_or_repeats(db: FakeDb, client: TestClient) -> None:
    same = minutes(10)  # five records share a timestamp: the id breaks the tie
    db.put_all(
        [make_audit("view_card", target_uid=VICTIM, at=minutes(i)) for i in range(1, 117)]
        + [make_audit("search", at=same, query=f"tie-{i}") for i in range(5)]
    )
    first = listed(client)
    assert len(first["items"]) == 50 and first["hasNext"] is True and first["hasPrev"] is False
    assert first["nextCursor"]
    second = listed(client, after=first["nextCursor"])
    assert len(second["items"]) == 50 and second["hasNext"] is True and second["hasPrev"] is True
    third = listed(client, after=second["nextCursor"])
    assert len(third["items"]) == 21 and third["hasNext"] is False and third["nextCursor"] is None
    seen = [e["id"] for page in (first, second, third) for e in page["items"]]
    assert len(seen) == len(set(seen)) == 121
    stamps = [e["at"] for page in (first, second, third) for e in page["items"]]
    assert stamps == sorted(stamps, reverse=True)


def test_limit_shortens_the_page_and_before_goes_back(db: FakeDb, client: TestClient) -> None:
    db.put_all([make_audit("view_card", target_uid=VICTIM, at=minutes(i)) for i in range(1, 8)])
    p1 = listed(client, limit=3)
    p2 = listed(client, limit=3, after=p1["nextCursor"])
    p3 = listed(client, limit=3, after=p2["nextCursor"])
    assert [len(p["items"]) for p in (p1, p2, p3)] == [3, 3, 1]
    # ``before`` = the page that ends right before a record: the 3 records newer than p2's last, still newest first
    back = listed(client, limit=3, before=p2["nextCursor"])
    assert [e["id"] for e in back["items"]] == [p1["items"][2]["id"], p2["items"][0]["id"], p2["items"][1]["id"]]
    assert back["hasNext"] is True and back["hasPrev"] is True
    assert back["nextCursor"]  # continues after the page's last record, like any page with hasNext


def test_filters_hold_across_pages(db: FakeDb, client: TestClient) -> None:
    db.put_all(
        [make_audit("quota_reset", target_uid=VICTIM, at=minutes(i)) for i in range(1, 6)]
        + [make_audit("limit_set", target_uid=VICTIM, at=minutes(i)) for i in range(6, 11)]
    )
    p1 = listed(client, action="quota_reset", limit=3)
    p2 = listed(client, action="quota_reset", limit=3, after=p1["nextCursor"])
    assert [e["action"] for e in p1["items"] + p2["items"]] == ["quota_reset"] * 5
    assert p2["hasNext"] is False


# --------------------------------------------------------------------------- budget and access


def test_a_page_reads_at_most_the_budget(db: FakeDb, client: TestClient) -> None:
    """NFR: at most 200 document reads a screen (50 records + the email index + a tombstone per distinct target)."""
    db.put_all([tombstone(f"u-gone-{i}") for i in range(25)])
    db.put_all([make_audit("view_card", target_uid=f"u-gone-{i % 25}", at=minutes(i)) for i in range(1, 80)])
    db.reset_counters()
    assert len(listed(client)["items"]) == 50
    assert db.total_reads <= 200, db.reads


def test_a_non_admin_gets_the_not_found_of_an_unknown_address(db: FakeDb, client: TestClient) -> None:
    db.put_all([make_audit("quota_reset", target_uid=VICTIM, at=minutes(1))])
    res = client.get(AUDIT_URL, headers={"Authorization": "Bearer tok-mallory"})
    assert res.status_code == 404 and res.json()["code"] == "not_found"
    assert "quota_reset" not in res.text and "victim" not in res.text


# --------------------------------------------------------------------------- Firestore emulator


@pytest.fixture
def emulator(admin_db: FirestoreIndex, tmp_path: Path):
    tag = secrets.token_hex(4)
    admin_uid, victim, gone = f"t19-admin-{tag}", f"t19-victim-{tag}", f"t19-gone-{tag}"
    seed(admin_db, [
        make_admin(admin_uid),
        make_user(victim, f"victim-{tag}@example.test", T0),
        tombstone(gone),
    ])
    audit = Audit(admin_db, now=lambda: T0)
    audit.record_view(AuditEntry(action="search", admin_uid=admin_uid, admin_email=ADMIN_EMAIL, query=f"victim-{tag}",
                                 matched_uids=[victim]))
    audit.record_view(AuditEntry(action="view_card", admin_uid=admin_uid, admin_email=ADMIN_EMAIL, target_uid=victim))
    audit.record_first(AuditEntry(action="quota_reset", admin_uid=admin_uid, admin_email=ADMIN_EMAIL, target_uid=gone,
                                  before={"analyses": 3}, after={"analyses": 0}))
    audit.record_first(AuditEntry(action="restrict", admin_uid=admin_uid, admin_email=ADMIN_EMAIL, target_uid=admin_uid,
                                  outcome="rejected", reject_reason="self_target"))
    client = build_client(tmp_path, admin_db)
    yield SimpleNamespace(client=client, admin=admin_uid, victim=victim, gone=gone, tag=tag)
    client.__exit__(None, None, None)


def test_emulator_journal_lists_filters_and_resolves_targets(emulator: SimpleNamespace) -> None:
    e = emulator
    headers = {"Authorization": f"Bearer tok-{e.admin}"}
    res = e.client.get(AUDIT_URL, params={"adminUid": e.admin}, headers=headers)  # the equality filter + at DESC index
    assert res.status_code == 200, res.text
    items = res.json()["items"]
    assert sorted(i["action"] for i in items) == ["quota_reset", "restrict", "search", "view_card"]
    by_action = {i["action"]: i for i in items}
    assert by_action["view_card"]["targetEmail"] == f"victim-{e.tag}@example.test"
    assert by_action["quota_reset"]["targetEmail"] is None and by_action["quota_reset"]["targetDeleted"] is True
    assert by_action["restrict"]["rejectReason"] == "self_target"
    assert by_action["search"]["query"] == f"victim-{e.tag}"
    stamps = [i["at"] for i in items]
    assert stamps == sorted(stamps, reverse=True)

    by_target = e.client.get(AUDIT_URL, params={"targetUid": e.gone}, headers=headers).json()["items"]
    assert [i["action"] for i in by_target] == ["quota_reset"]
    by_action_and_admin = e.client.get(AUDIT_URL, params={"action": "search", "adminUid": e.admin}, headers=headers)
    assert [i["action"] for i in by_action_and_admin.json()["items"]] == ["search"]
    paged = e.client.get(AUDIT_URL, params={"adminUid": e.admin, "limit": 3}, headers=headers).json()
    assert len(paged["items"]) == 3 and paged["hasNext"] is True
    rest = e.client.get(AUDIT_URL, params={"adminUid": e.admin, "limit": 3, "after": paged["nextCursor"]}, headers=headers)
    assert len(rest.json()["items"]) == 1 and rest.json()["hasNext"] is False

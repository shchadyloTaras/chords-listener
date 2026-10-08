"""searchUsers, getUserCard and listUserTracks (docs/features/admin: AC-03, AC-04, AC-05, AC-06, AC-10b, AC-15,
AC-16, AC-33b; contracts/openapi.yaml ``/api/admin/users``).

The API tests run the real app (admin router, allowlist authz, audit writer, email-index directory, runtime
settings) over ``UsersDb``, an in-memory Firestore that serves the queries these handlers make; the Firebase Auth
lookup of ``lastLoginAt`` is replaced by a fake. The last tests run the same flows on the Firestore emulator
(only when FIRESTORE_EMULATOR_HOST is set): the read budget of one card with 1 000 tracks.
"""
from __future__ import annotations

import base64
import json
import re
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
    HOSTILE_STRINGS,
    LOGIN_AT,
    Clock,
    FakeVerifier,
    H,
    Seed,
    encode_cursor,
    iso,
    make_account_state,
    make_admin,
    make_job,
    make_tracks,
    make_user,
    never,
    settings_for,
    utc_today,
    write_quota,
)
from app.admin.router import AdminServices, get_services
from app.firestore import FirestoreIndex
from app.main import create_app

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


def ivans(w: SimpleNamespace) -> None:
    w.db.put(make_user("u1", "Ivan.P@example.test"), make_user("u2", "John.Ivanov@example.test"),
             make_user("u3", "maria@example.test"))


# =========================================================================== AC-03 / AC-04 / AC-10b / AC-33b: search


def test_search_finds_a_part_of_the_email_anywhere_case_insensitively(world) -> None:
    w = world()
    ivans(w)
    for q in ("ivan", "IVAN", "  Ivan "):
        res = w.get("/api/admin/users", params={"q": q})
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["query"] == q.strip()
        assert [i["email"] for i in body["items"]] == ["ivan.p@example.test", "john.ivanov@example.test"]
        assert [i["uid"] for i in body["items"]] == ["u1", "u2"]
        assert all(i["service"] is False for i in body["items"])
        assert body["truncated"] is False


def test_search_with_no_match_is_an_empty_list_and_still_journaled(world) -> None:
    w = world()
    ivans(w)
    res = w.get("/api/admin/users", params={"q": "nobody-like-this"})
    assert res.status_code == 200
    assert res.json()["items"] == []
    (record,) = [d for d in w.db.audit_docs() if d["action"] == "search"]
    assert record["query"] == "nobody-like-this"
    assert record["matchedUids"] == []


@pytest.mark.parametrize("q", ["iv", "  iv  ", "a", "   ", ""])
def test_a_search_shorter_than_3_characters_is_refused_without_journaling(world, q: str) -> None:
    w = world()
    ivans(w)
    before = len(w.db.audit_docs())
    res = w.get("/api/admin/users", params={"q": q})
    assert res.status_code == 422
    assert res.json()["code"] == "query_too_short"
    assert res.json()["detail"] == "Type at least 3 characters"
    assert len(w.db.audit_docs()) == before
    assert not [qy for qy in w.db.queries if qy[0] == "users" and qy[1]], "nothing was searched"


def test_search_is_journaled_with_the_query_and_the_matched_uids_before_the_answer(world) -> None:
    w = world()
    ivans(w)
    res = w.get("/api/admin/users", params={"q": "ivan"})
    assert res.status_code == 200
    (record,) = [d for d in w.db.audit_docs() if d["action"] == "search"]
    assert record["adminUid"] == BOSS and record["adminEmail"] == ADMIN_EMAIL
    assert record["outcome"] == "applied"
    assert record["query"] == "ivan"
    assert record["matchedUids"] == ["u1", "u2"]
    assert record["targetUid"] is None


def test_a_failed_search_journal_withholds_every_result(world) -> None:
    w = world()
    ivans(w)
    w.db.fail_audit = True
    res = w.get("/api/admin/users", params={"q": "ivan"})
    assert res.status_code == 503
    assert res.json()["code"] == "audit_unavailable"
    assert "example.test" not in res.text and "u1" not in res.text
    assert not w.db.audit_docs()


def test_search_marks_the_service_account_and_caps_at_fifty(world) -> None:
    w = world()
    w.db.put(make_user("smoke-test", "smoke@example.test"))
    w.db.put(*[make_user(f"bulk-{i:03d}", f"bulk-{i:03d}@example.test") for i in range(60)])
    smoke = w.get("/api/admin/users", params={"q": "smoke@"}).json()
    assert smoke["items"] == [{"uid": "smoke-test", "email": "smoke@example.test", "service": True}]
    bulk = w.get("/api/admin/users", params={"q": "bulk-"}).json()
    assert len(bulk["items"]) == 50
    assert bulk["truncated"] is True
    (record,) = [d for d in w.db.audit_docs() if d.get("query") == "bulk-"]
    assert len(record["matchedUids"]) == 50


def test_a_new_registration_is_found_without_waiting_for_a_sync(world) -> None:
    w = world()
    ivans(w)
    assert len(w.get("/api/admin/users", params={"q": "ivan"}).json()["items"]) == 2
    w.services.directory._shards = None          # a fresh instance reads the index again
    w.db.put(make_user("u9", "ivan.new@example.test", created_at=datetime.now(timezone.utc) + timedelta(hours=1)))
    assert "ivan.new@example.test" in [i["email"] for i in w.get("/api/admin/users", params={"q": "ivan"}).json()["items"]]


def test_a_non_admin_is_refused_like_an_unknown_address_and_nothing_is_journaled(world) -> None:
    w = world()
    ivans(w)
    res = w.get("/api/admin/users", who="mallory", params={"q": "ivan"})
    assert res.status_code == 404 and res.json()["code"] == "not_found"
    assert not w.db.audit_docs()


# =========================================================================== AC-03 / AC-15 / AC-16: the card


def seeded_card(w: SimpleNamespace, uid: str = "u1", n_tracks: int = 5, **account: Any) -> None:
    w.db.put(make_user(uid, "Ivan.P@example.test", created_at=datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc)))
    w.db.put(*make_tracks(uid, n_tracks, size=1_000_000))
    if account:
        w.db.put(make_account_state(uid, **account))


def test_the_card_shows_profile_quota_limit_and_state(world) -> None:
    w = world()
    seeded_card(w, n_tracks=5)
    write_quota(w, "u1", analyses=12, vocals=3)
    res = w.get("/api/admin/users/u1")
    assert res.status_code == 200, res.text
    card = res.json()
    assert card["profile"] == {
        "uid": "u1", "email": "Ivan.P@example.test", "createdAt": "2026-09-01T10:00:00Z",
        "lastLoginAt": "2026-10-07T18:20:00Z", "service": False, "trackCount": 5, "storageBytes": 5_000_000,
    }
    account = card["account"]
    assert account["status"] == "normal" and account["restriction"] is None and account["deletion"] is None
    assert account["personalLimit"] is None
    quota = account["quota"]
    assert quota["analyses"] == {"used": 12, "limit": 40}
    assert quota["vocals"] == {"used": 3, "limit": 15}
    assert quota["jobs"] == {"used": 0, "limit": 2}
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", quota["day"])
    assert card["recentJobs"] == []
    assert len(card["tracks"]["items"]) == 5 and card["tracks"]["hasNext"] is False


def test_the_card_shows_the_personal_limit_over_the_default_for_the_fields_it_sets(world) -> None:
    w = world()
    until = utc_today() + timedelta(days=10)
    seeded_card(w, personal_limit={"analyses": 100, "until": until.isoformat(), "setAt": datetime(2026, 10, 1, tzinfo=timezone.utc),
                                   "byAdminUid": BOSS})
    write_quota(w, "u1", analyses=40, vocals=0)
    account = w.get("/api/admin/users/u1").json()["account"]
    assert account["personalLimit"] == {
        "analyses": 100, "vocals": None, "jobs": None, "until": until.isoformat(),
        "setAt": "2026-10-01T00:00:00Z", "byAdminUid": BOSS, "expired": False,
    }
    assert account["quota"]["analyses"] == {"used": 40, "limit": 100}
    assert account["quota"]["vocals"]["limit"] == 15      # not set personally: follows the default (AC-13b)


def test_a_personal_limit_lower_than_the_default_still_wins(world) -> None:
    w = world()
    seeded_card(w, personal_limit={"analyses": 5, "setAt": datetime(2026, 10, 1, tzinfo=timezone.utc), "byAdminUid": BOSS})
    account = w.get("/api/admin/users/u1").json()["account"]
    assert account["quota"]["analyses"]["limit"] == 5
    assert account["personalLimit"]["until"] is None and account["personalLimit"]["expired"] is False


def test_an_expired_personal_limit_falls_back_to_the_default_and_shows_it_ended(world) -> None:
    w = world()
    yesterday = utc_today() - timedelta(days=1)
    seeded_card(w, personal_limit={"analyses": 100, "until": yesterday.isoformat(),
                                   "setAt": datetime(2026, 9, 1, tzinfo=timezone.utc), "byAdminUid": BOSS})
    account = w.get("/api/admin/users/u1").json()["account"]
    assert account["personalLimit"]["expired"] is True                 # the card says «завершився»
    assert account["quota"]["analyses"]["limit"] == 40                 # the default applies (AC-15)


def test_a_personal_limit_runs_through_its_last_day_inclusive(world) -> None:
    w = world()
    seeded_card(w, personal_limit={"analyses": 100, "until": utc_today().isoformat(),
                                   "setAt": datetime(2026, 9, 1, tzinfo=timezone.utc), "byAdminUid": BOSS})
    account = w.get("/api/admin/users/u1").json()["account"]
    assert account["personalLimit"]["expired"] is False
    assert account["quota"]["analyses"]["limit"] == 100


def test_the_card_shows_the_restriction_with_reason_and_date(world) -> None:
    w = world()
    seeded_card(w, restriction={"reason": "автоматичні масові запити", "since": datetime(2026, 10, 8, 9, 0, tzinfo=timezone.utc),
                                "byAdminUid": BOSS})
    account = w.get("/api/admin/users/u1").json()["account"]
    assert account["status"] == "restricted"
    assert account["restriction"] == {"reason": "автоматичні масові запити", "since": "2026-10-08T09:00:00Z", "byAdminUid": BOSS}
    assert account["deletion"] is None


def test_the_card_shows_a_scheduled_deletion_with_its_date(world) -> None:
    w = world()
    scheduled = datetime(2026, 10, 8, 9, 0, tzinfo=timezone.utc)
    seeded_card(
        w,
        restriction={"reason": "deletion", "since": scheduled, "byAdminUid": BOSS},
        deletion={"scheduledAt": scheduled, "purgeAfter": scheduled + timedelta(days=7), "byAdminUid": BOSS,
                  "priorRestriction": None},
    )
    account = w.get("/api/admin/users/u1").json()["account"]
    assert account["status"] == "deletion_scheduled"
    assert account["deletion"] == {"scheduledAt": "2026-10-08T09:00:00Z", "purgeAfter": "2026-10-15T09:00:00Z", "byAdminUid": BOSS}
    assert "priorRestriction" not in json.dumps(account)


def test_the_card_shows_the_last_login_and_survives_an_unreachable_auth_service(world) -> None:
    def broken(uid: str) -> Optional[datetime]:
        raise RuntimeError("identity toolkit is down")

    w = world(login=lambda uid: None)
    seeded_card(w)
    assert w.get("/api/admin/users/u1").json()["profile"]["lastLoginAt"] is None      # never signed in
    w.services.last_login = broken
    res = w.get("/api/admin/users/u1")
    assert res.status_code == 200 and res.json()["profile"]["lastLoginAt"] is None


def test_the_card_lists_the_20_newest_jobs_of_the_user(world) -> None:
    w = world()
    seeded_card(w)
    start = datetime(2026, 10, 8, 8, 0, tzinfo=timezone.utc)
    w.db.put(*[make_job("u1", job_id=f"job{i:02d}", accepted_at=start + timedelta(minutes=i), title=f"Song {i}") for i in range(25)])
    w.db.put(make_job("u2", job_id="other", accepted_at=start))
    jobs = w.get("/api/admin/users/u1").json()["recentJobs"]
    assert [j["id"] for j in jobs] == [f"job{i:02d}" for i in range(24, 4, -1)]
    first = jobs[0]
    assert first["uid"] == "u1" and first["email"] == "Ivan.P@example.test" and first["userDeleted"] is False
    assert first["status"] == "error" and first["reason"] == "youtube_blocked" and first["errorText"] == "Download failed"
    assert first["acceptedAt"] == "2026-10-08T08:24:00Z" and first["finishedAt"] == "2026-10-08T08:24:30Z"


def test_the_card_counts_running_jobs_against_the_job_limit(world) -> None:
    w = world()
    seeded_card(w)
    manager = w.app.state.jobs
    manager.running_count = lambda uid=None: 2 if uid == "u1" else 0
    assert w.get("/api/admin/users/u1").json()["account"]["quota"]["jobs"] == {"used": 2, "limit": 2}


def test_opening_a_card_is_journaled_before_the_answer(world) -> None:
    w = world()
    seeded_card(w)
    assert w.get("/api/admin/users/u1").status_code == 200
    (record,) = [d for d in w.db.audit_docs() if d["action"] == "view_card"]
    assert record["adminUid"] == BOSS and record["targetUid"] == "u1" and record["outcome"] == "applied"
    assert ADMIN_EMAIL in json.dumps(record) and "Ivan.P" not in json.dumps(record)


def test_a_failed_card_journal_withholds_the_card(world) -> None:
    w = world()
    seeded_card(w)
    w.db.fail_audit = True
    res = w.get("/api/admin/users/u1")
    assert res.status_code == 503
    assert res.json()["code"] == "audit_unavailable"
    assert "Ivan" not in res.text and "example.test" not in res.text and "Song 0" not in res.text
    assert not w.db.audit_docs()


def test_an_unknown_user_is_not_found_and_not_journaled(world) -> None:
    w = world()
    res = w.get("/api/admin/users/ghost")
    assert res.status_code == 404
    assert res.json() == {"detail": "User not found", "code": "not_found"}
    assert not w.db.audit_docs()


def test_a_purged_user_is_not_found_even_if_a_document_is_left(world) -> None:
    w = world()
    seeded_card(w)
    w.db.docs["adminTombstones/u1"] = {"status": "purging", "purgeAfter": "2026-10-08T00:00:00Z"}
    res = w.get("/api/admin/users/u1")
    assert res.status_code == 404 and res.json()["code"] == "not_found"
    assert not w.db.audit_docs()
    w.db.docs["adminTombstones/gone"] = {"status": "done"}
    assert w.get("/api/admin/users/gone").status_code == 404


def test_a_user_without_tracks_has_an_empty_first_page(world) -> None:
    w = world()
    w.db.put(make_user("u1", "ivan@example.test"))
    card = w.get("/api/admin/users/u1").json()
    assert card["profile"]["trackCount"] == 0 and card["profile"]["storageBytes"] == 0
    assert card["tracks"] == {"items": [], "hasNext": False, "hasPrev": False, "nextCursor": None}


def test_a_track_without_a_recorded_size_has_null_size_and_adds_nothing_to_the_total(world) -> None:
    w = world()
    w.db.put(make_user("u1", "ivan@example.test"))
    tracks = make_tracks("u1", 2, size=7)
    old = Seed(tracks[1].path, {k: v for k, v in tracks[1].data.items() if k != "sizeBytes"})
    w.db.put(tracks[0], old)
    card = w.get("/api/admin/users/u1").json()
    assert card["profile"]["trackCount"] == 2 and card["profile"]["storageBytes"] == 7
    assert [t["sizeBytes"] for t in card["tracks"]["items"]] == [None, 7]          # newest first


def test_the_service_account_is_marked_on_its_card(world) -> None:
    w = world()
    w.db.put(make_user("smoke-test", "smoke@example.test"))
    assert w.get("/api/admin/users/smoke-test").json()["profile"]["service"] is True


# =========================================================================== AC-03 / AC-06: pages of songs


def test_songs_come_in_pages_of_50_newest_first(world) -> None:
    w = world()
    seeded_card(w, n_tracks=120)
    card = w.get("/api/admin/users/u1").json()
    page1 = card["tracks"]
    assert len(page1["items"]) == 50 and page1["hasNext"] is True and page1["hasPrev"] is False
    assert page1["items"][0]["id"] == f"{119:012x}" and page1["items"][-1]["id"] == f"{70:012x}"
    seen = [t["id"] for t in page1["items"]]

    res2 = w.get("/api/admin/users/u1/tracks", params={"after": page1["nextCursor"]})
    assert res2.status_code == 200
    page2 = res2.json()
    assert len(page2["items"]) == 50 and page2["hasNext"] is True and page2["hasPrev"] is True
    seen += [t["id"] for t in page2["items"]]

    page3 = w.get("/api/admin/users/u1/tracks", params={"after": page2["nextCursor"]}).json()
    assert len(page3["items"]) == 20 and page3["hasNext"] is False and page3["nextCursor"] is None
    seen += [t["id"] for t in page3["items"]]
    assert seen == [f"{i:012x}" for i in range(119, -1, -1)]
    created = [t["createdAt"] for t in page1["items"] + page2["items"] + page3["items"]]
    assert created == sorted(created, reverse=True)


def test_exactly_one_full_page_has_no_next_page(world) -> None:
    w = world()
    seeded_card(w, n_tracks=50)
    tracks = w.get("/api/admin/users/u1").json()["tracks"]
    assert len(tracks["items"]) == 50 and tracks["hasNext"] is False and tracks["nextCursor"] is None


def test_the_limit_parameter_shortens_the_page_and_the_cursor_continues_it(world) -> None:
    w = world()
    seeded_card(w, n_tracks=7)
    first = w.get("/api/admin/users/u1/tracks", params={"limit": 3}).json()
    assert [t["id"] for t in first["items"]] == [f"{i:012x}" for i in (6, 5, 4)] and first["hasNext"] is True
    second = w.get("/api/admin/users/u1/tracks", params={"limit": 3, "after": first["nextCursor"]}).json()
    assert [t["id"] for t in second["items"]] == [f"{i:012x}" for i in (3, 2, 1)]
    assert w.get("/api/admin/users/u1/tracks", params={"limit": 51}).status_code == 422
    assert w.get("/api/admin/users/u1/tracks", params={"limit": 0}).status_code == 422


def _first_cursor(page: dict) -> str:
    item = page["items"][0]
    return encode_cursor(item["createdAt"].replace("+00:00", "Z"), item["id"])


def test_the_before_cursor_goes_back_to_the_newer_songs(world) -> None:
    w = world()
    seeded_card(w, n_tracks=7)
    first = w.get("/api/admin/users/u1/tracks", params={"limit": 3}).json()
    second = w.get("/api/admin/users/u1/tracks", params={"limit": 3, "after": first["nextCursor"]}).json()
    back = w.get("/api/admin/users/u1/tracks", params={"limit": 2, "before": _first_cursor(second)})
    assert back.status_code == 200
    back = back.json()
    assert [t["id"] for t in back["items"]] == [f"{i:012x}" for i in (5, 4)]
    assert back["hasPrev"] is True and back["hasNext"] is True
    assert back["nextCursor"] is not None
    last = w.get("/api/admin/users/u1/tracks", params={"limit": 3, "before": _first_cursor(second)}).json()
    assert [t["id"] for t in last["items"]] == [t["id"] for t in first["items"]]
    assert last["hasPrev"] is False and last["hasNext"] is True


def test_after_and_before_together_are_an_invalid_value(world) -> None:
    w = world()
    seeded_card(w, n_tracks=3)
    cur = encode_cursor("2026-10-01T00:00:00Z", "t1")
    res = w.get("/api/admin/users/u1/tracks", params={"after": cur, "before": cur})
    assert res.status_code == 422 and res.json()["code"] == "invalid_value"


def test_search_is_not_truncated_at_exactly_fifty_matches(world) -> None:
    w = world()
    w.db.put(*[make_user(f"ex-{i:03d}", f"exact-{i:03d}@example.test") for i in range(50)])
    body = w.get("/api/admin/users", params={"q": "exact-"}).json()
    assert len(body["items"]) == 50 and body["truncated"] is False


def test_songs_with_the_same_date_are_neither_skipped_nor_repeated_across_pages(world) -> None:
    w = world()
    w.db.put(make_user("u1", "ivan@example.test"))
    same = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)
    seeds = [make_tracks("u1", 1, start=same)[0]]
    for i in range(1, 5):
        base = make_tracks("u1", 1, start=same)[0]
        track_id = f"same-{i}"
        seeds.append(Seed(f"users/u1/tracks/{track_id}", {**base.data, "id": track_id, "title": f"Twin {i}"}))
    w.db.put(*seeds)
    seen, cursor = [], None
    for _ in range(5):
        params: dict[str, Any] = {"limit": 2}
        if cursor:
            params["after"] = cursor
        page = w.get("/api/admin/users/u1/tracks", params=params).json()
        seen += [t["id"] for t in page["items"]]
        cursor = page["nextCursor"]
        if not page["hasNext"]:
            break
    assert sorted(seen) == sorted(s.path.rsplit("/", 1)[1] for s in seeds) and len(seen) == len(set(seen)) == 5


def test_the_cursor_is_the_opaque_date_and_id_of_the_last_song(world) -> None:
    w = world()
    seeded_card(w, n_tracks=60)
    cursor = w.get("/api/admin/users/u1").json()["tracks"]["nextCursor"]
    padded = cursor + "=" * (-len(cursor) % 4)
    decoded = json.loads(base64.urlsafe_b64decode(padded))
    assert set(decoded) == {"c", "i"} and decoded["i"] == f"{10:012x}"


@pytest.mark.parametrize("cursor", ["not-base64!!", "e30", encode_cursor("x", "y")[:-3], base64.urlsafe_b64encode(b"[1,2]").decode()])
def test_a_malformed_cursor_is_an_invalid_value(world, cursor: str) -> None:
    w = world()
    seeded_card(w, n_tracks=3)
    res = w.get("/api/admin/users/u1/tracks", params={"after": cursor})
    assert res.status_code == 422 and res.json()["code"] == "invalid_value"
    assert res.json()["details"]["fields"]


def test_later_pages_are_not_journaled_again_and_need_no_new_record(world) -> None:
    w = world()
    seeded_card(w, n_tracks=120)
    cursor = w.get("/api/admin/users/u1").json()["tracks"]["nextCursor"]
    assert len(w.db.audit_docs()) == 1
    w.db.fail_audit = True                       # even a broken journal does not stop the paging (api-sync-report)
    res = w.get("/api/admin/users/u1/tracks", params={"after": cursor})
    assert res.status_code == 200 and len(res.json()["items"]) == 50
    assert len(w.db.audit_docs()) == 1


def test_the_track_pages_of_an_unknown_or_purged_user_are_not_found(world) -> None:
    w = world()
    seeded_card(w, n_tracks=3)
    assert w.get("/api/admin/users/ghost/tracks").status_code == 404
    w.db.docs["adminTombstones/u1"] = {"status": "done"}
    res = w.get("/api/admin/users/u1/tracks")
    assert res.status_code == 404 and res.json()["code"] == "not_found"


def test_a_non_admin_cannot_page_songs(world) -> None:
    w = world()
    seeded_card(w, n_tracks=3)
    res = w.get("/api/admin/users/u1/tracks", who="mallory")
    assert res.status_code == 404
    assert res.json() == {"detail": "Unknown API endpoint: /api/admin/users/u1/tracks", "code": "not_found"}


# =========================================================================== AC-06: metadata only


ALLOWED_TRACK_KEYS = {"id", "title", "sourceType", "createdAt", "duration", "edited", "vocals", "sizeBytes"}
FORBIDDEN_WORDS = ("audio", "chord", "stem", "waveform", "beat", "media", "thumbnail", "artist", "url", "note", "key", "tempo")


def rich_track(uid: str, track_id: str, title: str, created: datetime) -> Seed:
    """A published summary as the library stores it, with every field a client could use to open the song."""
    return Seed(f"users/{uid}/tracks/{track_id}", {
        "id": track_id, "title": title, "artist": "Some Artist", "duration": 215.4, "thumbnail": "https://example.test/t.jpg",
        "source": {"type": "youtube", "url": "https://example.test/watch?v=abc", "videoId": "abc"},
        "key": {"root": "C", "mode": "major"}, "tempo": 120.0, "chordCount": 88, "edited": True, "vocals": True,
        "stems": ["vocals", "instruments"], "createdAt": iso(created), "version": 3, "publishedAt": created,
        "sizeBytes": 7_340_032, "audioUrl": "https://example.test/audio.mp3", "chords": [{"start": 0, "chord": "C"}],
        "notes": "private notes",
    })


def walk_keys(value: Any) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in walk_keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in walk_keys(v)}
    return set()


def test_a_song_row_has_only_the_metadata_fields_and_nothing_to_open_or_play(world) -> None:
    w = world()
    w.db.put(make_user("u1", "ivan@example.test"))
    w.db.put(rich_track("u1", "t-0001", "Test Song", datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)))
    item = w.get("/api/admin/users/u1").json()["tracks"]["items"][0]
    assert item == {
        "id": "t-0001", "title": "Test Song", "sourceType": "youtube", "createdAt": "2026-10-07T12:00:00Z",
        "duration": 215.4, "edited": True, "vocals": True, "sizeBytes": 7_340_032,
    }
    page_item = w.get("/api/admin/users/u1/tracks").json()["items"][0]
    assert page_item == item


def test_no_audio_chord_or_edit_field_appears_anywhere_in_the_card_or_a_page(world) -> None:
    w = world()
    w.db.put(make_user("u1", "ivan@example.test"))
    start = datetime(2026, 10, 7, tzinfo=timezone.utc)
    w.db.put(*[rich_track("u1", f"t-{i:04d}", f"Song {i}", start + timedelta(minutes=i)) for i in range(60)])
    w.db.put(make_job("u1", job_id="j1", status="done", reason=None))
    card = w.get("/api/admin/users/u1").json()
    page = w.get("/api/admin/users/u1/tracks", params={"after": card["tracks"]["nextCursor"]}).json()
    for body, items in ((card, card["tracks"]["items"]), (page, page["items"])):
        assert items
        for row in items:
            assert set(row) == ALLOWED_TRACK_KEYS
        leaked = {k for k in walk_keys(body) if any(word in k.lower() for word in FORBIDDEN_WORDS)}
        assert not leaked, leaked
        text = json.dumps(body)
        assert "audio.mp3" not in text and "private notes" not in text and "Some Artist" not in text


# =========================================================================== AC-05: text stays text


def test_hostile_titles_error_texts_and_emails_come_back_verbatim(world) -> None:
    w = world()
    hostile_email = "x+<b>@example.test"
    w.db.put(make_user("u1", hostile_email))
    w.db.put(*make_tracks("u1", len(HOSTILE_STRINGS), titles=HOSTILE_STRINGS))
    w.db.put(*[make_job("u1", job_id=f"j{i}", accepted_at=datetime(2026, 10, 8, i, tzinfo=timezone.utc), title=text, errorText=text[:200])
               for i, text in enumerate(HOSTILE_STRINGS)])
    card = w.get("/api/admin/users/u1").json()
    assert card["profile"]["email"] == hostile_email
    # verbatim: not escaped, stripped or re-encoded. A title is at most 300 characters (the sources cut it there, the
    # contract says so), a job's error text at most 200; the longer fixtures can only come back cut at that bound.
    titles = {t["title"] for t in card["tracks"]["items"]}
    assert titles == {s[:300] for s in HOSTILE_STRINGS}
    assert all(s in titles for s in HOSTILE_STRINGS if len(s) <= 300)
    assert {j["title"] for j in card["recentJobs"]} == {s[:300] for s in HOSTILE_STRINGS}
    assert {j["errorText"] for j in card["recentJobs"]} == {s[:200] for s in HOSTILE_STRINGS}
    found = w.get("/api/admin/users", params={"q": "<b>"}).json()
    assert [i["email"] for i in found["items"]] == [hostile_email]
    res = w.get("/api/admin/users/u1")
    assert res.headers["content-type"].startswith("application/json")


def test_a_title_over_the_contract_limit_is_cut_at_300_characters_not_refused(world) -> None:
    w = world()
    w.db.put(make_user("u1", "ivan@example.test"))
    w.db.put(*make_tracks("u1", 1, titles=["T" * 500]))
    assert w.get("/api/admin/users/u1").json()["tracks"]["items"][0]["title"] == "T" * 300


# =========================================================================== NFR: the card's read budget


def test_the_card_reads_at_most_200_documents_for_a_user_with_1000_songs(world) -> None:
    w = world()
    w.db.put(make_user("u1", "ivan@example.test"))
    w.db.put(*make_tracks("u1", 1000))
    w.db.put(*[make_job("u1", job_id=f"j{i:03d}", accepted_at=datetime(2026, 10, 8, tzinfo=timezone.utc) + timedelta(minutes=i)) for i in range(40)])
    w.db.put(make_account_state("u1", personal_limit={"analyses": 100, "setAt": datetime(2026, 10, 1, tzinfo=timezone.utc), "byAdminUid": BOSS}))
    w.services.settings.invalidate()
    w.db.reset_counters()
    res = w.get("/api/admin/users/u1")
    assert res.status_code == 200
    body = res.json()
    assert body["profile"]["trackCount"] == 1000 and len(body["tracks"]["items"]) == 50 and len(body["recentJobs"]) == 20
    assert sum(w.db.reads.values()) <= 200, w.db.reads


# =========================================================================== the services behind the routes


def test_the_services_are_built_once_per_app_and_can_be_replaced(world) -> None:
    w = world()
    assert get_services(w.app) is w.services
    assert isinstance(w.services, AdminServices)
    replaced = AdminServices(
        db=w.db, audit=w.services.audit, directory=w.services.directory, settings=w.services.settings,
        last_login=lambda uid: None,
    )
    w.app.state.admin_services = replaced
    assert get_services(w.app) is replaced


def test_the_admin_email_in_the_journal_comes_from_the_admins_own_account(world) -> None:
    w = world()
    ivans(w)
    w.db.put(make_user(BOSS, "Boss.Person@example.test"))
    w.services.directory._shards = None
    w.get("/api/admin/users", params={"q": "ivan"})
    assert w.db.audit_docs()[0]["adminEmail"] == "Boss.Person@example.test"      # as the account stores it


# =========================================================================== «останній вхід» from Firebase Auth


class FakeResponse:
    def __init__(self, status: int, body: Any) -> None:
        self.status_code, self._body = status, body

    def json(self) -> Any:
        return self._body


class FakeSession:
    def __init__(self, response: Any) -> None:
        self.response, self.calls = response, []

    def post(self, url: str, **kwargs: Any) -> Any:
        self.calls.append((url, kwargs))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def lookup(response: Any, **kw: Any) -> tuple[Any, FakeSession]:
    from app.admin.identity import AuthLookup

    session = FakeSession(response)
    return AuthLookup("p1", session_factory=lambda: session, **kw), session


def test_last_login_is_read_from_firebase_auth_and_comes_back_in_utc(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FIREBASE_AUTH_EMULATOR_HOST", raising=False)
    auth, session = lookup(FakeResponse(200, {"users": [{"localId": "u1", "lastLoginAt": "1791397200000"}]}))
    assert auth.last_login_at("u1") == datetime.fromtimestamp(1791397200, timezone.utc)
    url, kwargs = session.calls[0]
    assert url == "https://identitytoolkit.googleapis.com/v1/projects/p1/accounts:lookup"
    assert kwargs["json"] == {"localId": ["u1"]}


def test_last_login_points_at_the_auth_emulator_when_there_is_one() -> None:
    auth, session = lookup(FakeResponse(200, {"users": []}), emulator_host="127.0.0.1:9099")
    assert auth.last_login_at("u1") is None
    url, kwargs = session.calls[0]
    assert url == "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/p1/accounts:lookup"
    assert kwargs["headers"] == {"Authorization": "Bearer owner"}


@pytest.mark.parametrize("response", [
    FakeResponse(200, {"users": [{"localId": "u1"}]}),
    FakeResponse(200, {"users": [{"localId": "u1", "lastLoginAt": "0"}]}),
    FakeResponse(403, {"error": {"message": "denied"}}),
    FakeResponse(200, {"users": [{"lastLoginAt": "not-a-number"}]}),
    RuntimeError("no credentials"),
])
def test_last_login_is_unknown_when_auth_has_none_or_cannot_answer(response: Any) -> None:
    auth, _ = lookup(response)
    assert auth.last_login_at("u1") is None


# =========================================================================== emulator (only with FIRESTORE_EMULATOR_HOST)


def test_emulator_the_card_with_1000_songs_stays_within_the_read_budget(admin_db: FirestoreIndex, read_counter, tmp_path: Path) -> None:
    from admin.fixtures import seed

    uid = "budget-user"
    seed(admin_db, [make_admin(BOSS), make_user(BOSS, ADMIN_EMAIL), make_user(uid, "budget@example.test"), *make_tracks(uid, 1000)])
    seed(admin_db, [make_job(uid, job_id=f"budget-{i:03d}", accepted_at=datetime(2026, 10, 8, tzinfo=timezone.utc) + timedelta(minutes=i)) for i in range(30)])
    app = create_app(settings_for(tmp_path), analyzer=never, engine_info_fn=lambda: ENGINE_INFO,
                     token_verifier=FakeVerifier(Clock()), admin_db=admin_db)
    get_services(app).last_login = lambda _uid: LOGIN_AT
    with TestClient(app) as client:
        client.get(f"/api/admin/users/{uid}", headers=H(BOSS))        # warm: allowlist, settings, email lookup
        with read_counter.measure() as card:
            res = client.get(f"/api/admin/users/{uid}", headers=H(BOSS))
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["profile"]["trackCount"] == 1000 and body["profile"]["storageBytes"] == 1_000_000_000
        assert len(body["tracks"]["items"]) == 50 and len(body["recentJobs"]) == 20
        assert card.reads <= 200, card.reads
        page = client.get(f"/api/admin/users/{uid}/tracks", params={"after": body["tracks"]["nextCursor"]}, headers=H(BOSS)).json()
        assert page["items"][0]["id"] == f"{949:012x}" and page["hasPrev"] is True

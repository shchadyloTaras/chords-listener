"""setDefaultLimits, setSwitch and setBanner (docs/features/admin: AC-13b, AC-24..AC-30, AC-34; ADR-0005, ADR-0007).

Every test runs the real app on ``MemDb`` (an in-memory Firestore that applies the real REST write bodies: masks,
preconditions, the server-timestamp transform) and counts the commits, so "one batched write" is checked, not assumed.
"""
from __future__ import annotations

import copy
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from admin.fixtures import ADMIN_EMAIL, ENGINE_INFO, MemDb, make_account_state, make_admin, never, settings_for
from app.admin.authz import AdminAuthz
from app.admin.settings import CACHE_TTL_S, RuntimeSettings
from app.firestore import IndexError_, to_value
from app.main import create_app

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

NOON = datetime(2026, 10, 8, 12, 0, 0, tzinfo=timezone.utc)

ADMIN = "admin-1"
SETTINGS = "adminConfig/settings"
PUBLIC = "publicStatus/current"
STAMP = "2026-10-08T08:00:00Z"
LIMITS = {"analyses": 40, "vocals": 15, "jobs": 2, "maxDurationMin": 20, "maxUploadMb": 500}
SWITCHES = {"analysesPaused": False, "youtubeEnabled": True, "vocalsEnabled": True}
BANNER = {"enabled": False, "uk": "Технічні роботи", "en": "Maintenance"}
HEADERS = {"Authorization": f"Bearer tok-{ADMIN}"}
LIMITS_URL = "/api/admin/settings/limits"
BANNER_URL = "/api/admin/settings/banner"


def switch_url(name: str) -> str:
    return f"/api/admin/settings/switches/{name}"


class Verifier:
    """Tokens are ``tok-<uid>``; ``age`` is how many seconds ago the holder last typed their password."""

    def __init__(self) -> None:
        self.age = 0.0

    def verify_claims(self, token: str) -> tuple[str, Optional[float]]:
        return token.removeprefix("tok-"), time.time() - self.age

    def verify(self, token: str) -> str:
        return self.verify_claims(token)[0]


class FailingDb(MemDb):
    """``MemDb`` whose commits can be made to fail like a Firestore outage."""

    def __init__(self) -> None:
        super().__init__()
        self.down = False

    def commit(self, writes, *, transaction=None) -> None:
        if self.down:
            raise IndexError_("firestore is down", retryable=True)
        super().commit(writes, transaction=transaction)


class Env:
    def __init__(self, db: FailingDb, client: TestClient, verifier: Verifier) -> None:
        self.db, self.client, self.verifier = db, client, verifier

    def put(self, path: str, data: dict[str, Any]) -> None:
        from app.firestore import from_value
        self.db.docs[path] = from_value(to_value(data))

    def snapshot(self) -> dict[str, Any]:
        return copy.deepcopy(self.db.docs)

    def journal(self) -> list[dict[str, Any]]:
        return [d for p, d in sorted(self.db.docs.items()) if p.startswith("adminAudit/")]

    def doc(self, path: str) -> dict[str, Any]:
        return self.db.docs[path]

    def put_json(self, url: str, body: Any, **kw: Any):
        return self.client.put(url, json=body, headers=HEADERS, **kw)


@pytest.fixture
def env(tmp_path: Path):
    db = FailingDb()
    verifier = Verifier()
    app = create_app(
        settings_for(tmp_path), analyzer=never, engine_info_fn=lambda: ENGINE_INFO, token_verifier=verifier,
        admin_db=db, admin_authz=AdminAuthz(db),
    )
    e = Env(db, TestClient(app), verifier)
    e.client.__enter__()
    e.put(make_admin(ADMIN).path, make_admin(ADMIN).data)
    e.put(f"users/{ADMIN}", {"email": ADMIN_EMAIL, "createdAt": NOON})
    e.put(SETTINGS, {"limits": dict(LIMITS), "switches": dict(SWITCHES), "updatedBy": "someone", "updatedAt": STAMP})
    e.put(PUBLIC, {"banner": dict(BANNER), "switches": dict(SWITCHES), "updatedAt": STAMP})
    yield e
    e.client.__exit__(None, None, None)


# ===================================================================== AC-24: default limits


def test_default_limit_change_is_journaled_and_mirrored_in_one_commit(env: Env) -> None:
    commits = env.db.commits

    res = env.put_json(LIMITS_URL, {**LIMITS, "analyses": 30})

    assert res.status_code == 200, res.text
    assert env.db.commits == commits + 1                       # config + journal: one batched write
    assert env.doc(SETTINGS)["limits"] == {**LIMITS, "analyses": 30}
    assert env.doc(SETTINGS)["switches"] == SWITCHES           # a limits write never clobbers the switches
    assert env.doc(SETTINGS)["updatedBy"] == ADMIN
    body = res.json()
    assert body["limits"] == {**LIMITS, "analyses": 30}
    assert body["updatedBy"] == ADMIN
    [record] = env.journal()
    assert record["action"] == "defaults_changed" and record["outcome"] == "applied"
    assert record["setting"] == "limits"
    assert record["adminUid"] == ADMIN and record["adminEmail"] == ADMIN_EMAIL
    assert record["before"] == LIMITS and record["after"] == {**LIMITS, "analyses": 30}
    assert record["targetUid"] is None


def test_default_limit_change_applies_without_redeploy_within_a_minute(env: Env) -> None:
    mono = {"t": 1000.0}
    other_instance = RuntimeSettings(env.db, monotonic=lambda: mono["t"])    # e.g. another server instance
    assert other_instance.current().limits.analyses == 40                    # cached

    assert env.put_json(LIMITS_URL, {**LIMITS, "analyses": 30}).status_code == 200

    # the serving instance sees it at once (the handler refreshed its own cache)
    assert env.client.get("/api/admin/settings", headers=HEADERS).json()["limits"]["analyses"] == 30
    # any other instance sees it after the cache TTL, well inside the 60 s budget
    mono["t"] += CACHE_TTL_S + 1
    assert CACHE_TTL_S + 1 < 60
    assert other_instance.current().limits.analyses == 30


def test_changing_the_default_vocal_limit_leaves_personal_limits_alone(env: Env) -> None:
    """AC-13b: the default is stored on its own; a personal limit (analyses 5) stays and the unset field follows."""
    from app.admission import Admission
    from app.quotas import effective_limits

    account = make_account_state("u-5", personal_limit={"analyses": 5, "setAt": NOON, "byAdminUid": ADMIN})
    env.put(account.path, account.data)                                       # the personal limit lives in adminAccounts/<uid>
    before = copy.deepcopy(env.doc(account.path))

    def in_force() -> tuple[int, int, int]:                                  # what the gate computes for u-5, from the database
        gate = Admission(env.db, RuntimeSettings(env.db, monotonic=lambda: 1000.0), monotonic=lambda: 1000.0)
        eff = effective_limits(gate.defaults(), gate.personal("u-5"), "2026-10-08")
        return eff.analyses, eff.vocals, eff.jobs

    assert in_force() == (5, 15, 2)                                          # the personal 5 wins below the default 40

    res = env.put_json(LIMITS_URL, {**LIMITS, "vocals": 10})

    assert res.status_code == 200, res.text
    assert env.doc(account.path) == before                                   # the personal limit is not rewritten
    assert env.doc(SETTINGS)["limits"]["vocals"] == 10
    assert in_force() == (5, 10, 2)                                          # analyses stay 5; the unset vocals follow the default


# ===================================================================== AC-25: invalid limits


@pytest.mark.parametrize("patch", [
    {"analyses": 0}, {"analyses": -1}, {"analyses": 1001}, {"analyses": 1.5}, {"analyses": "30"}, {"analyses": None},
    {"vocals": 0}, {"vocals": 151},
    {"jobs": 0}, {"jobs": 5},
    {"maxDurationMin": 0}, {"maxDurationMin": 121},
    {"maxUploadMb": 0}, {"maxUploadMb": 513},
])
def test_invalid_default_limits_are_not_saved_nor_journaled(env: Env, patch: dict[str, Any]) -> None:
    before, commits = env.snapshot(), env.db.commits

    res = env.put_json(LIMITS_URL, {**LIMITS, **patch})

    assert res.status_code == 422, res.text
    body = res.json()
    assert body["code"] == "invalid_value"
    assert list(patch)[0] in body["details"]["fields"]                       # per-field explanation
    assert env.snapshot() == before and env.db.commits == commits            # nothing saved, nothing journaled


def test_an_empty_or_partial_limits_form_is_rejected_per_field(env: Env) -> None:
    before = env.snapshot()

    res = env.put_json(LIMITS_URL, {"analyses": 30})

    assert res.status_code == 422
    assert {"vocals", "jobs", "maxDurationMin", "maxUploadMb"} <= set(res.json()["details"]["fields"])
    assert env.snapshot() == before


@pytest.mark.parametrize("limits", [
    {"analyses": 1, "vocals": 1, "jobs": 1, "maxDurationMin": 1, "maxUploadMb": 1},
    {"analyses": 1000, "vocals": 150, "jobs": 4, "maxDurationMin": 120, "maxUploadMb": 512},
])
def test_the_edges_of_every_limit_range_are_accepted(env: Env, limits: dict[str, int]) -> None:
    assert env.put_json(LIMITS_URL, limits).status_code == 200
    assert env.doc(SETTINGS)["limits"] == limits


# ===================================================================== AC-26..AC-28: switches


@pytest.mark.parametrize("name, value", [
    ("youtubeEnabled", False), ("vocalsEnabled", False), ("analysesPaused", True),
])
def test_a_switch_change_writes_config_public_status_and_journal_in_one_commit(env: Env, name: str, value: bool) -> None:
    commits = env.db.commits
    banner_before = copy.deepcopy(env.doc(PUBLIC)["banner"])

    res = env.put_json(switch_url(name), {"value": value})

    assert res.status_code == 200, res.text
    assert env.db.commits == commits + 1
    expected = {**SWITCHES, name: value}
    assert env.doc(SETTINGS)["switches"] == expected
    assert env.doc(SETTINGS)["limits"] == LIMITS                             # limits untouched
    assert env.doc(PUBLIC)["switches"] == expected                           # the mirror the site reads
    assert env.doc(PUBLIC)["banner"] == banner_before                        # the banner untouched
    assert set(env.doc(PUBLIC)) == {"banner", "switches", "updatedAt"}       # nothing else is public
    assert res.json()["switches"] == expected
    [record] = env.journal()
    assert record["action"] == "switch_changed" and record["outcome"] == "applied"
    assert record["setting"] == f"switches.{name}"
    assert record["before"] == {name: SWITCHES[name]} and record["after"] == {name: value}
    assert record["adminUid"] == ADMIN


def test_a_change_of_one_switch_keeps_the_others_as_a_concurrent_writer_left_them(env: Env) -> None:
    env.put(SETTINGS, {"limits": dict(LIMITS), "switches": {**SWITCHES, "vocalsEnabled": False}, "updatedBy": "x"})
    env.put(PUBLIC, {"banner": dict(BANNER), "switches": {**SWITCHES, "vocalsEnabled": False}, "updatedAt": STAMP})

    assert env.put_json(switch_url("youtubeEnabled"), {"value": False}).status_code == 200

    both = {"analysesPaused": False, "youtubeEnabled": False, "vocalsEnabled": False}
    assert env.doc(SETTINGS)["switches"] == both and env.doc(PUBLIC)["switches"] == both


def test_jobs_accepted_before_a_switch_flips_are_not_touched(env: Env) -> None:
    jobs = env.client.app.state.jobs
    rec = jobs._new_record("url", {}, keys=set(), uid="u-1", source={"type": "youtube", "url": "https://youtu.be/a"})
    env.put("adminJobs/j1", {"uid": "u-1", "status": "running", "kind": "analysis", "acceptedAt": NOON})
    status_before, job_before = rec.status, copy.deepcopy(env.doc("adminJobs/j1"))

    for name, value in (("analysesPaused", True), ("youtubeEnabled", False), ("vocalsEnabled", False)):
        assert env.put_json(switch_url(name), {"value": value}).status_code == 200

    assert rec.status == status_before and not rec.cancel.is_set()
    assert env.doc("adminJobs/j1") == job_before
    assert [r.id for r in jobs.running_records()] == [rec.id]


# ===================================================================== AC-34: fresh login for the pause


def test_enabling_the_pause_needs_a_fresh_login(env: Env) -> None:
    env.verifier.age = 16 * 60
    before, commits = env.snapshot(), env.db.commits

    res = env.put_json(switch_url("analysesPaused"), {"value": True})

    assert res.status_code == 401
    assert res.json()["code"] == "reauth_required"
    assert env.snapshot() == before and env.db.commits == commits            # not done, not journaled

    env.verifier.age = 60                                                     # signed in again
    res = env.put_json(switch_url("analysesPaused"), {"value": True})

    assert res.status_code == 200, res.text
    assert env.doc(SETTINGS)["switches"]["analysesPaused"] is True
    assert [r["action"] for r in env.journal()] == ["switch_changed"]


@pytest.mark.parametrize("name, value", [
    ("analysesPaused", False), ("youtubeEnabled", False), ("vocalsEnabled", False), ("youtubeEnabled", True),
])
def test_other_switch_changes_need_no_fresh_login(env: Env, name: str, value: bool) -> None:
    env.verifier.age = 3 * 3600
    env.put(SETTINGS, {"limits": dict(LIMITS), "switches": {**SWITCHES, "analysesPaused": True}, "updatedBy": "x"})

    res = env.put_json(switch_url(name), {"value": value})

    assert res.status_code == 200, res.text
    assert env.doc(SETTINGS)["switches"][name] is value


def test_the_pause_with_a_login_just_inside_15_minutes_goes_through(env: Env) -> None:
    env.verifier.age = 14 * 60 + 30
    assert env.put_json(switch_url("analysesPaused"), {"value": True}).status_code == 200


@pytest.mark.parametrize("name, body", [
    ("nope", {"value": True}),
    ("youtubeEnabled", {"value": "yes"}),
    ("youtubeEnabled", {"value": None}),
    ("youtubeEnabled", {}),
    ("youtubeEnabled", {"value": True, "extra": 1}),
])
def test_an_unknown_switch_or_a_bad_value_is_invalid_and_not_journaled(env: Env, name: str, body: Any) -> None:
    before, commits = env.snapshot(), env.db.commits

    res = env.put_json(switch_url(name), body)

    assert res.status_code == 422, res.text
    assert res.json()["code"] == "invalid_value" and "fields" in res.json()["details"]
    assert env.snapshot() == before and env.db.commits == commits


# ===================================================================== AC-29 / AC-30: banner


def test_banner_publish_writes_the_public_mirror_and_journal_and_leaves_switches_intact(env: Env) -> None:
    env.put(PUBLIC, {"banner": dict(BANNER), "switches": {**SWITCHES, "youtubeEnabled": False}, "updatedAt": STAMP})
    config_before = copy.deepcopy(env.doc(SETTINGS))
    commits = env.db.commits
    banner = {"enabled": True, "uk": "Хмарний аналіз тимчасово на паузі", "en": "Cloud analysis is paused for now"}

    res = env.put_json(BANNER_URL, banner)

    assert res.status_code == 200, res.text
    assert env.db.commits == commits + 1
    assert env.doc(PUBLIC)["banner"] == banner                                # both languages
    assert env.doc(PUBLIC)["switches"] == {**SWITCHES, "youtubeEnabled": False}   # updateMask: switches intact
    assert set(env.doc(PUBLIC)) == {"banner", "switches", "updatedAt"}
    assert env.doc(SETTINGS) == config_before                                 # the server-only config is not touched
    assert res.json()["banner"] == banner
    [record] = env.journal()
    assert record["action"] == "banner_changed" and record["outcome"] == "applied"
    assert record["setting"] == "banner"
    assert record["before"] == BANNER and record["after"] == banner


def test_banner_can_be_turned_off_keeping_its_texts(env: Env) -> None:
    on = {"enabled": True, "uk": "а", "en": "a"}
    assert env.put_json(BANNER_URL, on).status_code == 200

    res = env.put_json(BANNER_URL, {**on, "enabled": False})

    assert res.status_code == 200
    assert env.doc(PUBLIC)["banner"] == {**on, "enabled": False}
    assert [r["before"]["enabled"] for r in env.journal() if r["after"]["enabled"] is False] == [True]


@pytest.mark.parametrize("patch, field", [
    ({"uk": ""}, "uk"), ({"en": ""}, "en"), ({"uk": "   "}, "uk"),
    ({"uk": "я" * 251}, "uk"), ({"en": "a" * 251}, "en"),
    ({"enabled": "yes"}, "enabled"),
])
def test_an_invalid_banner_is_not_published_nor_journaled(env: Env, patch: dict[str, Any], field: str) -> None:
    before, commits = env.snapshot(), env.db.commits

    res = env.put_json(BANNER_URL, {"enabled": True, "uk": "Привіт", "en": "Hello", **patch})

    assert res.status_code == 422, res.text
    assert res.json()["code"] == "invalid_value"
    assert field in res.json()["details"]["fields"]
    assert env.snapshot() == before and env.db.commits == commits


def test_a_banner_missing_a_language_is_rejected_per_field(env: Env) -> None:
    before = env.snapshot()

    res = env.put_json(BANNER_URL, {"enabled": True, "uk": "Привіт"})

    assert res.status_code == 422 and "en" in res.json()["details"]["fields"]
    assert env.snapshot() == before


def test_banner_texts_of_1_and_250_characters_are_accepted(env: Env) -> None:
    assert env.put_json(BANNER_URL, {"enabled": True, "uk": "я", "en": "a" * 250}).status_code == 200
    assert env.put_json(BANNER_URL, {"enabled": True, "uk": "я" * 250, "en": "a"}).status_code == 200


# ===================================================================== journal or nothing (ADR-0007)


@pytest.mark.parametrize("url, body", [
    (LIMITS_URL, {**LIMITS, "analyses": 30}),
    (switch_url("youtubeEnabled"), {"value": False}),
    (BANNER_URL, {"enabled": True, "uk": "а", "en": "a"}),
])
def test_a_failed_commit_changes_nothing_and_answers_not_applied(env: Env, url: str, body: Any) -> None:
    before = env.snapshot()
    env.db.down = True

    res = env.put_json(url, body)

    assert res.status_code == 503 and res.json()["code"] == "not_applied"
    env.db.down = False
    assert env.snapshot() == before                                           # neither config, mirror nor journal
    assert env.client.get("/api/admin/settings", headers=HEADERS).json()["limits"] == LIMITS


# ===================================================================== authorization


def test_a_non_admin_cannot_change_any_setting(env: Env) -> None:
    before = env.snapshot()
    other = {"Authorization": "Bearer tok-someone-else"}

    for url, body in ((LIMITS_URL, LIMITS), (switch_url("youtubeEnabled"), {"value": False}),
                      (BANNER_URL, {"enabled": True, "uk": "а", "en": "a"})):
        res = env.client.put(url, json=body, headers=other)
        assert res.status_code == 404, (url, res.text)

    assert env.snapshot() == before

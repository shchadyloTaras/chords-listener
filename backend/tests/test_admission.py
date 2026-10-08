"""The admission gate (docs/features/admin, T14, ADR-0008): every cloud job passes ``admission.check`` before
``Quotas.consume``. A refusal (restriction / scheduled deletion / purge, pause, YouTube off, vocals off) counts
nothing against the daily quota; the effective limit is the personal value of each set field over the default,
until the end date inclusive (UTC); a reset and an admission never lose one another.

The API tests run the real app in cloud mode over ``MemDb`` (the in-memory Firestore of the projection tests): the
five entries (link, upload, storage, re-analysis, vocals) are driven over HTTP. The unit tests drive ``Admission``
and ``Quotas`` with fake clocks.
"""
from __future__ import annotations

import json
import secrets
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Optional

import pytest

from admin.test_projections import MemDb
from app.models import Settings
from app.sources import SourceError
from app.storage import TrackStore
from app.users import user_context
from test_cloud import (  # noqa: F401  (make_cloud, media: fixtures of the cloud tests)
    BUCKET,
    VIDEO_ID,
    H,
    assert_error,
    make_cloud,
    media,
    needs_ffmpeg,
    upload,
    upload_and_wait,
    wait_job,
)

pytestmark = [pytest.mark.filterwarnings("ignore::DeprecationWarning"), needs_ffmpeg]

REASON = "automatic mass requests (admin eyes only)"
SINCE = "2026-10-01T09:00:00Z"
ADMIN = "admin-1"


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def yesterday() -> str:
    return (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")


# --------------------------------------------------------------------------- the app under test


def _no_vocals(*_: Any, **__: Any) -> dict:
    raise RuntimeError("the transcriber is not part of these tests")


def make_env(make_cloud, **overrides: Any) -> SimpleNamespace:
    """A cloud app over an in-memory Firestore; ``alice`` owns one analysed track (``env.track``)."""
    db = MemDb()
    overrides.setdefault("quota_analyses", 6)
    overrides.setdefault("quota_vocals", 3)
    overrides.setdefault("max_user_jobs", 2)
    env = make_cloud(admin_db=db, **overrides)
    env.db = db
    env.jobs = env.app.state.jobs
    env.jobs.vocal_transcriber = _no_vocals
    return env


def with_track(env: SimpleNamespace, media: SimpleNamespace) -> SimpleNamespace:
    job, _ = upload_and_wait(env, media.a, "alice")
    env.track = job["trackId"]
    return env


def set_account(env: SimpleNamespace, uid: str = "alice", **fields: Any) -> None:
    """Write ``adminAccounts/<uid>`` (restriction / deletion / personalLimit) and drop the gate's cached copy."""
    doc = {"restriction": None, "deletion": None, "personalLimit": None}
    doc.update(env.db.docs.get(f"adminAccounts/{uid}", {}))
    doc.update(fields)
    env.db.docs[f"adminAccounts/{uid}"] = doc
    env.app.state.admission.invalidate()


def set_config(env: SimpleNamespace, *, limits: Optional[dict] = None, **switches: bool) -> None:
    """Write ``adminConfig/settings``: ``limits`` over the app's own limits, ``switches`` over all-on."""
    s = env.settings
    stored = env.db.docs.get("adminConfig/settings", {})
    base = {"analyses": s.quota_analyses, "vocals": s.quota_vocals, "jobs": s.max_user_jobs,
            "maxDurationMin": 30, "maxUploadMb": 500}
    env.db.docs["adminConfig/settings"] = {
        "limits": {**base, **stored.get("limits", {}), **(limits or {})},
        "switches": {"analysesPaused": False, "youtubeEnabled": True, "vocalsEnabled": True,
                     **stored.get("switches", {}), **switches},
        "updatedBy": ADMIN,
    }
    env.app.state.admin_settings.invalidate()
    env.app.state.admission.invalidate()


RESTRICTION = {"reason": REASON, "since": SINCE, "byAdminUid": ADMIN}
DELETION = {"scheduledAt": SINCE, "purgeAfter": "2026-10-08T09:00:00Z", "byAdminUid": ADMIN, "priorRestriction": None}


def restrict(env: SimpleNamespace) -> None:
    set_account(env, restriction=dict(RESTRICTION))


def schedule_deletion(env: SimpleNamespace) -> None:
    set_account(env, deletion=dict(DELETION))  # the gate must not rely on ``restriction`` being set as well


def tombstone(env: SimpleNamespace) -> None:
    env.db.docs["adminTombstones/alice"] = {"status": "purging", "purgeAfter": SINCE, "startedAt": SINCE, "doneAt": None}
    env.app.state.admission.invalidate()


def pause(env: SimpleNamespace) -> None:
    set_config(env, analysesPaused=True)


def youtube_off(env: SimpleNamespace) -> None:
    set_config(env, youtubeEnabled=False)


def vocals_off(env: SimpleNamespace) -> None:
    set_config(env, vocalsEnabled=False)


# --------------------------------------------------------------------------- the five entries


def enter_url(env, media):
    return env.client.post("/api/jobs", json={"url": VIDEO_ID}, headers=H("alice"))


def enter_upload(env, media):
    return upload(env.client, media.b, H("alice"))


def enter_storage(env, media):
    path = env.gcs.put(f"users/alice/uploads/{secrets.token_hex(3)}/Song.mp3", media.c.read_bytes())
    return env.client.post("/api/jobs/storage", json={"path": path}, headers=H("alice"))


def enter_reanalyze(env, media):
    return env.client.post(f"/api/tracks/{env.track}/reanalyze", headers=H("alice"))


def enter_vocals(env, media):
    return env.client.post(f"/api/tracks/{env.track}/vocals", headers=H("alice"))


ENTRIES: dict[str, tuple[Callable, str]] = {  # entry -> (call, the quota it spends)
    "url": (enter_url, "analyses"),
    "upload": (enter_upload, "analyses"),
    "storage": (enter_storage, "analyses"),
    "reanalyze": (enter_reanalyze, "analyses"),
    "vocals": (enter_vocals, "vocals"),
}
CONDITIONS: dict[str, Callable] = {
    "restriction": restrict, "deletion": schedule_deletion, "purged": tombstone,
    "pause": pause, "youtube_off": youtube_off, "vocals_off": vocals_off,
}
REFUSAL: dict[str, tuple[int, str, tuple[str, ...]]] = {  # condition -> status, code, the entries it refuses
    "restriction": (403, "cloud_restricted", tuple(ENTRIES)),
    "deletion": (403, "cloud_restricted", tuple(ENTRIES)),
    "purged": (403, "cloud_restricted", tuple(ENTRIES)),
    "pause": (503, "analyses_paused", ("url", "upload", "storage", "reanalyze")),
    "youtube_off": (503, "youtube_disabled", ("url",)),
    "vocals_off": (503, "vocals_disabled", ("vocals",)),
}
CASES = [(condition, entry) for condition in REFUSAL for entry in ENTRIES]


def used(env: SimpleNamespace, uid: str = "alice") -> dict[str, int]:
    usage = env.jobs.quotas.usage(uid)
    return {"analyses": usage["analyses"]["used"], "vocals": usage["vocals"]["used"]}


def listed(env: SimpleNamespace) -> list[str]:
    return [j["id"] for j in env.client.get("/api/jobs", headers=H("alice")).json()]


@pytest.mark.parametrize(("condition", "entry"), CASES, ids=[f"{c}-{e}" for c, e in CASES])
def test_entry_is_refused_or_accepted_by_the_gate(make_cloud, media, condition: str, entry: str) -> None:
    """AC-18 / AC-26 / AC-27 / AC-28: a refusal spends nothing, starts nothing and says nothing of the admin's
    reason; an entry the condition does not concern is accepted and spends its quota unit as before."""
    env = with_track(make_env(make_cloud), media)
    before, jobs_before, runs_before = used(env), listed(env), len(env.engine.calls)
    CONDITIONS[condition](env)
    call, spends = ENTRIES[entry]
    status, code, refused = REFUSAL[condition]
    res = call(env, media)
    if entry in refused:
        body = assert_error(res, status, code)
        assert REASON not in res.text and "admin" not in body["detail"].lower()
        assert used(env) == before and listed(env) == jobs_before and len(env.engine.calls) == runs_before
    else:
        assert res.status_code == 201, res.text
        assert used(env)[spends] == before[spends] + 1


@needs_ffmpeg
def test_refusal_never_creates_the_quota_file(make_cloud, media) -> None:
    env = make_env(make_cloud)
    restrict(env)
    assert_error(enter_upload(env, media), 403, "cloud_restricted")
    assert_error(enter_url(env, media), 403, "cloud_restricted")
    assert not (env.settings.users_dir / "alice" / "quota.json").exists()
    assert env.jobs.quotas.usage("alice")["analyses"]["used"] == 0


def test_a_tab_recording_of_a_youtube_video_is_not_a_link_analysis(make_cloud, media) -> None:
    """AC-27 concerns the server downloading from YouTube; a recording of the tab (origin tab) is a file."""
    env = make_env(make_cloud)
    youtube_off(env)
    path = env.gcs.put("users/alice/uploads/t1/rec.webm", media.a.read_bytes(), content_type="audio/webm")
    res = env.client.post("/api/jobs/storage", headers=H("alice"), json={
        "path": path, "source": {"type": "youtube", "videoId": VIDEO_ID}})
    assert res.status_code == 201, res.text
    assert used(env)["analyses"] == 1


def test_other_users_are_not_affected_by_one_restriction(make_cloud, media) -> None:
    env = make_env(make_cloud)
    restrict(env)
    assert_error(enter_upload(env, media), 403, "cloud_restricted")
    res = upload(env.client, media.b, H("bob"))
    assert res.status_code == 201, res.text


def test_refusal_order_is_restriction_then_switches_then_limit(make_cloud, media) -> None:
    """ADR-0008: restriction/deletion -> switches -> effective limit -> consume."""
    env = make_env(make_cloud, quota_analyses=1)
    with_track(env, media)  # alice's one analysis of the day is spent
    assert_error(enter_upload(env, media), 429, "quota_exceeded")
    pause(env)
    assert_error(enter_upload(env, media), 503, "analyses_paused")  # the pause is told before the exhausted quota
    restrict(env)
    assert_error(enter_upload(env, media), 403, "cloud_restricted")  # and the restriction before the pause
    youtube_off(env)
    set_config(env, analysesPaused=False)
    set_account(env, restriction=None)
    assert_error(enter_url(env, media), 503, "youtube_disabled")  # the switch before the exhausted quota
    assert used(env)["analyses"] == 1


# --------------------------------------------------------------------------- accepted jobs finish (AC-19, AC-26, AC-27, AC-28)


@pytest.mark.parametrize("condition", ["restriction", "deletion", "pause", "youtube_off"])
def test_a_job_accepted_before_the_condition_completes(make_cloud, media, condition: str) -> None:
    env = make_env(make_cloud)
    env.engine.gate = threading.Event()
    res = enter_upload(env, media)
    assert res.status_code == 201, res.text
    CONDITIONS[condition](env)
    env.engine.gate.set()
    done = wait_job(env.client, res.json()["id"], H("alice"))
    assert done["status"] == "done", done
    assert env.client.get(f"/api/tracks/{done['trackId']}", headers=H("alice")).status_code == 200


def test_a_vocals_job_accepted_before_the_switch_completes(make_cloud, media) -> None:
    env = with_track(make_env(make_cloud), media)
    release = threading.Event()

    def transcriber(audio, stems_dir, progress, options):
        assert release.wait(10)
        raise RuntimeError("finished by the fake")

    env.jobs.vocal_transcriber = transcriber
    res = enter_vocals(env, media)
    assert res.status_code == 201, res.text
    vocals_off(env)
    release.set()
    done = wait_job(env.client, res.json()["id"], H("alice"))
    assert done["status"] == "error" and done["errorCode"] != "vocals_disabled"  # it ran: the switch did not stop it


def test_a_restricted_user_keeps_the_library(make_cloud, media) -> None:
    """AC-18: the library works as before: songs are listed and read, chords edited, the song deleted."""
    env = with_track(make_env(make_cloud), media)
    restrict(env)
    c = env.client
    assert [t["id"] for t in c.get("/api/tracks", headers=H("alice")).json()] == [env.track]
    assert c.get(f"/api/tracks/{env.track}", headers=H("alice")).status_code == 200
    assert c.patch(f"/api/tracks/{env.track}", json={"title": "Mine"}, headers=H("alice")).json()["title"] == "Mine"
    assert c.delete(f"/api/tracks/{env.track}", headers=H("alice")).status_code == 204


# --------------------------------------------------------------------------- effective limits (AC-13, AC-13b, AC-15, AC-24)


def limits(a: int = 40, v: int = 15, j: int = 2):
    from app.admin.models import DefaultLimitsIn

    return DefaultLimitsIn(analyses=a, vocals=v, jobs=j, max_duration_min=30, max_upload_mb=500)


def test_effective_limit_uses_personal_value_for_set_fields_only() -> None:
    from app.quotas import effective_limits

    eff = effective_limits(limits(), {"analyses": 100}, "2026-10-08")
    assert (eff.analyses, eff.vocals, eff.jobs) == (100, 15, 2)  # AC-13: transcriptions and parallel jobs stay default


def test_personal_value_wins_even_below_default_and_unset_field_follows_default() -> None:
    from app.quotas import effective_limits

    personal = {"analyses": 5}
    eff = effective_limits(limits(a=40, v=15), personal, "2026-10-08")
    assert (eff.analyses, eff.vocals) == (5, 15)
    eff = effective_limits(limits(a=40, v=10), personal, "2026-10-08")  # the default vocal limit changes to 10
    assert (eff.analyses, eff.vocals) == (5, 10)


def test_personal_limit_applies_through_end_date_inclusive_in_utc() -> None:
    from app.quotas import effective_limits

    personal = {"analyses": 100, "vocals": 50, "jobs": 4, "until": "2026-10-07"}
    last_day = effective_limits(limits(), personal, "2026-10-07")
    assert (last_day.analyses, last_day.vocals, last_day.jobs) == (100, 50, 4)
    next_day = effective_limits(limits(), personal, "2026-10-08")  # 00:00:00 UTC of the day after
    assert (next_day.analyses, next_day.vocals, next_day.jobs) == (40, 15, 2)
    no_end = effective_limits(limits(), {"analyses": 100}, "2099-01-01")
    assert no_end.analyses == 100


@pytest.mark.parametrize("junk", [None, {}, {"analyses": 0}, {"analyses": -3}, {"analyses": "9"}, {"analyses": True},
                                  {"until": "not a date", "analyses": 9}, "text", 7])
def test_a_personal_limit_that_does_not_make_sense_leaves_the_default(junk: Any) -> None:
    from app.quotas import effective_limits

    eff = effective_limits(limits(), junk, "2026-10-08")
    assert (eff.analyses, eff.vocals, eff.jobs) == (40, 15, 2)


def test_personal_limit_lets_the_user_run_more_than_the_default(make_cloud, media) -> None:
    """AC-13: default 1 analysis a day, personal 3: three are accepted, the fourth is not; vocals stay default."""
    env = make_env(make_cloud, quota_analyses=1, quota_vocals=1)
    set_account(env, personalLimit={"analyses": 3, "setAt": SINCE, "byAdminUid": ADMIN})
    for name in ("a", "b", "c"):
        upload_and_wait(env, getattr(media, name), "alice")
    track = env.client.get("/api/tracks", headers=H("alice")).json()[0]["id"]
    assert_error(env.client.post(f"/api/tracks/{track}/reanalyze", headers=H("alice")), 429, "quota_exceeded")
    assert env.client.get("/api/me", headers=H("alice")).json()["quotas"]["analyses"] == {"used": 3, "limit": 3}
    assert enter_vocals_for(env, track).status_code == 201
    assert_error(enter_vocals_for(env, track), 429, "quota_exceeded")


def enter_vocals_for(env: SimpleNamespace, track: str):
    return env.client.post(f"/api/tracks/{track}/vocals", json={"force": True}, headers=H("alice"))


def test_changing_the_default_vocal_limit_applies_to_an_unset_personal_field(make_cloud, media) -> None:
    """AC-13b: personal 1 analysis (below the default), default vocals 3 -> 1: 1 analysis and 1 transcription."""
    env = make_env(make_cloud, quota_analyses=6, quota_vocals=3)
    set_account(env, personalLimit={"analyses": 1, "setAt": SINCE, "byAdminUid": ADMIN})
    job, _ = upload_and_wait(env, media.a, "alice")
    assert_error(enter_upload(env, media), 429, "quota_exceeded")  # 5 of 6 would be left by default: personal wins
    set_config(env, limits={"vocals": 1})
    assert enter_vocals_for(env, job["trackId"]).status_code == 201
    assert_error(enter_vocals_for(env, job["trackId"]), 429, "quota_exceeded")
    assert env.client.get("/api/me", headers=H("alice")).json()["quotas"]["vocals"] == {"used": 1, "limit": 1}


def test_expired_personal_limit_falls_back_to_the_default(make_cloud, media) -> None:
    """AC-15: personal 100 until yesterday, default 1: the second analysis of today is refused."""
    env = make_env(make_cloud, quota_analyses=1)
    set_account(env, personalLimit={"analyses": 100, "until": yesterday(), "setAt": SINCE, "byAdminUid": ADMIN})
    upload_and_wait(env, media.a, "alice")
    assert_error(enter_upload(env, media), 429, "quota_exceeded")
    assert env.client.get("/api/me", headers=H("alice")).json()["quotas"]["analyses"] == {"used": 1, "limit": 1}


def test_personal_limit_on_its_last_day_still_applies(make_cloud, media) -> None:
    env = make_env(make_cloud, quota_analyses=1)
    set_account(env, personalLimit={"analyses": 2, "until": today(), "setAt": SINCE, "byAdminUid": ADMIN})
    upload_and_wait(env, media.a, "alice")
    assert enter_upload(env, media).status_code == 201


def test_a_personal_concurrent_jobs_limit_applies(make_cloud, media) -> None:
    env = make_env(make_cloud, max_user_jobs=1)
    set_account(env, personalLimit={"jobs": 2, "setAt": SINCE, "byAdminUid": ADMIN})
    env.engine.gate = threading.Event()
    assert enter_upload(env, media).status_code == 201
    assert enter_storage(env, media).status_code == 201  # a second parallel job: allowed by the personal limit
    assert_error(enter_url(env, media), 429, "quota_exceeded")  # a third is not
    assert env.client.get("/api/me", headers=H("alice")).json()["quotas"]["jobs"]["limit"] == 2
    env.engine.gate.set()


# --------------------------------------------------------------------------- the 60 s cache (AC-16, AC-24, NFR)


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class CountingDb(MemDb):
    def __init__(self) -> None:
        super().__init__()
        self.read_paths: list[str] = []

    def get(self, path: str):
        self.read_paths.append(path)
        return super().get(path)


@pytest.fixture
def unit(tmp_path: Path):
    """``Admission`` + ``Quotas`` over a counting in-memory database with a fake clock (no app, no HTTP)."""
    from app.admin.settings import RuntimeSettings
    from app.admission import Admission
    from app.quotas import Quotas

    clock, db = Clock(), CountingDb()
    settings = Settings(data_dir=tmp_path / "data", auth="firebase", quota_analyses=40, quota_vocals=15, max_user_jobs=2)
    runtime = RuntimeSettings(db, env=lambda: settings, monotonic=clock)
    admission = Admission(db, runtime, monotonic=clock)
    quotas = Quotas(settings, TrackStore(settings), limits=admission)
    return SimpleNamespace(clock=clock, db=db, runtime=runtime, admission=admission, quotas=quotas, settings=settings)


def code_of(call: Callable[[], Any]) -> Optional[str]:
    try:
        call()
    except SourceError as exc:
        return exc.code
    return None


def check(unit, kind: str = "analysis", origin: str = "file", running: int = 0, uid: str = "alice") -> None:
    unit.admission.check(uid, kind, origin, running=running, quotas=unit.quotas)


def test_a_restriction_takes_effect_within_a_minute(unit) -> None:
    check(unit)
    unit.db.docs["adminAccounts/alice"] = {"restriction": dict(RESTRICTION), "deletion": None, "personalLimit": None}
    unit.clock.advance(59)
    check(unit)  # still the cached state: the change is allowed up to 60 s
    unit.clock.advance(2)
    assert code_of(lambda: check(unit)) == "cloud_restricted"


def test_a_lifted_restriction_takes_effect_within_a_minute(unit) -> None:
    unit.db.docs["adminAccounts/alice"] = {"restriction": dict(RESTRICTION), "deletion": None, "personalLimit": None}
    assert code_of(lambda: check(unit)) == "cloud_restricted"
    del unit.db.docs["adminAccounts/alice"]
    unit.clock.advance(61)
    check(unit)


def test_a_personal_limit_and_a_default_limit_change_take_effect_within_a_minute(unit) -> None:
    for _ in range(40):
        check(unit)
    assert code_of(lambda: check(unit)) == "quota_exceeded"
    unit.db.docs["adminAccounts/alice"] = {"restriction": None, "deletion": None, "personalLimit": {"analyses": 41}}
    unit.clock.advance(61)
    check(unit)  # the personal limit is seen
    unit.db.docs["adminAccounts/alice"] = {"restriction": None, "deletion": None, "personalLimit": None}
    unit.db.docs["adminConfig/settings"] = {
        "limits": {"analyses": 30, "vocals": 15, "jobs": 2, "maxDurationMin": 30, "maxUploadMb": 500},
        "switches": {"analysesPaused": False, "youtubeEnabled": True, "vocalsEnabled": True}}
    unit.clock.advance(61)
    assert unit.quotas.effective_limits("alice").analyses == 30  # AC-24: the new default, no redeploy


def test_the_state_of_an_account_is_read_once_a_minute(unit) -> None:
    for _ in range(5):
        check(unit)
    assert unit.db.read_paths.count("adminAccounts/alice") == 1
    assert unit.db.read_paths.count("adminTombstones/alice") == 1
    unit.clock.advance(61)
    check(unit)
    assert unit.db.read_paths.count("adminAccounts/alice") == 2


def test_a_purge_marker_refuses_within_a_minute(unit) -> None:
    check(unit)
    unit.db.docs["adminTombstones/alice"] = {"status": "purging"}
    unit.clock.advance(61)
    assert code_of(lambda: check(unit)) == "cloud_restricted"


def test_a_refusal_counts_nothing_in_the_quota_file(unit) -> None:
    unit.db.docs["adminAccounts/alice"] = {"restriction": dict(RESTRICTION)}
    for kind, origin in (("analysis", "link"), ("analysis", "file"), ("reanalysis", "link"), ("vocals", "tab")):
        assert code_of(lambda: check(unit, kind, origin)) == "cloud_restricted"
    assert unit.quotas.usage("alice")["analyses"]["used"] == 0
    assert not (unit.settings.users_dir / "alice" / "quota.json").exists()


def test_the_gate_serves_the_last_known_state_when_the_database_is_down(unit) -> None:
    unit.db.docs["adminAccounts/alice"] = {"restriction": dict(RESTRICTION)}
    assert code_of(lambda: check(unit)) == "cloud_restricted"
    real_get = unit.db.get

    def down(path: str):
        raise OSError("firestore is down")

    unit.db.get = down  # type: ignore[method-assign]
    unit.clock.advance(120)
    assert code_of(lambda: check(unit)) == "cloud_restricted"  # the old verdict, not a free pass
    unit.db.get = real_get  # type: ignore[method-assign]


def test_without_any_known_state_and_a_database_that_is_down_the_job_is_not_accepted(unit) -> None:
    def down(path: str):
        raise OSError("firestore is down")

    unit.db.get = down  # type: ignore[method-assign]
    with pytest.raises(SourceError) as info:
        check(unit)
    assert info.value.status == 503
    assert not (unit.settings.users_dir / "alice" / "quota.json").exists()  # nothing was counted
    shown = unit.quotas.usage("alice")  # what the user is shown does not fail: it falls back to the env limits
    assert shown["analyses"] == {"used": 0, "limit": 40} and shown["jobs"] == {"limit": 2}


# --------------------------------------------------------------------------- reset and admission (AC-12b)


def test_reset_then_admission_counts_the_analysis_after_the_reset(unit) -> None:
    for _ in range(3):
        check(unit)
    assert unit.quotas.reset("alice") == {"analyses": 3, "vocals": 0}
    check(unit)
    assert unit.quotas.usage("alice")["analyses"]["used"] == 1


def test_admission_then_reset_leaves_nothing(unit) -> None:
    check(unit)
    unit.quotas.reset("alice")
    assert unit.quotas.usage("alice")["analyses"]["used"] == 0
    stored = json.loads((unit.settings.users_dir / "alice" / "quota.json").read_text())
    assert stored["analyses"] == 0 and stored["vocals"] == 0


def test_reset_returns_the_old_counters_and_leaves_other_users_and_a_new_day(unit) -> None:
    check(unit, uid="alice")
    check(unit, "vocals", uid="alice")
    check(unit, uid="bob")
    assert unit.quotas.reset("alice") == {"analyses": 1, "vocals": 1}
    assert unit.quotas.reset("alice") == {"analyses": 0, "vocals": 0}  # repeating is harmless
    assert unit.quotas.usage("bob")["analyses"]["used"] == 1


def test_quota_reset_and_concurrent_admission_never_lose_an_analysis(unit) -> None:
    """Both orders of every race end with usage = the analyses accepted after the reset (what the file says too)."""
    order: list[int] = []  # the analyses counter as saved, in lock order: 0 is the reset
    real_save = unit.quotas._save

    def spy(uid: str, counters: dict) -> None:
        order.append(counters["analyses"])
        real_save(uid, counters)

    unit.quotas._save = spy  # type: ignore[method-assign]
    for _ in range(5):
        check(unit)
    start = threading.Barrier(9)

    def admit() -> None:
        start.wait()
        for _ in range(3):
            check(unit)

    def reset() -> None:
        start.wait()
        unit.quotas.reset("alice")

    threads = [threading.Thread(target=admit) for _ in range(8)] + [threading.Thread(target=reset)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    spent_after_reset = len(order) - 1 - max(i for i, v in enumerate(order) if v == 0)
    assert order.count(0) == 1 and len(order) == 5 + 24 + 1
    assert unit.quotas.usage("alice")["analyses"]["used"] == spent_after_reset
    stored = json.loads((unit.settings.users_dir / "alice" / "quota.json").read_text())
    assert stored["analyses"] == spent_after_reset


# --------------------------------------------------------------------------- not cloud / not gated


def test_local_mode_has_no_gate(tmp_path: Path, media) -> None:
    from fastapi.testclient import TestClient

    from app.main import create_app
    from test_cloud import ENGINE_INFO, FakeEngine

    settings = Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist", scratch_dir=tmp_path / "s",
                        allowed_hosts=("testserver", "localhost"))
    app = create_app(settings, analyzer=FakeEngine(), engine_info_fn=lambda: ENGINE_INFO)
    assert app.state.admission is None
    with TestClient(app) as c:
        with open(media.a, "rb") as fh:
            res = c.post("/api/jobs/upload", files={"file": ("a.mp3", fh, "audio/mpeg")})
        assert res.status_code == 201, res.text


def test_quota_helpers_for_feature_code_still_work_without_the_gate(tmp_path: Path) -> None:
    """``JobManager.admit`` keeps working for a manager built without admin state (quota only)."""
    from app.jobs import JobManager

    settings = Settings(data_dir=tmp_path / "data", auth="firebase", quota_vocals=1)
    jobs = JobManager(settings, TrackStore(settings), fetcher=None)  # type: ignore[arg-type]
    with user_context("carol"):
        jobs.admit("vocals")
        with pytest.raises(SourceError) as info:
            jobs.admit("vocals")
        assert info.value.code == "quota_exceeded"
    jobs.shutdown()

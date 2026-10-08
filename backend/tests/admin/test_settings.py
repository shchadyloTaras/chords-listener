"""Runtime settings (ADR-0005, data-model Aggregate 6): the 30 s lazy cache, the env fallback and the writers of
``adminConfig/settings`` and its public mirror ``publicStatus/current`` (AC-24, AC-27, AC-29).

Unit tests run on ``MemDb`` (it applies the real REST write bodies, update masks included); the last test runs the
same write -> read flow on the Firestore emulator (only when FIRESTORE_EMULATOR_HOST is set)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from admin.fixtures import MemDb
from app.admin import settings as settings_mod
from app.admin.models import BannerIn, DefaultLimitsIn
from app.admin.settings import CACHE_TTL_S, PUBLIC_FIELDS, PublicStatus, RuntimeSettings
from app.firestore import IndexError_
from app.models import Settings as EnvSettings

SETTINGS = "adminConfig/settings"
PUBLIC = "publicStatus/current"
STAMP = "2026-10-07T12:00:00Z"

STORED_LIMITS = {"analyses": 30, "vocals": 10, "jobs": 3, "maxDurationMin": 20, "maxUploadMb": 100}
OFF = {"analysesPaused": False, "youtubeEnabled": True, "vocalsEnabled": True}


def env() -> EnvSettings:
    return EnvSettings(quota_analyses=40, quota_vocals=15, max_user_jobs=2, max_duration_min=15.0, max_upload_mb=50.0)


class Clock:
    def __init__(self) -> None:
        self.mono = 1000.0

    def advance(self, seconds: float) -> None:
        self.mono += seconds


@pytest.fixture
def db() -> MemDb:
    return MemDb()


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def rs(db, clock) -> RuntimeSettings:
    return RuntimeSettings(db, env=env, monotonic=lambda: clock.mono)


@pytest.fixture
def ps(db) -> PublicStatus:
    return PublicStatus(db)


def seed_settings(db: MemDb, **over: Any) -> None:
    db.docs[SETTINGS] = {"limits": dict(STORED_LIMITS), "switches": dict(OFF), "updatedBy": "admin-1",
                         "updatedAt": STAMP, **over}


def seed_public(db: MemDb, **over: Any) -> None:
    db.docs[PUBLIC] = {"banner": {"enabled": False, "uk": "", "en": ""}, "switches": dict(OFF),
                       "updatedAt": STAMP, **over}


def commit(db: MemDb, *ops: dict) -> None:
    db.commit(list(ops))


def reads(db: MemDb) -> int:
    return sum(db.reads.values())


LIMITS30 = DefaultLimitsIn(analyses=30, vocals=15, jobs=2, max_duration_min=15, max_upload_mb=50)


# ===================================================================== env fallback (ADR-0005)


def test_env_values_are_used_only_while_the_settings_document_is_absent(db, rs):
    cur = rs.current()
    assert cur.limits.analyses == 40 and cur.limits.vocals == 15 and cur.limits.jobs == 2
    assert cur.limits.max_duration_min == 15 and cur.limits.max_upload_mb == 50
    assert (cur.switches.analyses_paused, cur.switches.youtube_enabled, cur.switches.vocals_enabled) == (False, True, True)
    assert cur.banner.enabled is False
    assert cur.updated_by is None

    seed_settings(db)
    rs.invalidate()
    cur = rs.current()
    assert (cur.limits.analyses, cur.limits.vocals, cur.limits.jobs) == (30, 10, 3)
    assert cur.limits.max_duration_min == 20 and cur.limits.max_upload_mb == 100
    assert cur.updated_by == "admin-1"


def test_env_values_outside_the_admin_ranges_are_clamped_like_the_seed(db, clock):
    wild = EnvSettings(quota_analyses=0, quota_vocals=9999, max_user_jobs=1, max_duration_min=0.2, max_upload_mb=900.0)
    cur = RuntimeSettings(db, env=lambda: wild, monotonic=lambda: clock.mono).current()
    assert (cur.limits.analyses, cur.limits.vocals, cur.limits.jobs) == (1, 150, 1)
    assert (cur.limits.max_duration_min, cur.limits.max_upload_mb) == (1, 512)


def test_a_stored_limits_map_that_is_out_of_range_falls_back_to_env_not_to_a_crash(db, rs):
    seed_settings(db, limits={"analyses": 0, "vocals": 10})
    cur = rs.current()
    assert cur.limits.analyses == 40 and cur.limits.jobs == 2


def test_a_missing_switch_in_the_stored_map_takes_its_default(db, rs):
    seed_settings(db, switches={"youtubeEnabled": False})
    sw = rs.current().switches
    assert (sw.analyses_paused, sw.youtube_enabled, sw.vocals_enabled) == (False, False, True)


def test_the_banner_comes_from_the_public_document(db, rs):
    seed_settings(db)
    seed_public(db, banner={"enabled": True, "uk": "Технічні роботи", "en": "Maintenance"})
    banner = rs.current().banner
    assert (banner.enabled, banner.uk, banner.en) == (True, "Технічні роботи", "Maintenance")


# ===================================================================== AC-24: 30 s lazy cache, no polling


def test_a_value_read_once_is_served_from_memory_for_30_seconds(db, rs, clock):
    seed_settings(db)
    rs.current()
    first = reads(db)
    assert first >= 1
    for _ in range(5):
        clock.advance(CACHE_TTL_S / 6)
        rs.current()
    assert reads(db) == first


def test_a_settings_change_is_seen_after_the_ttl_without_a_redeploy_or_invalidate(db, rs, clock):
    """AC-24: 40 -> 30 is seen by the server within the 30 s TTL (<= 60 s budget) on the very next read."""
    seed_settings(db, limits={**STORED_LIMITS, "analyses": 40})
    assert rs.current().limits.analyses == 40
    commit(db, *rs.write_ops(limits=LIMITS30, updated_by="admin-1"))
    clock.advance(CACHE_TTL_S - 1)
    assert rs.current().limits.analyses == 40            # still inside the TTL: the old value may be served
    clock.advance(1.1)
    assert rs.current().limits.analyses == 30


def test_nothing_is_read_in_the_background(db, rs, clock):
    seed_settings(db)
    rs.current()
    seen = reads(db)
    clock.advance(10 * 60)                               # ten minutes pass with nobody asking
    assert reads(db) == seen
    rs.current()                                         # only a caller triggers the refresh
    assert reads(db) > seen


def test_invalidate_makes_the_next_read_fresh(db, rs):
    seed_settings(db)
    rs.current()
    commit(db, *rs.write_ops(limits=LIMITS30))
    rs.invalidate()
    assert rs.current().limits.analyses == 30


def test_a_failed_refresh_keeps_serving_the_last_known_values(db, rs, clock, monkeypatch):
    seed_settings(db)
    rs.current()
    clock.advance(CACHE_TTL_S + 1)
    calls = []

    def boom(path):
        calls.append(path)
        raise IndexError_("firestore down", retryable=True)

    monkeypatch.setattr(db, "get", boom)
    assert rs.current().limits.analyses == 30
    seen = len(calls)
    assert seen >= 1
    rs.current()                                          # does not hammer a failing backend on every call
    assert len(calls) == seen


def test_a_failed_first_read_is_not_hidden(db, rs, monkeypatch):
    def boom(path):
        raise IndexError_("firestore down", retryable=True)

    monkeypatch.setattr(db, "get", boom)
    with pytest.raises(IndexError_):
        rs.current()


# ===================================================================== settings writer (ops only; T23 adds the audit)


def test_limits_op_masks_only_the_limit_fields_and_the_stamp(db, rs):
    (op,) = rs.write_ops(limits=LIMITS30, updated_by="admin-1")
    assert op["update"]["name"].endswith("/documents/" + SETTINGS)
    assert sorted(op["updateMask"]["fieldPaths"]) == sorted(
        ["limits.analyses", "limits.vocals", "limits.jobs", "limits.maxDurationMin", "limits.maxUploadMb", "updatedBy"])
    assert op["updateTransforms"] == [{"fieldPath": "updatedAt", "setToServerValue": "REQUEST_TIME"}]


def test_a_limits_write_does_not_clobber_the_switches_and_vice_versa(db, rs):
    seed_settings(db, switches={"analysesPaused": True, "youtubeEnabled": False, "vocalsEnabled": True})
    commit(db, *rs.write_ops(limits=LIMITS30, updated_by="admin-2"))
    assert db.docs[SETTINGS]["switches"] == {"analysesPaused": True, "youtubeEnabled": False, "vocalsEnabled": True}
    assert db.docs[SETTINGS]["limits"]["analyses"] == 30 and db.docs[SETTINGS]["updatedBy"] == "admin-2"

    commit(db, *rs.write_ops(switches={"vocalsEnabled": False}, updated_by="admin-3"))
    assert db.docs[SETTINGS]["switches"] == {"analysesPaused": True, "youtubeEnabled": False, "vocalsEnabled": False}
    assert db.docs[SETTINGS]["limits"]["analyses"] == 30


def test_a_switch_op_masks_only_the_switch_it_changes(rs):
    (op,) = rs.write_ops(switches={"youtubeEnabled": False}, updated_by="admin-1")
    assert sorted(op["updateMask"]["fieldPaths"]) == ["switches.youtubeEnabled", "updatedBy"]


def test_the_settings_writer_rejects_an_empty_unknown_or_non_boolean_change(rs):
    with pytest.raises(ValueError):
        rs.write_ops()
    with pytest.raises(ValueError):
        rs.write_ops(switches={"limits": True})
    with pytest.raises(ValueError):
        rs.write_ops(switches={"youtubeEnabled": "no"})


# ===================================================================== AC-27 / AC-29: public status mirror


def test_banner_write_does_not_clobber_switches_and_vice_versa(db, ps):
    seed_public(db, switches={"analysesPaused": False, "youtubeEnabled": False, "vocalsEnabled": True})
    banner = BannerIn(enabled=True, uk="Технічні роботи", en="Maintenance")
    (op,) = ps.write_ops(banner=banner)
    assert sorted(op["updateMask"]["fieldPaths"]) == ["banner.en", "banner.enabled", "banner.uk"]
    assert op["updateTransforms"] == [{"fieldPath": "updatedAt", "setToServerValue": "REQUEST_TIME"}]
    commit(db, op)
    assert db.docs[PUBLIC]["banner"] == {"enabled": True, "uk": "Технічні роботи", "en": "Maintenance"}
    assert db.docs[PUBLIC]["switches"] == {"analysesPaused": False, "youtubeEnabled": False, "vocalsEnabled": True}

    commit(db, *ps.write_ops(switches={"youtubeEnabled": True}))
    assert db.docs[PUBLIC]["switches"]["youtubeEnabled"] is True
    assert db.docs[PUBLIC]["banner"] == {"enabled": True, "uk": "Технічні роботи", "en": "Maintenance"}


def test_a_switch_mirror_op_masks_only_the_switches_it_changes(ps):
    (op,) = ps.write_ops(switches={"youtubeEnabled": False, "vocalsEnabled": False})
    assert sorted(op["updateMask"]["fieldPaths"]) == ["switches.vocalsEnabled", "switches.youtubeEnabled"]
    assert op["update"]["name"].endswith("/documents/" + PUBLIC)


def test_the_public_document_allows_only_banner_switches_and_updated_at():
    assert PUBLIC_FIELDS == frozenset({"banner", "switches", "updatedAt"})


def test_the_public_writer_refuses_any_field_outside_the_allowlist(ps):
    for data, mask in [
        ({"limits": {"analyses": 30}}, ["limits.analyses"]),
        ({"updatedBy": "admin-1"}, ["updatedBy"]),
        ({"banner": {"enabled": True, "uk": "a", "en": "b", "email": "x@example.test"}}, ["banner.email"]),
        ({"switches": {"debug": True}}, ["switches.debug"]),
        ({"banner": {"enabled": True}}, ["banner.enabled", "adminEmail"]),
    ]:
        with pytest.raises(ValueError):
            ps.build_op(data, mask)


def test_the_public_writer_never_writes_a_limit_or_an_uid(ps):
    banner = BannerIn(enabled=True, uk="a", en="b")
    for op in (ps.write_ops(banner=banner)[0], ps.write_ops(switches={"analysesPaused": True})[0]):
        assert set(op["update"]["fields"]) <= PUBLIC_FIELDS
        assert {p.split(".")[0] for p in op["updateMask"]["fieldPaths"]} <= PUBLIC_FIELDS


def test_the_public_writer_rejects_an_empty_or_unknown_change(ps):
    with pytest.raises(ValueError):
        ps.write_ops()
    with pytest.raises(ValueError):
        ps.write_ops(switches={"limits": True})
    with pytest.raises(ValueError):
        ps.write_ops(banner={"enabled": True, "uk": "", "en": "x"})      # an invalid banner is not mirrored


def test_a_banner_given_as_a_plain_mapping_is_validated_and_written(db, ps):
    seed_public(db)
    commit(db, *ps.write_ops(banner={"enabled": True, "uk": "a", "en": "b"}))
    assert db.docs[PUBLIC]["banner"] == {"enabled": True, "uk": "a", "en": "b"}


def test_the_module_names_the_collections_it_touches():
    assert settings_mod.SETTINGS_PATH == SETTINGS and settings_mod.PUBLIC_STATUS_PATH == PUBLIC


# ===================================================================== emulator


def test_write_then_read_on_the_emulator(admin_db, clock):
    rs = RuntimeSettings(admin_db, env=env, monotonic=lambda: clock.mono)
    ps = PublicStatus(admin_db)
    admin_db.commit([admin_db.delete_op(SETTINGS), admin_db.delete_op(PUBLIC)])
    try:
        assert rs.current().limits.analyses == 40                       # absent: env
        admin_db.commit([
            admin_db.update_op(SETTINGS, {"limits": STORED_LIMITS, "switches": OFF, "updatedBy": None,
                                          "updatedAt": datetime(2026, 10, 7, tzinfo=timezone.utc)}),
            admin_db.update_op(PUBLIC, {"banner": {"enabled": False, "uk": "", "en": ""}, "switches": OFF,
                                        "updatedAt": datetime(2026, 10, 7, tzinfo=timezone.utc)}),
        ])
        admin_db.commit([*rs.write_ops(limits=LIMITS30, switches={"youtubeEnabled": False}, updated_by="admin-1"),
                         *ps.write_ops(banner=BannerIn(enabled=True, uk="Привіт", en="Hi")),
                         *ps.write_ops(switches={"youtubeEnabled": False})])
        clock.advance(CACHE_TTL_S + 1)
        cur = rs.current()
        assert cur.limits.analyses == 30 and cur.limits.vocals == 15 and cur.switches.youtube_enabled is False
        assert cur.banner.enabled and cur.banner.uk == "Привіт" and cur.updated_by == "admin-1"
        public = admin_db.get(PUBLIC).data
        assert set(public) == set(PUBLIC_FIELDS)
        assert public["switches"] == {**OFF, "youtubeEnabled": False}
    finally:
        admin_db.commit([admin_db.delete_op(SETTINGS), admin_db.delete_op(PUBLIC)])

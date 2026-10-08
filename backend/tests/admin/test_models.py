"""Admin request/response models: the validation ranges of spec AC-04 / AC-09 / AC-14 / AC-25 / AC-30
and a guard that the models mirror docs/features/admin/contracts/openapi.yaml."""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from app.admin import models as m

OPENAPI = Path(__file__).resolve().parents[3] / "docs" / "features" / "admin" / "contracts" / "openapi.yaml"
TODAY = date(2026, 10, 8)


@pytest.fixture(autouse=True)
def frozen_today(monkeypatch: pytest.MonkeyPatch) -> date:
    """The clock the date rules read ("today", UTC) is controllable, so both sides of midnight are testable."""
    monkeypatch.setattr(m, "today_utc", lambda: TODAY)
    return TODAY


def fields_of(exc: ValidationError) -> set[str]:
    return {".".join(str(p) for p in e["loc"]) for e in exc.errors()}


# --------------------------------------------------------------------------- AC-04: user search text


@pytest.mark.parametrize("q", ["", "a", "iv", "  iv  ", "   "])
def test_search_shorter_than_3_characters_is_not_executed(q: str) -> None:
    with pytest.raises(ValidationError):
        m.UserSearchQuery(q=q)


@pytest.mark.parametrize("q", ["ivn", "ivan", "x+<b>@example.test", "a" * 254])
def test_search_of_3_to_254_characters_is_accepted(q: str) -> None:
    assert m.UserSearchQuery(q=q).q == q


def test_search_longer_than_254_characters_is_rejected() -> None:
    with pytest.raises(ValidationError):
        m.UserSearchQuery(q="a" * 255)


def test_search_text_is_trimmed_before_counting() -> None:
    assert m.UserSearchQuery(q="  ivan ").q == "ivan"


# --------------------------------------------------------------------------- AC-09: stats period


def period(start: date, end: date) -> m.StatsPeriod:
    return m.StatsPeriod.model_validate({"from": start.isoformat(), "to": end.isoformat()})


def test_period_of_90_days_is_accepted() -> None:
    p = period(TODAY - timedelta(days=89), TODAY)  # 90 days, both ends included
    assert (p.to - p.from_).days == 89


def test_period_of_one_day_is_accepted() -> None:
    period(TODAY, TODAY)


def test_period_of_91_days_is_rejected() -> None:
    with pytest.raises(ValidationError):
        period(TODAY - timedelta(days=90), TODAY)


def test_period_ending_before_it_starts_is_rejected() -> None:
    with pytest.raises(ValidationError):
        period(TODAY, TODAY - timedelta(days=1))


def test_period_must_name_both_days() -> None:
    with pytest.raises(ValidationError):
        m.StatsPeriod.model_validate({"from": "2026-10-01"})


def test_period_rejection_is_an_invalid_period_error() -> None:
    """The route maps this to 422 invalid_period (not invalid_value)."""
    with pytest.raises(ValidationError) as ei:
        period(TODAY, TODAY - timedelta(days=1))
    assert any(isinstance(e.get("ctx", {}).get("error"), m.InvalidPeriod) for e in ei.value.errors())


# --------------------------------------------------------------------------- AC-14: personal limit

PERSONAL_RANGES = [("analyses", 1, 1000), ("vocals", 1, 150), ("jobs", 1, 4)]


@pytest.mark.parametrize(("field", "lo", "hi"), PERSONAL_RANGES)
def test_personal_limit_accepts_the_boundaries(field: str, lo: int, hi: int) -> None:
    for value in (lo, hi):
        assert getattr(m.PersonalLimitIn.model_validate({field: value}), field) == value


@pytest.mark.parametrize(("field", "lo", "hi"), PERSONAL_RANGES)
def test_personal_limit_rejects_just_outside_the_boundaries(field: str, lo: int, hi: int) -> None:
    for value in (lo - 1, hi + 1, -5):
        with pytest.raises(ValidationError) as ei:
            m.PersonalLimitIn.model_validate({field: value})
        assert field in fields_of(ei.value)


@pytest.mark.parametrize("field", ["analyses", "vocals", "jobs"])
@pytest.mark.parametrize("value", [1.5, "5", "abc", True, 2.0])
def test_personal_limit_rejects_a_non_integer(field: str, value: Any) -> None:
    with pytest.raises(ValidationError) as ei:
        m.PersonalLimitIn.model_validate({field: value})
    assert field in fields_of(ei.value)


@pytest.mark.parametrize("body", [{}, {"until": "2026-10-08"}, {"analyses": None, "vocals": None, "jobs": None}])
def test_personal_limit_needs_at_least_one_number(body: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        m.PersonalLimitIn.model_validate(body)


def test_personal_limit_all_three_at_the_upper_bounds_is_accepted() -> None:
    p = m.PersonalLimitIn.model_validate({"analyses": 1000, "vocals": 150, "jobs": 4})
    assert (p.analyses, p.vocals, p.jobs, p.until) == (1000, 150, 4, None)


def test_personal_limit_follows_the_default_for_an_unset_field() -> None:
    p = m.PersonalLimitIn.model_validate({"analyses": 100})
    assert p.vocals is None and p.jobs is None


def test_personal_limit_until_yesterday_is_rejected() -> None:
    with pytest.raises(ValidationError) as ei:
        m.PersonalLimitIn.model_validate({"analyses": 100, "until": (TODAY - timedelta(days=1)).isoformat()})
    assert "until" in fields_of(ei.value)


def test_personal_limit_until_today_is_accepted() -> None:
    assert m.PersonalLimitIn.model_validate({"analyses": 100, "until": TODAY.isoformat()}).until == TODAY


def test_personal_limit_until_tomorrow_and_absent_and_null_are_accepted() -> None:
    assert m.PersonalLimitIn.model_validate({"analyses": 1, "until": "2026-10-09"}).until == date(2026, 10, 9)
    assert m.PersonalLimitIn.model_validate({"analyses": 1}).until is None
    assert m.PersonalLimitIn.model_validate({"analyses": 1, "until": None}).until is None


def test_personal_limit_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        m.PersonalLimitIn.model_validate({"analyses": 1, "maxDurationMin": 5})


# --------------------------------------------------------------------------- AC-25: default limits

DEFAULT_RANGES = [
    ("analyses", 1, 1000),
    ("vocals", 1, 150),
    ("jobs", 1, 4),
    ("maxDurationMin", 1, 120),
    ("maxUploadMb", 1, 512),
]
VALID_DEFAULTS = {"analyses": 40, "vocals": 15, "jobs": 2, "maxDurationMin": 20, "maxUploadMb": 500}


@pytest.mark.parametrize(("field", "lo", "hi"), DEFAULT_RANGES)
def test_default_limits_accept_the_boundaries(field: str, lo: int, hi: int) -> None:
    for value in (lo, hi):
        m.DefaultLimitsIn.model_validate({**VALID_DEFAULTS, field: value})


@pytest.mark.parametrize(("field", "lo", "hi"), DEFAULT_RANGES)
def test_default_limits_reject_zero_negative_and_over_the_maximum(field: str, lo: int, hi: int) -> None:
    for value in (lo - 1, -1, hi + 1):
        with pytest.raises(ValidationError) as ei:
            m.DefaultLimitsIn.model_validate({**VALID_DEFAULTS, field: value})
        assert fields_of(ei.value) == {field}


@pytest.mark.parametrize("field", [f for f, _, _ in DEFAULT_RANGES])
@pytest.mark.parametrize("value", [None, "", 2.5, "7"])
def test_default_limits_reject_an_empty_or_non_integer_value(field: str, value: Any) -> None:
    with pytest.raises(ValidationError) as ei:
        m.DefaultLimitsIn.model_validate({**VALID_DEFAULTS, field: value})
    assert fields_of(ei.value) == {field}


@pytest.mark.parametrize("field", [f for f, _, _ in DEFAULT_RANGES])
def test_default_limits_need_all_five_values(field: str) -> None:
    body = {k: v for k, v in VALID_DEFAULTS.items() if k != field}
    with pytest.raises(ValidationError) as ei:
        m.DefaultLimitsIn.model_validate(body)
    assert fields_of(ei.value) == {field}


def test_default_limits_serialize_camel_case() -> None:
    assert m.DefaultLimitsIn.model_validate(VALID_DEFAULTS).model_dump() == VALID_DEFAULTS


# --------------------------------------------------------------------------- AC-30: banner


@pytest.mark.parametrize("lang", ["uk", "en"])
def test_banner_text_of_1_and_250_characters_is_accepted(lang: str) -> None:
    for text in ("x", "я" * 250):
        b = m.BannerIn.model_validate({"enabled": True, "uk": "ok", "en": "ok", lang: text})
        assert getattr(b, lang) == text


@pytest.mark.parametrize("lang", ["uk", "en"])
@pytest.mark.parametrize("bad", ["", "   ", "x" * 251])
def test_banner_text_empty_or_over_250_characters_is_rejected_in_either_language(lang: str, bad: str) -> None:
    with pytest.raises(ValidationError) as ei:
        m.BannerIn.model_validate({"enabled": True, "uk": "ok", "en": "ok", lang: bad})
    assert fields_of(ei.value) == {lang}


def test_banner_needs_both_languages_and_the_flag() -> None:
    for missing in ("enabled", "uk", "en"):
        body = {"enabled": True, "uk": "a", "en": "b"}
        del body[missing]
        with pytest.raises(ValidationError):
            m.BannerIn.model_validate(body)


# --------------------------------------------------------------------------- restriction / deletion


def test_restriction_reason_is_1_to_500_characters() -> None:
    assert m.RestrictionIn(reason="x").reason == "x"
    assert len(m.RestrictionIn(reason="x" * 500).reason) == 500
    for bad in ("", "  ", "x" * 501):
        with pytest.raises(ValidationError):
            m.RestrictionIn(reason=bad)


def test_deletion_needs_a_confirm_email_of_1_to_254_characters() -> None:
    assert m.DeletionIn.model_validate({"confirmEmail": "a@example.test"}).confirm_email == "a@example.test"
    for bad in ("", "x" * 255):
        with pytest.raises(ValidationError):
            m.DeletionIn.model_validate({"confirmEmail": bad})
    with pytest.raises(ValidationError):
        m.DeletionIn.model_validate({})


# --------------------------------------------------------------------------- responses

OVERVIEW = {
    "day": "2026-10-08",
    "analyses": {"link": 12, "file": 5, "mic": 1, "tab": 3},
    "vocals": 4,
    "failed": 2,
    "failedByReason": {"youtube_blocked": 1, "other": 1},
    "active": 7,
    "newUsers": 2,
    "runningJobs": [
        {
            "id": "a1b2c3d4e5f60718",
            "uid": "u-0000000001",
            "email": "user-1@example.test",
            "service": False,
            "kind": "analysis",
            "origin": "link",
            "acceptedAt": "2026-10-08T09:41:00Z",
        }
    ],
    "switches": {"analysesPaused": False, "youtubeEnabled": True, "vocalsEnabled": True},
}


def test_overview_round_trips_the_contract_example_in_camel_case() -> None:
    out = m.Overview.model_validate(OVERVIEW).model_dump(mode="json")
    assert out["failedByReason"] == {"youtube_blocked": 1, "other": 1}
    assert out["runningJobs"][0]["acceptedAt"].startswith("2026-10-08T09:41:00")
    assert out["switches"] == OVERVIEW["switches"]


def test_failure_reason_outside_the_fixed_list_is_rejected() -> None:
    with pytest.raises(ValidationError):
        m.Overview.model_validate({**OVERVIEW, "failedByReason": {"cosmic_rays": 1}})


def test_user_search_result_caps_items_at_50() -> None:
    item = {"uid": "u-1", "email": "a@example.test", "service": False}
    m.UserSearchResult.model_validate({"query": "abc", "items": [item] * 50, "truncated": False})
    with pytest.raises(ValidationError):
        m.UserSearchResult.model_validate({"query": "abc", "items": [item] * 51, "truncated": True})


def test_track_meta_page_carries_metadata_only() -> None:
    track = {
        "id": "t1",
        "title": "<script>alert(1)</script>",
        "sourceType": "youtube",
        "createdAt": "2026-10-08T09:00:00Z",
        "duration": 201.5,
        "edited": False,
        "vocals": True,
        "sizeBytes": None,
    }
    page = m.TrackMetaPage.model_validate({"items": [track], "hasNext": False, "hasPrev": False, "nextCursor": None})
    assert page.items[0].title == "<script>alert(1)</script>"
    with pytest.raises(ValidationError):  # audio / chords / media URLs never travel here (AC-06)
        m.TrackMeta.model_validate({**track, "mediaUrl": "https://example.test/a.mp3"})


def test_stats_range_holds_at_most_90_days() -> None:
    day = {
        "day": "2026-10-08",
        "state": "live",
        "analyses": {"link": 0, "file": 0, "mic": 0, "tab": 0},
        "vocals": 0,
        "failed": 0,
        "failedByReason": {},
        "active": 0,
        "newUsers": 0,
        "restoredTracks": None,
        "frozenAt": None,
    }
    m.StatsRange.model_validate({"from": "2026-07-11", "to": "2026-10-08", "days": [day] * 90})
    with pytest.raises(ValidationError):
        m.StatsRange.model_validate({"from": "2026-07-10", "to": "2026-10-08", "days": [day] * 91})


# --------------------------------------------------------------------------- contract mirror

CONTRACT_MODELS = {
    "Overview": "Overview",
    "RunningJob": "RunningJob",
    "UserSearchItem": "UserSearchItem",
    "UserSearchResult": "UserSearchResult",
    "Restriction": "Restriction",
    "Deletion": "Deletion",
    "PersonalLimit": "PersonalLimit",
    "PersonalLimitInput": "PersonalLimitIn",
    "AccountState": "AccountState",
    "UserProfile": "UserProfile",
    "UserCard": "UserCard",
    "RestrictionInput": "RestrictionIn",
    "DeletionRequest": "DeletionIn",
    "TrackMeta": "TrackMeta",
    "TrackMetaPage": "TrackMetaPage",
    "JobHistoryItem": "JobHistoryItem",
    "JobHistoryPage": "JobHistoryPage",
    "RestoredTracks": "RestoredTracks",
    "StatsDay": "StatsDay",
    "StatsRange": "StatsRange",
    "AuditEntry": "AuditEntry",
    "AuditPage": "AuditPage",
    "Settings": "Settings",
    "SwitchChange": "SwitchChange",
    "DefaultLimits": "DefaultLimitsIn",
    "Banner": "BannerIn",
    "Switches": "Switches",
    "OriginCounts": "OriginCounts",
    "QuotaUsage": "QuotaUsage",
    "UserQuotas": "UserQuotas",
    "SweepRun": "SweepRun",
}


def _contract_schemas() -> dict[str, Any]:
    yaml = pytest.importorskip("yaml")
    return yaml.safe_load(OPENAPI.read_text(encoding="utf-8"))["components"]["schemas"]


@pytest.mark.parametrize("name", sorted(CONTRACT_MODELS))
def test_model_mirrors_the_openapi_schema(name: str) -> None:
    schema = _contract_schemas()[name]
    model: type[BaseModel] = getattr(m, CONTRACT_MODELS[name])
    wire_names = {(f.alias or n) for n, f in model.model_fields.items()}
    assert wire_names == set(schema["properties"]), f"{name}: field names differ from openapi.yaml"
    contract_required = set(schema.get("required", []))
    model_required = {(f.alias or n) for n, f in model.model_fields.items() if f.is_required()}
    assert model_required == contract_required, f"{name}: required fields differ from openapi.yaml"

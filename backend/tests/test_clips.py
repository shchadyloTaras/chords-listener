"""YouTube fragments (docs/superpowers/specs/2026-10-07-youtube-warp-fetch-design.md): the request and track
fields, the clip download helpers, clip jobs. Offline: yt-dlp and the clip fetcher are fakes."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.jobs import JobRecord
from app.models import ClipRange, CreateJobRequest, Settings, TrackSummary
from app.storage import TrackStore

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

VIDEO_ID = "dQw4w9WgXcQ"


# --------------------------------------------------------------------------- request, settings, JSON


def test_create_job_request_takes_a_whole_second_clip_start() -> None:
    body = CreateJobRequest.model_validate({"url": VIDEO_ID, "clip": {"start": 72}})
    assert body.clip is not None and body.clip.start == 72
    assert CreateJobRequest.model_validate({"url": VIDEO_ID}).clip is None
    for bad in (-1, 1.5, "x", 24 * 3600 + 1):
        with pytest.raises(ValidationError):
            CreateJobRequest.model_validate({"url": VIDEO_ID, "clip": {"start": bad}})


def test_clip_settings_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHORDS_FETCH_URL", "https://chords-fetch-abc-ew.a.run.app/")
    monkeypatch.setenv("CHORDS_YT_CLIP_S", "45")
    s = Settings.from_env()
    assert s.fetch_url == "https://chords-fetch-abc-ew.a.run.app" and s.clip_s == 45
    monkeypatch.setenv("CHORDS_YT_CLIP_S", "600")
    assert Settings.from_env().clip_s == 60
    monkeypatch.setenv("CHORDS_YT_CLIP_S", "0")
    assert Settings.from_env().clip_s == 1
    monkeypatch.delenv("CHORDS_FETCH_URL", raising=False)
    monkeypatch.delenv("CHORDS_YT_CLIP_S", raising=False)
    assert (Settings.from_env().fetch_url, Settings.from_env().clip_s) == ("", 30)


def test_track_summary_and_job_carry_the_clip() -> None:
    meta = {"title": "Song", "clip": {"start": 72, "end": 102}}
    summary = TrackSummary.model_validate(TrackStore._summary_dict("0123456789ab", meta, edited=False, chord_count=3))
    assert summary.clip == ClipRange(start=72, end=102)
    assert summary.model_dump(mode="json")["clip"] == {"start": 72.0, "end": 102.0}
    plain = TrackSummary.model_validate(TrackStore._summary_dict("0123456789ab", {"title": "Song"}, edited=False, chord_count=0))
    assert plain.clip is None
    job = JobRecord(id="j1", kind="url", created_at="2026-10-08T10:00:00Z", clip={"start": 72.0, "end": 102.0}).to_model()
    assert job.model_dump(mode="json")["clip"] == {"start": 72.0, "end": 102.0}
    assert JobRecord(id="j2", kind="url", created_at="2026-10-08T10:00:00Z").to_model().clip is None

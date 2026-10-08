"""YouTube fragments (docs/superpowers/specs/2026-10-07-youtube-warp-fetch-design.md): the request and track
fields, the clip download helpers, clip jobs. Offline: yt-dlp and the clip fetcher are fakes."""
from __future__ import annotations

import threading
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.jobs import JobRecord
from app.models import ClipRange, CreateJobRequest, Settings, TrackSummary
from app.sources import (
    Cancelled,
    LocalClipFetcher,
    NormalizedUrl,
    RemoteMedia,
    SourceError,
    YtDlpFetcher,
    _map_ytdlp_error,
    clip_end,
    clip_track_key,
    is_bot_check,
    track_id_for,
)
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


# --------------------------------------------------------------------------- fragment helpers (sources)


def test_a_fragment_is_its_own_track() -> None:
    assert clip_track_key(VIDEO_ID, 72) == f"youtube:{VIDEO_ID}@72"
    kind, _, ident = clip_track_key(VIDEO_ID, 72).partition(":")
    assert track_id_for(kind, ident) not in (track_id_for("youtube", VIDEO_ID), track_id_for("youtube", f"{VIDEO_ID}@73"))


@pytest.mark.parametrize(
    ("start", "length", "duration", "end"),
    [
        (72, 30, 213.4, 102.0),
        (190, 30, 213.4, 213.4),  # the last window is cut at the video's end
        (0, 30, 20.0, 20.0),  # a video shorter than the window: all of it
        (72, 30, None, 102.0),  # length unknown: trust the window
    ],
)
def test_clip_end(start: int, length: int, duration: float | None, end: float) -> None:
    assert clip_end(start, length, duration) == end


def test_a_fragment_must_start_inside_the_video() -> None:
    with pytest.raises(SourceError) as err:
        clip_end(214, 30, 213.4)
    assert err.value.code == "invalid_url"


def test_bot_check_is_told_apart_from_a_refused_media_url() -> None:
    bot = _map_ytdlp_error(
        Exception("ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot. Use --cookies-from-browser"),
        youtube=True,
    )
    forbidden = _map_ytdlp_error(Exception("ERROR: unable to download video data: HTTP Error 403: Forbidden"), youtube=True)
    assert bot.code == forbidden.code == "download_blocked"
    assert is_bot_check(bot.detail or "") and not is_bot_check(forbidden.detail or "")
    assert "403" in (forbidden.detail or "")


def test_proxy_reaches_ytdlp() -> None:
    assert YtDlpFetcher(1000, proxy="socks5h://127.0.0.1:40000")._opts()["proxy"] == "socks5h://127.0.0.1:40000"
    assert "proxy" not in YtDlpFetcher(1000)._opts()


class FakeYDL:
    """yt_dlp.YoutubeDL stand-in: records its options, 'downloads' a small file."""

    made: list[FakeYDL] = []

    def __init__(self, opts: dict) -> None:
        self.opts = opts
        FakeYDL.made.append(self)

    def __enter__(self) -> FakeYDL:
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def process_ie_result(self, info: dict, download: bool = True) -> dict:
        path = Path(self.opts["paths"]["home"]) / "source.webm"
        path.write_bytes(b"\x1aE\xdf\xa3" + b"0" * 64)
        return {"requested_downloads": [{"filepath": str(path)}]}

    def extract_info(self, url: str, download: bool = True) -> dict:
        return self.process_ie_result({}, download)


def test_download_clip_asks_ytdlp_for_the_range_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import yt_dlp

    FakeYDL.made.clear()
    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYDL)
    media = RemoteMedia(url=f"https://www.youtube.com/watch?v={VIDEO_ID}", extractor="youtube", media_id=VIDEO_ID,
                        title="Song", video_id=VIDEO_ID, info={"id": VIDEO_ID})
    path = YtDlpFetcher(10_000).download_clip(media, 72.0, 102.0, tmp_path, lambda f: None, threading.Event())
    assert path == tmp_path / "source.webm"
    ranges = FakeYDL.made[-1].opts["download_ranges"]
    assert list(ranges({"duration": 213.4}, None)) == [{"start_time": 72.0, "end_time": 102.0}]


class FakeYtDlp:
    """YtDlpFetcher stand-in for LocalClipFetcher: a video of ``duration`` seconds."""

    def __init__(self, duration: float | None) -> None:
        self.duration = duration
        self.clips: list[tuple[float, float]] = []

    def probe(self, url: NormalizedUrl) -> RemoteMedia:
        return RemoteMedia(url=url.url, extractor="youtube", media_id=url.youtube_id or "", title="Song",
                           artist="Artist", duration=self.duration, thumbnail=None, video_id=url.youtube_id)

    def download_clip(self, media: RemoteMedia, start: float, end: float, dest_dir: Path, progress, cancel) -> Path:
        self.clips.append((start, end))
        path = dest_dir / "source.webm"
        path.write_bytes(b"x")
        return path


def test_local_clip_fetcher(tmp_path: Path) -> None:
    yt = FakeYtDlp(213.4)
    fetcher = LocalClipFetcher(yt)  # type: ignore[arg-type]
    clip = fetcher.fetch(VIDEO_ID, 190, 30, tmp_path, lambda f: None, threading.Event())
    assert (clip.start, clip.end, clip.title, clip.artist, clip.duration) == (190.0, 213.4, "Song", "Artist", 213.4)
    assert clip.thumbnail == f"https://i.ytimg.com/vi/{VIDEO_ID}/hqdefault.jpg" and yt.clips == [(190.0, 213.4)]
    with pytest.raises(SourceError) as err:
        fetcher.fetch(VIDEO_ID, 300, 30, tmp_path, lambda f: None, threading.Event())
    assert err.value.code == "invalid_url" and len(yt.clips) == 1
    with pytest.raises(SourceError) as err:
        fetcher.fetch("not-an-id", 0, 30, tmp_path, lambda f: None, threading.Event())
    assert err.value.code == "invalid_url"
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(Cancelled):
        fetcher.fetch(VIDEO_ID, 0, 30, tmp_path, lambda f: None, cancel)


def test_ffmpeg_cuts_the_fragment_through_an_http_proxy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # yt-dlp keeps the SOCKS proxy; ffmpeg, which cuts the fragment, gets the HTTP CONNECT proxy as its input option.
    import yt_dlp

    FakeYDL.made.clear()
    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYDL)
    media = RemoteMedia(url=f"https://www.youtube.com/watch?v={VIDEO_ID}", extractor="youtube", media_id=VIDEO_ID,
                        title="Song", video_id=VIDEO_ID, info={"id": VIDEO_ID})
    fetcher = YtDlpFetcher(10_000, proxy="socks5h://127.0.0.1:40000", ffmpeg_proxy="http://127.0.0.1:40001")
    fetcher.download_clip(media, 72.0, 102.0, tmp_path, lambda f: None, threading.Event())
    opts = FakeYDL.made[-1].opts
    assert opts["proxy"] == "socks5h://127.0.0.1:40000"
    assert opts["external_downloader_args"] == {"ffmpeg_i": ["-http_proxy", "http://127.0.0.1:40001"]}


def test_without_an_ffmpeg_proxy_the_clip_adds_no_downloader_args(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import yt_dlp

    FakeYDL.made.clear()
    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYDL)
    media = RemoteMedia(url=f"https://www.youtube.com/watch?v={VIDEO_ID}", extractor="youtube", media_id=VIDEO_ID,
                        title="Song", video_id=VIDEO_ID, info={"id": VIDEO_ID})
    YtDlpFetcher(10_000).download_clip(media, 72.0, 102.0, tmp_path, lambda f: None, threading.Event())
    assert "external_downloader_args" not in FakeYDL.made[-1].opts


def test_download_is_unchanged_and_takes_no_range(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Regression guard: a whole-track download keeps the old options (no range, no ffmpeg args), even with proxies set.
    import yt_dlp

    FakeYDL.made.clear()
    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYDL)
    media = RemoteMedia(url=f"https://www.youtube.com/watch?v={VIDEO_ID}", extractor="youtube", media_id=VIDEO_ID,
                        title="Song", video_id=VIDEO_ID, info={"id": VIDEO_ID})
    fetcher = YtDlpFetcher(10_000, proxy="socks5h://127.0.0.1:40000", ffmpeg_proxy="http://127.0.0.1:40001")
    path = fetcher.download(media, tmp_path, lambda f: None, threading.Event())
    assert path == tmp_path / "source.webm"
    opts = FakeYDL.made[-1].opts
    assert "download_ranges" not in opts and "external_downloader_args" not in opts

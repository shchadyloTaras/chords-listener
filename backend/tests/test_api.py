"""HTTP API tests (offline & fast): the engine and the yt-dlp fetcher are replaced with fakes, audio
fixtures are generated with ffmpeg into temp dirs."""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Optional

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field

from app.main import create_app
from app.models import AnalysisResult, Settings
from app.sources import (
    NormalizedUrl,
    RemoteMedia,
    SourceError,
    find_executable,
    normalize_url,
    track_id_for,
    youtube_thumbnail,
)

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

FFMPEG = find_executable("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(not FFMPEG or not find_executable("ffprobe"), reason="ffmpeg/ffprobe not installed")

VIDEO_ID = "dQw4w9WgXcQ"
LOCAL_HOSTS = ("testserver", "localhost", "127.0.0.1")


# --------------------------------------------------------------------------- media fixtures


def _ffmpeg(*args: str) -> None:
    subprocess.run([FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def _triad(freqs: tuple[float, ...], seconds: float) -> str:
    expr = "+".join(f"0.25*sin(2*PI*{f}*t)" for f in freqs)
    return f"aevalsrc={expr}:s=44100:d={seconds}"


@pytest.fixture(scope="session")
def media(tmp_path_factory: pytest.TempPathFactory) -> SimpleNamespace:
    if not FFMPEG:
        pytest.skip("ffmpeg not installed")
    d = tmp_path_factory.mktemp("media")
    c_major, a_minor = (261.63, 329.63, 392.0), (220.0, 261.63, 329.63)

    tagged_mp3 = d / "tone.mp3"
    _ffmpeg("-f", "lavfi", "-i", _triad(c_major, 4), "-c:a", "libmp3lame", "-b:a", "128k",
            "-metadata", "title=Sine Serenade", "-metadata", "artist=The Oscillators", str(tagged_mp3))
    plain_wav = d / "my_song-take_2.wav"
    _ffmpeg("-f", "lavfi", "-i", _triad(a_minor, 3), str(plain_wav))
    video = d / "clip.mp4"
    _ffmpeg("-f", "lavfi", "-i", "color=c=blue:s=64x64:d=2", "-f", "lavfi", "-i", _triad(c_major, 2),
            "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(video))
    silent_video = d / "no_audio.mp4"
    _ffmpeg("-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(silent_video))
    text = d / "notes.mp3"  # wrong extension on purpose: ffprobe is the gate
    text.write_text("definitely not audio\n" * 50)
    return SimpleNamespace(tagged_mp3=tagged_mp3, plain_wav=plain_wav, video=video, silent_video=silent_video, text=text)


# --------------------------------------------------------------------------- fakes


class FakeEngine:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.fail: bool | Exception = False
        self.gate: Optional[threading.Event] = None  # when set, analyze() waits (calling progress) until released

    def __call__(self, path: str, progress: Optional[Callable[[float, str], None]] = None, options: Optional[dict] = None) -> dict:
        self.calls.append((path, dict(options or {})))
        if progress:
            progress(0.25, "Detecting beats")
        if self.gate is not None:
            deadline = time.monotonic() + 10
            while not self.gate.is_set() and time.monotonic() < deadline:
                if progress:
                    progress(0.5, "Waiting")
                time.sleep(0.02)
        if self.fail:
            raise self.fail if isinstance(self.fail, Exception) else RuntimeError("synthetic engine failure")
        out = subprocess.run(
            [find_executable("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, check=True,
        )
        duration = float(out.stdout.strip())
        if progress:
            progress(1.0, "Finishing")
        half = duration / 2
        return {
            "duration": np.float64(duration),
            "tempo": np.float32(120.0),
            "timeSignature": 4,
            "beats": np.arange(0, duration, 0.5, dtype=np.float32),
            "downbeats": [0.0, 2.0],
            "chords": [  # deliberately unsorted; the API sorts them
                {"start": half, "end": duration, "label": "Am", "root": "A", "quality": "min", "bass": None, "confidence": 0.8},
                {"start": 0.0, "end": half, "label": "C", "root": "C", "quality": "maj", "bass": None, "confidence": np.float32(0.9)},
            ],
            "key": {"tonic": "C", "mode": "major", "name": "C", "confidence": 0.7},
            "waveform": [0.1, float("nan"), 0.9, 1.5],
            "engine": "fake 1.0",
        }


class FakeFetcher:
    """Stands in for yt-dlp: 'downloads' by copying a local fixture."""

    def __init__(self, audio: Path) -> None:
        self.audio = audio
        self.duration: Optional[float] = 4.0
        self.error: Optional[Exception] = None
        self.probes = 0
        self.downloads = 0

    def offline_key(self, url: NormalizedUrl) -> Optional[str]:
        return f"youtube:{url.youtube_id}" if url.youtube_id else None

    def probe(self, url: NormalizedUrl) -> RemoteMedia:
        self.probes += 1
        if self.error:
            raise self.error
        vid = url.youtube_id
        return RemoteMedia(
            url=url.url, extractor="youtube" if vid else "soundcloud", media_id=vid or "12345",
            title="Fake Song", artist="Fake Artist", duration=self.duration,
            thumbnail=youtube_thumbnail(vid) if vid else "https://example.com/t.jpg", video_id=vid,
        )

    def download(self, media: RemoteMedia, dest_dir: Path, progress: Callable[[float], None], cancel: threading.Event) -> Path:
        self.downloads += 1
        progress(0.5)
        dest = dest_dir / "source.mp3"
        shutil.copy(self.audio, dest)
        progress(1.0)
        return dest


ENGINE_INFO = {"name": "fake", "version": "1.0", "features": {"separation": False, "downbeats": True}}


@pytest.fixture
def make_env(tmp_path: Path, media: SimpleNamespace):
    clients: list[TestClient] = []

    def factory(data_dir: Optional[Path] = None, **overrides: Any) -> SimpleNamespace:
        settings = Settings(
            data_dir=data_dir or tmp_path / "data",
            frontend_dist=overrides.pop("frontend_dist", tmp_path / "no-dist"),
            allowed_hosts=overrides.pop("allowed_hosts", LOCAL_HOSTS),
            **overrides,
        )
        engine, fetcher = FakeEngine(), FakeFetcher(media.tagged_mp3)
        app = create_app(settings, analyzer=engine, fetcher=fetcher, engine_info_fn=lambda: ENGINE_INFO)
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return SimpleNamespace(client=client, engine=engine, fetcher=fetcher, settings=settings, media=media)

    yield factory
    for c in clients:
        c.__exit__(None, None, None)


@pytest.fixture
def env(make_env) -> SimpleNamespace:
    return make_env()


def wait_job(client: TestClient, job_id: str, timeout: float = 30.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in ("done", "error"):
            return job
        time.sleep(0.03)
    raise AssertionError(f"job {job_id} did not finish: {job}")


def upload(client: TestClient, path: Path, options: Optional[dict] = None, filename: Optional[str] = None):
    data = {"options": json.dumps(options)} if options is not None else None
    with open(path, "rb") as fh:
        return client.post("/api/jobs/upload", files={"file": (filename or path.name, fh, "application/octet-stream")}, data=data)


def upload_and_wait(env: SimpleNamespace, path: Path, **kw: Any) -> tuple[dict, dict]:
    res = upload(env.client, path, **kw)
    assert res.status_code == 201, res.text
    job = wait_job(env.client, res.json()["id"])
    assert job["status"] == "done", job
    return job, env.client.get(f"/api/tracks/{job['trackId']}").json()


def assert_error(res, status: int, code: str) -> None:
    assert res.status_code == status, res.text
    body = res.json()
    assert body["code"] == code and isinstance(body["detail"], str) and body["detail"], body


def work_leftovers(env: SimpleNamespace) -> list[str]:
    return [p.name for p in env.settings.work_dir.iterdir()] if env.settings.work_dir.exists() else []


# --------------------------------------------------------------------------- URL normalization (unit)


@pytest.mark.parametrize(
    "raw",
    [
        f"https://www.youtube.com/watch?v={VIDEO_ID}",
        f"https://youtube.com/watch?v={VIDEO_ID}&t=42s&list=PL1234567890&index=3",
        f"https://youtu.be/{VIDEO_ID}?si=AbCdEf&t=10",
        f"youtu.be/{VIDEO_ID}",
        f"https://m.youtube.com/watch?v={VIDEO_ID}&feature=share",
        f"https://music.youtube.com/watch?v={VIDEO_ID}&list=RDAMVM{VIDEO_ID}",
        f"https://www.youtube.com/shorts/{VIDEO_ID}?feature=share",
        f"https://www.youtube.com/embed/{VIDEO_ID}?start=30",
        f"https://www.youtube-nocookie.com/embed/{VIDEO_ID}",
        f"https://www.youtube.com/live/{VIDEO_ID}?si=x",
        f"www.youtube.com/watch?v={VIDEO_ID}",
        f"  HTTPS://WWW.YOUTUBE.COM/watch?app=desktop&v={VIDEO_ID}  ",
        f"https://www.youtube.com/attribution_link?u=%2Fwatch%3Fv%3D{VIDEO_ID}%26feature%3Dshare",
        VIDEO_ID,
    ],
)
def test_normalize_youtube_forms(raw: str) -> None:
    n = normalize_url(raw)
    assert n.youtube_id == VIDEO_ID
    assert n.url == f"https://www.youtube.com/watch?v={VIDEO_ID}"
    assert n.source_type == "youtube"


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "not a url",
        "ftp://example.com/song.mp3",
        "javascript:alert(1)",
        "https://",
        "https://nodot/path",
        "https://www.youtube.com/playlist?list=PL1234567890",
        "https://www.youtube.com/@somechannel",
        "https://youtu.be/short",
    ],
)
def test_normalize_rejects_invalid(raw: str) -> None:
    with pytest.raises(SourceError) as info:
        normalize_url(raw)
    assert info.value.code == "invalid_url"


def test_normalize_other_sites_keep_url_without_fragment() -> None:
    n = normalize_url("https://SoundCloud.com/artist/track?in=x#t=1:00")
    assert n.youtube_id is None and n.source_type == "url"
    assert n.url == "https://soundcloud.com/artist/track?in=x"


def test_track_ids_are_stable_short_hex() -> None:
    tid = track_id_for("youtube", VIDEO_ID)
    assert tid == hashlib.sha1(f"youtube:{VIDEO_ID}".encode()).hexdigest()[:12]
    media = RemoteMedia(url="u", extractor="youtube", media_id=VIDEO_ID, title="t", video_id=VIDEO_ID)
    assert media.track_id == tid


def test_engine_output_is_normalized() -> None:
    result = AnalysisResult.from_engine(
        {
            "duration": np.float64(10.0),
            "tempo": float("nan"),
            "beats": np.array([2.0, 1.0, -1.0]),
            "chords": [
                {"start": 5, "end": 12, "label": "G", "root": "G", "quality": "maj", "confidence": 2},
                {"start": 0, "end": 5, "label": "C", "root": "C", "quality": "maj", "confidence": 0.5},
                {"start": 3, "end": 1, "label": "bad"},
                {"start": 11, "end": 13, "label": "past-the-end"},
            ],
            "key": {"tonic": "C", "mode": "dorian", "name": "C?"},
            "waveform": [0.5, float("inf"), -1],
        }
    )
    assert [c.label for c in result.chords] == ["C", "G"]
    assert result.chords[1].end == 10.0 and result.chords[1].confidence == 1.0
    assert result.tempo is None and result.key is None
    assert result.beats == [1.0, 2.0]
    assert result.waveform == [0.5, 0.0, 0.0]
    with pytest.raises(ValueError):
        AnalysisResult.from_engine({"chords": []})


# --------------------------------------------------------------------------- health & basics


def test_health(env: SimpleNamespace) -> None:
    res = env.client.get("/api/health")
    assert res.status_code == 200
    body = res.json()
    features = dict(body["engine"]["features"])
    assert isinstance(features.pop("vocals"), bool)  # the optional vocal transcription (app.vocals)
    assert {**body["engine"], "features": features} == ENGINE_INFO
    assert body["ffmpeg"] is True and body["ok"] is True
    assert isinstance(body["ytdlp"], str) and body["ytdlp"]


def test_unknown_ids_return_not_found(env: SimpleNamespace) -> None:
    c = env.client
    assert_error(c.get("/api/jobs/nope"), 404, "not_found")
    assert_error(c.get("/api/tracks/abcdef123456"), 404, "not_found")
    assert_error(c.get("/api/tracks/..%2F..%2Fetc"), 404, "not_found")
    assert_error(c.get("/api/tracks/abcdef123456/audio"), 404, "not_found")
    assert_error(c.patch("/api/tracks/abcdef123456", json={"title": "x"}), 404, "not_found")
    assert_error(c.post("/api/tracks/abcdef123456/reset"), 404, "not_found")
    assert_error(c.post("/api/tracks/abcdef123456/reanalyze"), 404, "not_found")
    assert_error(c.delete("/api/tracks/abcdef123456"), 404, "not_found")
    assert_error(c.delete("/api/tracks/NOT-HEX"), 404, "not_found")
    assert_error(c.get("/api/does-not-exist"), 404, "not_found")
    assert c.get("/api/tracks").json() == []
    assert c.get("/api/jobs").json() == []


def test_invalid_url_requests(env: SimpleNamespace) -> None:
    c = env.client
    assert_error(c.post("/api/jobs", json={"url": "not a url"}), 400, "invalid_url")
    assert_error(c.post("/api/jobs", json={"url": "https://www.youtube.com/playlist?list=PL1"}), 400, "invalid_url")
    assert_error(c.post("/api/jobs", json={}), 422, "invalid_url")
    assert_error(c.post("/api/jobs", content=b"url=https://x.com", headers={"content-type": "text/plain"}), 422, "invalid_url")
    assert env.fetcher.probes == 0


# --------------------------------------------------------------------------- uploads


@needs_ffmpeg
def test_upload_job_to_track(env: SimpleNamespace) -> None:
    res = upload(env.client, env.media.tagged_mp3, options={"separate": True, "futureOption": 3})
    assert res.status_code == 201, res.text
    job = res.json()
    assert set(job) >= {"id", "status", "progress", "message", "createdAt", "title", "source"}
    assert job["title"] == "Sine Serenade"
    assert job["source"] == {"type": "file", "url": None, "videoId": None, "filename": "tone.mp3"}

    done = wait_job(env.client, job["id"])
    assert done["status"] == "done" and done["progress"] == 1.0 and done["errorCode"] is None
    track_id = done["trackId"]
    assert track_id == hashlib.sha1(env.media.tagged_mp3.read_bytes()).hexdigest()[:12]
    assert env.engine.calls[0][1] == {"separate": True, "futureOption": 3}
    assert env.engine.calls[0][0].endswith("audio.mp3")

    track = env.client.get(f"/api/tracks/{track_id}").json()
    assert track["id"] == track_id
    assert track["title"] == "Sine Serenade" and track["artist"] == "The Oscillators"
    assert track["audioUrl"] == f"/api/tracks/{track_id}/audio"
    assert track["source"]["type"] == "file"
    assert track["timeSignature"] == 4 and track["tempo"] == 120.0 and track["engine"] == "fake 1.0"
    assert track["key"]["name"] == "C" and track["edited"] is False
    assert [c["label"] for c in track["chords"]] == ["C", "Am"]
    assert track["chordCount"] == 2
    assert track["waveform"] == [0.1, 0.0, 0.9, 1.0]
    assert 3.9 < track["duration"] < 4.2
    assert all(isinstance(b, float) for b in track["beats"])
    assert track["createdAt"].endswith("Z")

    listing = env.client.get("/api/tracks").json()
    assert [t["id"] for t in listing] == [track_id]
    assert listing[0]["chordCount"] == 2 and listing[0]["key"]["name"] == "C"
    assert "chords" not in listing[0] and "waveform" not in listing[0]

    files = sorted(p.name for p in (env.settings.tracks_dir / track_id).iterdir())
    assert files == ["analysis.json", "audio.mp3", "meta.json"]
    assert work_leftovers(env) == []


@needs_ffmpeg
def test_upload_accepts_the_origin_hint_and_keeps_it_on_the_track_meta(env: SimpleNamespace) -> None:
    """Local mode keeps no admin history, but the hint (file | mic; absent or unknown -> file) still travels with the job."""
    res = upload(env.client, env.media.tagged_mp3)
    assert res.status_code == 201, res.text
    wait_job(env.client, res.json()["id"])
    with open(env.media.plain_wav, "rb") as fh:
        res = env.client.post("/api/jobs/upload", files={"file": ("rec.wav", fh, "audio/wav")}, data={"origin": "mic"})
    assert res.status_code == 201, res.text
    job = wait_job(env.client, res.json()["id"])
    assert job["status"] == "done"
    meta = json.loads((env.settings.tracks_dir / job["trackId"] / "meta.json").read_text("utf-8"))
    assert meta["origin"] == "mic"


@needs_ffmpeg
def test_upload_title_falls_back_to_filename_and_video_containers_work(env: SimpleNamespace) -> None:
    _, track = upload_and_wait(env, env.media.plain_wav)
    assert track["title"] == "my song-take 2" and track["artist"] is None
    assert track["source"]["filename"] == "my_song-take_2.wav"
    _, video_track = upload_and_wait(env, env.media.video)
    assert video_track["title"] == "clip" and 1.8 < video_track["duration"] < 2.3


@needs_ffmpeg
def test_upload_dedup_by_content(env: SimpleNamespace) -> None:
    first, _ = upload_and_wait(env, env.media.tagged_mp3)
    res = upload(env.client, env.media.tagged_mp3, filename="renamed copy.mp3")
    assert res.status_code == 201
    again = res.json()
    assert again["status"] == "done" and again["trackId"] == first["trackId"] and again["progress"] == 1.0
    assert again["id"] != first["id"]
    assert len(env.engine.calls) == 1
    assert work_leftovers(env) == []
    jobs = env.client.get("/api/jobs").json()
    assert [j["id"] for j in jobs] == [again["id"], first["id"]]  # newest first


@needs_ffmpeg
def test_upload_rejects_non_media(env: SimpleNamespace) -> None:
    assert_error(upload(env.client, env.media.text), 415, "unsupported_format")
    assert_error(upload(env.client, env.media.silent_video), 415, "unsupported_format")
    assert_error(env.client.post("/api/jobs/upload", data={"options": "{}"}), 400, "unsupported_format")
    assert_error(env.client.post("/api/jobs/upload", json={"file": "x"}), 400, "unsupported_format")
    assert work_leftovers(env) == []
    assert env.engine.calls == []


@needs_ffmpeg
def test_upload_size_and_duration_limits(make_env) -> None:
    small = make_env(max_upload_mb=0.01)  # ~10 KB
    assert_error(upload(small.client, small.media.plain_wav), 413, "too_large")
    assert work_leftovers(small) == []
    short = make_env(max_duration_min=0.02)  # 1.2 s
    assert_error(upload(short.client, short.media.plain_wav), 422, "too_long")
    assert work_leftovers(short) == []


@needs_ffmpeg
def test_analysis_failure_cleans_up(env: SimpleNamespace) -> None:
    env.engine.fail = True
    res = upload(env.client, env.media.tagged_mp3)
    job = wait_job(env.client, res.json()["id"])
    assert job["status"] == "error" and job["errorCode"] == "analysis_failed"
    assert "synthetic engine failure" in job["error"] and "Traceback" not in job["error"]
    assert job["trackId"] is None
    assert list(env.settings.tracks_dir.iterdir()) == []
    assert work_leftovers(env) == []
    # a retry after the failure analyzes again (failed jobs don't poison dedup)
    env.engine.fail = False
    job2, _ = upload_and_wait(env, env.media.tagged_mp3)
    assert job2["status"] == "done"


class CodedEngineError(Exception):
    """Mimics app.engine.errors.EngineError (duck-typed: a message plus an API error ``code``)."""

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


@needs_ffmpeg
def test_engine_error_codes_are_forwarded(env: SimpleNamespace) -> None:
    env.engine.fail = CodedEngineError("No harmonic content found", "unsupported_format")
    job = wait_job(env.client, upload(env.client, env.media.tagged_mp3).json()["id"])
    assert job["status"] == "error" and job["errorCode"] == "unsupported_format"
    assert job["error"] == "No harmonic content found"
    env.engine.fail = CodedEngineError("weird", "not-a-code")
    job = wait_job(env.client, upload(env.client, env.media.tagged_mp3).json()["id"])
    assert job["errorCode"] == "analysis_failed"


# --------------------------------------------------------------------------- audio streaming


@needs_ffmpeg
def test_audio_supports_range_requests(env: SimpleNamespace) -> None:
    _, track = upload_and_wait(env, env.media.tagged_mp3)
    url = track["audioUrl"]
    full = env.client.get(url)
    assert full.status_code == 200
    assert full.headers["content-type"] == "audio/mpeg"
    assert full.headers["accept-ranges"] == "bytes"
    size = len(full.content)
    assert size > 3000 and (full.content[:3] == b"ID3" or full.content[0] == 0xFF)

    part = env.client.get(url, headers={"Range": "bytes=1000-2000"})
    assert part.status_code == 206
    assert part.headers["content-range"] == f"bytes 1000-2000/{size}"
    assert part.headers["accept-ranges"] == "bytes"
    assert len(part.content) == 1001 and part.content == full.content[1000:2001]

    tail = env.client.get(url, headers={"Range": "bytes=-100"})
    assert tail.status_code == 206 and tail.content == full.content[-100:]
    assert env.client.get(url, headers={"Range": f"bytes={size + 10}-"}).status_code == 416

    head = env.client.head(url)
    assert head.status_code == 200 and int(head.headers["content-length"]) == size and head.content == b""


# --------------------------------------------------------------------------- edits


@needs_ffmpeg
def test_patch_and_reset(env: SimpleNamespace) -> None:
    _, track = upload_and_wait(env, env.media.tagged_mp3)
    tid = track["id"]
    detected = track["chords"]
    edited_chords = [
        {"start": 2.0, "end": 4.0, "label": "G/B", "root": "G", "quality": "maj", "bass": "B", "confidence": 1},
        {"start": 0.0, "end": 2.0, "label": "Fmaj7", "root": "F", "quality": "maj7", "confidence": 1},
    ]
    res = env.client.patch(f"/api/tracks/{tid}", json={"title": "  My Title ", "artist": "Me", "chords": edited_chords})
    assert res.status_code == 200, res.text
    t = res.json()
    assert t["title"] == "My Title" and t["artist"] == "Me" and t["edited"] is True
    assert [c["label"] for c in t["chords"]] == ["Fmaj7", "G/B"]
    assert t["chords"][1]["bass"] == "B" and t["chordCount"] == 2
    assert env.client.get(f"/api/tracks/{tid}").json()["chords"] == t["chords"]
    assert env.client.get("/api/tracks").json()[0]["edited"] is True

    # title-only patch keeps chord edits; artist can be cleared
    t = env.client.patch(f"/api/tracks/{tid}", json={"artist": None}).json()
    assert t["artist"] is None and t["edited"] is True and t["title"] == "My Title"

    bad = env.client.patch(f"/api/tracks/{tid}", json={"chords": [{"start": 3, "end": 1, "label": "C"}]})
    assert_error(bad, 422, "internal")
    assert_error(env.client.patch(f"/api/tracks/{tid}", json={"chords": [{"start": 0, "end": 1, "label": ""}]}), 422, "internal")

    reset = env.client.post(f"/api/tracks/{tid}/reset")
    assert reset.status_code == 200
    r = reset.json()
    assert r["edited"] is False and r["chords"] == detected and r["title"] == "My Title"
    analysis = json.loads((env.settings.tracks_dir / tid / "analysis.json").read_text())
    assert [c["label"] for c in analysis["chords"]] == ["C", "Am"]  # original detection never overwritten


@needs_ffmpeg
def test_reanalyze_creates_job_and_replaces_detection(env: SimpleNamespace) -> None:
    _, track = upload_and_wait(env, env.media.tagged_mp3)
    tid = track["id"]
    env.client.patch(f"/api/tracks/{tid}", json={"chords": [{"start": 0, "end": 4, "label": "D", "root": "D", "quality": "maj"}]})
    res = env.client.post(f"/api/tracks/{tid}/reanalyze", json={"options": {"separate": True}})
    assert res.status_code == 201, res.text
    job = wait_job(env.client, res.json()["id"])
    assert job["status"] == "done" and job["trackId"] == tid and job["title"] == "Sine Serenade"
    assert env.engine.calls[-1][1] == {"separate": True}
    t = env.client.get(f"/api/tracks/{tid}").json()
    assert t["edited"] is False and [c["label"] for c in t["chords"]] == ["C", "Am"]
    assert (env.settings.tracks_dir / tid / "edits.prev.json").exists()  # user edits backed up, not lost
    # body is optional
    job2 = wait_job(env.client, env.client.post(f"/api/tracks/{tid}/reanalyze").json()["id"])
    assert job2["status"] == "done"


@needs_ffmpeg
def test_delete_track(env: SimpleNamespace) -> None:
    _, track = upload_and_wait(env, env.media.tagged_mp3)
    tid = track["id"]
    res = env.client.delete(f"/api/tracks/{tid}")
    assert res.status_code == 204 and res.content == b""
    assert_error(env.client.get(f"/api/tracks/{tid}"), 404, "not_found")
    assert_error(env.client.get(f"/api/tracks/{tid}/audio"), 404, "not_found")
    assert env.client.get("/api/tracks").json() == []
    assert not (env.settings.tracks_dir / tid).exists()
    assert work_leftovers(env) == []
    # the same file can be analyzed again afterwards
    job, _ = upload_and_wait(env, env.media.tagged_mp3)
    assert job["trackId"] == tid and len(env.engine.calls) == 2


@needs_ffmpeg
def test_delete_cancels_running_reanalysis(env: SimpleNamespace) -> None:
    _, track = upload_and_wait(env, env.media.tagged_mp3)
    env.engine.gate = threading.Event()
    job_id = env.client.post(f"/api/tracks/{track['id']}/reanalyze").json()["id"]
    deadline = time.monotonic() + 5
    while env.client.get(f"/api/jobs/{job_id}").json()["status"] != "analyzing" and time.monotonic() < deadline:
        time.sleep(0.02)
    running = env.client.get(f"/api/jobs/{job_id}").json()
    assert running["status"] == "analyzing" and 0.45 <= running["progress"] < 1.0 and running["message"] == "Waiting"
    # a second reanalyze request while one is running returns the running job
    assert env.client.post(f"/api/tracks/{track['id']}/reanalyze").json()["id"] == job_id
    assert env.client.delete(f"/api/tracks/{track['id']}").status_code == 204
    job = wait_job(env.client, job_id)
    assert job["status"] == "error" and job["errorCode"] == "not_found"
    assert env.client.get("/api/tracks").json() == []


@needs_ffmpeg
def test_at_most_two_jobs_run_concurrently(env: SimpleNamespace) -> None:
    env.engine.gate = threading.Event()
    ids = [upload(env.client, p).json()["id"] for p in (env.media.tagged_mp3, env.media.plain_wav, env.media.video)]
    deadline = time.monotonic() + 10
    statuses: list[str] = []
    while time.monotonic() < deadline:
        statuses = [env.client.get(f"/api/jobs/{i}").json()["status"] for i in ids]
        if statuses.count("analyzing") == 2:
            break
        time.sleep(0.02)
    assert statuses.count("analyzing") == 2 and statuses.count("queued") == 1, statuses
    queued = env.client.get(f"/api/jobs/{ids[statuses.index('queued')]}").json()
    assert queued["progress"] == 0.0 and queued["message"] == "Waiting in queue"
    env.engine.gate.set()
    assert all(wait_job(env.client, i)["status"] == "done" for i in ids)
    assert len(env.client.get("/api/tracks").json()) == 3


# --------------------------------------------------------------------------- URL jobs (fake fetcher)


@needs_ffmpeg
def test_url_job_and_dedup_across_link_forms(env: SimpleNamespace) -> None:
    res = env.client.post("/api/jobs", json={"url": f"https://youtube.com/watch?v={VIDEO_ID}&t=30s&list=PL1"})
    assert res.status_code == 201, res.text
    job = res.json()
    assert job["source"]["type"] == "youtube" and job["source"]["videoId"] == VIDEO_ID
    assert job["thumbnail"] == f"https://i.ytimg.com/vi/{VIDEO_ID}/hqdefault.jpg"
    done = wait_job(env.client, job["id"])
    assert done["status"] == "done" and done["title"] == "Fake Song"
    tid = done["trackId"]
    assert tid == track_id_for("youtube", VIDEO_ID)

    track = env.client.get(f"/api/tracks/{tid}").json()
    assert track["title"] == "Fake Song" and track["artist"] == "Fake Artist"
    assert track["source"] == {"type": "youtube", "url": f"https://www.youtube.com/watch?v={VIDEO_ID}", "videoId": VIDEO_ID, "filename": None}
    assert track["thumbnail"].startswith("https://i.ytimg.com/vi/")

    again = env.client.post("/api/jobs", json={"url": f"https://youtu.be/{VIDEO_ID}?t=10"}).json()
    assert again["status"] == "done" and again["trackId"] == tid and again["title"] == "Fake Song"
    assert env.fetcher.probes == 1 and env.fetcher.downloads == 1 and len(env.engine.calls) == 1


@needs_ffmpeg
def test_url_job_dedup_after_metadata_for_other_sites(env: SimpleNamespace) -> None:
    first = wait_job(env.client, env.client.post("/api/jobs", json={"url": "https://soundcloud.com/a/b"}).json()["id"])
    assert first["status"] == "done" and first["trackId"] == track_id_for("soundcloud", "12345")
    second = wait_job(env.client, env.client.post("/api/jobs", json={"url": "https://soundcloud.com/a/b?utm=x"}).json()["id"])
    assert second["status"] == "done" and second["trackId"] == first["trackId"]
    assert env.fetcher.probes == 2 and env.fetcher.downloads == 1


def test_url_job_too_long_and_download_errors(env: SimpleNamespace) -> None:
    env.fetcher.duration = 3 * 3600
    job = wait_job(env.client, env.client.post("/api/jobs", json={"url": VIDEO_ID}).json()["id"])
    assert job["status"] == "error" and job["errorCode"] == "too_long" and "180 min" in job["error"]
    assert env.fetcher.downloads == 0

    env.fetcher.error = SourceError("download_failed", "Video unavailable")
    job = wait_job(env.client, env.client.post("/api/jobs", json={"url": "https://youtu.be/aaaaaaaaaaa"}).json()["id"])
    assert job["status"] == "error" and job["errorCode"] == "download_failed" and job["error"] == "Video unavailable"
    assert work_leftovers(env) == []


# --------------------------------------------------------------------------- persistence, frontend, guard


@needs_ffmpeg
def test_tracks_survive_restart(make_env, tmp_path: Path) -> None:
    first = make_env()
    _, track = upload_and_wait(first, first.media.tagged_mp3)
    (first.settings.work_dir / "stale-job").mkdir()
    second = make_env(data_dir=first.settings.data_dir)
    assert [t["id"] for t in second.client.get("/api/tracks").json()] == [track["id"]]
    assert second.client.get(f"/api/tracks/{track['id']}").json()["chords"] == track["chords"]
    assert work_leftovers(second) == []


def test_serves_built_frontend_with_spa_fallback(make_env, tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>app</title>")
    (dist / "assets" / "index-abc123.js").write_text("console.log(1)")
    (dist / "favicon.svg").write_text("<svg/>")
    env = make_env(frontend_dist=dist)
    c = env.client

    root = c.get("/")
    assert root.status_code == 200 and "<title>app</title>" in root.text
    assert root.headers["cache-control"] == "no-cache"
    deep = c.get("/track/abc123def456")
    assert deep.status_code == 200 and "<title>app</title>" in deep.text
    asset = c.get("/assets/index-abc123.js")
    assert asset.status_code == 200 and "immutable" in asset.headers["cache-control"]
    assert c.get("/favicon.svg").headers["cache-control"] == "no-cache"
    assert_error(c.get("/assets/missing.js"), 404, "not_found")
    assert_error(c.get("/api/nope"), 404, "not_found")
    assert c.get("/api/health").status_code == 200
    assert c.get("/../../etc/passwd").status_code in (200, 404)  # never escapes dist
    assert "root:" not in c.get("/..%2F..%2Fetc%2Fpasswd").text


def test_frontend_missing_page(env: SimpleNamespace) -> None:
    res = env.client.get("/")
    assert res.status_code == 404 and "npm run build" in res.text


def test_local_only_guard(make_env) -> None:
    env = make_env(allowed_hosts=("localhost", "127.0.0.1", "::1"))
    local = TestClient(env.client.app, base_url="http://localhost:8765")
    assert local.get("/api/health").status_code == 200
    assert_error(env.client.get("/api/health"), 400, "internal")  # Host: testserver is not local
    evil = local.post("/api/jobs", json={"url": "not a url"}, headers={"Origin": "https://evil.example"})
    assert_error(evil, 403, "internal")
    vite = local.post("/api/jobs", json={"url": "not a url"}, headers={"Origin": "http://localhost:5173"})
    assert_error(vite, 400, "invalid_url")  # passes the guard, fails validation
    assert local.get("/api/health", headers={"Host": "[::1]:8765"}).status_code == 200


def test_cors_preflight_for_vite_dev_server(env: SimpleNamespace) -> None:
    res = env.client.options(
        "/api/jobs",
        headers={"Origin": "http://127.0.0.1:5173", "Access-Control-Request-Method": "POST",
                 "Access-Control-Request-Headers": "content-type"},
    )
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"


# --------------------------------------------------------------------------- admin error codes (docs/features/admin)

ADMIN_ERROR_STATUS = {
    "cloud_restricted": 403,
    "analyses_paused": 503,
    "youtube_disabled": 503,
    "vocals_disabled": 503,
    "query_too_short": 422,
    "invalid_period": 422,
    "invalid_value": 422,
    "confirm_email_mismatch": 422,
    "reauth_required": 401,
    "self_target": 409,
    "deletion_pending": 409,
    "not_scheduled": 409,
    "not_set": 409,
    "deletion_rate_limit": 429,
    "not_applied": 503,
    "audit_unavailable": 503,
}


def _add_route(app: Any, method: str, path: str, fn: Callable[..., Any]) -> None:
    """Register a throwaway route ahead of the `/api/*` not-found catch-all (admin routes do not exist yet)."""
    app.router.add_api_route(path, fn, methods=[method])
    app.router.routes.insert(0, app.router.routes.pop())


def test_admin_error_code_table_has_exactly_the_sixteen_new_codes() -> None:
    from typing import get_args

    from app.main import STATUS_BY_CODE
    from app.models import ErrorCode

    new_codes = set(get_args(ErrorCode)) - {
        "invalid_url", "download_failed", "unsupported_format", "too_long", "too_large", "analysis_failed",
        "not_found", "internal", "unauthorized", "quota_exceeded", "download_blocked", "unavailable", "cancelled",
    }
    assert new_codes == set(ADMIN_ERROR_STATUS)
    assert len(ADMIN_ERROR_STATUS) == 16
    assert {c: STATUS_BY_CODE[c] for c in new_codes} == ADMIN_ERROR_STATUS


@pytest.mark.parametrize(("code", "status"), sorted(ADMIN_ERROR_STATUS.items()))
def test_admin_error_code_maps_to_its_status(env: SimpleNamespace, code: str, status: int) -> None:
    from typing import get_args

    from app.main import STATUS_BY_CODE, ApiException
    from app.models import ErrorCode

    assert code in get_args(ErrorCode)
    assert STATUS_BY_CODE[code] == status
    assert ApiException(code, "boom").status == status  # type: ignore[arg-type]

    def _raise() -> None:
        raise ApiException(code, "boom")  # type: ignore[arg-type]

    _add_route(env.client.app, "POST", f"/api/admin/_raise/{code}", _raise)
    assert_error(env.client.post(f"/api/admin/_raise/{code}"), status, code)


class _Limits(BaseModel):
    analyses: int = Field(ge=1, le=1000)
    vocals: int = Field(ge=1, le=150)


def _add_validated_routes(app: Any) -> None:
    def _limits(body: _Limits) -> dict:
        return body.model_dump()

    _add_route(app, "POST", "/api/admin/_t03/limits", _limits)
    _add_route(app, "POST", "/api/_t03/limits", _limits)


def test_admin_validation_error_is_invalid_value_with_details_per_field(env: SimpleNamespace) -> None:
    _add_validated_routes(env.client.app)
    res = env.client.post("/api/admin/_t03/limits", json={"analyses": 0, "vocals": 151})
    assert_error(res, 422, "invalid_value")
    fields = res.json()["details"]["fields"]
    assert set(fields) == {"analyses", "vocals"}
    assert all(isinstance(m, str) and m for m in fields.values())

    missing = env.client.post("/api/admin/_t03/limits", json={"analyses": 5})
    assert_error(missing, 422, "invalid_value")
    assert set(missing.json()["details"]["fields"]) == {"vocals"}

    not_json = env.client.post("/api/admin/_t03/limits", content=b"nope", headers={"content-type": "text/plain"})
    assert_error(not_json, 422, "invalid_value")
    assert isinstance(not_json.json()["details"]["fields"], dict)

    assert env.client.post("/api/admin/_t03/limits", json={"analyses": 1, "vocals": 150}).status_code == 200


def test_admin_validation_error_covers_query_params(env: SimpleNamespace) -> None:
    def _search(q: str) -> dict:
        return {"q": q}

    _add_route(env.client.app, "GET", "/api/admin/_t03/search", _search)
    res = env.client.get("/api/admin/_t03/search")
    assert_error(res, 422, "invalid_value")
    assert set(res.json()["details"]["fields"]) == {"q"}


def test_non_admin_validation_errors_keep_their_code_and_have_no_details(env: SimpleNamespace) -> None:
    _add_validated_routes(env.client.app)
    res = env.client.post("/api/_t03/limits", json={"analyses": 0, "vocals": 151})
    assert_error(res, 422, "internal")
    assert "details" not in res.json()
    jobs = env.client.post("/api/jobs", json={})
    assert_error(jobs, 422, "invalid_url")
    assert "details" not in jobs.json()

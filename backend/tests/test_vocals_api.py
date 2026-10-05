"""Vocal melody endpoints: POST/GET /api/tracks/{id}/vocals, GET /api/tracks/{id}/stems/{name}, the Track
fields (vocals, stems, stemUrls) and health ``features.vocals``. Offline and fast: the pipeline
(app.vocals.transcribe) is replaced by a fake that writes tiny stem files."""
from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterator, Optional
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

import app.vocals as vocals_pkg
from app.auth import AuthError
from app.main import create_app
from app.models import AnalysisResult, Settings
from app.publish import Publisher
from app.storage import read_json, write_json_atomic
from app.users import user_context
from app.vocals import VocalsError
from tests.test_cloud import BUCKET, FakeGcs, FakeIndex

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

ENGINE_INFO = {"name": "fake", "version": "1.0", "features": {"downbeats": True}}
TRACK_ID = "0123456789ab"
OTHER_ID = "abcdef012345"
DURATION = 30.0
STEM_BYTES = b"ID3" + bytes(range(256)) * 40
RESULT = {
    "version": 1,
    "engine": "fake-vocals 1.0",
    "tuningCents": 12.04,
    "notes": [[1.0, 1.5, 64, 0.8], [0.2, 0.6, 62, 0.5]],  # unsorted on purpose
    "contour": {"start": 0.2, "hop": 0.02, "midi": [62.1, None, 64.0]},
    "range": {"low": 62, "high": 64},
}


def fake_analyzer(path: str, progress: Any = None, options: Optional[dict] = None) -> dict:
    return {
        "duration": DURATION, "tempo": 100.0, "timeSignature": 4, "beats": [0.0, 0.6], "downbeats": [0.0],
        "chords": [{"start": 0.0, "end": DURATION, "label": "G", "root": "G", "quality": "maj", "bass": None,
                    "confidence": 0.9}],
        "key": {"tonic": "G", "mode": "major", "name": "G", "confidence": 0.8}, "waveform": [0.2], "engine": "fake 2.0",
    }


class FakeVocals:
    """Stands in for app.vocals.transcribe(audio_path, stems_dir, progress, options)."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.gate: Optional[threading.Event] = None
        self.fail: Optional[Exception] = None
        self.started = threading.Event()

    def __call__(self, audio_path: str, stems_dir: str, progress: Optional[Callable] = None,
                 options: Optional[dict] = None) -> dict:
        self.calls.append(audio_path)
        assert Path(audio_path).name == "audio.mp3"
        if progress:
            progress(0.3, "Separating vocals")
        self.started.set()
        if self.gate is not None:
            deadline = time.monotonic() + 10
            while not self.gate.is_set() and time.monotonic() < deadline:
                if progress:
                    progress(0.5, "Separating vocals")  # raises when the job is cancelled
                time.sleep(0.02)
        if self.fail is not None:
            raise self.fail
        stems = Path(stems_dir)
        stems.mkdir(parents=True, exist_ok=True)
        for name in ("vocals", "instruments"):
            (stems / f"{name}.mp3").write_bytes(STEM_BYTES)
        if progress:
            progress(0.95, "Finding notes")
        return {**RESULT, "notes": [list(n) for n in RESULT["notes"]], "contour": dict(RESULT["contour"])}


def install(client: TestClient, track_id: str = TRACK_ID, **meta_extra: Any) -> None:
    store = client.app.state.store
    staged = store.new_work_dir("test")
    (staged / "audio.mp3").write_bytes(b"\xff\xfb" + b"\x00" * 4000)
    analysis = AnalysisResult.from_engine(fake_analyzer(""))
    meta = {"id": track_id, "title": "Song", "source": {"type": "file", "filename": "song.mp3"},
            "createdAt": "2026-10-04T12:00:00Z", "duration": DURATION, **meta_extra}
    assert store.install_track(staged, track_id, meta, analysis)


@pytest.fixture
def make_client(tmp_path: Path) -> Iterator[Callable[..., TestClient]]:
    clients: list[TestClient] = []

    def factory(transcriber: Any = "fake", app_kw: Optional[dict] = None, **overrides: Any) -> TestClient:
        settings = Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist",
                            allowed_hosts=overrides.pop("allowed_hosts", ("testserver",)), **overrides)
        fake = FakeVocals() if transcriber == "fake" else transcriber
        app = create_app(settings, analyzer=fake_analyzer, engine_info_fn=lambda: ENGINE_INFO,
                         vocal_transcriber=fake, **(app_kw or {}))
        client = TestClient(app)
        client.__enter__()
        client.fake = fake  # type: ignore[attr-defined]
        clients.append(client)
        return client

    yield factory
    for c in clients:
        c.__exit__(None, None, None)


@pytest.fixture
def client(make_client) -> TestClient:
    c = make_client()
    install(c)
    return c


def wait_job(client: TestClient, job_id: str, headers: Optional[dict] = None, timeout: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout
    job: dict = {}
    while time.monotonic() < deadline:
        job = client.get(f"/api/jobs/{job_id}", headers=headers).json()
        if job.get("status") in ("done", "error"):
            return job
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} did not finish: {job}")


def assert_error(res: Any, status: int, code: str) -> str:
    assert res.status_code == status, res.text
    body = res.json()
    assert body["code"] == code and isinstance(body["detail"], str) and body["detail"], body
    return body["detail"]


def run_vocals(client: TestClient, track_id: str = TRACK_ID, headers: Optional[dict] = None, **body: Any) -> dict:
    res = client.post(f"/api/tracks/{track_id}/vocals", json=body or None, headers=headers)
    assert res.status_code == 201, res.text
    job = res.json()
    assert job["kind"] == "vocals" and job["trackId"] == track_id
    return wait_job(client, job["id"], headers)


# --------------------------------------------------------------------------- happy path


def test_health_reports_the_feature(make_client, monkeypatch: pytest.MonkeyPatch) -> None:
    assert make_client().get("/api/health").json()["engine"]["features"]["vocals"] is True
    monkeypatch.setattr(vocals_pkg, "available", lambda: False)
    features = make_client(transcriber=None).get("/api/health").json()["engine"]["features"]
    assert features == {"downbeats": True, "vocals": False}


def test_transcribe_then_read_everything(client: TestClient) -> None:
    track = client.get(f"/api/tracks/{TRACK_ID}").json()
    assert track["vocals"] is False and track["stems"] == [] and track["stemUrls"] == {}
    assert_error(client.get(f"/api/tracks/{TRACK_ID}/vocals"), 404, "not_found")
    assert_error(client.get(f"/api/tracks/{TRACK_ID}/stems/vocals"), 404, "not_found")

    job = run_vocals(client)
    assert job["status"] == "done", job
    assert job["progress"] == 1.0 and job["errorCode"] is None and job["title"] == "Song"

    res = client.get(f"/api/tracks/{TRACK_ID}/vocals")
    assert res.status_code == 200 and res.headers["cache-control"] == "no-cache"
    assert res.json() == {
        "version": 1,
        "engine": "fake-vocals 1.0",
        "tuningCents": 12.0,
        "notes": [[0.2, 0.6, 62, 0.5], [1.0, 1.5, 64, 0.8]],
        "contour": {"start": 0.2, "hop": 0.02, "midi": [62.1, None, 64.0]},
        "range": {"low": 62, "high": 64},
    }
    track = client.get(f"/api/tracks/{TRACK_ID}").json()
    assert track["vocals"] is True and track["stems"] == ["vocals", "instruments"]
    assert track["stemUrls"] == {name: f"/api/tracks/{TRACK_ID}/stems/{name}" for name in ("vocals", "instruments")}
    summary = client.get("/api/tracks").json()[0]
    assert summary["vocals"] is True and summary["stems"] == ["vocals", "instruments"]
    meta = read_json(client.app.state.settings.tracks_dir / TRACK_ID / "meta.json")
    assert meta["vocalsEngine"] == "fake-vocals 1.0" and meta["vocalsAt"]


def test_stems_are_served_with_range_support(client: TestClient) -> None:
    run_vocals(client)
    for name in ("vocals", "instruments"):
        res = client.get(f"/api/tracks/{TRACK_ID}/stems/{name}")
        assert res.status_code == 200 and res.content == STEM_BYTES
        assert res.headers["content-type"] == "audio/mpeg" and res.headers["accept-ranges"] == "bytes"
    part = client.get(f"/api/tracks/{TRACK_ID}/stems/vocals", headers={"Range": "bytes=100-199"})
    assert part.status_code == 206 and part.content == STEM_BYTES[100:200]
    assert part.headers["content-range"] == f"bytes 100-199/{len(STEM_BYTES)}"
    head = client.head(f"/api/tracks/{TRACK_ID}/stems/instruments")
    assert head.status_code == 200 and head.headers["content-length"] == str(len(STEM_BYTES))
    assert_error(client.get(f"/api/tracks/{TRACK_ID}/stems/drums"), 404, "not_found")
    assert_error(client.get(f"/api/tracks/{TRACK_ID}/stems/..%2Faudio.mp3"), 404, "not_found")
    assert_error(client.get(f"/api/tracks/{OTHER_ID}/stems/vocals"), 404, "not_found")


def test_cached_result_and_force(client: TestClient) -> None:
    run_vocals(client)
    res = client.post(f"/api/tracks/{TRACK_ID}/vocals")
    assert res.status_code == 201
    job = res.json()
    assert job["status"] == "done" and job["kind"] == "vocals" and job["trackId"] == TRACK_ID
    assert len(client.fake.calls) == 1  # type: ignore[attr-defined]
    assert run_vocals(client, force=True)["status"] == "done"
    assert len(client.fake.calls) == 2  # type: ignore[attr-defined]


def test_running_job_is_shared_and_listed(client: TestClient) -> None:
    fake: FakeVocals = client.fake  # type: ignore[attr-defined]
    fake.gate = threading.Event()
    first = client.post(f"/api/tracks/{TRACK_ID}/vocals").json()
    assert fake.started.wait(5)
    second = client.post(f"/api/tracks/{TRACK_ID}/vocals").json()
    assert second["id"] == first["id"]
    running = client.get(f"/api/jobs/{first['id']}").json()
    assert running["status"] == "analyzing" and 0 < running["progress"] < 1
    assert running["message"] == "Separating vocals"
    assert [j["kind"] for j in client.get("/api/jobs").json() if j["id"] == first["id"]] == ["vocals"]
    fake.gate.set()
    assert wait_job(client, first["id"])["status"] == "done"
    assert len(fake.calls) == 1


# --------------------------------------------------------------------------- errors


def test_unknown_track_and_unavailable_feature(make_client, monkeypatch: pytest.MonkeyPatch) -> None:
    c = make_client()
    install(c)
    assert_error(c.post(f"/api/tracks/{OTHER_ID}/vocals"), 404, "not_found")
    assert_error(c.post("/api/tracks/NOT-HEX/vocals"), 404, "not_found")
    assert_error(c.get(f"/api/tracks/{OTHER_ID}/vocals"), 404, "not_found")

    monkeypatch.setattr(vocals_pkg, "available", lambda: False)
    bare = make_client(transcriber=None)  # same data dir: the track is already there
    detail = assert_error(bare.post(f"/api/tracks/{TRACK_ID}/vocals"), 501, "unavailable")
    assert "not installed" in detail
    assert_error(bare.post(f"/api/tracks/{TRACK_ID}/vocals", json={"force": True}), 501, "unavailable")


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (VocalsError("The audio is too short", code="unsupported_format"), "unsupported_format"),
        (VocalsError("Vocal transcription is not installed on this server", code="unavailable"), "unavailable"),
        (RuntimeError("boom"), "analysis_failed"),
        (VocalsError("weird", code="internal"), "analysis_failed"),
    ],
)
def test_pipeline_failures_become_job_errors(client: TestClient, error: Exception, code: str) -> None:
    client.fake.fail = error  # type: ignore[attr-defined]
    job = run_vocals(client)
    assert job["status"] == "error" and job["errorCode"] == code and job["error"]
    assert_error(client.get(f"/api/tracks/{TRACK_ID}/vocals"), 404, "not_found")
    track = client.get(f"/api/tracks/{TRACK_ID}").json()
    assert track["vocals"] is False and track["stems"] == []
    assert not list(client.app.state.settings.work_dir.glob("vocals-*"))  # scratch cleaned up


def test_invalid_pipeline_result(make_client) -> None:
    c = make_client(transcriber=lambda audio, stems, progress=None, options=None: ["not", "an", "object"])
    install(c)
    job = run_vocals(c)
    assert job["status"] == "error" and job["errorCode"] == "analysis_failed"


# --------------------------------------------------------------------------- track lifecycle


def test_delete_cancels_a_running_job_and_removes_everything(client: TestClient) -> None:
    fake: FakeVocals = client.fake  # type: ignore[attr-defined]
    fake.gate = threading.Event()
    job = client.post(f"/api/tracks/{TRACK_ID}/vocals").json()
    assert fake.started.wait(5)
    assert client.delete(f"/api/tracks/{TRACK_ID}").status_code == 204
    done = wait_job(client, job["id"])
    assert done["status"] == "error" and done["errorCode"] == "not_found"
    assert not (client.app.state.settings.tracks_dir / TRACK_ID).exists()

    install(client)
    fake.gate = None
    run_vocals(client)
    stems = client.app.state.settings.tracks_dir / TRACK_ID / "stems"
    assert (stems / "vocals.mp3").is_file()
    assert client.delete(f"/api/tracks/{TRACK_ID}").status_code == 204
    assert not stems.exists()
    assert_error(client.get(f"/api/tracks/{TRACK_ID}/vocals"), 404, "not_found")


def test_reanalysis_and_reset_keep_the_vocals(client: TestClient) -> None:
    run_vocals(client)
    res = client.post(f"/api/tracks/{TRACK_ID}/reanalyze")
    assert res.status_code == 201
    assert wait_job(client, res.json()["id"])["status"] == "done"
    assert client.post(f"/api/tracks/{TRACK_ID}/reset").status_code == 200
    patched = client.patch(f"/api/tracks/{TRACK_ID}", json={"title": "Renamed"}).json()
    assert patched["vocals"] is True and patched["stems"] == ["vocals", "instruments"]
    assert client.get(f"/api/tracks/{TRACK_ID}/vocals").status_code == 200
    assert client.get(f"/api/tracks/{TRACK_ID}/stems/vocals").status_code == 200


def test_times_follow_the_tracks_start_offset(make_client) -> None:
    c = make_client()
    install(c, startOffset=12.5)  # a recording linked to a video: track time = audio time + 12.5 s
    run_vocals(c)
    body = c.get(f"/api/tracks/{TRACK_ID}/vocals").json()
    assert body["notes"] == [[12.7, 13.1, 62, 0.5], [13.5, 14.0, 64, 0.8]]
    assert body["contour"]["start"] == 12.7


def test_unreadable_vocals_file_counts_as_missing(client: TestClient) -> None:
    run_vocals(client)
    path = client.app.state.settings.tracks_dir / TRACK_ID / "vocals.json"
    path.write_text("{oops")
    assert_error(client.get(f"/api/tracks/{TRACK_ID}/vocals"), 404, "not_found")
    write_json_atomic(path, {"version": 99, "notes": []})
    assert_error(client.get(f"/api/tracks/{TRACK_ID}/vocals"), 404, "not_found")
    assert run_vocals(client)["status"] == "done"  # not cached any more: transcribed again
    assert len(client.fake.calls) == 2  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- cloud mode


class FakeVerifier:
    def verify(self, token: str) -> str:
        if token.startswith("tok-") and len(token) > 4:
            return token[4:]
        raise AuthError("Invalid token")


def H(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer tok-{uid}"}


def test_cloud_per_user_signed_stems_and_quota(make_client, tmp_path: Path) -> None:
    index, gcs = FakeIndex(), FakeGcs()

    def publisher(store: Any) -> Publisher:
        return Publisher(store, index, bucket=BUCKET, gcs_client_factory=lambda: gcs, backoff_s=0)

    c = make_client(auth="firebase", signing_key="test-signing-key-0123456789abcdef", quota_vocals=1,
                    scratch_dir=tmp_path / "scratch",
                    app_kw={"token_verifier": FakeVerifier(), "publisher_factory": publisher})
    with user_context("alice"):
        install(c)
    published = index.docs[("alice", TRACK_ID)]
    assert published["vocals"] is False and published["version"] == 1
    assert_error(c.post(f"/api/tracks/{TRACK_ID}/vocals"), 401, "unauthorized")
    assert_error(c.post(f"/api/tracks/{TRACK_ID}/vocals", headers=H("bob")), 404, "not_found")  # not bob's

    job = run_vocals(c, headers=H("alice"))
    assert job["status"] == "done"
    assert c.get(f"/api/jobs/{job['id']}", headers=H("bob")).status_code == 404
    stems_dir = tmp_path / "data" / "users" / "alice" / "tracks" / TRACK_ID / "stems"
    assert (stems_dir / "vocals.mp3").is_file()
    published = index.docs[("alice", TRACK_ID)]  # the transcription is published like any other change
    assert published["vocals"] is True and published["stems"] == ["vocals", "instruments"]
    assert published["version"] == 2

    track = c.get(f"/api/tracks/{TRACK_ID}", headers=H("alice")).json()
    url = track["stemUrls"]["vocals"]
    parts = urlsplit(url)
    assert parts.path == f"/api/tracks/{TRACK_ID}/stems/vocals"
    query = parse_qs(parts.query)
    assert query["u"] == ["alice"] and query["exp"] and query["sig"]
    res = c.get(url, headers={"Range": "bytes=0-9"})  # an <audio> element: no Authorization header
    assert res.status_code == 206 and res.content == STEM_BYTES[:10]
    assert_error(c.get(parts.path), 401, "unauthorized")
    assert_error(c.get(url.replace("sig=", "sig=x")), 401, "unauthorized")
    assert c.get(f"/api/tracks/{TRACK_ID}/vocals", headers=H("alice")).status_code == 200

    assert c.post(f"/api/tracks/{TRACK_ID}/vocals", headers=H("alice")).json()["status"] == "done"  # cached: free
    assert_error(c.post(f"/api/tracks/{TRACK_ID}/vocals", json={"force": True}, headers=H("alice")), 429,
                 "quota_exceeded")

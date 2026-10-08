"""Fakes, fixtures and helpers of the cloud-mode tests (``test_cloud.py``, ``test_admission.py``): the token check,
the GCS client, the library index, the engine and yt-dlp are fakes; short audio files are made with ffmpeg.

The fixtures (``media``, ``make_cloud``, ``cloud``) are imported by name into the test modules that use them."""
from __future__ import annotations

import fnmatch
import shutil
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Optional

import pytest
from fastapi.testclient import TestClient

from admin.fixtures import MemDb
from app.auth import AuthError
from app.firestore import IndexError_
from app.main import create_app
from app.models import Settings
from app.publish import Publisher
from app.sources import NormalizedUrl, RemoteMedia, find_executable, youtube_thumbnail

FFMPEG = find_executable("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(not FFMPEG or not find_executable("ffprobe"), reason="ffmpeg/ffprobe not installed")

PROJECT = "build-chords-listener"
BUCKET = "build-chords-listener.firebasestorage.app"
PAGES = "https://shchadylotaras.github.io"
SIGNING_KEY = "test-signing-key-0123456789abcdef"
SMOKE_KEY = "test-smoke-key-0123456789abcdef"
VIDEO_ID = "dQw4w9WgXcQ"
ENGINE_INFO = {"name": "fake", "version": "1.0", "features": {}}


# --------------------------------------------------------------------------- fakes and fixtures


def run_ffmpeg(*args: str) -> None:
    subprocess.run([FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


@pytest.fixture(scope="module")
def media(tmp_path_factory: pytest.TempPathFactory) -> SimpleNamespace:
    if not FFMPEG:
        pytest.skip("ffmpeg not installed")
    d = tmp_path_factory.mktemp("cloud-media")
    files = {}
    for name, freq, seconds in (("a", 261.63, 4), ("b", 329.63, 3), ("c", 392.0, 3)):
        path = d / f"{name}.mp3"
        run_ffmpeg("-f", "lavfi", "-i", f"sine=frequency={freq}:duration={seconds}", "-c:a", "libmp3lame", "-b:a", "96k",
                "-metadata", f"title=Tone {name.upper()}", str(path))
        files[name] = path
    return SimpleNamespace(**files)


class FakeEngine:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.gate: Optional[threading.Event] = None

    def __call__(self, path: str, progress: Optional[Callable[[float, str], None]] = None, options: Optional[dict] = None) -> dict:
        self.calls.append(path)
        if self.gate is not None:
            deadline = time.monotonic() + 10
            while not self.gate.is_set() and time.monotonic() < deadline:
                if progress:
                    progress(0.5, "Waiting")
                time.sleep(0.02)
        out = subprocess.run(
            [find_executable("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, check=True,
        )
        duration = float(out.stdout.strip())
        half = duration / 2
        return {
            "duration": duration,
            "tempo": 120.0,
            "timeSignature": 4,
            "beats": [0.0, 0.5, 1.0],
            "downbeats": [0.0],
            "chords": [
                {"start": 0.0, "end": half, "label": "C", "root": "C", "quality": "maj", "confidence": 0.9},
                {"start": half, "end": duration, "label": "Am", "root": "A", "quality": "min", "confidence": 0.8},
            ],
            "key": {"tonic": "C", "mode": "major", "name": "C", "confidence": 0.7},
            "waveform": [0.5] * 100,
            "engine": "fake 1.0",
        }


class FakeFetcher:
    def __init__(self, audio: Path) -> None:
        self.audio = audio
        self.error: Optional[Exception] = None

    def offline_key(self, url: NormalizedUrl) -> Optional[str]:
        return f"youtube:{url.youtube_id}" if url.youtube_id else None

    def probe(self, url: NormalizedUrl) -> RemoteMedia:
        if self.error:
            raise self.error
        return RemoteMedia(url=url.url, extractor="youtube", media_id=url.youtube_id or "x", title="Fake Song",
                           duration=4.0, thumbnail=youtube_thumbnail(url.youtube_id or "x"), video_id=url.youtube_id)

    def download(self, media: RemoteMedia, dest_dir: Path, progress: Callable[[float], None], cancel: threading.Event) -> Path:
        dest = dest_dir / "source.mp3"
        shutil.copy(self.audio, dest)
        return dest


class FakeVerifier:
    """Bearer tok-<uid> -> uid."""

    def verify(self, token: str) -> str:
        if token.startswith("tok-") and len(token) > 4:
            return token[4:]
        raise AuthError("Invalid token")


class NotFound(Exception):  # same class name as google.api_core.exceptions.NotFound
    pass


class FakeBlob:
    def __init__(self, gcs: FakeGcs, bucket: str, name: str) -> None:
        self.gcs, self.bucket_name, self.name = gcs, bucket, name
        self._staged: dict[str, Any] = {}

    @property
    def _obj(self) -> dict[str, Any]:
        obj = self.gcs.objects.get((self.bucket_name, self.name))
        if obj is None:
            raise NotFound(self.name)
        return obj

    @property
    def size(self) -> int:
        return len(self._obj["data"])

    @property
    def content_type(self) -> str:
        return self._staged.get("content_type", self._obj["content_type"])

    @content_type.setter
    def content_type(self, value: str) -> None:
        self._staged["content_type"] = value

    @property
    def metadata(self) -> Optional[dict[str, str]]:
        meta = self._staged.get("metadata", self._obj.get("metadata"))
        return None if meta is None else dict(meta)

    @metadata.setter
    def metadata(self, value: Optional[dict[str, str]]) -> None:
        self._staged["metadata"] = value

    @property
    def time_created(self) -> datetime:
        return self._obj["created"]

    def patch(self) -> None:
        """Send the staged content type / metadata to the object (like the real client, nothing is stored before)."""
        self._obj.update(self._staged)
        self._staged.clear()
        self.gcs.patched.append(self.name)

    def upload_from_filename(self, filename: str, content_type: Optional[str] = None,
                             if_generation_match: Optional[int] = None) -> None:
        self.gcs.uploads.append({"name": self.name, "if_generation_match": if_generation_match})
        self.gcs.put(self.name, Path(filename).read_bytes(), bucket=self.bucket_name,
                     content_type=content_type or "application/octet-stream")

    def reload(self) -> None:
        """The fake always reads the stored object, so there is nothing to refresh."""

    def download_to_file(self, fh: Any) -> None:
        data = self._obj["data"]
        for i in range(0, len(data), 4096):
            fh.write(data[i:i + 4096])

    def delete(self) -> None:
        self._obj  # noqa: B018 - raises NotFound
        del self.gcs.objects[(self.bucket_name, self.name)]
        self.gcs.deleted.append(self.name)


class FakeBucket:
    def __init__(self, gcs: FakeGcs, name: str) -> None:
        self.gcs, self.name = gcs, name

    def blob(self, name: str) -> FakeBlob:
        return FakeBlob(self.gcs, self.name, name)

    def get_blob(self, name: str) -> Optional[FakeBlob]:
        return FakeBlob(self.gcs, self.name, name) if (self.name, name) in self.gcs.objects else None


class FakeGcs:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], dict[str, Any]] = {}
        self.deleted: list[str] = []
        self.patched: list[str] = []
        self.uploads: list[dict[str, Any]] = []  # upload_from_filename calls: the name and its generation precondition

    def put(self, name: str, data: bytes, *, bucket: str = BUCKET, age_s: float = 0, content_type: str = "audio/mpeg",
            metadata: Optional[dict[str, str]] = None) -> str:
        created = datetime.now(timezone.utc) - timedelta(seconds=age_s)
        self.objects[(bucket, name)] = {"data": data, "content_type": content_type, "created": created,
                                        "metadata": metadata}
        return name

    def bucket(self, name: str) -> FakeBucket:
        return FakeBucket(self, name)

    def list_blobs(self, bucket: str, match_glob: Optional[str] = None) -> list[FakeBlob]:
        return [FakeBlob(self, b, n) for (b, n) in list(self.objects)
                if b == bucket and (match_glob is None or fnmatch.fnmatch(n, match_glob.replace("**", "*")))]


class FakeIndex:
    """Stands in for ``FirestoreIndex``: the documents by (uid, trackId). ``fail`` makes the next that many
    upserts / deletes raise (``retryable`` tells whether a retry may help)."""

    def __init__(self) -> None:
        self.docs: dict[tuple[str, str], dict[str, Any]] = {}
        self.fail, self.retryable, self.calls = 0, True, 0

    def _check(self) -> None:
        self.calls += 1
        if self.fail:
            self.fail -= 1
            raise IndexError_("down", retryable=self.retryable)

    def upsert(self, uid: str, tid: str, data: dict[str, Any]) -> None:
        self._check()
        self.docs[(uid, tid)] = data

    def delete(self, uid: str, tid: str) -> None:
        self._check()
        self.docs.pop((uid, tid), None)

    def exists(self, uid: str, tid: str) -> bool:
        return (uid, tid) in self.docs


@pytest.fixture
def make_cloud(tmp_path: Path, media: SimpleNamespace):
    clients: list[TestClient] = []

    def factory(data_dir: Optional[Path] = None, *, verifier: Any = None, cloud: bool = True, admin_db: Any = None,
                **overrides: Any) -> SimpleNamespace:
        clip_fetcher = overrides.pop("clip_fetcher", None)
        defaults: dict[str, Any] = {
            "auth": "firebase" if cloud else "off",
            "signing_key": SIGNING_KEY,
            "smoke_key": SMOKE_KEY,
            "upload_bucket": BUCKET,
            "scratch_dir": tmp_path / "scratch",
            "allowed_hosts": ("testserver", "*.run.app", "localhost"),
        }
        defaults.update(overrides)
        settings = Settings(data_dir=data_dir or tmp_path / "data", frontend_dist=tmp_path / "no-dist", **defaults)
        engine, fetcher, gcs, index = FakeEngine(), FakeFetcher(media.a), FakeGcs(), FakeIndex()
        admin_db = admin_db or MemDb()  # never the real Firestore: the lifecycle hooks write to it
        app = create_app(
            settings, analyzer=engine, fetcher=fetcher, clip_fetcher=clip_fetcher, engine_info_fn=lambda: ENGINE_INFO,
            token_verifier=verifier or FakeVerifier(), gcs_client_factory=lambda: gcs, admin_db=admin_db,
            publisher_factory=lambda store: Publisher(store, index, bucket=BUCKET, gcs_client_factory=lambda: gcs,
                                                      backoff_s=0),
        )
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return SimpleNamespace(client=client, engine=engine, fetcher=fetcher, gcs=gcs, index=index,
                               settings=settings, app=app, admin_db=admin_db)

    yield factory
    for c in clients:
        c.__exit__(None, None, None)


@pytest.fixture
def cloud(make_cloud) -> SimpleNamespace:
    return make_cloud()


def H(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer tok-{uid}"}


def assert_error(res: Any, status: int, code: str) -> dict:
    assert res.status_code == status, res.text
    body = res.json()
    assert body["code"] == code and body["detail"], body
    return body


def wait_job(client: TestClient, job_id: str, headers: dict[str, str], timeout: float = 30.0) -> dict:
    deadline = time.monotonic() + timeout
    job: dict = {}
    while time.monotonic() < deadline:
        job = client.get(f"/api/jobs/{job_id}", headers=headers).json()
        if job.get("status") in ("done", "error"):
            return job
        time.sleep(0.03)
    raise AssertionError(f"job {job_id} did not finish: {job}")


def upload(client: TestClient, path: Path, headers: dict[str, str]) -> Any:
    with open(path, "rb") as fh:
        return client.post("/api/jobs/upload", files={"file": (path.name, fh, "audio/mpeg")}, headers=headers)


def upload_and_wait(env: SimpleNamespace, path: Path, uid: str) -> tuple[dict, dict]:
    res = upload(env.client, path, H(uid))
    assert res.status_code == 201, res.text
    job = wait_job(env.client, res.json()["id"], H(uid))
    assert job["status"] == "done", job
    return job, env.client.get(f"/api/tracks/{job['trackId']}", headers=H(uid)).json()

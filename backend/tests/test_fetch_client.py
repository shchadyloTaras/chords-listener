"""chords-api → chords-fetch (app.fetch_client): the ID token, waiting while every container is busy, taking the
fragment out of the bucket (and deleting it whatever happens), refusing answers that point outside fetch/."""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Optional

import pytest
import requests

from app.fetch_client import BUSY_MESSAGE, RemoteClipFetcher
from app.sources import Cancelled, SourceError

BASE = "https://chords-fetch-abc123-ew.a.run.app"
VIDEO_ID = "dQw4w9WgXcQ"
OBJECT = "fetch/0123456789abcdef/source.webm"


class FakeResponse:
    def __init__(self, status: int, payload: Any) -> None:
        self.status_code, self._payload = status, payload

    def json(self) -> Any:
        if self._payload is None:
            raise ValueError("no JSON")
        return self._payload


class FakeSession:
    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.calls: list[dict[str, Any]] = []

    def post(self, url: str, json: Any = None, headers: Optional[dict] = None, timeout: Any = None) -> FakeResponse:
        self.calls.append({"url": url, "json": json, "headers": headers})
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


class FakeBucket:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = dict(objects)
        self.deleted: list[str] = []

    def download(self, path: str, dest: Path, *, size: int, progress, cancel, max_bytes: int) -> int:
        if path not in self.objects:
            raise SourceError("not_found", "gone", 404)
        dest.write_bytes(self.objects[path])
        progress(1.0)
        return len(self.objects[path])

    def delete(self, path: str) -> bool:
        self.deleted.append(path)
        return self.objects.pop(path, None) is not None


class Clock:
    def __init__(self) -> None:
        self.now = 0.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def ok(path: str = OBJECT) -> FakeResponse:
    return FakeResponse(200, {"title": "Song", "artist": "Artist", "duration": 213.4, "start": 72, "end": 102,
                              "thumbnail": f"https://i.ytimg.com/vi/{VIDEO_ID}/hqdefault.jpg", "path": path, "size": 5})


def make(session: FakeSession, bucket: Optional[FakeBucket] = None, **kw: Any) -> tuple[RemoteClipFetcher, Clock, list[str]]:
    clock, audiences = Clock(), []

    def token(audience: str) -> str:
        audiences.append(audience)
        return f"id-token-{len(audiences)}"

    fetcher = RemoteClipFetcher(BASE + "/", bucket or FakeBucket({OBJECT: b"audio"}), max_bytes=1000, token_fn=token,
                                session=session, sleep=clock.sleep, clock=clock, **kw)
    return fetcher, clock, audiences


def fetch(fetcher: RemoteClipFetcher, tmp_path: Path, cancel: Optional[threading.Event] = None):
    return fetcher.fetch(VIDEO_ID, 72, 30, tmp_path, lambda f: None, cancel or threading.Event())


def test_a_fragment_is_asked_for_with_an_id_token_and_taken_out_of_the_bucket(tmp_path: Path) -> None:
    session, bucket = FakeSession(ok()), FakeBucket({OBJECT: b"audio"})
    fetcher, _, audiences = make(session, bucket)
    clip = fetch(fetcher, tmp_path)
    assert session.calls == [{"url": f"{BASE}/clip", "json": {"videoId": VIDEO_ID, "start": 72, "length": 30},
                              "headers": {"Authorization": "Bearer id-token-1"}}]
    assert audiences == [BASE]
    assert clip.path == tmp_path / "source.webm" and clip.path.read_bytes() == b"audio"
    assert (clip.title, clip.artist, clip.duration, clip.start, clip.end) == ("Song", "Artist", 213.4, 72.0, 102.0)
    assert bucket.deleted == [OBJECT] and bucket.objects == {}


def test_the_id_token_is_reused(tmp_path: Path) -> None:
    fetcher, _, audiences = make(FakeSession(ok(), ok()), FakeBucket({OBJECT: b"a"}))
    fetch(fetcher, tmp_path)
    fetcher.bucket.objects[OBJECT] = b"b"
    fetch(fetcher, tmp_path)
    assert audiences == [BASE]


def test_busy_containers_are_waited_for(tmp_path: Path) -> None:
    session = FakeSession(FakeResponse(429, None), FakeResponse(503, {"code": "internal"}),
                          requests.ConnectionError("cold start"), ok())
    fetcher, clock, _ = make(session)
    assert fetch(fetcher, tmp_path).end == 102.0
    assert clock.slept == [2.0, 4.0, 8.0]


def test_busy_for_too_long_is_a_failure(tmp_path: Path) -> None:
    fetcher, clock, _ = make(FakeSession(*[FakeResponse(429, None)] * 10), busy_wait_s=10)
    with pytest.raises(SourceError) as err:
        fetch(fetcher, tmp_path)
    assert (err.value.code, err.value.message) == ("download_failed", BUSY_MESSAGE)
    assert clock.slept == [2.0, 4.0]


@pytest.mark.parametrize(
    ("status", "payload", "code"),
    [
        (502, {"code": "download_blocked", "message": "YouTube refused the download"}, "download_blocked"),
        (400, {"code": "invalid_url", "message": "The fragment starts after the video ends"}, "invalid_url"),
        (502, {"code": "download_failed", "message": "Video unavailable"}, "download_failed"),
        (500, {"code": "internal", "message": "boom"}, "download_failed"),
        (403, None, "download_failed"),  # Cloud Run IAM said no: not the user's fault, not "sign in"
        (401, {"code": "unauthorized", "message": "x"}, "download_failed"),
    ],
)
def test_errors_of_the_service(tmp_path: Path, status: int, payload: Any, code: str) -> None:
    bucket = FakeBucket({OBJECT: b"audio"})
    fetcher, _, _ = make(FakeSession(FakeResponse(status, payload)), bucket)
    with pytest.raises(SourceError) as err:
        fetch(fetcher, tmp_path)
    assert err.value.code == code
    if code != "download_failed" or (payload and payload.get("code") == "download_failed"):
        assert err.value.message == payload["message"]
    assert bucket.deleted == []


@pytest.mark.parametrize("path", ["users/alice/tracks/0123456789ab/audio.mp3", "fetch/../users/a/x.mp3", "fetch/", "x"])
def test_an_answer_outside_fetch_is_refused_and_nothing_is_deleted(tmp_path: Path, path: str) -> None:
    bucket = FakeBucket({path: b"precious"})
    fetcher, _, _ = make(FakeSession(ok(path)), bucket)
    with pytest.raises(SourceError) as err:
        fetch(fetcher, tmp_path)
    assert err.value.code == "download_failed"
    assert bucket.deleted == [] and bucket.objects == {path: b"precious"}


def test_a_malformed_answer_is_a_failure(tmp_path: Path) -> None:
    fetcher, _, _ = make(FakeSession(FakeResponse(200, {"title": "Song"})))
    with pytest.raises(SourceError) as err:
        fetch(fetcher, tmp_path)
    assert err.value.code == "download_failed"


def test_cancel_before_the_download_still_deletes_the_object(tmp_path: Path) -> None:
    bucket = FakeBucket({OBJECT: b"audio"})
    session = FakeSession(ok())
    fetcher, _, _ = make(session, bucket)
    cancel = threading.Event()
    real_post = session.post

    def post_then_cancel(*args: Any, **kw: Any) -> FakeResponse:
        res = real_post(*args, **kw)
        cancel.set()  # the job was cancelled while chords-fetch worked
        return res

    session.post = post_then_cancel  # type: ignore[method-assign]
    with pytest.raises(Cancelled):
        fetch(fetcher, tmp_path, cancel)
    assert bucket.deleted == [OBJECT] and not (tmp_path / "source.webm").exists()


def test_cancelled_before_asking_sends_nothing(tmp_path: Path) -> None:
    session = FakeSession(ok())
    fetcher, _, _ = make(session)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(Cancelled):
        fetch(fetcher, tmp_path, cancel)
    assert session.calls == []

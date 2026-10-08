"""chords-fetch (app.fetch_service): request validation, the retry table (refused media URL → fresh tries; bot
check → one WARP reconnect; anything else → at once), the hand-over through the bucket, the per-request log line.
Offline: the clip fetcher, WARP and the bucket are fakes."""
from __future__ import annotations

import logging
import re
import threading
from pathlib import Path
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from app.fetch_service import create_fetch_app
from app.sources import Cancelled, FetchedClip, SourceError

VIDEO_ID = "dQw4w9WgXcQ"
BOT = SourceError("download_blocked", "YouTube refused", detail="ERROR: [youtube] x: Sign in to confirm you're not a bot")
FORBIDDEN = SourceError("download_blocked", "YouTube refused", detail="ERROR: unable to download video data: HTTP Error 403: Forbidden")
STALL = SourceError("download_failed", "Network error: Read timed out", detail="ERROR: Read timed out.")
GONE = SourceError("download_failed", "Video unavailable", detail="ERROR: [youtube] x: Video unavailable")


class ScriptedFetcher:
    """Each fetch() takes the next step: an exception to raise, "hang" (wait for cancel), or None (succeed)."""

    def __init__(self, *script: Any) -> None:
        self.script = list(script)
        self.calls = 0

    def fetch(self, video_id: str, start: int, length: int, dest_dir: Path, progress, cancel: threading.Event) -> FetchedClip:
        self.calls += 1
        step = self.script.pop(0) if self.script else None
        if step == "hang":
            cancel.wait(5)
            raise Cancelled()
        if step is not None:
            raise step
        path = dest_dir / "source.webm"
        path.write_bytes(b"\x1aE\xdf\xa3fragment")
        return FetchedClip(path=path, title="Song", artist="Artist", duration=213.4,
                           thumbnail=f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
                           start=float(start), end=min(start + length, 213.4))


class FakeWarp:
    def __init__(self) -> None:
        self.ready, self.started, self.stopped, self.restarts = False, 0, 0, 0

    def start(self) -> None:
        self.started += 1
        self.ready = True

    def stop(self) -> None:
        self.stopped += 1
        self.ready = False

    def restart(self) -> None:
        self.restarts += 1
        self.ready = True


class FakeBucket:
    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, Optional[str]]] = {}

    def upload(self, path: str, src: Path, content_type: Optional[str] = None) -> int:
        self.objects[path] = (src.read_bytes(), content_type)
        return src.stat().st_size


@pytest.fixture
def service(tmp_path: Path):
    clients: list[TestClient] = []

    def factory(*script: Any, warp: Optional[FakeWarp] = None, **kw: Any):
        fetcher, bucket = ScriptedFetcher(*script), FakeBucket()
        warp = warp if warp is not None else FakeWarp()
        app = create_fetch_app(fetcher=fetcher, bucket=bucket, warp=warp, work_dir=tmp_path / "work", **kw)
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client, fetcher, bucket, warp

    yield factory
    for c in clients:
        c.__exit__(None, None, None)


def post(client: TestClient, **body: Any):
    return client.post("/clip", json={"videoId": VIDEO_ID, "start": 72, "length": 30, **body})


def test_a_fragment_goes_to_the_bucket(service, tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger="chords.fetch")
    client, fetcher, bucket, warp = service()
    assert warp.started == 1  # the container listens only once WARP is up
    res = post(client)
    assert res.status_code == 200, res.text
    data = res.json()
    assert re.fullmatch(r"fetch/[0-9a-f]{16}/source\.webm", data["path"])
    assert data == {"title": "Song", "artist": "Artist", "duration": 213.4, "start": 72.0, "end": 102.0, "size": 12,
                    "thumbnail": f"https://i.ytimg.com/vi/{VIDEO_ID}/hqdefault.jpg", "path": data["path"]}
    assert bucket.objects[data["path"]] == (b"\x1aE\xdf\xa3fragment", "audio/webm")
    assert list((tmp_path / "work").iterdir()) == []
    assert any(f"clip {VIDEO_ID}@72+30: ok after 1 attempt(s)" in r.getMessage() for r in caplog.records)
    assert client.get("/healthz").json() == {"ok": True}


@pytest.mark.parametrize(
    "body",
    [
        {"videoId": "not-an-id"},
        {"videoId": "https://youtu.be/dQw4w9WgXcQ"},
        {"start": -1},
        {"start": 1.5},
        {"length": 0},
        {"length": 61},
        {"url": "https://example.com/a.mp3"},
    ],
)
def test_only_a_video_id_and_a_short_range_are_accepted(service, body: dict) -> None:
    client, fetcher, _, _ = service()
    res = post(client, **body)
    assert res.status_code == 400 and res.json()["code"] == "invalid_url"
    assert fetcher.calls == 0


def test_a_refused_media_url_gets_fresh_tries(service) -> None:
    client, fetcher, _, warp = service(FORBIDDEN, STALL)
    assert post(client).status_code == 200
    assert fetcher.calls == 3 and warp.restarts == 0


def test_three_refusals_are_download_blocked(service) -> None:
    client, fetcher, _, _ = service(FORBIDDEN, FORBIDDEN, FORBIDDEN)
    res = post(client)
    assert res.status_code == 502 and res.json()["code"] == "download_blocked" and fetcher.calls == 3


def test_a_bot_check_reconnects_warp_once(service) -> None:
    client, fetcher, _, warp = service(BOT)
    assert post(client).status_code == 200
    assert fetcher.calls == 2 and warp.restarts == 1


def test_a_second_bot_check_is_download_blocked(service) -> None:
    client, fetcher, _, warp = service(BOT, BOT)
    res = post(client)
    assert res.status_code == 502 and res.json() == {"code": "download_blocked", "message": "YouTube refused"}
    assert fetcher.calls == 2 and warp.restarts == 1


def test_a_final_error_is_not_retried(service) -> None:
    client, fetcher, _, _ = service(GONE)
    res = post(client)
    assert res.status_code == 502 and res.json()["code"] == "download_failed" and fetcher.calls == 1


def test_a_start_past_the_end_is_invalid(service) -> None:
    client, _, _, _ = service(SourceError("invalid_url", "The fragment starts at 300 s but the video is only 213 s long"))
    res = post(client, start=300)
    assert res.status_code == 400 and res.json()["code"] == "invalid_url"


def test_an_attempt_that_hangs_is_cut_off(service) -> None:
    client, fetcher, _, _ = service("hang", "hang", attempt_timeout_s=0.05, max_attempts=2)
    res = post(client)
    assert res.status_code == 502 and res.json()["code"] == "download_failed"
    assert "timed out" in res.json()["message"] and fetcher.calls == 2


def test_a_lost_tunnel_is_brought_back_before_the_next_fragment(service) -> None:
    client, fetcher, _, warp = service()
    warp.ready = False  # e.g. a reconnect failed during the previous request
    assert post(client).status_code == 200
    assert warp.restarts == 1

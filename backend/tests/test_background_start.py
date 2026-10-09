"""The cloud start-up background work (docs/features/admin T65): the chord-model preload, the bucket and publish sweeps
and the first-wake sweep start once per app, after the first response of a new instance has been sent - so a cold
instance answers its first request without competing with them - or after a quiet period when no request comes.
Shutdown before then starts nothing; local mode starts none of it. Offline: the work is recorded, never run."""
from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any, Callable

import anyio
import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.main import create_app
from app.models import Settings
from app.publish import Publisher

from admin.fixtures import MemDb
from cloud_fixtures import BUCKET, PAGES, SIGNING_KEY, FakeEngine, FakeGcs, FakeIndex, FakeVerifier

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


class Recorder:
    """Stands in for ``app.main._start_cloud_background_tasks``: records the keyword arguments of every call."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(self, **kwargs: Any) -> None:
        self.calls.append(kwargs)


class WakeSweeper:
    """The sweeper of the app: counts the first-wake sweeps (``run_wake``) it is asked for."""

    def __init__(self) -> None:
        self.wakes = 0
        self.woke = threading.Event()

    def run_wake(self) -> None:
        self.wakes += 1
        self.woke.set()


@pytest.fixture
def started(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    recorder = Recorder()
    monkeypatch.setattr(main_module, "_start_cloud_background_tasks", recorder)
    return recorder


def quiet(monkeypatch: pytest.MonkeyPatch, seconds: float) -> None:
    """With no request, the work starts this long after start-up."""
    monkeypatch.setattr(main_module, "BACKGROUND_START_QUIET_S", seconds)


def build(tmp_path: Path, sweeper: WakeSweeper, *, cloud: bool = True, own_engine: bool = False) -> Any:
    """A cloud app on fakes (local with ``cloud=False``); ``own_engine``: no injected analyzer, as in production."""
    settings = Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist",
                        auth="firebase" if cloud else "off", signing_key=SIGNING_KEY, scratch_dir=tmp_path / "scratch",
                        upload_bucket=BUCKET, allowed_origins=(PAGES,), allowed_hosts=("testserver",))
    gcs = FakeGcs()
    return create_app(
        settings, analyzer=None if own_engine else FakeEngine(), token_verifier=FakeVerifier(),
        gcs_client_factory=lambda: gcs, admin_db=MemDb(), sweeper=sweeper, scheduler_verifier=None, wake_sweep=True,
        publisher_factory=lambda store: Publisher(store, FakeIndex(), bucket=BUCKET, gcs_client_factory=lambda: gcs),
    )


def wait_for(condition: Callable[[], Any], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)


# --------------------------------------------------------------------------- the app


@pytest.mark.parametrize("own_engine", [False, True], ids=["injected-analyzer", "own-engine"])
def test_the_work_starts_after_the_first_response_and_only_once(
    tmp_path: Path, started: Recorder, monkeypatch: pytest.MonkeyPatch, own_engine: bool
) -> None:
    quiet(monkeypatch, 60)  # the fallback stays out of the way
    sweeper = WakeSweeper()
    app = build(tmp_path, sweeper, own_engine=own_engine)
    with TestClient(app) as client:
        assert started.calls == []  # the server is up, nothing of the work has begun
        assert not sweeper.woke.wait(0.2)

        assert client.get("/api/health").status_code == 200
        assert len(started.calls) == 1
        work = started.calls[0]
        assert work["preload_engine"] is own_engine  # the models are preloaded only when the server analyzes itself
        assert work["bucket"] is app.state.bucket and work["publisher"] is app.state.publisher
        assert work["work_dir"] == app.state.settings.work_dir and not work["stop"].is_set()
        assert sweeper.woke.wait(5) and sweeper.wakes == 1

        assert client.get("/api/health").status_code == 200  # later responses start nothing more
        assert client.get("/api/me").status_code == 401
        time.sleep(0.1)
        assert len(started.calls) == 1 and sweeper.wakes == 1
    assert work["stop"].is_set()  # shutdown ends the sweep loops, as before


def test_a_cors_preflight_does_not_start_it(tmp_path: Path, started: Recorder, monkeypatch: pytest.MonkeyPatch) -> None:
    # A browser's preflight is followed at once by the request it was asked for: that one is answered first.
    quiet(monkeypatch, 60)
    sweeper = WakeSweeper()
    with TestClient(build(tmp_path, sweeper)) as client:
        res = client.options("/api/admin/overview", headers={"Origin": PAGES, "Access-Control-Request-Method": "GET",
                                                             "Access-Control-Request-Headers": "authorization"})
        assert res.status_code == 200 and res.headers["access-control-allow-origin"] == PAGES
        assert started.calls == [] and not sweeper.woke.wait(0.1)
        client.get("/api/health")
        assert len(started.calls) == 1 and sweeper.woke.wait(5)


def test_with_no_request_it_starts_after_a_quiet_period(tmp_path: Path, started: Recorder,
                                                        monkeypatch: pytest.MonkeyPatch) -> None:
    quiet(monkeypatch, 0.5)
    sweeper = WakeSweeper()
    with TestClient(build(tmp_path, sweeper)) as client:
        assert started.calls == []
        wait_for(lambda: len(started.calls) == 1)
        assert sweeper.woke.wait(5) and sweeper.wakes == 1
        assert client.get("/api/health").status_code == 200  # the first response finds it started
        time.sleep(0.1)
        assert len(started.calls) == 1 and sweeper.wakes == 1


def test_a_shutdown_before_the_quiet_period_starts_nothing(tmp_path: Path, started: Recorder,
                                                           monkeypatch: pytest.MonkeyPatch) -> None:
    quiet(monkeypatch, 0.2)
    sweeper = WakeSweeper()
    with TestClient(build(tmp_path, sweeper)):
        pass
    time.sleep(0.5)  # the quiet period is long over
    assert started.calls == [] and sweeper.wakes == 0


def test_local_mode_starts_none_of_it(tmp_path: Path, started: Recorder, monkeypatch: pytest.MonkeyPatch) -> None:
    quiet(monkeypatch, 0.05)
    sweeper = WakeSweeper()
    with TestClient(build(tmp_path, sweeper, cloud=False)) as client:
        assert client.get("/api/health").status_code == 200
        time.sleep(0.3)
        assert started.calls == [] and sweeper.wakes == 0


# --------------------------------------------------------------------------- the trigger (pure ASGI)


def test_the_trigger_fires_once_the_last_part_of_the_body_has_been_sent() -> None:
    events: list[str] = []
    sends: list[Any] = []

    async def inner(scope: dict, receive: Any, send: Any) -> None:
        sends.append(send)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"a", "more_body": True})
        events.append("the app goes on")
        await send({"type": "http.response.body", "body": b"b"})

    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict) -> None:
        events.append(f"{message['type']} more={message.get('more_body', False)}")

    trigger = main_module.AfterFirstResponseMiddleware(inner, start=lambda: events.append("start"))
    http = {"type": "http", "method": "GET", "path": "/api/health", "headers": []}
    anyio.run(trigger, {**http, "method": "OPTIONS"}, receive, send)  # a preflight: passed through untouched
    assert "start" not in events and sends[-1] is send
    events.clear()

    anyio.run(trigger, http, receive, send)
    assert events == ["http.response.start more=False", "http.response.body more=True", "the app goes on",
                      "http.response.body more=False", "start"]

    events.clear()
    anyio.run(trigger, http, receive, send)
    assert "start" not in events
    assert sends[-1] is send  # from then on a plain pass-through: the server's own ``send``, not a wrapper

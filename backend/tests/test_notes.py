"""Live-piano notes endpoints: GET/PUT /api/tracks/{id}/notes (offline & fast: tracks are installed
straight into the store, the "engine" is a stub)."""
from __future__ import annotations

import json
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models import AnalysisResult, Settings

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

ENGINE_INFO = {"name": "fake", "version": "1.0", "features": {}}
TRACK_ID = "0123456789ab"
DURATION = 30.0
PAGES = "https://shchadylotaras.github.io"


def fake_analyzer(path: str, progress: Any | None = None, options: dict | None = None) -> dict:
    if progress:
        progress(0.5, "Detecting chords")
    return {
        "duration": DURATION,
        "tempo": 100.0,
        "timeSignature": 4,
        "beats": [0.0, 0.6],
        "downbeats": [0.0],
        "chords": [{"start": 0.0, "end": DURATION, "label": "G", "root": "G", "quality": "maj", "bass": None, "confidence": 0.9}],
        "key": {"tonic": "G", "mode": "major", "name": "G", "confidence": 0.8},
        "waveform": [0.2, 0.4],
        "engine": "fake 2.0",
    }


@pytest.fixture
def make_client(tmp_path: Path) -> Iterator[Any]:
    clients: list[TestClient] = []

    def factory(**overrides: Any) -> TestClient:
        settings = Settings(
            data_dir=tmp_path / "data",
            frontend_dist=tmp_path / "no-dist",
            allowed_hosts=overrides.pop("allowed_hosts", ("testserver", "localhost", "127.0.0.1")),
            **overrides,
        )
        client = TestClient(create_app(settings, analyzer=fake_analyzer, engine_info_fn=lambda: ENGINE_INFO))
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for c in clients:
        c.__exit__(None, None, None)


def install(client: TestClient, track_id: str = TRACK_ID, duration: float = DURATION) -> None:
    store = client.app.state.store
    staged = store.new_work_dir("test")
    (staged / "audio.mp3").write_bytes(b"\xff\xfb" + b"\x00" * 4000)
    analysis = AnalysisResult.from_engine({**fake_analyzer(""), "duration": duration, "engine": "fake 1.0"})
    meta = {"id": track_id, "title": "Song", "source": {"type": "file", "filename": "song.mp3"}, "createdAt": "2026-10-04T12:00:00Z",
            "duration": duration}
    assert store.install_track(staged, track_id, meta, analysis)


@pytest.fixture
def client(make_client) -> TestClient:
    c = make_client()
    install(c)
    return c


def notes_body(rows: list[list[float]], **extra: Any) -> dict:
    return {"version": 1, "engine": "basic-pitch 1.0.1 (test)", "notes": rows, **extra}


def assert_error(res, status: int, code: str) -> str:
    assert res.status_code == status, res.text
    body = res.json()
    assert body["code"] == code and isinstance(body["detail"], str) and body["detail"], body
    return body["detail"]


def notes_url(track_id: str = TRACK_ID) -> str:
    return f"/api/tracks/{track_id}/notes"


# --------------------------------------------------------------------------- happy path


def test_get_404_then_put_then_get(client: TestClient) -> None:
    detail = assert_error(client.get(notes_url()), 404, "not_found")
    assert "not computed" in detail

    rows = [[1.25049, 1.75, 64, 0.81234], [0.5, 2.0, 60, 0.5], [0.5, 1.0, 48, 1]]
    res = client.put(notes_url(), json=notes_body(rows))
    assert res.status_code == 204, res.text
    assert res.content == b""

    got = client.get(notes_url())
    assert got.status_code == 200
    assert got.headers["content-type"].startswith("application/json")
    assert got.headers["cache-control"] == "no-cache"
    # sorted by start (then pitch), times rounded to ms, velocity to 0.001
    assert got.json() == {
        "version": 1,
        "engine": "basic-pitch 1.0.1 (test)",
        "notes": [[0.5, 1.0, 48, 1.0], [0.5, 2.0, 60, 0.5], [1.25, 1.75, 64, 0.812]],
    }
    stored = client.app.state.settings.tracks_dir / TRACK_ID / "notes.json"
    raw = stored.read_bytes()
    assert b", " not in raw and b": " not in raw and b"\n" not in raw  # compact JSON
    assert not list(stored.parent.glob(".notes.json.*.tmp"))  # atomic write left nothing behind


def test_put_replaces_and_accepts_an_empty_list(client: TestClient) -> None:
    assert client.put(notes_url(), json=notes_body([[0, 1, 60, 0.5]])).status_code == 204
    assert client.put(notes_url(), json=notes_body([])).status_code == 204
    assert client.get(notes_url()).json()["notes"] == []


def test_unknown_or_invalid_tracks(client: TestClient) -> None:
    assert_error(client.get(notes_url("abcdef123456")), 404, "not_found")
    assert_error(client.put(notes_url("abcdef123456"), json=notes_body([])), 404, "not_found")
    assert_error(client.get(notes_url("NOT-HEX")), 404, "not_found")
    assert_error(client.put(notes_url("..%2F..%2Fetc"), json=notes_body([])), 404, "not_found")


# --------------------------------------------------------------------------- validation


@pytest.mark.parametrize(
    ("body", "fragment"),
    [
        (notes_body([[0, 1, 60, 0.5]], version=2), "version"),
        ({"engine": "x", "notes": []}, "version"),
        (notes_body([[0, 1, 60, 0.5]], engine=""), "engine"),
        (notes_body([[0, 1, 60]]), "notes"),
        (notes_body([[0, 1, 20, 0.5]]), "pitch must be 21..108"),
        (notes_body([[0, 1, 109, 0.5]]), "pitch must be 21..108"),
        (notes_body([[0, 1, 60.5, 0.5]]), "integer"),
        (notes_body([[1, 1, 60, 0.5]]), "start < end"),
        (notes_body([[2, 1, 60, 0.5]]), "start < end"),
        (notes_body([[-0.5, 1, 60, 0.5]]), "start < end"),
        (notes_body([[0, 1, 60, 1.5]]), "velocity"),
        (notes_body([[0, 1, 60, -0.1]]), "velocity"),
        (notes_body([[0, 1, 60, "loud"]]), "notes"),
        (notes_body([[0, DURATION + 1.5, 60, 0.5]]), "ends after the track"),
    ],
)
def test_put_rejects_invalid_notes(client: TestClient, body: dict, fragment: str) -> None:
    detail = assert_error(client.put(notes_url(), json=body), 422, "internal")
    assert fragment in detail, detail
    assert_error(client.get(notes_url()), 404, "not_found")  # nothing stored


def test_put_rejects_non_finite_numbers_and_bad_json(client: TestClient) -> None:
    for raw in (b'{"version":1,"engine":"x","notes":[[NaN,1,60,0.5]]}', b'{"version":1,"engine":"x","notes":[[0,Infinity,60,0.5]]}',
                b"not json", b""):
        res = client.put(notes_url(), content=raw, headers={"content-type": "application/json"})
        assert_error(res, 422, "internal")


def test_notes_may_end_slightly_after_the_track(client: TestClient) -> None:
    assert client.put(notes_url(), json=notes_body([[DURATION - 1, DURATION + 0.9, 60, 0.5]])).status_code == 204


def test_note_count_and_body_size_limits(make_client) -> None:
    c = make_client(max_notes=3, max_notes_mb=0.001)  # ~1 KB
    install(c)
    assert_error(c.put(notes_url(), json=notes_body([[i, i + 0.5, 60, 0.5] for i in range(4)])), 422, "internal")
    assert c.put(notes_url(), json=notes_body([[i, i + 0.5, 60, 0.5] for i in range(3)])).status_code == 204
    big = json.dumps(notes_body([[0, 1, 60, 0.5]], engine="x" * 150)) + " " * 1200
    assert_error(c.put(notes_url(), content=big, headers={"content-type": "application/json"}), 413, "too_large")
    assert len(c.get(notes_url()).json()["notes"]) == 3  # the earlier save is untouched


def test_default_limits() -> None:
    s = Settings()
    assert s.max_notes == 300_000 and s.max_notes_bytes == 25 * 1024 * 1024


# --------------------------------------------------------------------------- lifecycle


def test_deleting_the_track_deletes_its_notes(client: TestClient) -> None:
    assert client.put(notes_url(), json=notes_body([[0, 1, 60, 0.5]])).status_code == 204
    assert client.delete(f"/api/tracks/{TRACK_ID}").status_code == 204
    assert not (client.app.state.settings.tracks_dir / TRACK_ID).exists()
    assert_error(client.get(notes_url()), 404, "not_found")
    install(client)  # the same audio added again starts without notes
    detail = assert_error(client.get(notes_url()), 404, "not_found")
    assert "not computed" in detail


def wait_job(client: TestClient, job_id: str, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in ("done", "error"):
            return job
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} did not finish")


def test_reanalysis_keeps_the_notes(client: TestClient) -> None:
    body = notes_body([[0.25, 1.5, 55, 0.7], [1.0, 2.0, 59, 0.4]])
    assert client.put(notes_url(), json=body).status_code == 204
    before = client.get(notes_url()).json()
    res = client.post(f"/api/tracks/{TRACK_ID}/reanalyze")
    assert res.status_code == 201, res.text
    job = wait_job(client, res.json()["id"])
    assert job["status"] == "done", job
    assert client.get(f"/api/tracks/{TRACK_ID}").json()["engine"] == "fake 2.0"  # re-analyzed…
    assert client.get(notes_url()).json() == before  # …the audio is the same, so the notes stay


def test_reset_and_edits_keep_the_notes(client: TestClient) -> None:
    assert client.put(notes_url(), json=notes_body([[0, 1, 60, 0.5]])).status_code == 204
    chords = [{"start": 0, "end": DURATION, "label": "C", "root": "C", "quality": "maj"}]
    assert client.patch(f"/api/tracks/{TRACK_ID}", json={"chords": chords}).status_code == 200
    assert client.post(f"/api/tracks/{TRACK_ID}/reset").status_code == 200
    assert client.get(notes_url()).json()["notes"] == [[0, 1, 60, 0.5]]


def test_unreadable_notes_file_counts_as_not_computed(client: TestClient) -> None:
    path = client.app.state.settings.tracks_dir / TRACK_ID / "notes.json"
    path.write_text("{broken")
    assert_error(client.get(notes_url()), 404, "not_found")
    path.write_text(json.dumps({"version": 99, "notes": []}))
    assert_error(client.get(notes_url()), 404, "not_found")


# --------------------------------------------------------------------------- local-only / CORS protections


def test_cross_site_writes_are_rejected_and_pages_may_use_it(make_client) -> None:
    c = make_client(allowed_hosts=("localhost", "127.0.0.1", "::1"))
    install(c)
    local = TestClient(c.app, base_url="http://localhost:8765")
    body = notes_body([[0, 1, 60, 0.5]])
    assert_error(local.put(notes_url(), json=body, headers={"Origin": "https://evil.example"}), 403, "internal")
    assert_error(c.get(notes_url()), 400, "internal")  # Host: testserver is not a local name (DNS rebinding)

    ok = local.put(notes_url(), json=body, headers={"Origin": PAGES})
    assert ok.status_code == 204 and ok.headers["access-control-allow-origin"] == PAGES
    got = local.get(notes_url(), headers={"Origin": PAGES})
    assert got.status_code == 200 and got.headers["access-control-allow-origin"] == PAGES

    preflight = local.options(
        notes_url(),
        headers={
            "Origin": PAGES,
            "Access-Control-Request-Method": "PUT",
            "Access-Control-Request-Headers": "content-type",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert preflight.status_code == 200
    assert "PUT" in preflight.headers["access-control-allow-methods"]
    assert preflight.headers["access-control-allow-private-network"] == "true"

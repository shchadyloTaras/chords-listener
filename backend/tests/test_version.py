"""Every change a reader can see bumps ``meta["version"]`` (phase 2 publishes it so clients know when a
kept copy is stale). Local-mode store behind the API, reusing test_api's fakes; the vocals bump is
covered with the cloud tests."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from tests.test_api import env, make_env, media, needs_ffmpeg, upload_and_wait, wait_job  # noqa: F401  (fixtures)

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


@needs_ffmpeg
def test_version_grows_with_every_change(env: SimpleNamespace) -> None:
    _, track = upload_and_wait(env, env.media.tagged_mp3)
    tid = track["id"]
    store = env.client.app.state.store
    assert store.version(tid) == 1

    env.client.patch(f"/api/tracks/{tid}", json={"title": "New"})
    assert store.version(tid) == 2
    env.client.patch(f"/api/tracks/{tid}", json={})  # nothing changed
    assert store.version(tid) == 2

    chords = [{"start": 0, "end": 4, "label": "D", "root": "D", "quality": "maj", "confidence": 1}]
    env.client.patch(f"/api/tracks/{tid}", json={"chords": chords})
    assert store.version(tid) == 3
    env.client.post(f"/api/tracks/{tid}/reset")
    assert store.version(tid) == 4
    env.client.post(f"/api/tracks/{tid}/reset")  # no edits left: nothing a reader could see changed
    assert store.version(tid) == 4

    wait_job(env.client, env.client.post(f"/api/tracks/{tid}/reanalyze").json()["id"])
    assert store.version(tid) == 5


@needs_ffmpeg
def test_old_tracks_without_version_read_as_zero(env: SimpleNamespace) -> None:
    _, track = upload_and_wait(env, env.media.tagged_mp3)
    tid = track["id"]
    store = env.client.app.state.store
    meta_path = store.track_dir(tid) / "meta.json"
    meta = json.loads(meta_path.read_text())
    meta.pop("version")
    meta_path.write_text(json.dumps(meta))
    assert store.version(tid) == 0

    env.client.patch(f"/api/tracks/{tid}", json={"title": "x"})
    assert store.version(tid) == 1

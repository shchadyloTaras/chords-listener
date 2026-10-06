"""The publisher (app.publish): per track it writes track.json, makes sure audio / stems carry a download
token and upserts the Firestore index document. Offline: the index is ``FakeIndex``, GCS is ``FakeGcs``."""
from __future__ import annotations

import errno
import json
import logging
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from google.api_core import exceptions as api_exceptions

import app.publish as publish_module
import app.gcs as gcs_module
from app.firestore import IndexError_, to_value
from app.models import AnalysisResult, Settings, TrackPatch, TrackSummary
from app.publish import NullPublisher, Publisher
from app.storage import TrackStore, read_json, write_json_atomic
from app.users import user_context
from tests.test_cloud import BUCKET, FakeGcs, FakeIndex

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

TOKEN_KEY = "firebaseStorageDownloadTokens"
AUDIO_BYTES = b"\xff\xfb" + b"\x00" * 400
ANALYSIS = {
    "duration": 30.0, "tempo": 100.0, "timeSignature": 4, "beats": [0.0, 0.6], "downbeats": [0.0],
    "chords": [{"start": 0.0, "end": 30.0, "label": "G", "root": "G", "quality": "maj", "bass": None,
                "confidence": 0.9}],
    "key": {"tonic": "G", "mode": "major", "name": "G", "confidence": 0.8}, "waveform": [0.2], "engine": "fake 2.0",
}


@pytest.fixture
def store(tmp_path: Path) -> TrackStore:
    settings = Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist", auth="firebase",
                        upload_bucket=BUCKET, scratch_dir=tmp_path / "scratch")
    s = TrackStore(settings)
    s.init()
    return s


@pytest.fixture
def gcs() -> FakeGcs:
    return FakeGcs()


@pytest.fixture
def index() -> FakeIndex:
    return FakeIndex()


@pytest.fixture
def pub(store: TrackStore, gcs: FakeGcs, index: FakeIndex) -> Publisher:
    return Publisher(store, index, bucket=BUCKET, gcs_client_factory=lambda: gcs, attempts=3, backoff_s=0)


def install(store: TrackStore, gcs: FakeGcs, uid: str = "alice", track_id: str = "0123456789ab",
            stems: tuple[str, ...] = (), **meta_extra: Any) -> str:
    """Install a track under ``uid`` and put its files in the fake bucket, as the mount would show them."""
    staged = store.new_work_dir("test")
    (staged / "audio.mp3").write_bytes(AUDIO_BYTES)
    for name in stems:
        (staged / "stems").mkdir(exist_ok=True)
        (staged / "stems" / f"{name}.mp3").write_bytes(AUDIO_BYTES)
    meta = {"id": track_id, "title": "Song", "source": {"type": "file", "filename": "song.mp3"},
            "createdAt": "2026-10-04T12:00:00Z", "duration": 30.0, **meta_extra}
    if stems:
        meta.update(vocals=True, stems=list(stems))
    with user_context(uid):
        assert store.install_track(staged, track_id, meta, AnalysisResult.from_engine(ANALYSIS))
    gcs.put(f"users/{uid}/tracks/{track_id}/audio.mp3", AUDIO_BYTES)
    for name in stems:
        gcs.put(f"users/{uid}/tracks/{track_id}/stems/{name}.mp3", AUDIO_BYTES)
    return track_id


@pytest.fixture
def tid(store: TrackStore, gcs: FakeGcs) -> str:
    return install(store, gcs)


def track_json(store: TrackStore, tid: str, uid: str = "alice") -> dict:
    with user_context(uid):
        return json.loads((store.track_dir(tid) / "track.json").read_text())


def pending_path(store: TrackStore, uid: str = "alice") -> Path:
    return store.user_dir(uid) / "publish-pending.json"


def blob_of(gcs: FakeGcs, path: str) -> Any:
    blob = gcs.bucket(BUCKET).get_blob(path)
    assert blob is not None, path
    return blob


# --------------------------------------------------------------------------- publish


def test_publish_writes_index_track_file_and_tokens(pub, store, gcs, index, tid):
    assert pub.publish("alice", tid)
    doc = index.docs[("alice", tid)]
    assert doc["version"] == 1 and doc["title"] and "audioUrl" not in doc
    tf = track_json(store, tid)
    assert tf["version"] == 1 and "audioUrl" not in tf and "stemUrls" not in tf
    blob = blob_of(gcs, f"users/alice/tracks/{tid}/audio.mp3")
    assert tf["media"]["audio"] == {"path": f"users/alice/tracks/{tid}/audio.mp3",
                                    "token": blob.metadata[TOKEN_KEY]}
    assert blob.content_type == "audio/mpeg"


def test_index_document_has_the_summary_fields_a_version_and_a_publish_time(pub, index, tid):
    before = datetime.now(timezone.utc)
    pub.publish("alice", tid)
    doc = index.docs[("alice", tid)]
    summary_keys = set(TrackSummary.model_validate({"id": tid, "title": "t", "duration": 1, "source": {"type": "file"},
                                                    "createdAt": "x"}).model_dump(mode="json"))
    assert set(doc) == summary_keys | {"version", "publishedAt"}
    assert doc["id"] == tid and doc["createdAt"] == "2026-10-04T12:00:00Z"
    assert doc["chordCount"] == 1 and doc["key"]["tonic"] == "G" and doc["edited"] is False
    assert before - timedelta(seconds=1) <= doc["publishedAt"] <= datetime.now(timezone.utc)
    assert doc["publishedAt"].tzinfo is not None


def test_the_index_document_can_be_stored_in_firestore(pub, index, tid):
    pub.publish("alice", tid)
    fields = to_value(index.docs[("alice", tid)])["mapValue"]["fields"]  # no value Firestore cannot hold
    assert fields["version"] == {"integerValue": "1"}
    assert fields["publishedAt"]["timestampValue"].endswith("Z")


def test_track_file_holds_the_whole_track(pub, store, tid):
    pub.publish("alice", tid)
    tf = track_json(store, tid)
    assert tf["id"] == tid and tf["chords"][0]["label"] == "G" and tf["waveform"] == [0.2]
    assert tf["media"]["stems"] == {}


def test_publish_with_stems_gives_each_a_token(pub, store, gcs, index):
    tid = install(store, gcs, track_id="abcdef012345", stems=("vocals", "instruments"))
    assert pub.publish("alice", tid)
    tf = track_json(store, tid)
    assert set(tf["media"]["stems"]) == {"vocals", "instruments"}
    for name, item in tf["media"]["stems"].items():
        path = f"users/alice/tracks/{tid}/stems/{name}.mp3"
        blob = blob_of(gcs, path)
        assert item == {"path": path, "token": blob.metadata[TOKEN_KEY]}
        assert blob.content_type == "audio/mpeg"
    assert index.docs[("alice", tid)]["stems"] == ["vocals", "instruments"]


def test_a_missing_object_is_left_out_of_media(pub, store, gcs, tid):
    del gcs.objects[(BUCKET, f"users/alice/tracks/{tid}/audio.mp3")]
    assert pub.publish("alice", tid)
    assert "audio" not in track_json(store, tid)["media"]


def test_tokens_are_kept_across_publishes(pub, gcs, tid):
    pub.publish("alice", tid)
    first = blob_of(gcs, f"users/alice/tracks/{tid}/audio.mp3").metadata
    patched = len(gcs.patched)
    pub.publish("alice", tid)
    again = blob_of(gcs, f"users/alice/tracks/{tid}/audio.mp3").metadata
    assert first[TOKEN_KEY] == again[TOKEN_KEY]
    assert len(gcs.patched) == patched  # nothing to change the second time


def test_a_token_the_object_already_has_is_used(pub, store, gcs, tid):
    path = f"users/alice/tracks/{tid}/audio.mp3"
    gcs.put(path, AUDIO_BYTES, content_type="application/octet-stream",
            metadata={TOKEN_KEY: "tok-a,tok-b", "other": "kept"})
    pub.publish("alice", tid)
    assert track_json(store, tid)["media"]["audio"]["token"] == "tok-a"
    blob = blob_of(gcs, path)
    assert blob.metadata == {TOKEN_KEY: "tok-a,tok-b", "other": "kept"}  # the token list is not rewritten
    assert blob.content_type == "audio/mpeg"  # the wrong content type is fixed


def test_a_new_token_keeps_the_other_metadata(pub, gcs, tid):
    path = f"users/alice/tracks/{tid}/audio.mp3"
    gcs.put(path, AUDIO_BYTES, metadata={"other": "kept"})
    pub.publish("alice", tid)
    meta = blob_of(gcs, path).metadata
    assert meta["other"] == "kept" and meta[TOKEN_KEY]


def test_publish_carries_the_current_version(pub, store, index, tid):
    pub.publish("alice", tid)
    with user_context("alice"):
        store.patch(tid, TrackPatch(title="Renamed"))
    pub.publish("alice", tid)
    doc = index.docs[("alice", tid)]
    assert doc["title"] == "Renamed" and doc["version"] == 2
    assert track_json(store, tid)["version"] == 2


def test_a_missing_created_at_is_written_once_without_a_version_bump(pub, store, gcs, index):
    tid = install(store, gcs, track_id="00112233aabb")
    with user_context("alice"):
        meta = store.read_meta(tid)
        meta.pop("createdAt")
        write_json_atomic(store.track_dir(tid) / "meta.json", meta)
        assert "createdAt" not in store.read_meta(tid)
    pub.publish("alice", tid)
    with user_context("alice"):
        stamped = store.read_meta(tid)
        assert stamped["version"] == 1  # not a change a reader can see
    assert index.docs[("alice", tid)]["createdAt"] == stamped["createdAt"]
    assert track_json(store, tid)["createdAt"] == stamped["createdAt"]
    assert stamped["createdAt"].endswith("Z")
    pub.publish("alice", tid)
    assert index.docs[("alice", tid)]["createdAt"] == stamped["createdAt"]  # stable


def test_publish_of_a_missing_track_removes_its_document(pub, index):
    index.docs[("alice", "0123456789ab")] = {"id": "0123456789ab"}
    assert pub.publish("alice", "0123456789ab") is True
    assert ("alice", "0123456789ab") not in index.docs


def test_tracks_of_other_users_are_published_under_their_own_uid(pub, store, gcs, index):
    a = install(store, gcs, uid="alice", track_id="aaaaaaaaaaaa")
    b = install(store, gcs, uid="bob", track_id="bbbbbbbbbbbb")
    pub.publish("alice", a)
    pub.publish("bob", b)
    assert set(index.docs) == {("alice", a), ("bob", b)}
    assert track_json(store, b, uid="bob")["media"]["audio"]["path"] == f"users/bob/tracks/{b}/audio.mp3"


# --------------------------------------------------------------------------- ensure_published (the dedup self-heal)


def test_ensure_published_publishes_what_the_index_lacks(pub, index, tid):
    assert pub.ensure_published("alice", tid) is True
    assert index.docs[("alice", tid)]["version"] == 1


def test_ensure_published_leaves_a_published_track_alone(pub, index, tid):
    assert pub.publish("alice", tid)
    index.docs[("alice", tid)]["title"] = "kept"
    writes = index.calls
    assert pub.ensure_published("alice", tid) is True
    assert index.calls == writes and index.docs[("alice", tid)]["title"] == "kept"


def test_ensure_published_publishes_when_the_index_cannot_say(pub, index, tid, monkeypatch):
    def down(uid: str, track_id: str) -> bool:
        raise IndexError_("down", retryable=True)

    monkeypatch.setattr(index, "exists", down)
    assert pub.ensure_published("alice", tid) is True
    assert ("alice", tid) in index.docs


def test_ensure_published_queues_a_failure_and_does_not_raise(pub, store, index, tid):
    index.fail, index.retryable = 1, False
    assert pub.ensure_published("alice", tid) is False
    assert json.loads(pending_path(store).read_text()) == {"ids": {tid: "publish"}}


# --------------------------------------------------------------------------- retries and the pending list


def test_publish_failure_goes_pending_and_sweeps(pub, store, index, tid):
    index.fail = 3
    assert pub.publish("alice", tid) is False
    pending = json.loads((store.user_dir("alice") / "publish-pending.json").read_text())
    assert pending == {"ids": {tid: "publish"}}
    assert pub.sweep_pending() == 1
    assert ("alice", tid) in index.docs
    assert not (store.user_dir("alice") / "publish-pending.json").exists()


def test_a_retry_that_succeeds_leaves_nothing_pending(pub, store, index, tid):
    index.fail = 2
    assert pub.publish("alice", tid) is True
    assert index.calls == 3 and ("alice", tid) in index.docs
    assert not pending_path(store).exists()


def test_retries_back_off_exponentially(store, gcs, index, tid, monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr(publish_module.time, "sleep", sleeps.append)
    pub = Publisher(store, index, bucket=BUCKET, gcs_client_factory=lambda: gcs, attempts=4, backoff_s=0.5)
    index.fail = 10
    assert pub.publish("alice", tid) is False
    assert index.calls == 4 and sleeps == [0.5, 1.0, 2.0]


def test_a_lasting_error_is_not_retried(pub, store, index, tid):
    index.fail, index.retryable = 5, False
    assert pub.publish("alice", tid) is False
    assert index.calls == 1
    assert read_json(pending_path(store)) == {"ids": {tid: "publish"}}


def test_an_unexpected_error_does_not_reach_the_caller(pub, store, index, tid, monkeypatch):
    def boom(*_a: Any) -> None:
        raise TypeError("can't store a thing in Firestore")

    monkeypatch.setattr(index, "upsert", boom)
    assert pub.publish("alice", tid) is False
    assert read_json(pending_path(store)) == {"ids": {tid: "publish"}}


def test_a_transient_storage_error_is_retried(pub, gcs, index, tid, monkeypatch):
    real = type(gcs.bucket(BUCKET)).get_blob
    failures = [api_exceptions.ServiceUnavailable("try later")]

    def flaky(self: Any, name: str) -> Any:
        if failures:
            raise failures.pop()
        return real(self, name)

    monkeypatch.setattr(type(gcs.bucket(BUCKET)), "get_blob", flaky)
    assert pub.publish("alice", tid) is True
    assert ("alice", tid) in index.docs


def test_a_lasting_storage_error_goes_pending_without_retries(pub, store, gcs, index, tid, monkeypatch):
    calls = []

    def denied(self: Any, name: str) -> Any:
        calls.append(name)
        raise api_exceptions.Forbidden("no")

    monkeypatch.setattr(type(gcs.bucket(BUCKET)), "get_blob", denied)
    assert pub.publish("alice", tid) is False
    assert len(calls) == 1 and ("alice", tid) not in index.docs
    assert read_json(pending_path(store)) == {"ids": {tid: "publish"}}


def test_a_success_clears_only_its_own_pending_entry(pub, store, index, tid):
    other = "abcdef012345"
    write_json_atomic(pending_path(store), {"ids": {tid: "publish", other: "unpublish"}})
    assert pub.publish("alice", tid) is True
    assert read_json(pending_path(store)) == {"ids": {other: "unpublish"}}


def test_sweep_does_one_attempt_per_entry_and_keeps_failures(pub, store, index, tid):
    write_json_atomic(pending_path(store), {"ids": {tid: "publish"}})
    index.fail = 5
    assert pub.sweep_pending() == 0
    assert index.calls == 1
    assert read_json(pending_path(store)) == {"ids": {tid: "publish"}}


def test_sweep_goes_through_every_user(pub, store, gcs, index):
    a = install(store, gcs, uid="alice", track_id="aaaaaaaaaaaa")
    b = install(store, gcs, uid="bob", track_id="bbbbbbbbbbbb")
    write_json_atomic(pending_path(store, "alice"), {"ids": {a: "publish"}})
    write_json_atomic(pending_path(store, "bob"), {"ids": {b: "publish", "ccccccccccc1": "unpublish"}})
    assert pub.sweep_pending() == 3
    assert set(index.docs) == {("alice", a), ("bob", b)}
    assert not pending_path(store, "alice").exists() and not pending_path(store, "bob").exists()


def test_sweep_with_nothing_pending(pub):
    assert pub.sweep_pending() == 0


def test_sweep_ignores_an_unreadable_pending_file(pub, store, tid):
    store.user_dir("alice").mkdir(parents=True, exist_ok=True)
    pending_path(store).write_text("{not json")
    assert pub.sweep_pending() == 0


# --------------------------------------------------------------------------- unpublish and delete


def test_unpublish_removes_the_document(pub, index, tid):
    pub.publish("alice", tid)
    assert pub.unpublish("alice", tid) is True
    assert ("alice", tid) not in index.docs


def test_a_failed_unpublish_goes_pending_and_the_sweep_finishes_it(pub, store, index, tid):
    pub.publish("alice", tid)
    index.fail = 3
    assert pub.unpublish("alice", tid) is False
    assert read_json(pending_path(store)) == {"ids": {tid: "unpublish"}}
    with user_context("alice"):
        store._discard_dir(store.track_dir(tid))
    assert pub.sweep_pending() == 1
    assert ("alice", tid) not in index.docs
    assert not pending_path(store).exists()


def test_unpublish_wins_over_a_late_publish(pub, store, index, tid):
    pub.publish("alice", tid)
    removed = []

    def remove():
        # a publish racing the delete waits for the per-track lock, then finds no directory
        t = threading.Thread(target=pub.publish, args=("alice", tid))
        t.start()
        t.join(0.3)
        assert t.is_alive()  # still waiting for the lock the delete holds
        with user_context("alice"):
            store._discard_dir(store.track_dir(tid))
        removed.append(t)

    pub.delete_track("alice", tid, remove)
    removed[0].join(5)
    assert ("alice", tid) not in index.docs
    assert pub.publish("alice", tid) is True  # publish of a missing track = unpublish
    assert ("alice", tid) not in index.docs


def test_delete_track_unpublishes_before_it_removes(pub, store, index, tid):
    pub.publish("alice", tid)
    seen = []
    pub.delete_track("alice", tid, lambda: seen.append(("alice", tid) in index.docs))
    assert seen == [False]


def test_delete_track_removes_even_when_the_index_is_down(pub, store, index, tid):
    pub.publish("alice", tid)
    index.fail = 3
    removed = []
    pub.delete_track("alice", tid, lambda: removed.append(True))
    assert removed == [True]
    assert read_json(pending_path(store)) == {"ids": {tid: "unpublish"}}


def test_delete_track_lets_a_failing_removal_through(pub, tid):
    def remove():
        raise OSError("disk")

    lock = pub._lock_for("alice", tid)  # kept alive, so the delete below uses this very lock
    with pytest.raises(OSError):
        pub.delete_track("alice", tid, remove)
    assert lock.acquire(blocking=False)  # released again


def test_the_per_track_lock_is_shared_by_uid_and_track(pub):
    assert pub._lock_for("alice", "0123456789ab") is pub._lock_for("alice", "0123456789ab")
    assert pub._lock_for("alice", "0123456789ab") is not pub._lock_for("bob", "0123456789ab")
    assert pub._lock_for("alice", "0123456789ab") is not pub._lock_for("alice", "abcdef012345")


# --------------------------------------------------------------------------- backfill


def test_backfill_is_idempotent(pub, index, tid):
    assert pub.backfill() == 1 and pub.backfill() == 1
    assert len(index.docs) == 1


def test_backfill_publishes_every_users_tracks(pub, store, gcs, index, tid):
    b = install(store, gcs, uid="bob", track_id="bbbbbbbbbbbb")
    c = install(store, gcs, uid="bob", track_id="cccccccccccc")
    (store.settings.users_dir / "bob" / "tracks" / "not-a-track").mkdir()
    (store.settings.users_dir / "bob" / "tracks" / "dddddddddddd").mkdir()  # an incomplete leftover
    assert pub.backfill() == 3
    assert set(index.docs) == {("alice", tid), ("bob", b), ("bob", c)}


def test_backfill_can_be_limited_to_one_user(pub, store, gcs, index, tid):
    b = install(store, gcs, uid="bob", track_id="bbbbbbbbbbbb")
    assert pub.backfill("bob") == 1
    assert set(index.docs) == {("bob", b)}
    assert pub.backfill("nobody") == 0
    assert pub.backfill("../alice") == 0


def test_backfill_counts_only_what_was_published(pub, index, tid):
    index.fail = 3
    assert pub.backfill() == 0
    assert pub.sweep_pending() == 1


def test_backfill_with_no_users(pub):
    assert pub.backfill() == 0


# --------------------------------------------------------------------------- the bucket mount fails


def eio(*_a: Any, **_k: Any) -> Any:
    raise OSError(errno.EIO, "Input/output error")


def test_sweep_survives_a_failing_listing(pub, store, index, tid, monkeypatch, caplog):
    write_json_atomic(pending_path(store), {"ids": {tid: "publish"}})
    with monkeypatch.context() as m:
        m.setattr(Path, "glob", eio)
        with caplog.at_level(logging.WARNING, logger="chords.publish"):
            assert pub.sweep_pending() == 0
    assert "could not list" in caplog.text
    assert not index.docs and pending_path(store).exists()  # nothing lost: the next sweep does it
    assert pub.sweep_pending() == 1


@pytest.mark.parametrize("uid", [None, "alice"])
def test_backfill_survives_a_failing_listing(pub, index, tid, monkeypatch, uid):
    with monkeypatch.context() as m:
        m.setattr(Path, "iterdir", eio)
        assert pub.backfill(uid) == 0
    assert not index.docs
    assert pub.backfill(uid) == 1


@pytest.mark.parametrize("failing", ["is_dir", "is_file"])
def test_backfill_skips_a_track_it_cannot_check(pub, store, gcs, index, tid, monkeypatch, failing):
    other = install(store, gcs, track_id="bbbbbbbbbbbb")
    real = getattr(Path, failing)

    def flaky(self: Path) -> bool:
        if "bbbbbbbbbbbb" in self.parts:
            eio()
        return real(self)

    monkeypatch.setattr(Path, failing, flaky)
    assert pub.backfill() == 1
    assert set(index.docs) == {("alice", tid)} and other not in {t for _, t in index.docs}


# --------------------------------------------------------------------------- the null publisher


def test_null_publisher_does_nothing(store, tid):
    null = NullPublisher()
    assert null.publish("alice", tid) is True
    assert null.unpublish("alice", tid) is True
    assert null.ensure_published("alice", tid) is True
    assert null.sweep_pending() == 0 and null.backfill() == 0
    assert not (store.user_dir("alice") / "tracks" / tid / "track.json").exists()


def test_null_publisher_still_removes_on_delete(tid):
    removed = []
    NullPublisher().delete_track(None, tid, lambda: removed.append(True))
    assert removed == [True]


# --------------------------------------------------------------------------- python -m app.publish backfill


@pytest.fixture
def cli(store, gcs, index, monkeypatch, capsys):
    """``main(argv)`` against the store's data dir with the fake clients; returns (exit code, printed text)."""
    env = {"CHORDS_AUTH": "firebase", "CHORDS_DATA_DIR": str(store.settings.data_dir), "CHORDS_UPLOAD_BUCKET": BUCKET,
           "CHORDS_FIREBASE_PROJECT": "my-project"}
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    projects: list[str] = []
    monkeypatch.setattr(publish_module, "FirestoreIndex", lambda project: projects.append(project) or index)
    monkeypatch.setattr(gcs_module, "default_client", lambda project=None: gcs)

    def run(*argv: str) -> tuple[int, str]:
        code = publish_module.main(list(argv))
        return code, capsys.readouterr().out

    run.projects = projects  # type: ignore[attr-defined]
    return run


def test_backfill_command_publishes_every_users_tracks(cli, store, gcs, index, tid):
    bob = install(store, gcs, uid="bob", track_id="bbbbbbbbbbbb")
    code, out = cli("backfill")
    assert code == 0 and out.strip() == "2 track(s) published"
    assert set(index.docs) == {("alice", tid), ("bob", bob)}
    assert blob_of(gcs, f"users/alice/tracks/{tid}/audio.mp3").metadata[TOKEN_KEY]
    assert cli.projects == ["my-project"]
    assert cli("backfill")[1].strip() == "2 track(s) published"  # idempotent


def test_backfill_command_can_be_limited_to_one_user(cli, store, gcs, index, tid):
    install(store, gcs, uid="bob", track_id="bbbbbbbbbbbb")
    code, out = cli("backfill", "--uid", "alice")
    assert code == 0 and out.strip() == "1 track(s) published"
    assert set(index.docs) == {("alice", tid)}


def test_backfill_command_ignores_the_publish_switch(cli, monkeypatch, index, tid):
    monkeypatch.setenv("CHORDS_PUBLISH", "off")  # that switch is for the service's own changes
    assert cli("backfill")[1].strip() == "1 track(s) published" and ("alice", tid) in index.docs


def test_backfill_command_needs_the_cloud_environment(cli, monkeypatch, index, tid):
    monkeypatch.delenv("CHORDS_UPLOAD_BUCKET")
    with pytest.raises(SystemExit) as exit_info:
        cli("backfill")
    assert exit_info.value.code == 2 and not index.docs
    monkeypatch.setenv("CHORDS_UPLOAD_BUCKET", BUCKET)
    monkeypatch.setenv("CHORDS_AUTH", "off")
    with pytest.raises(SystemExit):
        cli("backfill")


@pytest.mark.parametrize("argv", [(), ("backfill", "--uid", "../x"), ("publish",)])
def test_backfill_command_rejects_bad_arguments(cli, index, argv):
    with pytest.raises(SystemExit) as exit_info:
        cli(*argv)
    assert exit_info.value.code == 2 and not index.docs

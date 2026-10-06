"""The Firestore REST client the API uses to keep one index document per track. Offline: the HTTP session is a fake."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
import requests
from google.auth import exceptions as gexc

from app.firestore import FirestoreIndex, IndexError_, from_value, to_value

DOC = "https://firestore.googleapis.com/v1/projects/p1/databases/(default)/documents/users/alice/tracks/0123456789ab"


class FakeSession:
    """Answers with the given statuses in order (200 after that); an Exception in the list is raised instead."""

    def __init__(self, *responses):
        self.calls, self.responses = [], list(responses)

    def request(self, method, url, json=None, headers=None, timeout=None):
        self.calls.append((method, url, json, headers))
        status = self.responses.pop(0) if self.responses else 200
        if isinstance(status, Exception):
            raise status
        return SimpleNamespace(status_code=status, text="", json=lambda: {})


def test_upsert_patches_the_document_with_typed_fields():
    s = FakeSession(200)
    idx = FirestoreIndex("p1", session_factory=lambda: s)
    idx.upsert("alice", "0123456789ab", {"title": "T", "version": 3, "duration": 1.5, "vocals": False,
                                         "artist": None, "stems": ["vocals"], "source": {"type": "file"}})
    method, url, body, _ = s.calls[0]
    assert method == "PATCH"
    assert url == DOC
    f = body["fields"]
    assert f["version"] == {"integerValue": "3"} and f["duration"] == {"doubleValue": 1.5}
    assert f["artist"] == {"nullValue": None} and f["vocals"] == {"booleanValue": False}
    assert f["stems"] == {"arrayValue": {"values": [{"stringValue": "vocals"}]}}
    assert f["source"] == {"mapValue": {"fields": {"type": {"stringValue": "file"}}}}


def test_upsert_replaces_the_whole_document():
    s = FakeSession(200)
    FirestoreIndex("p1", session_factory=lambda: s).upsert("alice", "0123456789ab", {"title": "T"})
    assert s.calls[0][1] == DOC  # no ?updateMask: fields that are not sent are removed


def test_delete_treats_404_as_done():
    idx = FirestoreIndex("p1", session_factory=lambda: FakeSession(404))
    idx.delete("alice", "0123456789ab")   # no raise


def test_delete_sends_a_delete_request():
    s = FakeSession(200)
    FirestoreIndex("p1", session_factory=lambda: s).delete("alice", "0123456789ab")
    assert s.calls[0][:2] == ("DELETE", DOC)


@pytest.mark.parametrize("status,found", [(200, True), (404, False)])
def test_exists_reads_the_status(status, found):
    s = FakeSession(status)
    assert FirestoreIndex("p1", session_factory=lambda: s).exists("alice", "0123456789ab") is found
    assert s.calls[0][:2] == ("GET", DOC)


@pytest.mark.parametrize("status,retryable", [(429, True), (503, True), (403, False), (400, False)])
def test_errors_say_whether_to_retry(status, retryable):
    idx = FirestoreIndex("p1", session_factory=lambda: FakeSession(status))
    with pytest.raises(IndexError_) as e:
        idx.upsert("alice", "0123456789ab", {"title": "T"})
    assert e.value.retryable is retryable


@pytest.mark.parametrize("call", ["upsert", "delete", "exists"])
def test_every_call_raises_on_a_server_error(call):
    idx = FirestoreIndex("p1", session_factory=lambda: FakeSession(500))
    args = ("alice", "0123456789ab") + (({"title": "T"},) if call == "upsert" else ())
    with pytest.raises(IndexError_) as e:
        getattr(idx, call)(*args)
    assert e.value.retryable is True


@pytest.mark.parametrize("failure,retryable", [
    (requests.ConnectionError("reset"), True),
    (requests.Timeout("slow"), True),
    (gexc.TransportError("metadata server down"), True),
    (gexc.DefaultCredentialsError("no credentials"), False),
])
def test_network_and_credential_failures_become_index_errors(failure, retryable):
    idx = FirestoreIndex("p1", session_factory=lambda: FakeSession(failure))
    with pytest.raises(IndexError_) as e:
        idx.upsert("alice", "0123456789ab", {"title": "T"})
    assert e.value.retryable is retryable


def test_emulator_url_and_owner_token():
    s = FakeSession(200)
    FirestoreIndex("p1", session_factory=lambda: s, emulator_host="127.0.0.1:8080").exists("alice", "0123456789ab")
    method, url, _, headers = s.calls[0]
    assert method == "GET" and url.startswith("http://127.0.0.1:8080/v1/projects/p1/")
    assert headers["Authorization"] == "Bearer owner"


def test_emulator_host_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "localhost:8081")
    s = FakeSession(200)
    FirestoreIndex("p1", session_factory=lambda: s).delete("alice", "0123456789ab")
    assert s.calls[0][1].startswith("http://localhost:8081/v1/projects/p1/databases/(default)/documents/")
    assert s.calls[0][3] == {"Authorization": "Bearer owner"}


def test_without_an_emulator_there_is_no_authorization_header(monkeypatch):
    monkeypatch.delenv("FIRESTORE_EMULATOR_HOST", raising=False)
    s = FakeSession(200)
    FirestoreIndex("p1", session_factory=lambda: s).exists("alice", "0123456789ab")
    assert s.calls[0][3] is None  # the AuthorizedSession adds the service account's token


def test_the_session_is_created_lazily_and_once():
    made = []

    def factory():
        made.append(1)
        return FakeSession()

    idx = FirestoreIndex("p1", session_factory=factory)
    assert made == []
    idx.exists("alice", "0123456789ab")
    idx.exists("alice", "0123456789ab")
    assert made == [1]


def test_ids_are_escaped_in_the_url():
    s = FakeSession(200)
    FirestoreIndex("p1", session_factory=lambda: s).exists("a/b", "x y")
    assert s.calls[0][1].endswith("/users/a%2Fb/tracks/x%20y")


def test_values_round_trip():
    v = {"a": [1, 2.5, None, True, "x"], "m": {"k": "v"}}
    assert from_value(to_value(v)) == v


def test_bool_is_not_an_integer_and_ints_are_strings():
    assert to_value(True) == {"booleanValue": True}
    assert to_value(7) == {"integerValue": "7"}
    assert from_value({"integerValue": "7"}) == 7


def test_empty_containers_round_trip():
    assert from_value(to_value([])) == [] and from_value(to_value({})) == {}
    assert from_value({"arrayValue": {}}) == [] and from_value({"mapValue": {}}) == {}


def test_datetimes_are_utc_timestamps_with_z():
    assert to_value(datetime(2026, 10, 5, 8, 30, 15, 250000, tzinfo=timezone.utc)) == {
        "timestampValue": "2026-10-05T08:30:15.250000Z"}
    assert to_value(datetime(2026, 10, 5, 10, 0, tzinfo=timezone(timedelta(hours=2)))) == {
        "timestampValue": "2026-10-05T08:00:00Z"}
    assert from_value({"timestampValue": "2026-10-05T08:00:00Z"}) == "2026-10-05T08:00:00Z"


def test_a_naive_datetime_is_refused():
    with pytest.raises(ValueError):
        to_value(datetime(2026, 10, 5, 8, 0))


def test_unsupported_values_are_refused():
    with pytest.raises(TypeError):
        to_value(object())
    with pytest.raises(ValueError):
        from_value({"bytesValue": "AA=="})

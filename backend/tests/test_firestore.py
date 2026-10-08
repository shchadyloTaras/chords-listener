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


# ===================================================================== admin extensions (T01, AC-33)
# Batched writes with preconditions, transactions, structured queries and aggregations: the building
# blocks of "no audit record, no action" (ADR-0007). Offline tests pin the REST bodies; the emulator tests
# below prove the behaviour against a real Firestore (they run only when FIRESTORE_EMULATOR_HOST is set).

import json as _json
import os
import threading
import uuid

import app.firestore as fs

EMULATOR_HOST = os.environ.get("FIRESTORE_EMULATOR_HOST")


@pytest.fixture(autouse=True)
def _offline(monkeypatch):
    """Only the emulator tests (``db``) talk to an emulator; every other test here is offline with a fake session."""
    monkeypatch.delenv("FIRESTORE_EMULATOR_HOST", raising=False)


ROOT = "projects/p1/databases/(default)/documents"
URL = "https://firestore.googleapis.com/v1/" + ROOT


class Scripted:
    """Answers with (status, json body) pairs in order; an Exception is raised instead."""

    def __init__(self, *responses):
        self.calls, self.responses = [], list(responses)

    def request(self, method, url, json=None, headers=None, timeout=None):
        self.calls.append((method, url, json))
        item = self.responses.pop(0) if self.responses else (200, {})
        if isinstance(item, Exception):
            raise item
        status, body = item
        return SimpleNamespace(status_code=status, text=_json.dumps(body), content=b"x", json=lambda: body)


def client(*responses, **kw):
    s = Scripted(*responses)
    return fs.FirestoreIndex("p1", session_factory=lambda: s, **kw), s


def error_body(status, code):
    return {"error": {"code": code, "status": status, "message": status.lower()}}


def verbs(s):
    return [c[1].rsplit(":", 1)[1] for c in s.calls]


def test_update_op_carries_mask_precondition_and_transforms():
    idx, _ = client()
    w = idx.update_op("adminConfig/settings", {"banner": {"text": "hi"}}, exists=True, mask=["banner.text"],
                      transforms=[fs.server_timestamp("updatedAt"), fs.increment("version", 2)])
    assert w == {
        "update": {"name": f"{ROOT}/adminConfig/settings",
                   "fields": {"banner": {"mapValue": {"fields": {"text": {"stringValue": "hi"}}}}}},
        "updateMask": {"fieldPaths": ["banner.text"]},
        "currentDocument": {"exists": True},
        "updateTransforms": [{"fieldPath": "updatedAt", "setToServerValue": "REQUEST_TIME"},
                             {"fieldPath": "version", "increment": {"integerValue": "2"}}],
    }


def test_update_op_without_options_replaces_the_document():
    idx, _ = client()
    w = idx.update_op("a/b", {"x": 1})
    assert set(w) == {"update"} and w["update"]["fields"] == {"x": {"integerValue": "1"}}


def test_transform_only_update_has_an_empty_mask_so_other_fields_survive():
    idx, _ = client()
    w = idx.update_op("a/b", {}, transforms=[fs.increment("n")])
    assert w["updateMask"] == {"fieldPaths": []} and w["updateTransforms"][0]["increment"] == {"integerValue": "1"}


def test_delete_op_with_precondition():
    idx, _ = client()
    assert idx.delete_op("a/b", exists=True) == {"delete": f"{ROOT}/a/b", "currentDocument": {"exists": True}}
    assert idx.delete_op("a/b") == {"delete": f"{ROOT}/a/b"}


def test_field_path_quotes_unsafe_segments():
    assert fs.field_path("analyses", "web") == "analyses.web"
    assert fs.field_path("failedByReason", "no-audio found") == "failedByReason.`no-audio found`"
    assert fs.field_path("a", "x`y") == "a.`x\\`y`"


def test_commit_posts_the_writes_to_the_commit_endpoint():
    idx, s = client((200, {"writeResults": [{}, {}]}))
    writes = [idx.update_op("a/1", {"x": 1}), idx.delete_op("a/2")]
    idx.commit(writes)
    assert s.calls == [("POST", f"{URL}:commit", {"writes": writes})]


@pytest.mark.parametrize("status,code,kind", [
    (404, "NOT_FOUND", "PreconditionFailed"),          # exists=True on a missing document
    (409, "ALREADY_EXISTS", "PreconditionFailed"),     # exists=False on an existing one
    (400, "FAILED_PRECONDITION", "PreconditionFailed"),
    (409, "ABORTED", "Aborted"),
])
def test_commit_failures_are_told_apart(status, code, kind):
    kind = getattr(fs, kind)
    idx, _ = client((status, error_body(code, status)))
    with pytest.raises(kind) as e:
        idx.commit([idx.update_op("a/1", {"x": 1}, exists=False)])
    assert isinstance(e.value, IndexError_)
    assert e.value.retryable is (kind is fs.Aborted)


def test_a_commit_that_hits_a_server_error_stays_a_plain_retryable_index_error():
    idx, _ = client((503, {}))
    with pytest.raises(IndexError_) as e:
        idx.commit([idx.delete_op("a/1")])
    assert e.value.retryable is True and not isinstance(e.value, (fs.Aborted, fs.PreconditionFailed))


def test_transaction_retries_after_aborted_and_commits_once():
    idx, s = client(
        (200, {"transaction": "t1"}),                                   # begin
        (200, [{"found": {"name": f"{ROOT}/a/1", "fields": {"n": {"integerValue": "4"}}}}]),   # get
        (409, error_body("ABORTED", 409)),                              # commit: conflict
        (200, {}),                                                      # rollback (best effort)
        (200, {"transaction": "t2"}),                                   # begin again
        (200, [{"found": {"name": f"{ROOT}/a/1", "fields": {"n": {"integerValue": "5"}}}}]),
        (200, {"writeResults": [{}]}),                                  # commit
    )
    seen = []

    def body(tx):
        doc = tx.get("a/1")
        seen.append(doc.data["n"])
        tx.commit([idx.update_op("a/1", {"n": doc.data["n"] + 1})])
        return doc.data["n"] + 1

    assert idx.run_transaction(body, sleep=lambda _: None) == 6
    assert seen == [4, 5]                                               # the body ran again on fresh data
    assert verbs(s) == ["beginTransaction", "batchGet", "commit", "rollback", "beginTransaction", "batchGet", "commit"]
    assert s.calls[0][2] == {"options": {"readWrite": {}}}
    assert s.calls[4][2] == {"options": {"readWrite": {"retryTransaction": "t1"}}}
    assert s.calls[2][2]["transaction"] == "t1" and s.calls[6][2]["transaction"] == "t2"
    assert s.calls[1][2] == {"documents": [f"{ROOT}/a/1"], "transaction": "t1"}


def test_transaction_gives_up_after_its_attempts():
    aborted = (409, error_body("ABORTED", 409))
    idx, s = client((200, {"transaction": "t1"}), aborted, (200, {}), (200, {"transaction": "t2"}), aborted, (200, {}))
    with pytest.raises(fs.Aborted):
        idx.run_transaction(lambda tx: tx.commit([idx.delete_op("a/1")]), attempts=2, sleep=lambda _: None)
    assert verbs(s).count("beginTransaction") == 2


def test_a_failing_transaction_body_is_rolled_back_and_not_retried():
    idx, s = client((200, {"transaction": "t1"}), (200, {}))

    def boom(tx):
        raise RuntimeError("bug")

    with pytest.raises(RuntimeError):
        idx.run_transaction(boom)
    assert verbs(s) == ["beginTransaction", "rollback"]


def test_a_read_only_transaction_is_rolled_back():
    idx, s = client((200, {"transaction": "t1"}), (200, [{"missing": f"{ROOT}/a/1"}]), (200, {}))
    assert idx.run_transaction(lambda tx: tx.get("a/1")) is None
    assert verbs(s) == ["beginTransaction", "batchGet", "rollback"]


def test_get_many_asks_for_the_paths_in_batches_and_returns_the_found_ones(monkeypatch):
    found_a = {"found": {"name": f"{ROOT}/t/a", "fields": {"n": {"integerValue": "1"}}}}
    idx, s = client((200, [found_a, {"missing": f"{ROOT}/t/b"}]), (200, [{"missing": f"{ROOT}/t/c"}]))
    monkeypatch.setattr(fs, "GET_MANY_CHUNK", 2)
    found = idx.get_many(["t/a", "t/b", "t/a", "t/c"])                 # a repeated path is asked once
    assert {path: doc.data for path, doc in found.items()} == {"t/a": {"n": 1}}
    assert verbs(s) == ["batchGet", "batchGet"]
    assert [c[2]["documents"] for c in s.calls] == [[f"{ROOT}/t/a", f"{ROOT}/t/b"], [f"{ROOT}/t/c"]]


def test_run_query_builds_a_structured_query():
    idx, s = client((200, [{"readTime": "x"}]))
    assert idx.run_query("users/alice/tracks", filters=[("source.type", "==", "youtube"), ("size", ">=", 10)],
                         order_by=["-createdAt", "title"], limit=50) == []
    method, url, body = s.calls[0]
    assert (method, url) == ("POST", f"{URL}/users/alice:runQuery")
    q = body["structuredQuery"]
    assert q["from"] == [{"collectionId": "tracks"}]
    assert q["where"] == {"compositeFilter": {"op": "AND", "filters": [
        {"fieldFilter": {"field": {"fieldPath": "source.type"}, "op": "EQUAL", "value": {"stringValue": "youtube"}}},
        {"fieldFilter": {"field": {"fieldPath": "size"}, "op": "GREATER_THAN_OR_EQUAL",
                         "value": {"integerValue": "10"}}}]}}
    assert q["orderBy"] == [{"field": {"fieldPath": "createdAt"}, "direction": "DESCENDING"},
                            {"field": {"fieldPath": "title"}, "direction": "ASCENDING"},
                            {"field": {"fieldPath": "__name__"}, "direction": "ASCENDING"}]
    assert q["limit"] == 50 and "startAt" not in q


def test_top_level_and_group_queries():
    idx, s = client((200, []), (200, []))
    idx.run_query("adminJobs", filters=[("status", "in", ["running", "queued"])])
    idx.run_query("tracks", collection_group=True)
    assert s.calls[0][1] == f"{URL}:runQuery"
    assert s.calls[0][2]["structuredQuery"]["where"]["fieldFilter"]["value"] == {"arrayValue": {"values": [
        {"stringValue": "running"}, {"stringValue": "queued"}]}}
    assert s.calls[1][2]["structuredQuery"]["from"] == [{"collectionId": "tracks", "allDescendants": True}]


def test_run_query_cursor_continues_after_the_last_document_of_the_previous_page():
    row = {"document": {"name": f"{ROOT}/adminJobs/j2", "fields": {"at": {"integerValue": "7"}}}}
    idx, s = client((200, [row]), (200, []))
    (last,) = idx.run_query("adminJobs", order_by=["-at"], limit=1)
    assert last == fs.Document("adminJobs/j2", {"at": 7}) and last.id == "j2"
    idx.run_query("adminJobs", order_by=["-at"], limit=1, start_after=last)
    assert s.calls[1][2]["structuredQuery"]["startAt"] == {
        "values": [{"integerValue": "7"}, {"referenceValue": f"{ROOT}/adminJobs/j2"}], "before": False}


def test_aggregate_asks_for_count_and_sum_and_decodes_them():
    idx, s = client((200, [{"result": {"aggregateFields": {"n": {"integerValue": "3"}, "s": {"doubleValue": 6.5}}}}]))
    assert idx.aggregate("users/alice/tracks", {"n": "count", "s": ("sum", "size")},
                         filters=[("vocals", "==", True)]) == {"n": 3, "s": 6.5}
    method, url, body = s.calls[0]
    assert url == f"{URL}/users/alice:runAggregationQuery"
    agg = body["structuredAggregationQuery"]
    assert agg["aggregations"] == [{"alias": "n", "count": {}},
                                   {"alias": "s", "sum": {"field": {"fieldPath": "size"}}}]
    assert agg["structuredQuery"]["from"] == [{"collectionId": "tracks"}]
    assert "orderBy" not in agg["structuredQuery"]


def test_count_is_a_shortcut_for_one_count_aggregation():
    idx, _ = client((200, [{"result": {"aggregateFields": {"n": {"integerValue": "12"}}}}]))
    assert idx.count("adminJobs") == 12


def test_get_returns_a_document_or_none():
    idx, s = client((200, {"name": f"{ROOT}/a/1", "fields": {"x": {"stringValue": "y"}}}), (404, {}))
    assert idx.get("a/1") == fs.Document("a/1", {"x": "y"})
    assert idx.get("a/2") is None
    assert s.calls[0][:2] == ("GET", f"{URL}/a/1")


# ---------------------------------------------------------------- against the Firestore emulator

emulator = pytest.mark.skipif(not EMULATOR_HOST,
                              reason="needs the Firestore emulator (FIRESTORE_EMULATOR_HOST)")


@pytest.fixture
def db():
    return fs.FirestoreIndex("build-chords-listener", emulator_host=EMULATOR_HOST)


@pytest.fixture
def col():
    return f"t01_{uuid.uuid4().hex[:10]}"   # a fresh collection per test: nothing to clean up


@emulator
def test_two_doc_commit_with_a_failing_precondition_changes_nothing(db, col):
    db.commit([db.update_op(f"{col}/a", {"v": 1}, exists=False), db.update_op(f"{col}/b", {"v": 1}, exists=False)])
    assert db.get(f"{col}/a").data == {"v": 1} and db.get(f"{col}/b").data == {"v": 1}

    with pytest.raises(fs.PreconditionFailed):   # the second doc does not exist, so the whole batch is refused
        db.commit([db.update_op(f"{col}/a", {"v": 2}), db.update_op(f"{col}/missing", {"v": 2}, exists=True)])
    assert db.get(f"{col}/a").data == {"v": 1} and db.get(f"{col}/missing") is None

    with pytest.raises(fs.PreconditionFailed):   # exists=False on a live document
        db.commit([db.update_op(f"{col}/c", {"v": 9}, exists=False), db.update_op(f"{col}/a", {"v": 2}, exists=False)])
    assert db.get(f"{col}/c") is None and db.get(f"{col}/a").data == {"v": 1}


@emulator
def test_update_mask_leaves_other_fields_and_transforms_apply(db, col):
    db.commit([db.update_op(f"{col}/s", {"switches": {"youtube": True, "uploads": True}, "banner": {"text": "x"}})])
    db.commit([db.update_op(f"{col}/s", {"switches": {"youtube": False}}, exists=True, mask=["switches.youtube"],
                            transforms=[fs.increment("version"), fs.server_timestamp("updatedAt")])])
    db.commit([db.update_op(f"{col}/s", {}, transforms=[fs.increment("version", 4)])])   # only a transform
    data = db.get(f"{col}/s").data
    assert data["switches"] == {"youtube": False, "uploads": True} and data["banner"] == {"text": "x"}
    assert data["version"] == 5 and data["updatedAt"].endswith("Z")
    db.commit([db.delete_op(f"{col}/s", exists=True)])
    assert db.get(f"{col}/s") is None
    with pytest.raises(fs.PreconditionFailed):
        db.commit([db.delete_op(f"{col}/s", exists=True)])


@emulator
def test_transaction_reads_and_writes_atomically(db, col):
    db.commit([db.update_op(f"{col}/n", {"n": 1})])

    def bump(tx):
        n = tx.get(f"{col}/n").data["n"]
        tx.commit([db.update_op(f"{col}/n", {"n": n + 1}), db.update_op(f"{col}/log", {"from": n})])
        return n

    assert db.run_transaction(bump) == 1
    assert db.get(f"{col}/n").data == {"n": 2} and db.get(f"{col}/log").data == {"from": 1}


@emulator
def test_a_conflicting_transaction_is_retried_and_commits_once(db, col):
    db.commit([db.update_op(f"{col}/n", {"n": 0})])
    meet = threading.Barrier(2, timeout=10)
    runs, errors = [], []

    def worker(name):
        first = []

        def bump(tx):
            n = tx.get(f"{col}/n").data["n"]
            runs.append(name)
            if not first:
                first.append(1)
                try:
                    meet.wait()     # both transactions hold the read before either writes: a real conflict
                except threading.BrokenBarrierError:
                    pass
            tx.commit([db.update_op(f"{col}/n", {"n": n + 1})])

        try:
            db.run_transaction(bump, attempts=8)
        except Exception as exc:    # pragma: no cover - reported below
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert not errors
    assert db.get(f"{col}/n").data == {"n": 2}          # each increment landed exactly once
    assert len(runs) >= 3                               # and at least one body run was a retry


@emulator
def test_run_query_filters_orders_and_pages_with_a_cursor(db, col):
    rows = [("a", 5, "x"), ("b", 3, "x"), ("c", 5, "y"), ("d", 1, "x"), ("e", 4, "x"), ("f", 5, "x")]
    db.commit([db.update_op(f"{col}/{i}", {"rank": r, "kind": k}) for i, r, k in rows])

    def ids(docs):
        return [d.id for d in docs]

    assert ids(db.run_query(col, filters=[("kind", "==", "x")], order_by=["-rank"])) == ["f", "a", "e", "b", "d"]
    assert ids(db.run_query(col, filters=[("rank", ">", 3), ("kind", "==", "x")], order_by=["rank"])) == ["e", "a", "f"]
    assert ids(db.run_query(col, filters=[("kind", "in", ["y", "z"])])) == ["c"]

    paged, cursor = [], None
    while True:   # rank has ties (a, c, f all 5): the cursor must not skip or repeat any of them
        page = db.run_query(col, order_by=["-rank"], limit=2, start_after=cursor)
        paged += ids(page)
        if len(page) < 2:
            break
        cursor = page[-1]
    assert paged == ["f", "c", "a", "e", "b", "d"]      # ties break by document name, descending like the last order


@emulator
def test_aggregate_returns_count_and_sum(db, col):
    db.commit([db.update_op(f"{col}/{i}", {"size": s, "kind": k}) for i, s, k in
               [(1, 10, "x"), (2, 20, "x"), (3, 5, "y")]])
    assert db.aggregate(col, {"n": "count", "total": ("sum", "size")}) == {"n": 3, "total": 35}
    assert db.aggregate(col, {"n": "count", "total": ("sum", "size")}, filters=[("kind", "==", "x")]) == {
        "n": 2, "total": 30}
    assert db.count(col, filters=[("kind", "==", "none")]) == 0
    assert db.aggregate(col, {"total": ("sum", "size")}, filters=[("kind", "==", "none")]) == {"total": 0}

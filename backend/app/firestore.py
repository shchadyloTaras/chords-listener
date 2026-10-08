"""Firestore index for the library (docs/superpowers/specs/2026-10-05-library-firestore-storage-design.md).

``FirestoreIndex`` upserts / deletes one document per track, ``users/{uid}/tracks/{trackId}``, over the
Firestore REST API with the service account's credentials (``google.auth`` + ``requests``: no gRPC client).
``FIRESTORE_EMULATOR_HOST`` (e.g. ``127.0.0.1:8080``) points it at the Firestore emulator, which takes
``Authorization: Bearer owner`` as an admin. Failures raise ``IndexError_`` saying whether a retry may help.

The admin feature (docs/features/admin, ADR-0007) adds the building blocks of "no audit record, no action":
batched writes with preconditions, field masks and transforms (``update_op`` / ``delete_op`` / ``commit``),
read-write transactions that retry on contention (``run_transaction``), structured queries with a cursor
(``run_query``) and ``count`` / ``sum`` aggregations (``aggregate``). Paths are relative to the database's
documents root, e.g. ``"adminConfig/settings"`` or ``"users/alice/tracks"``.
"""
from __future__ import annotations

import logging
import os
import random
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Optional, Union
from urllib.parse import quote

import requests
from google.auth import exceptions as gexc

log = logging.getLogger("chords.firestore")

BASE_URL = "https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents"
SCOPES = ["https://www.googleapis.com/auth/datastore"]
TIMEOUT_S = 10.0
GET_MANY_CHUNK = 300  # documents per batchGet request


class IndexError_(Exception):
    """A Firestore call failed. ``retryable``: 429 / 5xx / network (worth trying again), else False."""

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


class Aborted(IndexError_):
    """A transaction lost a race with another writer (Firestore ABORTED): run it again from the reads."""

    def __init__(self, message: str) -> None:
        super().__init__(message, retryable=True)


class PreconditionFailed(IndexError_):
    """A write's precondition did not hold (``exists`` wrong, or the document is not as expected). The whole
    commit was refused and nothing changed; retrying the same writes cannot help."""

    def __init__(self, message: str) -> None:
        super().__init__(message, retryable=False)


@dataclass(frozen=True)
class Document:
    """A document read back: its path under the documents root and its decoded fields."""

    path: str
    data: dict[str, Any]

    @property
    def id(self) -> str:
        return self.path.rsplit("/", 1)[-1]


# --------------------------------------------------------------------------- typed values


def to_value(v: Any) -> dict[str, Any]:
    """A Python value as a Firestore REST typed value."""
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):  # before int: bool is an int
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, datetime):
        if v.tzinfo is None:
            raise ValueError("naive datetime: give it a timezone")
        return {"timestampValue": v.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [to_value(x) for x in v]}}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {str(k): to_value(x) for k, x in v.items()}}}
    raise TypeError(f"can't store a {type(v).__name__} in Firestore")


def from_value(d: dict[str, Any]) -> Any:
    """A Firestore REST typed value as a Python value (a timestamp stays its ISO string)."""
    if "nullValue" in d:
        return None
    if "booleanValue" in d:
        return bool(d["booleanValue"])
    if "integerValue" in d:
        return int(d["integerValue"])
    if "doubleValue" in d:
        return float(d["doubleValue"])
    if "stringValue" in d:
        return d["stringValue"]
    if "timestampValue" in d:
        return d["timestampValue"]
    if "arrayValue" in d:
        return [from_value(x) for x in d["arrayValue"].get("values", [])]
    if "mapValue" in d:
        return {k: from_value(x) for k, x in d["mapValue"].get("fields", {}).items()}
    raise ValueError(f"unsupported Firestore value: {sorted(d)}")


# --------------------------------------------------------------------------- write helpers

_SIMPLE_SEGMENT = re.compile(r"^[A-Za-z_][A-Za-z_0-9]*$")


def field_path(*segments: str) -> str:
    """A dotted field path; a segment that is not a plain identifier (a key from data, say) is backtick-quoted."""
    return ".".join(
        seg if _SIMPLE_SEGMENT.match(seg) else "`" + seg.replace("\\", "\\\\").replace("`", "\\`") + "`"
        for seg in segments
    )


def increment(field: str, by: Union[int, float] = 1) -> dict[str, Any]:
    """A field transform: add ``by`` to the number stored at ``field`` on the server (a missing field starts at 0)."""
    return {"fieldPath": field, "increment": to_value(by)}


def server_timestamp(field: str) -> dict[str, Any]:
    """A field transform: set ``field`` to the server's commit time."""
    return {"fieldPath": field, "setToServerValue": "REQUEST_TIME"}


# --------------------------------------------------------------------------- queries

_FILTER_OPS = {
    "==": "EQUAL", "!=": "NOT_EQUAL", "<": "LESS_THAN", "<=": "LESS_THAN_OR_EQUAL", ">": "GREATER_THAN",
    ">=": "GREATER_THAN_OR_EQUAL", "in": "IN", "not-in": "NOT_IN", "array-contains": "ARRAY_CONTAINS",
    "array-contains-any": "ARRAY_CONTAINS_ANY",
}

Filter = tuple[str, str, Any]
Aggregation = Union[str, tuple[str, str]]  # "count" or ("sum", "<field>")


def _dig(data: dict[str, Any], path: str) -> Any:
    for part in path.split("."):
        data = data[part]
    return data


# --------------------------------------------------------------------------- the client


def _error_status(res: Any) -> Optional[str]:
    """Firestore's canonical status name from an error body (``ABORTED``, ``ALREADY_EXISTS``, ...), if any."""
    try:
        body = res.json()
        status = body.get("error", {}).get("status") if isinstance(body, dict) else None
    except Exception:  # noqa: BLE001 - an unparseable error body just means "unknown"
        return None
    return status if isinstance(status, str) else None


def default_session() -> Any:
    from google.auth import default
    from google.auth.transport.requests import AuthorizedSession

    credentials, _ = default(scopes=SCOPES)
    return AuthorizedSession(credentials)


class FirestoreIndex:
    def __init__(
        self,
        project: str,
        *,
        session_factory: Optional[Callable[[], Any]] = None,
        emulator_host: Optional[str] = None,
    ) -> None:
        host = emulator_host or os.environ.get("FIRESTORE_EMULATOR_HOST")
        if host:
            self._base = f"http://{host}/v1/projects/{project}/databases/(default)/documents"
            self._headers: Optional[dict[str, str]] = {"Authorization": "Bearer owner"}
            self._factory = session_factory or requests.Session
        else:
            self._base = BASE_URL.format(project=project)
            self._headers = None  # the AuthorizedSession adds the service account's token
            self._factory = session_factory or default_session
        self._root = f"projects/{project}/databases/(default)/documents"
        self._session_obj: Any = None
        self._lock = threading.Lock()

    def _session(self) -> Any:
        with self._lock:
            if self._session_obj is None:
                self._session_obj = self._factory()
            return self._session_obj

    def _call(self, method: str, url: str, *, body: Optional[dict] = None, also_ok: tuple[int, ...] = ()) -> Any:
        """One HTTP call; returns the response, or raises ``IndexError_`` (``Aborted`` / ``PreconditionFailed``
        when Firestore says so) for any status outside 2xx and ``also_ok``."""
        try:
            res = self._session().request(method, url, json=body, headers=self._headers, timeout=TIMEOUT_S)
        except requests.RequestException as exc:
            raise IndexError_(f"Firestore {method} failed: {exc}", retryable=True) from exc
        except gexc.GoogleAuthError as exc:
            raise IndexError_(
                f"Firestore {method} failed: {exc}", retryable=isinstance(exc, gexc.TransportError) or exc.retryable
            ) from exc
        status = res.status_code
        if 200 <= status < 300 or status in also_ok:
            return res
        detail = (res.text or "")[:200]
        message = f"Firestore {method} answered {status}" + (f": {detail}" if detail else "")
        code = _error_status(res)
        if code == "ABORTED" or (status == 409 and code is None):
            raise Aborted(message)
        if code in ("FAILED_PRECONDITION", "ALREADY_EXISTS") or (code == "NOT_FOUND" and method == "POST"):
            raise PreconditionFailed(message)
        raise IndexError_(message, retryable=status == 429 or status >= 500)

    def _send(
        self, method: str, uid: str, track_id: str, *, body: Optional[dict] = None, also_ok: tuple[int, ...] = ()
    ) -> int:
        url = f"{self._base}/users/{quote(uid, safe='')}/tracks/{quote(track_id, safe='')}"
        return self._call(method, url, body=body, also_ok=also_ok).status_code

    def upsert(self, uid: str, track_id: str, data: dict[str, Any]) -> None:
        """Create or fully replace the track's document with ``data`` (no update mask: absent fields go)."""
        self._send("PATCH", uid, track_id, body={"fields": {k: to_value(v) for k, v in data.items()}})

    def delete(self, uid: str, track_id: str) -> None:
        """Remove the document; one that is already gone counts as done."""
        self._send("DELETE", uid, track_id, also_ok=(404,))

    def exists(self, uid: str, track_id: str) -> bool:
        return self._send("GET", uid, track_id, also_ok=(404,)) != 404

    # ----------------------------------------------------------------------- documents, batched writes

    def _name(self, path: str) -> str:
        return f"{self._root}/{path}"

    def _post(self, path: str, body: dict) -> Any:
        """POST ``body`` to ``<documents root><path>`` (``":commit"``, ``"/users/alice:runQuery"`` ...), return JSON."""
        res = self._call("POST", f"{self._base}{path}", body=body)
        try:
            return res.json()
        except ValueError as exc:
            raise IndexError_(f"Firestore answered with a body that is not JSON: {exc}", retryable=True) from exc

    def _doc(self, raw: dict[str, Any]) -> Document:
        return Document(raw["name"].split("/documents/", 1)[1],
                        {k: from_value(v) for k, v in raw.get("fields", {}).items()})

    def get(self, path: str) -> Optional[Document]:
        """The document at ``path``, or None when there is none."""
        res = self._call("GET", f"{self._base}/{quote(path, safe='/')}", also_ok=(404,))
        return None if res.status_code == 404 else self._doc(res.json())

    def get_many(self, paths: Iterable[str]) -> dict[str, Document]:
        """The documents at ``paths`` that exist, by path: one ``batchGet`` round trip per ``GET_MANY_CHUNK`` paths
        (Firestore bills one read per path asked, found or not)."""
        wanted = list(dict.fromkeys(paths))
        found: dict[str, Document] = {}
        for i in range(0, len(wanted), GET_MANY_CHUNK):
            rows = self._post(":batchGet", {"documents": [self._name(p) for p in wanted[i:i + GET_MANY_CHUNK]]})
            for row in rows:
                if "found" in row:
                    doc = self._doc(row["found"])
                    found[doc.path] = doc
        return found

    def update_op(
        self,
        path: str,
        data: dict[str, Any],
        *,
        exists: Optional[bool] = None,
        mask: Optional[Iterable[str]] = None,
        transforms: Iterable[dict[str, Any]] = (),
    ) -> dict[str, Any]:
        """A write for ``commit``: set ``data`` at ``path``.

        With no ``mask`` the document is replaced by ``data`` (plus the transforms); with ``mask`` (dotted field
        paths) only those fields are written, so other fields, and a sibling writer's fields, survive. A masked
        path that ``data`` leaves out is deleted. ``exists`` is the precondition: True = the document must be
        there, False = it must not be; None = no check. ``transforms`` are ``increment`` / ``server_timestamp``.
        A write that only carries transforms keeps every other field.
        """
        fields = {k: to_value(v) for k, v in data.items()}
        write: dict[str, Any] = {"update": {"name": self._name(path), "fields": fields}}
        transforms = list(transforms)
        if mask is not None:
            write["updateMask"] = {"fieldPaths": list(mask)}
        elif transforms and not data:
            write["updateMask"] = {"fieldPaths": []}
        if exists is not None:
            write["currentDocument"] = {"exists": exists}
        if transforms:
            write["updateTransforms"] = transforms
        return write

    def delete_op(self, path: str, *, exists: Optional[bool] = None) -> dict[str, Any]:
        """A write for ``commit``: delete the document at ``path`` (``exists=True``: refuse if it is not there)."""
        write: dict[str, Any] = {"delete": self._name(path)}
        if exists is not None:
            write["currentDocument"] = {"exists": exists}
        return write

    def commit(self, writes: list[dict[str, Any]], *, transaction: Optional[str] = None) -> None:
        """Apply every write atomically: all of them land or none. A broken precondition raises
        ``PreconditionFailed``; contention inside a transaction raises ``Aborted``."""
        body: dict[str, Any] = {"writes": writes}
        if transaction is not None:
            body["transaction"] = transaction
        self._post(":commit", body)

    # ----------------------------------------------------------------------- transactions

    def run_transaction(
        self,
        fn: Callable[["Transaction"], Any],
        *,
        attempts: int = 5,
        sleep: Callable[[float], None] = time.sleep,
    ) -> Any:
        """Call ``fn(tx)`` in a transaction and return what it returns. ``fn`` reads with ``tx.get`` /
        ``tx.run_query`` and writes by calling ``tx.commit(writes)`` once. If Firestore aborts the transaction
        (another writer got there first) ``fn`` runs again on fresh data, up to ``attempts`` times in all, then
        ``Aborted`` is raised. ``fn`` may therefore run several times: keep side effects out of it. Any other
        error from ``fn`` rolls the transaction back and propagates. A transaction that never commits is rolled back.
        """
        previous: Optional[str] = None
        for attempt in range(1, attempts + 1):
            tx = Transaction(self, previous)
            try:
                with tx:
                    return fn(tx)
            except Aborted:
                if attempt == attempts:
                    raise
                previous = tx.id
                sleep(random.uniform(0, 0.05 * 2 ** attempt))
        raise AssertionError("unreachable")  # pragma: no cover

    # ----------------------------------------------------------------------- queries

    def _structured_query(
        self,
        collection: str,
        filters: Optional[Iterable[Filter]],
        order_by: Optional[Iterable[str]],
        limit: Optional[int],
        start_after: Union[Document, list[Any], None],
        collection_group: bool,
    ) -> tuple[str, dict[str, Any]]:
        """(the parent path to POST ``:runQuery`` under, the structuredQuery) for a collection or group."""
        parent, _, coll = collection.rpartition("/")
        if collection_group:
            parent, source = "", {"collectionId": coll, "allDescendants": True}
        else:
            source = {"collectionId": coll}
        query: dict[str, Any] = {"from": [source]}
        conditions = [
            {"fieldFilter": {"field": {"fieldPath": f}, "op": _FILTER_OPS[op], "value": to_value(v)}}
            for f, op, v in (filters or ())
        ]
        if len(conditions) == 1:
            query["where"] = conditions[0]
        elif conditions:
            query["where"] = {"compositeFilter": {"op": "AND", "filters": conditions}}
        order = [(o[1:], "DESCENDING") if o.startswith("-") else (o, "ASCENDING") for o in (order_by or ())]
        if order:
            # Every order ends on the document name (as Firestore does implicitly), so a cursor can break ties.
            order.append(("__name__", order[-1][1]))
            query["orderBy"] = [{"field": {"fieldPath": f}, "direction": d} for f, d in order]
        if limit is not None:
            query["limit"] = limit
        if start_after is not None:
            if isinstance(start_after, Document):
                if not order:
                    raise ValueError("start_after needs order_by")
                values = [to_value(_dig(start_after.data, f)) for f, _ in order[:-1]]
                values.append({"referenceValue": self._name(start_after.path)})
            else:
                values = [to_value(v) for v in start_after]
            query["startAt"] = {"values": values, "before": False}
        return (f"/{parent}" if parent else ""), query

    def run_query(
        self,
        collection: str,
        *,
        filters: Optional[Iterable[Filter]] = None,
        order_by: Optional[Iterable[str]] = None,
        limit: Optional[int] = None,
        start_after: Union[Document, list[Any], None] = None,
        collection_group: bool = False,
        transaction: Optional[str] = None,
    ) -> list[Document]:
        """Documents of ``collection`` (``"adminJobs"``, ``"users/alice/tracks"``; with ``collection_group`` every
        collection of that last name) matching all ``filters`` (``(field, op, value)`` with ops ``== != < <= > >=
        in not-in array-contains array-contains-any``), in ``order_by`` order (``"field"`` ascending, ``"-field"``
        descending; ties break by document name). ``start_after``: the last ``Document`` of the previous page.
        """
        parent, query = self._structured_query(collection, filters, order_by, limit, start_after, collection_group)
        body: dict[str, Any] = {"structuredQuery": query}
        if transaction is not None:
            body["transaction"] = transaction
        rows = self._post(f"{parent}:runQuery", body)
        return [self._doc(row["document"]) for row in rows if "document" in row]

    def aggregate(
        self,
        collection: str,
        aggregations: dict[str, Aggregation],
        *,
        filters: Optional[Iterable[Filter]] = None,
        collection_group: bool = False,
    ) -> dict[str, Any]:
        """Server-side aggregates over the matching documents: ``{"n": "count", "total": ("sum", "size")}`` ->
        ``{"n": 3, "total": 35}`` (a sum over nothing is 0)."""
        specs: list[dict[str, Any]] = []
        for alias, how in aggregations.items():
            if how == "count":
                specs.append({"alias": alias, "count": {}})
            elif isinstance(how, tuple) and len(how) == 2 and how[0] == "sum":
                specs.append({"alias": alias, "sum": {"field": {"fieldPath": how[1]}}})
            else:
                raise ValueError(f"unsupported aggregation {how!r}: use 'count' or ('sum', field)")
        parent, query = self._structured_query(collection, filters, None, None, None, collection_group)
        body = {"structuredAggregationQuery": {"structuredQuery": query, "aggregations": specs}}
        for row in self._post(f"{parent}:runAggregationQuery", body):
            if "result" in row:
                fields = row["result"].get("aggregateFields", {})
                return {alias: from_value(fields[alias]) if alias in fields else None for alias in aggregations}
        raise IndexError_("Firestore answered an aggregation with no result", retryable=True)

    def count(
        self, collection: str, *, filters: Optional[Iterable[Filter]] = None, collection_group: bool = False
    ) -> int:
        """How many documents of ``collection`` match ``filters``."""
        return self.aggregate(collection, {"n": "count"}, filters=filters, collection_group=collection_group)["n"]


class Transaction:
    """One read-write transaction (see ``FirestoreIndex.run_transaction``). Reads go through it, so Firestore
    can tell whether another writer touched what was read before ``commit``. Leaving the ``with`` block
    without a successful commit rolls it back."""

    def __init__(self, db: FirestoreIndex, retry_of: Optional[str] = None) -> None:
        self._db = db
        self._retry_of = retry_of
        self.id: Optional[str] = None
        self._done = False

    def __enter__(self) -> "Transaction":
        options: dict[str, Any] = {"readWrite": {"retryTransaction": self._retry_of} if self._retry_of else {}}
        self.id = self._db._post(":beginTransaction", {"options": options})["transaction"]
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if not self._done:
            self.rollback()

    def get(self, path: str) -> Optional[Document]:
        """The document at ``path`` as of this transaction, or None."""
        rows = self._db._post(":batchGet", {"documents": [self._db._name(path)], "transaction": self.id})
        for row in rows:
            if "found" in row:
                return self._db._doc(row["found"])
        return None

    def run_query(self, collection: str, **kwargs: Any) -> list[Document]:
        """``FirestoreIndex.run_query`` inside this transaction."""
        return self._db.run_query(collection, transaction=self.id, **kwargs)

    def commit(self, writes: list[dict[str, Any]]) -> None:
        """Apply ``writes`` atomically, provided nothing this transaction read has changed (else ``Aborted``)."""
        self._db.commit(writes, transaction=self.id)
        self._done = True

    def rollback(self) -> None:
        """Give the transaction up. Best effort: Firestore expires an abandoned transaction by itself."""
        self._done = True
        try:
            self._db._post(":rollback", {"transaction": self.id})
        except IndexError_ as exc:
            log.warning("Firestore rollback failed: %s", exc)

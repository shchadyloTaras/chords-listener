"""Shared fixtures for the admin tests (docs/features/admin/data-model.md §Test fixtures, SAD §10).

* Factories (``make_admin``, ``make_user``, ``make_tracks``, ``make_account_state``, ``make_job``,
  ``make_stats_day``, ``make_audit``) return ``Seed`` values: a document path plus its fields. They touch no
  network, so offline tests can assert on them; ``seed(db, seeds)`` writes them to an emulator in batches.
* ``seed_synthetic_users(db, n)`` fills ``users/*`` and ``adminEmailIndex/s000…`` (NFR: search p95 at 10 000 users).
* ``HOSTILE_STRINGS`` / ``HOSTILE_EMAILS`` plant markup, script URLs, bidi controls and very long text (AC-05).
* ``MemDb`` is the one in-memory ``FirestoreIndex`` every offline test runs on (see its docstring).
* ``ReadCounter`` counts the document reads a block of code costs, the way Firestore bills them (NFR: ≤ 200 reads
  per screen). The ``read_counter`` pytest fixture in ``conftest.py`` installs it on every ``FirestoreIndex``.

PII guard: every address is on ``example.test``; no real names or emails appear anywhere.
"""
from __future__ import annotations

import copy
import json
import re
import secrets
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from functools import cmp_to_key
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

from app.firestore import Document, FirestoreIndex, PreconditionFailed, from_value, to_value

EMAIL_DOMAIN = "example.test"
ADMIN_EMAIL = f"admin@{EMAIL_DOMAIN}"
EPOCH = datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc)  # the default "now" of every factory: deterministic
BATCH = 400  # a Firestore commit takes at most 500 writes

HOSTILE_STRINGS: list[str] = [
    "<script>alert(1)</script>",
    '"><img src=x onerror=alert(1)>',
    "javascript:alert(1)",
    "‮txet desrever",  # right-to-left override
    "x+<b>@example.test",
    "<b>bold</b> & &amp; &lt;i&gt;",
    "A" * 300,
    "<img src=x onerror=alert(1)>" * 12,  # 324 chars of markup
]
HOSTILE_EMAILS: list[str] = ["x+<b>@example.test", "x+<img src=x onerror=alert(1)>@example.test"]

DEFAULT_SETTINGS: dict[str, Any] = {  # exactly the 11 keys firestore.rules allows on users/{uid}
    "simplify": False, "accidentals": "auto", "instrument": "guitar", "view": "sheet", "barsPerLine": 4,
    "follow": True, "showDiagrams": True, "copyFormat": "bars", "theme": "dark", "lang": "uk", "showVideo": False,
}
_SOURCE_TYPE = {"link": "youtube", "file": "file", "mic": "file", "tab": "file"}  # job origin -> tracks.source.type


@dataclass(frozen=True)
class Seed:
    """One document to write: its path under the documents root and its fields."""

    path: str
    data: dict[str, Any] = field(default_factory=dict)


def _iso(when: datetime) -> str:
    return when.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _auto_id() -> str:
    return secrets.token_hex(10)


# --------------------------------------------------------------------------- factories


def make_admin(uid: str = "admin-1") -> Seed:
    """``adminAllowlist/{uid}``; the admin's token email in tests is ``ADMIN_EMAIL``."""
    return Seed(f"adminAllowlist/{uid}", {"grantedAt": EPOCH, "note": "test admin"})


def make_user(uid: Optional[str] = None, email: Optional[str] = None, created_at: Optional[datetime] = None) -> Seed:
    """``users/{uid}`` with ``user-<uid>@example.test`` and the default settings."""
    uid = uid or f"user-{secrets.token_hex(4)}"
    created = created_at or EPOCH
    return Seed(f"users/{uid}", {
        "email": email or f"user-{uid}@{EMAIL_DOMAIN}",
        "createdAt": created,
        "updatedAt": created,
        "settings": dict(DEFAULT_SETTINGS),
    })


def make_tracks(
    uid: str,
    n: int,
    *,
    start: Optional[datetime] = None,
    origin: str = "file",
    size: int = 1_000_000,
    titles: Optional[list[str]] = None,
) -> list[Seed]:
    """``users/{uid}/tracks/*``: ``n`` summary documents, one minute apart from ``start``, ids ``000000000000``…
    ``titles`` (cycled) plants chosen text, e.g. ``HOSTILE_STRINGS``."""
    start = start or EPOCH
    out = []
    for i in range(n):
        track_id = f"{i:012x}"
        source: dict[str, Any] = {"type": _SOURCE_TYPE[origin]}
        if origin == "link":
            source.update(url=f"https://example.test/watch?v={track_id}", videoId=track_id[:11])
        else:
            source["filename"] = f"song-{i}.wav"
        out.append(Seed(f"users/{uid}/tracks/{track_id}", {
            "id": track_id,
            "title": titles[i % len(titles)] if titles else f"Song {i}",
            "artist": None,
            "duration": 180.0,
            "source": source,
            "edited": False,
            "vocals": False,
            "stems": [],
            "createdAt": _iso(start + timedelta(minutes=i)),
            "version": 1,
            "publishedAt": start + timedelta(minutes=i),
            "sizeBytes": size,
        }))
    return out


def make_account_state(
    uid: str,
    restriction: Optional[dict[str, Any]] = None,
    deletion: Optional[dict[str, Any]] = None,
    personal_limit: Optional[dict[str, Any]] = None,
) -> Seed:
    """``adminAccounts/{uid}``: the sparse admin state of one account."""
    return Seed(f"adminAccounts/{uid}", {
        "restriction": restriction, "deletion": deletion, "personalLimit": personal_limit, "updatedAt": EPOCH,
    })


def make_job(
    uid: str,
    status: str = "error",
    reason: Optional[str] = "youtube_blocked",
    origin: str = "link",
    accepted_at: Optional[datetime] = None,
    *,
    job_id: Optional[str] = None,
    **extra: Any,
) -> Seed:
    """``adminJobs/{id}``. ``reason`` and ``errorText`` are set only for ``status == "error"``; ``day`` and
    ``expireAt`` (+ 90 d) derive from ``accepted_at``. ``extra`` overrides any field (``title``, ``kind``…)."""
    accepted = accepted_at or EPOCH
    job_id = job_id or secrets.token_hex(8)
    failed = status == "error"
    data: dict[str, Any] = {
        "uid": uid, "service": False, "kind": "analysis", "origin": origin, "status": status,
        "reason": reason if failed else None,
        "errorText": "Download failed" if failed else None,
        "title": "Test song", "trackId": None,
        "acceptedAt": accepted,
        "finishedAt": None if status == "running" else accepted + timedelta(seconds=30),
        "day": accepted.astimezone(timezone.utc).strftime("%Y-%m-%d"),
        "expireAt": accepted + timedelta(days=90),
        "anonymizedAt": None,
    }
    data.update(extra)
    return Seed(f"adminJobs/{job_id}", data)


def make_stats_day(day: str, state: str = "live", **counters: Any) -> Seed:
    """``adminStats/{day}`` (``YYYY-MM-DD``) with zeroed counters; ``counters`` overrides any field."""
    data: dict[str, Any] = {
        "state": state,
        "analyses": {"link": 0, "file": 0, "mic": 0, "tab": 0},
        "vocals": 0, "failed": 0, "failedByReason": {}, "active": 0,
        "newUsers": None, "restoredTracks": None, "reconciledDiff": None,
        "frozenAt": EPOCH if state == "frozen" else None,
        "updatedAt": EPOCH,
    }
    data.update(counters)
    return Seed(f"adminStats/{day}", data)


def make_audit(
    action: str,
    outcome: str = "applied",
    admin_uid: str = "admin-1",
    target_uid: Optional[str] = None,
    *,
    at: Optional[datetime] = None,
    query: Optional[str] = None,
    matched_uids: Optional[list[str]] = None,
    **extra: Any,
) -> Seed:
    """``adminAudit/{autoId}``; ``expireAt`` is ``at`` + 400 d. ``extra`` overrides any field (``before``, ``after``…)."""
    when = at or EPOCH
    data: dict[str, Any] = {
        "at": when, "adminUid": admin_uid, "adminEmail": ADMIN_EMAIL, "action": action, "outcome": outcome,
        "targetUid": target_uid, "setting": None, "before": None, "after": None, "rejectReason": None,
        "query": query, "matchedUids": matched_uids, "refId": None,
        "expireAt": when + timedelta(days=400), "redactedAt": None,
    }
    data.update(extra)
    return Seed(f"adminAudit/{_auto_id()}", data)


# --------------------------------------------------------------------------- the emulator seeder


def seed(db: FirestoreIndex, seeds: Iterable[Seed], *, batch: int = BATCH) -> int:
    """Write every ``Seed`` (full replace) in commits of ``batch`` writes. Returns how many were written."""
    pending: list[dict[str, Any]] = []
    total = 0
    for s in seeds:
        pending.append(db.update_op(s.path, s.data))
        if len(pending) >= batch:
            db.commit(pending)
            total += len(pending)
            pending = []
    if pending:
        db.commit(pending)
        total += len(pending)
    return total


def synthetic_users(n: int, *, prefix: str = "synthetic") -> list[Seed]:
    """``n`` deterministic users ``<prefix>-000000``…, one second apart, emails ``<uid>@example.test``."""
    return [
        make_user(f"{prefix}-{i:06d}", email=f"{prefix}-{i:06d}@{EMAIL_DOMAIN}", created_at=EPOCH + timedelta(seconds=i))
        for i in range(n)
    ]


def seed_synthetic_users(db: FirestoreIndex, n: int = 10_000, *, prefix: str = "synthetic", shard_size: int = 20_000) -> list[str]:
    """Write ``users/*`` and the matching ``adminEmailIndex/s000…`` shards; returns the uids."""
    users = synthetic_users(n, prefix=prefix)
    seed(db, users)
    shards = []
    for k in range(0, max(n, 1), shard_size):
        chunk = users[k:k + shard_size]
        shards.append(Seed(f"adminEmailIndex/s{k // shard_size:03d}", {
            "entries": {s.path.split("/", 1)[1]: s.data["email"].lower() for s in chunk},
            "count": len(chunk),
            "syncedThrough": max((s.data["createdAt"] for s in chunk), default=EPOCH),
            "fullSyncAt": EPOCH,
        }))
    seed(db, shards, batch=1)  # a shard can be ~1 MiB: one per commit
    return [s.path.split("/", 1)[1] for s in users]


# --------------------------------------------------------------------------- the read counter


def count_reads(method: str, url: str, response: Any) -> int:
    """Document reads Firestore bills for one REST call: a ``get`` is 1 (a miss too), ``batchGet`` one per requested
    document, ``runQuery`` one per document returned (an empty result is billed 1), an aggregation 1 (data-model
    §Read budget counts it so). Writes, ``beginTransaction`` and ``rollback`` read nothing."""
    last = url.rsplit("/", 1)[-1]
    verb = last.split(":", 1)[1] if ":" in last else ""
    try:
        body = response.json()
    except Exception:  # noqa: BLE001 - an unreadable body is counted by its verb alone
        body = None
    if verb == "batchGet":
        return len(body) if isinstance(body, list) else 1
    if verb == "runQuery":
        return max(1, sum(1 for row in body if "document" in row)) if isinstance(body, list) else 1
    if verb == "runAggregationQuery":
        return 1
    if verb:  # :commit, :beginTransaction, :rollback
        return 0
    if method == "GET":
        docs = body.get("documents") if isinstance(body, dict) else None
        return max(1, len(docs)) if isinstance(docs, list) else 1
    return 0


class Measure:
    """Reads made since ``ReadCounter.measure()`` was entered (frozen when the block exits)."""

    def __init__(self, counter: "ReadCounter") -> None:
        self._counter = counter
        self._start = counter.reads
        self._end: Optional[int] = None

    @property
    def reads(self) -> int:
        return (self._counter.reads if self._end is None else self._end) - self._start

    def close(self) -> None:
        self._end = self._counter.reads


class ReadCounter:
    def __init__(self) -> None:
        self.reads = 0
        self._lock = threading.Lock()

    def record(self, method: str, url: str, response: Any) -> None:
        n = count_reads(method, url, response)
        with self._lock:
            self.reads += n

    def reset(self) -> None:
        with self._lock:
            self.reads = 0

    @contextmanager
    def measure(self) -> Iterator[Measure]:
        m = Measure(self)
        try:
            yield m
        finally:
            m.close()

    def install(self, monkeypatch: Any) -> None:
        """Count the reads of every ``FirestoreIndex`` (the app's, the tests', any thread) until the test ends."""
        original = FirestoreIndex._call
        counter = self

        def counted(client: FirestoreIndex, method: str, url: str, **kwargs: Any) -> Any:
            response = original(client, method, url, **kwargs)
            counter.record(method, url, response)
            return response

        monkeypatch.setattr(FirestoreIndex, "_call", counted)


# --------------------------------------------------------------------------- the in-memory Firestore

_TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")
_MISSING = object()
REQUEST_TIME = "2026-10-08T12:00:00Z"  # what a ``REQUEST_TIME`` transform stores in ``MemDb`` (override: ``db.request_time``)


def split_path(path: str) -> list[str]:
    """``failedByReason.`a.b```  ->  ["failedByReason", "a.b"] (the inverse of app.firestore.field_path)."""
    return [re.sub(r"\\(.)", r"\1", m.group(1)) if m.group(1) is not None else m.group(2)
            for m in re.finditer(r"`((?:\\.|[^`\\])*)`|([^.`]+)", path)]


def _key(value: Any) -> Any:
    """A comparable value: timestamps (datetime or ISO string) as datetimes, anything else as it is."""
    if isinstance(value, str) and _TS.match(value):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value


def _dig(data: Any, path: str) -> Any:
    """The value at a dotted field path (``deletion.purgeAfter``), or None."""
    for part in path.split("."):
        if not isinstance(data, dict) or part not in data:
            return None
        data = data[part]
    return data


def decode(value: Any) -> Any:
    """A Python value the way ``FirestoreIndex`` hands it back: a timestamp is its ISO string."""
    return from_value(to_value(value))


_FILTERS = {"==": lambda a, b: a == b, "<": lambda a, b: a < b, ">": lambda a, b: a > b,
            ">=": lambda a, b: a >= b, "<=": lambda a, b: a <= b}

INDEXES_FILE = Path(__file__).resolve().parents[3] / "firestore.indexes.json"
_RANGE_OPS = frozenset({"<", "<=", ">", ">=", "!=", "not-in"})

Tail = tuple[tuple[str, bool], ...]  # the sort a query needs: (field, descending), ...


class IndexGuard:
    """Whether Firestore can serve a query with the indexes it has: the composite ones in ``firestore.indexes.json``
    and the single-field ones it keeps for every field the file does not exempt (``"indexes": []``).

    * Equality filters alone: merged single-field indexes.
    * One field that is ranged and / or ordered, with no equality filter: its single-field index.
    * Otherwise the sort (the orders, or the ranged field ascending when there are none: an aggregation too) must
      close composite indexes whose leading fields together are exactly the equality fields (one index, or several
      merged on that sort), each in exactly the query's direction. Firestore never reads a composite index backwards:
      with (uid ASC, acceptedAt DESC) deployed, ``uid == x`` ordered by acceptedAt ASC is FAILED_PRECONDITION
      (production probe, 2026-10-08).
    A range must be on the first ordered field, and on one field only."""

    def __init__(self, path: Optional[Path] = None, *, aliases: Optional[dict[str, str]] = None) -> None:
        self.aliases = dict(aliases or {})  # a collection a test renamed -> the collection group it stands for
        spec = json.loads((path or INDEXES_FILE).read_text(encoding="utf-8"))
        self.composites: dict[str, list[Tail]] = {}
        for index in spec["indexes"]:
            fields = tuple((f["fieldPath"], f["order"] == "DESCENDING") for f in index["fields"])
            self.composites.setdefault(index["collectionGroup"], []).append(fields)
        self.exempt = {(o["collectionGroup"], o["fieldPath"]) for o in spec.get("fieldOverrides", []) if o.get("indexes") == []}

    def check(self, collection: str, filters: Any, order_by: Any) -> None:
        group = collection.rsplit("/", 1)[-1]
        group = self.aliases.get(group, group)
        equal = {f for f, op, _ in filters or [] if op not in _RANGE_OPS}
        ranged = {f for f, op, _ in filters or [] if op in _RANGE_OPS}
        order: Tail = tuple((o.lstrip("-"), o.startswith("-")) for o in order_by or [])

        def refuse(why: str) -> None:
            raise AssertionError(f"{collection}: filters {filters or []}, order {list(order_by or [])}: {why} "
                                 "(no index in firestore.indexes.json serves it)")

        if len(ranged) > 1:
            refuse("ranges on several fields")
        if ranged and order and order[0][0] not in ranged:
            refuse("a range must be on the first ordered field")
        tail: Tail = order or tuple((f, False) for f in ranged)
        single = all((group, f) not in self.exempt for f in equal | {f for f, _ in tail})
        if single and (not tail or (len(tail) == 1 and not equal)):
            return
        covered: set[str] = set()
        for fields in self.composites.get(group, []):
            lead, end = fields[:len(fields) - len(tail)], fields[len(fields) - len(tail):]
            if tail and end == tail and {f for f, _ in lead} <= equal:
                covered |= {f for f, _ in lead}
                if not equal:
                    return
        if not equal or covered != equal:
            refuse("no single-field or composite index fits")


class MemDb(FirestoreIndex):
    """In-memory ``FirestoreIndex``: documents by path (``docs``), decoded the way the real client returns them (a
    timestamp is its ISO string).

    * Writes: ``commit`` applies the real REST bodies of ``update_op`` / ``delete_op`` atomically (``currentDocument``
      preconditions, ``updateMask`` incl. nested paths, ``increment`` / ``REQUEST_TIME`` transforms); the transaction
      endpoints (``:beginTransaction``, ``:rollback``, ``:commit``, ``:batchGet``) are served too. ``commits`` counts
      the successful commits, ``commit_log`` records every attempted one, ``fail_next`` (a list of exceptions) breaks
      the next commit(s).
    * Reads: ``get``, ``run_query`` (``== < <= > >=`` and ``array-contains`` filters on dotted paths, several orders
      ascending or descending, ``start_after`` cursor, ``limit``), ``aggregate`` / ``count``.
    * Billing, as Firestore bills it: ``reads`` is documents returned per collection (``count:<collection>`` for an
      aggregation); ``total_reads`` sums it. A ``batchGet`` (``get_many``, transaction reads) counts like a ``get`` per
      document. ``bill_misses`` bills a missed ``get`` and an empty query 1 each.
      ``gets`` / ``queries`` / ``touched`` record what was asked; ``reset_counters()`` clears all of them.
    * ``indexed=True`` refuses (``AssertionError``) a query or aggregation no index of ``firestore.indexes.json`` serves
      (``IndexGuard``), so an offline test can't pass on a query production would reject; ``aggregations`` names the
      kinds an aggregation may ask for (``("count",)`` refuses a sum); ``aliases`` maps a collection a test renamed to
      the collection group whose indexes apply.
    """

    def __init__(self, *, bill_misses: bool = False, indexed: bool = False,
                 aggregations: Iterable[str] = ("count", "sum"), aliases: Optional[dict[str, str]] = None) -> None:
        super().__init__("p1", session_factory=lambda: None)
        self.guard: Optional[IndexGuard] = IndexGuard(aliases=aliases) if indexed else None
        self.aggregations = frozenset(aggregations)
        self.docs: dict[str, dict[str, Any]] = {}
        self.commits = 0
        self.commit_log: list[list[dict[str, Any]]] = []
        self.fail_next: list[Exception] = []
        self.request_time = REQUEST_TIME
        self.bill_misses = bill_misses
        self.reads: dict[str, int] = {}
        self.gets: list[str] = []
        self.queries: list[tuple[str, list]] = []
        self.touched: list[str] = []  # collections read, in order
        self._tx = 0

    # ----- seeding and counters
    def put(self, *seeds: Seed) -> None:
        for s in seeds:
            self.put_doc(s.path, s.data)

    def put_all(self, seeds: Iterable[Seed]) -> None:
        self.put(*seeds)

    def put_doc(self, path: str, data: dict[str, Any]) -> None:
        self.docs[path] = decode(data)

    @property
    def total_reads(self) -> int:
        return sum(self.reads.values())

    def reset_counters(self) -> None:
        self.reads.clear()
        self.gets.clear()
        self.queries.clear()
        self.touched.clear()

    def _bill(self, collection: str, n: int) -> None:
        self.reads[collection] = self.reads.get(collection, 0) + n

    # ----- reads
    def _read(self, path: str) -> Document:
        self._bill(path.rsplit("/", 1)[0], 1)
        return Document(path, copy.deepcopy(self.docs[path]))

    def get(self, path: str) -> Optional[Document]:
        self.gets.append(path)
        self.touched.append(path.rsplit("/", 1)[0])
        if path in self.docs:
            return self._read(path)
        if self.bill_misses:
            self._bill(path.rsplit("/", 1)[0], 1)
        return None

    def _rows(self, collection: str, filters: Any) -> list[tuple[str, dict[str, Any]]]:
        rows = [(p, d) for p, d in self.docs.items() if p.rsplit("/", 1)[0] == collection]
        for field, op, value in filters or []:
            def keep(doc: dict[str, Any]) -> bool:
                got = _dig(doc, field)
                if got is None:
                    return False
                if op == "array-contains":
                    return isinstance(got, list) and value in got
                return _FILTERS[op](_key(got), _key(value))

            rows = [(p, d) for p, d in rows if keep(d)]
        return rows

    def run_query(self, collection, *, filters=None, order_by=None, limit=None, start_after=None,
                  collection_group=False, transaction=None) -> list[Document]:
        if self.guard is not None:
            self.guard.check(collection, filters, order_by)
        self.queries.append((collection, list(filters or [])))
        self.touched.append(collection)
        specs = [(o.lstrip("-"), o.startswith("-")) for o in (order_by or [])]
        rows = [r for r in self._rows(collection, filters) if all(f in r[1] for f, _ in specs)]
        name_desc = specs[-1][1] if specs else False

        def compare(a: tuple[str, dict], b: tuple[str, dict]) -> int:
            for field, desc in specs:
                x, y = _key(a[1][field]), _key(b[1][field])
                if x != y:
                    return (-1 if x < y else 1) * (-1 if desc else 1)
            if a[0] == b[0]:
                return 0
            return (-1 if a[0] < b[0] else 1) * (-1 if name_desc else 1)

        rows.sort(key=cmp_to_key(compare))
        if start_after is not None:
            marker = (start_after.path, decode(start_after.data))
            rows = [r for r in rows if compare(r, marker) > 0]
        if limit is not None:
            rows = rows[:limit]
        if not rows and self.bill_misses:
            self._bill(collection, 1)
        return [self._read(p) for p, _ in rows]

    def aggregate(self, collection, aggregations, *, filters=None, collection_group=False) -> dict[str, Any]:
        kinds = {how if how == "count" else how[0] for how in aggregations.values()}
        assert kinds <= self.aggregations, f"{collection}: asks for {sorted(kinds - self.aggregations)}, not expected here"
        if self.guard is not None:
            self.guard.check(collection, filters, None)
        rows = self._rows(collection, filters)
        self.touched.append(collection)
        self._bill("count:" + collection, 1)
        out: dict[str, Any] = {}
        for alias, how in aggregations.items():
            if how == "count":
                out[alias] = len(rows)
            else:
                out[alias] = sum(d[how[1]] for _, d in rows if isinstance(d.get(how[1]), (int, float)))
        return out

    # ----- writes and transactions (the REST endpoints ``Transaction`` talks to)
    def _post(self, path: str, body: dict) -> Any:
        if path == ":beginTransaction":
            self._tx += 1
            return {"transaction": f"tx{self._tx}"}
        if path == ":rollback":
            return {}
        if path == ":batchGet":  # ``get_many`` and transaction reads: billed and recorded like a ``get`` each
            rows = []
            for name in body["documents"]:
                p = name.split("/documents/", 1)[1]
                self.gets.append(p)
                self.touched.append(p.rsplit("/", 1)[0])
                if p in self.docs or self.bill_misses:
                    self._bill(p.rsplit("/", 1)[0], 1)
                rows.append({"found": {"name": name, "fields": {k: to_value(v) for k, v in self.docs[p].items()}}}
                            if p in self.docs else {"missing": name})
            return rows
        if path == ":commit":
            self.commit(body["writes"])
            return {}
        raise AssertionError(f"MemDb does not serve {path}")

    def commit(self, writes, *, transaction=None) -> None:
        self.commit_log.append(copy.deepcopy(writes))
        if self.fail_next:
            raise self.fail_next.pop(0)
        staged = copy.deepcopy(self.docs)
        for w in writes:
            target = w["delete"] if "delete" in w else w["update"]["name"]
            path = target.split("/documents/", 1)[1]
            cond = w.get("currentDocument")
            if cond and "exists" in cond and (path in staged) != cond["exists"]:
                raise PreconditionFailed(f"precondition on {path}")
            if "delete" in w:
                staged.pop(path, None)
                continue
            fields = {k: from_value(v) for k, v in w["update"].get("fields", {}).items()}
            if "updateMask" not in w:
                staged[path] = fields
            else:
                doc = staged.setdefault(path, {})
                for fp in w["updateMask"]["fieldPaths"]:
                    parts = split_path(fp)
                    src: Any = fields
                    for part in parts:
                        src = src.get(part, _MISSING) if isinstance(src, dict) else _MISSING
                    dst = doc
                    for part in parts[:-1]:
                        dst = dst.setdefault(part, {})
                    if src is _MISSING:
                        dst.pop(parts[-1], None)
                    else:
                        dst[parts[-1]] = src
            doc = staged.setdefault(path, {})
            for t in w.get("updateTransforms", []):
                parts = split_path(t["fieldPath"])
                dst = doc
                for part in parts[:-1]:
                    dst = dst.setdefault(part, {})
                if "increment" in t:
                    dst[parts[-1]] = dst.get(parts[-1], 0) + from_value(t["increment"])
                else:
                    dst[parts[-1]] = self.request_time
        self.docs = staged
        self.commits += 1


# --------------------------------------------------------------------------- the admin app under test (shared by the API tests)

ENGINE_INFO = {"name": "fake", "version": "1.0", "features": {}}
SIGNING_KEY = "test-signing-key-0123456789abcdef"
SIGN_IN_T0 = 1_800_000_000.0     # the moment ``FakeVerifier`` signs everybody in (epoch seconds)
BOSS = "boss"                    # the admin of the ``world`` fixture (``conftest.py``)
LOGIN_AT = datetime(2026, 10, 7, 18, 20, tzinfo=timezone.utc)   # what the fake Firebase Auth says of the last sign-in
DEFAULT_LIMITS = {"analyses": 40, "vocals": 15, "jobs": 2, "maxDurationMin": 15, "maxUploadMb": 50}


class Clock:
    """A clock in epoch seconds that only moves when told."""

    def __init__(self, now: float = SIGN_IN_T0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeVerifier:
    """``tok-<uid>`` is a sign-in just now, ``tok-<uid>:<seconds>`` one that many seconds ago."""

    def __init__(self, clock: Clock, *, with_auth_time: bool = True) -> None:
        self.clock = clock
        self.with_auth_time = with_auth_time

    def verify_claims(self, token: str) -> tuple[str, Optional[float]]:
        from app.auth import AuthError

        if not token.startswith("tok-") or len(token) <= 4:
            raise AuthError("Invalid token")
        uid, _, age = token[4:].partition(":")
        return uid, (self.clock() - float(age or 0)) if self.with_auth_time else None

    def verify(self, token: str) -> str:
        return self.verify_claims(token)[0]


def H(uid: str, age_s: Optional[float] = None) -> dict[str, str]:
    """The headers of ``uid``'s request, signed in ``age_s`` seconds ago (just now by default)."""
    return {"Authorization": f"Bearer tok-{uid}" + (f":{age_s}" if age_s is not None else "")}


def settings_for(tmp_path: Path, *, cloud: bool = True) -> Any:
    """The app's settings for a test: the cloud (Firebase sign-in) unless ``cloud=False``, nothing published."""
    from app.models import Settings

    return Settings(
        data_dir=tmp_path / "data",
        frontend_dist=tmp_path / "no-dist",
        auth="firebase" if cloud else "off",
        signing_key=SIGNING_KEY,
        publish=False,
        allowed_hosts=("testserver", "localhost"),
    )


def never(*_: Any, **__: Any) -> dict:
    """The analysis engine of the admin tests: it must not run."""
    raise AssertionError("the engine must not run in these tests")


def iso(dt: datetime) -> str:
    """A UTC timestamp the way Firestore reads it back."""
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class DirectoryDb(MemDb):
    """``MemDb`` plus the seeding helpers of the email-index (directory) tests."""

    def add_user(self, uid: str, email: Optional[str], created: Optional[datetime]) -> None:
        data: dict[str, Any] = {"settings": {"theme": "dark"}}
        if email is not None:
            data["email"] = email
        if created is not None:
            data["createdAt"] = iso(created)
        self.docs[f"users/{uid}"] = data

    def shard_ids(self) -> list[str]:
        return sorted(p.split("/")[1] for p in self.docs if p.startswith("adminEmailIndex/"))


class UsersDb(MemDb):
    """``MemDb`` whose commits that write the journal can be made to fail (``fail_audit``); every query and count is
    checked against the deployed indexes (the deletion cap's count, the card's jobs, ...)."""

    def __init__(self) -> None:
        super().__init__(indexed=True)
        self.fail_audit = False

    def audit_docs(self) -> list[dict[str, Any]]:
        return sorted((d for p, d in self.docs.items() if p.startswith("adminAudit/")), key=lambda d: d["at"])

    def commit(self, writes: list[dict[str, Any]], *, transaction: Optional[str] = None) -> None:
        from app.firestore import IndexError_

        if self.fail_audit and any("/adminAudit/" in (w.get("update", {}).get("name", "")) for w in writes):
            raise IndexError_("Firestore is down", retryable=True)
        super().commit(writes, transaction=transaction)


def write_quota(w: Any, uid: str, **counters: int) -> None:
    """Today's quota counters of ``uid`` in the ``world``'s data directory."""
    folder = w.app.state.store.user_dir(uid)
    folder.mkdir(parents=True, exist_ok=True)
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    (folder / "quota.json").write_text(json.dumps({"day": day, **counters}))


def utc_today() -> Any:
    return datetime.now(timezone.utc).date()


def encode_cursor(created_at: str, track_id: str) -> str:
    """A song-list cursor the way the server packs one."""
    import base64

    raw = json.dumps({"c": created_at, "i": track_id}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


# --------------------------------------------------------------------------- the account-action tests (restriction, deletion)

ACCOUNT_UID = "u1"
REASON = "автоматичні масові запити"
SINCE = datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc)
SCHEDULED = datetime(2026, 10, 5, 9, 0, tzinfo=timezone.utc)


def seed_account(w: Any, uid: str = ACCOUNT_UID, **account: Any) -> None:
    """``users/<uid>`` (Ivan.P@example.test) and, when given, its ``adminAccounts`` state."""
    w.db.put(make_user(uid, "Ivan.P@example.test", created_at=datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc)))
    if account:
        w.db.put(make_account_state(uid, **account))


def restriction(since: datetime = SINCE, reason: str = REASON, by: str = "someone") -> dict[str, Any]:
    return {"reason": reason, "since": since, "byAdminUid": by}


def deletion(restricted_before: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    return {"scheduledAt": SCHEDULED, "purgeAfter": SCHEDULED + timedelta(days=7), "byAdminUid": "someone",
            "priorRestriction": restricted_before}


def journal(w: Any) -> list[dict[str, Any]]:
    return w.db.audit_docs()


def snapshot(w: Any) -> dict[str, Any]:
    return copy.deepcopy(w.db.docs)


def counting(w: Any) -> list[int]:
    """A one-element list that holds the number of commits made so far."""
    n = [0]
    real = w.db.commit

    def commit(writes, *, transaction=None):
        real(writes, transaction=transaction)
        n[0] += 1

    w.db.commit = commit  # type: ignore[method-assign]
    return n


def admit(w: Any, kind: str = "analysis", *, uid: str = ACCOUNT_UID) -> None:
    """Ask the admission gate whether ``uid`` may start a ``kind`` job now (raises when refused)."""
    w.app.state.admission.check(uid, kind, "file", running=0, quotas=w.app.state.jobs.quotas)

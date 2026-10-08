"""Shared fixtures for the admin tests (docs/features/admin/data-model.md §Test fixtures, SAD §10).

* Factories (``make_admin``, ``make_user``, ``make_tracks``, ``make_account_state``, ``make_job``,
  ``make_stats_day``, ``make_audit``) return ``Seed`` values: a document path plus its fields. They touch no
  network, so offline tests can assert on them; ``seed(db, seeds)`` writes them to an emulator in batches.
* ``seed_synthetic_users(db, n)`` fills ``users/*`` and ``adminEmailIndex/s000…`` (NFR: search p95 at 10 000 users).
* ``HOSTILE_STRINGS`` / ``HOSTILE_EMAILS`` plant markup, script URLs, bidi controls and very long text (AC-05).
* ``ReadCounter`` counts the document reads a block of code costs, the way Firestore bills them (NFR: ≤ 200 reads
  per screen). The ``read_counter`` pytest fixture in ``conftest.py`` installs it on every ``FirestoreIndex``.

PII guard: every address is on ``example.test``; no real names or emails appear anywhere.
"""
from __future__ import annotations

import secrets
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Iterator, Optional

from app.firestore import FirestoreIndex

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

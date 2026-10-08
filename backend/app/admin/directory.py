"""The email-index directory: find a user by part of their email (ADR-0009, data-model Aggregate 5).

Firestore matches only whole values and prefixes, so the admin search runs in memory over a compact projection of
``users``: ``adminEmailIndex/s000, s001, ...`` documents, each holding ``entries`` (uid -> lower-cased email),
``count``, ``syncedThrough`` and ``fullSyncAt``. A shard takes at most ``SHARD_SIZE`` entries (the ~1 MiB document
limit), so a search reads a handful of documents however many users match.

* ``search(q)``     at least 3 characters, case-insensitive substring, at most 50 hits. It first catches up.
* ``catch_up()``    folds in users registered since the cursor (the oldest ``syncedThrough`` of any shard), so a new
                    registration is found without waiting for a full sync.
* ``full_sync()``   rebuilds every shard from ``users`` (the twice-a-day sweep). It is also the only way an email
                    change reaches the index (accepted debt, SAD §11).
* ``remove(uid)``   takes a uid's email out of the index (the purge).
* ``email_of(uid)`` the address of a uid, for the audit list; ``None`` when it is not (or no longer) indexed.

The shards are cached for ``CACHE_TTL_S`` seconds per instance; a purge on another instance shows up here after that.
"""
from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Optional

from app.firestore import Document, FirestoreIndex, Transaction, field_path

SHARD_SIZE = 20_000          # ~1 MiB document limit (SAD §7)
MIN_QUERY_LENGTH = 3         # AC-04
MAX_RESULTS = 50
CACHE_TTL_S = 30.0
CATCH_UP_PAGE = 500          # users read per query when catching up
SYNC_PAGE = 1000             # users read per query during a full sync
SYNC_SKEW = timedelta(minutes=5)   # a full sync's cursor starts this far before the sync, so a registration that
                                   # raced the scan (or a clock a little off) is re-read by the next catch-up

USERS = "users"
INDEX = "adminEmailIndex"
TOMBSTONES = "adminTombstones"   # written by the purge (deletion.py)

_FRACTION = re.compile(r"(\.\d{6})\d+")


@dataclass(frozen=True)
class Match:
    uid: str
    email: str      # lower-cased, as indexed


@dataclass
class _Shard:
    id: str
    entries: dict[str, str] = field(default_factory=dict)
    synced_through: Optional[datetime] = None
    full_sync_at: Optional[datetime] = None


def shard_id(n: int) -> str:
    return f"s{n:03d}"


def parse_time(value: Any) -> Optional[datetime]:
    """A Firestore timestamp as read back (an ISO string, nanoseconds trimmed to microseconds) or a datetime."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value:
        return datetime.fromisoformat(_FRACTION.sub(r"\1", value.replace("Z", "+00:00")))
    return None


def _shard_of(doc: Document) -> _Shard:
    entries = doc.data.get("entries")
    return _Shard(
        doc.id,
        {str(u): e for u, e in entries.items() if isinstance(e, str)} if isinstance(entries, dict) else {},
        parse_time(doc.data.get("syncedThrough")),
        parse_time(doc.data.get("fullSyncAt")),
    )


class Directory:
    def __init__(
        self,
        db: FirestoreIndex,
        *,
        shard_size: int = SHARD_SIZE,
        users_collection: str = USERS,
        index_collection: str = INDEX,
        tombstones_collection: str = TOMBSTONES,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._db = db
        self._shard_size = shard_size
        self._users = users_collection
        self._index = index_collection
        self._tombstones = tombstones_collection
        self._now = now
        self._monotonic = monotonic
        self._lock = threading.RLock()
        self._shards: Optional[dict[str, _Shard]] = None
        self._loaded_at = 0.0

    # ----------------------------------------------------------------------- public

    def search(self, query: str, limit: int = MAX_RESULTS) -> list[Match]:
        """Users whose email contains ``query`` (trimmed, case-insensitive), ordered by email, at most ``limit`` (50).
        A query shorter than 3 characters raises ``ValueError`` before anything is read."""
        needle = query.strip().lower()
        if len(needle) < MIN_QUERY_LENGTH:
            raise ValueError(f"search needs at least {MIN_QUERY_LENGTH} characters")
        with self._lock:
            self._loaded()
            self._catch_up()
            assert self._shards is not None
            hits = [Match(uid, email) for s in self._shards.values() for uid, email in s.entries.items() if needle in email]
        hits.sort(key=lambda m: (m.email, m.uid))
        return hits[:limit]

    def catch_up(self) -> int:
        """Fold in the users registered since the index's cursor; returns how many were added or updated.
        An index that does not exist yet is built in full."""
        with self._lock:
            self._loaded()
            return self._catch_up()

    def full_sync(self) -> int:
        """Rebuild every shard from ``users``; returns the number of indexed emails."""
        with self._lock:
            return self._full_sync()

    def remove(self, uid: str) -> bool:
        """Delete ``uid``'s entry from every shard that holds it (read fresh, in a transaction). True if it was there."""

        def work(tx: Transaction) -> tuple[bool, dict[str, _Shard]]:
            docs = tx.run_query(self._index)
            writes = []
            for doc in docs:
                entries = doc.data.get("entries")
                if isinstance(entries, dict) and uid in entries:
                    writes.append(self._db.update_op(
                        doc.path, {"count": len(entries) - 1}, exists=True,
                        mask=[field_path("entries", uid), "count"]))
                    del entries[uid]
            if writes:
                tx.commit(writes)
            return bool(writes), {d.id: _shard_of(d) for d in docs}

        with self._lock:
            removed, shards = self._db.run_transaction(work)
            self._store(shards)
            return removed

    def email_of(self, uid: str) -> Optional[str]:
        """The indexed (lower-cased) email of ``uid``, or None. A uid the index does not know yet is looked for
        among the newest registrations once."""
        with self._lock:
            self._loaded()
            email = self._lookup(uid)
            if email is None and self._catch_up():
                email = self._lookup(uid)
            return email

    # ----------------------------------------------------------------------- shard cache

    def _store(self, shards: dict[str, _Shard]) -> None:
        self._shards = shards
        self._loaded_at = self._monotonic()

    def _loaded(self) -> dict[str, _Shard]:
        """The shards, read from Firestore unless a copy younger than the TTL is cached."""
        if self._shards is None or self._monotonic() - self._loaded_at > CACHE_TTL_S:
            self._store({d.id: _shard_of(d) for d in self._db.run_query(self._index)})
        assert self._shards is not None
        return self._shards

    def _lookup(self, uid: str) -> Optional[str]:
        for shard in (self._shards or {}).values():
            if uid in shard.entries:
                return shard.entries[uid]
        return None

    # ----------------------------------------------------------------------- catch-up

    def _cursor(self) -> Optional[datetime]:
        shards = self._shards or {}
        stamps = [s.synced_through for s in shards.values()]
        if not stamps or any(t is None for t in stamps):
            return None
        return min(t for t in stamps if t is not None)

    def _catch_up(self) -> int:
        cursor = self._cursor()
        if cursor is None:                       # no index (or a shard without a cursor): build it from scratch
            return self._full_sync()
        total, last = 0, None
        while True:
            page = self._db.run_query(
                self._users, filters=[("createdAt", ">", cursor)], order_by=["createdAt"],
                limit=CATCH_UP_PAGE, start_after=last)
            added: dict[str, str] = {}
            newest = cursor
            emails = {doc.id: doc.data.get("email") for doc in page}
            purged = self._purged_among([uid for uid, email in emails.items() if isinstance(email, str) and email])
            for doc in page:
                email = emails[doc.id]
                if isinstance(email, str) and email and doc.id not in purged:
                    added[doc.id] = email.lower()
                created = parse_time(doc.data.get("createdAt"))
                if created is not None and created > newest:
                    newest = created
            if page and (added or newest > cursor):
                if not self._fold_in(added, newest):
                    return self._full_sync()     # the shards vanished under us: rebuild
                total += len(added)
            if len(page) < CATCH_UP_PAGE:
                return total
            last = page[-1]

    def _fold_in(self, added: dict[str, str], newest: datetime) -> bool:
        """Write ``added`` into the shards and move every shard's cursor to ``newest`` (one transaction on fresh
        shards, so the counts stay right). Existing uids are updated in place; new ones fill the last shard, then
        open the next. False if there is no shard at all."""

        def work(tx: Transaction) -> Optional[dict[str, _Shard]]:
            docs = sorted(tx.run_query(self._index), key=lambda d: d.id)
            if not docs:
                return None
            shards = {d.id: _shard_of(d) for d in docs}
            home = {uid: s.id for s in shards.values() for uid in s.entries}
            touched: dict[str, dict[str, str]] = {}
            created: set[str] = set()
            fill = docs[-1].id
            for uid, email in added.items():
                sid = home.get(uid)
                if sid is None:
                    if len(shards[fill].entries) >= self._shard_size:
                        fill = shard_id(int(fill[1:]) + 1)
                        shards[fill] = _Shard(fill, full_sync_at=shards[docs[-1].id].full_sync_at)
                        created.add(fill)
                    sid = home[uid] = fill
                shards[sid].entries[uid] = email
                touched.setdefault(sid, {})[uid] = email
            writes = []
            for sid, shard in shards.items():
                if shard.synced_through is None or newest > shard.synced_through:
                    shard.synced_through = newest
                data: dict[str, Any] = {"count": len(shard.entries), "syncedThrough": shard.synced_through}
                mask = ["count", "syncedThrough"]
                if sid in touched:
                    data["entries"] = touched[sid]
                    mask += [field_path("entries", uid) for uid in touched[sid]]
                if sid in created:
                    data["fullSyncAt"] = shard.full_sync_at or self._now()
                    mask.append("fullSyncAt")
                writes.append(self._db.update_op(f"{self._index}/{sid}", data, mask=mask))
            tx.commit(writes)
            return shards

        shards = self._db.run_transaction(work)
        if shards is None:
            return False
        self._store(shards)
        return True

    # ----------------------------------------------------------------------- full sync

    def _purged(self) -> set[str]:
        """The uids that have a tombstone: a purged (or being purged) account is never indexed again, whatever a
        client holding a still-valid token wrote back to ``users/{uid}`` (review S2-2). The full sync reads them all
        once (it reads every user anyway)."""
        return {d.id for d in self._db.run_query(self._tombstones)}

    def _purged_among(self, uids: list[str]) -> set[str]:
        """Which of ``uids`` have a tombstone: a catch-up asks only about the registrations it folds in (a batched
        read of just those), never the whole collection, which grows with every purge."""
        if not uids:
            return set()
        found = self._db.get_many(f"{self._tombstones}/{uid}" for uid in uids)
        return {path.rsplit("/", 1)[1] for path in found}

    def _all_emails(self) -> dict[str, str]:
        emails: dict[str, str] = {}
        purged = self._purged()
        last: Optional[Document] = None
        while True:
            # Ordered by email: only users that have one are returned, and that is exactly who is indexed.
            page = self._db.run_query(self._users, order_by=["email"], limit=SYNC_PAGE, start_after=last)
            for doc in page:
                email = doc.data.get("email")
                if isinstance(email, str) and email and doc.id not in purged:
                    emails[doc.id] = email.lower()
            if len(page) < SYNC_PAGE:
                return emails
            last = page[-1]

    def _full_sync(self) -> int:
        started = self._now()
        cursor = started - SYNC_SKEW
        emails = self._all_emails()
        uids = sorted(emails)
        chunks: list[Iterable[str]] = [uids[i:i + self._shard_size]
                                       for i in range(0, len(uids), self._shard_size)] or [[]]
        shards: dict[str, _Shard] = {}
        for n, chunk in enumerate(chunks):
            shard = _Shard(shard_id(n), {u: emails[u] for u in chunk}, cursor, started)
            shards[shard.id] = shard
            self._db.commit([self._db.update_op(f"{self._index}/{shard.id}", {
                "entries": shard.entries, "count": len(shard.entries),
                "syncedThrough": cursor, "fullSyncAt": started})])        # one shard (up to ~1 MiB) per commit
        stale = [d.path for d in self._db.run_query(self._index) if d.id not in shards]
        if stale:
            self._db.commit([self._db.delete_op(p) for p in stale])
        self._store(shards)
        return len(emails)

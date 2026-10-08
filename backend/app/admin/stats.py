"""Daily stats counters (ADR-0010, data-model Aggregate 3): ``adminStats/{day}`` and its ``activeUsers/{uid}`` markers.

The overview reads one document per UTC day, so the counters are bumped at event time with atomic ``increment``
transforms (``counter_writes``) instead of being counted on read. A day is **live** until the nightly reconciliation
freezes it; a **frozen** day, and a **restored** one (rebuilt from tracks before the launch, AC-08), never changes:
``counter_writes`` returns no write for them, whatever the event. The service account (``SMOKE_UID``) is excluded
from the stats altogether (``is_service``).

This module only builds writes; the caller reads the documents inside its transaction and commits.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

from app.firestore import Document, FirestoreIndex, field_path, increment
from app.users import SMOKE_UID

STATS = "adminStats"
ACTIVE_USERS = "activeUsers"
LIVE = "live"
ORIGINS = ("link", "file", "mic", "tab")
MARKER_TTL = timedelta(days=3)  # `activeUsers.expireAt` = the day + 3 d (reconciliation recomputes `active` from jobs)

CounterPath = tuple[str, ...]  # ("analyses", "link"), ("failed",), ("failedByReason", "youtube_blocked"), ...


def is_service(uid: str) -> bool:
    """The deployment smoke-test account: labelled «службовий», never counted into the stats (spec OQ, 2026-10-08)."""
    return uid == SMOKE_UID


def utc_day(when: datetime) -> str:
    """The stats day (``YYYY-MM-DD``, UTC) a moment belongs to."""
    return when.astimezone(timezone.utc).strftime("%Y-%m-%d")


def day_start(day: str) -> datetime:
    return datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def day_path(day: str, collection: str = STATS) -> str:
    return f"{collection}/{day}"


def marker_path(day: str, uid: str, collection: str = STATS) -> str:
    return f"{collection}/{day}/{ACTIVE_USERS}/{uid}"


def empty_day(now: datetime) -> dict[str, Any]:
    """A live day with every counter at zero (the shape ``StatsDay`` in the contract reads back)."""
    return {
        "state": LIVE,
        "analyses": {origin: 0 for origin in ORIGINS},
        "vocals": 0,
        "failed": 0,
        "failedByReason": {},
        "active": 0,
        "newUsers": None,
        "restoredTracks": None,
        "reconciledDiff": None,
        "frozenAt": None,
        "updatedAt": now,
    }


def marker_doc(day: str, now: datetime) -> dict[str, Any]:
    return {"at": now, "expireAt": day_start(day) + MARKER_TTL}


def is_open(day_doc: Optional[Document]) -> bool:
    """Whether events still count into the day: it does not exist yet (the first event creates it) or is live."""
    return day_doc is None or day_doc.data.get("state") == LIVE


def counter_writes(
    db: FirestoreIndex,
    day: str,
    day_doc: Optional[Document],
    deltas: Mapping[CounterPath, int],
    now: datetime,
    *,
    collection: str = STATS,
) -> list[dict[str, Any]]:
    """The writes that add ``deltas`` to ``adminStats/{day}``, given the document as the caller's transaction read it.

    A missing day is created live with the deltas applied (precondition ``exists=False``); a live day gets atomic
    increments; a frozen or restored day gets nothing (an empty list), so it never changes (ADR-0010).
    """
    if not deltas or not is_open(day_doc):
        return []
    path = day_path(day, collection)
    if day_doc is None:
        data = empty_day(now)
        for counter, by in deltas.items():
            node = data
            for key in counter[:-1]:
                node = node[key]
            node[counter[-1]] = node.get(counter[-1], 0) + by
        return [db.update_op(path, data, exists=False)]
    return [db.update_op(
        path,
        {"updatedAt": now},
        mask=["updatedAt"],
        exists=True,
        transforms=[increment(field_path(*counter), by) for counter, by in deltas.items()],
    )]

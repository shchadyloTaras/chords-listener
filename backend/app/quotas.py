"""Per-user daily quotas (cloud mode, docs/CLOUD.md → Per-user data).

Counters live in ``<data>/users/<uid>/quota.json`` (``{"day": "YYYY-MM-DD", "analyses": n, "vocals": m}``)
so they survive restarts; the UTC day rolls them over. Local mode has no quotas.
Exceeded → ``QuotaExceeded`` (HTTP 429, code ``quota_exceeded``).
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from typing import Any, Optional

from .models import Settings
from .sources import SourceError
from .storage import TrackStore, read_json, write_json_atomic
from .users import current_uid

log = logging.getLogger("chords.quotas")

QUOTA_FILE = "quota.json"
KINDS = ("analyses", "vocals")


class QuotaExceeded(SourceError):
    def __init__(self, message: str) -> None:
        super().__init__("quota_exceeded", message, 429)


def utc_day() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


class Quotas:
    def __init__(self, settings: Settings, store: TrackStore) -> None:
        self.settings = settings
        self.store = store
        self._lock = threading.Lock()
        self._cache: dict[str, dict[str, Any]] = {}  # uid -> counters of the current day

    @property
    def enabled(self) -> bool:
        return self.settings.cloud

    def limit(self, kind: str) -> int:
        return {"analyses": self.settings.quota_analyses, "vocals": self.settings.quota_vocals}[kind]

    def _load(self, uid: str) -> dict[str, Any]:
        day = utc_day()
        cached = self._cache.get(uid)
        if cached and cached.get("day") == day:
            return cached
        data: dict[str, Any] = {}
        try:
            raw = read_json(self.store.user_dir(uid) / QUOTA_FILE)
            data = raw if isinstance(raw, dict) else {}
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            log.warning("unreadable quota file for %s; starting from zero", uid)
        if data.get("day") != day:
            data = {"day": day}
        counters = {"day": day, **{k: int(data.get(k) or 0) for k in KINDS}}
        self._cache[uid] = counters
        return counters

    def usage(self, uid: Optional[str] = None) -> dict[str, Any]:
        """``{"day": ..., "analyses": {"used", "limit"}, "vocals": {...}}`` for the current user."""
        uid = uid or current_uid()
        if not self.enabled or not uid:
            return {}
        with self._lock:
            counters = dict(self._load(uid))
        return {"day": counters["day"], **{k: {"used": counters[k], "limit": self.limit(k)} for k in KINDS}}

    def consume(self, kind: str, uid: Optional[str] = None) -> None:
        """Count one unit of ``kind`` ("analyses" | "vocals") for today, or raise QuotaExceeded."""
        if kind not in KINDS:
            raise ValueError(f"unknown quota {kind!r}")
        uid = uid or current_uid()
        if not self.enabled or not uid:
            return
        with self._lock:
            counters = self._load(uid)
            limit = self.limit(kind)
            if counters[kind] >= limit:
                what = "song analyses" if kind == "analyses" else "vocal transcriptions"
                raise QuotaExceeded(f"Daily limit reached: {limit} {what} per day. It resets at 00:00 UTC.")
            counters[kind] += 1
            self._save(uid, counters)

    def refund(self, kind: str, uid: Optional[str] = None) -> None:
        uid = uid or current_uid()
        if not self.enabled or not uid or kind not in KINDS:
            return
        with self._lock:
            counters = self._load(uid)
            if counters[kind] > 0:
                counters[kind] -= 1
                self._save(uid, counters)

    def _save(self, uid: str, counters: dict[str, Any]) -> None:
        try:
            write_json_atomic(self.store.user_dir(uid) / QUOTA_FILE, counters)
        except OSError:
            log.exception("could not persist the quota of %s (kept in memory)", uid)

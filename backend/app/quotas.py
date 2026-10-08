"""Per-user daily quotas (cloud mode, docs/CLOUD.md → Per-user data).

Counters live in ``<data>/users/<uid>/quota.json`` (``{"day": "YYYY-MM-DD", "analyses": n, "vocals": m}``)
so they survive restarts; the UTC day rolls them over. Local mode has no quotas.
Exceeded → ``QuotaExceeded`` (HTTP 429, code ``quota_exceeded``).

The limit in force for a user (docs/features/admin, AC-13, AC-13b, AC-15, AC-24) is ``effective_limits``: each field
of the user's personal limit that is set wins over the default limit, until the personal limit's end date
(inclusive, UTC); a field that is not set follows the default. The defaults and the personal limit come from a
``LimitSource`` (the admission gate); without one the ``CHORDS_QUOTA_*`` values of ``Settings`` are the defaults and
nobody has a personal limit. ``reset`` clears a user's counters under the same lock as ``consume``.
"""
from __future__ import annotations

import logging
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping, Optional, Protocol

from .models import Settings
from .sources import SourceError
from .storage import TrackStore, read_json, write_json_atomic
from .users import current_uid

log = logging.getLogger("chords.quotas")

QUOTA_FILE = "quota.json"
KINDS = ("analyses", "vocals")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


@dataclass(frozen=True)
class EffectiveLimits:
    analyses: int   # per UTC day
    vocals: int     # per UTC day
    jobs: int       # running at once


class LimitSource(Protocol):
    """Where the limits come from when the admin console is on (``app.admission.Admission``)."""

    def defaults(self) -> Any: ...   # anything with ``analyses`` / ``vocals`` / ``jobs``

    def personal(self, uid: str) -> Optional[Mapping[str, Any]]: ...


def _positive_int(value: Any) -> Optional[int]:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 1 else None


def effective_limits(defaults: Any, personal: Any, today: str) -> EffectiveLimits:
    """``defaults`` (anything with ``analyses`` / ``vocals`` / ``jobs``) with the set fields of ``personal`` laid over.
    A personal limit past its ``until`` day (``YYYY-MM-DD``, the last day it applies, inclusive; UTC) or not
    understood changes nothing; so does a field that is not a positive whole number."""
    values = {name: int(getattr(defaults, name)) for name in ("analyses", "vocals", "jobs")}
    if isinstance(personal, Mapping):
        until = personal.get("until")
        if until is None or (isinstance(until, str) and _DAY.fullmatch(until) and today <= until):
            for name in values:
                chosen = _positive_int(personal.get(name))
                if chosen is not None:
                    values[name] = chosen
    return EffectiveLimits(**values)


class QuotaExceeded(SourceError):
    def __init__(self, message: str) -> None:
        super().__init__("quota_exceeded", message, 429)


def utc_day() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


class Quotas:
    def __init__(self, settings: Settings, store: TrackStore, limits: Optional[LimitSource] = None) -> None:
        self.settings = settings
        self.store = store
        self._limits = limits
        self._lock = threading.Lock()
        self._cache: dict[str, dict[str, Any]] = {}  # uid -> counters of the current day

    @property
    def enabled(self) -> bool:
        return self.settings.cloud

    def effective_limits(self, uid: Optional[str] = None) -> EffectiveLimits:
        """The limits in force for ``uid`` (default: the current user) today. Reads the gate's cached state, never
        takes the counters' lock."""
        uid = uid or current_uid()
        if self._limits is None or not uid:
            s = self.settings
            return EffectiveLimits(s.quota_analyses, s.quota_vocals, s.max_user_jobs)
        return effective_limits(self._limits.defaults(), self._limits.personal(uid), utc_day())

    def limit(self, kind: str, uid: Optional[str] = None) -> int:
        return getattr(self.effective_limits(uid), kind)

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
        """``{"day": ..., "analyses": {"used", "limit"}, "vocals": {...}, "jobs": {"limit"}}`` for the current user.
        Shown to the user: when the admin state cannot be read the env limits are shown rather than an error."""
        uid = uid or current_uid()
        if not self.enabled or not uid:
            return {}
        try:
            limits = self.effective_limits(uid)
        except SourceError:
            log.warning("usage of %s shown with the env limits: the admin state is unavailable", uid)
            s = self.settings
            limits = EffectiveLimits(s.quota_analyses, s.quota_vocals, s.max_user_jobs)
        with self._lock:
            counters = dict(self._load(uid))
        return {
            "day": counters["day"],
            **{k: {"used": counters[k], "limit": getattr(limits, k)} for k in KINDS},
            "jobs": {"limit": limits.jobs},
        }

    def consume(self, kind: str, uid: Optional[str] = None) -> None:
        """Count one unit of ``kind`` ("analyses" | "vocals") for today, or raise QuotaExceeded."""
        if kind not in KINDS:
            raise ValueError(f"unknown quota {kind!r}")
        uid = uid or current_uid()
        if not self.enabled or not uid:
            return
        limit = self.limit(kind, uid)  # outside the lock: the gate's cache may have to read the database
        with self._lock:
            counters = self._load(uid)
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

    def admit(self, kind: str, running: int, uid: Optional[str] = None) -> None:
        """One more job of ``kind`` ("analyses" | "vocals") for ``uid``, who has ``running`` jobs in progress: refused
        (``QuotaExceeded``) when that is the user's limit of parallel jobs or today's ``kind`` quota is spent; else
        counts it. Nothing is counted for a refusal."""
        uid = uid or current_uid()
        if not self.enabled or not uid:
            return
        jobs = self.effective_limits(uid).jobs
        if running >= jobs:
            raise QuotaExceeded(f"You already have {jobs} songs in progress - wait for one to finish")
        self.consume(kind, uid)

    def reset(self, uid: str) -> dict[str, int]:
        """Admin reset (AC-12, AC-12b): today's counters of ``uid`` become zero; returns the values they had. Under
        the lock ``consume`` takes, so an analysis admitted at the same moment is counted either before the reset
        (and cleared with it) or after it (and kept), never lost. Jobs that are running are not touched."""
        with self._lock:
            counters = self._load(uid)
            old = {k: counters[k] for k in KINDS}
            for k in KINDS:
                counters[k] = 0
            self._save(uid, counters)
            return old

    def _save(self, uid: str, counters: dict[str, Any]) -> None:
        try:
            write_json_atomic(self.store.user_dir(uid) / QUOTA_FILE, counters)
        except OSError:
            log.exception("could not persist the quota of %s (kept in memory)", uid)

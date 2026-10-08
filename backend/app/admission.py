"""The admission gate: every cloud job passes ``Admission.check`` before ``Quotas.consume``
(docs/features/admin: ADR-0008; AC-12b, AC-13, AC-13b, AC-15, AC-18, AC-24, AC-26, AC-27, AC-28).

The five entries (a link, an upload, a file from storage, a re-analysis, a vocal transcription) are one call in
``JobManager.admit``; a new entry cannot skip the check. The order is fixed:

1. the account  - a restriction, a scheduled deletion or a purge marker -> ``cloud_restricted`` (403). The reason the
                  administrator wrote is never in the answer.
2. the switches - paused analyses (link, file, re-analysis) -> ``analyses_paused``; a link analysis while YouTube
                  is off -> ``youtube_disabled``; a transcription while vocals are off -> ``vocals_disabled`` (503).
3. the limit    - running jobs and today's quota, each against the *effective* limit (``app.quotas.effective_limits``:
                  the personal value of each set field over the default, until the end date inclusive).
4. ``Quotas.consume``, last: a refusal anywhere above counted nothing.

A job that was accepted is never touched by a later switch or restriction (AC-19, AC-26); nothing here looks at
running jobs. The state of an account (``adminAccounts/<uid>`` and ``adminTombstones/<uid>``) is cached for
``STATE_TTL_S`` seconds, so a change made by an administrator is seen by the next job after at most a minute (AC-16,
AC-24, AC-32 budget); the settings come from ``RuntimeSettings`` (its own cache, 30 s). If a read fails the last
known state is served; with none, the job is refused with a 503 (nothing is counted) rather than let through.
The gate relies on a single server instance (SAD §11): its counters and caches are in this process.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional

from .admin.settings import RuntimeSettings
from .quotas import Quotas
from .sources import SourceError

log = logging.getLogger("chords.admission")

STATE_TTL_S = 60.0
ACCOUNTS = "adminAccounts"
TOMBSTONES = "adminTombstones"
_MAX_CACHED = 4096   # accounts remembered before expired entries are dropped

#: What is being started: a new analysis (link / file / recording), a re-analysis of a song, a vocal transcription.
KINDS = ("analysis", "reanalysis", "vocals")
QUOTA_OF: dict[str, str] = {"analysis": "analyses", "reanalysis": "analyses", "vocals": "vocals"}

RESTRICTED = "Cloud analysis is restricted for your account"
PAUSED = "Cloud analysis is paused for now"
YOUTUBE_OFF = "YouTube downloads on the server are turned off"
VOCALS_OFF = "Vocal transcription is unavailable for now"
UNKNOWN = "Could not check your account right now. Try again in a moment"


@dataclass(frozen=True)
class AccountState:
    restricted: bool                              # restriction, scheduled deletion or purge marker
    personal: Optional[Mapping[str, Any]]         # ``personalLimit`` as stored (None: no personal limit)


class Admission:
    """``db`` needs ``get(path) -> Optional[Document]`` (``FirestoreIndex``); ``runtime`` holds the default limits
    and the switches. It is also the ``LimitSource`` of ``Quotas``."""

    def __init__(
        self,
        db: Any,
        runtime: RuntimeSettings,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        ttl_s: float = STATE_TTL_S,
    ) -> None:
        self._db = db
        self._runtime = runtime
        self._monotonic = monotonic
        self._ttl = ttl_s
        self._lock = threading.Lock()
        self._states: dict[str, tuple[AccountState, float]] = {}   # uid -> (state, loaded at)

    # ----------------------------------------------------------------------- LimitSource (app.quotas)

    def defaults(self) -> Any:
        """The default limits in force (analyses, vocals, jobs ...)."""
        return self._settings().limits

    def personal(self, uid: str) -> Optional[Mapping[str, Any]]:
        return self.state(uid).personal

    # ----------------------------------------------------------------------- the gate

    def prepare(self, uid: str) -> None:
        """Load what ``check`` will read (the account's state, the settings), so a cache miss does its database
        reads before the caller takes a lock, not under it. Raises like ``check`` when nothing can be read."""
        self.state(uid)
        self._settings()

    def check(self, uid: str, kind: str, origin: str, *, running: int, quotas: Quotas) -> None:
        """May ``uid`` start one more job of ``kind`` ("analysis" | "reanalysis" | "vocals") whose audio comes from
        ``origin`` ("link" | "file" | "mic" | "tab"), with ``running`` jobs in progress? Raises ``SourceError``
        (``cloud_restricted``, ``analyses_paused``, ``youtube_disabled``, ``vocals_disabled``, ``quota_exceeded``);
        otherwise counts the job in today's quota."""
        if kind not in QUOTA_OF:
            raise ValueError(f"unknown job kind {kind!r}")
        if self.state(uid).restricted:
            raise SourceError("cloud_restricted", RESTRICTED)
        switches = self._settings().switches
        if kind != "vocals" and switches.analyses_paused:
            raise SourceError("analyses_paused", PAUSED)
        if kind == "analysis" and origin == "link" and not switches.youtube_enabled:
            raise SourceError("youtube_disabled", YOUTUBE_OFF)
        if kind == "vocals" and not switches.vocals_enabled:
            raise SourceError("vocals_disabled", VOCALS_OFF)
        quotas.admit(QUOTA_OF[kind], running, uid)

    # ----------------------------------------------------------------------- account state

    def state(self, uid: str) -> AccountState:
        """The admin state of ``uid`` (cached ``ttl_s``). A failed read serves the last known state."""
        now = self._monotonic()
        with self._lock:
            cached = self._states.get(uid)
        if cached is not None and now - cached[1] <= self._ttl:
            return cached[0]
        try:
            state = self._read(uid)
        except Exception:  # noqa: BLE001 - a read that fails: the last state, or no job
            if cached is not None:
                log.warning("admission: could not refresh the state of %s, serving the previous one", uid, exc_info=True)
                return cached[0]
            log.error("admission: could not read the state of %s", uid, exc_info=True)
            raise SourceError("internal", UNKNOWN, 503) from None
        with self._lock:
            if len(self._states) >= _MAX_CACHED:
                self._states = {u: v for u, v in self._states.items() if now - v[1] <= self._ttl}
            self._states[uid] = (state, now)
        return state

    def invalidate(self, uid: Optional[str] = None) -> None:
        """Forget the cached state of ``uid`` (all accounts when None): the next job re-reads it."""
        with self._lock:
            if uid is None:
                self._states.clear()
            else:
                self._states.pop(uid, None)

    def _read(self, uid: str) -> AccountState:
        account = self._db.get(f"{ACCOUNTS}/{uid}")
        data = account.data if account is not None else {}
        tombstone = self._db.get(f"{TOMBSTONES}/{uid}") is not None
        personal = data.get("personalLimit")
        return AccountState(
            restricted=tombstone or bool(data.get("restriction")) or bool(data.get("deletion")),
            personal=personal if isinstance(personal, Mapping) else None,
        )

    def _settings(self) -> Any:
        try:
            return self._runtime.current()
        except Exception:  # noqa: BLE001 - nothing cached and the database does not answer
            log.error("admission: could not read the runtime settings", exc_info=True)
            raise SourceError("internal", UNKNOWN, 503) from None

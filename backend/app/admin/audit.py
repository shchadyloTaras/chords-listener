"""The admin audit writer: "no journal record, no action, no data" (docs/features/admin: AC-10b, AC-33, AC-33b;
ADR-0007; data-model Aggregate 4).

Three shapes, one per kind of handler:

* ``record_with(writes, entry)`` - a change that lives in Firestore. The change and its record go out in ONE commit
  (or one transaction commit, with ``tx=``), so either both land or neither does. A failed commit raises
  ``NotApplied`` (503 ``not_applied``) and leaves the state as it was.
* ``record_first(entry)`` / ``apply_first(entry, effect)`` - a change outside Firestore (``quota.json``, a Firebase
  account) and the rejected attempts. The record is written first; if that fails the effect never runs
  (``NotApplied``). If the effect then fails, ``mark_not_applied`` appends a ``not_applied`` follow-up whose
  ``refId`` names the first record, and ``apply_first`` raises ``NotApplied``.
* ``record_view(entry)`` - a view of personal data (search, user card). Call it BEFORE building the response; a
  failed write raises ``AuditUnavailable`` (503 ``audit_unavailable``) so no data is returned.

Records are append-only: each one is created with ``exists=False`` under a fresh auto-id, and this module has no
update or delete. A record stores the admin's own email and never the target's (the UI resolves the target from the
email index, AC-11), and expires 400 days after it was written (``expireAt``, the TTL policy of migration 02).
Handlers journal changes, rejected attempts and views only - a form validation error (422) never reaches here.

Every failed write logs the ``audit_write_failed`` metric on ``chords.admin`` (uid and action only, no email).
"""
from __future__ import annotations

import logging
import secrets
import string
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Optional, TypeVar, get_args

from ..firestore import Aborted, FirestoreIndex, IndexError_, PreconditionFailed
from .models import AuditAction, AuditOutcome

log = logging.getLogger("chords.admin")

COLLECTION = "adminAudit"
EXPIRE_AFTER = timedelta(days=400)  # NFR: the journal is kept at least 365 days
VIEW_ACTIONS = frozenset({"search", "view_card"})
MAX_MATCHED_UIDS = 50
QUERY_CHARS = (3, 254)
_ACTIONS = frozenset(get_args(AuditAction))
_OUTCOMES = frozenset(get_args(AuditOutcome))
_ID_ALPHABET = string.ascii_letters + string.digits
_ID_LENGTH = 20  # like a Firestore auto-id

T = TypeVar("T")


class AuditFailure(Exception):
    """The journal could not be written: ``main.py`` renders it as ``{"detail", "code"}`` with ``status``."""

    status = 503
    code = "audit_unavailable"
    detail = "Data is unavailable right now, try again"

    def __init__(self, detail: Optional[str] = None) -> None:
        super().__init__(detail or self.detail)


class NotApplied(AuditFailure):
    """A change was not applied (its record could not be written, or the effect failed): nothing changed."""

    code = "not_applied"
    detail = "The change was not applied, try again"


class AuditUnavailable(AuditFailure):
    """A view could not be recorded, so the data is withheld."""

    code = "audit_unavailable"
    detail = "Data is unavailable right now, try again"


@dataclass(frozen=True)
class AuditEntry:
    """What a handler wants journaled (data-model Aggregate 4). There is no target email on purpose.

    ``outcome`` is ``applied`` (default), ``rejected`` (with ``reject_reason``, the refusal's error code) or
    ``not_applied`` (a follow-up with ``ref_id``; ``Audit.mark_not_applied`` builds those). ``query`` and
    ``matched_uids`` belong to ``search`` only. A malformed entry raises ``ValueError`` before anything is written.
    """

    action: str
    admin_uid: str
    admin_email: str
    outcome: str = "applied"
    target_uid: Optional[str] = None
    setting: Optional[str] = None
    before: Optional[dict[str, Any]] = None
    after: Optional[dict[str, Any]] = None
    reject_reason: Optional[str] = None
    query: Optional[str] = None
    matched_uids: Optional[list[str]] = None
    ref_id: Optional[str] = None

    def __post_init__(self) -> None:
        if self.action not in _ACTIONS:
            raise ValueError(f"unknown audit action {self.action!r}")
        if self.outcome not in _OUTCOMES:
            raise ValueError(f"unknown audit outcome {self.outcome!r}")
        if not self.admin_uid or not self.admin_email:
            raise ValueError("an audit record needs the admin's uid and email")
        if (self.outcome == "rejected") != bool(self.reject_reason):
            raise ValueError("reject_reason is set if and only if the outcome is rejected")
        if (self.outcome == "not_applied") != bool(self.ref_id):
            raise ValueError("ref_id is set if and only if the outcome is not_applied")
        if self.query is not None:
            if self.action != "search":
                raise ValueError("a query belongs to a search record only")
            if not QUERY_CHARS[0] <= len(self.query) <= QUERY_CHARS[1]:
                raise ValueError(f"a search query has {QUERY_CHARS[0]}-{QUERY_CHARS[1]} characters")
        if self.matched_uids is not None:
            if self.action != "search":
                raise ValueError("matched uids belong to a search record only")
            if len(self.matched_uids) > MAX_MATCHED_UIDS:
                raise ValueError(f"a search record lists at most {MAX_MATCHED_UIDS} matches")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _auto_id() -> str:
    return "".join(secrets.choice(_ID_ALPHABET) for _ in range(_ID_LENGTH))


class Audit:
    """``db`` is a ``FirestoreIndex``; ``now`` and ``new_id`` are for tests."""

    def __init__(
        self,
        db: FirestoreIndex,
        *,
        now: Callable[[], datetime] = _utcnow,
        new_id: Callable[[], str] = _auto_id,
    ) -> None:
        self._db = db
        self._now = now
        self._new_id = new_id

    # ----------------------------------------------------------------------- the three shapes

    def record_with(
        self, writes: Iterable[dict[str, Any]], entry: AuditEntry, *, tx: Optional[Any] = None
    ) -> str:
        """Commit ``writes`` (``db.update_op`` / ``delete_op`` bodies) and the record of ``entry`` together; return the
        record's id. ``tx``: a ``Transaction`` to commit through instead of a plain commit; ``Aborted`` then propagates,
        so ``run_transaction`` retries. A failed commit raises ``NotApplied`` and nothing changed. A broken
        precondition of the caller's own writes (``PreconditionFailed``) is not an audit failure and propagates too.
        """
        ref, record = self._record(entry)
        all_writes = [record, *writes]
        try:
            if tx is not None:
                tx.commit(all_writes)
            else:
                self._db.commit(all_writes)
        except (Aborted, PreconditionFailed):
            raise
        except IndexError_ as exc:
            raise self._failed(NotApplied, entry, exc) from exc
        return ref

    def record_first(self, entry: AuditEntry) -> str:
        """Write the record of ``entry`` alone, before the effect it describes; return its id. A failed write raises
        ``NotApplied``: the caller must not run the effect. Also the way to journal a rejected attempt."""
        return self._write_alone(entry, NotApplied)

    def apply_first(self, entry: AuditEntry, effect: Callable[[], T]) -> T:
        """Journal ``entry``, then run ``effect()`` and return what it returns. If the record cannot be written the
        effect does not run; if the effect raises, a ``not_applied`` follow-up is appended and ``NotApplied`` raised."""
        ref = self.record_first(entry)
        try:
            return effect()
        except Exception as exc:
            self.mark_not_applied(ref, entry)
            raise NotApplied() from exc

    def mark_not_applied(self, ref: str, entry: AuditEntry) -> bool:
        """Append the follow-up of the record ``ref`` whose effect failed (same action, admin and target; ``refId`` =
        ``ref``). Best effort, never raises: False when even that write failed (the metric is logged)."""
        follow_up = AuditEntry(
            action=entry.action, admin_uid=entry.admin_uid, admin_email=entry.admin_email, outcome="not_applied",
            target_uid=entry.target_uid, setting=entry.setting, ref_id=ref,
        )
        try:
            self._write_alone(follow_up, NotApplied)
        except NotApplied:
            return False
        return True

    def record_view(self, entry: AuditEntry) -> str:
        """Record a view of personal data (``search`` / ``view_card``) before answering; return the record's id. A
        failed write raises ``AuditUnavailable``: the answer must not carry the data."""
        if entry.action not in VIEW_ACTIONS:
            raise ValueError(f"{entry.action!r} is not a view")
        return self._write_alone(entry, AuditUnavailable)

    # ----------------------------------------------------------------------- internals

    def _record(self, entry: AuditEntry) -> tuple[str, dict[str, Any]]:
        """(id, the create-only write of the record)."""
        at = self._now()
        ref = self._new_id()
        data = {
            "at": at,
            "adminUid": entry.admin_uid,
            "adminEmail": entry.admin_email,
            "action": entry.action,
            "outcome": entry.outcome,
            "targetUid": entry.target_uid,
            "setting": entry.setting,
            "before": entry.before,
            "after": entry.after,
            "rejectReason": entry.reject_reason,
            "query": entry.query,
            "matchedUids": entry.matched_uids,
            "refId": entry.ref_id,
            "expireAt": at + EXPIRE_AFTER,
            "redactedAt": None,
        }
        return ref, self._db.update_op(f"{COLLECTION}/{ref}", data, exists=False)

    def _write_alone(self, entry: AuditEntry, failure: type[AuditFailure]) -> str:
        ref, record = self._record(entry)
        try:
            self._db.commit([record])
        except IndexError_ as exc:  # includes a clash on the id: the record is not stored either way
            raise self._failed(failure, entry, exc) from exc
        return ref

    @staticmethod
    def _failed(failure: type[AuditFailure], entry: AuditEntry, exc: IndexError_) -> AuditFailure:
        # uid and action only: the logs must hold no email (SAD §8). The error text stays out for the same reason.
        log.warning(
            "audit_write_failed action=%s outcome=%s admin=%s target=%s error=%s retryable=%s",
            entry.action, entry.outcome, entry.admin_uid, entry.target_uid, type(exc).__name__, exc.retryable,
        )
        return failure()

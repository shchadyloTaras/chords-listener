"""The admin actions that change something (docs/features/admin; ADR-0005, ADR-0007).

Each action is one function that takes what the handler already resolved (the shared ``AdminServices``, who is
acting) and returns the resulting state. The route handlers in ``router.py`` only parse and authorize.

Service settings (AC-13b, AC-24..AC-30):

* ``set_default_limits``  - ``adminConfig/settings`` ``limits.*`` and its journal record in ONE commit.
* ``set_switch``          - ``adminConfig/settings`` ``switches.<name>``, the public mirror ``publicStatus/current``
                            ``switches.<name>`` and the journal record in ONE commit.
* ``set_banner``          - ``publicStatus/current`` ``banner.*`` and the journal record in ONE commit.

User actions (AC-12, AC-12b, AC-13, AC-14, AC-15, AC-33):

* ``reset_quota``           - journal first, under the ``Quotas`` lock: the record with the old counters is written
                              before ``quota.json`` is zeroed, so a concurrent admission is ordered before or after the
                              reset, never lost. Journal not written: nothing changed. Counters not written: a
                              ``not_applied`` follow-up record. Either way ``NotApplied`` (503).
* ``set_personal_limit``    - ``adminAccounts/<uid>.personalLimit`` (the whole map) and its journal record in ONE commit.
* ``remove_personal_limit`` - the same for removal; no limit set -> ``NotSet`` (409), nothing journaled.

* ``restrict_user``         - the cloud restriction of ``adminAccounts/<uid>`` (reason, since, by) and its journal record in
                              ONE transaction commit. ``unrestrict_user`` is the same for lifting it. Both read the account
                              inside the transaction, so a deletion scheduled meanwhile is seen on the retry. Own account
                              (restrict only) -> ``SelfTarget`` and a scheduled deletion -> ``DeletionPending`` (both 409,
                              journaled as rejected attempts); lifting a restriction that is not there -> ``NotSet`` (409,
                              nothing journaled). A restriction stops no job: it only writes configuration (AC-19).

* ``schedule_deletion``     - ``adminAccounts/<uid>.deletion`` (purgeAfter = +7 d, the prior restriction kept inside), the
                              immediate restriction (fixed reason ``Scheduled deletion``, OQ-API-2) and its journal record in
                              ONE transaction commit, under an in-process lock that also covers the ``count()`` of deletions
                              scheduled by all admins in the last 60 minutes (cap 10, AC-35). Order of checks: own account,
                              already scheduled (both journaled as rejected), typed e-mail (422, not journaled), the cap
                              (journaled). ``cancel_deletion`` puts the prior restriction back exactly (or none); no deletion,
                              or the purge date passed, is ``NotScheduled`` (409, journaled).

Every settings op is masked to the fields it changes, so a banner write cannot clobber the switches and the other way round.
A failed commit raises ``NotApplied`` (503) and nothing changed, cache included; after a commit the server's own
settings cache is refreshed at once (the other instances follow within its 30 s TTL, AC-24). No action stops or
touches a job that was already accepted: they only write configuration (AC-26..AC-28). Form validation happens
before any of this (the request models), so a rejected form is never journaled (AC-10b).
"""
from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Callable, Optional, TypeVar

from app.firestore import IndexError_, server_timestamp
from app.quotas import KINDS, Quotas
from app.sources import SourceError

from .audit import COLLECTION as AUDIT_COLLECTION
from .audit import AuditEntry, NotApplied
from .directory import USERS, parse_time
from .models import BannerIn, DefaultLimitsIn, PersonalLimitIn, Settings, SwitchName
from .settings import PublicStatus

if TYPE_CHECKING:  # router.py imports this module
    from .router import AdminServices

ACCOUNTS = "adminAccounts"
LIMIT_NUMBERS = ("analyses", "vocals", "jobs")
T = TypeVar("T")


def _fresh(svc: "AdminServices") -> Settings:
    """The settings as stored right now (not the cache): the "before" of a change."""
    svc.settings.invalidate()
    return svc.settings.current()


def _published(svc: "AdminServices") -> Settings:
    """The settings after a commit: the server's cache is dropped so the next read (this one) sees the change."""
    svc.settings.invalidate()
    return svc.settings.current()


def set_default_limits(svc: "AdminServices", *, admin_uid: str, admin_email: str, limits: DefaultLimitsIn) -> Settings:
    before = _fresh(svc).limits
    writes = svc.settings.write_ops(limits=limits, updated_by=admin_uid)
    svc.audit.record_with(writes, AuditEntry(
        action="defaults_changed", admin_uid=admin_uid, admin_email=admin_email, setting="limits",
        before=before.model_dump(by_alias=True), after=limits.model_dump(by_alias=True),
    ))
    return _published(svc)


def set_switch(
    svc: "AdminServices", *, admin_uid: str, admin_email: str, name: SwitchName, value: bool
) -> Settings:
    before = getattr(_fresh(svc).switches, _attr(name))
    writes = [
        *svc.settings.write_ops(switches={name: value}, updated_by=admin_uid),
        *PublicStatus(svc.db).write_ops(switches={name: value}),
    ]
    svc.audit.record_with(writes, AuditEntry(
        action="switch_changed", admin_uid=admin_uid, admin_email=admin_email, setting=f"switches.{name}",
        before={name: before}, after={name: value},
    ))
    return _published(svc)


def set_banner(svc: "AdminServices", *, admin_uid: str, admin_email: str, banner: BannerIn) -> Settings:
    before = _fresh(svc).banner
    writes = PublicStatus(svc.db).write_ops(banner=banner)
    svc.audit.record_with(writes, AuditEntry(
        action="banner_changed", admin_uid=admin_uid, admin_email=admin_email, setting="banner",
        before=before.model_dump(), after=banner.model_dump(),
    ))
    return _published(svc)


def _attr(name: str) -> str:
    """``analysesPaused`` -> ``analyses_paused`` (the ``Switches`` model field)."""
    return "".join(f"_{c.lower()}" if c.isupper() else c for c in name)


# --------------------------------------------------------------------------- user actions: quota and personal limit


def reset_quota(svc: "AdminServices", quotas: Quotas, *, admin_uid: str, admin_email: str, uid: str) -> dict[str, int]:
    """Zero today's analyses and vocals counters of ``uid``; return the old values. The journal record (with both old
    values) is written under the quota lock before the counters change (ADR-0007)."""
    written: dict[str, Any] = {}

    def journal(old: dict[str, int]) -> None:
        entry = AuditEntry(
            action="quota_reset", admin_uid=admin_uid, admin_email=admin_email, target_uid=uid,
            before=old, after={k: 0 for k in KINDS},
        )
        written["ref"], written["entry"] = svc.audit.record_first(entry), entry   # NotApplied: nothing has changed

    try:
        return quotas.reset(uid, journal)
    except NotApplied:
        raise
    except Exception as exc:
        if "ref" in written:   # the record is there but the counters are not zeroed: say so in the journal
            svc.audit.mark_not_applied(written["ref"], written["entry"])
        raise NotApplied() from exc


class NotSet(SourceError):
    """No personal limit (or restriction) to remove (409 ``not_set``): nothing changed, so nothing is journaled."""

    def __init__(self, detail: str = "This user has no personal limit") -> None:
        super().__init__("not_set", detail, 409)


def _limit_view(stored: Any) -> Optional[dict[str, Any]]:
    """What the journal keeps of a stored personal limit: the three numbers (None = follows the default) and the end
    day. None when there is no limit."""
    if not isinstance(stored, dict):
        return None
    until = stored.get("until")
    return {**{name: stored.get(name) for name in LIMIT_NUMBERS}, "until": until if isinstance(until, str) else None}


def _account_path(uid: str) -> str:
    return f"{ACCOUNTS}/{uid}"


def _stored_limit(svc: "AdminServices", uid: str) -> Optional[dict[str, Any]]:
    """The personal limit as stored right now (the "before" of a change), as ``_limit_view``."""
    doc = svc.db.get(_account_path(uid))
    return _limit_view(doc.data.get("personalLimit")) if doc is not None else None


def set_personal_limit(
    svc: "AdminServices", *, admin_uid: str, admin_email: str, uid: str, limit: PersonalLimitIn, now: datetime
) -> None:
    """Replace the whole personal limit of ``uid`` (the numbers not given follow the default) and journal it in one
    commit. A failed commit raises ``NotApplied``; nothing changed."""
    stored: dict[str, Any] = {name: getattr(limit, name) for name in LIMIT_NUMBERS if getattr(limit, name) is not None}
    if limit.until is not None:
        stored["until"] = limit.until.isoformat()
    stored.update({"setAt": now, "byAdminUid": admin_uid})
    after = _limit_view(stored)
    before = _stored_limit(svc, uid)
    write = svc.db.update_op(
        _account_path(uid), {"personalLimit": stored}, mask=["personalLimit"], transforms=[server_timestamp("updatedAt")]
    )
    svc.audit.record_with([write], AuditEntry(
        action="limit_set", admin_uid=admin_uid, admin_email=admin_email, target_uid=uid, before=before, after=after,
    ))


def remove_personal_limit(svc: "AdminServices", *, admin_uid: str, admin_email: str, uid: str) -> None:
    """Remove the personal limit of ``uid`` and journal it in one commit; ``NotSet`` when there is none (nothing is
    written or journaled then)."""
    before = _stored_limit(svc, uid)
    if before is None:
        raise NotSet()
    write = svc.db.update_op(_account_path(uid), {}, mask=["personalLimit"], transforms=[server_timestamp("updatedAt")])
    svc.audit.record_with([write], AuditEntry(
        action="limit_removed", admin_uid=admin_uid, admin_email=admin_email, target_uid=uid, before=before, after=None,
    ))


# --------------------------------------------------------------------------- user actions: cloud restriction


class SelfTarget(SourceError):
    """An administrator cannot restrict (or delete) their own account (409 ``self_target``, AC-17)."""

    def __init__(self) -> None:
        super().__init__("self_target", "An admin can't restrict or delete their own account", 409)


class DeletionPending(SourceError):
    """The account is scheduled for deletion: its state changes only by cancelling it (409 ``deletion_pending``, AC-23b)."""

    def __init__(self) -> None:
        super().__init__("deletion_pending", "Cancel the scheduled deletion first", 409)


def _zulu(when: datetime) -> str:
    """A timestamp the way a stored one reads back (UTC, ``Z``)."""
    return when.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _restriction_view(stored: Any) -> Optional[dict[str, Any]]:
    """What the journal keeps of a stored restriction: the reason (admins only, redacted on purge) and the date."""
    if not isinstance(stored, dict):
        return None
    since = stored.get("since")
    return {"reason": stored.get("reason"), "since": _zulu(since) if isinstance(since, datetime) else since}


def _refused(
    svc: "AdminServices", action: str, refusal: Optional[SourceError], *, admin_uid: str, admin_email: str, uid: str
) -> None:
    """Answer a transaction that found a reason to refuse. ``NotSet`` just raises: nothing changed, nothing to
    journal. Any other refusal is journaled as a rejected attempt first (``refusal.code`` is its reason); if the
    record cannot be written ``NotApplied`` is raised instead: no record, no answer about the attempt."""
    if refusal is None:
        return
    if not isinstance(refusal, _UNJOURNALED):
        svc.audit.record_first(AuditEntry(
            action=action, admin_uid=admin_uid, admin_email=admin_email, target_uid=uid,
            outcome="rejected", reject_reason=refusal.code,
        ))
    raise refusal


def restrict_user(
    svc: "AdminServices", *, admin_uid: str, admin_email: str, uid: str, reason: str, now: datetime
) -> None:
    """Put a cloud restriction on ``uid`` (or replace its reason) and journal it in one transaction commit. Refusals
    are journaled as rejected attempts; a failed journal write or transaction raises ``NotApplied``, nothing changed."""
    who = {"admin_uid": admin_uid, "admin_email": admin_email, "uid": uid}
    stored = {"reason": reason, "since": now, "byAdminUid": admin_uid}

    def work(tx: Any) -> Optional[SourceError]:
        doc = tx.get(_account_path(uid))
        data = doc.data if doc is not None else {}
        if data.get("deletion"):
            return DeletionPending()
        write = svc.db.update_op(
            _account_path(uid), {"restriction": stored}, mask=["restriction"], transforms=[server_timestamp("updatedAt")]
        )
        svc.audit.record_with([write], AuditEntry(
            action="restrict", admin_uid=admin_uid, admin_email=admin_email, target_uid=uid,
            before=_restriction_view(data.get("restriction")), after=_restriction_view(stored),
        ), tx=tx)
        return None

    _refused(svc, "restrict", SelfTarget() if uid == admin_uid else _in_transaction(svc, work), **who)


def unrestrict_user(svc: "AdminServices", *, admin_uid: str, admin_email: str, uid: str) -> None:
    """Lift the cloud restriction of ``uid`` and journal it in one transaction commit. A scheduled deletion is
    refused and journaled; no restriction is ``NotSet`` and nothing is journaled."""
    def work(tx: Any) -> Optional[SourceError]:
        doc = tx.get(_account_path(uid))
        data = doc.data if doc is not None else {}
        if data.get("deletion"):
            return DeletionPending()
        before = _restriction_view(data.get("restriction"))
        if before is None:
            return NotSet("This user is not restricted")
        write = svc.db.update_op(_account_path(uid), {}, mask=["restriction"], transforms=[server_timestamp("updatedAt")])
        svc.audit.record_with([write], AuditEntry(
            action="unrestrict", admin_uid=admin_uid, admin_email=admin_email, target_uid=uid, before=before, after=None,
        ), tx=tx)
        return None

    _refused(svc, "unrestrict", _in_transaction(svc, work), admin_uid=admin_uid, admin_email=admin_email, uid=uid)


# --------------------------------------------------------------------------- user actions: scheduled deletion

DELETION_CAP = 10                            # scheduled deletions by ALL admins together ...
DELETION_CAP_WINDOW = timedelta(minutes=60)  # ... in any 60 minutes (AC-35)
DELETION_DELAY = timedelta(days=7)           # from scheduling to the purge (AC-20)
DELETION_REASON = "Scheduled deletion"       # the restriction a deletion sets (OQ-API-2): server text, never typed
_deletion_lock = threading.Lock()            # one server at most (SAD §11): the count and the commit are one step


class ConfirmEmailMismatch(SourceError):
    """The typed e-mail is not the user's (422 ``confirm_email_mismatch``, AC-21): an input error, not journaled."""

    def __init__(self) -> None:
        super().__init__("confirm_email_mismatch", "Type this user's email exactly to confirm", 422)


class DeletionRateLimit(SourceError):
    """Ten deletions are already scheduled in the last 60 minutes (429 ``deletion_rate_limit``, AC-35)."""

    def __init__(self) -> None:
        super().__init__(
            "deletion_rate_limit", "At most 10 deletions can be scheduled in any 60 minutes (all admins together)", 429
        )


class NotScheduled(SourceError):
    """No deletion to cancel, or its 7 days have passed (409 ``not_scheduled``)."""

    def __init__(self) -> None:
        super().__init__("not_scheduled", "No deletion to cancel, or the final deletion has already started", 409)


_UNJOURNALED = (NotSet, ConfirmEmailMismatch)   # nothing changed and nothing was attempted: no record


def emails_match(typed: Optional[str], actual: Optional[str]) -> bool:
    """The confirmation rule (AC-21): the typed address equals the user's, ignoring case and the spaces around it."""
    if not typed or not actual:
        return False
    return typed.strip().casefold() == actual.strip().casefold() != ""


def _user_email(svc: "AdminServices", uid: str) -> Optional[str]:
    doc = svc.db.get(f"{USERS}/{uid}")
    email = doc.data.get("email") if doc is not None else None
    return email if isinstance(email, str) and email else svc.directory.email_of(uid)


def _scheduled_since(svc: "AdminServices", since: datetime) -> int:
    """Deletions that were scheduled (journal: ``deletion_scheduled`` + ``applied``) after ``since``, by any admin.
    Rejected attempts and ``not_applied`` follow-ups are other outcomes, so they do not count."""
    return svc.db.count(AUDIT_COLLECTION, filters=[
        ("action", "==", "deletion_scheduled"), ("outcome", "==", "applied"), ("at", ">", since),
    ])


def _kept_restriction(stored: Any) -> Optional[dict[str, Any]]:
    """A stored restriction as it is written back: its date is a timestamp again (it reads as text)."""
    if not isinstance(stored, dict):
        return None
    return {**stored, "since": parse_time(stored.get("since")) or stored.get("since")}


def schedule_deletion(
    svc: "AdminServices", *, admin_uid: str, admin_email: str, uid: str, confirm_email: str, now: datetime
) -> None:
    """Schedule the purge of ``uid`` for ``now`` + 7 days and restrict the account at once (the restriction it had is kept
    inside the deletion), in one transaction commit with the journal record. Checks, in this order: own account, already
    scheduled, typed e-mail (not journaled), the cap of 10 per 60 minutes over all admins; the other refusals are journaled
    as rejected attempts. A failed journal write or transaction raises ``NotApplied``: nothing changed."""
    who = {"admin_uid": admin_uid, "admin_email": admin_email, "uid": uid}
    purge_after = now + DELETION_DELAY
    restriction = {"reason": DELETION_REASON, "since": now, "byAdminUid": admin_uid}

    def work(tx: Any) -> Optional[SourceError]:
        doc = tx.get(_account_path(uid))
        data = doc.data if doc is not None else {}
        if data.get("deletion"):
            return DeletionPending()
        if not emails_match(confirm_email, _user_email(svc, uid)):
            return ConfirmEmailMismatch()
        if _scheduled_since(svc, now - DELETION_CAP_WINDOW) >= DELETION_CAP:
            return DeletionRateLimit()
        prior = _kept_restriction(data.get("restriction"))
        deletion = {"scheduledAt": now, "purgeAfter": purge_after, "byAdminUid": admin_uid, "priorRestriction": prior}
        write = svc.db.update_op(
            _account_path(uid), {"restriction": restriction, "deletion": deletion}, mask=["restriction", "deletion"],
            transforms=[server_timestamp("updatedAt")],
        )
        svc.audit.record_with([write], AuditEntry(
            action="deletion_scheduled", admin_uid=admin_uid, admin_email=admin_email, target_uid=uid,
            before=_restriction_view(prior),
            after={**(_restriction_view(restriction) or {}), "purgeAfter": _zulu(purge_after)},
        ), tx=tx)
        return None

    if uid == admin_uid:
        _refused(svc, "deletion_scheduled", SelfTarget(), **who)
    with _deletion_lock:
        refusal = _in_transaction(svc, work)
    _refused(svc, "deletion_scheduled", refusal, **who)


def cancel_deletion(svc: "AdminServices", *, admin_uid: str, admin_email: str, uid: str, now: datetime) -> None:
    """Cancel the scheduled deletion of ``uid`` while its 7 days run: the restriction it had before comes back as it was
    (reason, date, admin), or none, with the journal record in one transaction commit. No deletion, or the purge date
    passed, is ``NotScheduled``, journaled as a rejected attempt."""
    def work(tx: Any) -> Optional[SourceError]:
        doc = tx.get(_account_path(uid))
        data = doc.data if doc is not None else {}
        deletion = data.get("deletion")
        if not isinstance(deletion, dict):
            return NotScheduled()
        purge_after = parse_time(deletion.get("purgeAfter"))
        if purge_after is not None and purge_after <= now:
            return NotScheduled()
        prior = _kept_restriction(deletion.get("priorRestriction"))
        write = svc.db.update_op(
            _account_path(uid), {"restriction": prior} if prior else {}, mask=["restriction", "deletion"],
            transforms=[server_timestamp("updatedAt")],
        )
        before = {**(_restriction_view(data.get("restriction")) or {}), "purgeAfter": deletion.get("purgeAfter")}
        svc.audit.record_with([write], AuditEntry(
            action="deletion_cancelled", admin_uid=admin_uid, admin_email=admin_email, target_uid=uid,
            before=before, after=_restriction_view(prior),
        ), tx=tx)
        return None

    _refused(svc, "deletion_cancelled", _in_transaction(svc, work), admin_uid=admin_uid, admin_email=admin_email, uid=uid)


def _in_transaction(svc: "AdminServices", work: Callable[[Any], T]) -> T:
    """Run ``work`` in a Firestore transaction. A database that cannot be reached (or keeps aborting) means nothing
    changed: ``NotApplied``."""
    try:
        return svc.db.run_transaction(work)
    except IndexError_ as exc:
        raise NotApplied() from exc

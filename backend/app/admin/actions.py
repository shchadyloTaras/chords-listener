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

Every settings op is masked to the fields it changes, so a banner write cannot clobber the switches and the other way round.
A failed commit raises ``NotApplied`` (503) and nothing changed, cache included; after a commit the server's own
settings cache is refreshed at once (the other instances follow within its 30 s TTL, AC-24). No action stops or
touches a job that was already accepted: they only write configuration (AC-26..AC-28). Form validation happens
before any of this (the request models), so a rejected form is never journaled (AC-10b).
"""
from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any, Optional

from app.firestore import server_timestamp
from app.quotas import KINDS, Quotas
from app.sources import SourceError

from .audit import AuditEntry, NotApplied
from .models import BannerIn, DefaultLimitsIn, PersonalLimitIn, Settings, SwitchName
from .settings import PublicStatus

if TYPE_CHECKING:  # router.py imports this module
    from .router import AdminServices

ACCOUNTS = "adminAccounts"
LIMIT_NUMBERS = ("analyses", "vocals", "jobs")


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
    """No personal limit to remove (409 ``not_set``)."""

    def __init__(self) -> None:
        super().__init__("not_set", "This user has no personal limit", 409)


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

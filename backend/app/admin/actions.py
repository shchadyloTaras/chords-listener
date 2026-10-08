"""The admin actions that change something (docs/features/admin; ADR-0005, ADR-0007).

Each action is one function that takes what the handler already resolved (the shared ``AdminServices``, who is
acting) and returns the resulting state. The route handlers in ``router.py`` only parse and authorize.

Service settings (AC-13b, AC-24..AC-30):

* ``set_default_limits``  - ``adminConfig/settings`` ``limits.*`` and its journal record in ONE commit.
* ``set_switch``          - ``adminConfig/settings`` ``switches.<name>``, the public mirror ``publicStatus/current``
                            ``switches.<name>`` and the journal record in ONE commit.
* ``set_banner``          - ``publicStatus/current`` ``banner.*`` and the journal record in ONE commit.

Every op is masked to the fields it changes, so a banner write cannot clobber the switches and the other way round.
A failed commit raises ``NotApplied`` (503) and nothing changed, cache included; after a commit the server's own
settings cache is refreshed at once (the other instances follow within its 30 s TTL, AC-24). No action stops or
touches a job that was already accepted: they only write configuration (AC-26..AC-28). Form validation happens
before any of this (the request models), so a rejected form is never journaled (AC-10b).
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from .audit import AuditEntry
from .models import BannerIn, DefaultLimitsIn, Settings, SwitchName
from .settings import PublicStatus

if TYPE_CHECKING:  # router.py imports this module
    from .router import AdminServices


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

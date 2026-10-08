"""Runtime settings: default limits, service switches and the maintenance banner (ADR-0005, data-model Aggregate 6).

Two documents hold them:

* ``adminConfig/settings``   server-only: ``limits``, ``switches``, ``updatedBy``, ``updatedAt``. The server reads it
                             through ``RuntimeSettings.current()``.
* ``publicStatus/current``   readable by everyone (the site reads it straight from Firestore, so a banner or a
                             switch never wakes the server): ``banner``, ``switches``, ``updatedAt`` and nothing else.

``RuntimeSettings.current()`` is a lazy cache. A value read is served from memory for ``CACHE_TTL_S`` seconds; the
first call after that re-reads both documents. Nothing polls in the background (the server may sleep, ADR-0005), so a
change made elsewhere is seen on the first call after the TTL, well inside the 60 s budget of AC-24. While
``adminConfig/settings`` does not exist the ``CHORDS_QUOTA_*`` / ``CHORDS_MAX_*`` env values are used, clamped to the
admin ranges the way the seed migration does; once the document exists the env values are no longer consulted. A
refresh that fails keeps serving the last values (and tries again after the next TTL); with nothing cached the
error propagates.

The writers only *build* batched-write ops (``update_op`` with an ``updateMask``); the caller commits them together
with the audit record (ADR-0007, T23) and then calls ``RuntimeSettings.invalidate()``. Every op masks just the
fields it changes (``limits.*``, one ``switches.<name>`` per changed switch, ``banner.*``), so a banner write never
clobbers the switches and a limits write never clobbers them either. The public document accepts only
``PUBLIC_FIELDS`` (SAD §11): ``PublicStatus.build_op`` raises ``ValueError`` for any other field or mask path.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Optional, Union, get_args

from pydantic import ValidationError

from app.admin.directory import parse_time
from app.admin.models import (
    ANALYSES_PER_DAY,
    CONCURRENT_JOBS,
    MAX_DURATION_MIN,
    MAX_UPLOAD_MB,
    VOCALS_PER_DAY,
    BannerIn,
    DefaultLimitsIn,
    Settings,
    SwitchName,
    Switches,
)
from app.firestore import Document, FirestoreIndex, field_path, server_timestamp
from app.models import Settings as EnvSettings

log = logging.getLogger("chords.admin.settings")

CACHE_TTL_S = 30.0
SETTINGS_PATH = "adminConfig/settings"
PUBLIC_STATUS_PATH = "publicStatus/current"

SWITCH_NAMES: tuple[str, ...] = get_args(SwitchName)
SWITCH_DEFAULTS: dict[str, bool] = {"analysesPaused": False, "youtubeEnabled": True, "vocalsEnabled": True}
LIMIT_FIELDS: tuple[str, ...] = ("analyses", "vocals", "jobs", "maxDurationMin", "maxUploadMb")
BANNER_FIELDS: frozenset[str] = frozenset({"enabled", "uk", "en"})

#: The only top-level fields of ``publicStatus/current`` (SAD §11): no limits, no uids, no emails.
PUBLIC_FIELDS: frozenset[str] = frozenset({"banner", "switches", "updatedAt"})

#: The banner before any was published: off, with short valid texts (openapi Banner: uk/en 1-250 characters even
#: while off). Migration 04 seeds it; a missing or invalid stored banner reads as it.
PLACEHOLDER_BANNER = BannerIn.model_validate(
    {"enabled": False, "uk": "Технічні роботи. Скоро повернемось.", "en": "Maintenance in progress. Back soon."}
)

_NEVER = datetime.fromtimestamp(0, timezone.utc)   # "updated at" of values that came from the env


def _clamp(value: float, bounds: tuple[int, int]) -> int:
    return max(bounds[0], min(bounds[1], int(round(value))))


def _env_limits(env: EnvSettings) -> DefaultLimitsIn:
    """The env defaults as admin limits; a value outside the admin ranges is clamped (the UI could not save it)."""
    return DefaultLimitsIn(
        analyses=_clamp(env.quota_analyses, ANALYSES_PER_DAY),
        vocals=_clamp(env.quota_vocals, VOCALS_PER_DAY),
        jobs=_clamp(env.max_user_jobs, CONCURRENT_JOBS),
        max_duration_min=_clamp(env.max_duration_min, MAX_DURATION_MIN),
        max_upload_mb=_clamp(env.max_upload_mb, MAX_UPLOAD_MB),
    )


def _checked_switches(changes: Mapping[str, Any]) -> dict[str, bool]:
    """``changes`` as a non-empty ``{switch name: bool}``; an unknown name or a non-boolean value is a ``ValueError``."""
    if not changes:
        raise ValueError("no switch to change")
    for name, value in changes.items():
        if name not in SWITCH_NAMES:
            raise ValueError(f"unknown switch {name!r}")
        if not isinstance(value, bool):
            raise ValueError(f"switch {name!r} must be true or false")
    return dict(changes)


def _stamp() -> list[dict[str, Any]]:
    return [server_timestamp("updatedAt")]


class RuntimeSettings:
    def __init__(
        self,
        db: FirestoreIndex,
        *,
        env: Callable[[], EnvSettings] = EnvSettings.from_env,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._db = db
        self._env = env
        self._monotonic = monotonic
        self._lock = threading.Lock()
        self._value: Optional[Settings] = None
        self._loaded_at = 0.0
        self.from_env = False   # True while the cached values came from the env (``adminConfig/settings`` absent)

    # ----------------------------------------------------------------------- read

    def current(self) -> Settings:
        """The settings in force: from memory while younger than ``CACHE_TTL_S``, else re-read (lazily, on this call)."""
        with self._lock:
            if self._value is None or self._monotonic() - self._loaded_at > CACHE_TTL_S:
                try:
                    self._value = self._load()
                except Exception:  # noqa: BLE001 - any failed read: keep the last values if there are some
                    if self._value is None:
                        raise
                    log.warning("settings refresh failed, serving the previous values", exc_info=True)
                self._loaded_at = self._monotonic()
            return self._value

    def invalidate(self) -> None:
        """Forget the cached values; the next ``current()`` re-reads (call it after committing a write)."""
        with self._lock:
            self._value = None

    def _load(self) -> Settings:
        doc = self._db.get(SETTINGS_PATH)
        public = self._db.get(PUBLIC_STATUS_PATH)
        data = doc.data if doc is not None else {}
        self.from_env = doc is None
        if doc is None:
            log.info("%s is absent: using the CHORDS_* env values", SETTINGS_PATH)
        return Settings(
            limits=self._limits(data.get("limits")) if doc is not None else _env_limits(self._env()),
            switches=self._switches(data.get("switches")),
            banner=self._banner(public),
            updated_at=parse_time(data.get("updatedAt")) or _NEVER,
            updated_by=data.get("updatedBy") if isinstance(data.get("updatedBy"), str) else None,
        )

    def _limits(self, stored: Any) -> DefaultLimitsIn:
        try:
            return DefaultLimitsIn.model_validate(stored)
        except ValidationError:
            log.warning("stored limits are not valid: using the CHORDS_* env values", exc_info=True)
            return _env_limits(self._env())

    @staticmethod
    def _switches(stored: Any) -> Switches:
        values = dict(SWITCH_DEFAULTS)
        if isinstance(stored, dict):
            values.update({k: v for k, v in stored.items() if k in SWITCH_DEFAULTS and isinstance(v, bool)})
        return Switches.model_validate(values)

    @staticmethod
    def _banner(public: Optional[Document]) -> BannerIn:
        """The banner of the public document. None, or one that does not validate (an empty text from an old seed, a
        hand edit), is ``PLACEHOLDER_BANNER``: off, and never a banner the contract would refuse."""
        stored = public.data.get("banner") if public is not None else None
        if isinstance(stored, dict):
            try:
                return BannerIn.model_validate(stored)
            except ValidationError:
                log.warning("stored banner is not valid: showing none", exc_info=True)
        return PLACEHOLDER_BANNER.model_copy()

    # ----------------------------------------------------------------------- write ops

    def write_ops(
        self,
        *,
        limits: Union[DefaultLimitsIn, Mapping[str, Any], None] = None,
        switches: Optional[Mapping[str, bool]] = None,
        updated_by: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Batched-write ops for ``adminConfig/settings``: new default ``limits`` (all five values) and / or changed
        ``switches`` (only the named ones). The mask holds just those fields plus ``updatedBy``; ``updatedAt`` is
        the server's commit time. Nothing is sent: compose with the audit op and ``commit``."""
        if limits is None and switches is None:
            raise ValueError("give limits or switches")
        data: dict[str, Any] = {}
        mask: list[str] = []
        if limits is not None:
            checked = limits if isinstance(limits, DefaultLimitsIn) else DefaultLimitsIn.model_validate(limits)
            data["limits"] = checked.model_dump(by_alias=True)
            mask += [field_path("limits", name) for name in LIMIT_FIELDS]
        if switches is not None:
            changes = _checked_switches(switches)
            data["switches"] = changes
            mask += [field_path("switches", name) for name in changes]
        data["updatedBy"] = updated_by
        mask.append("updatedBy")
        return [self._db.update_op(SETTINGS_PATH, data, mask=mask, transforms=_stamp())]


class PublicStatus:
    """Writer of the public mirror ``publicStatus/current`` (AC-27 switches, AC-29 banner)."""

    def __init__(self, db: FirestoreIndex) -> None:
        self._db = db

    def write_ops(
        self,
        *,
        banner: Union[BannerIn, Mapping[str, Any], None] = None,
        switches: Optional[Mapping[str, bool]] = None,
    ) -> list[dict[str, Any]]:
        """Batched-write ops for the public document: the ``banner`` and / or the named ``switches``, masked to
        exactly those fields, ``updatedAt`` stamped by the server. An invalid banner raises ``ValueError``."""
        if banner is None and switches is None:
            raise ValueError("give a banner or switches")
        data: dict[str, Any] = {}
        mask: list[str] = []
        if banner is not None:
            checked = banner if isinstance(banner, BannerIn) else BannerIn.model_validate(banner)
            data["banner"] = checked.model_dump()
            mask += [field_path("banner", name) for name in ("enabled", "uk", "en")]
        if switches is not None:
            changes = _checked_switches(switches)
            data["switches"] = changes
            mask += [field_path("switches", name) for name in changes]
        return [self.build_op(data, mask)]

    def build_op(self, data: Mapping[str, Any], mask: list[str]) -> dict[str, Any]:
        """The one place an op for the public document is made. Raises ``ValueError`` for any field in ``data`` or
        ``mask`` that is not ``banner`` (``enabled`` / ``uk`` / ``en``) or ``switches`` (a known name); ``updatedAt``
        is always stamped by the server, never written by the caller."""
        allowed = PUBLIC_FIELDS - {"updatedAt"}
        for key, value in data.items():
            if key not in allowed:
                raise ValueError(f"{key!r} is not a field of the public status document")
            if not isinstance(value, Mapping):
                raise ValueError(f"{key!r} must be a map")
            known = BANNER_FIELDS if key == "banner" else frozenset(SWITCH_NAMES)
            if set(value) - known:
                raise ValueError(f"{key}.{sorted(set(value) - known)[0]} is not a field of the public status document")
        for path in mask:
            top, _, rest = path.partition(".")
            if top not in allowed:
                raise ValueError(f"{path!r} is not a field of the public status document")
            known = BANNER_FIELDS if top == "banner" else frozenset(SWITCH_NAMES)
            if rest and rest not in known:
                raise ValueError(f"{path!r} is not a field of the public status document")
        return self._db.update_op(PUBLIC_STATUS_PATH, dict(data), mask=list(mask), transforms=_stamp())

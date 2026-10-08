"""Admin API schemas (camelCase JSON), derived from docs/features/admin/contracts/openapi.yaml.

Request models carry the validation ranges of spec §5 (AC-04, AC-09, AC-14, AC-25, AC-30); a value outside them
raises ``pydantic.ValidationError``, which the app maps to 422 ``invalid_value`` with per-field messages (the
stats period to ``invalid_period``). Response models mirror the contract field for field, so a route cannot leak
a field the contract does not name (metadata only, AC-06).
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Annotated, Any, Literal, Optional

from pydantic import ConfigDict, Field, StrictBool, StrictInt, StringConstraints, field_validator, model_validator

from app.models import CamelModel

# --------------------------------------------------------------------------- ranges (spec §5, data-model)

ANALYSES_PER_DAY = (1, 1000)
VOCALS_PER_DAY = (1, 150)
CONCURRENT_JOBS = (1, 4)
MAX_DURATION_MIN = (1, 120)
MAX_UPLOAD_MB = (1, 512)  # 0.5 GB, the storage limit today
MIN_SEARCH_CHARS = 3
MAX_EMAIL_CHARS = 254
MAX_PERIOD_DAYS = 90
BANNER_CHARS = (1, 250)
REASON_CHARS = (1, 500)
PAGE_SIZE = 50


def today_utc() -> date:
    """"Today" for the date rules (UTC). Module-level so tests can pin the clock."""
    return datetime.now(timezone.utc).date()


class InvalidPeriod(ValueError):
    """A statistics period over 90 days or ending before it starts (AC-09) - the route answers 422 ``invalid_period``."""


# --------------------------------------------------------------------------- scalars

Uid = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
UtcDay = Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$")]
Cursor = Annotated[str, StringConstraints(max_length=512)]
Email = Annotated[str, StringConstraints(max_length=MAX_EMAIL_CHARS)]
Count = Annotated[int, Field(ge=0)]

Origin = Literal["link", "file", "mic", "tab"]
SourceType = Literal["youtube", "other"]  # a job's source for the history filter: a YouTube video or anything else
JobKind = Literal["analysis", "vocals"]
HistoryStatus = Literal["running", "done", "error"]
FailureReason = Literal[
    "youtube_blocked", "download_failed", "unsupported_format", "too_long", "too_large", "analysis_failed", "other"
]
ReasonCounts = dict[FailureReason, Count]
AuditAction = Literal[
    "search",
    "view_card",
    "quota_reset",
    "limit_set",
    "limit_removed",
    "restrict",
    "unrestrict",
    "deletion_scheduled",
    "deletion_cancelled",
    "defaults_changed",
    "switch_changed",
    "banner_changed",
]
AuditOutcome = Literal["applied", "rejected", "not_applied"]
AccountStatus = Literal["normal", "restricted", "deletion_scheduled"]
SwitchName = Literal["analysesPaused", "youtubeEnabled", "vocalsEnabled"]

Analyses = Annotated[StrictInt, Field(ge=ANALYSES_PER_DAY[0], le=ANALYSES_PER_DAY[1])]
Vocals = Annotated[StrictInt, Field(ge=VOCALS_PER_DAY[0], le=VOCALS_PER_DAY[1])]
Jobs = Annotated[StrictInt, Field(ge=CONCURRENT_JOBS[0], le=CONCURRENT_JOBS[1])]
BannerText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=BANNER_CHARS[0], max_length=BANNER_CHARS[1])]


class Model(CamelModel):
    """Contract objects are closed (``additionalProperties: false``)."""

    model_config = ConfigDict(extra="forbid")


# --------------------------------------------------------------------------- requests


class UserSearchQuery(Model):
    """GET /api/admin/users?q= (AC-04): 3-254 characters once trimmed; shorter is never searched."""

    q: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=MIN_SEARCH_CHARS, max_length=MAX_EMAIL_CHARS)
    ]


class StatsPeriod(Model):
    """GET /api/admin/stats?from=&to= (AC-09): ``to`` not before ``from``, at most 90 days, both ends included."""

    from_: date = Field(alias="from")
    to: date

    @model_validator(mode="after")
    def _check_period(self) -> "StatsPeriod":
        if self.to < self.from_:
            raise InvalidPeriod("The period must end no earlier than it starts")
        if (self.to - self.from_).days + 1 > MAX_PERIOD_DAYS:
            raise InvalidPeriod(f"The period must not be longer than {MAX_PERIOD_DAYS} days")
        return self


class PersonalLimitIn(Model):
    """PUT /api/admin/users/{uid}/limit (AC-14). At least one whole number; ``until`` not before today (UTC)."""

    analyses: Optional[Analyses] = None
    vocals: Optional[Vocals] = None
    jobs: Optional[Jobs] = None
    until: Optional[date] = None  # last UTC day included; absent / null = no end date

    @field_validator("until")
    @classmethod
    def _until_not_in_the_past(cls, value: Optional[date]) -> Optional[date]:
        if value is not None and value < today_utc():
            raise ValueError("The end date must be today (UTC) or later")
        return value

    @model_validator(mode="after")
    def _at_least_one_number(self) -> "PersonalLimitIn":
        if self.analyses is None and self.vocals is None and self.jobs is None:
            raise ValueError("Set at least one of analyses, vocals, jobs")
        return self


class DefaultLimitsIn(Model):
    """PUT /api/admin/settings/limits (AC-25): all five values, each in range. Also the stored / returned shape."""

    analyses: Analyses
    vocals: Vocals
    jobs: Jobs
    max_duration_min: Annotated[StrictInt, Field(ge=MAX_DURATION_MIN[0], le=MAX_DURATION_MIN[1])]
    max_upload_mb: Annotated[StrictInt, Field(ge=MAX_UPLOAD_MB[0], le=MAX_UPLOAD_MB[1])]


class BannerIn(Model):
    """PUT /api/admin/settings/banner (AC-30): both texts 1-250 characters, plain text. Also the stored shape."""

    enabled: StrictBool
    uk: BannerText
    en: BannerText


class RestrictionIn(Model):
    """PUT /api/admin/users/{uid}/restriction: why (1-500 characters, admin-only)."""

    reason: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=REASON_CHARS[0], max_length=REASON_CHARS[1])
    ]


class DeletionIn(Model):
    """POST /api/admin/users/{uid}/deletion: the account's e-mail typed again (compared case-insensitively later)."""

    confirm_email: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_EMAIL_CHARS)
    ]


class SwitchChange(Model):
    """PUT /api/admin/settings/switches/{name}."""

    value: StrictBool


# --------------------------------------------------------------------------- shared shapes


class OriginCounts(Model):
    link: Count
    file: Count
    mic: Count
    tab: Count


class QuotaUsage(Model):
    used: Count
    limit: Annotated[int, Field(ge=1)]


class UserQuotas(Model):
    """Same shape as ``quotas`` in GET /api/me; ``limit`` is the effective limit (personal over default)."""

    day: UtcDay
    analyses: QuotaUsage
    vocals: QuotaUsage
    jobs: QuotaUsage


class Switches(Model):
    analyses_paused: bool
    youtube_enabled: bool
    vocals_enabled: bool


DefaultLimits = DefaultLimitsIn
Banner = BannerIn


# --------------------------------------------------------------------------- overview


class RunningJob(Model):
    id: str
    uid: Uid
    email: Optional[Email]
    service: bool
    kind: JobKind
    origin: Origin
    accepted_at: datetime


class Overview(Model):
    day: UtcDay
    analyses: OriginCounts
    vocals: Count
    failed: Count
    failed_by_reason: ReasonCounts
    active: Count
    new_users: Count
    running_jobs: list[RunningJob]
    switches: Switches


# --------------------------------------------------------------------------- users


class UserSearchItem(Model):
    uid: Uid
    email: Email
    service: bool


class UserSearchResult(Model):
    query: Annotated[str, StringConstraints(min_length=MIN_SEARCH_CHARS, max_length=MAX_EMAIL_CHARS)]
    items: Annotated[list[UserSearchItem], Field(max_length=PAGE_SIZE)]
    truncated: bool  # more than 50 matches - refine the query


class Restriction(Model):
    reason: Annotated[str, StringConstraints(min_length=REASON_CHARS[0], max_length=REASON_CHARS[1])]  # admin-only
    since: datetime
    by_admin_uid: Uid


class Deletion(Model):
    scheduled_at: datetime
    purge_after: datetime  # scheduled_at + 7 days
    by_admin_uid: Uid


class PersonalLimit(Model):
    analyses: Optional[Analyses]  # null -> follows the default
    vocals: Optional[Vocals]
    jobs: Optional[Jobs]
    until: Optional[date]  # last UTC day included; null = no end date
    set_at: datetime
    by_admin_uid: Uid
    expired: bool  # until < today (UTC): the card shows "завершився" (AC-15)


class AccountState(Model):
    uid: Uid
    status: AccountStatus
    restriction: Optional[Restriction]
    deletion: Optional[Deletion]
    personal_limit: Optional[PersonalLimit]
    quota: UserQuotas


class UserProfile(Model):
    uid: Uid
    email: Email
    created_at: datetime
    last_login_at: Optional[datetime]
    service: bool
    track_count: Count
    storage_bytes: Count


# --------------------------------------------------------------------------- tracks (metadata only)


class TrackMeta(Model):
    """Metadata only - never audio, chords, edits, notes or media URLs (AC-06)."""

    id: str
    title: Annotated[str, StringConstraints(max_length=300)]  # user text: plain text only (AC-05)
    source_type: Literal["youtube", "url", "file"]
    created_at: datetime
    duration: Annotated[float, Field(ge=0)]
    edited: bool
    vocals: bool
    size_bytes: Optional[Count]  # null until the backfill reaches the track


class TrackMetaPage(Model):
    items: Annotated[list[TrackMeta], Field(max_length=PAGE_SIZE)]
    has_next: bool
    has_prev: bool
    next_cursor: Optional[Cursor]


# --------------------------------------------------------------------------- job history


class JobHistoryItem(Model):
    id: str
    uid: Uid
    email: Optional[Email]  # null when the user was purged
    user_deleted: bool
    service: bool
    kind: JobKind
    origin: Origin
    source_type: SourceType  # records from before the field read as "other"
    status: HistoryStatus
    reason: Optional[FailureReason]  # set iff status == error
    error_text: Optional[Annotated[str, StringConstraints(max_length=200)]]
    title: Optional[Annotated[str, StringConstraints(max_length=300)]]
    accepted_at: datetime
    finished_at: Optional[datetime]


class JobHistoryPage(Model):
    items: Annotated[list[JobHistoryItem], Field(max_length=PAGE_SIZE)]
    has_next: bool
    has_prev: bool
    next_cursor: Optional[Cursor]
    counts_by_reason: ReasonCounts


class UserCard(Model):
    profile: UserProfile
    account: AccountState
    recent_jobs: Annotated[list[JobHistoryItem], Field(max_length=20)]
    tracks: TrackMetaPage


# --------------------------------------------------------------------------- stats


class RestoredTracks(Model):
    youtube: Count
    url: Count
    file: Count


class StatsDay(Model):
    day: UtcDay
    state: Literal["live", "frozen", "restored"]
    analyses: OriginCounts
    vocals: Count
    failed: Count
    failed_by_reason: ReasonCounts
    active: Count
    new_users: Optional[Count]  # null on restored days
    restored_tracks: Optional[RestoredTracks]
    frozen_at: Optional[datetime]


class StatsRange(Model):
    from_: UtcDay = Field(alias="from")
    to: UtcDay
    days: Annotated[list[StatsDay], Field(max_length=MAX_PERIOD_DAYS)]


# --------------------------------------------------------------------------- audit


class AuditEntry(Model):
    id: str
    at: datetime
    admin_uid: Uid
    admin_email: Email
    action: AuditAction
    outcome: AuditOutcome
    target_uid: Optional[Uid]
    target_email: Optional[Email]  # null when purged
    target_deleted: bool
    setting: Optional[str]  # limits | switches.<name> | banner
    before: Optional[dict[str, Any]]
    after: Optional[dict[str, Any]]
    reject_reason: Optional[str]  # set iff outcome == rejected: the refusal ErrorCode
    query: Optional[Email]  # the search string (action == search); null after purge redaction
    ref_id: Optional[str]  # for not_applied: the record it completes
    redacted_at: Optional[datetime]


class AuditPage(Model):
    items: Annotated[list[AuditEntry], Field(max_length=PAGE_SIZE)]
    has_next: bool
    has_prev: bool
    next_cursor: Optional[Cursor]


# --------------------------------------------------------------------------- settings / internal


class Settings(Model):
    limits: DefaultLimits
    switches: Switches
    banner: Banner
    updated_at: datetime
    updated_by: Optional[Uid]


class SweepRun(Model):
    slot: Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}Z|-wake)$")]
    state: Literal["running", "done", "failed"]
    steps: dict[str, Literal["done"]]
    started_at: datetime
    finished_at: Optional[datetime]

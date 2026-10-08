"""API schemas (camelCase JSON, mirrors frontend/src/types.ts) and runtime settings."""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

PROJECT_ROOT = Path(__file__).resolve().parents[2]

JobStatus = Literal["queued", "downloading", "decoding", "analyzing", "done", "error"]
ErrorCode = Literal[
    "invalid_url",
    "download_failed",
    "unsupported_format",
    "too_long",
    "too_large",
    "analysis_failed",
    "not_found",
    "internal",
    # cloud (docs/CLOUD.md)
    "unauthorized",  # missing/invalid Firebase ID token or media signature (401)
    "quota_exceeded",  # per-user daily limit or concurrent-job limit (429)
    "download_blocked",  # YouTube refused the server (bot check / sign-in wall / 403)
    "unavailable",  # feature not installed / not enabled on this server (501)
    "cancelled",  # the user cancelled the job (POST /api/jobs/{id}/cancel)
    # admin, admission gate (docs/features/admin)
    "cloud_restricted",  # the account is restricted by an administrator (403)
    "analyses_paused",  # new analyses are paused for everyone (503)
    "youtube_disabled",  # link analyses are switched off (503)
    "vocals_disabled",  # vocal transcription is switched off (503)
    # admin, /api/admin/*
    "query_too_short",  # user search text shorter than 3 characters (422)
    "invalid_period",  # statistics period ends before it starts or is over 90 days (422)
    "invalid_value",  # a form field is out of range; per-field messages in `details.fields` (422)
    "confirm_email_mismatch",  # the typed e-mail does not match the account being deleted (422)
    "reauth_required",  # the admin's sign-in is too old for a destructive action (401)
    "self_target",  # an administrator cannot restrict or delete their own account (409)
    "deletion_pending",  # the account is already scheduled for deletion (409)
    "not_scheduled",  # no deletion is scheduled to cancel (409)
    "not_set",  # no personal limit / restriction is set to remove (409)
    "deletion_rate_limit",  # too many deletions scheduled in a row (429)
    "not_applied",  # the change or its journal record could not be written; nothing changed (503)
    "audit_unavailable",  # the view could not be journaled, so no data is returned (503)
]
SourceType = Literal["youtube", "url", "file"]


# --------------------------------------------------------------------------- settings


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def _env_switch(name: str, default: bool) -> bool:
    """An on/off switch: unset or empty -> ``default``; ``0`` / ``false`` / ``off`` (any case) -> off; else on."""
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw not in ("0", "false", "off")


AuthMode = Literal["off", "firebase"]


def _env_auth() -> AuthMode:
    """CHORDS_AUTH: "off" (default, local single-user) or "firebase" (cloud). Anything else is an error,
    so a typo can't silently turn authentication off."""
    raw = os.environ.get("CHORDS_AUTH", "").strip().lower()
    if raw in ("", "off", "none", "local"):
        return "off"
    if raw == "firebase":
        return "firebase"
    raise ValueError(f"CHORDS_AUTH must be 'off' or 'firebase', not {raw!r}")


# Cloud mode answers on the Cloud Run host (and local names, for testing the cloud mode locally).
CLOUD_ALLOWED_HOSTS: tuple[str, ...] = ("*.run.app", "localhost", "127.0.0.1", "::1")

DEFAULT_ALLOWED_ORIGINS: tuple[str, ...] = (
    "https://shchadylotaras.github.io",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)


def normalize_origin(value: str) -> str:
    """``HTTPS://Example.com:443/`` -> ``https://example.com`` (scheme://host[:port], lowercase, default port dropped)."""
    value = value.strip().rstrip("/").lower()
    scheme, sep, rest = value.partition("://")
    if not sep:
        return value
    host = rest.split("/", 1)[0]
    if (scheme == "https" and host.endswith(":443")) or (scheme == "http" and host.endswith(":80")):
        host = host.rsplit(":", 1)[0]
    return f"{scheme}://{host}"


def _env_origins(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return tuple(dict.fromkeys(normalize_origin(o) for o in raw.split(",") if o.strip() and o.strip() != "*"))


@dataclass(frozen=True)
class Settings:
    """Runtime configuration. ``Settings.from_env()`` reads the ``CHORDS_*`` variables."""

    data_dir: Path = PROJECT_ROOT / "data"
    frontend_dist: Path = PROJECT_ROOT / "frontend" / "dist"
    max_duration_min: float = 30.0
    max_upload_mb: float = 500.0
    max_workers: int = 2
    max_finished_jobs: int = 50
    # Hosts (Host header) the API answers to; protects against DNS rebinding. "*" disables the check.
    allowed_hosts: tuple[str, ...] = ("localhost", "127.0.0.1", "::1", "*.localhost")
    # Web pages on other origins that may use this server (CORS + the cross-site check), e.g. the
    # GitHub Pages build. Pages on a local host (any port) are always allowed. CHORDS_ALLOWED_ORIGINS
    # (comma-separated) replaces this list.
    allowed_origins: tuple[str, ...] = DEFAULT_ALLOWED_ORIGINS
    # Live-piano notes uploaded by the UI (PUT /api/tracks/{id}/notes)
    max_notes: int = 300_000
    max_notes_mb: float = 25.0
    # ---- cloud mode (docs/CLOUD.md); the defaults keep the local single-user behaviour
    auth: AuthMode = "off"  # CHORDS_AUTH
    firebase_project: str = "build-chords-listener"  # CHORDS_FIREBASE_PROJECT
    signing_key: str = field(default="", repr=False)  # CHORDS_SIGNING_KEY (media URL signatures)
    smoke_key: str = field(default="", repr=False)  # CHORDS_SMOKE_KEY (X-Smoke-Key -> uid "smoke-test")
    upload_bucket: str = ""  # CHORDS_UPLOAD_BUCKET (client uploads for POST /api/jobs/storage)
    publish: bool = True  # CHORDS_PUBLISH (cloud): publish track changes to Firestore + Storage; 0|false|off disables
    scratch_dir: Optional[Path] = None  # CHORDS_WORK_DIR: job scratch space (default <data>/.work)
    quota_analyses: int = 40  # CHORDS_QUOTA_ANALYSES: analyses per user per UTC day
    quota_vocals: int = 15  # CHORDS_QUOTA_VOCALS: vocal transcriptions per user per UTC day
    max_user_jobs: int = 2  # CHORDS_QUOTA_JOBS: running jobs per user
    max_request_mb: float = 30.0  # CHORDS_MAX_REQUEST_MB: multipart upload cap (Cloud Run: 32 MiB/request)
    media_url_ttl_s: int = 12 * 3600

    @property
    def cloud(self) -> bool:
        return self.auth == "firebase"

    @property
    def users_dir(self) -> Path:
        return self.data_dir / "users"

    @property
    def max_request_bytes(self) -> int:
        return int(self.max_request_mb * 1024 * 1024)

    @property
    def max_duration_s(self) -> float:
        return self.max_duration_min * 60.0

    @property
    def max_upload_bytes(self) -> int:
        return int(self.max_upload_mb * 1024 * 1024)

    @property
    def max_notes_bytes(self) -> int:
        return int(self.max_notes_mb * 1024 * 1024)

    @property
    def tracks_dir(self) -> Path:
        return self.data_dir / "tracks"

    @property
    def work_dir(self) -> Path:
        return self.scratch_dir or self.data_dir / ".work"

    @classmethod
    def from_env(cls) -> Settings:
        data_dir = os.environ.get("CHORDS_DATA_DIR", "").strip()
        hosts = os.environ.get("CHORDS_ALLOWED_HOSTS", "").strip()
        host_list = tuple(h.strip() for h in hosts.split(",") if h.strip())
        scratch = os.environ.get("CHORDS_WORK_DIR", "").strip()
        defaults = cls()
        auth = _env_auth()
        cloud = auth == "firebase"
        if cloud:  # cloud: the env lists are added to the defaults (docs/CLOUD.md → CORS / hosts)
            allowed_hosts = tuple(dict.fromkeys(CLOUD_ALLOWED_HOSTS + host_list))
            allowed_origins = tuple(
                dict.fromkeys(defaults.allowed_origins + _env_origins("CHORDS_ALLOWED_ORIGINS", ()))
            )
        else:
            allowed_hosts = host_list or defaults.allowed_hosts
            allowed_origins = _env_origins("CHORDS_ALLOWED_ORIGINS", defaults.allowed_origins)
        return cls(
            data_dir=Path(data_dir).expanduser().resolve() if data_dir else defaults.data_dir,
            frontend_dist=Path(os.environ["CHORDS_FRONTEND_DIST"]).expanduser().resolve()
            if os.environ.get("CHORDS_FRONTEND_DIST")
            else defaults.frontend_dist,
            max_duration_min=_env_float("CHORDS_MAX_DURATION_MIN", defaults.max_duration_min),
            max_upload_mb=_env_float("CHORDS_MAX_UPLOAD_MB", defaults.max_upload_mb),
            max_workers=max(1, _env_int("CHORDS_MAX_WORKERS", defaults.max_workers)),
            max_finished_jobs=500 if cloud else defaults.max_finished_jobs,
            allowed_hosts=allowed_hosts,
            allowed_origins=allowed_origins,
            auth=auth,
            firebase_project=os.environ.get("CHORDS_FIREBASE_PROJECT", "").strip() or defaults.firebase_project,
            signing_key=os.environ.get("CHORDS_SIGNING_KEY", "").strip(),
            smoke_key=os.environ.get("CHORDS_SMOKE_KEY", "").strip(),
            upload_bucket=os.environ.get("CHORDS_UPLOAD_BUCKET", "").strip(),
            publish=_env_switch("CHORDS_PUBLISH", defaults.publish),
            scratch_dir=Path(scratch).expanduser().resolve() if scratch else None,
            quota_analyses=max(0, _env_int("CHORDS_QUOTA_ANALYSES", defaults.quota_analyses)),
            quota_vocals=max(0, _env_int("CHORDS_QUOTA_VOCALS", defaults.quota_vocals)),
            max_user_jobs=max(1, _env_int("CHORDS_QUOTA_JOBS", defaults.max_user_jobs)),
            max_request_mb=_env_float("CHORDS_MAX_REQUEST_MB", defaults.max_request_mb),
        )


# --------------------------------------------------------------------------- API models


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, serialize_by_alias=True)


class TrackSource(CamelModel):
    type: SourceType
    url: Optional[str] = None
    video_id: Optional[str] = None
    filename: Optional[str] = None


class KeyInfo(CamelModel):
    tonic: str
    mode: Literal["major", "minor"]
    name: str
    confidence: float = 0.0


def _finite(value: float, default: float = 0.0) -> float:
    return value if math.isfinite(value) else default


class ChordSegment(CamelModel):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    label: str = Field(min_length=1, max_length=32)
    root: Optional[str] = Field(default=None, max_length=8)
    quality: Optional[str] = Field(default=None, max_length=16)
    bass: Optional[str] = Field(default=None, max_length=8)
    confidence: float = 1.0

    @field_validator("start", "end", "confidence")
    @classmethod
    def _must_be_finite(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("must be a finite number")
        return v

    @field_validator("label")
    @classmethod
    def _strip_label(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("label must not be empty")
        return v

    @model_validator(mode="after")
    def _ordered(self) -> ChordSegment:
        if self.end < self.start:
            raise ValueError("end must be >= start")
        self.confidence = min(1.0, max(0.0, self.confidence))
        return self


class TrackSummary(CamelModel):
    id: str
    title: str
    artist: Optional[str] = None
    duration: float
    thumbnail: Optional[str] = None
    source: TrackSource
    key: Optional[KeyInfo] = None
    tempo: Optional[float] = None
    chord_count: Optional[int] = None
    edited: bool = False
    # vocal melody transcribed (GET /api/tracks/{id}/vocals) and its separated stems
    # (GET /api/tracks/{id}/stems/{name}; names: "vocals", "instruments")
    vocals: bool = False
    stems: list[str] = Field(default_factory=list)
    created_at: str


class Track(TrackSummary):
    audio_url: str
    time_signature: int = 4
    beats: list[float] = Field(default_factory=list)
    downbeats: list[float] = Field(default_factory=list)
    chords: list[ChordSegment] = Field(default_factory=list)
    waveform: list[float] = Field(default_factory=list)
    engine: str = ""
    # Set for recordings linked to a video (POST /api/jobs/storage with startOffset): every time above is
    # in video time; the audio file starts at this video time (audio time = track time - startOffset).
    start_offset: Optional[float] = None
    # playable URLs of the stems listed in ``stems`` (signed like ``audioUrl`` in cloud mode)
    stem_urls: dict[str, str] = Field(default_factory=dict)


class EngineInfo(CamelModel):
    name: str
    version: str
    features: dict[str, bool] = Field(default_factory=dict)


class Health(CamelModel):
    ok: bool
    engine: EngineInfo
    ytdlp: Optional[str] = None
    ffmpeg: bool


class Job(CamelModel):
    id: str
    kind: Literal["analysis", "vocals"] = "analysis"
    status: JobStatus
    progress: float
    message: str
    error: Optional[str] = None
    error_code: Optional[ErrorCode] = None
    track_id: Optional[str] = None
    title: Optional[str] = None
    thumbnail: Optional[str] = None
    source: Optional[TrackSource] = None
    created_at: str


class ApiError(BaseModel):
    detail: str
    code: ErrorCode


# --------------------------------------------------------------------------- request bodies


class AnalysisOptions(BaseModel):
    """Options forwarded to the engine. Unknown keys are kept (the engine ignores what it doesn't know)."""

    model_config = ConfigDict(extra="allow")

    separate: Optional[bool] = None

    def to_engine(self) -> dict[str, Any]:
        return {k: v for k, v in self.model_dump().items() if v is not None}


class CreateJobRequest(CamelModel):
    url: str = Field(min_length=1, max_length=4096)
    options: Optional[AnalysisOptions] = None


class ReanalyzeRequest(CamelModel):
    options: Optional[AnalysisOptions] = None


class StorageSource(CamelModel):
    """What a cloud upload is: a plain file, or a recording of a YouTube video (tab capture)."""

    type: Literal["youtube", "file"]
    video_id: Optional[str] = Field(default=None, pattern=r"^[A-Za-z0-9_-]{11}$")
    url: Optional[str] = Field(default=None, max_length=4096)
    filename: Optional[str] = Field(default=None, max_length=255)


class StorageJobRequest(CamelModel):
    """POST /api/jobs/storage: ingest ``users/<uid>/uploads/...`` from the upload bucket (cloud mode)."""

    path: str = Field(min_length=1, max_length=1024)
    title: Optional[str] = Field(default=None, max_length=300)
    source: Optional[StorageSource] = None
    start_offset: Optional[float] = Field(default=None, ge=0, le=24 * 3600)
    options: Optional[AnalysisOptions] = None


class QuotaUsage(CamelModel):
    used: int
    limit: int


class UserQuotas(CamelModel):
    day: str
    analyses: QuotaUsage
    vocals: QuotaUsage
    jobs: QuotaUsage


class UserInfo(CamelModel):
    """GET /api/me: who the server thinks the caller is, and their limits (cloud mode)."""

    uid: Optional[str] = None
    cloud: bool = False
    quotas: Optional[UserQuotas] = None


class TrackPatch(CamelModel):
    title: Optional[str] = Field(default=None, max_length=300)
    artist: Optional[str] = Field(default=None, max_length=300)
    chords: Optional[list[ChordSegment]] = Field(default=None, max_length=50_000)


# --------------------------------------------------------------------------- live piano notes

NOTES_VERSION = 1
NOTES_MIDI_MIN = 21
NOTES_MIDI_MAX = 108
NoteRow = tuple[float, float, int, float]


class TrackNotes(BaseModel):
    """Notes transcribed from a track's audio in the browser (live piano), stored as notes.json.

    ``notes`` rows are ``[start s, end s, MIDI 21..108, velocity 0..1]``; on save they are rounded
    (ms / 0.001) and sorted by start. Bounds against the track duration are checked by the endpoint.
    """

    model_config = ConfigDict(extra="ignore")

    version: Literal[1]
    engine: str = Field(min_length=1, max_length=200)
    notes: list[NoteRow]

    @model_validator(mode="after")
    def _valid_rows(self) -> TrackNotes:
        rows: list[NoteRow] = []
        for i, (start, end, midi, velocity) in enumerate(self.notes):
            if not (math.isfinite(start) and math.isfinite(end) and math.isfinite(velocity)):
                raise ValueError(f"notes[{i}]: values must be finite numbers")
            if not 0 <= start < end:
                raise ValueError(f"notes[{i}]: need 0 <= start < end")
            if not NOTES_MIDI_MIN <= midi <= NOTES_MIDI_MAX:
                raise ValueError(f"notes[{i}]: pitch must be {NOTES_MIDI_MIN}..{NOTES_MIDI_MAX}")
            if not 0 <= velocity <= 1:
                raise ValueError(f"notes[{i}]: velocity must be 0..1")
            r_start, r_end = round(start, 3), round(end, 3)
            rows.append((r_start, max(r_end, round(r_start + 0.001, 3)), midi, round(velocity, 3)))
        rows.sort(key=lambda r: (r[0], r[2]))
        self.notes = rows
        return self

    def latest_end(self) -> float:
        return max((r[1] for r in self.notes), default=0.0)


# --------------------------------------------------------------------------- vocal melody (optional extra)

VOCALS_VERSION = 1


class VocalsRequest(CamelModel):
    """POST /api/tracks/{id}/vocals: ``force`` recomputes even when the vocals are already there."""

    force: bool = False


class VocalContour(CamelModel):
    start: float
    hop: float
    midi: list[Optional[float]]


class VocalRange(CamelModel):
    low: int
    high: int


class VocalNotes(CamelModel):
    """The sung melody (vocals.json): ``notes`` rows are ``[start s, end s, MIDI, velocity 0..1]`` (MIDI after
    removing the singer's global tuning offset ``tuningCents``); ``contour`` is the raw f0 (fractional
    MIDI, not tuning-corrected; null = unvoiced) for drawing. Times are track times."""

    version: Literal[1] = VOCALS_VERSION
    engine: str = Field(min_length=1, max_length=200)
    tuning_cents: float = 0.0
    notes: list[NoteRow] = Field(default_factory=list)
    contour: Optional[VocalContour] = None
    range: Optional[VocalRange] = None

    @classmethod
    def from_pipeline(cls, raw: Any, offset: float = 0.0) -> VocalNotes:
        """Validate the pipeline's result leniently (bad rows dropped, values clamped) and move it into
        track time (``offset`` = the track's startOffset for recordings linked to a video)."""
        data = to_builtin(raw)
        if not isinstance(data, dict):
            raise ValueError("the vocal pipeline returned a non-object result")
        offset = float(offset) if isinstance(offset, (int, float)) and math.isfinite(offset) and offset > 0 else 0.0
        rows: list[NoteRow] = []
        for row in data.get("notes") or []:
            try:
                start, end, midi, velocity = (float(row[0]), float(row[1]), int(row[2]), float(row[3]))
            except (TypeError, ValueError, IndexError):
                continue
            if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end):
                continue
            if not NOTES_MIDI_MIN <= midi <= NOTES_MIDI_MAX:
                continue
            velocity = min(1.0, max(0.0, velocity)) if math.isfinite(velocity) else 0.5
            rows.append((round(start + offset, 3), round(end + offset, 3), midi, round(velocity, 3)))
        rows.sort(key=lambda r: (r[0], r[2]))
        data["notes"] = rows
        contour = data.get("contour")
        if isinstance(contour, dict) and isinstance(contour.get("start"), (int, float)):
            contour["start"] = round(float(contour["start"]) + offset, 3)
        else:
            data["contour"] = None
        if rows:
            data["range"] = {"low": min(r[2] for r in rows), "high": max(r[2] for r in rows)}
        else:
            data["range"] = None
        tuning = data.get("tuningCents")
        data["tuningCents"] = round(float(tuning), 1) if isinstance(tuning, (int, float)) and math.isfinite(tuning) else 0.0
        return cls.model_validate(data)


# --------------------------------------------------------------------------- engine output


class AnalysisResult(CamelModel):
    """Validated/normalized engine output, persisted as analysis.json."""

    duration: float = Field(ge=0)
    tempo: Optional[float] = None
    time_signature: int = 4
    beats: list[float] = Field(default_factory=list)
    downbeats: list[float] = Field(default_factory=list)
    chords: list[ChordSegment] = Field(default_factory=list)
    key: Optional[KeyInfo] = None
    waveform: list[float] = Field(default_factory=list)
    engine: str = ""

    @field_validator("tempo")
    @classmethod
    def _tempo(cls, v: Optional[float]) -> Optional[float]:
        return v if v is not None and math.isfinite(v) and v > 0 else None

    @field_validator("time_signature")
    @classmethod
    def _ts(cls, v: int) -> int:
        return v if 1 <= v <= 16 else 4

    @field_validator("beats", "downbeats")
    @classmethod
    def _times(cls, v: list[float]) -> list[float]:
        return sorted(round(t, 4) for t in v if math.isfinite(t) and t >= 0)

    @field_validator("waveform")
    @classmethod
    def _peaks(cls, v: list[float]) -> list[float]:
        return [round(min(1.0, max(0.0, _finite(x))), 4) for x in v]

    @classmethod
    def from_engine(cls, raw: Any) -> AnalysisResult:
        """Validate engine output leniently: numpy values are converted, bad chord rows and an invalid
        key are dropped, chords are sorted and clamped to the duration. Raises ValueError if unusable."""
        data = to_builtin(raw)
        if not isinstance(data, dict):
            raise ValueError("engine returned a non-object result")
        key = data.get("key")
        if key is not None:
            try:
                data["key"] = KeyInfo.model_validate(key).model_dump()
            except ValueError:
                data["key"] = None
        duration = data.get("duration")
        if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 0:
            raise ValueError("engine returned no valid duration")
        chords: list[ChordSegment] = []
        for row in data.get("chords") or []:
            try:
                seg = ChordSegment.model_validate(row)
            except ValueError:
                continue
            seg.start = round(min(seg.start, duration), 4)
            seg.end = round(min(seg.end, duration), 4)
            if seg.end > seg.start:
                chords.append(seg)
        chords.sort(key=lambda c: c.start)
        data["chords"] = [c.model_dump() for c in chords]
        for name in ("beats", "downbeats", "waveform"):
            values = data.get(name)
            data[name] = [v for v in values if isinstance(v, (int, float))] if isinstance(values, list) else []
        if not isinstance(data.get("engine"), str):
            data["engine"] = str(data.get("engine") or "")
        return cls.model_validate(data)

    def shifted(self, offset: float) -> AnalysisResult:
        """The same analysis in the time base of a video whose recording started at ``offset`` seconds:
        every time moves by ``offset``, an "N" chord covers 0..offset (chords stay contiguous from 0) and
        the waveform is padded with silence so it still spans 0..duration."""
        if not (offset and math.isfinite(offset) and offset > 0):
            return self
        offset = round(offset, 4)

        def move(t: float) -> float:
            return round(t + offset, 4)

        chords = [c.model_copy(update={"start": move(c.start), "end": move(c.end)}) for c in self.chords]
        if chords and chords[0].label == "N":  # the recording starts silent: extend that segment back to 0
            chords[0] = chords[0].model_copy(update={"start": 0.0})
        elif chords and chords[0].start > 0:
            chords.insert(
                0,
                ChordSegment(start=0.0, end=chords[0].start, label="N", root=None, quality=None, bass=None, confidence=1.0),
            )
        pad = round(len(self.waveform) * offset / self.duration) if self.duration > 0 else 0
        return self.model_copy(
            update={
                "duration": move(self.duration),
                "beats": [move(t) for t in self.beats],
                "downbeats": [move(t) for t in self.downbeats],
                "chords": chords,
                "waveform": [0.0] * pad + list(self.waveform),
            }
        )


def to_builtin(value: Any) -> Any:
    """Recursively convert numpy scalars/arrays (and tuples) into plain JSON-able Python values;
    non-finite floats become 0.0 so the output is always valid JSON."""
    if isinstance(value, dict):
        return {str(k): to_builtin(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_builtin(v) for v in value]
    if hasattr(value, "tolist") and not isinstance(value, (str, bytes)):
        return to_builtin(value.tolist())
    if isinstance(value, bool) or value is None or isinstance(value, (str, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else 0.0
    if hasattr(value, "item"):
        return to_builtin(value.item())
    try:
        return to_builtin(float(value))
    except (TypeError, ValueError):
        return str(value)

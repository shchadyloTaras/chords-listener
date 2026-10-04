"""API schemas (camelCase JSON, mirrors frontend/src/types.ts) and runtime settings."""
from __future__ import annotations

import math
import os
from dataclasses import dataclass
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

    @property
    def max_duration_s(self) -> float:
        return self.max_duration_min * 60.0

    @property
    def max_upload_bytes(self) -> int:
        return int(self.max_upload_mb * 1024 * 1024)

    @property
    def tracks_dir(self) -> Path:
        return self.data_dir / "tracks"

    @property
    def work_dir(self) -> Path:
        return self.data_dir / ".work"

    @classmethod
    def from_env(cls) -> Settings:
        data_dir = os.environ.get("CHORDS_DATA_DIR", "").strip()
        hosts = os.environ.get("CHORDS_ALLOWED_HOSTS", "").strip()
        defaults = cls()
        return cls(
            data_dir=Path(data_dir).expanduser().resolve() if data_dir else defaults.data_dir,
            frontend_dist=Path(os.environ["CHORDS_FRONTEND_DIST"]).expanduser().resolve()
            if os.environ.get("CHORDS_FRONTEND_DIST")
            else defaults.frontend_dist,
            max_duration_min=_env_float("CHORDS_MAX_DURATION_MIN", defaults.max_duration_min),
            max_upload_mb=_env_float("CHORDS_MAX_UPLOAD_MB", defaults.max_upload_mb),
            allowed_hosts=tuple(h.strip() for h in hosts.split(",") if h.strip()) if hosts else defaults.allowed_hosts,
            allowed_origins=_env_origins("CHORDS_ALLOWED_ORIGINS", defaults.allowed_origins),
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
    created_at: str


class Track(TrackSummary):
    audio_url: str
    time_signature: int = 4
    beats: list[float] = Field(default_factory=list)
    downbeats: list[float] = Field(default_factory=list)
    chords: list[ChordSegment] = Field(default_factory=list)
    waveform: list[float] = Field(default_factory=list)
    engine: str = ""


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


class TrackPatch(CamelModel):
    title: Optional[str] = Field(default=None, max_length=300)
    artist: Optional[str] = Field(default=None, max_length=300)
    chords: Optional[list[ChordSegment]] = Field(default=None, max_length=50_000)


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

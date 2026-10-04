"""Background job system: in-memory registry + a small worker pool running the analysis pipeline.

Overall progress mapping (docs/SPEC.md): queued 0 -> downloading 0..0.35 -> decoding 0.35..0.45 ->
analyzing 0.45..1.0 (engine fraction scaled) -> done 1.
"""
from __future__ import annotations

import logging
import secrets
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional, get_args

from app.engine import analyze

from .models import AnalysisResult, ErrorCode, Job, JobStatus, Settings
from .sources import (
    Cancelled,
    NormalizedUrl,
    ProbeResult,
    ReceivedUpload,
    RemoteMedia,
    SourceError,
    UrlFetcher,
    display_name,
    probe_media,
    track_id_for,
    transcode_to_mp3,
    youtube_thumbnail,
)
from .storage import AUDIO_FILE, TrackStore, summary_fields, utc_now

log = logging.getLogger("chords.jobs")

Analyzer = Callable[..., dict]

ERROR_CODES = frozenset(get_args(ErrorCode))
DOWNLOAD_RANGE = (0.0, 0.35)
DECODE_RANGE = (0.35, 0.45)
ANALYZE_RANGE = (0.45, 1.0)


class JobFailed(Exception):
    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: ErrorCode = code
        self.message = message


@dataclass
class JobRecord:
    id: str
    kind: str  # "url" | "upload" | "reanalyze"
    created_at: str
    status: JobStatus = "queued"
    progress: float = 0.0
    message: str = "Waiting in queue"
    error: Optional[str] = None
    error_code: Optional[ErrorCode] = None
    track_id: Optional[str] = None
    title: Optional[str] = None
    thumbnail: Optional[str] = None
    source: Optional[dict[str, Any]] = None
    options: dict[str, Any] = field(default_factory=dict)
    cancel: threading.Event = field(default_factory=threading.Event)
    cancel_reason: tuple[ErrorCode, str] = ("internal", "Cancelled")
    keys: set[str] = field(default_factory=set)
    created_ts: float = field(default_factory=time.time)

    @property
    def finished(self) -> bool:
        return self.status in ("done", "error")

    def to_model(self) -> Job:
        return Job.model_validate(
            {
                "id": self.id,
                "status": self.status,
                "progress": round(self.progress, 4),
                "message": self.message,
                "error": self.error,
                "errorCode": self.error_code,
                "trackId": self.track_id,
                "title": self.title,
                "thumbnail": self.thumbnail,
                "source": self.source,
                "createdAt": self.created_at,
            }
        )


class JobManager:
    def __init__(
        self,
        settings: Settings,
        store: TrackStore,
        fetcher: UrlFetcher,
        analyzer: Optional[Analyzer] = None,
    ) -> None:
        self.settings = settings
        self.store = store
        self.fetcher = fetcher
        self.analyzer: Analyzer = analyzer or analyze
        self._lock = threading.RLock()
        self._jobs: dict[str, JobRecord] = {}
        self._active: dict[str, str] = {}  # dedup key ("track:<id>" / "url:<url>") -> job id
        self._track_locks: dict[str, threading.Lock] = {}
        self._executor = ThreadPoolExecutor(max_workers=settings.max_workers, thread_name_prefix="chords-job")
        self._closed = False

    # ------------------------------------------------------------------ queries

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            rec = self._jobs.get(job_id)
            return rec.to_model() if rec else None

    def list(self) -> list[Job]:
        with self._lock:
            recs = sorted(self._jobs.values(), key=lambda r: r.created_ts, reverse=True)
            return [r.to_model() for r in recs]

    # ------------------------------------------------------------------ submission

    def submit_url(self, url: NormalizedUrl, options: dict[str, Any]) -> Job:
        offline_key = self.fetcher.offline_key(url)
        track_id = None
        if offline_key:
            kind, _, ident = offline_key.partition(":")
            track_id = track_id_for(kind, ident)
            if self.store.exists(track_id):
                return self._already_done("url", track_id)
        source = (
            {"type": "youtube", "url": url.url, "videoId": url.youtube_id, "filename": None}
            if url.youtube_id
            else {"type": "url", "url": url.url, "videoId": None, "filename": None}
        )
        keys = {f"url:{url.url}"} | ({f"track:{track_id}"} if track_id else set())
        with self._lock:
            running = self._find_active(keys)
            if running:
                return running.to_model()
            rec = self._new_record(
                "url",
                options,
                source=source,
                thumbnail=youtube_thumbnail(url.youtube_id) if url.youtube_id else None,
                keys=keys,
            )
            self._submit(rec, lambda: self._run_url(rec, url))
            return rec.to_model()

    def submit_upload(self, upload: ReceivedUpload, probe: ProbeResult, options: dict[str, Any]) -> Job:
        """Takes ownership of ``upload.work_dir`` (removed when the job ends)."""
        track_id = upload.sha1[:12]
        if self.store.exists(track_id):
            shutil.rmtree(upload.work_dir, ignore_errors=True)
            return self._already_done("upload", track_id)
        keys = {f"track:{track_id}"}
        with self._lock:
            running = self._find_active(keys)
            if running:
                shutil.rmtree(upload.work_dir, ignore_errors=True)
                return running.to_model()
            rec = self._new_record(
                "upload",
                options,
                source={"type": "file", "url": None, "videoId": None, "filename": upload.filename},
                title=probe.title or display_name(upload.filename),
                keys=keys,
            )
            self._submit(rec, lambda: self._run_upload(rec, upload, probe, track_id))
            return rec.to_model()

    def submit_reanalyze(self, track_id: str, options: dict[str, Any]) -> Job:
        meta = self.store.read_meta(track_id)  # raises TrackNotFound
        keys = {f"track:{track_id}"}
        with self._lock:
            running = self._find_active(keys)
            if running:
                return running.to_model()
            rec = self._new_record(
                "reanalyze",
                options,
                source=meta.get("source"),
                title=meta.get("title"),
                thumbnail=meta.get("thumbnail"),
                keys=keys,
            )
            self._submit(rec, lambda: self._run_reanalyze(rec, track_id))
            return rec.to_model()

    def cancel_track_jobs(self, track_id: str, code: ErrorCode, message: str) -> None:
        with self._lock:
            job_id = self._active.get(f"track:{track_id}")
            rec = self._jobs.get(job_id) if job_id else None
            if rec and not rec.finished:
                rec.cancel_reason = (code, message)
                rec.cancel.set()

    def shutdown(self) -> None:
        with self._lock:
            self._closed = True
            for rec in self._jobs.values():
                if not rec.finished:
                    rec.cancel_reason = ("internal", "The server was stopped")
                    rec.cancel.set()
        self._executor.shutdown(wait=False, cancel_futures=True)

    # ------------------------------------------------------------------ registry internals

    def _new_record(self, kind: str, options: dict[str, Any], *, keys: set[str], **fields: Any) -> JobRecord:
        rec = JobRecord(id=secrets.token_hex(8), kind=kind, created_at=utc_now(), options=dict(options), **fields)
        with self._lock:
            self._jobs[rec.id] = rec
            for k in keys:
                self._active[k] = rec.id
            rec.keys = set(keys)
            self._prune()
        return rec

    def _already_done(self, kind: str, track_id: str) -> Job:
        try:
            meta = self.store.read_meta(track_id)
        except Exception:
            meta = {}
        rec = self._new_record(
            kind, {}, keys=set(), source=meta.get("source"), title=meta.get("title"), thumbnail=meta.get("thumbnail")
        )
        self._update(rec, status="done", progress=1.0, message="Already analyzed", track_id=track_id)
        return rec.to_model()

    def _find_active(self, keys: set[str]) -> Optional[JobRecord]:
        for k in keys:
            job_id = self._active.get(k)
            rec = self._jobs.get(job_id) if job_id else None
            if rec and not rec.finished:
                return rec
        return None

    def _claim(self, rec: JobRecord, key: str) -> None:
        with self._lock:
            self._active.setdefault(key, rec.id)
            rec.keys.add(key)

    def _release(self, rec: JobRecord) -> None:
        with self._lock:
            for k in rec.keys:
                if self._active.get(k) == rec.id:
                    del self._active[k]

    def _prune(self) -> None:
        finished = sorted((r for r in self._jobs.values() if r.finished), key=lambda r: r.created_ts)
        for rec in finished[: max(0, len(finished) - self.settings.max_finished_jobs)]:
            self._jobs.pop(rec.id, None)

    def _update(self, rec: JobRecord, **changes: Any) -> None:
        with self._lock:
            if "progress" in changes:
                changes["progress"] = max(rec.progress, min(1.0, float(changes["progress"])))
            for k, v in changes.items():
                setattr(rec, k, v)

    def _check_cancel(self, rec: JobRecord) -> None:
        if rec.cancel.is_set():
            raise Cancelled()

    def _submit(self, rec: JobRecord, fn: Callable[[], None]) -> None:
        if self._closed:
            self._fail(rec, "internal", "The server is shutting down")
            self._release(rec)
            return
        self._executor.submit(self._run, rec, fn)

    def _run(self, rec: JobRecord, fn: Callable[[], None]) -> None:
        started = time.monotonic()
        try:
            self._check_cancel(rec)
            fn()
            log.info("job %s (%s) done in %.1fs -> track %s", rec.id, rec.kind, time.monotonic() - started, rec.track_id)
        except Cancelled:
            code, message = rec.cancel_reason
            self._fail(rec, code, message)
        except (JobFailed, SourceError) as exc:
            log.info("job %s (%s) failed: [%s] %s", rec.id, rec.kind, exc.code, exc.message)
            self._fail(rec, exc.code, exc.message)
        except Exception:
            log.exception("job %s (%s) crashed", rec.id, rec.kind)
            self._fail(rec, "internal", "Unexpected server error")
        finally:
            self._release(rec)
            with self._lock:
                self._prune()

    def _fail(self, rec: JobRecord, code: ErrorCode, message: str) -> None:
        self._update(rec, status="error", error_code=code, error=message, message=message)

    def _track_lock(self, track_id: str) -> threading.Lock:
        with self._lock:
            return self._track_locks.setdefault(track_id, threading.Lock())

    @staticmethod
    def _scaled(lo_hi: tuple[float, float], fraction: float) -> float:
        lo, hi = lo_hi
        return lo + (hi - lo) * min(1.0, max(0.0, fraction))

    # ------------------------------------------------------------------ pipelines

    def _run_url(self, rec: JobRecord, url: NormalizedUrl) -> None:
        self._update(rec, status="downloading", progress=0.01, message="Fetching video info")
        media: RemoteMedia = self.fetcher.probe(url)
        self._check_cancel(rec)
        self._update(rec, title=media.title, thumbnail=media.thumbnail or rec.thumbnail, source=media.source())
        if media.duration and media.duration > self.settings.max_duration_s:
            raise JobFailed("too_long", self._too_long_message(media.duration))
        track_id = media.track_id
        self._claim(rec, f"track:{track_id}")
        if self.store.exists(track_id):
            self._update(rec, status="done", progress=1.0, message="Already analyzed", track_id=track_id)
            return

        work = self.store.new_work_dir(rec.id)
        try:
            self._update(rec, progress=0.02, message="Downloading audio")
            src = self.fetcher.download(
                media,
                work,
                lambda f: self._update(rec, progress=self._scaled((0.02, DOWNLOAD_RANGE[1]), f)),
                rec.cancel,
            )
            self._check_cancel(rec)
            meta = {
                "title": media.title,
                "artist": media.artist,
                "thumbnail": media.thumbnail,
                "source": media.source(),
                "sourceDuration": media.duration,
            }
            self._process(rec, src, work, track_id, meta, probe=None)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _run_upload(self, rec: JobRecord, upload: ReceivedUpload, probe: ProbeResult, track_id: str) -> None:
        try:
            meta = {
                "title": rec.title or display_name(upload.filename),
                "artist": probe.artist,
                "thumbnail": None,
                "source": rec.source,
                "sourceDuration": probe.duration,
                "fileSize": upload.size,
                "sha1": upload.sha1,
            }
            self._process(rec, upload.path, upload.work_dir, track_id, meta, probe=probe)
        finally:
            shutil.rmtree(upload.work_dir, ignore_errors=True)

    def _process(
        self,
        rec: JobRecord,
        src: Path,
        work: Path,
        track_id: str,
        meta: dict[str, Any],
        probe: Optional[ProbeResult],
    ) -> None:
        """Shared tail: probe -> transcode to playback mp3 -> analyze -> install into the library."""
        self._update(rec, status="decoding", progress=DECODE_RANGE[0], message="Converting audio")
        probe = probe or probe_media(src)
        if not probe.has_audio:
            raise JobFailed("unsupported_format", "This media has no audio track")
        if probe.duration and probe.duration > self.settings.max_duration_s:
            raise JobFailed("too_long", self._too_long_message(probe.duration))

        staged = work / "track"
        staged.mkdir(exist_ok=True)
        audio = staged / AUDIO_FILE
        transcode_to_mp3(
            src, audio, probe.duration, lambda f: self._update(rec, progress=self._scaled(DECODE_RANGE, f)), rec.cancel
        )
        src.unlink(missing_ok=True)
        self._check_cancel(rec)
        playback = probe_media(audio)
        if playback.duration is None or playback.duration < 0.5:
            raise JobFailed("unsupported_format", "The audio is empty or too short")
        if playback.duration > self.settings.max_duration_s:
            raise JobFailed("too_long", self._too_long_message(playback.duration))

        analysis = self._analyze(rec, audio)
        self._update(rec, message="Saving")
        now = utc_now()
        full_meta = {
            "id": track_id,
            **meta,
            "originalTitle": meta.get("title"),
            "originalArtist": meta.get("artist"),
            "createdAt": now,
            "updatedAt": now,
            "analyzedAt": now,
            "options": rec.options,
            "engine": analysis.engine,
            "audio": {"codec": "mp3", "bitrate": 192000, "sampleRate": 44100, "channels": 2,
                      "duration": playback.duration},
            **summary_fields(analysis),
        }
        if not full_meta.get("duration"):
            full_meta["duration"] = playback.duration
        with self._track_lock(track_id):
            self._check_cancel(rec)
            installed = self.store.install_track(staged, track_id, full_meta, analysis)
        if not installed:
            log.info("job %s: track %s was completed by another job meanwhile", rec.id, track_id)
        self._update(rec, status="done", progress=1.0, message="Done", track_id=track_id)

    def _run_reanalyze(self, rec: JobRecord, track_id: str) -> None:
        audio = self.store.audio_path(track_id)
        analysis = self._analyze(rec, audio)
        self._update(rec, message="Saving")
        with self._track_lock(track_id):
            self._check_cancel(rec)
            self.store.save_reanalysis(track_id, analysis, rec.options)
        self._update(rec, status="done", progress=1.0, message="Done", track_id=track_id)

    def _analyze(self, rec: JobRecord, audio: Path) -> AnalysisResult:
        self._update(rec, status="analyzing", progress=ANALYZE_RANGE[0], message="Analyzing chords")

        def progress(fraction: float, message: str = "") -> None:
            if rec.cancel.is_set():
                raise Cancelled()
            try:
                value = float(fraction)
            except (TypeError, ValueError):
                value = 0.0
            # stay below 1.0 until results are saved, so "progress == 1" always means done
            self._update(
                rec,
                progress=min(0.99, self._scaled(ANALYZE_RANGE, value)),
                message=str(message).strip()[:120] or "Analyzing chords",
            )

        try:
            raw = self.analyzer(str(audio), progress, dict(rec.options))
        except Cancelled:
            raise
        except Exception as exc:
            self._check_cancel(rec)
            reason = str(exc).strip().splitlines()[0][:200] if str(exc).strip() else type(exc).__name__
            code = getattr(exc, "code", None)
            if code in ERROR_CODES and code != "internal":  # engine-declared user-facing error (EngineError)
                log.warning("job %s: engine rejected %s: [%s] %s", rec.id, audio.name, code, reason)
                raise JobFailed(code, reason) from exc
            log.exception("job %s: engine failed on %s", rec.id, audio)
            raise JobFailed("analysis_failed", f"Chord analysis failed: {reason}") from exc
        self._check_cancel(rec)
        try:
            return AnalysisResult.from_engine(raw)
        except ValueError as exc:
            log.error("job %s: engine returned an invalid result: %s", rec.id, exc)
            raise JobFailed("analysis_failed", "Chord analysis returned an invalid result") from exc

    def _too_long_message(self, duration: float) -> str:
        return too_long_message(duration, self.settings.max_duration_min)


def too_long_message(duration: float, limit_min: float) -> str:
    length = f"{duration:.0f} s" if duration < 120 else f"{duration / 60:.0f} min"
    return f"The audio is {length} long; the limit is {limit_min:g} min"

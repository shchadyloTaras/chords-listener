"""Background job system: in-memory registry + a small worker pool running the analysis pipeline.

Overall progress mapping (docs/SPEC.md): queued 0 -> downloading 0..0.35 -> decoding 0.35..0.45 ->
analyzing 0.45..1.0 (engine fraction scaled) -> done 1.
"""
from __future__ import annotations

import contextvars
import hashlib
import logging
import secrets
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Optional, get_args

from app.engine import analyze

from .admin.history import AcceptedJob, FinishedJob
from .models import AnalysisResult, ErrorCode, Job, JobStatus, Settings, VocalNotes
from .quotas import QuotaExceeded, Quotas
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
    safe_suffix,
    track_id_for,
    transcode_to_mp3,
    youtube_oembed,
    youtube_thumbnail,
    youtube_url,
)
from .storage import AUDIO_FILE, TrackStore, summary_fields, utc_now
from .users import current_uid

if TYPE_CHECKING:
    from .admin.history import Projections
    from .gcs import UploadBucket

log = logging.getLogger("chords.jobs")

Analyzer = Callable[..., dict]
# (audio_path, stems_dir, progress, options) -> VocalNotes dict; writes stems_dir/<stem>.mp3 (app.vocals)
VocalTranscriber = Callable[..., dict]

ERROR_CODES = frozenset(get_args(ErrorCode))
ORIGINS = ("link", "file", "mic", "tab")  # where a job's audio came from (admin history ``origin``)
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
    kind: str  # "url" | "upload" | "reanalyze" | "vocals"
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
    uid: Optional[str] = None  # owner (cloud mode); None in local mode
    origin: str = "file"  # "link" | "file" | "mic" | "tab" (admin job history)

    @property
    def finished(self) -> bool:
        return self.status in ("done", "error")

    def to_model(self) -> Job:
        return Job.model_validate(
            {
                "id": self.id,
                "kind": "vocals" if self.kind == "vocals" else "analysis",
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
        vocal_transcriber: Optional[VocalTranscriber] = None,
        projections: Optional["Projections"] = None,
        is_tombstoned: Optional[Callable[[str], bool]] = None,
    ) -> None:
        """``projections`` (admin job history, docs/features/admin) is told when a job is taken on and when it ends;
        ``is_tombstoned(uid)`` tells whether the user's account is being purged: the result of such a job is
        discarded instead of written (ADR-0011). Both are optional and never fail a job."""
        self.settings = settings
        self.store = store
        self.fetcher = fetcher
        self.analyzer: Analyzer = analyzer or analyze
        self.vocal_transcriber = vocal_transcriber  # None: app.vocals.transcribe when the extra is installed
        self.projections = projections
        self._is_tombstoned = is_tombstoned
        self._lock = threading.RLock()
        self._jobs: dict[str, JobRecord] = {}
        self._active: dict[str, str] = {}  # dedup key ("track:<id>" / "url:<url>") -> job id
        self._track_locks: dict[str, threading.Lock] = {}
        self._executor = ThreadPoolExecutor(max_workers=settings.max_workers, thread_name_prefix="chords-job")
        self._closed = False
        self.quotas = Quotas(settings, store)

    # ------------------------------------------------------------------ per-user helpers (cloud mode)

    def _ukey(self, key: str, uid: Optional[str] = None) -> str:
        """Dedup / lock key namespaced by the owner, so users never share running jobs."""
        uid = uid if uid is not None else current_uid()
        return f"{uid}|{key}" if uid else key

    def _visible(self, rec: JobRecord) -> bool:
        return not self.settings.cloud or rec.uid == current_uid()

    def running_count(self, uid: Optional[str] = None) -> int:
        uid = uid if uid is not None else current_uid()
        with self._lock:
            # a job being cancelled stops at its next progress report: it no longer counts
            return sum(1 for r in self._jobs.values() if r.uid == uid and not r.finished and not r.cancel.is_set())

    def admit(self, quota: Optional[str] = "analyses") -> None:
        """Cloud mode: may the current user start one more job now? Checks the running-jobs limit, then
        counts one unit of the daily ``quota`` ("analyses" | "vocals" | None). Raises QuotaExceeded (429).
        Feature code that creates its own jobs (e.g. vocals) calls this right before submitting."""
        if not self.settings.cloud:
            return
        with self._lock:
            if self.running_count() >= self.settings.max_user_jobs:
                raise QuotaExceeded(
                    f"You already have {self.settings.max_user_jobs} songs in progress - wait for one to finish"
                )
            if quota:
                self.quotas.consume(quota)

    # ------------------------------------------------------------------ queries

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            rec = self._jobs.get(job_id)
            return rec.to_model() if rec and self._visible(rec) else None

    def list(self) -> list[Job]:
        with self._lock:
            recs = sorted((r for r in self._jobs.values() if self._visible(r)), key=lambda r: r.created_ts, reverse=True)
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
        keys = {self._ukey(f"url:{url.url}")} | ({self._ukey(f"track:{track_id}")} if track_id else set())
        with self._lock:
            running = self._find_active(keys)
            if running:
                return running.to_model()
            self.admit()
            rec = self._new_record(
                "url",
                options,
                origin="link",
                source=source,
                thumbnail=youtube_thumbnail(url.youtube_id) if url.youtube_id else None,
                keys=keys,
            )
            self._submit(rec, lambda: self._run_url(rec, url))
            return rec.to_model()

    def submit_upload(
        self, upload: ReceivedUpload, probe: ProbeResult, options: dict[str, Any], origin: str = "file"
    ) -> Job:
        """Takes ownership of ``upload.work_dir`` (removed when the job ends). ``origin``: "file" | "mic"."""
        track_id = upload.sha1[:12]
        if self.store.exists(track_id):
            shutil.rmtree(upload.work_dir, ignore_errors=True)
            return self._already_done("upload", track_id)
        keys = {self._ukey(f"track:{track_id}")}
        with self._lock:
            running = self._find_active(keys)
            if running:
                shutil.rmtree(upload.work_dir, ignore_errors=True)
                return running.to_model()
            try:
                self.admit()
            except QuotaExceeded:
                shutil.rmtree(upload.work_dir, ignore_errors=True)
                raise
            rec = self._new_record(
                "upload",
                options,
                origin=_upload_origin(origin),
                source={"type": "file", "url": None, "videoId": None, "filename": upload.filename},
                title=probe.title or display_name(upload.filename),
                keys=keys,
            )
            self._submit(rec, lambda: self._run_upload(rec, upload, probe, track_id))
            return rec.to_model()

    def submit_reanalyze(self, track_id: str, options: dict[str, Any]) -> Job:
        meta = self.store.read_meta(track_id)  # raises TrackNotFound
        keys = {self._ukey(f"track:{track_id}")}
        with self._lock:
            running = self._find_active(keys)
            if running:
                return running.to_model()
            self.admit()
            rec = self._new_record(
                "reanalyze",
                options,
                origin=_meta_origin(meta),
                source=meta.get("source"),
                title=meta.get("title"),
                thumbnail=meta.get("thumbnail"),
                keys=keys,
            )
            self._submit(rec, lambda: self._run_reanalyze(rec, track_id))
            return rec.to_model()

    def submit_storage(
        self,
        path: str,
        bucket: UploadBucket,
        *,
        size: int,
        title: Optional[str],
        video_id: Optional[str],
        start_offset: float,
        options: dict[str, Any],
        origin: str = "file",
    ) -> Job:
        """Ingest a client upload from the bucket (``users/<uid>/uploads/...``, cloud mode). The job
        downloads it, deletes the object, dedups by content sha1 and analyzes it like an upload.
        ``video_id`` links the track to a YouTube video (a tab capture, origin "tab"); ``start_offset`` (video
        time where the recording begins) shifts every analysis time so chords line up with the video.
        ``origin`` ("file" | "mic") is the client's hint for anything that is not a tab capture."""
        filename = path.rsplit("/", 1)[-1] or "audio"
        if video_id:
            source = {"type": "youtube", "url": youtube_url(video_id), "videoId": video_id, "filename": None}
        else:
            source = {"type": "file", "url": None, "videoId": None, "filename": filename}
        keys = {self._ukey(f"upload:{path}")}
        with self._lock:
            running = self._find_active(keys)
            if running:
                return running.to_model()
            self.admit()
            rec = self._new_record(
                "upload",
                options,
                origin="tab" if video_id else _upload_origin(origin),
                source=source,
                title=(title or "").strip() or (None if video_id else display_name(filename)),
                thumbnail=youtube_thumbnail(video_id) if video_id else None,
                keys=keys,
            )
            self._submit(rec, lambda: self._run_storage(rec, path, bucket, size, start_offset))
            return rec.to_model()

    def vocals_available(self) -> bool:
        """Vocal transcription can run here (the optional ``vocals`` extra is installed)."""
        if self.vocal_transcriber is not None:
            return True
        from app import vocals

        return vocals.available()

    def submit_vocals(self, track_id: str, force: bool = False) -> Job:
        """Separate the track's vocals and transcribe the sung melody (``kind: "vocals"``). Done at once
        when the result is already stored, unless ``force``. The caller checks ``vocals_available()``."""
        meta = self.store.read_meta(track_id)  # raises TrackNotFound
        if not force and self.store.has_vocals(track_id):
            return self._already_done("vocals", track_id, message="Vocals already transcribed")
        keys = {self._ukey(f"vocals:{track_id}")}
        with self._lock:
            running = self._find_active(keys)
            if running:
                return running.to_model()
            self.admit("vocals")
            rec = self._new_record(
                "vocals",
                {},
                origin=_meta_origin(meta),
                source=meta.get("source"),
                title=meta.get("title"),
                thumbnail=meta.get("thumbnail"),
                track_id=track_id,
                keys=keys,
            )
            self._submit(rec, lambda: self._run_vocals(rec, track_id))
            return rec.to_model()

    def cancel(self, job_id: str) -> Optional[Job]:
        """The user cancels a job: it stops at its next progress report and ends with ``errorCode: "cancelled"``.
        A cancelled vocal transcription gives its daily quota unit back. None: no such job (of this user)."""
        with self._lock:
            rec = self._jobs.get(job_id)
            if rec is None or not self._visible(rec):
                return None
            if not rec.finished and not rec.cancel.is_set():
                rec.cancel_reason = ("cancelled", "Cancelled")
                rec.cancel.set()
                if rec.kind == "vocals" and self.settings.cloud:
                    self.quotas.refund("vocals", rec.uid)
            return rec.to_model()

    def cancel_track_jobs(self, track_id: str, code: ErrorCode, message: str) -> None:
        with self._lock:
            for key in (f"track:{track_id}", f"vocals:{track_id}"):
                job_id = self._active.get(self._ukey(key))
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
        fields.setdefault("uid", current_uid())
        rec = JobRecord(id=secrets.token_hex(8), kind=kind, created_at=utc_now(), options=dict(options), **fields)
        with self._lock:
            self._jobs[rec.id] = rec
            for k in keys:
                self._active[k] = rec.id
            rec.keys = set(keys)
            self._prune()
        return rec

    def _already_done(self, kind: str, track_id: str, message: str = "Already analyzed") -> Job:
        try:
            meta = self.store.read_meta(track_id)
        except Exception:
            meta = {}
        rec = self._new_record(
            kind, {}, keys=set(), source=meta.get("source"), title=meta.get("title"), thumbnail=meta.get("thumbnail")
        )
        self._update(rec, status="done", progress=1.0, message=message, track_id=track_id)
        self._ensure_published(track_id)
        return rec.to_model()

    def _ensure_published(self, track_id: str) -> None:
        """A track that is "already analyzed" may predate publishing: publish it if the index lacks it. Cloud
        mode only; call it outside ``self._lock`` (the publisher may take a while)."""
        uid = current_uid()
        if self.settings.cloud and uid and not self._tombstoned(uid):  # never republish for a purged account
            self.store.publisher.ensure_published(uid, track_id)

    def _find_active(self, keys: set[str]) -> Optional[JobRecord]:
        for k in keys:
            job_id = self._active.get(k)
            rec = self._jobs.get(job_id) if job_id else None
            # one being cancelled is not shared: the same work asked again starts afresh
            if rec and not rec.finished and not rec.cancel.is_set():
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
        # The worker runs in a copy of the submitting request's context: same user (app.users), so the
        # storage helpers resolve that user's paths inside the job.
        self._executor.submit(contextvars.copy_context().run, self._run, rec, fn)

    def _run(self, rec: JobRecord, fn: Callable[[], None]) -> None:
        started = time.monotonic()
        self._project_accept(rec)
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
            self._project_finish(rec)

    def _fail(self, rec: JobRecord, code: ErrorCode, message: str) -> None:
        self._update(rec, status="error", error_code=code, error=message, message=message)

    # ------------------------------------------------------------------ admin hooks (docs/features/admin)

    def _project_accept(self, rec: JobRecord) -> None:
        """Record the job in the admin history. Cloud jobs only; never raises (a failed write is buffered).
        Nothing here looks at the account's restriction: a job the server accepted always runs (AC-19)."""
        if self.projections is None or not rec.uid:
            return
        try:
            self.projections.accept(AcceptedJob(
                id=rec.id, uid=rec.uid, kind="vocals" if rec.kind == "vocals" else "analysis",
                origin=rec.origin if rec.origin in ORIGINS else "file",  # type: ignore[arg-type]
                accepted_at=datetime.fromtimestamp(rec.created_ts, timezone.utc), title=rec.title,
            ))
        except Exception:
            log.warning("admin history: could not record job %s", rec.id, exc_info=True)

    def _project_finish(self, rec: JobRecord) -> None:
        if self.projections is None or not rec.uid or not rec.finished:
            return
        try:
            self.projections.finish(FinishedJob(
                id=rec.id, status="done" if rec.status == "done" else "error", finished_at=datetime.now(timezone.utc),
                error_code=rec.error_code, error_text=rec.error, track_id=rec.track_id,
            ))
        except Exception:
            log.warning("admin history: could not settle job %s", rec.id, exc_info=True)

    def _tombstoned(self, uid: Optional[str]) -> bool:
        """Is the account being purged (ADR-0011)? A check that cannot be made says no: the purge repeats its erase
        steps on its next run, so a result that slipped through is erased again."""
        if self._is_tombstoned is None or not uid:
            return False
        try:
            return bool(self._is_tombstoned(uid))
        except Exception:
            log.warning("could not check the tombstone of %s", uid, exc_info=True)
            return False

    def _discard_if_tombstoned(self, rec: JobRecord) -> None:
        """Late-job discard: called right before a result is written, so the song of a purged account does not
        come back."""
        if self._tombstoned(rec.uid):
            log.info("job %s: its account is being purged, the result is discarded", rec.id)
            raise JobFailed("cancelled", "The account was removed")

    def _track_lock(self, track_id: str) -> threading.Lock:
        with self._lock:
            return self._track_locks.setdefault(self._ukey(track_id), threading.Lock())

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
        self._claim(rec, self._ukey(f"track:{track_id}", rec.uid))
        if self.store.exists(track_id):
            self._update(rec, status="done", progress=1.0, message="Already analyzed", track_id=track_id)
            self._ensure_published(track_id)
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

    def _run_storage(self, rec: JobRecord, path: str, bucket: UploadBucket, size: int, start_offset: float) -> None:
        self._update(rec, status="downloading", progress=0.01, message="Fetching the upload")
        work = self.store.new_work_dir(rec.id)
        try:
            src = work / ("upload" + safe_suffix(path.rsplit("/", 1)[-1]))
            try:
                bucket.download(
                    path,
                    src,
                    size=size,
                    progress=lambda f: self._update(rec, progress=self._scaled((0.01, DOWNLOAD_RANGE[1]), f)),
                    cancel=rec.cancel,
                    max_bytes=self.settings.max_upload_bytes,
                )
            finally:
                bucket.delete(path)  # the upload is consumed whatever happens next
            self._check_cancel(rec)
            sha1 = _file_sha1(src)
            track_id = sha1[:12]
            self._claim(rec, self._ukey(f"track:{track_id}", rec.uid))
            if self.store.exists(track_id):
                self._update(rec, status="done", progress=1.0, message="Already analyzed", track_id=track_id)
                self._ensure_published(track_id)
                return
            probe = probe_media(src)
            if not probe.has_audio:
                raise JobFailed("unsupported_format", "This file has no audio track")
            video_id = (rec.source or {}).get("videoId")
            artist = probe.artist
            if not rec.title:
                title, channel = youtube_oembed(video_id) if video_id else (None, None)
                artist = artist or channel
                self._update(rec, title=title or probe.title or display_name(path.rsplit("/", 1)[-1]))
            meta = {
                "title": rec.title,
                "artist": artist,
                "thumbnail": rec.thumbnail,
                "source": rec.source,
                "sourceDuration": probe.duration,
                "fileSize": src.stat().st_size,
                "sha1": sha1,
            }
            self._process(rec, src, work, track_id, meta, probe=probe, start_offset=start_offset)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _process(
        self,
        rec: JobRecord,
        src: Path,
        work: Path,
        track_id: str,
        meta: dict[str, Any],
        probe: Optional[ProbeResult],
        start_offset: float = 0.0,
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
        if start_offset > 0:
            analysis = analysis.shifted(start_offset)
            meta = {**meta, "startOffset": round(start_offset, 4)}
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
            "origin": rec.origin,
            "engine": analysis.engine,
            "audio": {"codec": "mp3", "bitrate": 192000, "sampleRate": 44100, "channels": 2,
                      "duration": playback.duration},
            **summary_fields(analysis),
        }
        if not full_meta.get("duration"):
            full_meta["duration"] = playback.duration
        with self._track_lock(track_id):
            self._check_cancel(rec)
            self._discard_if_tombstoned(rec)
            installed = self.store.install_track(staged, track_id, full_meta, analysis)
        if not installed:
            log.info("job %s: track %s was completed by another job meanwhile", rec.id, track_id)
        self._update(rec, status="done", progress=1.0, message="Done", track_id=track_id)

    def _run_reanalyze(self, rec: JobRecord, track_id: str) -> None:
        audio = self.store.audio_path(track_id)
        analysis = self._analyze(rec, audio)
        offset = self.store.read_meta(track_id).get("startOffset")
        if isinstance(offset, (int, float)) and offset > 0:  # a recording linked to a video: keep video time
            analysis = analysis.shifted(float(offset))
        self._update(rec, message="Saving")
        with self._track_lock(track_id):
            self._check_cancel(rec)
            self._discard_if_tombstoned(rec)
            self.store.save_reanalysis(track_id, analysis, rec.options)
        self._update(rec, status="done", progress=1.0, message="Done", track_id=track_id)

    def _run_vocals(self, rec: JobRecord, track_id: str) -> None:
        """Separation + melody transcription (app.vocals) on the track's audio; stems and vocals.json are
        installed into the track when everything succeeded."""
        self._update(rec, status="analyzing", progress=0.01, message="Preparing")
        audio = self.store.audio_path(track_id)
        offset = self.store.read_meta(track_id).get("startOffset") or 0.0
        transcribe = self.vocal_transcriber
        if transcribe is None:
            from app.vocals import transcribe
        work = self.store.new_work_dir(f"vocals-{rec.id}")
        try:
            stems = work / "stems"

            def progress(fraction: float, message: str = "") -> None:
                if rec.cancel.is_set():
                    raise Cancelled()
                try:
                    value = float(fraction)
                except (TypeError, ValueError):
                    value = 0.0
                # stay below 1.0 until the result is installed, so "progress == 1" always means done
                self._update(rec, progress=min(0.99, max(0.01, value)),
                             message=str(message).strip()[:120] or "Transcribing the vocals")

            try:
                raw = transcribe(str(audio), str(stems), progress, dict(rec.options))
            except Cancelled:
                raise
            except Exception as exc:
                self._check_cancel(rec)
                reason = str(exc).strip().splitlines()[0][:200] if str(exc).strip() else type(exc).__name__
                code = getattr(exc, "code", None)
                if code in ERROR_CODES and code != "internal":  # VocalsError with a user-facing code
                    log.warning("job %s: vocals failed on %s: [%s] %s", rec.id, track_id, code, reason)
                    raise JobFailed(code, reason) from exc
                log.exception("job %s: vocal transcription failed on %s", rec.id, track_id)
                raise JobFailed("analysis_failed", f"Vocal transcription failed: {reason}") from exc
            self._check_cancel(rec)
            try:
                vocals = VocalNotes.from_pipeline(raw, offset)
            except ValueError as exc:
                log.error("job %s: the vocal pipeline returned an invalid result: %s", rec.id, exc)
                raise JobFailed("analysis_failed", "Vocal transcription returned an invalid result") from exc
            self._update(rec, message="Saving")
            with self._track_lock(track_id):
                self._check_cancel(rec)
                self._discard_if_tombstoned(rec)
                self.store.install_vocals(track_id, stems, vocals)
            self._update(rec, status="done", progress=1.0, message="Done", track_id=track_id)
        finally:
            shutil.rmtree(work, ignore_errors=True)

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


def _upload_origin(hint: Optional[str]) -> str:
    """The client's hint for an uploaded file: "mic" for a recording, anything else (or none) is "file"."""
    return "mic" if hint == "mic" else "file"


def _meta_origin(meta: dict[str, Any]) -> str:
    """Re-analysis and vocal transcription inherit the origin of their track (tracks that predate it: a YouTube
    source is a link, anything else a file)."""
    origin = meta.get("origin")
    if origin in ORIGINS:
        return origin
    return "link" if (meta.get("source") or {}).get("type") == "youtube" else "file"


def _file_sha1(path: Path) -> str:
    digest = hashlib.sha1()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def too_long_message(duration: float, limit_min: float) -> str:
    length = f"{duration:.0f} s" if duration < 120 else f"{duration / 60:.0f} min"
    return f"The audio is {length} long; the limit is {limit_min:g} min"

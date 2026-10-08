"""On-disk track library.

Layout (under ``Settings.data_dir``)::

    tracks/<trackId>/audio.mp3       playback file (served with HTTP Range support)
    tracks/<trackId>/analysis.json   engine output (detected chords, beats, waveform ...)
    tracks/<trackId>/meta.json       title, artist, source, createdAt, summary fields ...
    tracks/<trackId>/edits.json      user chord edits (optional; dropped by "reset")
    tracks/<trackId>/notes.json      live-piano notes transcribed in the browser (optional; kept on
                                     re-analysis since the audio does not change)
    tracks/<trackId>/vocals.json     sung melody (app.vocals; optional, kept on re-analysis)
    tracks/<trackId>/stems/<name>.mp3  separated stems: vocals, instruments (= bass + other)
    .work/<jobId>/                   scratch space for running jobs (wiped on startup)

A track directory is assembled completely inside ``.work`` and then moved into ``tracks/`` with a
single atomic rename, so readers never observe half-written tracks. JSON files are written
atomically (temp file + ``os.replace``).

Cloud mode (``CHORDS_AUTH=firebase``, docs/CLOUD.md): every path above lives under
``users/<uid>/`` for the *current user* (``app.users.current_uid()``), e.g.
``<data>/users/<uid>/tracks/<trackId>/``. Feature code always goes through the helpers
(``track_dir``, ``audio_path``, ``user_dir``, ``uploads_dir``, ``media_url`` ...) and never builds user
paths itself. Scratch space (``CHORDS_WORK_DIR``) may then be on another file system than the
library (Cloud Run: /tmp vs. the bucket mount); tracks are installed by copying with ``meta.json``
last, and a track only "exists" once its meta.json is there. There every change is also published
(``app.publish``: track.json + the Firestore index) by ``TrackStore.publisher``, after the change is on disk
and ``TrackStore._lock`` is released (the publisher takes its own per-track lock first, then ``_lock``).
"""
from __future__ import annotations

import contextvars
import json
import logging
import os
import re
import secrets
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from .models import (
    NOTES_VERSION,
    VOCALS_VERSION,
    AnalysisResult,
    Settings,
    Track,
    TrackNotes,
    TrackPatch,
    TrackSummary,
    VocalNotes,
)
from .users import NoUserContext, current_uid, valid_uid

if TYPE_CHECKING:
    from .auth import MediaSigner

log = logging.getLogger("chords.storage")

AUDIO_FILE = "audio.mp3"
ANALYSIS_FILE = "analysis.json"
META_FILE = "meta.json"
EDITS_FILE = "edits.json"
EDITS_BACKUP_FILE = "edits.prev.json"
NOTES_FILE = "notes.json"
VOCALS_FILE = "vocals.json"
STEMS_DIR = "stems"
STEM_NAMES = ("vocals", "instruments")

_TRACK_ID_RE = re.compile(r"^[0-9a-f]{6,64}$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def write_json_atomic(path: Path, data: Any, *, pretty: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    text = json.dumps(data, ensure_ascii=False, indent=2 if pretty else None, separators=None if pretty else (",", ":"))
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def read_json(path: Path) -> Any:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


class TrackNotFound(Exception):
    pass


class TrackStore:
    def __init__(self, settings: Settings, signer: Optional[MediaSigner] = None, publisher: Any = None) -> None:
        from .publish import NullPublisher  # app.publish imports this module

        self.settings = settings
        self.work_root = settings.work_dir
        self.signer = signer
        self.publisher = publisher or NullPublisher()  # app.publish: Publisher (cloud) or NullPublisher
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ per-user roots

    def user_dir(self, uid: Optional[str] = None) -> Path:
        """Root of the current (or given) user's files: ``<data>/users/<uid>`` in cloud mode, ``<data>``
        itself in local mode. Raises NoUserContext in cloud mode without an authenticated user."""
        if not self.settings.cloud:
            return self.settings.data_dir
        uid = uid or current_uid()
        if not valid_uid(uid):
            raise NoUserContext("no authenticated user for this operation")
        return self.settings.users_dir / str(uid)

    @property
    def root(self) -> Path:
        """The current user's track library (local mode: ``<data>/tracks``)."""
        return self.user_dir() / "tracks"

    def uploads_dir(self) -> Path:
        """``<data>/users/<uid>/uploads`` — where clients upload big files (cloud mode)."""
        return self.user_dir() / "uploads"

    def upload_prefix(self) -> str:
        """Bucket object prefix of the current user's uploads: ``users/<uid>/uploads/``."""
        return self.uploads_dir().relative_to(self.settings.data_dir).as_posix() + "/"

    def media_url(self, track_id: str, name: str = "audio") -> str:
        """URL of a track's media file for ``<audio>``: ``/api/tracks/<id>/<name>`` (e.g. ``audio``,
        ``stems/vocals``), signed for the current user in cloud mode (docs/CLOUD.md → Media URLs)."""
        path = f"/api/tracks/{track_id}/{name}"
        uid = current_uid()
        if not self.settings.cloud or self.signer is None or not uid:
            return path
        return self.signer.sign(uid, path)

    # ------------------------------------------------------------------ lifecycle

    def init(self) -> None:
        """Create the directory layout and wipe scratch space left over from a previous run."""
        if self.settings.cloud:
            self.settings.users_dir.mkdir(parents=True, exist_ok=True)
        else:
            self.root.mkdir(parents=True, exist_ok=True)
        if self.work_root.exists():
            for child in self.work_root.iterdir():
                if child.is_dir():
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    child.unlink(missing_ok=True)
        self.work_root.mkdir(parents=True, exist_ok=True)

    def new_work_dir(self, prefix: str) -> Path:
        self.work_root.mkdir(parents=True, exist_ok=True)
        path = self.work_root / f"{prefix}-{secrets.token_hex(6)}"
        path.mkdir(parents=True)
        return path

    # ------------------------------------------------------------------ paths

    @staticmethod
    def valid_id(track_id: str) -> bool:
        return bool(_TRACK_ID_RE.fullmatch(track_id or ""))

    def track_dir(self, track_id: str) -> Path:
        if not self.valid_id(track_id):
            raise TrackNotFound(track_id)
        return self.root / track_id

    def audio_path(self, track_id: str) -> Path:
        path = self.track_dir(track_id) / AUDIO_FILE
        if not path.is_file():
            raise TrackNotFound(track_id)
        return path

    def exists(self, track_id: str) -> bool:
        if not self.valid_id(track_id):
            return False
        d = self.root / track_id
        return all((d / name).is_file() for name in (AUDIO_FILE, ANALYSIS_FILE, META_FILE))

    def _require(self, track_id: str) -> Path:
        if not self.exists(track_id):
            raise TrackNotFound(track_id)
        return self.root / track_id

    # ------------------------------------------------------------------ raw files

    def read_meta(self, track_id: str) -> dict[str, Any]:
        return read_json(self._require(track_id) / META_FILE)

    def version(self, track_id: str) -> int:
        """The track's change counter; 0 for tracks written before versions existed."""
        return int(self.read_meta(track_id).get("version") or 0)

    def read_analysis(self, track_id: str) -> dict[str, Any]:
        return read_json(self._require(track_id) / ANALYSIS_FILE)

    def read_edits(self, track_id: str) -> Optional[dict[str, Any]]:
        path = self._require(track_id) / EDITS_FILE
        if not path.is_file():
            return None
        try:
            data = read_json(path)
        except (OSError, ValueError):
            log.warning("ignoring unreadable %s", path)
            return None
        return data if isinstance(data, dict) and isinstance(data.get("chords"), list) else None

    def duration(self, track_id: str) -> float:
        """Track duration in seconds (analysis first, then meta)."""
        d = self._require(track_id)
        for name in (ANALYSIS_FILE, META_FILE):
            try:
                value = read_json(d / name).get("duration")
            except (OSError, ValueError, AttributeError):
                continue
            if isinstance(value, (int, float)) and value > 0:
                return float(value)
        return 0.0

    # ------------------------------------------------------------------ live-piano notes

    def read_notes(self, track_id: str) -> Optional[bytes]:
        """The stored notes.json (compact JSON bytes), or None when not computed yet (or unreadable)."""
        path = self._require(track_id) / NOTES_FILE
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            return None
        try:
            data = json.loads(raw)
        except ValueError:
            log.warning("ignoring unreadable %s", path)
            return None
        if not isinstance(data, dict) or data.get("version") != NOTES_VERSION or not isinstance(data.get("notes"), list):
            log.warning("ignoring %s with an unknown format", path)
            return None
        return raw

    def write_notes(self, track_id: str, notes: TrackNotes) -> None:
        with self._lock:
            d = self._require(track_id)
            write_json_atomic(d / NOTES_FILE, notes.model_dump(mode="json"))

    # ------------------------------------------------------------------ vocal melody + stems (app.vocals)

    def read_vocals(self, track_id: str) -> Optional[bytes]:
        """The stored vocals.json (compact JSON bytes), or None when not transcribed yet (or unreadable)."""
        path = self._require(track_id) / VOCALS_FILE
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            return None
        try:
            data = json.loads(raw)
        except ValueError:
            log.warning("ignoring unreadable %s", path)
            return None
        if not isinstance(data, dict) or data.get("version") != VOCALS_VERSION or not isinstance(data.get("notes"), list):
            log.warning("ignoring %s with an unknown format", path)
            return None
        return raw

    def has_vocals(self, track_id: str) -> bool:
        """The vocals were transcribed and every stem is in place (a usable cached result)."""
        if self.read_vocals(track_id) is None:
            return False
        stems = self.track_dir(track_id) / STEMS_DIR
        return all((stems / f"{name}.mp3").is_file() for name in STEM_NAMES)

    def stem_path(self, track_id: str, name: str) -> Path:
        if name not in STEM_NAMES:
            raise TrackNotFound(track_id)
        path = self.track_dir(track_id) / STEMS_DIR / f"{name}.mp3"
        if not path.is_file():
            raise TrackNotFound(track_id)
        return path

    def install_vocals(self, track_id: str, staged_stems: Path, vocals: VocalNotes) -> None:
        """Move the separated stems (``<name>.mp3`` in ``staged_stems``) into the track, then write
        vocals.json and the summary fields in meta.json (readers see ``vocals`` only when all is there)."""
        dest = self._require(track_id) / STEMS_DIR
        dest.mkdir(exist_ok=True)
        staged: list[tuple[Path, Path]] = []
        try:
            for name in STEM_NAMES:  # copy next to the destination first (scratch may be another FS)
                src = staged_stems / f"{name}.mp3"
                if src.is_file():
                    tmp = dest / f".{name}.{secrets.token_hex(4)}.tmp"
                    try:
                        os.replace(src, tmp)
                    except OSError:
                        shutil.copyfile(src, tmp)
                    staged.append((tmp, dest / f"{name}.mp3"))
            with self._lock:
                d = self._require(track_id)
                for tmp, final in staged:
                    os.replace(tmp, final)
                write_json_atomic(d / VOCALS_FILE, vocals.model_dump(mode="json"))
                meta = read_json(d / META_FILE)
                meta.update({
                    "vocals": True,
                    "stems": [final.stem for _, final in staged],
                    "vocalsEngine": vocals.engine,
                    "vocalsAt": utc_now(),
                })
                _bump(meta)
                write_json_atomic(d / META_FILE, meta, pretty=True)
        finally:
            for tmp, _ in staged:
                tmp.unlink(missing_ok=True)
        log.info("track %s: vocals installed (%d notes)", track_id, len(vocals.notes))
        self._publish(track_id)

    # ------------------------------------------------------------------ create / update

    def install_track(self, staged_dir: Path, track_id: str, meta: dict[str, Any], analysis: AnalysisResult) -> bool:
        """Write meta/analysis into ``staged_dir`` (which already holds audio.mp3) and atomically move it
        into the library. Returns False when a complete track with this id appeared meanwhile (the
        staged copy is then left for the caller to discard)."""
        write_json_atomic(staged_dir / ANALYSIS_FILE, analysis.model_dump(mode="json"))
        write_json_atomic(staged_dir / META_FILE, {**meta, "version": 1}, pretty=True)
        with self._lock:
            if self.exists(track_id):
                return False
            dest = self.track_dir(track_id)
            if dest.exists():  # incomplete leftover (e.g. crash) — replace it
                self._discard_dir(dest)
            self.root.mkdir(parents=True, exist_ok=True)
            try:
                os.replace(staged_dir, dest)
            except OSError:  # scratch on another file system (cloud: /tmp -> bucket mount)
                _copy_tree_meta_last(staged_dir, dest)
                shutil.rmtree(staged_dir, ignore_errors=True)
        log.info("track %s installed (%s)", track_id, meta.get("title"))
        self._publish(track_id)
        return True

    def save_reanalysis(self, track_id: str, analysis: AnalysisResult, options: dict[str, Any]) -> None:
        with self._lock:
            d = self._require(track_id)
            write_json_atomic(d / ANALYSIS_FILE, analysis.model_dump(mode="json"))
            edits = d / EDITS_FILE
            if edits.exists():  # fresh detection replaces the user's edits; keep them as a backup
                os.replace(edits, d / EDITS_BACKUP_FILE)
            meta = read_json(d / META_FILE)
            now = utc_now()
            meta.update(summary_fields(analysis))
            meta.update({"updatedAt": now, "analyzedAt": now, "options": options, "engine": analysis.engine})
            _bump(meta)
            write_json_atomic(d / META_FILE, meta, pretty=True)
        self._publish(track_id)

    def patch(self, track_id: str, patch: TrackPatch) -> Track:
        fields = patch.model_fields_set
        with self._lock:
            d = self._require(track_id)
            meta = read_json(d / META_FILE)
            meta_changed = False
            if "title" in fields and patch.title is not None and patch.title.strip():
                meta["title"] = patch.title.strip()
                meta_changed = True
            if "artist" in fields:
                meta["artist"] = (patch.artist or "").strip() or None
                meta_changed = True
            if "chords" in fields and patch.chords is not None:
                chords = sorted(patch.chords, key=lambda c: (c.start, c.end))
                write_json_atomic(
                    d / EDITS_FILE,
                    {"chords": [c.model_dump(mode="json") for c in chords], "updatedAt": utc_now()},
                )
                meta_changed = True
            if meta_changed:
                meta["updatedAt"] = utc_now()
                _bump(meta)
                write_json_atomic(d / META_FILE, meta, pretty=True)
        if meta_changed:
            self._publish(track_id)
        return self.get_track(track_id)

    def reset(self, track_id: str) -> Track:
        with self._lock:
            d = self._require(track_id)
            edits = d / EDITS_FILE
            changed = edits.exists()
            if changed:  # nothing to reset is not a change a reader can see
                edits.unlink()
                meta = read_json(d / META_FILE)
                _bump(meta)
                write_json_atomic(d / META_FILE, meta, pretty=True)
        if changed:
            self._publish(track_id)
        return self.get_track(track_id)

    def delete(self, track_id: str) -> None:
        def remove() -> None:
            with self._lock:
                d = self.track_dir(track_id)
                if not d.exists():
                    raise TrackNotFound(track_id)
                self._discard_dir(d)

        # Cloud mode: the index document goes first, then the directory, under the publisher's track lock.
        self.publisher.delete_track(current_uid(), track_id, remove)
        log.info("track %s deleted", track_id)

    def _publish(self, track_id: str) -> None:
        """Cloud mode: bring the track's published copies up to date. Never raises; call it with ``_lock`` released."""
        uid = current_uid()
        if self.settings.cloud and uid:
            self.publisher.publish(uid, track_id)

    def _discard_dir(self, path: Path) -> None:
        """Move a directory out of the library first (atomic), then remove it."""
        self.work_root.mkdir(parents=True, exist_ok=True)
        trash = self.work_root / f"trash-{path.name}-{secrets.token_hex(4)}"
        try:
            os.replace(path, trash)
        except OSError:
            trash = path
        shutil.rmtree(trash, ignore_errors=True)

    # ------------------------------------------------------------------ read models

    def get_track(self, track_id: str) -> Track:
        try:
            meta = self.read_meta(track_id)
            analysis = self.read_analysis(track_id)
        except (OSError, ValueError) as exc:
            if isinstance(exc, FileNotFoundError):
                raise TrackNotFound(track_id) from exc
            raise
        edits = self.read_edits(track_id)
        chords = edits["chords"] if edits else analysis.get("chords", [])
        duration = analysis.get("duration") or meta.get("duration") or 0.0
        return Track.model_validate(
            {
                **self._summary_dict(track_id, meta, edited=edits is not None, chord_count=len(chords)),
                "duration": duration,
                "key": analysis.get("key"),
                "tempo": analysis.get("tempo"),
                "audioUrl": self.media_url(track_id, "audio"),
                "timeSignature": analysis.get("timeSignature") or 4,
                "beats": analysis.get("beats") or [],
                "downbeats": analysis.get("downbeats") or [],
                "chords": chords,
                "waveform": analysis.get("waveform") or [],
                "engine": analysis.get("engine") or meta.get("engine") or "",
                "startOffset": meta.get("startOffset") or None,
                "stemUrls": {name: self.media_url(track_id, f"{STEMS_DIR}/{name}") for name in _stems(meta)},
            }
        )

    def list_tracks(self) -> list[TrackSummary]:
        if not self.root.is_dir():
            return []
        dirs = list(self.root.iterdir())
        if self.settings.cloud and len(dirs) > 1:
            # On the bucket mount every stat/read is a network round trip: read the tracks in parallel
            # (each worker gets its own copy of this request's context, i.e. the same user).
            from concurrent.futures import ThreadPoolExecutor

            contexts = [contextvars.copy_context() for _ in dirs]  # copied here, in the request's thread
            with ThreadPoolExecutor(max_workers=min(16, len(dirs)), thread_name_prefix="chords-list") as pool:
                found = list(pool.map(lambda pair: pair[0].run(self._summary_of, pair[1]), zip(contexts, dirs)))
        else:
            found = [self._summary_of(d) for d in dirs]
        out = [t for t in found if t is not None]
        out.sort(key=lambda t: (t.created_at, t.id), reverse=True)
        return out

    def _summary_of(self, d: Path) -> Optional[TrackSummary]:
        if not d.is_dir() or not self.exists(d.name):
            return None
        try:
            meta = read_json(d / META_FILE)
            edits = self.read_edits(d.name)
            chord_count = len(edits["chords"]) if edits else meta.get("chordCount")
            return TrackSummary.model_validate(
                self._summary_dict(d.name, meta, edited=edits is not None, chord_count=chord_count)
            )
        except (OSError, ValueError):
            log.warning("skipping unreadable track %s", d.name, exc_info=True)
            return None

    @staticmethod
    def _summary_dict(track_id: str, meta: dict[str, Any], *, edited: bool, chord_count: Optional[int]) -> dict[str, Any]:
        return {
            "id": track_id,
            "title": meta.get("title") or "Untitled",
            "artist": meta.get("artist"),
            "duration": meta.get("duration") or 0.0,
            "thumbnail": meta.get("thumbnail"),
            "source": meta.get("source") or {"type": "file"},
            "key": meta.get("key"),
            "tempo": meta.get("tempo"),
            "chordCount": chord_count,
            "edited": edited,
            "vocals": bool(meta.get("vocals")),
            "stems": _stems(meta),
            "clip": meta.get("clip"),
            "createdAt": meta.get("createdAt") or utc_now(),
        }


def _bump(meta: dict[str, Any]) -> None:
    """Every change a reader can see gets a new version (phase 2: the published copies follow it)."""
    meta["version"] = int(meta.get("version") or 0) + 1


def _stems(meta: dict[str, Any]) -> list[str]:
    stems = meta.get("stems") if meta.get("vocals") else None
    return [s for s in stems if s in STEM_NAMES] if isinstance(stems, list) else []


def _copy_tree_meta_last(src: Path, dest: Path) -> None:
    """Copy a staged track directory into place; meta.json goes last, so ``exists()`` (which needs it)
    never sees a partially copied track."""
    dest.mkdir(parents=True, exist_ok=True)
    meta: Optional[Path] = None
    for item in sorted(src.iterdir()):
        if item.name == META_FILE:
            meta = item
        elif item.is_dir():
            shutil.copytree(item, dest / item.name, dirs_exist_ok=True)
        else:
            shutil.copyfile(item, dest / item.name)
    if meta is not None:
        shutil.copyfile(meta, dest / META_FILE)


def summary_fields(analysis: AnalysisResult) -> dict[str, Any]:
    """Fields cached in meta.json so the library list doesn't need to load analysis.json."""
    return {
        "duration": analysis.duration,
        "key": analysis.key.model_dump(mode="json") if analysis.key else None,
        "tempo": analysis.tempo,
        "chordCount": len(analysis.chords),
    }

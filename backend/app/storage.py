"""On-disk track library.

Layout (under ``Settings.data_dir``)::

    tracks/<trackId>/audio.mp3       playback file (served with HTTP Range support)
    tracks/<trackId>/analysis.json   engine output (detected chords, beats, waveform ...)
    tracks/<trackId>/meta.json       title, artist, source, createdAt, summary fields ...
    tracks/<trackId>/edits.json      user chord edits (optional; dropped by "reset")
    tracks/<trackId>/notes.json      live-piano notes transcribed in the browser (optional; kept on
                                     re-analysis since the audio does not change)
    .work/<jobId>/                   scratch space for running jobs (wiped on startup)

A track directory is assembled completely inside ``.work`` and then moved into ``tracks/`` with a
single atomic rename, so readers never observe half-written tracks. JSON files are written
atomically (temp file + ``os.replace``).
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .models import (
    NOTES_VERSION,
    AnalysisResult,
    Settings,
    Track,
    TrackNotes,
    TrackPatch,
    TrackSummary,
)

log = logging.getLogger("chords.storage")

AUDIO_FILE = "audio.mp3"
ANALYSIS_FILE = "analysis.json"
META_FILE = "meta.json"
EDITS_FILE = "edits.json"
EDITS_BACKUP_FILE = "edits.prev.json"
NOTES_FILE = "notes.json"

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
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.root = settings.tracks_dir
        self.work_root = settings.work_dir
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ lifecycle

    def init(self) -> None:
        """Create the directory layout and wipe scratch space left over from a previous run."""
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

    # ------------------------------------------------------------------ create / update

    def install_track(self, staged_dir: Path, track_id: str, meta: dict[str, Any], analysis: AnalysisResult) -> bool:
        """Write meta/analysis into ``staged_dir`` (which already holds audio.mp3) and atomically move it
        into the library. Returns False when a complete track with this id appeared meanwhile (the
        staged copy is then left for the caller to discard)."""
        write_json_atomic(staged_dir / ANALYSIS_FILE, analysis.model_dump(mode="json"))
        write_json_atomic(staged_dir / META_FILE, meta, pretty=True)
        with self._lock:
            if self.exists(track_id):
                return False
            dest = self.track_dir(track_id)
            if dest.exists():  # incomplete leftover (e.g. crash) — replace it
                self._discard_dir(dest)
            self.root.mkdir(parents=True, exist_ok=True)
            os.replace(staged_dir, dest)
        log.info("track %s installed (%s)", track_id, meta.get("title"))
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
            write_json_atomic(d / META_FILE, meta, pretty=True)

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
                write_json_atomic(d / META_FILE, meta, pretty=True)
        return self.get_track(track_id)

    def reset(self, track_id: str) -> Track:
        with self._lock:
            d = self._require(track_id)
            (d / EDITS_FILE).unlink(missing_ok=True)
        return self.get_track(track_id)

    def delete(self, track_id: str) -> None:
        with self._lock:
            d = self.track_dir(track_id)
            if not d.exists():
                raise TrackNotFound(track_id)
            self._discard_dir(d)
        log.info("track %s deleted", track_id)

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
                "audioUrl": f"/api/tracks/{track_id}/audio",
                "timeSignature": analysis.get("timeSignature") or 4,
                "beats": analysis.get("beats") or [],
                "downbeats": analysis.get("downbeats") or [],
                "chords": chords,
                "waveform": analysis.get("waveform") or [],
                "engine": analysis.get("engine") or meta.get("engine") or "",
            }
        )

    def list_tracks(self) -> list[TrackSummary]:
        if not self.root.is_dir():
            return []
        out: list[TrackSummary] = []
        for d in self.root.iterdir():
            if not d.is_dir() or not self.exists(d.name):
                continue
            try:
                meta = read_json(d / META_FILE)
                edits = self.read_edits(d.name)
                chord_count = len(edits["chords"]) if edits else meta.get("chordCount")
                out.append(
                    TrackSummary.model_validate(
                        self._summary_dict(d.name, meta, edited=edits is not None, chord_count=chord_count)
                    )
                )
            except (OSError, ValueError):
                log.warning("skipping unreadable track %s", d.name, exc_info=True)
        out.sort(key=lambda t: (t.created_at, t.id), reverse=True)
        return out

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
            "createdAt": meta.get("createdAt") or utc_now(),
        }


def summary_fields(analysis: AnalysisResult) -> dict[str, Any]:
    """Fields cached in meta.json so the library list doesn't need to load analysis.json."""
    return {
        "duration": analysis.duration,
        "key": analysis.key.model_dump(mode="json") if analysis.key else None,
        "tempo": analysis.tempo,
        "chordCount": len(analysis.chords),
    }

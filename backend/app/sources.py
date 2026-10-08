"""Media sources: URL normalization + yt-dlp download, streamed uploads, ffprobe/ffmpeg helpers."""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional, Protocol
from urllib.parse import parse_qs, unquote, urlsplit, urlunsplit

from starlette.requests import Request

from .models import ErrorCode

log = logging.getLogger("chords.sources")

ProgressCb = Callable[[float], None]

# Common audio + video containers accepted for upload (ffprobe is the real gate).
UPLOAD_EXTENSIONS = (
    "mp3 wav m4a aac flac ogg oga opus webm weba mp4 m4v mov mkv aiff aif caf 3gp amr wma"
).split()

_EXTRA_BIN_DIRS = ("/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin")


class SourceError(Exception):
    """A user-facing failure with an API error code (and optionally an explicit HTTP status)."""

    def __init__(
        self, code: ErrorCode, message: str, status: Optional[int] = None, *, detail: Optional[str] = None
    ) -> None:
        super().__init__(message)
        self.code: ErrorCode = code
        self.message = message
        self.status = status
        self.detail = detail  # yt-dlp's own message, for retry decisions (chords-fetch); never shown to users


class Cancelled(Exception):
    """Raised inside long operations when the owning job has been cancelled."""


# --------------------------------------------------------------------------- tools


def ensure_tool_path() -> None:
    """Make Homebrew/MacPorts binaries (ffmpeg, node, deno) reachable even when the server was launched
    from an environment with a minimal PATH (IDE, launchd). Existing PATH entries keep priority."""
    parts = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    added = [d for d in _EXTRA_BIN_DIRS if d not in parts and os.path.isdir(d)]
    if added:
        os.environ["PATH"] = os.pathsep.join(parts + added)


def find_executable(name: str) -> Optional[str]:
    return shutil.which(name) or next(
        (str(Path(d) / name) for d in _EXTRA_BIN_DIRS if os.access(Path(d) / name, os.X_OK)), None
    )


def ffmpeg_available() -> bool:
    return bool(find_executable("ffmpeg") and find_executable("ffprobe"))


def ytdlp_version() -> Optional[str]:
    try:
        from yt_dlp.version import __version__

        return str(__version__)
    except Exception:  # pragma: no cover - yt-dlp missing/broken
        return None


# --------------------------------------------------------------------------- URL normalization

_YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_YT_PATH_PREFIXES = ("shorts", "embed", "v", "e", "live", "watch")
_HOST_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$")


@dataclass(frozen=True)
class NormalizedUrl:
    url: str
    youtube_id: Optional[str] = None

    @property
    def source_type(self) -> str:
        return "youtube" if self.youtube_id else "url"

    @property
    def offline_track_key(self) -> Optional[str]:
        return f"youtube:{self.youtube_id}" if self.youtube_id else None


def youtube_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def youtube_thumbnail(video_id: str) -> str:
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"


def youtube_oembed(video_id: str, timeout: float = 6.0) -> tuple[Optional[str], Optional[str]]:
    """(title, channel) of a YouTube video from the public oEmbed endpoint; (None, None) on any failure."""
    import urllib.request
    from urllib.parse import quote

    if not _YT_ID_RE.fullmatch(video_id or ""):
        return None, None
    url = f"https://www.youtube.com/oembed?format=json&url={quote(youtube_url(video_id), safe='')}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "chords-listener"})
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 - fixed https host
            data = json.loads(res.read(256 * 1024).decode("utf-8"))
    except Exception as exc:
        log.info("oEmbed lookup for %s failed: %s", video_id, exc)
        return None, None
    title = str(data.get("title") or "").strip()[:300] or None
    author = _strip_topic(str(data.get("author_name") or "").strip()[:300] or None)
    return title, author


def _is_youtube_host(host: str) -> bool:
    if host in ("youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"):
        return True
    return host == "youtube.com" or host.endswith(".youtube.com")


def _youtube_id_from(host: str, path: str, query: dict[str, list[str]]) -> Optional[str]:
    segments = [s for s in path.split("/") if s]
    if host.endswith("youtu.be"):
        return segments[0] if segments and _YT_ID_RE.fullmatch(segments[0]) else None
    v = (query.get("v") or query.get("vi") or [""])[0]
    if _YT_ID_RE.fullmatch(v):
        return v
    if len(segments) >= 2 and segments[0] in _YT_PATH_PREFIXES and _YT_ID_RE.fullmatch(segments[1]):
        return segments[1]
    if segments and segments[0] == "attribution_link":
        inner = unquote((query.get("u") or [""])[0])
        if inner:
            parts = urlsplit(inner if "://" in inner else "https://www.youtube.com" + inner)
            return _youtube_id_from("www.youtube.com", parts.path, parse_qs(parts.query))
    return None


def normalize_url(raw: str) -> NormalizedUrl:
    """Validate a user-supplied link. YouTube links of any form collapse to the canonical watch URL of a
    single video (timestamps/playlist params dropped). Raises SourceError(invalid_url)."""
    text = (raw or "").strip()
    if not text or any(ch.isspace() for ch in text):
        raise SourceError("invalid_url", "Paste a link to a video or audio page")
    if _YT_ID_RE.fullmatch(text) and not re.fullmatch(r"[a-z]+", text):
        return NormalizedUrl(youtube_url(text), text)
    if "://" not in text:
        text = "https://" + text.lstrip("/")
    try:
        parts = urlsplit(text)
        host = (parts.hostname or "").lower().rstrip(".")
        parts.port  # noqa: B018 - raises ValueError on a malformed port
    except ValueError as exc:
        raise SourceError("invalid_url", "This doesn't look like a valid link") from exc
    if parts.scheme.lower() not in ("http", "https"):
        raise SourceError("invalid_url", "Only http(s) links are supported")
    if not host or not (_HOST_RE.fullmatch(host) or re.fullmatch(r"[0-9a-f:.]+", host)) or (
        "." not in host and ":" not in host and host != "localhost"
    ):
        raise SourceError("invalid_url", "This doesn't look like a valid link")

    if _is_youtube_host(host):
        query = parse_qs(parts.query)
        video_id = _youtube_id_from(host, parts.path, query)
        if video_id:
            return NormalizedUrl(youtube_url(video_id), video_id)
        if "list" in query:
            raise SourceError("invalid_url", "Playlist links aren't supported - open a single video and copy its link")
        raise SourceError("invalid_url", "This YouTube link doesn't point to a video")

    netloc = host if parts.port is None else f"{host}:{parts.port}"
    return NormalizedUrl(urlunsplit((parts.scheme.lower(), netloc, parts.path or "/", parts.query, "")))


def track_id_for(kind: str, ident: str) -> str:
    """Stable 12-hex track id for a remote source (``youtube:<videoId>``, ``<extractor>:<id>``)."""
    return hashlib.sha1(f"{kind}:{ident}".encode()).hexdigest()[:12]


# --------------------------------------------------------------------------- YouTube fragments

YT_CLIP_MAX_S = 60  # the longest fragment chords-fetch serves


def clip_track_key(video_id: str, start: int) -> str:
    """Track key of a YouTube fragment: one fragment = one track (``youtube:<videoId>@<start>``)."""
    return f"youtube:{video_id}@{int(start)}"


def clip_end(start: int, length: int, duration: Optional[float]) -> float:
    """End (video seconds) of the fragment that starts at ``start``: ``length`` seconds, cut at the video's end
    (a video shorter than that is taken whole). Raises SourceError(invalid_url) when ``start`` is past the end."""
    if duration is not None and start >= duration:
        raise SourceError("invalid_url", f"The fragment starts at {start} s but the video is only {duration:.0f} s long")
    end = float(start + length)
    return min(end, float(duration)) if duration is not None else end


@dataclass
class FetchedClip:
    path: Path
    title: str
    artist: Optional[str]
    duration: Optional[float]  # the whole video
    thumbnail: Optional[str]
    start: float
    end: float


class ClipFetcher(Protocol):
    def fetch(
        self, video_id: str, start: int, length: int, dest_dir: Path, progress: ProgressCb, cancel: threading.Event
    ) -> FetchedClip:
        """Download ``length`` seconds of the video from ``start`` into dest_dir. Raises SourceError / Cancelled."""


# --------------------------------------------------------------------------- remote media (yt-dlp)


@dataclass
class RemoteMedia:
    url: str
    extractor: str
    media_id: str
    title: str
    artist: Optional[str] = None
    duration: Optional[float] = None
    thumbnail: Optional[str] = None
    video_id: Optional[str] = None
    info: dict[str, Any] = field(default_factory=dict, repr=False)

    @property
    def track_key(self) -> str:
        return f"youtube:{self.video_id}" if self.video_id else f"{self.extractor}:{self.media_id}"

    @property
    def track_id(self) -> str:
        kind, _, ident = self.track_key.partition(":")
        return track_id_for(kind, ident)

    def source(self) -> dict[str, Any]:
        if self.video_id:
            return {"type": "youtube", "url": youtube_url(self.video_id), "videoId": self.video_id, "filename": None}
        return {"type": "url", "url": self.url, "videoId": None, "filename": None}


class UrlFetcher(Protocol):
    def offline_key(self, url: NormalizedUrl) -> Optional[str]:
        """Best-effort ``<extractor>:<id>`` without network access (for dedup before probing)."""

    def probe(self, url: NormalizedUrl) -> RemoteMedia:
        """Fetch metadata only. Raises SourceError."""

    def download(self, media: RemoteMedia, dest_dir: Path, progress: ProgressCb, cancel: threading.Event) -> Path:
        """Download the best audio into dest_dir and return the file path. Raises SourceError/Cancelled."""


_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
AUDIO_FORMAT = "bestaudio/best"


def _clean_ytdlp_message(msg: str) -> str:
    msg = _ANSI_RE.sub("", str(msg)).strip()
    msg = re.sub(r"^(ERROR:\s*)+", "", msg)
    msg = re.sub(r"^\[[^\]]+\]\s*", "", msg)  # "[youtube] " extractor prefix
    msg = re.sub(r"^[A-Za-z0-9_-]{6,}:\s+", "", msg)  # "<videoId>: " prefix
    msg = msg.split("\n")[0].strip()
    return (msg[:280] + "...") if len(msg) > 280 else msg


# YouTube refusing a (data-center) server: bot check, sign-in wall, 403/429 on the media URLs, or every
# stream withheld. The client then offers to capture the audio in the browser tab (docs/CLOUD.md → YouTube).
_BLOCKED_PATTERNS = (
    "sign in to confirm",  # "Sign in to confirm you're not a bot" / "... your age"
    "not a bot",
    "--cookies-from-browser",
    "http error 403",
    "403: forbidden",
    "status code 403",
    "http error 429",
    "too many requests",
    "the following content is not available on this app",
    "this content isn't available, try again later",
)
_YOUTUBE_BLOCKED_PATTERNS = ("requested format is not available", "only images are available")


def is_blocked_message(message: str, youtube: bool = False) -> bool:
    low = _ANSI_RE.sub("", message).lower().replace("’", "'")
    return any(p in low for p in _BLOCKED_PATTERNS) or (youtube and any(p in low for p in _YOUTUBE_BLOCKED_PATTERNS))


_BOT_CHECK_PATTERNS = ("sign in to confirm", "not a bot", "--cookies-from-browser")


def is_bot_check(message: str) -> bool:
    """YouTube's bot check / sign-in wall (a new WARP session may pass it), as opposed to a refused media URL
    (HTTP 403 on the stream, fixed by a fresh extraction)."""
    low = _ANSI_RE.sub("", message or "").lower().replace("’", "'")
    return any(p in low for p in _BOT_CHECK_PATTERNS)


def _map_ytdlp_error(exc: BaseException, youtube: bool = False) -> SourceError:
    raw = _ANSI_RE.sub("", str(exc)).strip()[:1000]
    msg = _clean_ytdlp_message(str(exc))
    low = msg.lower()
    if is_blocked_message(str(exc), youtube):
        return SourceError(
            "download_blocked",
            "YouTube refused the download from the server (bot check). Play the video and use "
            "\"listen in this tab\", or upload the audio file.",
            detail=raw,
        )
    if "unsupported url" in low or "is not a valid url" in low:
        return SourceError("invalid_url", "This link isn't supported", detail=raw)
    if any(s in low for s in ("getaddrinfo", "nodename nor servname", "name or service not known", "timed out",
                              "connection refused", "network is unreachable", "unable to download webpage")):
        return SourceError("download_failed", f"Network error: {msg}" if msg else "Network error", detail=raw)
    return SourceError("download_failed", msg or "Download failed", detail=raw)


class _YtdlLogger:
    def debug(self, msg: str) -> None:
        if not msg.startswith("[debug] "):
            log.debug("yt-dlp: %s", msg)

    def info(self, msg: str) -> None:
        log.debug("yt-dlp: %s", msg)

    def warning(self, msg: str) -> None:
        log.info("yt-dlp warning: %s", _clean_ytdlp_message(msg))

    def error(self, msg: str) -> None:
        log.warning("yt-dlp error: %s", _clean_ytdlp_message(msg))


def _js_runtimes() -> dict[str, dict[str, str]]:
    """YouTube needs a JS runtime for signature/n-challenge solving (yt-dlp-ejs). Enable whatever is
    installed, deno first (yt-dlp's preferred runtime), then node, then bun."""
    runtimes: dict[str, dict[str, str]] = {}
    for name in ("deno", "node", "bun"):
        path = find_executable(name)
        if path:
            runtimes[name] = {"path": path}
    return runtimes


def _strip_topic(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    name = str(name).strip()
    return name[: -len(" - Topic")].strip() if name.endswith(" - Topic") else name or None


class YtDlpFetcher:
    """UrlFetcher backed by the yt-dlp Python API."""

    def __init__(self, max_bytes: int, proxy: Optional[str] = None, ffmpeg_proxy: Optional[str] = None) -> None:
        self.max_bytes = max_bytes
        self.proxy = proxy  # e.g. socks5h://127.0.0.1:40000 (chords-fetch: Cloudflare WARP)
        self.ffmpeg_proxy = ffmpeg_proxy  # http://… (CONNECT) proxy for ffmpeg, which cuts fragments and can't use SOCKS

    def _opts(self, **extra: Any) -> dict[str, Any]:
        opts: dict[str, Any] = {
            "quiet": True,
            "no_warnings": False,
            "noprogress": True,
            "noplaylist": True,
            "playlist_items": "1",
            "socket_timeout": 20,
            "retries": 3,
            "fragment_retries": 3,
            "extractor_retries": 2,
            "logger": _YtdlLogger(),
            "consoletitle": False,
        }
        runtimes = _js_runtimes()
        if runtimes:
            opts["js_runtimes"] = runtimes
        ffmpeg = find_executable("ffmpeg")
        if ffmpeg:
            opts["ffmpeg_location"] = str(Path(ffmpeg).parent)
        if self.proxy:
            opts["proxy"] = self.proxy
        opts.update(extra)
        return opts

    def offline_key(self, url: NormalizedUrl) -> Optional[str]:
        if url.youtube_id:
            return f"youtube:{url.youtube_id}"
        try:
            from yt_dlp.extractor import gen_extractor_classes

            for ie in gen_extractor_classes():
                if ie.ie_key() == "Generic" or not ie.suitable(url.url):
                    continue
                temp_id = ie.get_temp_id(url.url)
                return f"{ie.ie_key().lower()}:{temp_id}" if temp_id else None
        except Exception:  # pragma: no cover - extractor quirks must never break job creation
            log.debug("offline_key failed for %s", url.url, exc_info=True)
        return None

    def probe(self, url: NormalizedUrl) -> RemoteMedia:
        import yt_dlp

        try:
            with yt_dlp.YoutubeDL(self._opts(format=AUDIO_FORMAT)) as ydl:
                info = ydl.extract_info(url.url, download=False)
        except yt_dlp.utils.DownloadError as exc:
            raise _map_ytdlp_error(exc, youtube=bool(url.youtube_id)) from exc
        if not info:
            raise SourceError("download_failed", "Couldn't read this link")
        if info.get("_type") == "playlist" or "entries" in info:
            entries = [e for e in (info.get("entries") or []) if e]
            if not entries:
                raise SourceError("invalid_url", "This link has no playable media")
            info = entries[0]
        if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming", "post_live"):
            raise SourceError("invalid_url", "Live streams can't be analyzed - try again when the stream has ended")

        extractor = str(info.get("extractor_key") or info.get("extractor") or "generic").lower()
        media_id = str(info.get("id") or "")
        if not media_id:
            raise SourceError("download_failed", "Couldn't identify the media behind this link")
        video_id = media_id if extractor == "youtube" and _YT_ID_RE.fullmatch(media_id) else None

        track, artist = info.get("track"), info.get("artist") or (info.get("artists") or [None])[0]
        if track and artist:
            title, performer = str(track), str(artist)
        else:
            title = str(info.get("title") or info.get("fulltitle") or media_id)
            performer = _strip_topic(artist or info.get("uploader") or info.get("channel") or info.get("creator"))
        duration = info.get("duration")
        return RemoteMedia(
            url=str(info.get("webpage_url") or url.url),
            extractor=extractor,
            media_id=media_id,
            title=title.strip() or media_id,
            artist=performer,
            duration=float(duration) if isinstance(duration, (int, float)) and duration > 0 else None,
            thumbnail=youtube_thumbnail(video_id) if video_id else info.get("thumbnail"),
            video_id=video_id,
            info=info,
        )

    def download(self, media: RemoteMedia, dest_dir: Path, progress: ProgressCb, cancel: threading.Event) -> Path:
        return self._download(media, dest_dir, progress, cancel)

    def download_clip(
        self, media: RemoteMedia, start: float, end: float, dest_dir: Path, progress: ProgressCb, cancel: threading.Event
    ) -> Path:
        """Only ``[start, end]`` of the media: yt-dlp's download_ranges has ffmpeg fetch and cut just that part."""
        from yt_dlp.utils import download_range_func

        # re-encode the 30 s: a stream-copy cut snaps to a seek point and the audio would not start at `start`
        extra: dict[str, Any] = {
            "download_ranges": download_range_func(None, [(start, end)]),
            "force_keyframes_at_cuts": True,
        }
        # ffmpeg does the cut and can't use SOCKS or yt-dlp's env proxy: its input gets the HTTP CONNECT proxy.
        # ffmpeg gives up on a network stall after 20 s (-rw_timeout, µs) instead of hanging; the attempt is then retried
        extra["external_downloader_args"] = {
            "ffmpeg_i": [*(["-http_proxy", self.ffmpeg_proxy] if self.ffmpeg_proxy else []), "-rw_timeout", "20000000"]
        }
        return self._download(media, dest_dir, progress, cancel, **extra)

    def _download(
        self, media: RemoteMedia, dest_dir: Path, progress: ProgressCb, cancel: threading.Event, **extra: Any
    ) -> Path:
        import yt_dlp

        def hook(d: dict[str, Any]) -> None:
            if cancel.is_set():
                raise yt_dlp.utils.DownloadCancelled("cancelled")
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                done = d.get("downloaded_bytes") or 0
                if total:
                    progress(min(1.0, done / total))
                elif d.get("fragment_count"):
                    progress(min(1.0, (d.get("fragment_index") or 0) / d["fragment_count"]))
            elif d.get("status") == "finished":
                progress(1.0)

        opts = self._opts(
            format=AUDIO_FORMAT,
            outtmpl={"default": "source.%(ext)s"},
            paths={"home": str(dest_dir), "temp": str(dest_dir)},
            progress_hooks=[hook],
            max_filesize=self.max_bytes,
            overwrites=True,
            continuedl=False,
            writethumbnail=False,
            **extra,
        )
        def run(fresh: bool) -> Optional[dict[str, Any]]:
            with yt_dlp.YoutubeDL(opts) as ydl:
                if fresh:
                    return ydl.extract_info(media.url, download=True)
                return ydl.process_ie_result(dict(media.info), download=True)

        result: Optional[dict[str, Any]] = None
        for fresh in ((False, True) if media.info else (True,)):
            try:
                result = run(fresh)
                break
            except yt_dlp.utils.DownloadCancelled as exc:
                raise Cancelled() from exc
            except yt_dlp.utils.DownloadError as exc:
                if cancel.is_set():
                    raise Cancelled() from exc
                if fresh:
                    raise _map_ytdlp_error(exc, youtube=bool(media.video_id)) from exc
                # Pre-extracted stream URLs can be rejected (e.g. YouTube 403); re-extract and retry once.
                log.info("download from cached info failed (%s); re-extracting", _clean_ytdlp_message(str(exc)))
                for leftover in dest_dir.glob("source.*"):
                    leftover.unlink(missing_ok=True)
        if cancel.is_set():
            raise Cancelled()

        candidates: list[Path] = []
        for item in (result or {}).get("requested_downloads") or []:
            if item.get("filepath"):
                candidates.append(Path(item["filepath"]))
        candidates += sorted(dest_dir.glob("source.*"))
        for path in candidates:
            if path.is_file() and path.suffix not in (".part", ".ytdl", ".tmp") and path.stat().st_size > 0:
                return path
        size = (result or {}).get("filesize") or (result or {}).get("filesize_approx")
        if isinstance(size, (int, float)) and size > self.max_bytes:
            raise SourceError("too_large", "The media file is too large")
        raise SourceError("download_failed", "The download produced no audio file")


class LocalClipFetcher:
    """ClipFetcher in this process with yt-dlp: the local server, dev, and chords-fetch (with a WARP proxy)."""

    def __init__(self, ytdlp: YtDlpFetcher) -> None:
        self.ytdlp = ytdlp

    def fetch(
        self, video_id: str, start: int, length: int, dest_dir: Path, progress: ProgressCb, cancel: threading.Event
    ) -> FetchedClip:
        if not _YT_ID_RE.fullmatch(video_id or ""):
            raise SourceError("invalid_url", "This YouTube link doesn't point to a video")
        media = self.ytdlp.probe(NormalizedUrl(youtube_url(video_id), video_id))
        end = clip_end(start, length, media.duration)
        if cancel.is_set():
            raise Cancelled()
        path = self.ytdlp.download_clip(media, float(start), end, dest_dir, progress, cancel)
        return FetchedClip(
            path=path,
            title=media.title,
            artist=media.artist,
            duration=media.duration,
            thumbnail=media.thumbnail or youtube_thumbnail(video_id),
            start=float(start),
            end=end,
        )


# --------------------------------------------------------------------------- ffprobe / ffmpeg


@dataclass
class ProbeResult:
    duration: Optional[float]
    has_audio: bool
    title: Optional[str] = None
    artist: Optional[str] = None
    format_name: Optional[str] = None


def _tag(tags: dict[str, Any], *names: str) -> Optional[str]:
    lowered = {str(k).lower(): v for k, v in (tags or {}).items()}
    for n in names:
        v = lowered.get(n)
        if isinstance(v, str) and v.strip():
            return v.strip()[:300]
    return None


def probe_media(path: Path) -> ProbeResult:
    """Inspect a media file with ffprobe. Raises SourceError(unsupported_format) if it isn't media."""
    ffprobe = find_executable("ffprobe")
    if not ffprobe:
        raise SourceError("internal", "ffprobe is not installed")
    try:
        proc = subprocess.run(
            [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired as exc:
        raise SourceError("unsupported_format", "Couldn't read this file") from exc
    if proc.returncode != 0:
        raise SourceError("unsupported_format", "This file isn't a supported audio or video format")
    try:
        data = json.loads(proc.stdout or "{}")
    except ValueError as exc:
        raise SourceError("unsupported_format", "Couldn't read this file") from exc
    fmt = data.get("format") or {}
    streams = data.get("streams") or []
    audio = [s for s in streams if s.get("codec_type") == "audio"]

    def _num(v: Any) -> Optional[float]:
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        return f if math.isfinite(f) and f > 0 else None

    stream_durations = [d for d in (_num(s.get("duration")) for s in audio) if d]
    duration = _num(fmt.get("duration")) or (max(stream_durations) if stream_durations else None)
    tags = dict(fmt.get("tags") or {})
    for s in audio:  # ogg/opus keep their tags on the stream
        for k, v in (s.get("tags") or {}).items():
            tags.setdefault(k, v)
    return ProbeResult(
        duration=duration,
        has_audio=bool(audio),
        title=_tag(tags, "title"),
        artist=_tag(tags, "artist", "album_artist", "albumartist", "performer"),
        format_name=fmt.get("format_name"),
    )


def transcode_to_mp3(
    src: Path, dst: Path, duration: Optional[float], progress: ProgressCb, cancel: threading.Event
) -> None:
    """Transcode the first audio stream of ``src`` into a 192k stereo mp3 at ``dst`` (atomic)."""
    ffmpeg = find_executable("ffmpeg")
    if not ffmpeg:
        raise SourceError("internal", "ffmpeg is not installed")
    tmp = dst.with_name(f".{dst.stem}.partial.mp3")
    cmd = [
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(src), "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
        "-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k",
        "-progress", "pipe:1", "-nostats", str(tmp),
    ]
    with tempfile.TemporaryFile() as errfile:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errfile, text=True)
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                if cancel.is_set():
                    proc.kill()
                    raise Cancelled()
                key, _, value = line.strip().partition("=")
                if key in ("out_time_us", "out_time_ms") and duration and value.isdigit():
                    progress(min(1.0, int(value) / 1e6 / duration))
            proc.wait()
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        if proc.returncode != 0 or not tmp.is_file() or tmp.stat().st_size == 0:
            errfile.seek(0)
            detail = errfile.read().decode("utf-8", "replace").strip().splitlines()
            log.warning("ffmpeg failed for %s: %s", src.name, detail[-3:] if detail else proc.returncode)
            tmp.unlink(missing_ok=True)
            raise SourceError("unsupported_format", "Couldn't decode the audio in this file")
    os.replace(tmp, dst)
    progress(1.0)


# --------------------------------------------------------------------------- streamed uploads


@dataclass
class ReceivedUpload:
    path: Path
    filename: str
    size: int
    sha1: str
    options: Optional[dict[str, Any]] = None

    @property
    def work_dir(self) -> Path:
        return self.path.parent


def safe_suffix(filename: str) -> str:
    ext = Path(filename).suffix.lower().lstrip(".")
    return f".{ext}" if re.fullmatch(r"[a-z0-9]{1,8}", ext) else ".bin"


def display_name(filename: str) -> str:
    """Human title from a file name: drop the extension, turn separators into spaces."""
    stem = Path(filename).stem if Path(filename).suffix.lower().lstrip(".") in UPLOAD_EXTENSIONS else filename
    stem = re.sub(r"[_]+", " ", stem).strip()
    return re.sub(r"\s{2,}", " ", stem)[:300] or "Untitled"


async def receive_upload(request: Request, dest_dir: Path, max_bytes: int) -> ReceivedUpload:
    """Stream a multipart/form-data body straight to disk (no temp spooling), hashing on the fly.

    Expects a file part named ``file`` and an optional small text part ``options`` (JSON). Raises
    SourceError(too_large) once the file exceeds ``max_bytes`` (the rest of the body is drained so the
    client still receives the error response).
    """
    from python_multipart.multipart import MultipartParser, parse_options_header

    ctype, params = parse_options_header(request.headers.get("content-type", ""))
    boundary = params.get(b"boundary")
    if ctype != b"multipart/form-data" or not boundary:
        raise SourceError("unsupported_format", 'Upload the file as multipart/form-data in a "file" field', 400)
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > max_bytes + 1024 * 1024:
        await _drain(request)
        raise SourceError("too_large", _too_large_message(max_bytes))

    state: dict[str, Any] = {"name": None, "filename": None, "is_file": False, "field": bytearray()}
    header_name, header_value = bytearray(), bytearray()
    headers: dict[bytes, bytes] = {}
    pending: list[bytes] = []
    fields: dict[str, str] = {}
    result: dict[str, Any] = {}
    hasher = hashlib.sha1()
    out = {"fh": None, "size": 0, "path": None, "done": False}
    too_large = False

    def on_part_begin() -> None:
        headers.clear()
        state.update(name=None, filename=None, is_file=False, field=bytearray())

    def on_header_field(data: bytes, start: int, end: int) -> None:
        header_name.extend(data[start:end])

    def on_header_value(data: bytes, start: int, end: int) -> None:
        header_value.extend(data[start:end])

    def on_header_end() -> None:
        headers[bytes(header_name).lower()] = bytes(header_value)
        header_name.clear()
        header_value.clear()

    def on_headers_finished() -> None:
        _, opts = parse_options_header(headers.get(b"content-disposition", b""))
        name = opts.get(b"name", b"").decode("utf-8", "replace")
        state["name"] = name
        if b"filename" in opts:
            state["filename"] = opts[b"filename"].decode("utf-8", "replace")
            state["is_file"] = name == "file" and out["path"] is None and not out["done"]
            if state["is_file"]:
                path = dest_dir / ("upload" + safe_suffix(state["filename"]))
                out["path"], out["fh"] = path, open(path, "wb")

    def on_part_data(data: bytes, start: int, end: int) -> None:
        if state["is_file"]:
            pending.append(data[start:end])
        elif state["filename"] is None and len(state["field"]) < 65536:
            state["field"].extend(data[start:end])

    def on_part_end() -> None:
        if state["is_file"]:
            state["is_file"] = False
            out["done"] = True
            result["filename"] = state["filename"]
        elif state["filename"] is None and state["name"]:
            fields[state["name"]] = state["field"].decode("utf-8", "replace")

    parser = MultipartParser(
        boundary,
        {
            "on_part_begin": on_part_begin,
            "on_part_data": on_part_data,
            "on_part_end": on_part_end,
            "on_header_field": on_header_field,
            "on_header_value": on_header_value,
            "on_header_end": on_header_end,
            "on_headers_finished": on_headers_finished,
        },
    )
    try:
        async for chunk in request.stream():
            if too_large:
                continue  # drain
            parser.write(chunk)
            if pending and out["fh"] is not None:
                for piece in pending:
                    out["size"] += len(piece)
                    if out["size"] > max_bytes:
                        too_large = True
                        break
                    hasher.update(piece)
                    out["fh"].write(piece)
                pending.clear()
        if not too_large:
            parser.finalize()
    except SourceError:
        raise
    except Exception as exc:
        raise SourceError("unsupported_format", "The upload was malformed or interrupted", 400) from exc
    finally:
        if out["fh"] is not None:
            out["fh"].close()

    if too_large:
        raise SourceError("too_large", _too_large_message(max_bytes))
    if out["path"] is None or not out["done"]:
        raise SourceError("unsupported_format", 'No file was uploaded (expected a "file" field)', 400)
    if out["size"] == 0:
        raise SourceError("unsupported_format", "The uploaded file is empty")

    options: Optional[dict[str, Any]] = None
    if fields.get("options"):
        try:
            parsed = json.loads(fields["options"])
            options = parsed if isinstance(parsed, dict) else None
        except ValueError:
            log.warning("ignoring malformed upload options: %.100s", fields["options"])
    filename = (result.get("filename") or "").replace("\\", "/").rsplit("/", 1)[-1].strip() or "audio"
    return ReceivedUpload(path=out["path"], filename=filename[:255], size=out["size"], sha1=hasher.hexdigest(), options=options)


def _too_large_message(max_bytes: int) -> str:
    return f"The file is larger than the {round(max_bytes / (1024 * 1024), 2):g} MB limit"


async def _drain(request: Request) -> None:
    async for _ in request.stream():
        pass

# YouTube clips through Cloudflare WARP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user pastes a YouTube link on any device, picks a 30-second fragment, and the cloud downloads only that fragment through a separate `chords-fetch` service (Cloudflare WARP) and turns it into a track with chords aligned to the video.

**Architecture:** A new small FastAPI service `chords-fetch` (Cloud Run, Direct VPC egress + Cloud NAT, wireproxy as a userspace WARP SOCKS5 proxy) downloads `[start, start+30]` with yt-dlp `download_ranges` and leaves the file in the Firebase bucket under `fetch/`. `chords-api` gets `POST /api/jobs {url, clip: {start}}`: it calls `chords-fetch` with a Google ID token (`RemoteClipFetcher`), takes and deletes the object, and analyzes it like a tab recording linked to the video (`startOffset = start`, new field `clip`). The web client gets a fragment picker page (`#/youtube/<videoId>`), routes signed-in users' YouTube links there, stops playback of clip tracks at `clip.end`, and falls back to «Слухати у вкладці» at the fragment's start.

**Tech Stack:** Python 3.11, FastAPI, pydantic v2, yt-dlp 2026.8.19, google-cloud-storage, google-auth, pytest; wireproxy (Go) + wgcf; Cloud Run, Cloud NAT, Secret Manager, Cloud Build; React 19 + TypeScript + Vite, vitest, Tailwind tokens already in the app.

**Spec:** `docs/superpowers/specs/2026-10-07-youtube-warp-fetch-design.md` (read it before starting; this plan argues from it).

## Global Constraints

- Work only in the worktree `.claude/worktrees/youtube-warp` on branch `youtube-warp`. Never touch the `admin` branch or the main checkout.
- Fragment length: exactly 30 s. Server: `CHORDS_YT_CLIP_S` (default `30`, clamped to `1..60`). Client: `CLIP_SECONDS = 30`. Keep the two equal.
- Fragment start: whole seconds, `0..86400`. `end = min(start + 30, videoDuration)`; a video shorter than 30 s is taken whole.
- Track key of a fragment: `youtube:<videoId>@<start>` → `track_id_for("youtube", "<videoId>@<start>")`. Full-video tracks keep `youtube:<videoId>`.
- Video id: `^[A-Za-z0-9_-]{11}$`. `chords-fetch` never accepts URLs.
- `chords-fetch` `POST /clip` body `{videoId, start, length}` with `length` `1..60`; anything else → HTTP 400 `{code: "invalid_url", message}`.
- Only the existing error codes: `invalid_url`, `download_failed`, `download_blocked`, `too_large`, `unavailable` (+ the rest of `ErrorCode`). Busy message, verbatim: `The server is busy, try again in a minute`.
- `chords-fetch` Cloud Run: `europe-west1`, gen2, 1 vCPU / 1 GiB, request-based billing, concurrency 1, min 0 / max `FETCH_MAX_INSTANCES` (default 3), timeout 300 s, `--no-allow-unauthenticated`, Direct VPC egress `all-traffic` on network `default` / subnet `default`.
- wireproxy: `github.com/windtf/wireproxy/cmd/wireproxy@v1.1.3` (the spike's build); SOCKS5 `127.0.0.1:40000`; yt-dlp proxy `socks5h://127.0.0.1:40000`; readiness = `https://www.cloudflare.com/cdn-cgi/trace` contains `warp=on`.
- yt-dlp in the fetch image = the version `backend/uv.lock` locks (2026.8.19); a test enforces it.
- One WARP profile, secret `warp-profile` in Secret Manager. Never print it, never write it into the repo, never commit `.cloud.env`.
- `chords-fetch` logs one line per request (videoId, start, length, outcome, attempts, seconds) and never a user id or the egress IP.
- Ukrainian UI copy speaks informally («ти»): the repo's i18n says so and `src/i18n/tour.test.ts` enforces it for tours. The spec's «Увійдіть…» becomes «Увійди…».
- Commit messages follow the repo style (`Area: what changed`, imperative, no trailing period) and end with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Commands: backend tests `cd backend && uv run pytest <files> -q`; frontend tests `cd frontend && npx vitest run <files>`; frontend types `cd frontend && npx tsc -b`; lint `cd frontend && npm run lint`.
- Deploy scripts create billable cloud resources and register a Cloudflare device: they run only in Task 18, and only with the owner's explicit go-ahead.

## Deviations from the spec (decided here)

1. `RemoteClipFetcher` tests use a fake HTTP session object instead of a fake HTTP server (same behaviour under test, no sockets).
2. yt-dlp keeps the backend's `retries: 3` inside `chords-fetch` (the spec said `--retries 2`); the service's own retry loop (3 attempts + 1 after a WARP reconnect) is what the spec's retry table describes.
3. `Job` carries `clip` too (the spec says the range comes back "in the job / track"), so the job page can send a blocked fragment to «Слухати у вкладці» at `t=start`.
4. The shared gcloud plumbing of `deploy_cloud.sh` (credentials, Cloud Build wait loop) moves to `scripts/gcloud_common.sh`, sourced by both deploy scripts, instead of being copied into `deploy_fetch.sh`.
5. A YouTube link's own `t=` (`?t=72`, `?t=1m12s`) becomes the picker's default start.

## Review Focus

1. **A window at the end of the video / a short video / an unknown length.** `start + 30 > duration` must end at the video's end, a 20 s video must be taken whole, `duration` `None` must trust the window, and the picker must never offer a start past `duration − 30`. Pinned by `test_clip_end` (Task 2) and `clipWindow.test.ts` (Task 12).
2. **The same fragment twice at once** (double tap, two tabs, phone + laptop). One running job, one download, one quota unit. Pinned by `test_the_same_fragment_twice_at_once_is_one_job` (Task 4).
3. **A malformed or hostile `chords-fetch` answer.** A `path` outside `fetch/` (e.g. `users/alice/tracks/x/audio.mp3`) must never be downloaded or deleted. Pinned by `test_an_answer_outside_fetch_is_refused_and_nothing_is_deleted` (Task 3).
4. **Play pressed after the fragment ended.** A clip track paused at `clip.end` must start the fragment again, not run on into the rest of the video. Pinned by `clipBounds.test.ts` (Task 15).
5. **A job cancelled (track deleted, server stopping) mid-fetch.** The object in `fetch/` must still be deleted and the job must end without leftovers. Pinned by `test_cancel_before_the_download_still_deletes_the_object` (Task 3) and the `work_leftovers` asserts (Task 4).

## File map

Backend (`backend/`):
- `app/models.py` — `ClipRange`, `ClipRequest`, `clip` on `TrackSummary` / `Job` / `CreateJobRequest`; `Settings.fetch_url`, `Settings.clip_s`.
- `app/storage.py` — `_summary_dict` passes `clip` through (track JSON, `track.json`, Firestore index follow).
- `app/sources.py` — `SourceError.detail`, `is_bot_check`, `clip_track_key`, `clip_end`, `FetchedClip`, `ClipFetcher`, `YtDlpFetcher(proxy=)`, `YtDlpFetcher.download_clip`, `LocalClipFetcher`.
- `app/gcs.py` — `FETCH_PREFIX`, `FETCH_GLOB`, `UploadBucket.upload`.
- `app/fetch_client.py` (new) — `RemoteClipFetcher`, `google_id_token` (chords-api → chords-fetch).
- `app/jobs.py` — clip jobs (`submit_url(..., clip_start=)`, `_submit_clip`, `_run_clip`, `JobRecord.clip`).
- `app/main.py` — `create_job` passes `clip`, `_clip_fetcher` choice, hourly bucket sweep incl. `fetch/**`.
- `app/warp.py` (new) — wireproxy lifecycle + readiness.
- `app/fetch_service.py` (new) — the `chords-fetch` FastAPI app.
- `fetch.Dockerfile`, `fetch.cloudbuild.yaml` (new); `.gcloudignore` (allow `fetch.Dockerfile`).
- Tests: `tests/test_clips.py`, `tests/test_fetch_client.py`, `tests/test_warp.py`, `tests/test_fetch_service.py`, `tests/test_fetch_image.py` (new); `tests/test_cloud.py` (additions).

Scripts: `scripts/gcloud_common.sh` (new, sourced), `scripts/deploy_fetch.sh` (new), `scripts/deploy_cloud.sh` (sources the common file, sets `CHORDS_FETCH_URL`), `scripts/smoke_fetch.py` (new).

Frontend (`frontend/src/`):
- `types.ts` — `ClipRange`, `clip` on `Job` / `TrackSummary`.
- `lib/api.ts` — `createClipJob`. `hooks/useJobs.ts` — `submitClip`, `blockedPath`, retry of clip jobs.
- `hooks/useRoute.ts` — route `clip` (`#/youtube/<id>[?t=]`), `start` on `capture`.
- `components/input/url.ts` — `linkTarget` → `'clip'`, `parseYouTubeStart`. `components/input/startLink.ts`, `components/input/SmartInput.tsx`.
- `components/clip/clipWindow.ts`, `components/clip/ClipTimeline.tsx`, `components/clip/ClipPage.tsx` (new); `App.tsx`.
- `components/player/sources/youtubeApi.ts` — shared `videoTitle`.
- `components/jobs/JobPage.tsx`, `components/capture/CapturePage.tsx`, `components/capture/machine.ts`.
- `components/player/clipBounds.ts` (new), `components/player/engine.ts`, `store.ts`, `components/ui/format.ts`, `components/history/RecentTracks.tsx`, `components/layout/TrackTitleBar.tsx`.
- `lib/tour/tours.ts`, `lib/tour/trigger.ts`, `i18n/tour.ts`, `i18n/clip.ts` (new), `i18n/index.ts`, `i18n/cloud.ts`.

Docs: `README.md`, `docs/SPEC.md`, `docs/CLOUD.md`.

---

### Task 1: Backend clip fields (models, settings, track and job JSON)

**Files:**
- Modify: `backend/app/models.py` (Settings, `TrackSummary`, `Job`, `CreateJobRequest`; new `ClipRange`, `ClipRequest`)
- Modify: `backend/app/storage.py:496-511` (`_summary_dict`)
- Modify: `backend/app/jobs.py:66-107` (`JobRecord`)
- Test: `backend/tests/test_clips.py` (new)

**Interfaces:**
- Produces: `ClipRange(start: float, end: float)` (camelCase JSON `{start, end}`); `ClipRequest(start: int)`; `CreateJobRequest.clip: Optional[ClipRequest]`; `TrackSummary.clip` / `Track.clip` / `Job.clip: Optional[ClipRange]`; `Settings.fetch_url: str` (`CHORDS_FETCH_URL`, trailing `/` stripped), `Settings.clip_s: int` (`CHORDS_YT_CLIP_S`, default 30, clamped 1..60); `JobRecord.clip: Optional[dict[str, float]]`; meta key `"clip": {"start", "end"}` in `meta.json`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_clips.py`:

```python
"""YouTube fragments (docs/superpowers/specs/2026-10-07-youtube-warp-fetch-design.md): the request and track
fields, the clip download helpers, clip jobs. Offline: yt-dlp and the clip fetcher are fakes."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.jobs import JobRecord
from app.models import ClipRange, CreateJobRequest, Settings, TrackSummary
from app.storage import TrackStore

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

VIDEO_ID = "dQw4w9WgXcQ"


# --------------------------------------------------------------------------- request, settings, JSON


def test_create_job_request_takes_a_whole_second_clip_start() -> None:
    body = CreateJobRequest.model_validate({"url": VIDEO_ID, "clip": {"start": 72}})
    assert body.clip is not None and body.clip.start == 72
    assert CreateJobRequest.model_validate({"url": VIDEO_ID}).clip is None
    for bad in (-1, 1.5, "x", 24 * 3600 + 1):
        with pytest.raises(ValidationError):
            CreateJobRequest.model_validate({"url": VIDEO_ID, "clip": {"start": bad}})


def test_clip_settings_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHORDS_FETCH_URL", "https://chords-fetch-abc-ew.a.run.app/")
    monkeypatch.setenv("CHORDS_YT_CLIP_S", "45")
    s = Settings.from_env()
    assert s.fetch_url == "https://chords-fetch-abc-ew.a.run.app" and s.clip_s == 45
    monkeypatch.setenv("CHORDS_YT_CLIP_S", "600")
    assert Settings.from_env().clip_s == 60
    monkeypatch.setenv("CHORDS_YT_CLIP_S", "0")
    assert Settings.from_env().clip_s == 1
    monkeypatch.delenv("CHORDS_FETCH_URL", raising=False)
    monkeypatch.delenv("CHORDS_YT_CLIP_S", raising=False)
    assert (Settings.from_env().fetch_url, Settings.from_env().clip_s) == ("", 30)


def test_track_summary_and_job_carry_the_clip() -> None:
    meta = {"title": "Song", "clip": {"start": 72, "end": 102}}
    summary = TrackSummary.model_validate(TrackStore._summary_dict("0123456789ab", meta, edited=False, chord_count=3))
    assert summary.clip == ClipRange(start=72, end=102)
    assert summary.model_dump(mode="json")["clip"] == {"start": 72.0, "end": 102.0}
    plain = TrackSummary.model_validate(TrackStore._summary_dict("0123456789ab", {"title": "Song"}, edited=False, chord_count=0))
    assert plain.clip is None
    job = JobRecord(id="j1", kind="url", created_at="2026-10-08T10:00:00Z", clip={"start": 72.0, "end": 102.0}).to_model()
    assert job.model_dump(mode="json")["clip"] == {"start": 72.0, "end": 102.0}
    assert JobRecord(id="j2", kind="url", created_at="2026-10-08T10:00:00Z").to_model().clip is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_clips.py -q`
Expected: FAIL at import: `ImportError: cannot import name 'ClipRange' from 'app.models'`.

- [ ] **Step 3: Implement**

In `backend/app/models.py`, add to `Settings` (after `max_request_mb`):

```python
    # ---- YouTube fragments (docs/CLOUD.md → YouTube clips)
    fetch_url: str = ""  # CHORDS_FETCH_URL: the chords-fetch service (downloads fragments through WARP)
    clip_s: int = 30  # CHORDS_YT_CLIP_S: fragment length in seconds, 1..60 (the client's CLIP_SECONDS)
```

and to the `cls(...)` call at the end of `Settings.from_env` (after `max_request_mb=...`):

```python
            fetch_url=os.environ.get("CHORDS_FETCH_URL", "").strip().rstrip("/"),
            clip_s=min(60, max(1, _env_int("CHORDS_YT_CLIP_S", defaults.clip_s))),
```

Add right after `class TrackSource`:

```python
class ClipRange(CamelModel):
    """A fragment of a YouTube video, in video seconds (a clip track or job, docs/CLOUD.md → YouTube clips)."""

    start: float = Field(ge=0)
    end: float = Field(ge=0)
```

In `TrackSummary`, after `stems`:

```python
    # a fragment of a YouTube video (POST /api/jobs with ``clip``): the player starts at ``clip.start`` and stops
    # at ``clip.end``; such a track is also a recording linked to the video (``Track.start_offset`` = clip.start)
    clip: Optional[ClipRange] = None
```

In `Job`, after `source`:

```python
    clip: Optional[ClipRange] = None  # a YouTube fragment job: the range (exact once the fragment is downloaded)
```

Replace `class CreateJobRequest` with:

```python
class ClipRequest(CamelModel):
    """``clip`` of POST /api/jobs: analyze only ``CHORDS_YT_CLIP_S`` seconds of a YouTube video from ``start``."""

    start: int = Field(ge=0, le=24 * 3600)


class CreateJobRequest(CamelModel):
    url: str = Field(min_length=1, max_length=4096)
    options: Optional[AnalysisOptions] = None
    clip: Optional[ClipRequest] = None
```

In `backend/app/storage.py` `_summary_dict`, add after `"stems": _stems(meta),`:

```python
            "clip": meta.get("clip"),
```

In `backend/app/jobs.py` `JobRecord`, add after `uid`:

```python
    clip: Optional[dict[str, float]] = None  # YouTube fragment jobs: {"start", "end"} in video seconds
```

and in `JobRecord.to_model`, after `"source": self.source,`:

```python
                "clip": self.clip,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_clips.py tests/test_api.py tests/test_cloud.py tests/test_publish.py -q`
Expected: PASS (the old suites prove nothing else moved).

- [ ] **Step 5: Commit**

```bash
git add backend/app/models.py backend/app/storage.py backend/app/jobs.py backend/tests/test_clips.py
git commit -m "$(cat <<'EOF'
YouTube clips: clip fields on requests, tracks and jobs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: yt-dlp fragment download (sources)

**Files:**
- Modify: `backend/app/sources.py` (`SourceError`, `_map_ytdlp_error`, new helpers, `YtDlpFetcher`, `LocalClipFetcher`)
- Test: `backend/tests/test_clips.py` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces (all in `app.sources`):
  - `SourceError(code, message, status=None, *, detail: Optional[str] = None)`; `.detail` = yt-dlp's raw message (ANSI stripped, ≤1000 chars) for retry decisions, never shown to users.
  - `is_bot_check(message: str) -> bool`
  - `YT_CLIP_MAX_S = 60`
  - `clip_track_key(video_id: str, start: int) -> str` → `"youtube:<id>@<start>"`
  - `clip_end(start: int, length: int, duration: Optional[float]) -> float` (raises `SourceError("invalid_url")` when `start >= duration`)
  - `@dataclass FetchedClip(path: Path, title: str, artist: Optional[str], duration: Optional[float], thumbnail: Optional[str], start: float, end: float)`
  - `class ClipFetcher(Protocol): fetch(video_id: str, start: int, length: int, dest_dir: Path, progress: ProgressCb, cancel: threading.Event) -> FetchedClip`
  - `YtDlpFetcher(max_bytes: int, proxy: Optional[str] = None)`; `YtDlpFetcher.download_clip(media: RemoteMedia, start: float, end: float, dest_dir: Path, progress: ProgressCb, cancel: threading.Event) -> Path`
  - `LocalClipFetcher(ytdlp: YtDlpFetcher)` implementing `ClipFetcher`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_clips.py` (add the imports at the top of the file, next to the existing ones):

```python
import threading
from pathlib import Path

from app.sources import (
    Cancelled,
    LocalClipFetcher,
    NormalizedUrl,
    RemoteMedia,
    SourceError,
    YtDlpFetcher,
    _map_ytdlp_error,
    clip_end,
    clip_track_key,
    is_bot_check,
    track_id_for,
)
```

```python
# --------------------------------------------------------------------------- fragment helpers (sources)


def test_a_fragment_is_its_own_track() -> None:
    assert clip_track_key(VIDEO_ID, 72) == f"youtube:{VIDEO_ID}@72"
    kind, _, ident = clip_track_key(VIDEO_ID, 72).partition(":")
    assert track_id_for(kind, ident) not in (track_id_for("youtube", VIDEO_ID), track_id_for("youtube", f"{VIDEO_ID}@73"))


@pytest.mark.parametrize(
    ("start", "length", "duration", "end"),
    [
        (72, 30, 213.4, 102.0),
        (190, 30, 213.4, 213.4),  # the last window is cut at the video's end
        (0, 30, 20.0, 20.0),  # a video shorter than the window: all of it
        (72, 30, None, 102.0),  # length unknown: trust the window
    ],
)
def test_clip_end(start: int, length: int, duration: float | None, end: float) -> None:
    assert clip_end(start, length, duration) == end


def test_a_fragment_must_start_inside_the_video() -> None:
    with pytest.raises(SourceError) as err:
        clip_end(214, 30, 213.4)
    assert err.value.code == "invalid_url"


def test_bot_check_is_told_apart_from_a_refused_media_url() -> None:
    bot = _map_ytdlp_error(
        Exception("ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot. Use --cookies-from-browser"),
        youtube=True,
    )
    forbidden = _map_ytdlp_error(Exception("ERROR: unable to download video data: HTTP Error 403: Forbidden"), youtube=True)
    assert bot.code == forbidden.code == "download_blocked"
    assert is_bot_check(bot.detail or "") and not is_bot_check(forbidden.detail or "")
    assert "403" in (forbidden.detail or "")


def test_proxy_reaches_ytdlp() -> None:
    assert YtDlpFetcher(1000, proxy="socks5h://127.0.0.1:40000")._opts()["proxy"] == "socks5h://127.0.0.1:40000"
    assert "proxy" not in YtDlpFetcher(1000)._opts()


class FakeYDL:
    """yt_dlp.YoutubeDL stand-in: records its options, 'downloads' a small file."""

    made: list[FakeYDL] = []

    def __init__(self, opts: dict) -> None:
        self.opts = opts
        FakeYDL.made.append(self)

    def __enter__(self) -> FakeYDL:
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def process_ie_result(self, info: dict, download: bool = True) -> dict:
        path = Path(self.opts["paths"]["home"]) / "source.webm"
        path.write_bytes(b"\x1aE\xdf\xa3" + b"0" * 64)
        return {"requested_downloads": [{"filepath": str(path)}]}

    def extract_info(self, url: str, download: bool = True) -> dict:
        return self.process_ie_result({}, download)


def test_download_clip_asks_ytdlp_for_the_range_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import yt_dlp

    FakeYDL.made.clear()
    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYDL)
    media = RemoteMedia(url=f"https://www.youtube.com/watch?v={VIDEO_ID}", extractor="youtube", media_id=VIDEO_ID,
                        title="Song", video_id=VIDEO_ID, info={"id": VIDEO_ID})
    path = YtDlpFetcher(10_000).download_clip(media, 72.0, 102.0, tmp_path, lambda f: None, threading.Event())
    assert path == tmp_path / "source.webm"
    ranges = FakeYDL.made[-1].opts["download_ranges"]
    assert list(ranges({"duration": 213.4}, None)) == [{"start_time": 72.0, "end_time": 102.0}]


class FakeYtDlp:
    """YtDlpFetcher stand-in for LocalClipFetcher: a video of ``duration`` seconds."""

    def __init__(self, duration: float | None) -> None:
        self.duration = duration
        self.clips: list[tuple[float, float]] = []

    def probe(self, url: NormalizedUrl) -> RemoteMedia:
        return RemoteMedia(url=url.url, extractor="youtube", media_id=url.youtube_id or "", title="Song",
                           artist="Artist", duration=self.duration, thumbnail=None, video_id=url.youtube_id)

    def download_clip(self, media: RemoteMedia, start: float, end: float, dest_dir: Path, progress, cancel) -> Path:
        self.clips.append((start, end))
        path = dest_dir / "source.webm"
        path.write_bytes(b"x")
        return path


def test_local_clip_fetcher(tmp_path: Path) -> None:
    yt = FakeYtDlp(213.4)
    fetcher = LocalClipFetcher(yt)  # type: ignore[arg-type]
    clip = fetcher.fetch(VIDEO_ID, 190, 30, tmp_path, lambda f: None, threading.Event())
    assert (clip.start, clip.end, clip.title, clip.artist, clip.duration) == (190.0, 213.4, "Song", "Artist", 213.4)
    assert clip.thumbnail == f"https://i.ytimg.com/vi/{VIDEO_ID}/hqdefault.jpg" and yt.clips == [(190.0, 213.4)]
    with pytest.raises(SourceError) as err:
        fetcher.fetch(VIDEO_ID, 300, 30, tmp_path, lambda f: None, threading.Event())
    assert err.value.code == "invalid_url" and len(yt.clips) == 1
    with pytest.raises(SourceError) as err:
        fetcher.fetch("not-an-id", 0, 30, tmp_path, lambda f: None, threading.Event())
    assert err.value.code == "invalid_url"
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(Cancelled):
        fetcher.fetch(VIDEO_ID, 0, 30, tmp_path, lambda f: None, cancel)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_clips.py -q`
Expected: FAIL at import: `ImportError: cannot import name 'LocalClipFetcher' from 'app.sources'`.

- [ ] **Step 3: Implement**

In `backend/app/sources.py`, replace `SourceError.__init__` with:

```python
    def __init__(
        self, code: ErrorCode, message: str, status: Optional[int] = None, *, detail: Optional[str] = None
    ) -> None:
        super().__init__(message)
        self.code: ErrorCode = code
        self.message = message
        self.status = status
        self.detail = detail  # yt-dlp's own message, for retry decisions (chords-fetch); never shown to users
```

Replace `_map_ytdlp_error` with:

```python
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
```

Add right after `is_blocked_message`:

```python
_BOT_CHECK_PATTERNS = ("sign in to confirm", "not a bot", "--cookies-from-browser")


def is_bot_check(message: str) -> bool:
    """YouTube's bot check / sign-in wall (a new WARP session may pass it), as opposed to a refused media URL
    (HTTP 403 on the stream, fixed by a fresh extraction)."""
    low = _ANSI_RE.sub("", message or "").lower().replace("’", "'")
    return any(p in low for p in _BOT_CHECK_PATTERNS)
```

Add after `track_id_for`:

```python
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
```

In `YtDlpFetcher`, replace `__init__` with:

```python
    def __init__(self, max_bytes: int, proxy: Optional[str] = None) -> None:
        self.max_bytes = max_bytes
        self.proxy = proxy  # e.g. socks5h://127.0.0.1:40000 (chords-fetch: Cloudflare WARP)
```

and in `_opts`, right before `opts.update(extra)`:

```python
        if self.proxy:
            opts["proxy"] = self.proxy
```

Split `download` into a thin public method plus `_download` (the body stays exactly as it is today, only the `opts = self._opts(...)` call gains `**extra`):

```python
    def download(self, media: RemoteMedia, dest_dir: Path, progress: ProgressCb, cancel: threading.Event) -> Path:
        return self._download(media, dest_dir, progress, cancel)

    def download_clip(
        self, media: RemoteMedia, start: float, end: float, dest_dir: Path, progress: ProgressCb, cancel: threading.Event
    ) -> Path:
        """Only ``[start, end]`` of the media: yt-dlp's download_ranges has ffmpeg fetch and cut just that part."""
        from yt_dlp.utils import download_range_func

        return self._download(media, dest_dir, progress, cancel, download_ranges=download_range_func(None, [(start, end)]))

    def _download(
        self, media: RemoteMedia, dest_dir: Path, progress: ProgressCb, cancel: threading.Event, **extra: Any
    ) -> Path:
        import yt_dlp

        # ... the former body of download(), unchanged, except:
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
```

Add after the `YtDlpFetcher` class:

```python
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_clips.py tests/test_api.py tests/test_cloud.py -q`
Expected: PASS (`test_ytdlp_error_mapping` in test_cloud still passes: codes are unchanged).

- [ ] **Step 5: Commit**

```bash
git add backend/app/sources.py backend/tests/test_clips.py
git commit -m "$(cat <<'EOF'
YouTube clips: download only a fragment with yt-dlp, optionally through a proxy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 3: chords-api's client for chords-fetch (`RemoteClipFetcher`)

**Files:**
- Modify: `backend/app/gcs.py` (constants `FETCH_PREFIX`, `FETCH_GLOB`)
- Create: `backend/app/fetch_client.py`
- Test: `backend/tests/test_fetch_client.py` (new)

**Interfaces:**
- Consumes: `FetchedClip`, `SourceError`, `Cancelled`, `safe_suffix` (Task 2).
- Produces: `app.gcs.FETCH_PREFIX = "fetch/"`, `app.gcs.FETCH_GLOB = "fetch/**"`; `app.fetch_client.RemoteClipFetcher(base_url: str, bucket, *, max_bytes: int, token_fn: Optional[Callable[[str], str]] = None, session=None, busy_wait_s: float = 60.0, sleep=time.sleep, clock=time.monotonic)` implementing `ClipFetcher`; attribute `.base_url`; `app.fetch_client.BUSY_MESSAGE`; `app.fetch_client.google_id_token(audience: str) -> str`. `bucket` needs `download(path, dest, *, size, progress, cancel, max_bytes)` and `delete(path)` (`gcs.UploadBucket`). Wire contract with chords-fetch: request `POST {base_url}/clip` JSON `{videoId, start, length}` + `Authorization: Bearer <ID token for base_url>`; answer 200 `{title, artist, duration, thumbnail, start, end, path, size}` or 4xx/5xx `{code, message}`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_fetch_client.py`:

```python
"""chords-api → chords-fetch (app.fetch_client): the ID token, waiting while every container is busy, taking the
fragment out of the bucket (and deleting it whatever happens), refusing answers that point outside fetch/."""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Optional

import pytest
import requests

from app.fetch_client import BUSY_MESSAGE, RemoteClipFetcher
from app.sources import Cancelled, SourceError

BASE = "https://chords-fetch-abc123-ew.a.run.app"
VIDEO_ID = "dQw4w9WgXcQ"
OBJECT = "fetch/0123456789abcdef/source.webm"


class FakeResponse:
    def __init__(self, status: int, payload: Any) -> None:
        self.status_code, self._payload = status, payload

    def json(self) -> Any:
        if self._payload is None:
            raise ValueError("no JSON")
        return self._payload


class FakeSession:
    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.calls: list[dict[str, Any]] = []

    def post(self, url: str, json: Any = None, headers: Optional[dict] = None, timeout: Any = None) -> FakeResponse:
        self.calls.append({"url": url, "json": json, "headers": headers})
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


class FakeBucket:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = dict(objects)
        self.deleted: list[str] = []

    def download(self, path: str, dest: Path, *, size: int, progress, cancel, max_bytes: int) -> int:
        if path not in self.objects:
            raise SourceError("not_found", "gone", 404)
        dest.write_bytes(self.objects[path])
        progress(1.0)
        return len(self.objects[path])

    def delete(self, path: str) -> bool:
        self.deleted.append(path)
        return self.objects.pop(path, None) is not None


class Clock:
    def __init__(self) -> None:
        self.now = 0.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def ok(path: str = OBJECT) -> FakeResponse:
    return FakeResponse(200, {"title": "Song", "artist": "Artist", "duration": 213.4, "start": 72, "end": 102,
                              "thumbnail": f"https://i.ytimg.com/vi/{VIDEO_ID}/hqdefault.jpg", "path": path, "size": 5})


def make(session: FakeSession, bucket: Optional[FakeBucket] = None, **kw: Any) -> tuple[RemoteClipFetcher, Clock, list[str]]:
    clock, audiences = Clock(), []

    def token(audience: str) -> str:
        audiences.append(audience)
        return f"id-token-{len(audiences)}"

    fetcher = RemoteClipFetcher(BASE + "/", bucket or FakeBucket({OBJECT: b"audio"}), max_bytes=1000, token_fn=token,
                                session=session, sleep=clock.sleep, clock=clock, **kw)
    return fetcher, clock, audiences


def fetch(fetcher: RemoteClipFetcher, tmp_path: Path, cancel: Optional[threading.Event] = None):
    return fetcher.fetch(VIDEO_ID, 72, 30, tmp_path, lambda f: None, cancel or threading.Event())


def test_a_fragment_is_asked_for_with_an_id_token_and_taken_out_of_the_bucket(tmp_path: Path) -> None:
    session, bucket = FakeSession(ok()), FakeBucket({OBJECT: b"audio"})
    fetcher, _, audiences = make(session, bucket)
    clip = fetch(fetcher, tmp_path)
    assert session.calls == [{"url": f"{BASE}/clip", "json": {"videoId": VIDEO_ID, "start": 72, "length": 30},
                              "headers": {"Authorization": "Bearer id-token-1"}}]
    assert audiences == [BASE]
    assert clip.path == tmp_path / "source.webm" and clip.path.read_bytes() == b"audio"
    assert (clip.title, clip.artist, clip.duration, clip.start, clip.end) == ("Song", "Artist", 213.4, 72.0, 102.0)
    assert bucket.deleted == [OBJECT] and bucket.objects == {}


def test_the_id_token_is_reused(tmp_path: Path) -> None:
    fetcher, _, audiences = make(FakeSession(ok(), ok()), FakeBucket({OBJECT: b"a"}))
    fetch(fetcher, tmp_path)
    fetcher.bucket.objects[OBJECT] = b"b"
    fetch(fetcher, tmp_path)
    assert audiences == [BASE]


def test_busy_containers_are_waited_for(tmp_path: Path) -> None:
    session = FakeSession(FakeResponse(429, None), FakeResponse(503, {"code": "internal"}),
                          requests.ConnectionError("cold start"), ok())
    fetcher, clock, _ = make(session)
    assert fetch(fetcher, tmp_path).end == 102.0
    assert clock.slept == [2.0, 4.0, 8.0]


def test_busy_for_too_long_is_a_failure(tmp_path: Path) -> None:
    fetcher, clock, _ = make(FakeSession(*[FakeResponse(429, None)] * 10), busy_wait_s=10)
    with pytest.raises(SourceError) as err:
        fetch(fetcher, tmp_path)
    assert (err.value.code, err.value.message) == ("download_failed", BUSY_MESSAGE)
    assert clock.slept == [2.0, 4.0]


@pytest.mark.parametrize(
    ("status", "payload", "code"),
    [
        (502, {"code": "download_blocked", "message": "YouTube refused the download"}, "download_blocked"),
        (400, {"code": "invalid_url", "message": "The fragment starts after the video ends"}, "invalid_url"),
        (502, {"code": "download_failed", "message": "Video unavailable"}, "download_failed"),
        (500, {"code": "internal", "message": "boom"}, "download_failed"),
        (403, None, "download_failed"),  # Cloud Run IAM said no: not the user's fault, not "sign in"
        (401, {"code": "unauthorized", "message": "x"}, "download_failed"),
    ],
)
def test_errors_of_the_service(tmp_path: Path, status: int, payload: Any, code: str) -> None:
    bucket = FakeBucket({OBJECT: b"audio"})
    fetcher, _, _ = make(FakeSession(FakeResponse(status, payload)), bucket)
    with pytest.raises(SourceError) as err:
        fetch(fetcher, tmp_path)
    assert err.value.code == code
    if code != "download_failed" or (payload and payload.get("code") == "download_failed"):
        assert err.value.message == payload["message"]
    assert bucket.deleted == []


@pytest.mark.parametrize("path", ["users/alice/tracks/0123456789ab/audio.mp3", "fetch/../users/a/x.mp3", "fetch/", "x"])
def test_an_answer_outside_fetch_is_refused_and_nothing_is_deleted(tmp_path: Path, path: str) -> None:
    bucket = FakeBucket({path: b"precious"})
    fetcher, _, _ = make(FakeSession(ok(path)), bucket)
    with pytest.raises(SourceError) as err:
        fetch(fetcher, tmp_path)
    assert err.value.code == "download_failed"
    assert bucket.deleted == [] and bucket.objects == {path: b"precious"}


def test_a_malformed_answer_is_a_failure(tmp_path: Path) -> None:
    fetcher, _, _ = make(FakeSession(FakeResponse(200, {"title": "Song"})))
    with pytest.raises(SourceError) as err:
        fetch(fetcher, tmp_path)
    assert err.value.code == "download_failed"


def test_cancel_before_the_download_still_deletes_the_object(tmp_path: Path) -> None:
    bucket = FakeBucket({OBJECT: b"audio"})
    session = FakeSession(ok())
    fetcher, _, _ = make(session, bucket)
    cancel = threading.Event()
    real_post = session.post

    def post_then_cancel(*args: Any, **kw: Any) -> FakeResponse:
        res = real_post(*args, **kw)
        cancel.set()  # the job was cancelled while chords-fetch worked
        return res

    session.post = post_then_cancel  # type: ignore[method-assign]
    with pytest.raises(Cancelled):
        fetch(fetcher, tmp_path, cancel)
    assert bucket.deleted == [OBJECT] and not (tmp_path / "source.webm").exists()


def test_cancelled_before_asking_sends_nothing(tmp_path: Path) -> None:
    session = FakeSession(ok())
    fetcher, _, _ = make(session)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(Cancelled):
        fetch(fetcher, tmp_path, cancel)
    assert session.calls == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_fetch_client.py -q`
Expected: FAIL: `ModuleNotFoundError: No module named 'app.fetch_client'`.

- [ ] **Step 3: Implement**

In `backend/app/gcs.py`, after `UPLOADS_GLOB = ...`:

```python
FETCH_PREFIX = "fetch/"  # fragments chords-fetch leaves for the API (docs/CLOUD.md → YouTube clips)
FETCH_GLOB = FETCH_PREFIX + "**"
```

Create `backend/app/fetch_client.py`:

```python
"""chords-api's side of YouTube fragments (docs/CLOUD.md → YouTube clips): ``RemoteClipFetcher`` asks the
chords-fetch service (Cloud Run, downloads through Cloudflare WARP) for a fragment, then moves the file it left in
the bucket (``fetch/<requestId>/source.<ext>``) into the job's work dir and deletes the object."""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from pydantic import BaseModel, ValidationError

from .gcs import FETCH_PREFIX
from .sources import Cancelled, FetchedClip, ProgressCb, SourceError, safe_suffix

log = logging.getLogger("chords.fetch_client")

BUSY_MESSAGE = "The server is busy, try again in a minute"
TOKEN_TTL_S = 50 * 60  # Google ID tokens live 1 h
_BUSY = frozenset({0, 429, 503})  # 0: no connection (a cold start, a network hiccup)
_PASSED_ON = frozenset({"invalid_url", "download_blocked", "download_failed", "too_large"})

TokenFn = Callable[[str], str]


def google_id_token(audience: str) -> str:
    """An ID token for ``audience`` (the chords-fetch URL) from the metadata server: Cloud Run's service account."""
    import google.auth.transport.requests
    import google.oauth2.id_token

    return google.oauth2.id_token.fetch_id_token(google.auth.transport.requests.Request(), audience)


class _ClipAnswer(BaseModel):
    title: str
    artist: Optional[str] = None
    duration: Optional[float] = None
    thumbnail: Optional[str] = None
    start: float
    end: float
    path: str
    size: int = 0


class RemoteClipFetcher:
    """ClipFetcher backed by chords-fetch: ``POST {base_url}/clip`` with an ID token, asked again while every
    container is busy or starting (429 / 503 / no connection) for up to ``busy_wait_s``."""

    def __init__(
        self,
        base_url: str,
        bucket: Any,
        *,
        max_bytes: int,
        token_fn: Optional[TokenFn] = None,
        session: Any = None,
        busy_wait_s: float = 60.0,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.bucket = bucket
        self.max_bytes = max_bytes
        self.busy_wait_s = busy_wait_s
        self._token_fn = token_fn or google_id_token
        self._token: Optional[tuple[str, float]] = None
        self._lock = threading.Lock()
        self._session = session
        self._sleep, self._clock = sleep, clock

    def fetch(
        self, video_id: str, start: int, length: int, dest_dir: Path, progress: ProgressCb, cancel: threading.Event
    ) -> FetchedClip:
        raw = self._call({"videoId": video_id, "start": int(start), "length": int(length)}, cancel)
        try:
            answer = _ClipAnswer.model_validate(raw)
        except ValidationError as exc:
            log.error("chords-fetch answered something unexpected: %.300s", raw)
            raise SourceError("download_failed", "The download service gave an invalid answer") from exc
        segments = answer.path.split("/")
        if not answer.path.startswith(FETCH_PREFIX) or any(s in ("", ".", "..") for s in segments):
            # never read or delete anything outside fetch/ on the service's word
            log.error("chords-fetch answered with an object outside %s: %.200s", FETCH_PREFIX, answer.path)
            raise SourceError("download_failed", "The download service gave an invalid answer")
        dest = dest_dir / ("source" + safe_suffix(segments[-1]))
        try:
            if cancel.is_set():
                raise Cancelled()
            self.bucket.download(
                answer.path, dest, size=answer.size, progress=progress, cancel=cancel, max_bytes=self.max_bytes
            )
        finally:
            self.bucket.delete(answer.path)  # the fragment is consumed whatever happens next
        return FetchedClip(
            path=dest,
            title=answer.title.strip()[:300] or video_id,
            artist=answer.artist,
            duration=answer.duration,
            thumbnail=answer.thumbnail,
            start=answer.start,
            end=answer.end,
        )

    # ------------------------------------------------------------------ HTTP

    def _call(self, body: dict[str, Any], cancel: threading.Event) -> Any:
        deadline = self._clock() + self.busy_wait_s
        delay = 2.0
        while True:
            if cancel.is_set():
                raise Cancelled()
            status, payload = self._post(body)
            if status == 200:
                return payload
            if status not in _BUSY:
                raise _service_error(status, payload)
            if self._clock() + delay > deadline:
                log.warning("chords-fetch still busy after %.0f s (last: %s)", self.busy_wait_s, status or "no connection")
                raise SourceError("download_failed", BUSY_MESSAGE)
            log.info("chords-fetch busy (%s); asking again in %.0f s", status or "no connection", delay)
            self._sleep(delay)
            delay = min(delay * 2, 15.0)

    def _post(self, body: dict[str, Any]) -> tuple[int, Any]:
        import requests

        try:
            res = self._http().post(
                f"{self.base_url}/clip",
                json=body,
                headers={"Authorization": f"Bearer {self._id_token()}"},
                timeout=(10, 300),
            )
        except requests.RequestException as exc:
            log.info("chords-fetch unreachable: %s", exc)
            return 0, None
        try:
            return res.status_code, res.json()
        except ValueError:
            return res.status_code, None

    def _http(self) -> Any:
        if self._session is None:
            import requests

            self._session = requests.Session()
        return self._session

    def _id_token(self) -> str:
        with self._lock:
            now = self._clock()
            if self._token is None or now - self._token[1] > TOKEN_TTL_S:
                self._token = (self._token_fn(self.base_url), now)
            return self._token[0]


def _service_error(status: int, payload: Any) -> SourceError:
    """chords-fetch's own user-facing codes pass on; anything else (IAM refusals, crashes) is a plain failure."""
    code = payload.get("code") if isinstance(payload, dict) else None
    message = payload.get("message") if isinstance(payload, dict) else None
    if code in _PASSED_ON and isinstance(message, str) and message.strip():
        return SourceError(code, message.strip()[:300])
    log.warning("chords-fetch failed: HTTP %s %.200s", status, payload)
    return SourceError("download_failed", "The download service failed")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_fetch_client.py -q`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/gcs.py backend/app/fetch_client.py backend/tests/test_fetch_client.py
git commit -m "$(cat <<'EOF'
YouTube clips: chords-api client for the chords-fetch service

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Clip jobs and `POST /api/jobs {clip}`

**Files:**
- Modify: `backend/app/jobs.py` (`JobManager.__init__`, `submit_url`, new `_submit_clip`, `_run_clip`, `_already_done`)
- Modify: `backend/app/main.py` (`create_app`, new `_clip_fetcher`, `create_job`, `_start_cloud_background_tasks`)
- Test: `backend/tests/test_clips.py` (append), `backend/tests/test_cloud.py` (factory + 3 tests)

**Interfaces:**
- Consumes: `ClipFetcher`, `LocalClipFetcher`, `YtDlpFetcher`, `clip_track_key`, `FetchedClip` (Task 2); `RemoteClipFetcher` (Task 3); `FETCH_GLOB` (Task 3); `Settings.fetch_url`, `Settings.clip_s`, `JobRecord.clip` (Task 1).
- Produces: `JobManager(settings, store, fetcher, analyzer=None, vocal_transcriber=None, clip_fetcher: Optional[ClipFetcher] = None)`, attribute `.clip_fetcher`; `JobManager.submit_url(url, options, clip_start: Optional[int] = None) -> Job`; `create_app(..., clip_fetcher: Optional[ClipFetcher] = None, ...)`; `POST /api/jobs {url, options?, clip?: {start}}` → 201 Job (with `clip`), 400 `invalid_url` (clip on a non-YouTube link), 501 `unavailable` (no fragment downloader). Track meta of a fragment: `startOffset = start` (when > 0), `clip = {start, end}`, `source = {type: "youtube", url, videoId}`. Bucket sweep: hourly; `users/*/uploads/**` older than 24 h, `fetch/**` older than 1 h.
- Test helper produced for later tasks: `tests.test_clips.FakeClipFetcher(audio: Path, duration: Optional[float] = 213.0)` with `.calls`, `.error`, `.gate`, `.duration`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_clips.py` (imports at the top of the file):

```python
import shutil
from types import SimpleNamespace
from typing import Optional

from fastapi.testclient import TestClient

from app.main import create_app
from app.sources import FetchedClip, youtube_thumbnail
from tests.test_api import (  # noqa: F401  (media is a fixture)
    ENGINE_INFO,
    LOCAL_HOSTS,
    FakeEngine,
    FakeFetcher,
    assert_error,
    media,
    needs_ffmpeg,
    wait_job,
    work_leftovers,
)
```

```python
# --------------------------------------------------------------------------- clip jobs (local mode, fake fetcher)


class FakeClipFetcher:
    """Stands in for chords-fetch: 'downloads' a fragment by copying a local fixture."""

    def __init__(self, audio: Path, duration: Optional[float] = 213.0) -> None:
        self.audio, self.duration = audio, duration
        self.calls: list[tuple[str, int, int]] = []
        self.error: Optional[Exception] = None
        self.gate: Optional[threading.Event] = None  # when set, fetch() waits for it

    def fetch(self, video_id: str, start: int, length: int, dest_dir: Path, progress, cancel) -> FetchedClip:
        self.calls.append((video_id, start, length))
        if self.gate is not None:
            self.gate.wait(10)
        if self.error:
            raise self.error
        end = clip_end(start, length, self.duration)
        dest = dest_dir / "source.mp3"
        shutil.copy(self.audio, dest)
        progress(1.0)
        return FetchedClip(path=dest, title="Fake Song", artist="Fake Artist", duration=self.duration,
                           thumbnail=youtube_thumbnail(video_id), start=float(start), end=end)


@pytest.fixture
def clip_env(tmp_path: Path, media: SimpleNamespace):  # noqa: F811
    clients: list[TestClient] = []

    def factory(**overrides: object) -> SimpleNamespace:
        settings = Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist", allowed_hosts=LOCAL_HOSTS,
                            **overrides)  # type: ignore[arg-type]
        engine, clips = FakeEngine(), FakeClipFetcher(media.tagged_mp3)
        app = create_app(settings, analyzer=engine, fetcher=FakeFetcher(media.tagged_mp3), clip_fetcher=clips,
                         engine_info_fn=lambda: ENGINE_INFO)
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return SimpleNamespace(client=client, engine=engine, clips=clips, settings=settings)

    yield factory
    for c in clients:
        c.__exit__(None, None, None)


@needs_ffmpeg
def test_clip_job_makes_a_video_linked_track(clip_env) -> None:
    env = clip_env()
    res = env.client.post("/api/jobs", json={"url": f"https://youtu.be/{VIDEO_ID}?t=5", "clip": {"start": 72}})
    assert res.status_code == 201, res.text
    job = res.json()
    assert job["source"] == {"type": "youtube", "url": f"https://www.youtube.com/watch?v={VIDEO_ID}",
                             "videoId": VIDEO_ID, "filename": None}
    assert job["clip"] == {"start": 72.0, "end": 102.0}
    done = wait_job(env.client, job["id"])
    assert done["status"] == "done", done
    assert done["trackId"] == track_id_for("youtube", f"{VIDEO_ID}@72") and done["title"] == "Fake Song"
    assert env.clips.calls == [(VIDEO_ID, 72, 30)]
    track = env.client.get(f"/api/tracks/{done['trackId']}").json()
    assert track["clip"] == {"start": 72.0, "end": 102.0} and track["startOffset"] == 72
    first = track["chords"][0]
    assert (first["label"], first["start"], first["end"]) == ("N", 0, 72)
    assert track["artist"] == "Fake Artist" and track["source"]["videoId"] == VIDEO_ID
    assert [t["clip"] for t in env.client.get("/api/tracks").json()] == [{"start": 72.0, "end": 102.0}]
    assert work_leftovers(env) == []


@needs_ffmpeg
def test_one_fragment_is_one_track(clip_env) -> None:
    env = clip_env()

    def post(start: int) -> dict:
        return env.client.post("/api/jobs", json={"url": VIDEO_ID, "clip": {"start": start}}).json()

    first = wait_job(env.client, post(72)["id"])
    again = post(72)
    assert again["status"] == "done" and again["trackId"] == first["trackId"]
    assert again["clip"] == {"start": 72.0, "end": 102.0}
    other = wait_job(env.client, post(0)["id"])
    assert other["trackId"] not in (first["trackId"], track_id_for("youtube", VIDEO_ID))
    assert env.client.get(f"/api/tracks/{other['trackId']}").json()["startOffset"] is None
    assert len(env.clips.calls) == 2 and len(env.engine.calls) == 2


@needs_ffmpeg
def test_the_same_fragment_twice_at_once_is_one_job(clip_env) -> None:
    env = clip_env()
    env.clips.gate = threading.Event()
    a = env.client.post("/api/jobs", json={"url": VIDEO_ID, "clip": {"start": 72}}).json()
    b = env.client.post("/api/jobs", json={"url": f"https://youtu.be/{VIDEO_ID}", "clip": {"start": 72}}).json()
    assert a["id"] == b["id"]
    env.clips.gate.set()
    assert wait_job(env.client, a["id"])["status"] == "done"
    assert len(env.clips.calls) == 1


@needs_ffmpeg
def test_a_fragment_ignores_the_video_length_limit(clip_env) -> None:
    env = clip_env(max_duration_min=1)
    env.clips.duration = 3 * 3600.0
    done = wait_job(env.client, env.client.post("/api/jobs", json={"url": VIDEO_ID, "clip": {"start": 3600}}).json()["id"])
    assert done["status"] == "done", done


def test_fragment_errors(clip_env) -> None:
    env = clip_env()
    assert_error(env.client.post("/api/jobs", json={"url": "https://soundcloud.com/a/b", "clip": {"start": 0}}), 400, "invalid_url")
    assert_error(env.client.post("/api/jobs", json={"url": VIDEO_ID, "clip": {"start": -1}}), 422, "invalid_url")
    env.clips.duration = 50.0
    job = wait_job(env.client, env.client.post("/api/jobs", json={"url": VIDEO_ID, "clip": {"start": 60}}).json()["id"])
    assert job["status"] == "error" and job["errorCode"] == "invalid_url"
    env.clips.duration = 213.0
    env.clips.error = SourceError("download_blocked", "YouTube refused the download from the server (bot check).")
    job = wait_job(env.client, env.client.post("/api/jobs", json={"url": VIDEO_ID, "clip": {"start": 30}}).json()["id"])
    assert job["errorCode"] == "download_blocked" and job["clip"] == {"start": 30.0, "end": 60.0}
    assert job["source"]["videoId"] == VIDEO_ID
    assert work_leftovers(env) == []


def test_who_downloads_fragments(tmp_path: Path) -> None:
    from app.fetch_client import RemoteClipFetcher

    base = {"data_dir": tmp_path / "d", "frontend_dist": tmp_path / "x", "allowed_hosts": LOCAL_HOSTS}
    cloud = {"auth": "firebase", "signing_key": "k" * 32, "publish": False}

    def chosen(**kw: object):
        app = create_app(Settings(**base, **kw), analyzer=FakeEngine(), engine_info_fn=lambda: ENGINE_INFO,  # type: ignore[arg-type]
                         token_verifier=object())
        return app.state.jobs.clip_fetcher

    assert isinstance(chosen(), LocalClipFetcher)
    assert chosen(**cloud, upload_bucket="b.firebasestorage.app") is None  # YouTube refuses Google Cloud: never try
    remote = chosen(**cloud, upload_bucket="b.firebasestorage.app", fetch_url="https://chords-fetch-x-ew.a.run.app")
    assert isinstance(remote, RemoteClipFetcher) and remote.base_url == "https://chords-fetch-x-ew.a.run.app"
    assert chosen(**cloud, fetch_url="https://chords-fetch-x-ew.a.run.app") is None  # no bucket to hand files over
```

In `backend/tests/test_cloud.py`, inside `make_cloud`'s `factory`, pop the new override before `defaults.update(overrides)` and pass it on:

```python
        clip_fetcher = overrides.pop("clip_fetcher", None)
```

```python
        app = create_app(
            settings, analyzer=engine, fetcher=fetcher, clip_fetcher=clip_fetcher, engine_info_fn=lambda: ENGINE_INFO,
            # ... the other arguments as they are
        )
```

and append these tests to `backend/tests/test_cloud.py`:

```python
# --------------------------------------------------------------------------- YouTube fragments


def test_fragments_without_chords_fetch_are_unavailable(cloud: SimpleNamespace) -> None:
    res = cloud.client.post("/api/jobs", json={"url": VIDEO_ID, "clip": {"start": 72}}, headers=H("alice"))
    assert_error(res, 501, "unavailable")
    assert cloud.client.get("/api/jobs", headers=H("alice")).json() == []
    assert cloud.client.get("/api/me", headers=H("alice")).json()["quotas"]["analyses"]["used"] == 0


@needs_ffmpeg
def test_fragment_jobs_count_against_the_quota_and_stay_per_user(make_cloud, media: SimpleNamespace) -> None:
    from tests.test_clips import FakeClipFetcher

    env = make_cloud(clip_fetcher=FakeClipFetcher(media.a))
    body = {"url": VIDEO_ID, "clip": {"start": 72}}
    a = wait_job(env.client, env.client.post("/api/jobs", json=body, headers=H("alice")).json()["id"], H("alice"))
    b = wait_job(env.client, env.client.post("/api/jobs", json=body, headers=H("bob")).json()["id"], H("bob"))
    assert a["status"] == b["status"] == "done" and a["trackId"] == b["trackId"]  # same id, each in their own library
    assert env.client.get("/api/me", headers=H("alice")).json()["quotas"]["analyses"]["used"] == 1
    assert env.client.get(f"/api/tracks/{a['trackId']}", headers=H("bob")).json()["clip"] == {"start": 72.0, "end": 102.0}


def test_stale_fragments_are_swept_after_an_hour(cloud: SimpleNamespace) -> None:
    from app.gcs import FETCH_GLOB

    cloud.gcs.put("fetch/0123456789abcdef/source.webm", b"1", age_s=2 * 3600)
    cloud.gcs.put("fetch/fedcba9876543210/source.webm", b"2", age_s=60)
    cloud.gcs.put("users/alice/uploads/u1/a.mp3", b"3", age_s=2 * 3600)
    assert cloud.app.state.bucket.sweep(max_age_s=3600, glob=FETCH_GLOB) == 1
    assert {n for (_, n) in cloud.gcs.objects} == {"fetch/fedcba9876543210/source.webm", "users/alice/uploads/u1/a.mp3"}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_clips.py tests/test_cloud.py -q -k "clip or fragment or downloads"`
Expected: FAIL: `TypeError: create_app() got an unexpected keyword argument 'clip_fetcher'`.

- [ ] **Step 3: Implement**

In `backend/app/jobs.py`, extend the `.sources` import with `ClipFetcher` and `clip_track_key`, then change the constructor:

```python
    def __init__(
        self,
        settings: Settings,
        store: TrackStore,
        fetcher: UrlFetcher,
        analyzer: Optional[Analyzer] = None,
        vocal_transcriber: Optional[VocalTranscriber] = None,
        clip_fetcher: Optional[ClipFetcher] = None,
    ) -> None:
        self.settings = settings
        self.store = store
        self.fetcher = fetcher
        self.clip_fetcher = clip_fetcher  # YouTube fragments (None: this server can't download them)
        # ... the rest unchanged
```

Replace the head of `submit_url`:

```python
    def submit_url(self, url: NormalizedUrl, options: dict[str, Any], clip_start: Optional[int] = None) -> Job:
        if clip_start is not None:
            return self._submit_clip(url, clip_start, options)
        offline_key = self.fetcher.offline_key(url)
        # ... unchanged
```

Add after `submit_url`:

```python
    def _submit_clip(self, url: NormalizedUrl, start: int, options: dict[str, Any]) -> Job:
        """``clip_s`` seconds of a YouTube video from ``start`` (whole seconds): one fragment = one track
        (``youtube:<id>@<start>``), downloaded by ``clip_fetcher`` and analyzed in video time."""
        video_id = url.youtube_id
        if not video_id:
            raise SourceError("invalid_url", "Only a YouTube video can be analyzed as a fragment")
        if self.clip_fetcher is None:
            raise SourceError("unavailable", "YouTube fragments can't be downloaded on this server", 501)
        kind, _, ident = clip_track_key(video_id, start).partition(":")
        track_id = track_id_for(kind, ident)
        if self.store.exists(track_id):
            return self._already_done("url", track_id)
        keys = {self._ukey(f"track:{track_id}")}
        with self._lock:
            running = self._find_active(keys)
            if running:
                return running.to_model()
            self.admit()
            rec = self._new_record(
                "url",
                options,
                source={"type": "youtube", "url": youtube_url(video_id), "videoId": video_id, "filename": None},
                thumbnail=youtube_thumbnail(video_id),
                clip={"start": float(start), "end": float(start + self.settings.clip_s)},
                keys=keys,
            )
            self._submit(rec, lambda: self._run_clip(rec, video_id, start, track_id))
            return rec.to_model()
```

In `_already_done`, pass the stored range on:

```python
        rec = self._new_record(
            kind, {}, keys=set(), source=meta.get("source"), title=meta.get("title"), thumbnail=meta.get("thumbnail"),
            clip=meta.get("clip"),
        )
```

Add after `_run_url`:

```python
    def _run_clip(self, rec: JobRecord, video_id: str, start: int, track_id: str) -> None:
        assert self.clip_fetcher is not None
        self._update(rec, status="downloading", progress=0.01, message="Downloading the fragment")
        work = self.store.new_work_dir(rec.id)
        try:
            clip = self.clip_fetcher.fetch(
                video_id,
                start,
                self.settings.clip_s,
                work,
                lambda f: self._update(rec, progress=self._scaled((0.01, DOWNLOAD_RANGE[1]), f)),
                rec.cancel,
            )
            self._check_cancel(rec)
            span = {"start": clip.start, "end": clip.end}
            self._update(rec, title=clip.title, thumbnail=clip.thumbnail or rec.thumbnail, clip=span)
            meta = {
                "title": clip.title,
                "artist": clip.artist,
                "thumbnail": clip.thumbnail or rec.thumbnail,
                "source": rec.source,
                "sourceDuration": clip.duration,
                "clip": span,
            }
            # only the fragment was downloaded: the video's own length doesn't matter (no too_long check here)
            self._process(rec, clip.path, work, track_id, meta, probe=None, start_offset=clip.start)
        finally:
            shutil.rmtree(work, ignore_errors=True)
```

In `backend/app/main.py`:

1. Imports: `from .fetch_client import RemoteClipFetcher`; `from .gcs import FETCH_GLOB, UPLOADS_GLOB, UploadBucket, default_client`; add `ClipFetcher` and `LocalClipFetcher` to the `.sources` import.
2. Constants next to `PUBLISH_SWEEP_INTERVAL_S`:

```python
BUCKET_SWEEP_INTERVAL_S = 3600.0  # how often abandoned uploads and fragments are removed from the bucket
UPLOAD_MAX_AGE_S = 24 * 3600.0
FETCH_MAX_AGE_S = 3600.0  # fragments chords-fetch left that no job took (the API died meanwhile)
```

3. `create_app` gets `clip_fetcher: Optional[ClipFetcher] = None` after `fetcher`; add to its docstring "``clip_fetcher`` replaces the YouTube fragment downloader (tests; see ``_clip_fetcher``)". Build the bucket before the job manager and pass the downloader:

```python
    store = TrackStore(settings, signer=signer)
    bucket = (
        UploadBucket(settings.upload_bucket, project=settings.firebase_project, client_factory=gcs_client_factory)
        if settings.cloud and settings.upload_bucket
        else None
    )
    jobs = JobManager(
        settings,
        store,
        fetcher or YtDlpFetcher(settings.max_upload_bytes),
        analyzer,
        vocal_transcriber=vocal_transcriber,
        clip_fetcher=clip_fetcher or _clip_fetcher(settings, bucket),
    )
```

(delete the old `bucket = (...)` block that followed `jobs = ...`).

4. Add after `create_app`:

```python
def _clip_fetcher(settings: Settings, bucket: Optional[UploadBucket]) -> Optional[ClipFetcher]:
    """Who downloads YouTube fragments: chords-fetch when CHORDS_FETCH_URL is set (it hands files over through the
    bucket); yt-dlp in this process on a local server; nobody on a cloud server without chords-fetch - YouTube
    refuses Google Cloud addresses, so the API never tries itself (501, the client listens in the tab)."""
    if settings.fetch_url:
        if bucket is None:
            log.error("CHORDS_FETCH_URL is set but CHORDS_UPLOAD_BUCKET is not: YouTube fragments are off")
            return None
        return RemoteClipFetcher(settings.fetch_url, bucket, max_bytes=settings.max_upload_bytes)
    if settings.cloud:
        return None
    return LocalClipFetcher(YtDlpFetcher(settings.max_upload_bytes))
```

5. Replace `create_job`:

```python
    @api.post(
        "/jobs",
        response_model=Job,
        status_code=201,
        responses={501: {"description": "A clip, and this server can't download YouTube fragments (code unavailable)"}},
    )
    def create_job(body: CreateJobRequest) -> Job:
        url = normalize_url(body.url)
        return jobs.submit_url(url, _options(body.options), clip_start=body.clip.start if body.clip else None)
```

6. In `_start_cloud_background_tasks`, replace the inner `sweep` and its docstring sentence ("remove uploads abandoned by clients (older than a day)") with:

```python
    def sweep() -> None:
        """Abandoned client uploads (a day old) and fragments chords-fetch left behind (an hour old), hourly."""
        assert bucket is not None
        while True:
            for glob, max_age in ((UPLOADS_GLOB, UPLOAD_MAX_AGE_S), (FETCH_GLOB, FETCH_MAX_AGE_S)):
                try:
                    bucket.sweep(max_age_s=max_age, glob=glob)
                except Exception as exc:  # pragma: no cover - best effort
                    log.warning("stale object sweep (%s) failed: %s", glob, exc)
            if stop.wait(BUCKET_SWEEP_INTERVAL_S):  # the app's shutdown ends the loop
                return
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest -q`
Expected: the whole backend suite PASSES.

- [ ] **Step 5: Commit**

```bash
git add backend/app/jobs.py backend/app/main.py backend/tests/test_clips.py backend/tests/test_cloud.py
git commit -m "$(cat <<'EOF'
YouTube clips: fragment jobs on POST /api/jobs, hourly sweep of fetch/

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: WARP tunnel manager (`app/warp.py`)

**Files:**
- Create: `backend/app/warp.py`
- Test: `backend/tests/test_warp.py` (new)

**Interfaces:**
- Produces: `class WarpError(Exception)`; `cloudflare_trace(proxy: str, timeout: float = 8.0) -> str`; `class Warp(profile: Path, *, port=40000, binary="wireproxy", ready_timeout_s=30.0, trace=cloudflare_trace, popen=subprocess.Popen, sleep=time.sleep, clock=time.monotonic, work_dir: Optional[Path] = None)` with `.proxy -> "socks5h://127.0.0.1:<port>"`, `.ready: bool`, `.sessions: int`, `start()`, `restart()`, `stop()` (all blocking; `start` raises `WarpError`).

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_warp.py`:

```python
"""The WARP tunnel of chords-fetch (app.warp): wireproxy's config, waiting for warp=on, reconnecting, failing loud."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from app.warp import Warp, WarpError

TRACE_ON = "fl=1f1\nh=www.cloudflare.com\nip=2a09:bac1::1\ncolo=FRA\nloc=DE\nwarp=on\n"
TRACE_OFF = TRACE_ON.replace("warp=on", "warp=off")


class FakeProc:
    def __init__(self, args: list[str], exit_code: int | None = None) -> None:
        self.args, self.returncode, self.terminated = args, exit_code, False

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated, self.returncode = True, -15

    def wait(self, timeout: float | None = None) -> int | None:
        return self.returncode

    def kill(self) -> None:
        self.returncode = -9


class Harness:
    def __init__(self, tmp_path: Path, traces: list[Any], exit_code: int | None = None) -> None:
        self.profile = tmp_path / "wgcf-profile.conf"
        self.profile.write_text("[Interface]\nPrivateKey = secret\n")
        self.traces, self.exit_code = list(traces), exit_code
        self.procs: list[FakeProc] = []
        self.now = 0.0
        self.warp = Warp(self.profile, trace=self.trace, popen=self.popen, sleep=self.sleep, clock=lambda: self.now,
                         work_dir=tmp_path / "warp", ready_timeout_s=5)

    def popen(self, args: list[str], **kw: Any) -> FakeProc:
        proc = FakeProc(args, self.exit_code)
        self.procs.append(proc)
        return proc

    def trace(self, proxy: str) -> str:
        assert proxy == "socks5h://127.0.0.1:40000"
        item = self.traces.pop(0) if self.traces else TRACE_OFF
        if isinstance(item, Exception):
            raise item
        return item

    def sleep(self, seconds: float) -> None:
        self.now += seconds


def test_start_runs_wireproxy_on_the_profile_and_waits_for_warp_on(tmp_path: Path) -> None:
    h = Harness(tmp_path, [ConnectionError("not yet"), TRACE_OFF, TRACE_ON])
    h.warp.start()
    assert h.warp.ready and h.warp.sessions == 1 and h.warp.proxy == "socks5h://127.0.0.1:40000"
    (proc,) = h.procs
    assert proc.args[0] == "wireproxy" and proc.args[1] == "-c"
    conf = Path(proc.args[2]).read_text()
    assert f"WGConfig = {h.profile}" in conf and "[Socks5]\nBindAddress = 127.0.0.1:40000" in conf
    assert "secret" not in conf  # the profile is referenced, never copied


def test_restart_starts_a_new_session(tmp_path: Path) -> None:
    h = Harness(tmp_path, [TRACE_ON, TRACE_ON])
    h.warp.start()
    h.warp.restart()
    assert [p.terminated for p in h.procs] == [True, False] and h.warp.sessions == 2 and h.warp.ready


def test_no_tunnel_in_time_is_an_error_and_wireproxy_is_stopped(tmp_path: Path) -> None:
    h = Harness(tmp_path, [])
    with pytest.raises(WarpError, match="did not come up"):
        h.warp.start()
    assert h.procs[0].terminated and not h.warp.ready


def test_wireproxy_exiting_is_an_error(tmp_path: Path) -> None:
    h = Harness(tmp_path, [], exit_code=1)
    with pytest.raises(WarpError, match="exited with code 1"):
        h.warp.start()


def test_a_missing_profile_is_an_error(tmp_path: Path) -> None:
    h = Harness(tmp_path, [TRACE_ON])
    h.profile.unlink()
    with pytest.raises(WarpError, match="profile"):
        h.warp.start()
    assert h.procs == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_warp.py -q`
Expected: FAIL: `ModuleNotFoundError: No module named 'app.warp'`.

- [ ] **Step 3: Implement**

Create `backend/app/warp.py`:

```python
"""Cloudflare WARP for chords-fetch: wireproxy (a userspace WireGuard client with a SOCKS5 proxy) on a wgcf
profile, so yt-dlp reaches YouTube from a WARP address instead of a Google Cloud one (YouTube asks Google Cloud
addresses to prove they are not a bot). On Cloud Run this works only with Direct VPC egress + Cloud NAT: over the
default egress the tunnel comes up but stalls on any payload over ~500 bytes (docs/CLOUD.md → YouTube clips)."""
from __future__ import annotations

import logging
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger("chords.warp")

TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace"


class WarpError(Exception):
    """The WARP tunnel did not come up."""


def cloudflare_trace(proxy: str, timeout: float = 8.0) -> str:
    """Cloudflare's trace page fetched through ``proxy``: ``warp=on`` once the tunnel carries traffic."""
    import yt_dlp

    with yt_dlp.YoutubeDL({"proxy": proxy, "quiet": True, "no_warnings": True, "socket_timeout": timeout}) as ydl:
        return ydl.urlopen(TRACE_URL).read(4096).decode("utf-8", "replace")


def _trace_summary(text: str) -> str:
    """``colo=FRA loc=DE warp=on`` from a trace (never all of it: it holds the egress address)."""
    fields = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
    return " ".join(f"{k}={fields[k]}" for k in ("colo", "loc", "warp") if k in fields)


class Warp:
    """One wireproxy process. ``start`` blocks until the tunnel works (or raises WarpError); ``restart`` opens a
    new session, which usually comes with a new WARP address."""

    def __init__(
        self,
        profile: Path,
        *,
        port: int = 40000,
        binary: str = "wireproxy",
        ready_timeout_s: float = 30.0,
        trace: Callable[[str], str] = cloudflare_trace,
        popen: Callable[..., Any] = subprocess.Popen,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        work_dir: Optional[Path] = None,
    ) -> None:
        self.profile = profile
        self.port = port
        self.binary = binary
        self.ready_timeout_s = ready_timeout_s
        self._trace, self._popen, self._sleep, self._clock = trace, popen, sleep, clock
        self._work = work_dir or Path(tempfile.mkdtemp(prefix="warp-"))
        self._proc: Any = None
        self.ready = False
        self.sessions = 0

    @property
    def proxy(self) -> str:
        return f"socks5h://127.0.0.1:{self.port}"

    def start(self) -> None:
        if not self.profile.is_file():
            raise WarpError(f"WARP profile not found: {self.profile}")
        self._work.mkdir(parents=True, exist_ok=True)
        conf = self._work / "wireproxy.conf"
        conf.write_text(f"WGConfig = {self.profile}\n\n[Socks5]\nBindAddress = 127.0.0.1:{self.port}\n")
        self._proc = self._popen([self.binary, "-c", str(conf)], stdin=subprocess.DEVNULL)
        self.sessions += 1
        self._wait_ready()

    def restart(self) -> None:
        log.info("reconnecting WARP")
        self.stop()
        self.start()

    def stop(self) -> None:
        self.ready = False
        proc, self._proc = self._proc, None
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

    def _wait_ready(self) -> None:
        deadline = self._clock() + self.ready_timeout_s
        last = "no answer"
        while self._clock() < deadline:
            if self._proc.poll() is not None:
                code = self._proc.returncode
                self._proc = None
                raise WarpError(f"wireproxy exited with code {code}")
            try:
                text = self._trace(self.proxy)
                if "warp=on" in text:
                    self.ready = True
                    log.info("WARP is up (%s)", _trace_summary(text))
                    return
                last = _trace_summary(text) or "no trace"
            except Exception as exc:  # the tunnel is still coming up
                last = f"{type(exc).__name__}: {str(exc)[:200]}"
            self._sleep(1.0)
        self.stop()
        raise WarpError(f"WARP did not come up in {self.ready_timeout_s:g} s ({last})")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_warp.py -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/warp.py backend/tests/test_warp.py
git commit -m "$(cat <<'EOF'
YouTube clips: WARP tunnel manager for chords-fetch (wireproxy)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The chords-fetch service (`app/fetch_service.py`)

**Files:**
- Modify: `backend/app/gcs.py` (`UploadBucket.upload`)
- Create: `backend/app/fetch_service.py`
- Test: `backend/tests/test_fetch_service.py` (new), `backend/tests/test_cloud.py` (`FakeBlob.upload_from_filename` + 1 test)

**Interfaces:**
- Consumes: `LocalClipFetcher`, `YtDlpFetcher(proxy=)`, `FetchedClip`, `SourceError.detail`, `is_bot_check`, `YT_CLIP_MAX_S`, `safe_suffix` (Task 2); `FETCH_PREFIX` (Task 3); `Warp`, `WarpError` (Task 5).
- Produces: `UploadBucket.upload(path: str, src: Path, content_type: Optional[str] = None) -> int`; `app.fetch_service.create_fetch_app(*, fetcher: ClipFetcher, bucket, warp: Optional[Warp], work_dir: Path, max_attempts: int = 3, attempt_timeout_s: float = 90.0) -> FastAPI`; `app.fetch_service.create_app_from_env() -> FastAPI` (env `FETCH_BUCKET` required, `WARP_PROFILE` optional, `FETCH_WORK_DIR` default `/tmp/chords-fetch`); `fetch_with_retries(...)`, `failure_kind(exc) -> "bot" | "retry" | "final"`. HTTP: `POST /clip` (contract in Task 3), `GET /healthz` → `{"ok": bool}`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_fetch_service.py`:

```python
"""chords-fetch (app.fetch_service): request validation, the retry table (refused media URL → fresh tries; bot
check → one WARP reconnect; anything else → at once), the hand-over through the bucket, the per-request log line.
Offline: the clip fetcher, WARP and the bucket are fakes."""
from __future__ import annotations

import logging
import re
import threading
from pathlib import Path
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from app.fetch_service import create_fetch_app
from app.sources import Cancelled, FetchedClip, SourceError

VIDEO_ID = "dQw4w9WgXcQ"
BOT = SourceError("download_blocked", "YouTube refused", detail="ERROR: [youtube] x: Sign in to confirm you're not a bot")
FORBIDDEN = SourceError("download_blocked", "YouTube refused", detail="ERROR: unable to download video data: HTTP Error 403: Forbidden")
STALL = SourceError("download_failed", "Network error: Read timed out", detail="ERROR: Read timed out.")
GONE = SourceError("download_failed", "Video unavailable", detail="ERROR: [youtube] x: Video unavailable")


class ScriptedFetcher:
    """Each fetch() takes the next step: an exception to raise, "hang" (wait for cancel), or None (succeed)."""

    def __init__(self, *script: Any) -> None:
        self.script = list(script)
        self.calls = 0

    def fetch(self, video_id: str, start: int, length: int, dest_dir: Path, progress, cancel: threading.Event) -> FetchedClip:
        self.calls += 1
        step = self.script.pop(0) if self.script else None
        if step == "hang":
            cancel.wait(5)
            raise Cancelled()
        if step is not None:
            raise step
        path = dest_dir / "source.webm"
        path.write_bytes(b"\x1aE\xdf\xa3fragment")
        return FetchedClip(path=path, title="Song", artist="Artist", duration=213.4,
                           thumbnail=f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
                           start=float(start), end=min(start + length, 213.4))


class FakeWarp:
    def __init__(self) -> None:
        self.ready, self.started, self.stopped, self.restarts = False, 0, 0, 0

    def start(self) -> None:
        self.started += 1
        self.ready = True

    def stop(self) -> None:
        self.stopped += 1
        self.ready = False

    def restart(self) -> None:
        self.restarts += 1
        self.ready = True


class FakeBucket:
    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, Optional[str]]] = {}

    def upload(self, path: str, src: Path, content_type: Optional[str] = None) -> int:
        self.objects[path] = (src.read_bytes(), content_type)
        return src.stat().st_size


@pytest.fixture
def service(tmp_path: Path):
    clients: list[TestClient] = []

    def factory(*script: Any, warp: Optional[FakeWarp] = None, **kw: Any):
        fetcher, bucket = ScriptedFetcher(*script), FakeBucket()
        warp = warp if warp is not None else FakeWarp()
        app = create_fetch_app(fetcher=fetcher, bucket=bucket, warp=warp, work_dir=tmp_path / "work", **kw)
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client, fetcher, bucket, warp

    yield factory
    for c in clients:
        c.__exit__(None, None, None)


def post(client: TestClient, **body: Any):
    return client.post("/clip", json={"videoId": VIDEO_ID, "start": 72, "length": 30, **body})


def test_a_fragment_goes_to_the_bucket(service, tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger="chords.fetch")
    client, fetcher, bucket, warp = service()
    assert warp.started == 1  # the container listens only once WARP is up
    res = post(client)
    assert res.status_code == 200, res.text
    data = res.json()
    assert re.fullmatch(r"fetch/[0-9a-f]{16}/source\.webm", data["path"])
    assert data == {"title": "Song", "artist": "Artist", "duration": 213.4, "start": 72.0, "end": 102.0, "size": 12,
                    "thumbnail": f"https://i.ytimg.com/vi/{VIDEO_ID}/hqdefault.jpg", "path": data["path"]}
    assert bucket.objects[data["path"]] == (b"\x1aE\xdf\xa3fragment", "audio/webm")
    assert list((tmp_path / "work").iterdir()) == []
    assert any(f"clip {VIDEO_ID}@72+30: ok after 1 attempt(s)" in r.getMessage() for r in caplog.records)
    assert client.get("/healthz").json() == {"ok": True}


@pytest.mark.parametrize(
    "body",
    [
        {"videoId": "not-an-id"},
        {"videoId": "https://youtu.be/dQw4w9WgXcQ"},
        {"start": -1},
        {"start": 1.5},
        {"length": 0},
        {"length": 61},
        {"url": "https://example.com/a.mp3"},
    ],
)
def test_only_a_video_id_and_a_short_range_are_accepted(service, body: dict) -> None:
    client, fetcher, _, _ = service()
    res = post(client, **body)
    assert res.status_code == 400 and res.json()["code"] == "invalid_url"
    assert fetcher.calls == 0


def test_a_refused_media_url_gets_fresh_tries(service) -> None:
    client, fetcher, _, warp = service(FORBIDDEN, STALL)
    assert post(client).status_code == 200
    assert fetcher.calls == 3 and warp.restarts == 0


def test_three_refusals_are_download_blocked(service) -> None:
    client, fetcher, _, _ = service(FORBIDDEN, FORBIDDEN, FORBIDDEN)
    res = post(client)
    assert res.status_code == 502 and res.json()["code"] == "download_blocked" and fetcher.calls == 3


def test_a_bot_check_reconnects_warp_once(service) -> None:
    client, fetcher, _, warp = service(BOT)
    assert post(client).status_code == 200
    assert fetcher.calls == 2 and warp.restarts == 1


def test_a_second_bot_check_is_download_blocked(service) -> None:
    client, fetcher, _, warp = service(BOT, BOT)
    res = post(client)
    assert res.status_code == 502 and res.json() == {"code": "download_blocked", "message": "YouTube refused"}
    assert fetcher.calls == 2 and warp.restarts == 1


def test_a_final_error_is_not_retried(service) -> None:
    client, fetcher, _, _ = service(GONE)
    res = post(client)
    assert res.status_code == 502 and res.json()["code"] == "download_failed" and fetcher.calls == 1


def test_a_start_past_the_end_is_invalid(service) -> None:
    client, _, _, _ = service(SourceError("invalid_url", "The fragment starts at 300 s but the video is only 213 s long"))
    res = post(client, start=300)
    assert res.status_code == 400 and res.json()["code"] == "invalid_url"


def test_an_attempt_that_hangs_is_cut_off(service) -> None:
    client, fetcher, _, _ = service("hang", "hang", attempt_timeout_s=0.05, max_attempts=2)
    res = post(client)
    assert res.status_code == 502 and res.json()["code"] == "download_failed"
    assert "timed out" in res.json()["message"] and fetcher.calls == 2


def test_a_lost_tunnel_is_brought_back_before_the_next_fragment(service) -> None:
    client, fetcher, _, warp = service()
    warp.ready = False  # e.g. a reconnect failed during the previous request
    assert post(client).status_code == 200
    assert warp.restarts == 1
```

In `backend/tests/test_cloud.py`, add to `FakeBlob`:

```python
    def upload_from_filename(self, filename: str, content_type: Optional[str] = None) -> None:
        self.gcs.put(self.name, Path(filename).read_bytes(), bucket=self.bucket_name,
                     content_type=content_type or "application/octet-stream")
```

and append:

```python
def test_bucket_upload(cloud: SimpleNamespace, tmp_path: Path) -> None:
    src = tmp_path / "source.webm"
    src.write_bytes(b"abc")
    assert cloud.app.state.bucket.upload("fetch/0123456789abcdef/source.webm", src, content_type="audio/webm") == 3
    obj = cloud.gcs.objects[(BUCKET, "fetch/0123456789abcdef/source.webm")]
    assert obj["data"] == b"abc" and obj["content_type"] == "audio/webm"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_fetch_service.py tests/test_cloud.py::test_bucket_upload -q`
Expected: FAIL: `ModuleNotFoundError: No module named 'app.fetch_service'` (and `AttributeError: 'UploadBucket' object has no attribute 'upload'`).

- [ ] **Step 3: Implement**

In `backend/app/gcs.py`, add to `UploadBucket` after `download`:

```python
    def upload(self, path: str, src: Path, content_type: Optional[str] = None) -> int:
        """Store ``src`` as the object ``path`` (chords-fetch → ``fetch/...``); returns its size. Raises SourceError."""
        try:
            self._bucket().blob(path).upload_from_filename(str(src), content_type=content_type)
        except Exception as exc:
            raise _map_error(exc, "Couldn't store the file") from exc
        return src.stat().st_size
```

Create `backend/app/fetch_service.py`:

```python
"""chords-fetch: short YouTube fragments through Cloudflare WARP, for chords-api
(docs/superpowers/specs/2026-10-07-youtube-warp-fetch-design.md; docs/CLOUD.md → YouTube clips).

    uvicorn --factory app.fetch_service:create_app_from_env --port 8080

``POST /clip {videoId, start, length}``: probe the video, download only ``[start, min(start + length, duration)]``
with yt-dlp through the WARP SOCKS5 proxy, store it as ``fetch/<requestId>/source.<ext>`` in the bucket and answer
``{title, artist, duration, thumbnail, start, end, path, size}``; errors are ``{code, message}``. Only video ids are
accepted, never URLs, so this is no open proxy; Cloud Run lets in only chords-api's service account. One request
per container (concurrency 1), so a WARP reconnect never cuts another download.
"""
from __future__ import annotations

import logging
import os
import secrets
import shutil
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from .gcs import FETCH_PREFIX, UploadBucket
from .sources import (
    YT_CLIP_MAX_S,
    Cancelled,
    ClipFetcher,
    FetchedClip,
    LocalClipFetcher,
    SourceError,
    YtDlpFetcher,
    ensure_tool_path,
    is_bot_check,
    safe_suffix,
)
from .warp import Warp, WarpError

log = logging.getLogger("chords.fetch")

MAX_ATTEMPTS = 3  # a refused media URL (HTTP 403, ~1 in 10 first tries) or a stall: fresh tries
ATTEMPT_TIMEOUT_S = 90.0
MAX_CLIP_BYTES = 50 * 1024 * 1024  # a minute of the best audio is a few MB
STATUS = {"invalid_url": 400, "too_large": 413, "download_blocked": 502, "download_failed": 502}
CONTENT_TYPES = {
    ".webm": "audio/webm", ".weba": "audio/webm", ".m4a": "audio/mp4", ".mp4": "audio/mp4",
    ".opus": "audio/ogg", ".ogg": "audio/ogg", ".mp3": "audio/mpeg",
}
_STALLS = ("timed out", "timeout", "connection reset", "connection refused", "connection aborted",
           "network is unreachable", "unable to download webpage", "temporary failure", "eof occurred")


class ClipBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    videoId: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")  # noqa: N815 - the JSON name
    start: int = Field(ge=0, le=24 * 3600)
    length: int = Field(ge=1, le=YT_CLIP_MAX_S)


def failure_kind(exc: SourceError) -> str:
    """'bot' (a new WARP session may pass), 'retry' (a refused media URL, a stall) or 'final'."""
    detail = exc.detail or exc.message
    if exc.code == "download_blocked":
        return "bot" if is_bot_check(detail) else "retry"
    if exc.code == "download_failed" and any(s in detail.lower() for s in _STALLS):
        return "retry"
    return "final"


def _reconnect(warp: Warp) -> None:
    try:
        warp.restart()
    except WarpError as exc:
        log.error("WARP reconnect failed: %s", exc)
        raise SourceError("download_failed", "The download service lost its connection - try again in a minute") from exc


def fetch_with_retries(
    fetcher: ClipFetcher,
    warp: Optional[Warp],
    body: ClipBody,
    dest: Path,
    *,
    max_attempts: int = MAX_ATTEMPTS,
    attempt_timeout_s: float = ATTEMPT_TIMEOUT_S,
    stats: Optional[dict[str, int]] = None,
) -> FetchedClip:
    """One fragment, retried: a refused media URL or a stall gets up to ``max_attempts`` fresh tries (a new
    extraction each time); a bot check gets one WARP reconnect (a new session, usually a new address) and one more
    try, then ``download_blocked``. ``stats["attempts"]`` counts the tries."""
    stats = stats if stats is not None else {}
    attempts, reconnected = 0, False
    while True:
        attempts += 1
        stats["attempts"] = attempts
        shutil.rmtree(dest, ignore_errors=True)  # a failed try may leave parts behind
        dest.mkdir(parents=True)
        cancel = threading.Event()
        watchdog = threading.Timer(attempt_timeout_s, cancel.set)
        watchdog.daemon = True
        watchdog.start()
        try:
            return fetcher.fetch(body.videoId, body.start, body.length, dest, lambda _f: None, cancel)
        except Cancelled as exc:  # only the watchdog cancels here
            if attempts >= max_attempts:
                raise SourceError(
                    "download_failed", f"Network error: the download timed out after {attempt_timeout_s:g} s"
                ) from exc
            log.info("clip %s: attempt %d timed out", body.videoId, attempts)
        except SourceError as exc:
            kind = failure_kind(exc)
            if kind == "bot" and warp is not None and not reconnected:
                log.info("clip %s: bot check on attempt %d, reconnecting WARP", body.videoId, attempts)
                reconnected = True
                _reconnect(warp)
            elif kind == "retry" and attempts < max_attempts:
                log.info("clip %s: attempt %d failed (%s), trying again", body.videoId, attempts, exc.code)
            else:
                raise
        finally:
            watchdog.cancel()


def _error(code: str, message: str) -> JSONResponse:
    return JSONResponse({"code": code, "message": message}, status_code=STATUS.get(code, 500))


def create_fetch_app(
    *,
    fetcher: ClipFetcher,
    bucket: Any,
    warp: Optional[Warp],
    work_dir: Path,
    max_attempts: int = MAX_ATTEMPTS,
    attempt_timeout_s: float = ATTEMPT_TIMEOUT_S,
) -> FastAPI:
    """``bucket``: ``upload(path, src, content_type)`` (gcs.UploadBucket). ``warp`` None: no proxy (local runs)."""

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        work_dir.mkdir(parents=True, exist_ok=True)
        if warp is not None:
            await run_in_threadpool(warp.start)  # Cloud Run sends requests once the port is open, i.e. after this
        try:
            yield
        finally:
            if warp is not None:
                warp.stop()

    app = FastAPI(title="chords-fetch", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(RequestValidationError)
    async def _invalid(_: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
        return _error("invalid_url", f"Invalid request - {where}: {first.get('msg', 'invalid value')}")

    @app.exception_handler(SourceError)
    async def _source(_: Request, exc: SourceError) -> JSONResponse:
        return _error(exc.code, exc.message)

    @app.get("/healthz")
    def healthz() -> dict[str, bool]:
        return {"ok": warp is None or warp.ready}

    @app.post("/clip")
    def clip(body: ClipBody) -> dict[str, Any]:
        request_id = secrets.token_hex(8)
        dest = work_dir / request_id
        stats = {"attempts": 0}
        started, outcome = time.monotonic(), "internal"
        try:
            if warp is not None and not warp.ready:
                _reconnect(warp)
            got = fetch_with_retries(fetcher, warp, body, dest, max_attempts=max_attempts,
                                     attempt_timeout_s=attempt_timeout_s, stats=stats)
            size = got.path.stat().st_size
            if size > MAX_CLIP_BYTES:
                raise SourceError("too_large", "The fragment is too large")
            suffix = safe_suffix(got.path.name)
            path = f"{FETCH_PREFIX}{request_id}/source{suffix}"
            bucket.upload(path, got.path, content_type=CONTENT_TYPES.get(suffix, "application/octet-stream"))
            outcome = "ok"
            return {
                "title": got.title, "artist": got.artist, "duration": got.duration, "thumbnail": got.thumbnail,
                "start": got.start, "end": got.end, "path": path, "size": size,
            }
        except SourceError as exc:
            outcome = exc.code
            raise
        finally:
            shutil.rmtree(dest, ignore_errors=True)
            log.info("clip %s@%d+%d: %s after %d attempt(s) in %.1fs", body.videoId, body.start, body.length,
                     outcome, stats["attempts"], time.monotonic() - started)

    return app


def create_app_from_env() -> FastAPI:
    """The Cloud Run service. ``FETCH_BUCKET``: the Firebase default bucket; ``WARP_PROFILE``: the wgcf profile
    mounted from Secret Manager (unset: no WARP, for local runs); ``FETCH_WORK_DIR``: scratch space."""
    ensure_tool_path()
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    bucket_name = os.environ.get("FETCH_BUCKET", "").strip()
    if not bucket_name:
        raise RuntimeError("FETCH_BUCKET is not set")
    profile = os.environ.get("WARP_PROFILE", "").strip()
    work_dir = Path(os.environ.get("FETCH_WORK_DIR", "").strip() or "/tmp/chords-fetch")
    warp = Warp(Path(profile), work_dir=work_dir / ".warp") if profile else None
    fetcher = LocalClipFetcher(YtDlpFetcher(MAX_CLIP_BYTES, proxy=warp.proxy if warp else None))
    return create_fetch_app(fetcher=fetcher, bucket=UploadBucket(bucket_name), warp=warp, work_dir=work_dir)
```

Note: `work_dir / ".warp"` lives inside the scratch dir; the `/clip` handler only removes `work_dir/<requestId>`, so the wireproxy config survives.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_fetch_service.py tests/test_cloud.py -q`
Expected: PASS.

- [ ] **Step 5: Run it locally once (no WARP, real yt-dlp from your own connection)**

```bash
cd backend && FETCH_BUCKET=unused uv run python - <<'EOF'
import threading, tempfile
from pathlib import Path
from app.sources import LocalClipFetcher, YtDlpFetcher
clip = LocalClipFetcher(YtDlpFetcher(50 * 1024 * 1024)).fetch("dQw4w9WgXcQ", 60, 30, Path(tempfile.mkdtemp()), lambda f: None, threading.Event())
print(clip.title, clip.start, clip.end, clip.path.stat().st_size)
EOF
```

Expected: one line like `Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster) 60.0 90.0 480000` (a few hundred KB). Then check the cut: `ffprobe -v error -show_entries format=duration -of csv=p=0 <path>` prints ~30. If YouTube refuses your home address, note it and move on (the unit tests are the gate).

- [ ] **Step 6: Commit**

```bash
git add backend/app/gcs.py backend/app/fetch_service.py backend/tests/test_fetch_service.py backend/tests/test_cloud.py
git commit -m "$(cat <<'EOF'
YouTube clips: the chords-fetch service (fragments through WARP into the bucket)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The chords-fetch image

**Files:**
- Create: `backend/fetch.Dockerfile`, `backend/fetch.cloudbuild.yaml`
- Modify: `backend/.gcloudignore` (let `fetch.Dockerfile` into the Cloud Build upload)
- Test: `backend/tests/test_fetch_image.py` (new)

**Interfaces:**
- Consumes: `app/fetch_service.py`, `app/warp.py`, `app/gcs.py`, `app/sources.py`, `app/models.py` (Tasks 1–6).
- Produces: image `europe-west1-docker.pkg.dev/build-chords-listener/chords/fetch:<tag>` built by `gcloud builds submit backend --config backend/fetch.cloudbuild.yaml --region europe-west1 --substitutions _IMAGE=…/fetch,_TAG=<tag>`; runs `uvicorn --factory app.fetch_service:create_app_from_env` on `$PORT` as uid 10001, with `wireproxy`, `ffmpeg`, `node` on PATH.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_fetch_image.py`:

```python
"""The chords-fetch image (backend/fetch.Dockerfile) pins what backend/uv.lock locks: yt-dlp must move in step with
the API's (YouTube changes often), the rest so both run the same code. It copies only what the service imports."""
from __future__ import annotations

import re
import tomllib
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
DOCKERFILE = BACKEND / "fetch.Dockerfile"


def locked(name: str) -> str:
    lock = tomllib.loads((BACKEND / "uv.lock").read_text())
    return next(p["version"] for p in lock["package"] if p["name"] == name)


def test_fetch_image_pins_the_locked_versions() -> None:
    text = DOCKERFILE.read_text()
    ytdlp = re.search(r"^ARG YTDLP_VERSION=(\S+)$", text, re.M)
    assert ytdlp and ytdlp.group(1) == locked("yt-dlp")
    pins = dict(re.findall(r'"([a-z0-9-]+)(?:\[[a-z]+\])?==([0-9][^"]*)"', text))
    assert pins == {name: locked(name) for name in ("fastapi", "uvicorn", "google-cloud-storage", "google-auth")}


def test_fetch_image_copies_only_what_the_service_imports() -> None:
    copy = re.search(r"^COPY ((?:app/\S+ )+)\./app/$", DOCKERFILE.read_text(), re.M)
    assert copy
    copied = set(copy.group(1).split())
    assert copied == {"app/__init__.py", "app/models.py", "app/sources.py", "app/gcs.py", "app/warp.py", "app/fetch_service.py"}
    for name in copied:  # ... and those modules import nothing else of the app
        imports = set(re.findall(r"^from \.(\w+) import", (BACKEND / name).read_text(), re.M))
        assert {f"app/{m}.py" for m in imports} <= copied, name


def test_cloud_build_upload_includes_the_fetch_dockerfile() -> None:
    assert "!/fetch.Dockerfile" in (BACKEND / ".gcloudignore").read_text().splitlines()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && uv run pytest tests/test_fetch_image.py -q`
Expected: FAIL: `FileNotFoundError: ... fetch.Dockerfile`.

- [ ] **Step 3: Implement**

Create `backend/fetch.Dockerfile`:

```dockerfile
# chords-fetch: short YouTube fragments through Cloudflare WARP (docs/CLOUD.md → YouTube clips). Context: backend/.
#
#   scripts/deploy_fetch.sh                                            Cloud Build -> Artifact Registry -> Cloud Run
#   docker build -f backend/fetch.Dockerfile -t chords-fetch backend   local build (linux/amd64)
#
# Contents: python 3.11 + yt-dlp at the version backend/uv.lock locks (tests/test_fetch_image.py keeps them equal),
# fastapi/uvicorn, google-cloud-storage; ffmpeg (cuts the fragment), node (yt-dlp's JS runtime for YouTube),
# wireproxy (WARP as a userspace SOCKS5 proxy). No analysis dependencies: the image stays small and starts fast.

FROM golang:bookworm AS wireproxy
ARG WIREPROXY_VERSION=v1.1.3
# the module may want a newer Go than the image's: let go fetch the toolchain it asks for
ENV GOTOOLCHAIN=auto
RUN CGO_ENABLED=0 go install github.com/windtf/wireproxy/cmd/wireproxy@${WIREPROXY_VERSION}

FROM node:22-bookworm-slim AS node

FROM python:3.11-slim-bookworm

ARG YTDLP_VERSION=2026.8.19

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    FETCH_WORK_DIR=/tmp/chords-fetch \
    PORT=8080

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=wireproxy /go/bin/wireproxy /usr/local/bin/wireproxy

RUN pip install "yt-dlp[default]==${YTDLP_VERSION}" "fastapi==0.142.2" "uvicorn[standard]==0.54.0" \
      "google-cloud-storage==3.16.0" "google-auth==2.59.1"

RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /tmp --no-create-home --shell /usr/sbin/nologin app

WORKDIR /app
COPY app/__init__.py app/models.py app/sources.py app/gcs.py app/warp.py app/fetch_service.py ./app/
USER 10001:10001

EXPOSE 8080
# Cloud Run sets $PORT and mounts the WARP profile (Secret Manager) at $WARP_PROFILE.
CMD ["sh", "-c", "exec uvicorn --factory app.fetch_service:create_app_from_env --host 0.0.0.0 --port ${PORT:-8080} --no-access-log --timeout-keep-alive 65"]
```

Create `backend/fetch.cloudbuild.yaml`:

```yaml
# Cloud Build: backend/fetch.Dockerfile -> Artifact Registry. Run by scripts/deploy_fetch.sh:
#   gcloud builds submit backend --config backend/fetch.cloudbuild.yaml --region europe-west1 --substitutions _IMAGE=<repo>/fetch,_TAG=<tag>
# The previous :latest image seeds the layer cache, so code-only redeploys skip the Go and pip layers.
steps:
  - id: pull-cache
    name: gcr.io/cloud-builders/docker
    entrypoint: bash
    args: ["-c", "docker pull ${_IMAGE}:latest || echo 'no cached image yet'"]
  - id: build
    name: gcr.io/cloud-builders/docker
    args:
      - build
      - --file=fetch.Dockerfile
      - --build-arg=BUILDKIT_INLINE_CACHE=1
      - --cache-from=${_IMAGE}:latest
      - --tag=${_IMAGE}:${_TAG}
      - --tag=${_IMAGE}:latest
      - .
images:
  - ${_IMAGE}:${_TAG}
  - ${_IMAGE}:latest
substitutions:
  _IMAGE: europe-west1-docker.pkg.dev/build-chords-listener/chords/fetch
  _TAG: manual
timeout: 1800s
options:
  logging: CLOUD_LOGGING_ONLY
```

In `backend/.gcloudignore`, add after `!/Dockerfile`:

```
!/fetch.Dockerfile
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && uv run pytest tests/test_fetch_image.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Build the image locally when Docker is available**

```bash
docker build --platform linux/amd64 -f backend/fetch.Dockerfile -t chords-fetch backend
docker run --rm --platform linux/amd64 --entrypoint wireproxy chords-fetch --version
docker run --rm --platform linux/amd64 --entrypoint python chords-fetch -c "import app.fetch_service, yt_dlp.version; print(yt_dlp.version.__version__)"
```

Expected: the build succeeds; wireproxy prints `wireproxy, version v1.1.3`; python prints `2026.08.19`. Without Docker, skip this step and say so in the task report (Cloud Build in Task 18 is then the first real build).

- [ ] **Step 6: Commit**

```bash
git add backend/fetch.Dockerfile backend/fetch.cloudbuild.yaml backend/.gcloudignore backend/tests/test_fetch_image.py
git commit -m "$(cat <<'EOF'
YouTube clips: chords-fetch image (yt-dlp pinned to the lock, wireproxy, ffmpeg, node)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Deploy scripts (`gcloud_common.sh`, `deploy_fetch.sh`, `deploy_cloud.sh`)

**Files:**
- Create: `scripts/gcloud_common.sh` (sourced), `scripts/deploy_fetch.sh` (executable)
- Modify: `scripts/deploy_cloud.sh` (source the common file; build via `cloud_build`; set `CHORDS_FETCH_URL` / `CHORDS_YT_CLIP_S`)

**Interfaces:**
- Consumes: `backend/fetch.cloudbuild.yaml` (Task 7); `create_app_from_env` env contract (Task 6): `FETCH_BUCKET`, `WARP_PROFILE`, `FETCH_WORK_DIR`; `Settings.fetch_url` / `clip_s` env names (Task 1).
- Produces: `scripts/gcloud_common.sh` defining `$GCLOUD`, `log`, `elapsed`, `refresh_token`, `gc`, `api`, `cloud_build CONFIG IMAGE TAG` (expects `ROOT`, `PROJECT`, `REGION`, `TMP` set before `source`); `scripts/deploy_fetch.sh` (env knobs `PROJECT`, `REGION`, `SERVICE=chords-fetch`, `FETCH_MAX_INSTANCES=3`, `SKIP_SETUP`, `SKIP_BUILD`); `deploy_cloud.sh` writes `CHORDS_FETCH_URL` (when the `chords-fetch` service exists) and `CHORDS_YT_CLIP_S: "30"`.

No unit tests: shell. The gate is `bash -n`, `shellcheck` (when installed) and a sourcing check. Nothing here is run against the cloud in this task.

- [ ] **Step 1: Create `scripts/gcloud_common.sh`**

Move the credential code out of `deploy_cloud.sh` verbatim (from `GCLOUD="${GCLOUD:-...` through the `api()` function, plus `export CLOUDSDK_...`, `STARTED`, `log`, `elapsed`) and add `cloud_build` (the build loop of `deploy_cloud.sh`, as a function):

```bash
# Shared by scripts/deploy_cloud.sh and scripts/deploy_fetch.sh (sourced, not run). Expects ROOT, PROJECT, REGION
# and TMP (a private 0700 temp dir) to be set. Provides $GCLOUD, log, elapsed, refresh_token, gc (gcloud with a
# fresh token), api (a REST call with the token) and cloud_build (Cloud Build in $REGION, waits, cleans up).
#
# Credentials: a normal `gcloud auth login`, or - without one - an access token minted from the firebase-tools
# login (scripts/gcloud_token.cjs, re-minted every 40 min, kept in a 0600 file in $TMP). Nothing secret is printed.

GCLOUD="${GCLOUD:-$(command -v gcloud || true)}"
[[ -x "$GCLOUD" ]] || GCLOUD=/opt/homebrew/share/google-cloud-sdk/bin/gcloud
[[ -x "$GCLOUD" ]] || { echo "gcloud not found (set GCLOUD=/path/to/gcloud)" >&2; exit 1; }
export CLOUDSDK_CORE_PROJECT="$PROJECT" CLOUDSDK_CORE_DISABLE_PROMPTS=1

STARTED=$(date +%s)
log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
elapsed() { echo "$(( $(date +%s) - STARTED ))s"; }

# ------------------------------------------------------------------------------ credentials
TOKEN_FILE="$TMP/token"
TOKEN_AT=0
if [[ -n "${CLOUDSDK_AUTH_ACCESS_TOKEN_FILE:-}" ]]; then
  AUTH_MODE=file # the caller manages the token
  cp "$CLOUDSDK_AUTH_ACCESS_TOKEN_FILE" "$TOKEN_FILE"
elif "$GCLOUD" auth print-access-token >/dev/null 2>&1; then
  AUTH_MODE=gcloud
else
  AUTH_MODE=mint
fi

refresh_token() { # keeps $TOKEN_FILE fresh (tokens live ~60 min)
  local now
  now=$(date +%s)
  if (( now - TOKEN_AT < 2400 )); then return; fi
  case "$AUTH_MODE" in
    mint)
      node "$ROOT/scripts/gcloud_token.cjs" "$TOKEN_FILE" >/dev/null
      export CLOUDSDK_AUTH_ACCESS_TOKEN_FILE="$TOKEN_FILE" ;;
    gcloud)
      (umask 077; "$GCLOUD" auth print-access-token > "$TOKEN_FILE") ;;
    file)
      cp "$CLOUDSDK_AUTH_ACCESS_TOKEN_FILE" "$TOKEN_FILE" ;;
  esac
  TOKEN_AT=$now
}
refresh_token
gc() { refresh_token; "$GCLOUD" "$@"; }

# REST call with the access token (header read from a 0600 file, never on a command line).
# Usage: api METHOD URL [JSON]; sets API_STATUS, body in $TMP/api.out
api() {
  refresh_token
  (umask 077; printf 'Authorization: Bearer %s\nx-goog-user-project: %s\n' "$(cat "$TOKEN_FILE")" "$PROJECT" > "$TMP/auth.hdr")
  local data=()
  if [[ $# -ge 3 ]]; then data=(-H 'Content-Type: application/json' --data "$3"); fi
  API_STATUS=$(curl -sS -o "$TMP/api.out" -w '%{http_code}' -X "$1" -H @"$TMP/auth.hdr" ${data[@]+"${data[@]}"} "$2")
  rm -f "$TMP/auth.hdr"
}

# ------------------------------------------------------------------------------ Cloud Build
# Builds backend/ with CONFIG into IMAGE:TAG in $REGION (the repository's region: the cache pull of the previous
# image stays inside it), waits, prints the log tail on failure, deletes the uploaded source archive.
# Usage: cloud_build CONFIG IMAGE TAG
cloud_build() {
  local config=$1 image=$2 tag=$3 build_id status src
  build_id=$(gc builds submit "$ROOT/backend" --config "$config" --region "$REGION" \
    --substitutions "_IMAGE=$image,_TAG=$tag" --async --format='value(id)')
  echo "build $build_id: https://console.cloud.google.com/cloud-build/builds;region=$REGION/$build_id?project=$PROJECT"
  while true; do
    status=$(gc builds describe "$build_id" --region "$REGION" --format='value(status)')
    case "$status" in
      SUCCESS) break ;;
      FAILURE|INTERNAL_ERROR|TIMEOUT|CANCELLED|EXPIRED)
        echo "build $status - last log lines:" >&2
        gc logging read "resource.type=build AND resource.labels.build_id=$build_id" --limit 80 \
          --format='value(textPayload)' --order=desc 2>/dev/null \
          | awk '{ line[NR] = $0 } END { for (i = NR; i > 0; i--) print line[i] }' >&2 || true
        exit 1 ;;
    esac
    printf '  %s (%s)\n' "$status" "$(elapsed)"
    sleep 20
  done
  echo "build finished ($(elapsed))"
  src=$(gc builds describe "$build_id" --region "$REGION" \
    --format='value(source.storageSource.bucket,source.storageSource.object)' | tr '\t' '/')
  if [[ -n "$src" && "$src" != "/" ]]; then gc storage rm "gs://$src" >/dev/null 2>&1 || true; fi
}
```

- [ ] **Step 2: Switch `scripts/deploy_cloud.sh` to it**

1. Delete from `GCLOUD="${GCLOUD:-...` down to the end of `api()` **except** the tool check loop and the `TMP=...`/`chmod`/`trap` lines; keep the order: variables → tool check → `TMP` → `source`:

```bash
for tool in node curl openssl python3; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/chords-deploy.XXXXXX")"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
# shellcheck source=scripts/gcloud_common.sh
source "$ROOT/scripts/gcloud_common.sh"

log "Project $PROJECT, region $REGION, service $SERVICE (auth: $AUTH_MODE)"
```

2. Replace the `# ---- build` section with:

```bash
# ------------------------------------------------------------------------------ build
if [[ -z "${SKIP_BUILD:-}" ]]; then
  TAG="${IMAGE_TAG:-$(date -u +%Y%m%d-%H%M%S)}"
  log "Cloud Build: $IMAGE:$TAG"
  cloud_build "$ROOT/backend/cloudbuild.yaml" "$IMAGE" "$TAG"
  DEPLOY_IMAGE="$IMAGE:$TAG"
else
  DEPLOY_IMAGE="$IMAGE:latest"
fi
```

3. Right before `log "Deploying $SERVICE ($DEPLOY_IMAGE)"`, add:

```bash
# YouTube fragments: chords-api calls chords-fetch (scripts/deploy_fetch.sh) when that service exists
FETCH_URL=$(gc run services describe "${FETCH_SERVICE:-chords-fetch}" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)
```

and after the `cat > "$TMP/env.yaml" <<EOF ... EOF` block (still inside the `umask 077` subshell):

```bash
  echo "CHORDS_YT_CLIP_S: \"30\"" >> "$TMP/env.yaml"
  if [[ -n "$FETCH_URL" ]]; then echo "CHORDS_FETCH_URL: \"$FETCH_URL\"" >> "$TMP/env.yaml"; fi
```

and after the deploy, next to the other `echo` lines:

```bash
echo "YouTube fragments: ${FETCH_URL:-off (no chords-fetch: run scripts/deploy_fetch.sh, then this script again)}"
```

4. In the header comment, replace the "Credentials:" paragraph with `# Credentials and Cloud Build: scripts/gcloud_common.sh.`

- [ ] **Step 3: Create `scripts/deploy_fetch.sh`**

```bash
#!/usr/bin/env bash
# Deploys chords-fetch (short YouTube fragments through Cloudflare WARP, docs/CLOUD.md → YouTube clips) to Cloud
# Run with what it needs: the WARP profile in Secret Manager, Cloud NAT for Direct VPC egress, its own service
# account. Idempotent: re-run it to redeploy. Then run scripts/deploy_cloud.sh so chords-api gets CHORDS_FETCH_URL.
#
#   scripts/deploy_fetch.sh                  everything: setup + Cloud Build + deploy + one direct fragment
#   SKIP_SETUP=1 scripts/deploy_fetch.sh     code-only redeploy (no APIs / secret / NAT / IAM steps)
#   SKIP_BUILD=1 scripts/deploy_fetch.sh     redeploy the newest image (settings only)
#
# The WARP profile: registered once with a local `wgcf` (brew install wgcf) after you confirm Cloudflare's terms,
# stored only as the secret `warp-profile`; never printed, never written into the repository.
# Cost: the Cloud NAT gateway + its IP ≈ $4–5 / month whether used or not; NAT data ≈ $0.045 / GB (a fragment is
# ~0.5 MB); the service itself stays in Cloud Run's free tier at this scale.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${PROJECT:-build-chords-listener}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-chords-fetch}"
REPO="${REPO:-chords}"
BUCKET="${BUCKET:-$PROJECT.firebasestorage.app}"
IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPO/fetch"
FETCH_SA_NAME="${FETCH_SA_NAME:-chords-fetch}"
FETCH_SA="$FETCH_SA_NAME@$PROJECT.iam.gserviceaccount.com"
API_SA="${API_SA:-chords-api@$PROJECT.iam.gserviceaccount.com}"
SECRET="${SECRET:-warp-profile}"
NETWORK="${NETWORK:-default}"
SUBNET="${SUBNET:-default}"
ROUTER="${ROUTER:-chords-nat-router}"
NAT="${NAT:-chords-nat}"
FETCH_MAX_INSTANCES="${FETCH_MAX_INSTANCES:-3}"
PROFILE_MOUNT=/secrets/warp/wgcf-profile.conf

for tool in node curl python3; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/chords-fetch-deploy.XXXXXX")"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
# shellcheck source=scripts/gcloud_common.sh
source "$ROOT/scripts/gcloud_common.sh"

log "Project $PROJECT, region $REGION, service $SERVICE (auth: $AUTH_MODE)"

if [[ -z "${SKIP_SETUP:-}" ]]; then
  # ---------------------------------------------------------------------------- APIs
  log "Enabling APIs"
  gc services enable secretmanager.googleapis.com compute.googleapis.com run.googleapis.com \
    cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com

  # ---------------------------------------------------------------------------- WARP profile
  log "WARP profile (secret $SECRET)"
  if gc secrets describe "$SECRET" >/dev/null 2>&1; then
    echo "exists"
  else
    command -v wgcf >/dev/null || { echo "wgcf is needed once to register the WARP device: brew install wgcf" >&2; exit 1; }
    [[ -t 0 ]] || { echo "registering the WARP device needs your confirmation: run this script in a terminal" >&2; exit 1; }
    echo "This registers ONE new Cloudflare WARP device for chords-fetch and accepts Cloudflare's terms of service"
    echo "(https://www.cloudflare.com/application/terms/). The profile is stored only in Secret Manager."
    read -r -p "Register it now? [y/N] " answer
    [[ "$answer" == [yY]* ]] || { echo "stopped: no WARP profile" >&2; exit 1; }
    (cd "$TMP" && umask 077 && wgcf register --accept-tos >/dev/null && wgcf generate >/dev/null)
    gc secrets create "$SECRET" --replication-policy=automatic --data-file="$TMP/wgcf-profile.conf" >/dev/null
    rm -f "$TMP/wgcf-profile.conf" "$TMP/wgcf-account.toml"
    echo "stored as secret $SECRET"
  fi

  # ---------------------------------------------------------------------------- Cloud NAT
  # Direct VPC egress + Cloud NAT: the only egress on which WireGuard (WARP) carries real payloads from Cloud Run
  log "Cloud NAT $NAT (router $ROUTER, $REGION) + Private Google Access on $SUBNET"
  gc compute routers describe "$ROUTER" --region "$REGION" >/dev/null 2>&1 \
    || gc compute routers create "$ROUTER" --network "$NETWORK" --region "$REGION"
  gc compute routers nats describe "$NAT" --router "$ROUTER" --region "$REGION" >/dev/null 2>&1 \
    || gc compute routers nats create "$NAT" --router "$ROUTER" --region "$REGION" \
         --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges
  # the bucket and the token endpoints are reached without NAT
  gc compute networks subnets update "$SUBNET" --region "$REGION" --enable-private-ip-google-access

  # ---------------------------------------------------------------------------- service account + IAM
  log "Service account $FETCH_SA"
  if ! gc iam service-accounts describe "$FETCH_SA" >/dev/null 2>&1; then
    gc iam service-accounts create "$FETCH_SA_NAME" --display-name="Chords Listener fetch (Cloud Run)"
  fi
  for attempt in 1 2 3 4 5 6; do # a new service account takes a moment to become usable in IAM
    if gc storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$FETCH_SA" \
        --role=roles/storage.objectUser \
        --condition="expression=resource.name.startsWith('projects/_/buckets/$BUCKET/objects/fetch/'),title=fetch-only,description=chords-fetch writes only under fetch/" \
        >/dev/null 2>"$TMP/iam.err"; then
      echo "roles/storage.objectUser on gs://$BUCKET/fetch/ only"; break
    fi
    [[ $attempt == 6 ]] && { cat "$TMP/iam.err" >&2; exit 1; }
    sleep 10
  done
  gc secrets add-iam-policy-binding "$SECRET" --member="serviceAccount:$FETCH_SA" \
    --role=roles/secretmanager.secretAccessor >/dev/null
  echo "roles/secretmanager.secretAccessor on $SECRET"

  log "Artifact Registry repository $REPO"
  if ! gc artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1; then
    gc artifacts repositories create "$REPO" --repository-format=docker --location "$REGION" \
      --description="Chords Listener images"
  fi
fi

# ------------------------------------------------------------------------------ build
if [[ -z "${SKIP_BUILD:-}" ]]; then
  TAG="${IMAGE_TAG:-$(date -u +%Y%m%d-%H%M%S)}"
  log "Cloud Build: $IMAGE:$TAG"
  cloud_build "$ROOT/backend/fetch.cloudbuild.yaml" "$IMAGE" "$TAG"
  DEPLOY_IMAGE="$IMAGE:$TAG"
else
  DEPLOY_IMAGE="$IMAGE:latest"
fi

# ------------------------------------------------------------------------------ deploy
log "Deploying $SERVICE ($DEPLOY_IMAGE)"
gc run deploy "$SERVICE" \
  --image "$DEPLOY_IMAGE" \
  --region "$REGION" \
  --execution-environment gen2 \
  --cpu 1 --memory 1Gi \
  --cpu-throttling \
  --cpu-boost \
  --concurrency 1 \
  --min-instances 0 \
  --max-instances "$FETCH_MAX_INSTANCES" \
  --timeout 300 \
  --port 8080 \
  --no-allow-unauthenticated \
  --service-account "$FETCH_SA" \
  --network "$NETWORK" --subnet "$SUBNET" --vpc-egress all-traffic \
  --set-secrets "$PROFILE_MOUNT=$SECRET:latest" \
  --set-env-vars "FETCH_BUCKET=$BUCKET,WARP_PROFILE=$PROFILE_MOUNT,FETCH_WORK_DIR=/tmp/chords-fetch" \
  --quiet
gc run services add-iam-policy-binding "$SERVICE" --region "$REGION" \
  --member="serviceAccount:$API_SA" --role=roles/run.invoker >/dev/null
echo "roles/run.invoker for $API_SA"

URL=$(gc run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')

# ------------------------------------------------------------------------------ smoke: one fragment, straight
if ID_TOKEN=$("$GCLOUD" auth print-identity-token 2>/dev/null) && [[ -n "$ID_TOKEN" ]]; then
  log "Smoke: one fragment straight from $SERVICE"
  (umask 077; printf 'Authorization: Bearer %s\n' "$ID_TOKEN" > "$TMP/id.hdr")
  STATUS=$(curl -sS --max-time 300 -o "$TMP/clip.json" -w '%{http_code}' -H @"$TMP/id.hdr" \
    -H 'Content-Type: application/json' --data '{"videoId":"dQw4w9WgXcQ","start":60,"length":30}' "$URL/clip" || echo 000)
  rm -f "$TMP/id.hdr"
  echo "HTTP $STATUS"
  OBJECT=$(python3 - "$TMP/clip.json" <<'PY' || true
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
print({k: d.get(k) for k in ("title", "start", "end", "size", "code", "message")}, file=sys.stderr)
print(d.get("path") or "")
PY
)
  if [[ -n "$OBJECT" ]]; then gc storage rm "gs://$BUCKET/$OBJECT" >/dev/null 2>&1 || true; fi
  [[ "$STATUS" == 200 ]] || echo "the direct fragment failed: see the logs of $SERVICE" >&2
else
  echo "no gcloud identity token (firebase-tools login): skipped the direct fragment; run scripts/smoke_fetch.py"
fi

log "Done in $(elapsed)"
echo "Service URL: $URL"
echo "Next: scripts/deploy_cloud.sh (sets CHORDS_FETCH_URL on chords-api), then python3 scripts/smoke_fetch.py"
```

Then `chmod +x scripts/deploy_fetch.sh`.

- [ ] **Step 4: Check the scripts without touching the cloud**

```bash
bash -n scripts/gcloud_common.sh scripts/deploy_cloud.sh scripts/deploy_fetch.sh && echo syntax-ok
command -v shellcheck >/dev/null && shellcheck -x scripts/gcloud_common.sh scripts/deploy_cloud.sh scripts/deploy_fetch.sh
bash -c 'set -euo pipefail; ROOT=$PWD PROJECT=build-chords-listener REGION=europe-west1 TMP=$(mktemp -d); source scripts/gcloud_common.sh; type gc api log elapsed cloud_build >/dev/null && echo sourced-ok'
git diff --stat scripts/deploy_cloud.sh
```

Expected: `syntax-ok`, no shellcheck errors (warnings that already existed in `deploy_cloud.sh` may stay), `sourced-ok`. The diff of `deploy_cloud.sh` only removes the moved blocks and adds the four changes above — read it once against the old file to make sure no setup step was lost.

- [ ] **Step 5: Commit**

```bash
git add scripts/gcloud_common.sh scripts/deploy_fetch.sh scripts/deploy_cloud.sh
git commit -m "$(cat <<'EOF'
Deploy: chords-fetch script (WARP secret, Cloud NAT, IAM); chords-api gets CHORDS_FETCH_URL

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Live smoke test (`scripts/smoke_fetch.py`)

**Files:**
- Create: `scripts/smoke_fetch.py`

**Interfaces:**
- Consumes: `scripts/smoke_cloud.py` (`Api`, `check`, `read_env_file`, `DEFAULT_URL`, `RESULTS`); `POST /api/jobs {url, clip}` (Task 4).
- Produces: `python3 scripts/smoke_fetch.py [--url URL] [--videos ID,ID] [--start S] [--keep]`, exit 0 when every fragment became a track with chords and `clip` and the repeat was deduplicated.

- [ ] **Step 1: Write the script**

```python
#!/usr/bin/env python3
"""Live check of YouTube fragments through chords-api + chords-fetch (docs/CLOUD.md → YouTube clips), as the
``smoke-test`` user: the 18 videos of the WARP spike, one 30-second fragment each (from --start, or from 0 when the
video is shorter), each must become a track with chords and ``clip``; the first fragment asked again must be done at
once (dedup). The tracks it made are deleted at the end unless --keep.

    python3 scripts/smoke_fetch.py [--url URL] [--videos ID,ID,...] [--start S] [--keep]

Reads CHORDS_SMOKE_KEY from .cloud.env; standard library only (shares scripts/smoke_cloud.py's helpers).
"""
from __future__ import annotations

import argparse
import os
import sys
import time

from smoke_cloud import DEFAULT_URL, RESULTS, Api, check, read_env_file

SPIKE_VIDEOS = (
    "dQw4w9WgXcQ kJQP7kiw5Fk JGwWNGJdvx8 fJ9rUzIMcZQ 9bZkp7q19f0 hTWKbfoikeg YQHsXMglC9A 60ItHLz5WEA OPf0YbXqDm0 "
    "RgKAFK5djSk CevxZvSJLk8 09R8_2nJtjg pRpeEdMmmQ0 hT_nvWreIhg lp-EO5I60KA kXYiU_JCYtU YykjpeuMNEk fRh_vgS2dFE"
).split()


def fragment(api: Api, video_id: str, start: int) -> tuple[dict, float]:
    """Asks for one fragment and waits for its job; a start past a short video's end falls back to 0."""
    started = time.monotonic()
    body = {"url": f"https://www.youtube.com/watch?v={video_id}", "clip": {"start": start}}
    res = api.request("POST", "/api/jobs", json_body=body)
    if res.status == 501:
        return {"status": "error", "errorCode": "unavailable", "error": "chords-api has no CHORDS_FETCH_URL"}, 0.0
    if res.status != 201:
        return {"status": "error", "errorCode": f"http {res.status}", "error": res.body[:200].decode("utf-8", "replace")}, 0.0
    job = api.wait_job(res.json()["id"], timeout=360)
    if job.get("errorCode") == "invalid_url" and start > 0:
        return fragment(api, video_id, 0)
    return job, time.monotonic() - started


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--url", default=os.environ.get("CHORDS_CLOUD_URL", DEFAULT_URL))
    ap.add_argument("--videos", default=",".join(SPIKE_VIDEOS), help="comma-separated video ids")
    ap.add_argument("--start", type=int, default=45, help="fragment start, seconds")
    ap.add_argument("--keep", action="store_true", help="keep the tracks it made")
    args = ap.parse_args()
    key = os.environ.get("CHORDS_SMOKE_KEY") or read_env_file().get("CHORDS_SMOKE_KEY", "")
    if not key:
        print("CHORDS_SMOKE_KEY not found (.cloud.env)", file=sys.stderr)
        return 2
    api = Api(args.url, key)
    videos = [v.strip() for v in args.videos.split(",") if v.strip()]
    print(f"YouTube fragments through {api.base}: {len(videos)} videos from {args.start} s", flush=True)
    made: list[str] = []
    blocked = 0
    try:
        for video_id in videos:
            job, seconds = fragment(api, video_id, args.start)
            ok = job.get("status") == "done"
            track: dict = {}
            if ok:
                made.append(job["trackId"])
                track = api.request("GET", f"/api/tracks/{job['trackId']}").json()
                ok = bool(track.get("clip")) and bool(track.get("chords")) and track["source"].get("videoId") == video_id
            blocked += job.get("errorCode") == "download_blocked"
            clip = track.get("clip") or job.get("clip") or {}
            check(f"fragment {video_id}", ok,
                  f"{clip.get('start')}–{clip.get('end')} s in {seconds:.0f}s" if ok
                  else f"[{job.get('errorCode')}] {job.get('error')}")
        if made:
            first = videos[0]
            res = api.request("POST", "/api/jobs", json_body={"url": first, "clip": {"start": args.start}})
            again = res.json() if res.status == 201 else {}
            check("the same fragment again is done at once", again.get("status") == "done" and again.get("trackId") in made,
                  f"{again.get('status')} {again.get('message')}")
    finally:
        if not args.keep:
            for track_id in made:
                api.request("DELETE", f"/api/tracks/{track_id}")
    failed = [name for name, ok, _ in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed; download_blocked: {blocked}"
          + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
```

Note: the dedup check posts the bare id `videos[0]` as `url` (the API accepts a bare 11-char id, `normalize_url`), and with `--start` past that video's end it would not be deduplicated: the default 45 s fits every spike video.

- [ ] **Step 2: Check it offline**

```bash
python3 -m py_compile scripts/smoke_fetch.py && (cd scripts && python3 smoke_fetch.py --help)
```

Expected: the usage text, exit 0. (The live run is part of Task 18.)

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke_fetch.py
git commit -m "$(cat <<'EOF'
Smoke: YouTube fragments through chords-api and chords-fetch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Client contract — types, `createClipJob`, `submitClip`, routes

**Files:**
- Modify: `frontend/src/types.ts`, `frontend/src/lib/api.ts`, `frontend/src/hooks/useJobs.ts`, `frontend/src/hooks/useRoute.ts`
- Modify: `frontend/src/lib/tour/trigger.test.ts` (the `capture` route literal gains `start`)
- Test: `frontend/src/hooks/useRoute.test.ts`, `frontend/src/lib/api.cloud.test.ts` (append)

**Interfaces:**
- Consumes: the API contract of Tasks 1 and 4 (`clip` on Job / TrackSummary; `POST /api/jobs {url, clip: {start}}`; 501 `unavailable`).
- Produces: `interface ClipRange { start: number; end: number }`; `Job.clip?: ClipRange | null`; `TrackSummary.clip?: ClipRange | null`; `api.createClipJob(videoId: string, start: number, signal?: AbortSignal): Promise<Job>`; `submitClip(videoId: string, start: number, signal?: AbortSignal): Promise<Job>` (useJobs; follows the job like `submitUrl`); `Route` gains `{ name: 'clip'; videoId: string; start: number | null }` and `start: number | null` on `capture`; `paths.clip(videoId, { t?: number | null })` → `/youtube/<id>[?t=<whole s>]`; `paths.capture(videoId, { blocked?: boolean; t?: number | null })` → `/listen/youtube/<id>[?blocked=1][&t=<s>]` (`t` < 1 is left out).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/hooks/useRoute.test.ts`:

```ts
describe('YouTube routes', () => {
  const ID = 'dQw4w9WgXcQ'

  it('the fragment picker, with the start when given', () => {
    expect(paths.clip(ID)).toBe(`/youtube/${ID}`)
    expect(paths.clip(ID, { t: 72.9 })).toBe(`/youtube/${ID}?t=72`)
    expect(parseHash(`#/youtube/${ID}`)).toEqual({ name: 'clip', videoId: ID, start: null })
    expect(parseHash(`#${paths.clip(ID, { t: 72 })}`)).toEqual({ name: 'clip', videoId: ID, start: 72 })
    expect(parseHash(`#/youtube/${ID}?t=abc`)).toEqual({ name: 'clip', videoId: ID, start: null })
    expect(parseHash('#/youtube/not-an-id')).toEqual({ name: 'notFound' })
  })

  it('the capture page keeps ?blocked=1 and takes a start', () => {
    expect(paths.capture(ID, { blocked: true })).toBe(`/listen/youtube/${ID}?blocked=1`)
    expect(paths.capture(ID, { blocked: true, t: 72 })).toBe(`/listen/youtube/${ID}?blocked=1&t=72`)
    expect(paths.capture(ID, { t: 0 })).toBe(`/listen/youtube/${ID}`)
    expect(parseHash(`#/listen/youtube/${ID}?blocked=1&t=72`)).toEqual({ name: 'capture', videoId: ID, blocked: true, start: 72 })
    expect(parseHash(`#/listen/youtube/${ID}`)).toEqual({ name: 'capture', videoId: ID, blocked: false, start: null })
  })
})
```

Append to `frontend/src/lib/api.cloud.test.ts`:

```ts
describe('YouTube fragments', () => {
  it('ask the cloud for a fragment from a whole-second start', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...job, clip: { start: 72, end: 102 } }, 201))
    const started = await api.createClipJob('dQw4w9WgXcQ', 72.8)
    expect(started.clip).toEqual({ start: 72, end: 102 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`${CLOUD}/api/jobs`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', clip: { start: 72 } })
  })

  it('report a cloud without the fragment service as unavailable', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: "YouTube fragments can't be downloaded on this server", code: 'unavailable' }, 501))
    await expect(api.createClipJob('dQw4w9WgXcQ', 0)).rejects.toMatchObject({ code: 'unavailable', status: 501 })
  })
})
```

In `frontend/src/lib/tour/trigger.test.ts`, change the helper to:

```ts
const capture = (blocked: boolean): Route => ({ name: 'capture', videoId: 'dQw4w9WgXcQ', blocked, start: null })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/hooks/useRoute.test.ts src/lib/api.cloud.test.ts`
Expected: FAIL: `paths.clip is not a function`, `api.createClipJob is not a function`.

- [ ] **Step 3: Implement**

`frontend/src/types.ts` — add before `export interface Job`:

```ts
/** A fragment of a YouTube video, in video seconds (docs/CLOUD.md → YouTube clips). */
export interface ClipRange {
  start: number
  end: number
}
```

in `Job`, after `source`:

```ts
  /** a YouTube fragment job: the range asked for (exact once the fragment is downloaded) */
  clip?: ClipRange | null
```

in `TrackSummary`, after `stems`:

```ts
  /**
   * A fragment of a YouTube video (the cloud downloaded only these seconds): the player starts the video at
   * `clip.start` and stops at `clip.end`; the track is also a recording linked to the video (`startOffset`).
   */
  clip?: ClipRange | null
```

`frontend/src/lib/api.ts` — add after `createJob`:

```ts
/** Analyzes a fragment of a YouTube video on the cloud: POST /api/jobs with `clip` (whole seconds from `start`). */
export async function createClipJob(videoId: string, start: number, signal?: AbortSignal): Promise<Job> {
  const conn = await whenSettled()
  if (conn.status !== 'server')
    throw new ApiError('YouTube fragments need the cloud (sign in)', 'server_required')
  const job = await request<Job>('/jobs', {
    method: 'POST',
    body: JSON.stringify({
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      clip: { start: Math.max(0, Math.floor(start)) },
    }),
    signal,
  })
  return startedJob(job)
}
```

`frontend/src/hooks/useJobs.ts` — add after `submitUrl`:

```ts
/** Starts a YouTube fragment on the cloud and follows its job (navigates to it). Throws ApiError. */
export async function submitClip(videoId: string, start: number, signal?: AbortSignal): Promise<Job> {
  const fromPath = currentPath()
  const job = await api.createClipJob(videoId, start, signal)
  upsert(job)
  follow(job, fromPath)
  return job
}
```

`frontend/src/hooks/useRoute.ts` — replace the header comment, the `Route` type's `capture` member, `paths.capture` and the YouTube branch of `parseHash`; add the `clip` route:

```ts
/**
 * Hash-based routes: #/ · #/job/<id> · #/track/<id> · #/demo ·
 * #/listen[?src=mic|tab][&title=<name>] (live chords from the microphone / a tab; the title names the recording) ·
 * #/listen/youtube/<videoId>[?blocked=1][&t=<s>] (play a YouTube video here and listen to this tab, from t) ·
 * #/youtube/<videoId>[?t=<s>] (pick a fragment of a YouTube video for the cloud, starting at t)
 */
export type Route =
  | { name: 'home' }
  | { name: 'job'; id: string }
  | { name: 'track'; id: string }
  | { name: 'demo' }
  | { name: 'listen'; source: 'mic' | 'tab' | null; title: string | null }
  | { name: 'capture'; videoId: string; blocked: boolean; start: number | null }
  | { name: 'clip'; videoId: string; start: number | null }
  | { name: 'notFound' }

/** `t=` of the YouTube routes: whole seconds, left out below 1. */
function setStart(q: URLSearchParams, t: number | null | undefined) {
  if (t !== undefined && t !== null && Number.isFinite(t) && t >= 1) q.set('t', String(Math.floor(t)))
}

function withQuery(path: string, q: URLSearchParams): string {
  const s = q.toString()
  return s ? `${path}?${s}` : path
}
```

```ts
  capture: (videoId: string, opts: { blocked?: boolean; t?: number | null } = {}) => {
    const q = new URLSearchParams()
    if (opts.blocked) q.set('blocked', '1')
    setStart(q, opts.t)
    return withQuery(`/listen/youtube/${encodeURIComponent(videoId)}`, q)
  },
  clip: (videoId: string, opts: { t?: number | null } = {}) => {
    const q = new URLSearchParams()
    setStart(q, opts.t)
    return withQuery(`/youtube/${encodeURIComponent(videoId)}`, q)
  },
```

```ts
function decodeVideoId(raw: string): string | null {
  let id = raw
  try {
    id = decodeURIComponent(raw)
  } catch {
    /* keep raw */
  }
  return VIDEO_ID_RE.test(id) ? id : null
}

function parseStart(raw: string | null): number | null {
  return raw !== null && /^\d{1,6}$/.test(raw) ? Number(raw) : null
}
```

and in `parseHash`, replace the `const yt = ...` block with:

```ts
  const yt = /^\/listen\/youtube\/([^/?#]+)$/.exec(path)
  if (yt) {
    const videoId = decodeVideoId(yt[1])
    return videoId
      ? { name: 'capture', videoId, blocked: query.get('blocked') === '1', start: parseStart(query.get('t')) }
      : { name: 'notFound' }
  }
  const clip = /^\/youtube\/([^/?#]+)$/.exec(path)
  if (clip) {
    const videoId = decodeVideoId(clip[1])
    return videoId ? { name: 'clip', videoId, start: parseStart(query.get('t')) } : { name: 'notFound' }
  }
```

- [ ] **Step 4: Run the tests and the type check**

Run: `cd frontend && npx vitest run src/hooks src/lib/api.cloud.test.ts src/lib/tour && npx tsc -b`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/types.ts frontend/src/lib/api.ts frontend/src/hooks/useJobs.ts frontend/src/hooks/useRoute.ts frontend/src/hooks/useRoute.test.ts frontend/src/lib/api.cloud.test.ts frontend/src/lib/tour/trigger.test.ts
git commit -m "$(cat <<'EOF'
YouTube clips (web): clip types, createClipJob, picker and capture routes with t

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Signed-in YouTube links open the picker

**Files:**
- Modify: `frontend/src/components/input/url.ts` (`linkTarget`, new `parseYouTubeStart`)
- Modify: `frontend/src/components/input/startLink.ts`, `frontend/src/hooks/useJobs.ts` (`retryJob`), `frontend/src/components/input/SmartInput.tsx` (hint), `frontend/src/i18n/cloud.ts` (`cloud.input.hintYoutubeClip`)
- Test: `frontend/src/components/input/startLink.test.ts`, `frontend/src/hooks/useJobs.retry.test.ts`

**Interfaces:**
- Consumes: `paths.clip`, `paths.capture` (Task 10).
- Produces: `linkTarget(url, conn): 'clip' | 'capture' | 'notVideo' | 'server' | 'account'` — `'clip'` for a YouTube video when `conn.status === 'server' && conn.backend === 'cloud'` (the cloud is the API only for a signed-in user); `parseYouTubeStart(raw: string): number | null`; `LinkStart` gains `{ kind: 'clip'; videoId: string }`.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/components/input/startLink.test.ts`:
- header comment: "every YouTube link opens the capture page (guest or signed in)" → "a guest's YouTube link opens the capture page, a signed-in user's the fragment picker (the cloud downloads 30 s through chords-fetch)".
- import `parseYouTubeStart` from `./url` next to `parseYouTubeId`.
- in the `linkTarget` table, the row `['cloud', { status: 'server', backend: 'cloud' }, YT, 'capture']` becomes `['cloud', { status: 'server', backend: 'cloud' }, YT, 'clip']`.
- in `it.each(VIDEOS)(...)`: title `'a video, %s: a fragment on the cloud, listened to here as a guest; a local server downloads it'` and `expect(linkTarget(url, CLOUD_CONN)).toBe('clip')`.
- replace the test `'signed in on the cloud: YouTube is listened to here, nothing is sent'` with:

```ts
  it('signed in on the cloud: YouTube opens the fragment picker, nothing is sent yet', async () => {
    cloud()
    expect(await startLink(VIDEO)).toEqual({ kind: 'clip', videoId: 'dQw4w9WgXcQ' })
    expect(route.navigate).toHaveBeenCalledWith('/youtube/dQw4w9WgXcQ')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a link with its own start opens the picker there', async () => {
    cloud()
    await startLink('https://youtu.be/dQw4w9WgXcQ?t=1m12s')
    expect(route.navigate).toHaveBeenCalledWith('/youtube/dQw4w9WgXcQ?t=72')
  })
```

- append:

```ts
describe('parseYouTubeStart', () => {
  it.each([
    ['https://youtu.be/dQw4w9WgXcQ?t=72', 72],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=72s', 72],
    ['https://youtu.be/dQw4w9WgXcQ?t=1m12s', 72],
    ['https://youtu.be/dQw4w9WgXcQ?t=1h2m3s', 3723],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ?start=30', 30],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=45', 45],
    ['https://youtu.be/dQw4w9WgXcQ', null],
    ['https://youtu.be/dQw4w9WgXcQ?t=0', null],
    ['https://youtu.be/dQw4w9WgXcQ?t=abc', null],
    ['https://soundcloud.com/a/b?t=72', null],
  ] as const)('%s → %s', (url, start) => {
    expect(parseYouTubeStart(url)).toBe(start)
  })
})
```

In `frontend/src/hooks/useJobs.retry.test.ts`:
- header comment: "Retrying a YouTube job on the cloud: the video is listened to here (the cloud is never sent YouTube links)" → "Retrying a YouTube job: signed in, the fragment picker opens at the job's fragment; a guest listens in the tab".
- replace `'a YouTube video on the cloud: opens it on the capture page, nothing is sent'` and `'the video the job knows wins over what its link says'` with:

```ts
  it('a YouTube fragment on the cloud: the picker opens at its start, nothing is sent', async () => {
    cloud()
    const job = { ...failed({ type: 'youtube', videoId: 'dQw4w9WgXcQ', url: VIDEO }), clip: { start: 72, end: 102 } }
    expect(await retryJob(job)).toBe(true)
    expect(navigate).toHaveBeenCalledWith('/youtube/dQw4w9WgXcQ?t=72')
    expect(api.createJob).not.toHaveBeenCalled()
  })

  it('an older YouTube job on the cloud (no fragment): the picker from the beginning', async () => {
    cloud()
    expect(await retryJob(failed({ type: 'youtube', videoId: 'dQw4w9WgXcQ', url: VIDEO }))).toBe(true)
    expect(navigate).toHaveBeenCalledWith('/youtube/dQw4w9WgXcQ')
  })

  it('the video the job knows wins over what its link says', async () => {
    cloud()
    expect(await retryJob(failed({ type: 'youtube', videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/playlist?list=PL1' }))).toBe(true)
    expect(navigate).toHaveBeenCalledWith('/youtube/dQw4w9WgXcQ')
    expect(api.createJob).not.toHaveBeenCalled()
  })

  it('a guest listens to the video in the tab', async () => {
    connect({ status: 'browser', backend: null, apiBase: null, remote: false })
    expect(await retryJob(failed({ type: 'youtube', videoId: 'dQw4w9WgXcQ', url: VIDEO }))).toBe(true)
    expect(navigate).toHaveBeenCalledWith('/listen/youtube/dQw4w9WgXcQ')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/input/startLink.test.ts src/hooks/useJobs.retry.test.ts`
Expected: FAIL (`parseYouTubeStart` is not exported; `'capture'` received where `'clip'` is expected).

- [ ] **Step 3: Implement**

`frontend/src/components/input/url.ts` — replace `linkTarget` (and its doc comment) with:

```ts
/**
 * Where a link goes. A local server (home connection) downloads every link itself. Signed in on the cloud, a YouTube
 * video opens the fragment picker: the cloud downloads 30 s of it through chords-fetch (YouTube refuses the cloud's
 * own servers). Without an account a video is listened to in the browser ('capture'). Any other YouTube page (a
 * playlist, a channel, a clip) is not one video: 'notVideo', nothing is sent anywhere. Lives here, not in
 * startLink.ts, so hooks/useJobs.ts can use it without an import cycle.
 */
export function linkTarget(
  url: string,
  conn: Pick<ConnectionState, 'status' | 'backend'>,
): 'clip' | 'capture' | 'notVideo' | 'server' | 'account' {
  const server = conn.status === 'server'
  if (server && conn.backend === 'local') return 'server'
  if (youTubeUrl(url)) {
    if (!parseYouTubeId(url)) return 'notVideo'
    return server && conn.backend === 'cloud' ? 'clip' : 'capture'
  }
  return server ? 'server' : 'account'
}

/** A YouTube link's own start (`t=72`, `t=1m12s`, `start=30`, `#t=45`) in whole seconds; null when it has none. */
export function parseYouTubeStart(raw: string): number | null {
  const u = youTubeUrl(raw)
  if (!u) return null
  const value = (u.searchParams.get('t') ?? u.searchParams.get('start') ?? new URLSearchParams(u.hash.slice(1)).get('t') ?? '').trim()
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value)
  if (!value || !m) return null
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  return seconds > 0 ? seconds : null
}
```

`frontend/src/components/input/startLink.ts`:
- import `parseYouTubeStart` with `linkTarget, parseYouTubeId`.
- add to `LinkStart`: `/** signed in on the cloud: a YouTube video opens the fragment picker */ | { kind: 'clip'; videoId: string }`.
- in `startLink`, before `if (target === 'capture' && videoId)`:

```ts
  if (target === 'clip' && videoId) {
    navigate(paths.clip(videoId, { t: parseYouTubeStart(url) }))
    return { kind: 'clip', videoId }
  }
```

`frontend/src/hooks/useJobs.ts` — import `parseYouTubeId` stays; in `retryJob`, replace the link branch with:

```ts
  if (job.source?.type !== 'file' && job.source?.url) {
    const { url } = job.source
    const conn = useConnection.getState()
    const target = linkTarget(url, conn)
    // a YouTube video: signed in, the fragment picker (at the fragment this job asked for); a guest listens in the tab
    if (target === 'clip' || target === 'capture' || target === 'notVideo') {
      const videoId = job.source.videoId ?? parseYouTubeId(url)
      if (!videoId) return false
      const onCloud = conn.status === 'server' && conn.backend === 'cloud'
      navigate(onCloud ? paths.clip(videoId, { t: job.clip?.start }) : paths.capture(videoId))
      return true
    }
    await submitUrl(url)
    return true
  }
```

`frontend/src/components/input/SmartInput.tsx` — the `'youtube'` hint:

```tsx
      case 'youtube':
        // a local server downloads the video; signed in, the cloud takes a fragment; a guest listens on the capture page
        if (localServer) return ok(t('core.input.hintYoutube'))
        if (onCloud) return ok(t('cloud.input.hintYoutubeClip'))
        return ok(t(tabCapable ? 'cloud.input.hintYoutubeGuest' : 'cloud.input.hintYoutubeHere'))
```

`frontend/src/i18n/cloud.ts` — next to `cloud.input.hintYoutubeGuest`:
- uk: `'cloud.input.hintYoutubeClip': 'Відео з YouTube — натисни Enter, вибери 30 секунд, і хмара розбере акорди',`
- en: `'cloud.input.hintYoutubeClip': 'YouTube video — press Enter, pick 30 seconds and the cloud finds the chords',`

- [ ] **Step 4: Run the tests, types and lint**

Run: `cd frontend && npx vitest run src/components/input src/hooks && npx tsc -b && npm run lint`
Expected: PASS, no type or lint errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/input/url.ts frontend/src/components/input/startLink.ts frontend/src/components/input/startLink.test.ts frontend/src/hooks/useJobs.ts frontend/src/hooks/useJobs.retry.test.ts frontend/src/components/input/SmartInput.tsx frontend/src/i18n/cloud.ts
git commit -m "$(cat <<'EOF'
YouTube clips (web): signed-in YouTube links open the fragment picker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Fragment window math and range formatting

**Files:**
- Create: `frontend/src/components/clip/clipWindow.ts`, `frontend/src/components/clip/clipWindow.test.ts`
- Modify: `frontend/src/components/ui/format.ts` (`formatRange`)
- Test: `frontend/src/components/ui/format.test.ts` (new)

**Interfaces:**
- Consumes: `ClipRange` (Task 10).
- Produces (`components/clip/clipWindow.ts`): `CLIP_SECONDS = 30`; `maxStart(duration: number | null, length?: number): number` (`Infinity` when unknown); `clampStart(start, duration, length?) → whole seconds`; `clipWindow(start, duration, length?) → ClipRange`; `nudgeStart(start, delta, duration, length?)`; `startAt(time, duration, length?)` («Звідси»); `startFromTap(fraction, duration, length?)` (window centred on the tap); `startFromDrag(origin, dx, width, duration, length?)`. `formatRange(start: number, end: number, sep = '–'): string` in `components/ui/format.ts`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/clip/clipWindow.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CLIP_SECONDS, clampStart, clipWindow, maxStart, nudgeStart, startAt, startFromDrag, startFromTap } from './clipWindow'

describe('the fragment window', () => {
  it('is 30 s, the server’s CHORDS_YT_CLIP_S', () => expect(CLIP_SECONDS).toBe(30))

  it('never runs past the end of the video', () => {
    expect(maxStart(213.4)).toBe(183)
    expect(clampStart(200, 213.4)).toBe(183)
    expect(clipWindow(200, 213.4)).toEqual({ start: 183, end: 213 })
    expect(clampStart(99999, 213.4)).toBe(183) // ?t= past the end
  })

  it('takes a video shorter than the window whole', () => {
    expect(maxStart(20)).toBe(0)
    expect(clipWindow(10, 20)).toEqual({ start: 0, end: 20 })
  })

  it('trusts the start while the length is unknown', () => {
    expect(maxStart(null)).toBe(Number.POSITIVE_INFINITY)
    expect(clipWindow(72, null)).toEqual({ start: 72, end: 102 })
    expect(clampStart(72.9, null)).toBe(72)
    expect(clampStart(-5, null)).toBe(0)
    expect(clampStart(Number.NaN, 100)).toBe(0)
  })

  it('moves by the keyboard and from the playhead', () => {
    expect(nudgeStart(72, 1, 213.4)).toBe(73)
    expect(nudgeStart(72, -5, 213.4)).toBe(67)
    expect(nudgeStart(2, -5, 213.4)).toBe(0)
    expect(nudgeStart(183, 5, 213.4)).toBe(183)
    expect(startAt(84.7, 213.4)).toBe(84)
    expect(startAt(205, 213.4)).toBe(183)
  })

  it('a tap centres the window there; a drag follows the pointer', () => {
    expect(startFromTap(0.5, 200)).toBe(85)
    expect(startFromTap(0, 200)).toBe(0)
    expect(startFromTap(1, 200)).toBe(170)
    expect(startFromDrag(72, 100, 400, 200)).toBe(122) // a quarter of the line = 50 s
    expect(startFromDrag(72, -400, 400, 200)).toBe(0)
    expect(startFromDrag(72, 10, 0, 200)).toBe(72) // not laid out yet
  })
})
```

Create `frontend/src/components/ui/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formatRange } from './format'

describe('formatRange', () => {
  it('a fragment of a video', () => {
    expect(formatRange(72, 102)).toBe('1:12–1:42')
    expect(formatRange(72, 102, ' – ')).toBe('1:12 – 1:42')
    expect(formatRange(3590, 3620)).toBe('0:59:50–1:00:20')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/clip src/components/ui/format.test.ts`
Expected: FAIL: cannot resolve `./clipWindow`; `formatRange` is not exported.

- [ ] **Step 3: Implement**

Create `frontend/src/components/clip/clipWindow.ts`:

```ts
// The fragment window of the YouTube picker (#/youtube/<videoId>): whole seconds, inside the video, CLIP_SECONDS
// long (a video shorter than that is taken whole). Pure; ClipPage / ClipTimeline do the DOM.
import type { ClipRange } from '../../types'

/** Length of a fragment the cloud analyzes, s: the server's CHORDS_YT_CLIP_S (keep the two equal). */
export const CLIP_SECONDS = 30

/** The latest start that still fits the video (0 when it is shorter than the window); Infinity while unknown. */
export function maxStart(duration: number | null, length = CLIP_SECONDS): number {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.floor(duration - length))
}

/** A start in whole seconds, inside the video. */
export function clampStart(start: number, duration: number | null, length = CLIP_SECONDS): number {
  const s = Number.isFinite(start) ? Math.floor(Math.max(0, start)) : 0
  return Math.min(s, maxStart(duration, length))
}

/** The window that starts at `start` (clamped); it ends at the video's end when that comes first. */
export function clipWindow(start: number, duration: number | null, length = CLIP_SECONDS): ClipRange {
  const s = clampStart(start, duration, length)
  const known = duration !== null && Number.isFinite(duration) && duration > 0
  return { start: s, end: known ? Math.min(s + length, Math.floor(duration)) : s + length }
}

/** ←/→ move the window by 1 s, with Shift by 5 s. */
export function nudgeStart(start: number, delta: number, duration: number | null, length = CLIP_SECONDS): number {
  return clampStart(start + delta, duration, length)
}

/** «Звідси»: the window begins where the video is now. */
export function startAt(time: number, duration: number | null, length = CLIP_SECONDS): number {
  return clampStart(time, duration, length)
}

/** A tap at `fraction` (0..1) of the timeline: the window is centred on that point of the video. */
export function startFromTap(fraction: number, duration: number, length = CLIP_SECONDS): number {
  return clampStart(fraction * duration - length / 2, duration, length)
}

/** Dragging the window: its start (`origin` when the drag began) follows `dx` px of a `width` px timeline. */
export function startFromDrag(origin: number, dx: number, width: number, duration: number, length = CLIP_SECONDS): number {
  if (width <= 0 || duration <= 0) return clampStart(origin, duration, length)
  return clampStart(origin + (dx / width) * duration, duration, length)
}
```

Note: `clipWindow(200, 213.4)` ends at `Math.floor(213.4) = 213`, the whole second the picker shows; the server cuts at the exact end.

In `frontend/src/components/ui/format.ts`, after `formatTime`:

```ts
/** "1:12–1:42": a fragment of a video (both ends in the longer one's format). */
export function formatRange(start: number, end: number, sep = '–'): string {
  return `${formatTime(start, end)}${sep}${formatTime(end, end)}`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/clip src/components/ui/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/clip/clipWindow.ts frontend/src/components/clip/clipWindow.test.ts frontend/src/components/ui/format.ts frontend/src/components/ui/format.test.ts
git commit -m "$(cat <<'EOF'
YouTube clips (web): fragment window math and range formatting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: The fragment picker page (`#/youtube/<videoId>`)

**Files:**
- Create: `frontend/src/components/clip/ClipTimeline.tsx`, `frontend/src/components/clip/ClipPage.tsx`, `frontend/src/i18n/clip.ts`
- Modify: `frontend/src/components/player/sources/youtubeApi.ts` (shared `videoTitle`), `frontend/src/components/capture/CapturePage.tsx` (use it), `frontend/src/i18n/index.ts` (register `clip`), `frontend/src/App.tsx` (route)

**Interfaces:**
- Consumes: `submitClip` (Task 10), `paths.capture` with `t` (Task 10), `CLIP_SECONDS`, `clampStart`, `clipWindow`, `nudgeStart`, `startAt`, `startFromTap`, `startFromDrag` (Task 12), `formatRange` (Task 12), `errorText` (`components/jobs/errorText.ts`), `loadYouTubeApi`, `isEmbedBlockedError`, `YT_STATE` (`youtubeApi.ts`).
- Produces: `<ClipPage videoId start />` (default export-less named export); `<ClipTimeline start duration now onChange disabled label />`; `videoTitle(player: YTPlayer | null): string | null` exported from `youtubeApi.ts`; i18n keys `clip.title`, `clip.intro`, `clip.window`, `clip.windowLabel`, `clip.fromHere`, `clip.preview`, `clip.analyze`.

Behaviour (spec "Client changes"): YouTube embed; a timeline 0..duration with the 30 s window (drag it; tap the line to move it there); the range label `1:12 – 1:42`; «Звідси» puts the window's start at the player's current time; «Прослухати» plays the window once and pauses at its end; «Розібрати акорди» starts the job (→ job page). A 501 `unavailable` sends the user to `#/listen/youtube/<id>?blocked=1&t=<start>`. The window never runs past the end (`start ≤ duration − 30`, whole video when shorter). Default start: `?t=` else 0. Touch on a 375 px screen; keyboard ←/→ 1 s, Shift 5 s, Home/End.

The window is a pure-UI component with all the math in Task 12; there is no unit test for the DOM part (the repo tests no page components) — the gate is the browser check in Step 3.

- [ ] **Step 1: Implement**

In `frontend/src/components/player/sources/youtubeApi.ts`, append (moved from `CapturePage.tsx`):

```ts
/** The IFrame API also reports the loaded video's title (not in the typed surface). */
type YTPlayerWithData = YTPlayer & { getVideoData?(): { title?: string; author?: string } }

/** The loaded video's title, or null. */
export function videoTitle(player: YTPlayer | null): string | null {
  try {
    const title = (player as YTPlayerWithData | null)?.getVideoData?.()?.title?.trim()
    return title || null
  } catch {
    return null
  }
}
```

and in `CapturePage.tsx` delete the local `YTPlayerWithData` type and `videoTitle` function, importing `videoTitle` from `'../player/sources/youtubeApi'` instead.

Create `frontend/src/i18n/clip.ts`:

```ts
import type { Dict } from './index'

// The YouTube fragment picker (#/youtube/<videoId>): pick 30 seconds, the cloud downloads just those and finds the
// chords. Keys prefixed "clip.". Ukrainian first (default, informal "ти").
export const clip: Dict = {
  uk: {
    'clip.title': 'Фрагмент з YouTube',
    'clip.intro': 'Вибери {seconds} секунд — хмара завантажить лише їх і розбере акорди, точно в такт відео.',
    'clip.window': 'Фрагмент · {seconds} с',
    'clip.windowLabel': 'Фрагмент відео',
    'clip.fromHere': 'Звідси',
    'clip.preview': 'Прослухати',
    'clip.analyze': 'Розібрати акорди',
  },
  en: {
    'clip.title': 'YouTube fragment',
    'clip.intro': 'Pick {seconds} seconds — the cloud downloads just those and finds the chords, in time with the video.',
    'clip.window': 'Fragment · {seconds} s',
    'clip.windowLabel': 'Video fragment',
    'clip.fromHere': 'From here',
    'clip.preview': 'Preview',
    'clip.analyze': 'Find the chords',
  },
}
```

In `frontend/src/i18n/index.ts`: `import { clip } from './clip'` and add `clip` to the end of the `dicts` array.

Create `frontend/src/components/clip/ClipTimeline.tsx`:

```tsx
// The fragment window on the video's timeline: drag it, tap the line to move it there (centred), ←/→ move it by
// 1 s (Shift: 5 s), Home / End. A slider for screen readers; `touch-none` keeps a drag from scrolling the page.
import clsx from 'clsx'
import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { formatRange, formatTime } from '../ui/format'
import { clipWindow, maxStart, nudgeStart, startFromDrag, startFromTap } from './clipWindow'

interface Props {
  start: number
  /** the video's length, null while unknown */
  duration: number | null
  /** where the video is now (the playhead) */
  now: number
  onChange(start: number): void
  disabled?: boolean
  label: string
}

export function ClipTimeline({ start, duration, now, onChange, disabled, label }: Props) {
  const lineRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; origin: number; moved: boolean } | null>(null)
  const total = duration && duration > 0 ? duration : null
  const range = clipWindow(start, total)
  const pct = (t: number) => (total ? `${Math.min(100, Math.max(0, (t / total) * 100))}%` : '0%')

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || !total) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, origin: range.start, moved: false }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || !total) return
    if (Math.abs(e.clientX - d.x) > 3) d.moved = true
    if (d.moved) onChange(startFromDrag(d.origin, e.clientX - d.x, lineRef.current?.clientWidth ?? 0, total))
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    const line = lineRef.current
    if (!d || d.moved || !total || !line) return
    // a tap: outside the window it moves there; on the window it stays
    const rect = line.getBoundingClientRect()
    const fraction = (e.clientX - rect.left) / rect.width
    const at = fraction * total
    if (at < range.start || at > range.end) onChange(startFromTap(fraction, total))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const step = e.shiftKey ? 5 : 1
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') onChange(nudgeStart(start, -step, total))
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') onChange(nudgeStart(start, step, total))
    else if (e.key === 'Home') onChange(0)
    else if (e.key === 'End' && total) onChange(maxStart(total))
    else return
    e.preventDefault()
  }

  return (
    <div className="mt-3">
      <div
        ref={lineRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total ? maxStart(total) : 0}
        aria-valuenow={range.start}
        aria-valuetext={formatRange(range.start, range.end, ' – ')}
        aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={onKeyDown}
        className={clsx(
          'relative h-12 touch-none rounded-xl bg-surface-2 select-none',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          disabled ? 'opacity-60' : 'cursor-pointer',
        )}
      >
        {total && (
          <>
            <div
              className="absolute inset-y-1 rounded-lg border-2 border-accent bg-accent/20"
              style={{ left: pct(range.start), width: `max(0.75rem, ${((range.end - range.start) / total) * 100}%)` }}
              aria-hidden="true"
            />
            <div
              className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-text/70"
              style={{ left: pct(now) }}
              aria-hidden="true"
            />
          </>
        )}
      </div>
      <div className="mt-1 flex justify-between text-xs text-faint tabular-nums" aria-hidden="true">
        <span>0:00</span>
        <span>{total ? formatTime(total) : '–:––'}</span>
      </div>
    </div>
  )
}
```

Create `frontend/src/components/clip/ClipPage.tsx`:

```tsx
// The fragment picker (#/youtube/<videoId>[?t=<start>]): a signed-in user picks CLIP_SECONDS of a YouTube video and
// the cloud analyzes just that part (docs/superpowers/specs/2026-10-07-youtube-warp-fetch-design.md). Works by touch
// on a phone; the window's math is in clipWindow.ts.
import { ArrowDownToLine, ArrowLeft, LoaderCircle, Play, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { submitClip } from '../../hooks/useJobs'
import { navigate, paths } from '../../hooks/useRoute'
import { toApiError } from '../../lib/api'
import { useApp } from '../../store'
import { errorText } from '../jobs/errorText'
import { isEmbedBlockedError, loadYouTubeApi, videoTitle, YT_STATE, type YTPlayer } from '../player/sources/youtubeApi'
import { Button } from '../ui/IconButton'
import { VideoSiteIcon } from '../ui/Logo'
import { formatRange } from '../ui/format'
import { ClipTimeline } from './ClipTimeline'
import { CLIP_SECONDS, clampStart, clipWindow, startAt } from './clipWindow'

type PlayerStatus = 'loading' | 'ready' | 'embed' | 'error'

export function ClipPage({ videoId, start: initialStart }: { videoId: string; start: number | null }) {
  const t = useT()
  const mountRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<YTPlayer | null>(null)
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus>('loading')
  const [title, setTitle] = useState<string | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [now, setNow] = useState(0)
  const [start, setStart] = useState(() => clampStart(initialStart ?? 0, null))
  const [busy, setBusy] = useState(false)
  /** «Прослухати»: the video pauses once it reaches this time */
  const previewEnd = useRef<number | null>(null)
  const range = clipWindow(start, duration)

  useDocumentTitle(title ? `${t('clip.title')} · ${title}` : t('clip.title'))

  // ---- the embedded player
  useEffect(() => {
    const host = mountRef.current
    if (!host) return
    let cancelled = false
    let player: YTPlayer | null = null
    const learnDuration = (p: YTPlayer) => {
      const d = p.getDuration()
      if (d > 0) setDuration(d)
    }
    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return
        const el = document.createElement('div')
        host.appendChild(el)
        player = new YT.Player(el, {
          videoId,
          width: '100%',
          height: '100%',
          host: 'https://www.youtube-nocookie.com',
          playerVars: { playsinline: 1, rel: 0, iv_load_policy: 3, enablejsapi: 1, origin: window.location.origin },
          events: {
            onReady: (e) => {
              if (cancelled) return
              playerRef.current = e.target
              setPlayerStatus('ready')
              setTitle(videoTitle(e.target))
              learnDuration(e.target)
            },
            onStateChange: (e) => {
              if (cancelled || e.data !== YT_STATE.PLAYING) return
              setTitle((prev) => prev ?? videoTitle(e.target))
              learnDuration(e.target)
            },
            onError: (e) => {
              if (!cancelled) setPlayerStatus(isEmbedBlockedError(e.data) ? 'embed' : 'error')
            },
          },
        })
      })
      .catch(() => {
        if (!cancelled) setPlayerStatus('error')
      })
    return () => {
      cancelled = true
      playerRef.current = null
      try {
        player?.destroy()
      } catch {
        /* iframe already gone */
      }
      host.replaceChildren()
    }
  }, [videoId])

  // the window stays inside the video once its length is known (a ?t= past the end moves back)
  useEffect(() => {
    if (duration) setStart((s) => clampStart(s, duration))
  }, [duration])

  // ---- the playhead; «Прослухати» stops at the window's end
  useEffect(() => {
    const id = window.setInterval(() => {
      const p = playerRef.current
      if (!p) return
      try {
        const time = p.getCurrentTime() || 0
        setNow(time)
        if (previewEnd.current !== null && time >= previewEnd.current) {
          previewEnd.current = null
          p.pauseVideo()
        }
      } catch {
        /* not ready */
      }
    }, 200)
    return () => window.clearInterval(id)
  }, [])

  const fromHere = () => setStart(startAt(now, duration))

  const preview = () => {
    const p = playerRef.current
    if (!p) return
    previewEnd.current = range.end
    p.seekTo(range.start, true)
    p.playVideo()
  }

  const analyze = async () => {
    if (busy) return
    setBusy(true)
    previewEnd.current = null
    try {
      playerRef.current?.pauseVideo()
    } catch {
      /* player gone */
    }
    try {
      await submitClip(videoId, range.start) // opens the job page
    } catch (e) {
      const { code } = toApiError(e)
      // this cloud cannot download YouTube fragments: listen to the video in the tab, from the same place
      if (code === 'unavailable') navigate(paths.capture(videoId, { blocked: true, t: range.start }), { replace: true })
      else if (code !== 'aborted') useApp.getState().toast(errorText(code), 'error')
    } finally {
      setBusy(false)
    }
  }

  const ready = playerStatus === 'ready'
  const playerBroken = playerStatus === 'embed' || playerStatus === 'error'

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 sm:px-6 sm:pt-10">
      <Button variant="ghost" className="-ml-3" icon={<ArrowLeft className="size-4" />} onClick={() => navigate(paths.home())}>
        {t('core.job.backHome')}
      </Button>

      <header className="mt-3">
        <p className="flex items-center gap-2 text-sm font-medium text-accent">
          <VideoSiteIcon className="size-4" />
          {t('clip.title')}
        </p>
        <h1 className="mt-1.5 font-display text-2xl leading-tight font-semibold tracking-tight break-words sm:text-3xl">
          {title ?? t('cloud.capture.untitled')}
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">{t('clip.intro', { seconds: CLIP_SECONDS })}</p>
      </header>

      <div className="relative mt-6 aspect-video overflow-hidden rounded-2xl border border-border-strong bg-black">
        <div ref={mountRef} className="absolute inset-0 [&_iframe]:size-full" />
        {playerStatus === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center text-white/60" role="status">
            <LoaderCircle className="size-6 animate-spin" aria-hidden="true" />
            <span className="sr-only">{t('core.loading')}</span>
          </div>
        )}
        {playerBroken && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-white/80">
            {t(playerStatus === 'embed' ? 'core.video.blocked' : 'core.video.failed')}
          </div>
        )}
      </div>

      <section className="mt-5 rounded-2xl border border-border bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-sm text-muted">{t('clip.window', { seconds: CLIP_SECONDS })}</p>
          <p className="font-display text-lg font-semibold tabular-nums" aria-live="polite">
            {formatRange(range.start, range.end, ' – ')}
          </p>
        </div>
        <ClipTimeline
          start={range.start}
          duration={duration}
          now={now}
          onChange={setStart}
          disabled={!duration}
          label={t('clip.windowLabel')}
        />
        <div className="mt-4 flex flex-wrap gap-2">
          <Button icon={<ArrowDownToLine className="size-4" />} onClick={fromHere} disabled={!ready}>
            {t('clip.fromHere')}
          </Button>
          <Button icon={<Play className="size-4" />} onClick={preview} disabled={!ready}>
            {t('clip.preview')}
          </Button>
          <Button
            variant="primary"
            className="w-full sm:ml-auto sm:w-auto"
            icon={busy ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            onClick={analyze}
            disabled={busy}
          >
            {t('clip.analyze')}
          </Button>
        </div>
      </section>
    </div>
  )
}
```

(«Розібрати акорди» stays enabled when the embed is broken: the server does not need the embed, and the window then starts at `?t=` or 0.)

In `frontend/src/App.tsx`: `import { ClipPage } from './components/clip/ClipPage'` and in `Page`:

```tsx
    case 'clip':
      return <ClipPage key={route.videoId} videoId={route.videoId} start={route.start} />
```

- [ ] **Step 2: Types, lint, the whole unit suite**

Run: `cd frontend && npx tsc -b && npm run lint && npx vitest run`
Expected: PASS. (No `data-tour` attributes yet: `components/tour/anchors.test.ts` rejects anchors no tour names, so they come with the tour in Task 16.)

- [ ] **Step 3: Check it in the browser (local server, real yt-dlp from your connection)**

Start the app with the preview tool: add to `.claude/launch.json` of the worktree (create it if missing, do not commit it) a configuration `{"name": "dev", "runtimeExecutable": "./dev.sh", "port": 5173}` and call `preview_start {name: "dev"}`. Then:
1. Open `http://localhost:5173/#/youtube/dQw4w9WgXcQ?t=72`. Expect the title of the video, the range label `1:12 – 1:42`, the window drawn at ~34 % of the line.
2. Focus the timeline (Tab), press → once: `1:13 – 1:43`; Shift+→: `1:18 – 1:48`; End: `3:03 – 3:33` (the video is 3:33); Home: `0:00 – 0:30`.
3. Click the line near its middle: the window centres there. Drag the window: it follows the pointer and never passes either end.
4. «Прослухати»: the video plays from the window's start and pauses at its end (watch the playhead).
5. Play the video by hand, pause at ~0:50, press «Звідси»: `0:50 – 1:20`.
6. «Розібрати акорди»: the job page opens; with the local server (it downloads fragments with yt-dlp in-process) the job ends on the track page. Check `read_console_messages` for errors.
7. `resize_window {preset: "mobile"}`, reload: the page fits 375 px without horizontal scroll, the buttons wrap, «Розібрати акорди» is full width; drag the window by touch emulation (pointer drag). Reset with `resize_window {preset: "desktop"}`.

Take one screenshot of step 1 and one of step 7 for the task report.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/clip/ClipTimeline.tsx frontend/src/components/clip/ClipPage.tsx frontend/src/i18n/clip.ts frontend/src/i18n/index.ts frontend/src/App.tsx frontend/src/components/player/sources/youtubeApi.ts frontend/src/components/capture/CapturePage.tsx
git commit -m "$(cat <<'EOF'
YouTube clips (web): the fragment picker page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Fallbacks to «Слухати у вкладці» and the guest hint

**Files:**
- Modify: `frontend/src/hooks/useJobs.ts` (`blockedPath`, the blocked toast), `frontend/src/components/jobs/JobPage.tsx`
- Modify: `frontend/src/components/capture/machine.ts` (`idlePosition`), `frontend/src/components/capture/CapturePage.tsx` (`start` prop, guest hint), `frontend/src/App.tsx`, `frontend/src/i18n/cloud.ts`
- Test: `frontend/src/hooks/useJobs.retry.test.ts`, `frontend/src/components/capture/machine.test.ts`

**Interfaces:**
- Consumes: `paths.capture(videoId, { blocked, t })`, `Route.capture.start` (Task 10); `Job.clip` (Task 10).
- Produces: `blockedPath(job: Pick<Job, 'status' | 'errorCode' | 'source' | 'clip'>): string | null` (useJobs); `idlePosition(currentTime: number, startAt: number | null): number` (machine.ts); `<CapturePage videoId blocked start />`; i18n `cloud.capture.clipHint` (replaces `cloud.capture.accountHint`).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/hooks/useJobs.retry.test.ts` (import `blockedPath` with `retryJob, uploadAndFollow`):

```ts
describe('blockedPath', () => {
  const source = { type: 'youtube' as const, videoId: 'dQw4w9WgXcQ' }

  it('a fragment YouTube refused: listen in the tab from the fragment’s start', () => {
    expect(blockedPath({ status: 'error', errorCode: 'download_blocked', source, clip: { start: 72, end: 102 } })).toBe(
      '/listen/youtube/dQw4w9WgXcQ?blocked=1&t=72',
    )
    expect(blockedPath({ status: 'error', errorCode: 'download_blocked', source })).toBe('/listen/youtube/dQw4w9WgXcQ?blocked=1')
  })

  it('nothing for other failures', () => {
    expect(blockedPath({ status: 'error', errorCode: 'download_failed', source })).toBeNull()
    expect(blockedPath({ status: 'done', source })).toBeNull()
  })
})
```

Append to `frontend/src/components/capture/machine.test.ts` (import `idlePosition` with the others):

```ts
describe('idlePosition', () => {
  it('the start the page was opened with, until the video has played; then where the video is', () => {
    expect(idlePosition(0, 72)).toBe(72)
    expect(idlePosition(0.4, 72)).toBe(72)
    expect(idlePosition(15, 72)).toBe(15)
    expect(idlePosition(0, null)).toBe(0)
    expect(chooseStartOffset(idlePosition(0, 72), 213)).toBe(72) // «Почати з 1:12» right away
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/hooks/useJobs.retry.test.ts src/components/capture/machine.test.ts`
Expected: FAIL: `blockedPath` / `idlePosition` are not exported.

- [ ] **Step 3: Implement**

`frontend/src/hooks/useJobs.ts` — after `blockedVideoId`:

```ts
/** Where a job YouTube refused sends the user: «Слухати у вкладці» for that video, from the fragment's start. */
export function blockedPath(job: Pick<Job, 'status' | 'errorCode' | 'source' | 'clip'>): string | null {
  const videoId = blockedVideoId(job)
  return videoId ? paths.capture(videoId, { blocked: true, t: job.clip?.start }) : null
}
```

and replace the blocked toast (the `const videoId = blockedVideoId(next)` block) with:

```ts
    const blocked = blockedPath(next)
    if (blocked) {
      toast(`${jobTitle(next)}: ${t('cloud.blocked.toast')}`, 'info', {
        label: t('cloud.blocked.action'),
        run: () => navigate(blocked),
      })
      return
    }
```

`frontend/src/components/jobs/JobPage.tsx` — import `blockedPath` instead of `blockedVideoId`, and:

```tsx
  // YouTube refused the server download: play the video here and listen to this tab instead (from the fragment)
  const blocked = job ? blockedPath(job) : null
  useEffect(() => {
    if (job?.status === 'done' && job.trackId) navigate(paths.track(job.trackId), { replace: true })
    if (job?.status === 'error') acknowledgeJob(job.id)
    if (blocked) navigate(blocked, { replace: true })
  }, [job?.status, job?.trackId, job?.id, blocked])
```

`frontend/src/components/capture/machine.ts` — after `chooseStartOffset`:

```ts
/**
 * Before the recording starts: where the video is or - while it has not played yet - the start the page was opened
 * with (`#/listen/youtube/<id>?t=`, e.g. the fragment YouTube refused to the cloud), fed to chooseStartOffset.
 */
export function idlePosition(currentTime: number, startAt: number | null): number {
  return currentTime >= 1 || !startAt ? currentTime : startAt
}
```

`frontend/src/components/capture/CapturePage.tsx`:
- signature: `export function CapturePage({ videoId, blocked, start }: { videoId: string; blocked: boolean; start: number | null })`
- `const [position, setPosition] = useState(start ?? 0)`
- import `idlePosition` from `./machine`.
- in the player's `playerVars`: `{ playsinline: 1, rel: 0, iv_load_policy: 3, enablejsapi: 1, origin: window.location.origin, ...(start ? { start } : {}) }` and add `start` to that effect's dependency list.
- in the "before starting" interval: `setPosition(chooseStartOffset(idlePosition(p.getCurrentTime(), start), p.getDuration()))`; add `start` to its dependency list.
- replace the guest block (`{cloudInvite && tabCapture && ( … cloud.capture.accountHint … )}`) with:

```tsx
        {/* a guest: signed in, the cloud takes a fragment of this video - no microphone, no tab */}
        {cloudInvite && (
          <p className="mt-1.5 text-sm text-muted">
            {tabCapture && <>{t('cloud.capture.guest')} </>}
            <button type="button" onClick={() => openAuthDialog('signIn')} className="text-left font-medium text-accent hover:underline">
              {t('cloud.capture.clipHint')}
            </button>
          </p>
        )}
```

`frontend/src/App.tsx`: `<CapturePage key={route.videoId} videoId={route.videoId} blocked={route.blocked} start={route.start} />`.

`frontend/src/i18n/cloud.ts` — delete `cloud.capture.accountHint` (uk and en) and add:
- uk: `'cloud.capture.clipHint': 'Увійди, щоб розбирати YouTube без мікрофона',`
- en: `'cloud.capture.clipHint': 'Sign in to get the chords of YouTube videos without a microphone',`

- [ ] **Step 4: Run tests, types, lint**

Run: `cd frontend && npx vitest run && npx tsc -b && npm run lint && grep -rn "accountHint" src || echo "no accountHint left"`
Expected: PASS; `no accountHint left`.

- [ ] **Step 5: Check in the browser**

With the dev preview from Task 13: open `http://localhost:5173/#/listen/youtube/dQw4w9WgXcQ?blocked=1&t=72` as a guest (signed out). Expect the "blocked" intro text, the start button reading «Почати з 1:12», and the hint «Увійди, щоб розбирати YouTube без мікрофона» that opens the sign-in dialog. `resize_window {preset: "mobile"}`: the hint is there too (phones have no tab capture). Reset to desktop.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useJobs.ts frontend/src/hooks/useJobs.retry.test.ts frontend/src/components/jobs/JobPage.tsx frontend/src/components/capture/machine.ts frontend/src/components/capture/machine.test.ts frontend/src/components/capture/CapturePage.tsx frontend/src/App.tsx frontend/src/i18n/cloud.ts
git commit -m "$(cat <<'EOF'
YouTube clips (web): blocked fragments fall back to the tab at their start; sign-in hint for guests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Playing a fragment track; the range next to its title

**Files:**
- Create: `frontend/src/components/player/clipBounds.ts`, `frontend/src/components/player/clipBounds.test.ts`, `frontend/src/store.clip.test.ts`
- Modify: `frontend/src/components/player/engine.ts`, `frontend/src/store.ts` (`setTrack`), `frontend/src/components/history/RecentTracks.tsx`, `frontend/src/components/layout/TrackTitleBar.tsx`

**Interfaces:**
- Consumes: `Track.clip`, `ClipRange` (Task 10); `formatRange` (Task 12).
- Produces: `CLIP_END_SLACK_S = 0.25`; `clipRestart(time: number, clip: ClipRange | null | undefined): number | null`; `pastClipEnd(time: number, clip: ClipRange | null | undefined, loop: { start: number; end: number } | null): boolean`. `setTrack(track)` puts the playhead at `track.clip.start` for fragment tracks.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/player/clipBounds.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { clipRestart, pastClipEnd } from './clipBounds'

const clip = { start: 72, end: 102 }

describe('fragment tracks', () => {
  it('play at or after the fragment’s end starts it again', () => {
    expect(clipRestart(102, clip)).toBe(72)
    expect(clipRestart(101.9, clip)).toBe(72)
    expect(clipRestart(130, clip)).toBe(72)
    expect(clipRestart(80, clip)).toBeNull()
    expect(clipRestart(10, clip)).toBeNull() // before the fragment the video simply plays from there
    expect(clipRestart(500, null)).toBeNull()
  })

  it('playback stops at the fragment’s end unless an A–B loop is set', () => {
    expect(pastClipEnd(102, clip, null)).toBe(true)
    expect(pastClipEnd(101.5, clip, null)).toBe(false)
    expect(pastClipEnd(110, clip, { start: 80, end: 90 })).toBe(false)
    expect(pastClipEnd(110, clip, { start: 80, end: 80 })).toBe(true) // an empty loop is no loop
    expect(pastClipEnd(110, null, null)).toBe(false)
  })
})
```

Create `frontend/src/store.clip.test.ts`:

```ts
// A fragment track (docs/CLOUD.md → YouTube clips) opens with the playhead at the fragment's start.
import { describe, expect, it, vi } from 'vitest'
import type { Track } from './types'

// settings are persisted: give the store a storage to write to
vi.hoisted(() =>
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }),
)

import { useApp } from './store'

const track = (patch: Partial<Track> = {}): Track => ({
  id: '0123456789ab',
  title: 'Song',
  duration: 102,
  source: { type: 'youtube', videoId: 'dQw4w9WgXcQ' },
  createdAt: '2026-10-08T10:00:00Z',
  audioUrl: '/api/tracks/0123456789ab/audio',
  timeSignature: 4,
  beats: [],
  downbeats: [],
  chords: [],
  waveform: [],
  engine: 'test',
  ...patch,
})

describe('setTrack', () => {
  it('starts a fragment at its start, any other track at 0', () => {
    useApp.getState().setTrack(track({ clip: { start: 72, end: 102 }, startOffset: 72 }))
    expect(useApp.getState().currentTime).toBe(72)
    useApp.getState().setTrack(track())
    expect(useApp.getState().currentTime).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/player/clipBounds.test.ts src/store.clip.test.ts`
Expected: FAIL: cannot resolve `./clipBounds`; `currentTime` is 0 instead of 72.

- [ ] **Step 3: Implement**

Create `frontend/src/components/player/clipBounds.ts`:

```ts
// A fragment track (`track.clip`, docs/CLOUD.md → YouTube clips): the YouTube player would run on past the fragment,
// so playback stops at `clip.end`, and play from there starts the fragment again. Pure; engine.ts applies it.
import type { ClipRange } from '../../types'

/** This close to the end counts as "at the end". */
export const CLIP_END_SLACK_S = 0.25

/** Where play() first seeks: the fragment's start when the playhead is at / after its end; null otherwise. */
export function clipRestart(time: number, clip: ClipRange | null | undefined): number | null {
  return clip && time >= clip.end - CLIP_END_SLACK_S ? clip.start : null
}

/** The playhead ran past the fragment's end (a set A–B loop decides instead). */
export function pastClipEnd(
  time: number,
  clip: ClipRange | null | undefined,
  loop: { start: number; end: number } | null,
): boolean {
  if (!clip || (loop && loop.end > loop.start)) return false
  return time >= clip.end
}
```

`frontend/src/components/player/engine.ts`:
- imports: `import type { ClipRange, Track } from '../../types'` and `import { clipRestart, pastClipEnd } from './clipBounds'`.
- field: `private readonly clip: ClipRange | null` and, first line of the constructor, `this.clip = track.clip ?? null`.
- controller `play`:

```ts
    play: () => {
      const src = this.active
      if (!src) return
      // a fragment that has played to its end starts again (the video itself would run on)
      const from = clipRestart(src.getTime(), this.clip)
      if (from !== null) {
        src.seek(from)
        useApp.getState().setPlayback({ currentTime: from })
      }
      src.play()
    },
```

- in `tick`, after the A–B loop block and before `if (Math.abs(time - s.currentTime) > 0.0005)`:

```ts
    const clip = this.clip
    if (clip && pastClipEnd(time, clip, loop)) {
      src.pause()
      this.stopLoop()
      s.setPlayback({ isPlaying: false, currentTime: clip.end })
      return
    }
```

`frontend/src/store.ts` — `setTrack`:

```ts
      setTrack: (track) =>
        set({ track, currentTime: track?.clip?.start ?? 0, isPlaying: false, loop: null, duration: track?.duration ?? 0 }),
```

`frontend/src/components/history/RecentTracks.tsx` — import `formatRange` with the other `../ui/format` helpers; after `<span className="truncate font-medium text-text">{track.title}</span>`:

```tsx
            {track.clip && (
              <span className="shrink-0 text-sm text-muted tabular-nums">· {formatRange(track.clip.start, track.clip.end)}</span>
            )}
```

`frontend/src/components/layout/TrackTitleBar.tsx` — import `formatRange` from `'../ui/format'`; wrap the title `InlineEdit` so the range sits next to it:

```tsx
            <div className="flex max-w-full min-w-0 items-baseline gap-1.5">
              <InlineEdit
                value={track.title}
                /* ...the same props as before... */
              />
              {track.clip && (
                <span className="shrink-0 text-xs text-muted tabular-nums">· {formatRange(track.clip.start, track.clip.end)}</span>
              )}
            </div>
```

- [ ] **Step 4: Run tests, types, lint**

Run: `cd frontend && npx vitest run && npx tsc -b && npm run lint`
Expected: PASS.

- [ ] **Step 5: Check in the browser**

With the dev preview and the fragment track made in Task 13 step 6 (local server):
1. The library row shows `Rick Astley … · 1:12–1:42`; the track page header shows the same range after the title.
2. Open the track: the playhead is at 1:12. Show the video (the player's video toggle), press play: the video starts at 1:12 with chords on top and pauses by itself at 1:42.
3. Press play again: it starts from 1:12. Hide the video: the audio plays the fragment the same way.

Screenshot step 2 (paused at the end) for the task report.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/player/clipBounds.ts frontend/src/components/player/clipBounds.test.ts frontend/src/store.clip.test.ts frontend/src/components/player/engine.ts frontend/src/store.ts frontend/src/components/history/RecentTracks.tsx frontend/src/components/layout/TrackTitleBar.tsx
git commit -m "$(cat <<'EOF'
YouTube clips (web): fragment tracks play from their start, stop at their end, show their range

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: A tour for the picker

**Files:**
- Modify: `frontend/src/lib/tour/tours.ts`, `frontend/src/lib/tour/trigger.ts`, `frontend/src/i18n/tour.ts`, `frontend/src/components/clip/ClipPage.tsx`, `frontend/src/components/clip/ClipTimeline.tsx`
- Test: `frontend/src/lib/tour/tours.test.ts`, `frontend/src/lib/tour/trigger.test.ts`

**Interfaces:**
- Consumes: `ClipPage` / `ClipTimeline` (Task 13); the tour framework (`useTourTrigger`, flag `touch` reported by `TourHost`).
- Produces: `TourId` `'clip'` (last in `TOUR_IDS`); `clipReady(player: string): boolean`; `reopenTours` / `tourRouteKey` handle the `clip` route; `data-tour` anchors `clip.window` (the timeline), `clip.from`, `clip.preview`, `clip.analyze` (the three buttons). The anchors and the tour land together: `components/tour/anchors.test.ts` fails on an anchor no tour names and on a tour anchor no component sets.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/tour/tours.test.ts`:
- header comment: "The six tours as data: … 43 distinct anchors" → "The seven tours as data: … 47 distinct anchors".
- `'has the six tours in a fixed order'` → `'has the seven tours in a fixed order'` with `expect(TOUR_IDS).toEqual(['home', 'song', 'score', 'keys', 'listen', 'capture', 'clip'])`.
- `'anchors 43 distinct ids'` → `'anchors 47 distinct ids'` with `toHaveLength(47)`.
- add:

```ts
  it('YouTube fragment: 4 steps, the window text for touch screens too', () => {
    expect(shown('clip', {})).toEqual(['window', 'from', 'preview', 'analyze'])
    expect(textKey('clip', TOURS.clip.steps[0], { touch: true })).toBe('tour.clip.window.text.touch')
  })
```

`frontend/src/lib/tour/trigger.test.ts` — import `clipReady` with the others and add:

```ts
  it('the fragment picker: its own tour, once the player has loaded; one screen per video', () => {
    const clip: Route = { name: 'clip', videoId: 'dQw4w9WgXcQ', start: null }
    expect(reopenTours(clip, { view: 'sheet', keysPanel: false })).toEqual(['clip'])
    expect(guideAvailable(clip, false)).toBe(true)
    expect(tourRouteKey(clip)).toBe('clip:dQw4w9WgXcQ')
    expect(clipReady('ready')).toBe(true)
    expect(clipReady('loading')).toBe(false)
    expect(clipReady('embed')).toBe(false)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/tour src/i18n/tour.test.ts src/components/tour`
Expected: FAIL (`TOURS.clip` undefined, `clipReady` not exported).

- [ ] **Step 3: Implement**

`frontend/src/lib/tour/tours.ts`:
- `export type TourId = 'home' | 'song' | 'score' | 'keys' | 'listen' | 'capture' | 'clip'` and `TOUR_IDS` gains `'clip'` at the end.
- in `TOURS`, after `capture`:

```ts
  // route `clip` (docs/superpowers/specs/2026-10-07-youtube-warp-fetch-design.md): the window, «Звідси»,
  // «Прослухати», «Розібрати акорди»
  clip: {
    id: 'clip',
    steps: [
      { id: 'window', anchors: ['clip.window'], variants: ['touch'] },
      { id: 'from', anchors: ['clip.from'] },
      { id: 'preview', anchors: ['clip.preview'] },
      { id: 'analyze', anchors: ['clip.analyze'] },
    ],
  },
```

`frontend/src/lib/tour/trigger.ts`:
- `reopenTours`: add `case 'clip': return ['clip']` after `case 'capture'`.
- `tourRouteKey`: add `case 'clip': return \`clip:${route.videoId}\`` after the `capture` case.
- after `captureReady`:

```ts
/** The YouTube fragment picker: the embedded player has loaded. */
export function clipReady(player: string): boolean {
  return player === 'ready'
}
```

`frontend/src/i18n/tour.ts` — in `uk`, after the `tour.capture.*` keys:

```ts
    'tour.clip.window.title': 'Твій фрагмент',
    'tour.clip.window.text': 'Рамка — це 30 секунд, які розбере хмара. Перетягни її або клацни на лінії; стрілки ← → зсувають на секунду, із Shift — на пʼять.',
    'tour.clip.window.text.touch': 'Рамка — це 30 секунд, які розбере хмара. Перетягни її пальцем або торкнись лінії, щоб перенести її туди.',
    'tour.clip.from.title': 'Звідси',
    'tour.clip.from.text': 'Увімкни відео й зупини його там, де починається потрібне місце, — кнопка поставить рамку саме туди.',
    'tour.clip.preview.title': 'Прослухати',
    'tour.clip.preview.text': 'Програє вибрані 30 секунд один раз, щоб перевірити, що це те місце.',
    'tour.clip.analyze.title': 'Розібрати акорди',
    'tour.clip.analyze.text': 'Хмара завантажить лише цей фрагмент і розбере акорди. Пісня зʼявиться в бібліотеці, а відео гратиме разом з акордами.',
```

in `en`, after the `tour.capture.*` keys:

```ts
    'tour.clip.window.title': 'Your fragment',
    'tour.clip.window.text': 'The frame is the 30 seconds the cloud analyzes. Drag it or click the line; the ← → keys move it by a second, with Shift by five.',
    'tour.clip.window.text.touch': 'The frame is the 30 seconds the cloud analyzes. Drag it with a finger or tap the line to move it there.',
    'tour.clip.from.title': 'From here',
    'tour.clip.from.text': 'Play the video and pause it where the part you want begins — this button puts the frame right there.',
    'tour.clip.preview.title': 'Preview',
    'tour.clip.preview.text': 'Plays the chosen 30 seconds once, so you can check it is the right part.',
    'tour.clip.analyze.title': 'Find the chords',
    'tour.clip.analyze.text': 'The cloud downloads just this fragment and finds the chords. The song lands in your library and the video plays along with the chords.',
```

`frontend/src/components/clip/ClipPage.tsx` — import `useTourTrigger` from `'../tour/hooks'` and `clipReady` from `'../../lib/tour/trigger'`; after `const playerBroken = …`:

```tsx
  // the picker's tour: once the player has loaded (not while a fragment is being sent)
  useTourTrigger('clip', clipReady(playerStatus) && !busy)
```

and the anchors: in `ClipPage.tsx` add `data-tour="clip.from"` to the «Звідси» `Button`, `data-tour="clip.preview"` to «Прослухати», `data-tour="clip.analyze"` to «Розібрати акорди» (`Button` passes unknown props on to the `<button>`); in `ClipTimeline.tsx` add `data-tour="clip.window"` to the `role="slider"` element, right after `ref={lineRef}`.

- [ ] **Step 4: Run tests, types, lint**

Run: `cd frontend && npx vitest run && npx tsc -b && npm run lint`
Expected: PASS (incl. `i18n/tour.test.ts`: every key present in both languages, informal Ukrainian; `components/tour/anchors.test.ts`: the four anchors exist in `ClipPage.tsx` / `ClipTimeline.tsx`).

- [ ] **Step 5: Check in the browser**

Clear the tour flag (`javascript_tool`: `localStorage.removeItem('chords-listener-tours')`), open `http://localhost:5173/#/youtube/dQw4w9WgXcQ`: once the video loads the tour starts at the window, then «Звідси», «Прослухати», «Розібрати акорди». On `resize_window {preset: "mobile"}` the first step uses the touch text. Reset to desktop.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/tour/tours.ts frontend/src/lib/tour/tours.test.ts frontend/src/lib/tour/trigger.ts frontend/src/lib/tour/trigger.test.ts frontend/src/i18n/tour.ts frontend/src/components/clip/ClipPage.tsx frontend/src/components/clip/ClipTimeline.tsx
git commit -m "$(cat <<'EOF'
YouTube clips (web): tour for the fragment picker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Docs (README, SPEC, CLOUD)

**Files:**
- Modify: `README.md` (Онлайн-версія, Хмарний сервер), `docs/SPEC.md` (§ "Where the API lives", routes), `docs/CLOUD.md` (YouTube, Cloud Run settings, Deploy)

**Interfaces:**
- Consumes: everything above; no code.

- [ ] **Step 1: README.md**

1. In «Онлайн-версія», replace the «Посилання» bullet with:

```markdown
- **Посилання.** Встав посилання на YouTube: з акаунтом відкриється вибір фрагмента — вибери 30 секунд, хмара завантажить лише їх і розпізнає акорди (на будь-якому пристрої, телефон теж). Посилання з інших сайтів сервер у хмарі завантажує цілком.
```

2. In the «Акаунт» paragraph, replace «дає акорди з YouTube» with «дає акорди з YouTube (фрагмент на 30 секунд, без мікрофона)».
3. After the «Слухати у вкладці (YouTube)» heading, replace its first paragraph with:

```markdown
З акаунтом посилання на YouTube відкриває вибір фрагмента: рамка на 30 секунд поверх відео (перетягни її, торкнись лінії або натисни «Звідси», щоб почати з поточного місця; «Прослухати» програє вибране), а «Розібрати акорди» віддає її хмарі. Хмара завантажує лише ці 30 секунд через Cloudflare WARP і робить із них пісню: відео стартує з початку фрагмента й зупиняється на його кінці, акорди лягають точно на відео. Той самий фрагмент удруге не завантажується, інший фрагмент того ж відео — окрема пісня.

Якщо YouTube усе ж не віддає фрагмент (або без акаунта), сайт сам відкриває «Слухати у вкладці» — з того ж місця:
```

4. In «Хмарний сервер», after the `deploy_cloud.sh` code block, add:

````markdown
**Фрагменти з YouTube** завантажує окремий маленький сервіс `chords-fetch` (Cloud Run, до 3 контейнерів, через Cloudflare WARP, бо YouTube не пускає адреси Google Cloud). Розгортається окремо, перед `deploy_cloud.sh`:

```bash
./scripts/deploy_fetch.sh                 # секрет WARP (раз, із твоєю згодою), Cloud NAT, збірка, розгортання
./scripts/deploy_cloud.sh                 # API дізнається адресу chords-fetch (CHORDS_FETCH_URL)
python3 scripts/smoke_fetch.py            # 18 відео з перевірки, по фрагменту з кожного
```

Для першого запуску потрібен `wgcf` (`brew install wgcf`): скрипт зареєструє один пристрій WARP, спитавши дозволу, і збереже профіль лише в Secret Manager. Вартість: Cloud NAT ≈ $4–5 на місяць завжди, дані через NAT ≈ $0.045 за ГБ (фрагмент ≈ 0,5 МБ), сам `chords-fetch` вкладається в безкоштовну квоту Cloud Run. Без `chords-fetch` сайт для YouTube відкриває «Слухати у вкладці».
````

5. In «Як користуватись → 1. Додати пісню», the «Посилання» bullet: replace «розпізнавання почнеться одразу» with «з акаунтом відкриється вибір фрагмента на 30 секунд, на локальному сервері розпізнавання почнеться одразу», and «Якщо YouTube не віддає відео серверу (або ти без акаунта на сайті), відкривається «Слухати у вкладці»» stays.
6. In «Інструкція», the list of screens gains «вибір фрагмента з YouTube».

- [ ] **Step 2: docs/SPEC.md**

In "Where the API lives", replace the sentence beginning "`createJob` (links) rejects with client code `server_required`; `startLink` decides first…" up to "…its times are video times." with:

```markdown
`createJob` (links) rejects with client code `server_required`; `startLink` decides first (`linkTarget` in `components/input/url.ts`): a local server (`backend: 'local'`) downloads every link; signed in on the cloud, a YouTube video opens the fragment picker (`#/youtube/<videoId>[?t=<s>]`, the link's own `t=` as the default start) and «Розібрати акорди» sends `POST /api/jobs {url, clip: {start}}` (`createClipJob`); without an account it opens "listen in the tab" (`#/listen/youtube/<videoId>[?blocked=1][&t=<s>]`). A YouTube page that is not one video (playlist, channel) is `notVideo`: a hint, nothing sent. Other sites go to a connected server, otherwise ask for an account. A fragment job that ends in `download_blocked`, or a cloud that answers 501 `unavailable` to a fragment, opens "listen in the tab" at the fragment's start. Fragment tracks carry `clip: {start, end}` (video seconds) and `startOffset = start`: the player starts at `clip.start` and pauses at `clip.end` (`components/player/clipBounds.ts`); the title shows the range (`Назва · 1:12–1:42`). Tab recordings of a video keep `source: {type: 'youtube'}`; a recording that began at video time t > 0 is stored with t seconds of silence in front, so its times are video times.
```

In "HTTP API (`/api`)", next to `POST /api/jobs`, add: "`clip: {start}` (whole seconds, optional): only `CHORDS_YT_CLIP_S` (30) seconds of a YouTube video from `start`; the job and the track carry `clip: {start, end}`; 400 `invalid_url` for a non-YouTube link, 501 `unavailable` when the server can't download fragments (cloud without `CHORDS_FETCH_URL`)."

In "Guide / tour", add the seventh tour: "`clip` (route `clip`): the window (touch variant), «Звідси», «Прослухати», «Розібрати акорди»; starts once the embedded player has loaded."

- [ ] **Step 3: docs/CLOUD.md**

1. In "## YouTube", replace the "Client:" bullet with:

```markdown
- Client: a guest's YouTube link opens "Слухати у вкладці" (`#/listen/youtube/<videoId>`); a signed-in user's opens the fragment picker (`#/youtube/<videoId>`, see "YouTube clips" below); a YouTube page that is not one video (a playlist, a channel, a clip) only gets a hint to copy the video's own link. `parseYouTubeId` (`frontend/src/components/input/url.ts`) reads the same hosts and shapes as `sources._youtube_id_from` — keep them in step. A local server (`backend: 'local'`, a home connection) downloads whole videos. The API behaviour above (a whole video through yt-dlp from Cloud Run) remains for direct callers and old jobs: a job that ends in `download_blocked` offers "Слухати у вкладці".
```

2. Add after the "## YouTube" section:

````markdown
## YouTube clips (`chords-fetch`)

Spec: `docs/superpowers/specs/2026-10-07-youtube-warp-fetch-design.md`. YouTube asks Google Cloud addresses to prove they are not a bot; through Cloudflare WARP it does not (spike 2026-10-07: 18/18 videos, 54/54 from 3 parallel containers sharing one profile, 0 bot checks). WARP from Cloud Run works only over **Direct VPC egress + Cloud NAT**; over the default egress the WireGuard tunnel comes up but stalls on any payload over ~500 bytes.

- `POST /api/jobs {url, clip: {start}}` (chords-api, signed-in users): dedup by track key `youtube:<videoId>@<start>` → admit (quota "analyses") → `RemoteClipFetcher` calls `POST $CHORDS_FETCH_URL/clip {videoId, start, length: CHORDS_YT_CLIP_S}` with a Google ID token (audience = that URL); 429 / 503 / no connection are asked again with backoff for up to 60 s, then `download_failed` "The server is busy, try again in a minute". The answer names an object under `fetch/` (anything else is refused, nothing is deleted); the API downloads it, deletes it, and analyzes it with `startOffset = start`; the track gets `clip: {start, end}`. Without `CHORDS_FETCH_URL` a cloud server answers 501 `unavailable` (it never downloads YouTube itself); a local server downloads fragments in-process (`LocalClipFetcher`).
- `chords-fetch` (`backend/app/fetch_service.py`, image `backend/fetch.Dockerfile`): FastAPI, `POST /clip {videoId, start, length}` (id `^[A-Za-z0-9_-]{11}$`, `start` ≥ 0 whole seconds, `length` 1..60; anything else 400 `invalid_url`; URLs are never accepted). It probes the video (live streams and a start past the end → `invalid_url`), downloads `[start, min(start + length, duration)]` with yt-dlp `download_ranges` through `socks5h://127.0.0.1:40000`, uploads `fetch/<requestId>/source.<ext>` to the Firebase bucket and answers `{title, artist, duration, thumbnail, start, end, path, size}`; errors `{code, message}`. Retries: a refused media URL (HTTP 403) or a stall → up to 3 fresh tries; a bot check → one WARP reconnect (new session) and one more try, then `download_blocked`; each try is cut off after 90 s. One log line per request (video, range, outcome, attempts, seconds), no user ids.
- WARP: `wireproxy` (`github.com/windtf/wireproxy` v1.1.3) on the wgcf profile from Secret Manager (`warp-profile`, mounted at `/secrets/warp/wgcf-profile.conf`); the container listens only after `https://www.cloudflare.com/cdn-cgi/trace` shows `warp=on` through the proxy. One profile is shared by all containers.
- Cloud Run (`scripts/deploy_fetch.sh`): `europe-west1`, gen2, 1 vCPU / 1 GiB, request-based billing, concurrency 1, min 0 / max `FETCH_MAX_INSTANCES` (3), timeout 300 s, `--no-allow-unauthenticated` (only `chords-api`'s service account has `roles/run.invoker`), Direct VPC egress `all-traffic` on `default`/`default`, service account `chords-fetch` with `roles/storage.objectUser` limited by an IAM condition to `objects/fetch/` and `roles/secretmanager.secretAccessor` on `warp-profile`. Cloud Router `chords-nat-router` + Cloud NAT `chords-nat` (auto IP, all subnet ranges); Private Google Access on subnet `default`.
- Clean-up: the API deletes each fragment once read; its hourly bucket sweep removes `fetch/**` older than 1 h (and `users/*/uploads/**` older than a day).
- Cost: Cloud NAT gateway + IP ≈ $4–5 / month whether used or not; NAT data ≈ $0.045 / GB (a fragment ≈ 0.5 MB); `chords-fetch` within Cloud Run's free tier at this scale; Secret Manager within its free tier.
- Rollout order: `scripts/deploy_fetch.sh` → `scripts/deploy_cloud.sh` (sets `CHORDS_FETCH_URL` when `chords-fetch` exists, and `CHORDS_YT_CLIP_S=30`) → `python3 scripts/smoke_fetch.py` → the web release. Until the API has `CHORDS_FETCH_URL`, fragments answer 501 and the site opens "Слухати у вкладці", so any order is safe.
- Risks: YouTube may start flagging WARP addresses (fallback: the capture page; next step several profiles or a home relay); yt-dlp must be bumped in `backend/uv.lock` and `backend/fetch.Dockerfile` together (`tests/test_fetch_image.py`); WARP's free tier is meant for personal devices.
````

3. In "## Cloud Run settings (cost guards)", add to the env list: `CHORDS_FETCH_URL` (when `chords-fetch` exists), `CHORDS_YT_CLIP_S=30`.
4. In "## Deploy", add a bullet: "`scripts/deploy_fetch.sh` (before `deploy_cloud.sh`): APIs (Secret Manager, Compute) → secret `warp-profile` (registered once with a local `wgcf`, after your confirmation) → Cloud Router + Cloud NAT + Private Google Access → service account `chords-fetch` + IAM → `gcloud builds submit backend --config backend/fetch.cloudbuild.yaml` → `gcloud run deploy chords-fetch` → `roles/run.invoker` for `chords-api` → one fragment straight from the service when `gcloud auth print-identity-token` works. Both scripts share `scripts/gcloud_common.sh` (credentials, Cloud Build wait loop)."

- [ ] **Step 4: Check the docs build nothing broken**

Run: `grep -n "accountHint\|never sends YouTube links\|every YouTube link, from a guest or a signed-in user" README.md docs/*.md || echo clean`
Expected: `clean` (no stale statements left).

- [ ] **Step 5: Commit**

```bash
git add README.md docs/SPEC.md docs/CLOUD.md
git commit -m "$(cat <<'EOF'
Docs: YouTube clips through chords-fetch (feature, API, deploy, cost)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Rollout (owner-run; needs explicit go-ahead at each step)

**Files:** none (operations). Every step creates billable resources or publishes; do each only after the owner says so in chat, and report the output.

**Interfaces:**
- Consumes: `scripts/deploy_fetch.sh`, `scripts/deploy_cloud.sh`, `scripts/smoke_fetch.py` (Tasks 8–9); the merged branch for the web release (`.github/workflows/pages.yml` publishes `main`).

- [ ] **Step 1: Whole-branch gate before anything leaves the machine**

```bash
cd backend && uv run pytest -q
```

```bash
cd frontend && npx vitest run && npx tsc -b && npm run lint && npm run build
```

Expected: everything passes; the build succeeds.

- [ ] **Step 2: Deploy `chords-fetch` (owner confirms; the WARP registration prompt is theirs to answer)**

```bash
./scripts/deploy_fetch.sh
```

Expected: the secret step asks «Register it now? [y/N]» once (the owner answers); NAT, IAM, build (~3–5 min), deploy; the direct smoke prints `HTTP 200` with a title and `start 60 end 90`. If the bucket IAM binding with a condition fails because the bucket has no uniform bucket-level access, stop and ask the owner (do not drop the condition). If the direct smoke fails, read `gcloud run services logs read chords-fetch --region europe-west1 --limit 50` before changing anything.

- [ ] **Step 3: Point chords-api at it (owner confirms)**

```bash
SKIP_SETUP=1 ./scripts/deploy_cloud.sh
```

Expected: the last lines include `YouTube fragments: https://chords-fetch-…run.app`.

- [ ] **Step 4: Live smoke**

```bash
python3 scripts/smoke_fetch.py
```

Expected: `19/19 checks passed; download_blocked: 0` (18 fragments + the dedup check). A few `download_blocked` mean YouTube flags the WARP address: report the numbers, do not retry in a loop.

- [ ] **Step 5: Web release (owner confirms; merging to `main` publishes GitHub Pages)**

Finish the branch with superpowers:finishing-a-development-branch (PR into `main`). After Pages deploys, the owner tries a YouTube link from a phone: picker → «Розібрати акорди» → the track with the video stopping at the fragment's end.

---

## Self-review notes (for the executor)

- Spec coverage: Goal/Decisions 1–6 → Tasks 1, 2, 4 (30 s, user start, one fragment = one track, video-linked track with `clip`), 3–6 (separate service, WARP, retries, security), 8 (one shared profile, NAT, IAM, Cloud Run settings), 10–16 (client), 17 (docs), 18 (rollout order). Error table: bot check after reconnect → Task 6 `test_a_second_bot_check_is_download_blocked` + Task 14 fallback; busy > 60 s → Task 3; live stream → `YtDlpFetcher.probe` (unchanged) inside `LocalClipFetcher`; start past the end → Tasks 2, 6; short video → Task 2; age-restricted/removed → `_map_ytdlp_error` (unchanged, Task 6 `test_a_final_error_is_not_retried`); same fragment again → Task 4; `chords-fetch` not deployed → Task 4 (501) + Task 13 (fallback); orphans in `fetch/` → Task 4 sweep.
- Names used across tasks: `ClipRange`, `ClipRequest`, `FetchedClip`, `ClipFetcher`, `LocalClipFetcher`, `RemoteClipFetcher`, `clip_track_key`, `clip_end`, `is_bot_check`, `FETCH_PREFIX`, `FETCH_GLOB`, `create_fetch_app`, `create_app_from_env`, `Warp`, `WarpError`; web: `createClipJob`, `submitClip`, `blockedPath`, `paths.clip`, `parseYouTubeStart`, `CLIP_SECONDS`, `clipWindow`, `clampStart`, `formatRange`, `clipRestart`, `pastClipEnd`, `idlePosition`, `clipReady`.

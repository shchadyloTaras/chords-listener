#!/usr/bin/env python3
"""Live check of YouTube fragments through chords-api + chords-fetch (docs/CLOUD.md → YouTube clips), as the
``smoke-test`` user: the 18 videos of the WARP spike, one 30-second fragment each (from --start, or from 0 when the
video is shorter), each must become a track with chords and ``clip``; the first fragment asked again must be done at
once (dedup). Clip tracks an earlier run left for these videos are deleted first, so no fragment is answered from
them. The tracks this run made, and any it may have made before an error, are deleted at the end unless --keep.
A run spends up to 18 of the smoke user's 40 daily analyses (CHORDS_QUOTA_ANALYSES), so a third run, or one after
smoke_cloud.py, on the same UTC day may hit 429.

    python3 scripts/smoke_fetch.py [--url URL] [--videos ID,ID,...] [--start S] [--keep]

Reads CHORDS_SMOKE_KEY from .cloud.env; standard library only (shares scripts/smoke_cloud.py's helpers).
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
import time

from smoke_cloud import DEFAULT_URL, RESULTS, Api, check, read_env_file

SPIKE_VIDEOS = (
    "dQw4w9WgXcQ kJQP7kiw5Fk JGwWNGJdvx8 fJ9rUzIMcZQ 9bZkp7q19f0 hTWKbfoikeg YQHsXMglC9A 60ItHLz5WEA OPf0YbXqDm0 "
    "RgKAFK5djSk CevxZvSJLk8 09R8_2nJtjg pRpeEdMmmQ0 hT_nvWreIhg lp-EO5I60KA kXYiU_JCYtU YykjpeuMNEk fRh_vgS2dFE"
).split()


def track_id(video_id: str, start: int) -> str:
    """The track id of a fragment, predicted without asking the server: mirrors backend track_id_for("youtube",
    f"{id}@{start}") (sha1 of ``youtube:<id>@<start>``, first 12 hex chars)."""
    return hashlib.sha1(f"youtube:{video_id}@{start}".encode()).hexdigest()[:12]


def fragment(api: Api, video_id: str, start: int) -> tuple[dict, float, int]:
    """Asks for one fragment and waits for its job; a start past a short video's end falls back to 0.
    Returns the job, its seconds, and the start the returned job was asked for."""
    started = time.monotonic()
    body = {"url": f"https://www.youtube.com/watch?v={video_id}", "clip": {"start": start}}
    res = api.request("POST", "/api/jobs", json_body=body)
    if res.status == 501:
        return {"status": "error", "errorCode": "unavailable", "error": "chords-api has no CHORDS_FETCH_URL"}, 0.0, start
    if res.status != 201:
        return ({"status": "error", "errorCode": f"http {res.status}", "error": res.body[:200].decode("utf-8", "replace")},
                0.0, start)
    job = api.wait_job(res.json()["id"], timeout=360)
    if job.get("errorCode") == "invalid_url" and start > 0:
        return fragment(api, video_id, 0)
    return job, time.monotonic() - started, start


def pre_clean(api: Api, videos: list[str]) -> None:
    """Deletes the clip tracks of these videos that an earlier run left behind: such a leftover answers its fragment at
    once ("already analyzed"), and the run would pass without chords-fetch ever running."""
    name = "pre-clean earlier fragment tracks"
    try:
        listed = api.request("GET", "/api/tracks")
    except OSError as exc:
        check(name, False, f"GET /api/tracks: {type(exc).__name__}: {exc}")
        return
    if listed.status != 200:
        check(name, False, f"GET /api/tracks: http {listed.status}")
        return
    stale = [t["id"] for t in listed.json() if t.get("clip") and (t.get("source") or {}).get("videoId") in videos]
    removed, problems = 0, []
    for stale_id in stale:
        try:
            status = api.request("DELETE", f"/api/tracks/{stale_id}").status
        except OSError as exc:
            problems.append(f"{stale_id}: {type(exc).__name__}: {exc}")
            continue
        if status == 204:
            removed += 1
        elif status != 404:
            problems.append(f"{stale_id}: http {status}")
    print(f"pre-clean: removed {removed} earlier fragment track(s) of these videos", flush=True)
    check(name, not problems, f"{len(stale)} found" + (f"; {problems}" if problems else ""))


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
    pre_clean(api, videos)
    made: list[str] = []      # tracks this run created
    suspects: list[str] = []  # track ids this run may have created before an error
    blocked = 0
    first_ok: tuple[str, int] | None = None  # (video, start the job was asked for) of the first fragment that succeeded
    try:
        for video_id in videos:
            try:
                job, seconds, start_used = fragment(api, video_id, args.start)
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
                if ok and first_ok is None:
                    first_ok = (video_id, start_used)
            except (TimeoutError, OSError) as exc:
                check(f"fragment {video_id}", False, f"{type(exc).__name__}: {exc}")
                suspects.append(track_id(video_id, args.start))
                if args.start > 0:
                    suspects.append(track_id(video_id, 0))
        if first_ok is None:
            print("dedup check skipped: no fragment succeeded", flush=True)
        else:
            name = "the same fragment again is done at once"
            dup_id, dup_start = first_ok
            try:
                res = api.request("POST", "/api/jobs", json_body={"url": dup_id, "clip": {"start": dup_start}})
            except OSError as exc:
                check(name, False, f"{type(exc).__name__}: {exc}")
            else:
                again = res.json() if res.status == 201 else {}
                detail = f"{again.get('status')} {again.get('message')}" if res.status == 201 else f"http {res.status}"
                check(name, again.get("status") == "done" and again.get("trackId") in made, detail)
    finally:
        if not args.keep:
            targets = list(dict.fromkeys(made + suspects))
            problems = []
            for tid in targets:
                try:
                    status = api.request("DELETE", f"/api/tracks/{tid}").status
                except OSError as exc:
                    problems.append(f"{tid}: {type(exc).__name__}: {exc}")
                    continue
                if status not in (204, 404):
                    problems.append(f"{tid}: http {status}")
            check("delete fragment tracks", not problems,
                  f"{len(targets)} track ids" + (f"; {problems}" if problems else ""))
    failed = [name for name, ok, _ in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed; download_blocked: {blocked}"
          + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

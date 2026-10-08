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

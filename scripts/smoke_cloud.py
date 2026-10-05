#!/usr/bin/env python3
"""End-to-end smoke test of the deployed cloud API (docs/CLOUD.md), as the ``smoke-test`` user.

    python3 scripts/smoke_cloud.py [--url URL] [--youtube URL | --skip-youtube] [--keep]
                                   [--firestore-token-file PATH]
    python3 scripts/smoke_cloud.py --cold          only: first-request latency + one short analysis

Checks: health, 401 without credentials, CORS preflight from the GitHub Pages origin, multipart upload
-> job -> track -> signed audio with HTTP Range (206), storage ingest (upload to the bucket with gcloud,
POST /api/jobs/storage linked to a YouTube video with startOffset), live-piano notes PUT/GET, a real
YouTube link (reports honestly whether YouTube blocks the server: download_blocked), quotas (running-jobs
limit -> 429, /api/me counters), delete, and timings (first request, analysis of a 4-minute song).
Everything it creates is removed at the end (tracks via the API, then users/smoke-test/ in the bucket).

The published library (Firestore index + track.json) is checked only with --firestore-token-file PATH, a file
holding an OAuth access token that may read Firestore and the bucket (`gcloud auth print-access-token > PATH`,
or the token minted by scripts/gcloud_token.cjs): after the upload analysis the index document
users/smoke-test/tracks/<id> must exist with version >= 1 and `gcloud storage cat` must show a matching
track.json; after the delete the index documents must be gone.

Needs: ffmpeg, uv (synthetic songs from backend/scripts/make_synthetic.py), gcloud, node with the
firebase-tools login (bucket access with a token minted by scripts/gcloud_token.cjs when gcloud has no
login). Reads CHORDS_SMOKE_KEY from .cloud.env; standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parents[1]
PROJECT = "build-chords-listener"
BUCKET = f"{PROJECT}.firebasestorage.app"
PAGES = "https://shchadylotaras.github.io"
DEFAULT_URL = "https://chords-api-84488579848.europe-west1.run.app"
DEFAULT_YOUTUBE = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"  # Rick Astley - Never Gonna Give You Up (3:33)
LINKED_VIDEO = "dQw4w9WgXcQ"
FIRESTORE = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"

RESULTS: list[tuple[str, bool, str]] = []
TIMINGS: dict[str, float] = {}


# --------------------------------------------------------------------------- small helpers


class Resp:
    def __init__(self, status: int, headers: dict[str, str], body: bytes, elapsed: float) -> None:
        self.status, self.headers, self.body, self.elapsed = status, headers, body, elapsed

    def json(self) -> Any:
        return json.loads(self.body or b"null")


class Api:
    def __init__(self, base: str, key: str) -> None:
        self.base = base.rstrip("/")
        self.key = key

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[bytes] = None,
        json_body: Any = None,
        headers: Optional[dict[str, str]] = None,
        auth: bool = True,
        timeout: float = 300,
    ) -> Resp:
        hdrs = dict(headers or {})
        if auth:
            hdrs["X-Smoke-Key"] = self.key
        if json_body is not None:
            body = json.dumps(json_body).encode()
            hdrs["Content-Type"] = "application/json"
        url = path if path.startswith("http") else self.base + path
        req = urllib.request.Request(url, data=body, method=method, headers=hdrs)
        started = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                data = res.read()
                return Resp(res.status, {k.lower(): v for k, v in res.headers.items()}, data, time.monotonic() - started)
        except urllib.error.HTTPError as err:
            data = err.read()
            return Resp(err.code, {k.lower(): v for k, v in err.headers.items()}, data, time.monotonic() - started)

    def upload(self, path: Path, content_type: str = "audio/mpeg") -> Resp:
        boundary = uuid.uuid4().hex
        head = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode()
        body = head + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        return self.request("POST", "/api/jobs/upload", body=body,
                            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})

    def wait_job(self, job_id: str, timeout: float = 900) -> dict:
        deadline = time.monotonic() + timeout
        job: dict = {}
        while time.monotonic() < deadline:
            res = self.request("GET", f"/api/jobs/{job_id}")
            if res.status == 200:
                job = res.json()
                if job["status"] in ("done", "error"):
                    return job
            time.sleep(1.0)
        raise TimeoutError(f"job {job_id} still {job.get('status')} after {timeout:.0f}s")


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  - ' + detail if detail else ''}", flush=True)
    return ok


def read_env_file() -> dict[str, str]:
    env: dict[str, str] = {}
    path = ROOT / ".cloud.env"
    if path.is_file():
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip()
    return env


def index_doc(api: Api, token_file: Path, track_id: str, *, present: bool = True, timeout: float = 20.0) -> Resp:
    """users/smoke-test/tracks/<id> read with the deploy credentials. Publishing is not part of the job's own
    result, so it polls until the document is there (200) or, with present=False, gone (404), or ``timeout``
    passes; any other status (no permission, ...) is returned as it is."""
    headers = {"Authorization": f"Bearer {token_file.read_text().strip()}", "x-goog-user-project": PROJECT}
    deadline = time.monotonic() + timeout
    while True:
        res = api.request("GET", f"{FIRESTORE}/users/smoke-test/tracks/{track_id}", auth=False, headers=headers)
        if res.status == (200 if present else 404) or time.monotonic() >= deadline:
            return res
        time.sleep(1.0)


def gcloud_bin() -> str:
    return os.environ.get("GCLOUD") or shutil.which("gcloud") or "/opt/homebrew/share/google-cloud-sdk/bin/gcloud"


def gcloud_env(tmp: Path) -> dict[str, str]:
    """Environment for gcloud: its own login if it has one, else a token minted from firebase-tools."""
    env = dict(os.environ, CLOUDSDK_CORE_PROJECT=PROJECT, CLOUDSDK_CORE_DISABLE_PROMPTS="1")
    probe = subprocess.run([gcloud_bin(), "auth", "print-access-token"], capture_output=True, env=env)
    if probe.returncode == 0:
        return env
    token = tmp / "token"
    subprocess.run(["node", str(ROOT / "scripts" / "gcloud_token.cjs"), str(token)], check=True, capture_output=True)
    env["CLOUDSDK_AUTH_ACCESS_TOKEN_FILE"] = str(token)
    return env


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def make_songs(tmp: Path) -> dict[str, Path]:
    """Short mp3s from the synthetic set + a 4-minute mp3 made by joining several of them."""
    syn = tmp / "syn"
    names = ["pop_c_piano", "minor_b_guitar", "folk_g_guitar", "waltz_d_34", "jazz_f_sevenths", "ballad_eb_pad",
             "a_minor_mix_break", "rock_e_detuned"]
    subprocess.run(["uv", "run", "--no-sync", "python", "scripts/make_synthetic.py", "--out", str(syn), "--only", *names],
                   cwd=ROOT / "backend", check=True, capture_output=True)
    out: dict[str, Path] = {}
    for name in names:
        mp3 = tmp / f"{name}.mp3"
        ffmpeg("-i", str(syn / f"{name}.wav"), "-c:a", "libmp3lame", "-b:a", "160k", str(mp3))
        out[name] = mp3
    listing = tmp / "concat.txt"
    listing.write_text("".join(f"file '{syn / n}.wav'\n" for n in names))
    long = tmp / "four_minutes.mp3"
    ffmpeg("-f", "concat", "-safe", "0", "-i", str(listing), "-t", "240", "-c:a", "libmp3lame", "-b:a", "192k", str(long))
    out["four_minutes"] = long
    return out


# --------------------------------------------------------------------------- the checks


def run_cold(api: Api, songs: dict[str, Path]) -> None:
    res = api.request("GET", "/api/health", auth=False, timeout=600)
    TIMINGS["first_request_s"] = round(res.elapsed, 2)
    check("first request (health)", res.status == 200, f"{res.elapsed:.2f}s")
    started = time.monotonic()
    up = api.upload(songs["waltz_d_34"])
    if check("cold upload accepted", up.status == 201, f"{up.status}"):
        job = api.wait_job(up.json()["id"])
        TIMINGS["cold_short_analysis_s"] = round(time.monotonic() - started, 2)
        check("cold short analysis", job["status"] == "done", f"{TIMINGS['cold_short_analysis_s']}s")
        if job.get("trackId"):
            api.request("DELETE", f"/api/tracks/{job['trackId']}")


def run_all(api: Api, songs: dict[str, Path], tmp: Path, youtube: Optional[str], firestore_token: Optional[Path]) -> None:
    created: set[str] = set()

    # -- health, first-request latency
    res = api.request("GET", "/api/health", auth=False, timeout=600)
    TIMINGS["first_request_s"] = round(res.elapsed, 2)
    health = res.json() if res.status == 200 else {}
    check("health", res.status == 200 and health.get("ok") is True,
          f"{res.elapsed:.2f}s, engine {health.get('engine', {}).get('name')} {health.get('engine', {}).get('version')}, "
          f"yt-dlp {health.get('ytdlp')}, features {health.get('engine', {}).get('features')}")

    # -- auth
    res = api.request("GET", "/api/tracks", auth=False)
    check("401 without credentials", res.status == 401 and res.json().get("code") == "unauthorized", f"{res.status}")
    res = api.request("GET", "/api/tracks", auth=False, headers={"Authorization": "Bearer not-a-real-token"})
    check("401 with an invalid Firebase token", res.status == 401 and res.json().get("code") == "unauthorized", f"{res.status}")
    me = api.request("GET", "/api/me").json()
    check("smoke key -> uid smoke-test", me.get("uid") == "smoke-test", json.dumps(me.get("quotas")))
    used_before = (me.get("quotas") or {}).get("analyses", {}).get("used", 0)

    # -- CORS
    res = api.request("OPTIONS", "/api/jobs/storage", auth=False, headers={
        "Origin": PAGES, "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type"})
    check("CORS preflight from GitHub Pages", res.status == 200 and res.headers.get("access-control-allow-origin") == PAGES,
          f"{res.status}, allow-origin={res.headers.get('access-control-allow-origin')}")
    res = api.request("GET", "/api/tracks", auth=False, headers={"Origin": PAGES})
    check("401 readable cross-origin", res.status == 401 and res.headers.get("access-control-allow-origin") == PAGES)

    # -- multipart upload -> job -> track -> signed audio with Range
    started = time.monotonic()
    up = api.upload(songs["pop_c_piano"])
    track: dict = {}
    if check("multipart upload accepted", up.status == 201, f"{up.status} {up.body[:200]!r}"):
        job = api.wait_job(up.json()["id"])
        TIMINGS["short_song_total_s"] = round(time.monotonic() - started, 2)
        if check("upload job done", job["status"] == "done", f"{job['status']} {job.get('errorCode')} {job.get('error')} "
                                                                f"in {TIMINGS['short_song_total_s']}s"):
            created.add(job["trackId"])
            track = api.request("GET", f"/api/tracks/{job['trackId']}").json()
            labels = [c["label"] for c in track.get("chords", [])]
            check("track has chords", len(labels) >= 4,
                  f"key {track.get('key', {}).get('name')}, tempo {track.get('tempo')}, chords {labels[:10]}")
    if track and firestore_token:
        # -- the published library: index document + track.json (checked before the notes edit below bumps the version)
        res = index_doc(api, firestore_token, track["id"])
        fields = res.json().get("fields", {}) if res.status == 200 else {}
        version = int(fields.get("version", {}).get("integerValue", 0))
        check("Firestore index document users/smoke-test/tracks/<id>", res.status == 200 and version >= 1,
              f"{res.status}, version {version}, fields {sorted(fields)[:6]}...")
        env = gcloud_env(tmp)
        cat = subprocess.run([gcloud_bin(), "storage", "cat", f"gs://{BUCKET}/users/smoke-test/tracks/{track['id']}/track.json"],
                             env=env, capture_output=True, text=True)
        published: dict = json.loads(cat.stdout) if cat.returncode == 0 else {}
        audio = published.get("media", {}).get("audio", {})
        check("track.json published next to the track",
              cat.returncode == 0 and published.get("id") == track["id"] and published.get("version") == version
              and audio.get("path") == f"users/smoke-test/tracks/{track['id']}/audio.mp3" and bool(audio.get("token"))
              and "audioUrl" not in published,
              cat.stderr.strip()[-200:] if cat.returncode else f"version {published.get('version')}, media {sorted(published.get('media', {}))}")
    if track:
        audio_url = track["audioUrl"]
        check("audioUrl is signed", "sig=" in audio_url and "u=smoke-test" in audio_url, audio_url.split("?")[0])
        res = api.request("GET", audio_url, auth=False, headers={"Range": "bytes=0-1023"})
        check("signed audio plays with Range (206)", res.status == 206 and len(res.body) == 1024
              and res.headers.get("content-range", "").startswith("bytes 0-1023/"),
              f"{res.status} {res.headers.get('content-range')} {res.headers.get('content-type')}")
        res = api.request("GET", audio_url[:-3] + "xyz", auth=False, headers={"Range": "bytes=0-1"})
        check("tampered signature -> 401", res.status == 401, f"{res.status}")
        res = api.request("GET", audio_url.split("?")[0], auth=False)
        check("unsigned audio -> 401", res.status == 401, f"{res.status}")

        # -- notes
        notes = {"version": 1, "engine": "smoke-test", "notes": [[0.5, 1.0, 60, 0.8], [1.0, 1.5, 64, 0.7]]}
        res = api.request("PUT", f"/api/tracks/{track['id']}/notes", json_body=notes)
        got = api.request("GET", f"/api/tracks/{track['id']}/notes")
        check("notes PUT/GET", res.status == 204 and got.status == 200 and got.json()["notes"] == notes["notes"],
              f"PUT {res.status}, GET {got.status}")

    # -- storage ingest (bucket upload with gcloud, linked to a YouTube video)
    env = gcloud_env(tmp)
    object_path = f"users/smoke-test/uploads/{uuid.uuid4().hex}/tab-recording.mp3"
    cp = subprocess.run([gcloud_bin(), "storage", "cp", str(songs["folk_g_guitar"]), f"gs://{BUCKET}/{object_path}",
                         "--content-type=audio/mpeg"], env=env, capture_output=True, text=True)
    if check("bucket upload (gcloud storage cp)", cp.returncode == 0, cp.stderr.strip()[-200:] if cp.returncode else object_path):
        started = time.monotonic()
        res = api.request("POST", "/api/jobs/storage", json_body={
            "path": object_path, "startOffset": 7.5,
            "source": {"type": "youtube", "videoId": LINKED_VIDEO, "url": f"https://youtu.be/{LINKED_VIDEO}"}})
        if check("POST /api/jobs/storage", res.status == 201, f"{res.status} {res.body[:200]!r}"):
            job = api.wait_job(res.json()["id"])
            TIMINGS["storage_ingest_total_s"] = round(time.monotonic() - started, 2)
            if check("storage job done", job["status"] == "done", f"{job['status']} {job.get('errorCode')} {job.get('error')}"):
                created.add(job["trackId"])
                t = api.request("GET", f"/api/tracks/{job['trackId']}").json()
                chords = t.get("chords") or [{}]
                first_played = next((c for c in chords if c.get("label") != "N"), {})
                check("linked to the video, times shifted by startOffset",
                      t.get("source", {}).get("videoId") == LINKED_VIDEO and t.get("startOffset") == 7.5
                      and chords[0].get("label") == "N" and chords[0].get("start") == 0
                      and first_played.get("start", 0) >= 7.5,
                      f"title {t.get('title')!r}, artist {t.get('artist')!r}, startOffset {t.get('startOffset')}, "
                      f"first chords {[(c['label'], c['start']) for c in t.get('chords', [])[:3]]}")
            ls = subprocess.run([gcloud_bin(), "storage", "ls", f"gs://{BUCKET}/{object_path}"], env=env,
                                capture_output=True, text=True)
            check("upload object deleted after ingest", ls.returncode != 0, ls.stdout.strip() or "gone")
    res = api.request("POST", "/api/jobs/storage", json_body={"path": "users/someone-else/uploads/x/a.mp3"})
    check("storage path of another user -> 403", res.status == 403, f"{res.status} {res.json().get('code')}")

    # -- a real YouTube link
    if youtube:
        started = time.monotonic()
        res = api.request("POST", "/api/jobs", json_body={"url": youtube})
        if check("POST /api/jobs (YouTube)", res.status == 201, f"{res.status} {res.body[:200]!r}"):
            job = api.wait_job(res.json()["id"], timeout=900)
            TIMINGS["youtube_total_s"] = round(time.monotonic() - started, 2)
            outcome = job["status"] if job["status"] == "done" else f"error {job.get('errorCode')}: {job.get('error')}"
            print(f"INFO  YouTube outcome: {outcome} after {TIMINGS['youtube_total_s']}s", flush=True)
            if job["status"] == "done":
                created.add(job["trackId"])
                t = api.request("GET", f"/api/tracks/{job['trackId']}").json()
                check("YouTube download + analysis worked", len(t.get("chords", [])) > 4,
                      f"{t.get('title')!r} key {t.get('key', {}).get('name')}, {len(t.get('chords', []))} chords")
            else:
                check("YouTube failure is classified", job.get("errorCode") in ("download_blocked", "download_failed"),
                      outcome)

    # -- quotas: the running-jobs limit (2 per user), and the daily counter
    first = api.upload(songs["four_minutes"])
    started = time.monotonic()
    second = api.upload(songs["jazz_f_sevenths"])
    third = api.upload(songs["ballad_eb_pad"])
    me = api.request("GET", "/api/me").json()
    check("third concurrent job -> 429 quota_exceeded",
          first.status == 201 and second.status == 201 and third.status == 429 and third.json().get("code") == "quota_exceeded",
          f"{first.status}/{second.status}/{third.status} {third.body[:120]!r}; jobs {me.get('quotas', {}).get('jobs')}")
    for res in (first, second, third):
        if res.status == 201:
            job = api.wait_job(res.json()["id"])
            if job.get("trackId"):
                created.add(job["trackId"])
            if res is first:
                TIMINGS["four_minute_song_analysis_s"] = round(time.monotonic() - started, 2)
                check("4-minute song analyzed", job["status"] == "done",
                      f"{TIMINGS['four_minute_song_analysis_s']}s (upload {first.elapsed:.1f}s before that)")
    me = api.request("GET", "/api/me").json()
    used = me.get("quotas", {}).get("analyses", {})
    check("daily analyses counter", used.get("used", 0) > used_before, f"{used_before} -> {used}")

    # -- delete
    ok = True
    for tid in sorted(created):
        ok &= api.request("DELETE", f"/api/tracks/{tid}").status == 204
        ok &= api.request("GET", f"/api/tracks/{tid}").status == 404
    left = api.request("GET", "/api/tracks").json()
    check("delete tracks", ok and not left, f"{len(created)} deleted, {len(left)} left")
    if firestore_token:
        stale = [tid for tid in sorted(created) if index_doc(api, firestore_token, tid, present=False).status != 404]
        check("index documents removed with the tracks", not stale, f"still indexed: {stale}" if stale else f"{len(created)} gone")


def cleanup_bucket(tmp: Path) -> None:
    env = gcloud_env(tmp)
    res = subprocess.run([gcloud_bin(), "storage", "rm", "-r", f"gs://{BUCKET}/users/smoke-test/"], env=env,
                         capture_output=True, text=True)
    print(f"INFO  bucket cleanup users/smoke-test/: {'done' if res.returncode == 0 else res.stderr.strip()[-160:]}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--url", default=os.environ.get("CHORDS_CLOUD_URL", DEFAULT_URL))
    ap.add_argument("--youtube", default=DEFAULT_YOUTUBE)
    ap.add_argument("--skip-youtube", action="store_true")
    ap.add_argument("--keep", action="store_true", help="leave users/smoke-test/ in the bucket")
    ap.add_argument("--cold", action="store_true", help="only measure the first request + one short analysis")
    ap.add_argument("--firestore-token-file", type=Path, metavar="PATH",
                    help="file with an access token that reads Firestore and the bucket: also check the published "
                         "library (index document, track.json)")
    args = ap.parse_args()
    key = os.environ.get("CHORDS_SMOKE_KEY") or read_env_file().get("CHORDS_SMOKE_KEY", "")
    if not key:
        print("CHORDS_SMOKE_KEY not found (.cloud.env)", file=sys.stderr)
        return 2
    if args.firestore_token_file and not args.firestore_token_file.is_file():
        print(f"--firestore-token-file: {args.firestore_token_file} not found", file=sys.stderr)
        return 2
    api = Api(args.url, key)
    print(f"Smoke test of {api.base}", flush=True)
    with tempfile.TemporaryDirectory(prefix="chords-smoke-") as tmp_name:
        tmp = Path(tmp_name)
        songs = make_songs(tmp)
        try:
            if args.cold:
                run_cold(api, songs)
            else:
                run_all(api, songs, tmp, None if args.skip_youtube else args.youtube, args.firestore_token_file)
        finally:
            if not args.keep:
                cleanup_bucket(tmp)
    failed = [name for name, ok, _ in RESULTS if not ok]
    print(f"\nTimings: {json.dumps(TIMINGS)}")
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed" + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

"""Cloud mode (docs/CLOUD.md): Firebase auth, per-user isolation, signed media URLs, quotas, storage ingest,
YouTube download_blocked mapping, CORS/host guard. Offline and fast: the token check, the GCS client, the
engine and yt-dlp are fakes; short audio fixtures are generated with ffmpeg."""
from __future__ import annotations

import base64
import errno
import hashlib
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Optional
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

import app.jobs as jobs_module
import app.quotas as quotas_module
import app.storage as storage_module
from app.auth import AuthError, FirebaseTokenVerifier, MediaSigner
from app.admin import history, stats
from app.firestore import IndexError_
from app.main import create_app
from app.models import AnalysisResult, Settings
from app.publish import NullPublisher, Publisher
from app.sources import SourceError, _map_ytdlp_error, youtube_thumbnail
from app.users import SMOKE_UID, current_uid, user_context

from admin.fixtures import MemDb
from cloud_fixtures import (  # noqa: F401  (cloud, make_cloud, media: fixtures)
    BUCKET,
    PAGES,
    PROJECT,
    SIGNING_KEY,
    SMOKE_KEY,
    VIDEO_ID,
    FakeEngine,
    FakeGcs,
    FakeVerifier,
    H,
    assert_error,
    cloud,
    make_cloud,
    media,
    needs_ffmpeg,
    upload,
    upload_and_wait,
    wait_job,
)

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


# --------------------------------------------------------------------------- auth


def test_public_endpoints_and_401s(cloud: SimpleNamespace) -> None:
    c = cloud.client
    assert c.get("/api/health").status_code == 200
    assert c.get("/api/openapi.json").status_code == 200
    assert c.get("/api/docs").status_code == 200
    for res in (
        c.get("/api/tracks"),
        c.get("/api/jobs"),
        c.post("/api/jobs", json={"url": VIDEO_ID}),
        c.get("/api/tracks", headers={"Authorization": "Bearer nope"}),
        c.get("/api/tracks", headers={"Authorization": "Basic dXNlcjpwYXNz"}),
        c.get("/api/tracks", headers={"Authorization": "Bearer "}),
        c.get("/api/tracks", headers={"X-Smoke-Key": "wrong-key-wrong-key"}),
        c.get("/api/does-not-exist"),
    ):
        assert_error(res, 401, "unauthorized")
        assert res.headers["www-authenticate"] == "Bearer"
    assert c.get("/api/tracks", headers=H("alice")).json() == []
    assert c.get("/api/does-not-exist", headers=H("alice")).status_code == 404


def test_me_and_smoke_key(cloud: SimpleNamespace) -> None:
    c = cloud.client
    me = c.get("/api/me", headers=H("alice")).json()
    assert me["uid"] == "alice" and me["cloud"] is True
    assert me["quotas"]["analyses"] == {"used": 0, "limit": 40}
    assert me["quotas"]["vocals"] == {"used": 0, "limit": 15}
    assert me["quotas"]["jobs"] == {"used": 0, "limit": 2}
    assert len(me["quotas"]["day"]) == 10
    assert c.get("/api/me", headers={"X-Smoke-Key": SMOKE_KEY}).json()["uid"] == SMOKE_UID


def test_short_smoke_key_is_disabled(make_cloud) -> None:
    env = make_cloud(smoke_key="short")
    assert_error(env.client.get("/api/me", headers={"X-Smoke-Key": "short"}), 401, "unauthorized")


def test_401_is_readable_cross_origin_and_preflight_needs_no_token(cloud: SimpleNamespace) -> None:
    c = cloud.client
    res = c.get("/api/tracks", headers={"Origin": PAGES})
    assert res.status_code == 401 and res.headers["access-control-allow-origin"] == PAGES
    pre = c.options("/api/jobs/storage", headers={
        "Origin": PAGES, "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
    })
    assert pre.status_code == 200, pre.text
    assert pre.headers["access-control-allow-origin"] == PAGES
    assert "authorization" in pre.headers["access-control-allow-headers"].lower()
    evil = c.options("/api/jobs", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in evil.headers


def test_host_guard_and_cross_site_check_in_cloud_mode(make_cloud) -> None:
    env = make_cloud(allowed_hosts=("*.run.app", "localhost"))
    run_host = "https://chords-api-123456.europe-west1.run.app"
    c = TestClient(env.app, base_url=run_host)
    assert c.get("/api/health").status_code == 200
    assert_error(c.get("/api/health", headers={"Host": "evil.example"}), 400, "internal")
    body = {"url": "not a url"}
    # pages origin, local dev pages and same-origin pass the cross-site check (then fail validation)
    for origin in (PAGES, "http://localhost:5173", "http://127.0.0.1:4173", run_host):
        assert_error(c.post("/api/jobs", json=body, headers={**H("alice"), "Origin": origin}), 400, "invalid_url")
    # another *.run.app service is not trusted just because its host matches the host pattern
    for origin in ("https://evil.run.app", "https://evil.example", "null"):
        assert_error(c.post("/api/jobs", json=body, headers={**H("alice"), "Origin": origin}), 403, "internal")


# --------------------------------------------------------------------------- the real token verifier


@pytest.fixture(scope="module")
def rsa_keys() -> SimpleNamespace:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    def make() -> tuple[str, str]:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        private = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                    serialization.NoEncryption()).decode()
        public = key.public_key().public_bytes(serialization.Encoding.PEM,
                                               serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        return private, public

    (p1, k1), (p2, k2) = make(), make()
    return SimpleNamespace(private=p1, public=k1, other_private=p2, other_public=k2)


def _claims(now: float, **over: Any) -> dict[str, Any]:
    claims = {"iss": f"https://securetoken.google.com/{PROJECT}", "aud": PROJECT, "sub": "uid123ABC",
              "iat": int(now) - 10, "exp": int(now) + 3600, "auth_time": int(now) - 20}
    claims.update(over)
    return claims


def _signed(private_pem: str, claims: dict[str, Any], kid: str = "k1") -> str:
    from google.auth import crypt, jwt

    return jwt.encode(crypt.RSASigner.from_string(private_pem, key_id=kid), claims).decode()


def _unsigned(claims: dict[str, Any]) -> str:
    def b64(d: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")

    return f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64(claims)}."


def test_firebase_verifier_rs256(rsa_keys: SimpleNamespace) -> None:
    fetches: list[int] = []
    clock = [time.time()]

    def fetch() -> tuple[dict[str, str], float]:
        fetches.append(1)
        return {"k1": rsa_keys.public, "k2": rsa_keys.other_public}, 600.0

    v = FirebaseTokenVerifier(PROJECT, emulator=False, fetch_certs=fetch, clock=lambda: clock[0])
    now = clock[0]
    assert v.verify(_signed(rsa_keys.private, _claims(now))) == "uid123ABC"
    assert v.verify(_signed(rsa_keys.other_private, _claims(now), kid="k2")) == "uid123ABC"
    assert len(fetches) == 1  # certificates are cached
    bad = [
        _signed(rsa_keys.private, _claims(now, aud="other-project")),
        _signed(rsa_keys.private, _claims(now, iss="https://securetoken.google.com/other-project")),
        _signed(rsa_keys.private, _claims(now, exp=int(now) - 3600, iat=int(now) - 7200)),
        _signed(rsa_keys.private, _claims(now, sub="")),
        _signed(rsa_keys.private, _claims(now, sub="../../etc")),
        _signed(rsa_keys.private, _claims(now), kid="unknown"),
        _signed(rsa_keys.other_private, _claims(now), kid="k1"),  # signed by the wrong key
        _unsigned(_claims(now)),  # unsigned tokens only with the Auth emulator
        "not.a.token",
        "",
    ]
    good = _signed(rsa_keys.private, _claims(now))
    head, payload, sig = good.split(".")
    forged = json.loads(base64.urlsafe_b64decode(payload + "=="))
    forged["sub"] = "someone-else"
    bad.append(f"{head}.{base64.urlsafe_b64encode(json.dumps(forged).encode()).decode().rstrip('=')}.{sig}")
    for token in bad:
        with pytest.raises(AuthError):
            v.verify(token)
    clock[0] += 601  # max-age passed: certificates are fetched again (token times are checked against real time)
    v.verify(_signed(rsa_keys.private, _claims(time.time())))
    assert len(fetches) == 2


def test_firebase_verifier_keeps_stale_certs_when_google_is_unreachable(rsa_keys: SimpleNamespace) -> None:
    from app.auth import AuthUnavailable

    calls = {"n": 0}
    clock = [time.time()]

    def fetch() -> tuple[dict[str, str], float]:
        calls["n"] += 1
        if calls["n"] > 1:
            raise OSError("network down")
        return {"k1": rsa_keys.public}, 60.0

    v = FirebaseTokenVerifier(PROJECT, emulator=False, fetch_certs=fetch, clock=lambda: clock[0])
    v.verify(_signed(rsa_keys.private, _claims(time.time())))
    clock[0] += 120
    assert v.verify(_signed(rsa_keys.private, _claims(time.time()))) == "uid123ABC"
    nothing = FirebaseTokenVerifier(PROJECT, emulator=False, fetch_certs=lambda: (_ for _ in ()).throw(OSError("down")))
    with pytest.raises(AuthUnavailable):
        nothing.verify(_signed(rsa_keys.private, _claims(time.time())))


def test_emulator_tokens_only_with_the_emulator_env(monkeypatch: pytest.MonkeyPatch) -> None:
    now = time.time()
    token = _unsigned(_claims(now, sub="emuUser1"))
    monkeypatch.delenv("FIREBASE_AUTH_EMULATOR_HOST", raising=False)
    with pytest.raises(AuthError):
        FirebaseTokenVerifier(PROJECT, fetch_certs=lambda: ({}, 60)).verify(token)
    monkeypatch.setenv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099")
    v = FirebaseTokenVerifier(PROJECT)
    assert v.emulator is True
    assert v.verify(token) == "emuUser1"
    for claims in (_claims(now, exp=int(now) - 600), _claims(now, aud="x"), _claims(now, iss="https://evil"),
                   _claims(now, sub="a/b")):
        with pytest.raises(AuthError):
            v.verify(_unsigned(claims))


def test_emulator_token_end_to_end(make_cloud, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099")
    env = make_cloud(verifier=FirebaseTokenVerifier(PROJECT))
    token = _unsigned(_claims(time.time(), sub="emuUser1"))
    me = env.client.get("/api/me", headers={"Authorization": f"Bearer {token}"}).json()
    assert me["uid"] == "emuUser1"


# --------------------------------------------------------------------------- isolation


@needs_ffmpeg
def test_users_are_isolated(cloud: SimpleNamespace, media: SimpleNamespace) -> None:
    c = cloud.client
    job, track = upload_and_wait(cloud, media.a, "alice")
    tid = track["id"]
    data = cloud.settings.data_dir
    assert (data / "users" / "alice" / "tracks" / tid / "meta.json").is_file()
    assert not (data / "tracks").exists()  # no legacy layout in cloud mode

    # bob sees nothing of alice's
    assert c.get("/api/tracks", headers=H("bob")).json() == []
    assert c.get("/api/jobs", headers=H("bob")).json() == []
    assert_error(c.get(f"/api/jobs/{job['id']}", headers=H("bob")), 404, "not_found")
    assert_error(c.get(f"/api/tracks/{tid}", headers=H("bob")), 404, "not_found")
    assert_error(c.get(f"/api/tracks/{tid}/audio", headers=H("bob")), 404, "not_found")
    assert_error(c.patch(f"/api/tracks/{tid}", json={"title": "x"}, headers=H("bob")), 404, "not_found")
    assert_error(c.get(f"/api/tracks/{tid}/notes", headers=H("bob")), 404, "not_found")
    assert_error(c.post(f"/api/tracks/{tid}/reanalyze", headers=H("bob")), 404, "not_found")
    assert_error(c.delete(f"/api/tracks/{tid}", headers=H("bob")), 404, "not_found")
    # alice still has hers; jobs list is hers only
    assert [t["id"] for t in c.get("/api/tracks", headers=H("alice")).json()] == [tid]
    assert [j["id"] for j in c.get("/api/jobs", headers=H("alice")).json()] == [job["id"]]

    # the same file uploaded by bob is analyzed again into bob's own library (no cross-user dedup)
    job_b, track_b = upload_and_wait(cloud, media.a, "bob")
    assert track_b["id"] == tid and job_b["id"] != job["id"]
    assert len(cloud.engine.calls) == 2
    assert (data / "users" / "bob" / "tracks" / tid / "audio.mp3").is_file()
    assert c.delete(f"/api/tracks/{tid}", headers=H("alice")).status_code == 204
    assert c.get(f"/api/tracks/{tid}", headers=H("bob")).status_code == 200


@needs_ffmpeg
def test_running_job_is_not_shared_between_users(cloud: SimpleNamespace) -> None:
    c = cloud.client
    cloud.engine.gate = threading.Event()
    a = c.post("/api/jobs", json={"url": VIDEO_ID}, headers=H("alice")).json()
    b = c.post("/api/jobs", json={"url": VIDEO_ID}, headers=H("bob")).json()
    assert a["id"] != b["id"]  # same video, different users: separate jobs
    again = c.post("/api/jobs", json={"url": f"https://youtu.be/{VIDEO_ID}"}, headers=H("alice")).json()
    assert again["id"] == a["id"]  # ...but a user's own running job is reused
    cloud.engine.gate.set()
    assert wait_job(c, a["id"], H("alice"))["status"] == "done"
    assert wait_job(c, b["id"], H("bob"))["status"] == "done"


# --------------------------------------------------------------------------- signed media URLs


@needs_ffmpeg
def test_signed_audio_urls(cloud: SimpleNamespace, media: SimpleNamespace) -> None:
    c = cloud.client
    _, track = upload_and_wait(cloud, media.a, "alice")
    tid, url = track["id"], track["audioUrl"]
    parts = urlsplit(url)
    q = {k: v[0] for k, v in parse_qs(parts.query).items()}
    assert parts.path == f"/api/tracks/{tid}/audio" and q["u"] == "alice" and q["exp"].isdigit() and q["sig"]
    assert 12 * 3600 <= int(q["exp"]) - time.time() <= 13 * 3600 + 5

    full = c.get(url)  # no Authorization header: the signature is the credential
    assert full.status_code == 200 and full.headers["content-type"] == "audio/mpeg"
    size = len(full.content)
    part = c.get(url, headers={"Range": "bytes=100-199"})
    assert part.status_code == 206 and part.headers["content-range"] == f"bytes 100-199/{size}"
    assert part.content == full.content[100:200]
    assert c.head(url).status_code == 200
    # the URL is stable within the hour (cacheable), and the API with a token still works too
    assert c.get(f"/api/tracks/{tid}", headers=H("alice")).json()["audioUrl"] == url
    assert c.get(parts.path, headers=H("alice")).status_code == 200

    tampered_sig = url[:-2] + ("AA" if not url.endswith("AA") else "BB")
    other_user = url.replace("u=alice", "u=bob")
    longer = url.replace(f"exp={q['exp']}", f"exp={int(q['exp']) + 3600}")
    other_track = url.replace(tid, "0123456789ab")
    expired = MediaSigner(SIGNING_KEY).sign("alice", parts.path, now=time.time() - 14 * 3600)
    for bad in (tampered_sig, other_user, longer, other_track, expired, parts.path + "?u=alice&exp=1&sig=x"):
        assert_error(c.get(bad), 401, "unauthorized")
    assert_error(c.get(parts.path), 401, "unauthorized")
    # bob's token can't reach alice's audio (his namespace has no such track)
    assert_error(c.get(parts.path, headers=H("bob")), 404, "not_found")


def test_signed_urls_cover_stems_and_media_signer_rules() -> None:
    signer = MediaSigner(SIGNING_KEY)
    now = 1_800_000_000.0
    url = signer.sign("alice", "/api/tracks/0123456789ab/stems/vocals", now=now)
    q = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
    assert signer.verify("alice", "/api/tracks/0123456789ab/stems/vocals", q["exp"], q["sig"], now=now)
    assert not signer.verify("alice", "/api/tracks/0123456789ab/stems/instruments", q["exp"], q["sig"], now=now)
    assert not signer.verify("alice", "/api/tracks/0123456789ab/stems/vocals", q["exp"], q["sig"], now=now + 14 * 3600)
    assert signer.sign("alice", "/p", now=now) == signer.sign("alice", "/p", now=now + 60)  # same hour, same URL
    assert not MediaSigner("another-key-0123456789").verify("alice", "/api/tracks/0123456789ab/stems/vocals",
                                                            q["exp"], q["sig"], now=now)
    with pytest.raises(ValueError):
        MediaSigner("short")


@needs_ffmpeg
def test_signed_stem_url_passes_auth(cloud: SimpleNamespace, media: SimpleNamespace) -> None:
    _, track = upload_and_wait(cloud, media.a, "alice")
    with user_context("alice"):
        url = cloud.app.state.store.media_url(track["id"], "stems/vocals")
    res = cloud.client.get(url)
    # authenticated by the signature; the stems endpoint itself belongs to the vocals feature
    assert res.status_code != 401


@needs_ffmpeg
def test_local_mode_keeps_plain_urls_and_ignores_cloud_headers(make_cloud, media: SimpleNamespace) -> None:
    env = make_cloud(cloud=False, allowed_hosts=("testserver",))
    c = env.client
    res = upload(c, media.a, {"Authorization": "Bearer garbage", "X-Smoke-Key": "whatever"})
    assert res.status_code == 201, res.text
    job = wait_job(c, res.json()["id"], {})
    track = c.get(f"/api/tracks/{job['trackId']}").json()
    assert track["audioUrl"] == f"/api/tracks/{track['id']}/audio"
    assert (env.settings.data_dir / "tracks" / track["id"] / "meta.json").is_file()
    assert not (env.settings.data_dir / "users").exists()
    assert c.get("/api/me").json() == {"uid": None, "cloud": False, "quotas": None}
    assert_error(c.post("/api/jobs/storage", json={"path": "users/x/uploads/1/a.mp3"}), 501, "unavailable")


# --------------------------------------------------------------------------- quotas


@needs_ffmpeg
def test_daily_analysis_quota(make_cloud, media: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    env = make_cloud(quota_analyses=2)
    c = env.client
    upload_and_wait(env, media.a, "alice")
    upload_and_wait(env, media.b, "alice")
    assert c.get("/api/me", headers=H("alice")).json()["quotas"]["analyses"] == {"used": 2, "limit": 2}
    # a duplicate of an analyzed file costs nothing
    dup = upload(c, media.a, H("alice")).json()
    assert dup["status"] == "done"
    body = assert_error(upload(c, media.c, H("alice")), 429, "quota_exceeded")
    assert "2 song analyses per day" in body["detail"]
    assert_error(c.post("/api/jobs", json={"url": VIDEO_ID}, headers=H("alice")), 429, "quota_exceeded")
    track_id = c.get("/api/tracks", headers=H("alice")).json()[0]["id"]
    assert_error(c.post(f"/api/tracks/{track_id}/reanalyze", headers=H("alice")), 429, "quota_exceeded")
    assert list(env.settings.work_dir.iterdir()) == []  # the rejected upload was cleaned up
    # other users have their own counters
    upload_and_wait(env, media.c, "bob")
    # counters survive a restart (persisted on the data dir)
    again = make_cloud(env.settings.data_dir, quota_analyses=2)
    assert_error(upload(again.client, media.c, H("alice")), 429, "quota_exceeded")
    stored = json.loads((env.settings.data_dir / "users" / "alice" / "quota.json").read_text())
    assert stored["analyses"] == 2 and stored["day"] == quotas_module.utc_day()
    # a new UTC day resets them
    monkeypatch.setattr(quotas_module, "utc_day", lambda: "2099-01-01")
    res = upload(again.client, media.c, H("alice"))
    assert res.status_code == 201, res.text


@needs_ffmpeg
def test_concurrent_jobs_per_user(make_cloud, media: SimpleNamespace) -> None:
    env = make_cloud(max_user_jobs=1)
    c = env.client
    env.engine.gate = threading.Event()
    first = upload(c, media.a, H("alice"))
    assert first.status_code == 201
    body = assert_error(upload(c, media.b, H("alice")), 429, "quota_exceeded")
    assert "in progress" in body["detail"]
    assert c.get("/api/me", headers=H("alice")).json()["quotas"]["jobs"] == {"used": 1, "limit": 1}
    assert upload(c, media.b, H("bob")).status_code == 201  # per user, not global
    env.engine.gate.set()
    wait_job(c, first.json()["id"], H("alice"))
    assert upload(c, media.b, H("alice")).status_code == 201
    # the rejected attempt did not use up a daily analysis
    assert c.get("/api/me", headers=H("alice")).json()["quotas"]["analyses"]["used"] == 2


def test_quota_helpers_for_feature_code(make_cloud) -> None:
    env = make_cloud(quota_vocals=1)
    jobs = env.app.state.jobs
    with user_context("carol"):
        jobs.admit("vocals")
        with pytest.raises(SourceError) as info:
            jobs.admit("vocals")
        assert info.value.code == "quota_exceeded" and info.value.status == 429
        assert jobs.quotas.usage()["vocals"] == {"used": 1, "limit": 1}


# --------------------------------------------------------------------------- uploads


@needs_ffmpeg
def test_cloud_multipart_upload_limit(make_cloud, media: SimpleNamespace) -> None:
    env = make_cloud(max_request_mb=0.01)
    body = assert_error(upload(env.client, media.a, H("alice")), 413, "too_large")
    assert "/api/jobs/storage" in body["detail"]


@needs_ffmpeg
def test_storage_ingest(cloud: SimpleNamespace, media: SimpleNamespace) -> None:
    c = cloud.client
    data = media.a.read_bytes()
    path = cloud.gcs.put("users/alice/uploads/u1/My Song.mp3", data)
    res = c.post("/api/jobs/storage", json={"path": path}, headers=H("alice"))
    assert res.status_code == 201, res.text
    job = res.json()
    assert job["source"] == {"type": "file", "url": None, "videoId": None, "filename": "My Song.mp3"}
    assert job["title"] == "My Song"
    done = wait_job(c, job["id"], H("alice"))
    assert done["status"] == "done", done
    assert done["trackId"] == hashlib.sha1(data).hexdigest()[:12]
    assert (BUCKET, path) not in cloud.gcs.objects and path in cloud.gcs.deleted  # consumed
    track = c.get(f"/api/tracks/{done['trackId']}", headers=H("alice")).json()
    assert track["title"] == "My Song" and track["startOffset"] is None
    assert [ch["label"] for ch in track["chords"]] == ["C", "Am"]
    assert list(cloud.settings.work_dir.iterdir()) == []

    # the same content again: deduplicated per user, the new upload is still removed
    path2 = cloud.gcs.put("users/alice/uploads/u2/copy.mp3", data)
    again = wait_job(c, c.post("/api/jobs/storage", json={"path": path2}, headers=H("alice")).json()["id"], H("alice"))
    assert again["status"] == "done" and again["trackId"] == done["trackId"] and again["message"] == "Already analyzed"
    assert (BUCKET, path2) not in cloud.gcs.objects
    assert len(cloud.engine.calls) == 1


@needs_ffmpeg
def test_storage_ingest_linked_to_youtube(cloud: SimpleNamespace, media: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jobs_module, "youtube_oembed", lambda vid: ("Never Gonna Give You Up", "Rick Astley"))
    c = cloud.client
    path = cloud.gcs.put("users/alice/uploads/u3/recording.webm", media.a.read_bytes(), content_type="audio/webm")
    res = c.post("/api/jobs/storage", headers=H("alice"), json={
        "path": path, "startOffset": 12.5,
        "source": {"type": "youtube", "videoId": VIDEO_ID, "url": "https://evil.example/not-used"},
    })
    assert res.status_code == 201, res.text
    job = res.json()
    assert job["source"] == {"type": "youtube", "url": f"https://www.youtube.com/watch?v={VIDEO_ID}",
                             "videoId": VIDEO_ID, "filename": None}
    assert job["thumbnail"] == youtube_thumbnail(VIDEO_ID)
    done = wait_job(c, job["id"], H("alice"))
    assert done["status"] == "done" and done["title"] == "Never Gonna Give You Up", done
    track = c.get(f"/api/tracks/{done['trackId']}", headers=H("alice")).json()
    assert track["source"]["type"] == "youtube" and track["source"]["videoId"] == VIDEO_ID
    assert track["artist"] == "Rick Astley" and track["thumbnail"] == youtube_thumbnail(VIDEO_ID)
    assert track["startOffset"] == 12.5
    chords = track["chords"]
    assert [ch["label"] for ch in chords] == ["N", "C", "Am"]
    assert chords[0]["start"] == 0 and chords[0]["end"] == 12.5 and chords[1]["start"] == 12.5
    assert track["beats"][0] == 12.5 and track["downbeats"] == [12.5]
    assert 16.4 < track["duration"] < 16.7  # 12.5 s offset + ~4 s recording
    assert len(track["waveform"]) > 100 and track["waveform"][0] == 0.0
    # re-analysis keeps the video time base
    re_job = wait_job(c, c.post(f"/api/tracks/{track['id']}/reanalyze", headers=H("alice")).json()["id"], H("alice"))
    assert re_job["status"] == "done"
    assert c.get(f"/api/tracks/{track['id']}", headers=H("alice")).json()["chords"][1]["start"] == 12.5
    # a URL alone identifies the video too
    path2 = cloud.gcs.put("users/alice/uploads/u4/rec.webm", Path(media.b).read_bytes())
    res2 = c.post("/api/jobs/storage", headers=H("alice"), json={
        "path": path2, "title": "My take", "source": {"type": "youtube", "url": f"https://youtu.be/{VIDEO_ID}?t=3"}})
    assert res2.json()["title"] == "My take" and res2.json()["source"]["videoId"] == VIDEO_ID
    wait_job(c, res2.json()["id"], H("alice"))


def test_storage_ingest_rejections(make_cloud) -> None:
    env = make_cloud(max_upload_mb=0.001)  # ~1 KB
    c = env.client
    big = env.gcs.put("users/alice/uploads/u1/big.mp3", b"x" * 5000)
    empty = env.gcs.put("users/alice/uploads/u2/empty.mp3", b"")
    env.gcs.put("users/bob/uploads/u1/b.mp3", b"x" * 10)
    post = lambda body: c.post("/api/jobs/storage", json=body, headers=H("alice"))  # noqa: E731
    assert_error(post({"path": "users/bob/uploads/u1/b.mp3"}), 403, "unauthorized")
    assert_error(post({"path": "users/alice/tracks/x/audio.mp3"}), 403, "unauthorized")
    assert_error(post({"path": "users/alice/uploads/../../bob/uploads/u1/b.mp3"}), 404, "not_found")
    assert_error(post({"path": "users/alice/uploads/u9//x.mp3"}), 404, "not_found")
    assert_error(post({"path": "users/alice/uploads/missing/x.mp3"}), 404, "not_found")
    assert_error(post({"path": big}), 413, "too_large")
    assert_error(post({"path": empty}), 415, "unsupported_format")
    assert (BUCKET, big) not in env.gcs.objects and (BUCKET, empty) not in env.gcs.objects
    assert (BUCKET, "users/bob/uploads/u1/b.mp3") in env.gcs.objects  # never touched
    res = post({"path": "users/alice/uploads/u3/a.mp3", "source": {"type": "youtube", "videoId": "bad"}})
    assert res.status_code == 422
    env.gcs.put("users/alice/uploads/u5/a.mp3", b"x" * 10)
    assert_error(post({"path": "users/alice/uploads/u5/a.mp3", "source": {"type": "youtube"}}), 400, "invalid_url")
    assert_error(post({"path": "users/alice/uploads/u5/a.mp3", "startOffset": -1}), 422, "internal")


@needs_ffmpeg
def test_storage_ingest_of_non_audio_fails_and_still_deletes(cloud: SimpleNamespace) -> None:
    path = cloud.gcs.put("users/alice/uploads/u1/notes.mp3", b"definitely not audio\n" * 100)
    job = wait_job(cloud.client, cloud.client.post("/api/jobs/storage", json={"path": path}, headers=H("alice")).json()["id"], H("alice"))
    assert job["status"] == "error" and job["errorCode"] == "unsupported_format"
    assert (BUCKET, path) not in cloud.gcs.objects


def test_storage_ingest_needs_a_bucket(make_cloud) -> None:
    env = make_cloud(upload_bucket="")
    assert_error(env.client.post("/api/jobs/storage", json={"path": "users/alice/uploads/1/a.mp3"}, headers=H("alice")),
                 501, "unavailable")


def test_stale_upload_sweep(cloud: SimpleNamespace) -> None:
    gcs = cloud.gcs
    gcs.put("users/alice/uploads/old/a.mp3", b"1", age_s=3 * 86400)
    gcs.put("users/alice/uploads/new/b.mp3", b"2", age_s=60)
    gcs.put("users/alice/tracks/0123456789ab/audio.mp3", b"3", age_s=3 * 86400)
    assert cloud.app.state.bucket.sweep() == 1
    names = {n for (_, n) in gcs.objects}
    assert names == {"users/alice/uploads/new/b.mp3", "users/alice/tracks/0123456789ab/audio.mp3"}


@needs_ffmpeg
def test_install_across_file_systems(cloud: SimpleNamespace, media: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    """Cloud Run: scratch on /tmp, library on the bucket mount -> directory renames fail with EXDEV."""
    real_replace = os.replace

    def replace(src: Any, dst: Any) -> None:
        if Path(src).is_dir():
            raise OSError(errno.EXDEV, "Invalid cross-device link")
        real_replace(src, dst)

    monkeypatch.setattr(storage_module.os, "replace", replace)
    _, track = upload_and_wait(cloud, media.a, "alice")
    d = cloud.settings.data_dir / "users" / "alice" / "tracks" / track["id"]
    assert sorted(p.name for p in d.iterdir()) == ["analysis.json", "audio.mp3", "meta.json", "track.json"]
    assert list(cloud.settings.work_dir.iterdir()) == []
    assert cloud.client.delete(f"/api/tracks/{track['id']}", headers=H("alice")).status_code == 204
    assert not d.exists()


# --------------------------------------------------------------------------- publishing (app.publish)


def sweep_threads() -> list[threading.Thread]:
    return [t for t in threading.enumerate() if t.name == "chords-publish-sweep"]


def wait_for(condition: Callable[[], Any], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.02)


def track_dir_of(env: SimpleNamespace, uid: str, track_id: str) -> Path:
    return env.settings.data_dir / "users" / uid / "tracks" / track_id


@needs_ffmpeg
def test_publishes_after_every_change(cloud: SimpleNamespace, media: SimpleNamespace) -> None:
    c, docs = cloud.client, cloud.index.docs
    _, track = upload_and_wait(cloud, media.a, "alice")
    tid = track["id"]
    assert docs[("alice", tid)]["version"] == 1 and not docs[("alice", tid)]["edited"]
    track_file = track_dir_of(cloud, "alice", tid) / "track.json"
    assert json.loads(track_file.read_text())["version"] == 1

    assert c.patch(f"/api/tracks/{tid}", json={"title": "Renamed"}, headers=H("alice")).status_code == 200
    assert docs[("alice", tid)]["title"] == "Renamed" and docs[("alice", tid)]["version"] == 2
    assert json.loads(track_file.read_text())["title"] == "Renamed"

    edit = {"chords": [{"start": 0, "end": 2, "label": "G"}]}
    assert c.patch(f"/api/tracks/{tid}", json=edit, headers=H("alice")).status_code == 200
    assert docs[("alice", tid)]["edited"] and docs[("alice", tid)]["version"] == 3
    assert c.patch(f"/api/tracks/{tid}", json={}, headers=H("alice")).status_code == 200
    assert docs[("alice", tid)]["version"] == 3  # nothing changed, nothing published

    assert c.post(f"/api/tracks/{tid}/reset", headers=H("alice")).status_code == 200
    assert not docs[("alice", tid)]["edited"] and docs[("alice", tid)]["version"] == 4
    assert c.post(f"/api/tracks/{tid}/reset", headers=H("alice")).status_code == 200
    assert docs[("alice", tid)]["version"] == 4  # no edits left to reset

    job = wait_job(c, c.post(f"/api/tracks/{tid}/reanalyze", headers=H("alice")).json()["id"], H("alice"))
    assert job["status"] == "done"
    assert docs[("alice", tid)]["version"] == 5

    assert c.delete(f"/api/tracks/{tid}", headers=H("alice")).status_code == 204
    assert ("alice", tid) not in docs and not track_dir_of(cloud, "alice", tid).exists()


@needs_ffmpeg
def test_other_users_are_published_separately(cloud: SimpleNamespace, media: SimpleNamespace) -> None:
    _, a = upload_and_wait(cloud, media.a, "alice")
    _, b = upload_and_wait(cloud, media.a, "bob")
    assert set(cloud.index.docs) == {("alice", a["id"]), ("bob", b["id"])}
    assert (track_dir_of(cloud, "bob", b["id"]) / "track.json").is_file()


@needs_ffmpeg
def test_already_analyzed_republishes_what_the_index_lacks(cloud: SimpleNamespace, media: SimpleNamespace) -> None:
    _, track = upload_and_wait(cloud, media.a, "alice")
    key, writes = ("alice", track["id"]), cloud.index.calls
    upload_and_wait(cloud, media.a, "alice")  # dedup path, the index has the track: nothing to do
    assert cloud.index.calls == writes

    cloud.index.docs.clear()
    upload_and_wait(cloud, media.a, "alice")  # self-heal: a track that predates publishing
    assert key in cloud.index.docs and cloud.index.docs[key]["version"] == 1

    cloud.index.docs.clear()  # the same through a client upload to Storage
    path = cloud.gcs.put("users/alice/uploads/u1/a.mp3", Path(media.a).read_bytes())
    res = cloud.client.post("/api/jobs/storage", json={"path": path}, headers=H("alice"))
    assert wait_job(cloud.client, res.json()["id"], H("alice"))["trackId"] == track["id"]
    assert key in cloud.index.docs


@needs_ffmpeg
def test_publish_off_switch(make_cloud, media: SimpleNamespace) -> None:
    env = make_cloud(publish=False)
    assert isinstance(env.app.state.publisher, NullPublisher)
    wait_for(lambda: not sweep_threads())  # earlier tests' apps are shut down; this one started none
    _, track = upload_and_wait(env, media.a, "alice")
    assert env.client.patch(f"/api/tracks/{track['id']}", json={"title": "x"}, headers=H("alice")).status_code == 200
    assert not env.index.docs and env.index.calls == 0
    assert not (track_dir_of(env, "alice", track["id"]) / "track.json").exists()
    assert env.client.delete(f"/api/tracks/{track['id']}", headers=H("alice")).status_code == 204
    assert not track_dir_of(env, "alice", track["id"]).exists()


@needs_ffmpeg
def test_local_mode_publishes_nothing(make_cloud, media: SimpleNamespace) -> None:
    env = make_cloud(cloud=False, allowed_hosts=("testserver",))
    assert isinstance(env.app.state.publisher, NullPublisher)
    wait_for(lambda: not sweep_threads())
    job = wait_job(env.client, upload(env.client, media.a, {}).json()["id"], {})
    d = env.settings.data_dir / "tracks" / job["trackId"]
    assert env.client.delete(f"/api/tracks/{job['trackId']}").status_code == 204
    assert not d.exists() and not env.index.docs and env.index.calls == 0


@needs_ffmpeg
def test_delete_works_while_the_index_is_down(cloud: SimpleNamespace, media: SimpleNamespace) -> None:
    _, track = upload_and_wait(cloud, media.a, "alice")
    tid = track["id"]
    cloud.index.fail, cloud.index.retryable = 99, False
    assert cloud.client.delete(f"/api/tracks/{tid}", headers=H("alice")).status_code == 204  # the user is not told
    assert not track_dir_of(cloud, "alice", tid).exists()
    pending = cloud.settings.data_dir / "users" / "alice" / "publish-pending.json"
    assert json.loads(pending.read_text()) == {"ids": {tid: "unpublish"}}
    cloud.index.fail = 0
    assert cloud.app.state.publisher.sweep_pending() == 1
    assert ("alice", tid) not in cloud.index.docs and not pending.exists()
    assert_error(cloud.client.delete(f"/api/tracks/{tid}", headers=H("alice")), 404, "not_found")


@needs_ffmpeg
def test_failed_publish_is_queued_and_swept_at_startup(make_cloud, media: SimpleNamespace) -> None:
    env = make_cloud()
    env.index.fail, env.index.retryable = 99, False
    _, track = upload_and_wait(env, media.a, "alice")  # the request succeeds, publishing does not
    key = ("alice", track["id"])
    pending = env.settings.data_dir / "users" / "alice" / "publish-pending.json"
    assert key not in env.index.docs and json.loads(pending.read_text()) == {"ids": {track["id"]: "publish"}}
    again = make_cloud(env.settings.data_dir)  # a restart: the sweep thread works through the queue
    wait_for(lambda: key in again.index.docs and not pending.exists())


def test_publisher_choice(tmp_path: Path) -> None:
    def app_for(**overrides: Any) -> Any:
        fields: dict[str, Any] = {"auth": "firebase", "upload_bucket": BUCKET, **overrides}
        settings = Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist", signing_key=SIGNING_KEY,
                            scratch_dir=tmp_path / "scratch", **fields)
        return create_app(settings, analyzer=FakeEngine(), token_verifier=FakeVerifier())

    app = app_for()
    assert isinstance(app.state.publisher, Publisher) and app.state.store.publisher is app.state.publisher
    assert app.state.publisher.bucket_name == BUCKET
    assert isinstance(app_for(publish=False).state.publisher, NullPublisher)
    assert isinstance(app_for(upload_bucket="").state.publisher, NullPublisher)
    assert isinstance(app_for(auth="off").state.publisher, NullPublisher)


def test_publishing_on_without_a_bucket_is_an_error(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    # Clients that read the index never fall back while it answers: nothing published is an outage, not a warning.
    settings = Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist", signing_key=SIGNING_KEY,
                        scratch_dir=tmp_path / "scratch", auth="firebase", upload_bucket="")
    with caplog.at_level(logging.WARNING, logger="chords.api"):
        app = create_app(settings, analyzer=FakeEngine(), token_verifier=FakeVerifier())
    assert isinstance(app.state.publisher, NullPublisher)
    errors = [r for r in caplog.records if r.levelno == logging.ERROR and "CHORDS_UPLOAD_BUCKET" in r.getMessage()]
    assert errors, caplog.text


def test_pending_sweep_repeats_and_stops_with_the_app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import app.main as main_module

    class CountingPublisher:
        calls = 0

        def sweep_pending(self) -> int:
            CountingPublisher.calls += 1
            if CountingPublisher.calls == 2:
                raise RuntimeError("a sweep that fails does not stop the loop")
            return 0

    monkeypatch.setattr(main_module, "PUBLISH_SWEEP_INTERVAL_S", 0.01)
    gcs = FakeGcs()  # the bucket sweep thread of this app works on the fake, never on a real bucket
    gcs.put("fetch/0123456789abcdef/source.webm", b"1", age_s=2 * 3600)
    settings = Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist", auth="firebase",
                        signing_key=SIGNING_KEY, scratch_dir=tmp_path / "scratch", upload_bucket=BUCKET)
    app = create_app(settings, analyzer=FakeEngine(), token_verifier=FakeVerifier(), gcs_client_factory=lambda: gcs,
                     publisher_factory=lambda store: CountingPublisher())
    wait_for(lambda: not sweep_threads())  # earlier tests' apps are shut down
    with TestClient(app):
        assert [t.daemon for t in sweep_threads()] == [True]
        wait_for(lambda: CountingPublisher.calls >= 4)
        wait_for(lambda: not gcs.objects)  # the start-up pass of the bucket sweep took the stale fragment from the fake
    wait_for(lambda: not sweep_threads())  # the app's shutdown ends the loop
    stopped = CountingPublisher.calls
    time.sleep(0.1)
    assert CountingPublisher.calls == stopped


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(None, True), ("", True), ("1", True), ("on", True), ("yes", True), ("0", False), ("false", False),
     ("OFF", False), (" Off ", False)],
)
def test_chords_publish_switch(monkeypatch: pytest.MonkeyPatch, raw: Optional[str], expected: bool) -> None:
    if raw is None:
        monkeypatch.delenv("CHORDS_PUBLISH", raising=False)
    else:
        monkeypatch.setenv("CHORDS_PUBLISH", raw)
    assert Settings.from_env().publish is expected


# --------------------------------------------------------------------------- YouTube on servers


@pytest.mark.parametrize(
    ("message", "youtube", "code"),
    [
        ("ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot. Use --cookies-from-browser or "
         "--cookies for the authentication.", True, "download_blocked"),
        ("ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm your age. This video may be inappropriate", True, "download_blocked"),
        ("ERROR: unable to download video data: HTTP Error 403: Forbidden", True, "download_blocked"),
        ("ERROR: [youtube] x: HTTP Error 429: Too Many Requests", True, "download_blocked"),
        ("ERROR: [youtube] dQw4w9WgXcQ: Requested format is not available. Use --list-formats", True, "download_blocked"),
        ("ERROR: [soundcloud] 1: Requested format is not available", False, "download_failed"),
        ("ERROR: [youtube] dQw4w9WgXcQ: Video unavailable", True, "download_failed"),
        ("ERROR: [generic] Unsupported URL: https://example.com", False, "invalid_url"),
        ("ERROR: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname>", True, "download_failed"),
    ],
)
def test_ytdlp_error_mapping(message: str, youtube: bool, code: str) -> None:
    assert _map_ytdlp_error(Exception(message), youtube=youtube).code == code


def test_download_blocked_job(cloud: SimpleNamespace) -> None:
    cloud.fetcher.error = _map_ytdlp_error(Exception("Sign in to confirm you're not a bot"), youtube=True)
    job = wait_job(cloud.client, cloud.client.post("/api/jobs", json={"url": VIDEO_ID}, headers=H("alice")).json()["id"], H("alice"))
    assert job["status"] == "error" and job["errorCode"] == "download_blocked"


def test_js_runtime_is_passed_to_ytdlp(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.sources as sources

    monkeypatch.setattr(sources, "find_executable", lambda name: "/usr/local/bin/node" if name == "node" else None)
    opts = sources.YtDlpFetcher(1000)._opts()
    assert opts["js_runtimes"] == {"node": {"path": "/usr/local/bin/node"}}


# --------------------------------------------------------------------------- settings & shifting


def test_settings_from_env_cloud(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for k, v in {
        "CHORDS_AUTH": "firebase", "CHORDS_DATA_DIR": str(tmp_path), "CHORDS_SIGNING_KEY": "k" * 32,
        "CHORDS_SMOKE_KEY": "s" * 32, "CHORDS_UPLOAD_BUCKET": BUCKET, "CHORDS_WORK_DIR": str(tmp_path / "w"),
        "CHORDS_QUOTA_ANALYSES": "7", "CHORDS_QUOTA_VOCALS": "3", "CHORDS_QUOTA_JOBS": "4",
        "CHORDS_ALLOWED_ORIGINS": "https://mirror.example", "CHORDS_ALLOWED_HOSTS": "api.example.com",
    }.items():
        monkeypatch.setenv(k, v)
    s = Settings.from_env()
    assert s.cloud and s.users_dir == tmp_path / "users" and s.work_dir == tmp_path / "w"
    assert (s.quota_analyses, s.quota_vocals, s.max_user_jobs) == (7, 3, 4)
    assert "*.run.app" in s.allowed_hosts and "api.example.com" in s.allowed_hosts
    assert PAGES in s.allowed_origins and "https://mirror.example" in s.allowed_origins
    assert "k" * 32 not in repr(s) and "s" * 32 not in repr(s)
    monkeypatch.setenv("CHORDS_AUTH", "fire")
    with pytest.raises(ValueError):
        Settings.from_env()
    monkeypatch.setenv("CHORDS_AUTH", "off")
    assert not Settings.from_env().cloud


def test_analysis_shift() -> None:
    a = AnalysisResult.from_engine({
        "duration": 10.0, "beats": [0.0, 1.0], "downbeats": [0.0],
        "chords": [{"start": 0, "end": 5, "label": "C"}, {"start": 5, "end": 10, "label": "G"}],
        "waveform": [0.5] * 10,
    })
    s = a.shifted(5.0)
    assert s.duration == 15.0 and s.beats == [5.0, 6.0] and s.downbeats == [5.0]
    assert [(c.label, c.start, c.end) for c in s.chords] == [("N", 0.0, 5.0), ("C", 5.0, 10.0), ("G", 10.0, 15.0)]
    assert s.waveform == [0.0] * 5 + [0.5] * 10
    assert a.shifted(0) is a and a.shifted(float("nan")) is a
    silent_start = AnalysisResult.from_engine({
        "duration": 4.0, "chords": [{"start": 0, "end": 1, "label": "N"}, {"start": 1, "end": 4, "label": "Am"}]})
    assert [(c.label, c.start, c.end) for c in silent_start.shifted(2.0).chords] == [("N", 0.0, 3.0), ("Am", 3.0, 6.0)]


def test_context_is_restored_after_requests(cloud: SimpleNamespace) -> None:
    cloud.client.get("/api/me", headers=H("alice"))
    assert current_uid() is None


def test_track_listing_reads_tracks_in_parallel_as_the_caller(cloud: SimpleNamespace) -> None:
    store = cloud.app.state.store
    analysis = AnalysisResult.from_engine({"duration": 3.0, "chords": [{"start": 0, "end": 3, "label": "C"}]})
    ids = [f"{i:012x}" for i in range(1, 8)]
    with user_context("alice"):
        for n, tid in enumerate(ids):
            staged = store.new_work_dir("test")
            (staged / "audio.mp3").write_bytes(b"\xff\xfb" + b"\x00" * 100)
            meta = {"id": tid, "title": f"Song {n}", "source": {"type": "file"}, "createdAt": f"2026-10-04T12:00:0{n}Z",
                    "duration": 3.0}
            assert store.install_track(staged, tid, meta, analysis)
    listing = cloud.client.get("/api/tracks", headers=H("alice")).json()
    assert [t["id"] for t in listing] == list(reversed(ids))  # newest first, all of them
    assert cloud.client.get("/api/tracks", headers=H("bob")).json() == []


def test_storage_helpers_need_a_user_in_cloud_mode(cloud: SimpleNamespace) -> None:
    from app.users import NoUserContext

    store = cloud.app.state.store
    with pytest.raises(NoUserContext):  # never a silent fallback to a shared path
        store.track_dir("0123456789ab")
    with user_context("alice"):
        assert store.track_dir("0123456789ab") == cloud.settings.data_dir / "users" / "alice" / "tracks" / "0123456789ab"
        assert store.upload_prefix() == "users/alice/uploads/"
        assert store.media_url("0123456789ab", "stems/vocals").startswith("/api/tracks/0123456789ab/stems/vocals?u=alice&")


# --------------------------------------------------------------------------- admin projections (docs/features/admin, T12)


@pytest.fixture
def admin_cloud(make_cloud) -> SimpleNamespace:
    """A cloud server whose admin database is the in-memory Firestore; ``jobs()`` / ``today()`` read what it holds."""
    db = MemDb()
    env = make_cloud(admin_db=db)
    env.db = db
    env.jobs = lambda: {k.split("/", 1)[1]: v for k, v in db.docs.items() if k.startswith("adminJobs/")}
    env.today = lambda: db.docs.get(f"adminStats/{stats.utc_day(datetime.now(timezone.utc))}")
    return env


def settled(env: SimpleNamespace, expected: int = 1) -> list[dict[str, Any]]:
    """The ``adminJobs`` records once ``expected`` of them exist and none is still running (the finish lands a
    moment after the job reads as done)."""
    deadline = time.monotonic() + 10
    jobs: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        jobs = list(env.jobs().values())
        if len(jobs) >= expected and all(j["status"] != "running" for j in jobs):
            break
        time.sleep(0.02)
    assert len(jobs) == expected and all(j["status"] != "running" for j in jobs), jobs
    return jobs


def upload_with(client: TestClient, path: Path, uid: str, **fields: str) -> Any:
    with open(path, "rb") as fh:
        return client.post("/api/jobs/upload", files={"file": (path.name, fh, "audio/mpeg")}, data=fields or None,
                           headers=H(uid))


@needs_ffmpeg
def test_accepted_job_is_recorded_and_counted_then_settled(admin_cloud: SimpleNamespace, media: SimpleNamespace) -> None:
    env = admin_cloud
    env.engine.gate = threading.Event()
    res = upload_with(env.client, media.a, "alice")
    assert res.status_code == 201, res.text
    job_id = res.json()["id"]
    deadline = time.monotonic() + 10
    while not env.jobs() and time.monotonic() < deadline:  # the accept lands as the worker takes the job on
        time.sleep(0.02)
    rec = env.jobs()[job_id]
    assert (rec["uid"], rec["kind"], rec["origin"], rec["status"], rec["service"]) == ("alice", "analysis", "file", "running", False)
    day = env.today()
    assert day["analyses"]["file"] == 1 and day["active"] == 1 and day["failed"] == 0

    env.engine.gate.set()
    done = wait_job(env.client, job_id, H("alice"))
    assert done["status"] == "done"
    (rec,) = settled(env)
    assert rec["status"] == "done" and rec["trackId"] == done["trackId"] and rec["finishedAt"] is not None
    assert env.today()["failed"] == 0


@needs_ffmpeg
def test_failed_job_records_its_reason_and_counts_a_failure(admin_cloud: SimpleNamespace) -> None:
    env = admin_cloud
    env.fetcher.error = SourceError("download_failed", "The video cannot be fetched")
    res = env.client.post("/api/jobs", json={"url": f"https://youtu.be/{VIDEO_ID}"}, headers=H("alice"))
    assert res.status_code == 201, res.text
    assert wait_job(env.client, res.json()["id"], H("alice"))["status"] == "error"
    (rec,) = settled(env)
    assert (rec["origin"], rec["status"], rec["reason"]) == ("link", "error", "download_failed")
    assert rec["errorText"] == "The video cannot be fetched"
    day = env.today()
    assert day["analyses"]["link"] == 1 and day["failed"] == 1 and day["failedByReason"] == {"download_failed": 1}


@needs_ffmpeg
def test_upload_origin_hint_is_file_or_mic_and_defaults_to_file(admin_cloud: SimpleNamespace, media: SimpleNamespace) -> None:
    env = admin_cloud
    for path, fields in ((media.a, {}), (media.b, {"origin": "mic"}), (media.c, {"origin": "bogus"})):
        res = upload_with(env.client, path, "alice", **fields)
        assert res.status_code == 201, res.text
        wait_job(env.client, res.json()["id"], H("alice"))
    assert sorted(j["origin"] for j in settled(env, 3)) == ["file", "file", "mic"]
    assert env.today()["analyses"] == {"link": 0, "file": 2, "mic": 1, "tab": 0}


@needs_ffmpeg
def test_storage_origin_hint_and_tab_capture(admin_cloud: SimpleNamespace, media: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jobs_module, "youtube_oembed", lambda vid: ("Tab song", "Someone"))
    env = admin_cloud
    bodies = [
        (media.a, {}),                                                                     # absent -> file
        (media.b, {"origin": "mic"}),                                                      # the hint
        (media.c, {"origin": "mic", "source": {"type": "youtube", "videoId": VIDEO_ID}}),  # a tab capture ignores it
    ]
    for i, (audio, body) in enumerate(bodies):
        path = env.gcs.put(f"users/alice/uploads/u{i}/rec.webm", Path(audio).read_bytes())
        res = env.client.post("/api/jobs/storage", json={"path": path, **body}, headers=H("alice"))
        assert res.status_code == 201, res.text
        wait_job(env.client, res.json()["id"], H("alice"))
    assert sorted(j["origin"] for j in settled(env, 3)) == ["file", "mic", "tab"]
    bad = env.gcs.put("users/alice/uploads/u9/rec.webm", b"x" * 10)
    res = env.client.post("/api/jobs/storage", json={"path": bad, "origin": "tab"}, headers=H("alice"))
    assert res.status_code == 422  # only file | mic may be hinted


@needs_ffmpeg
def test_reanalysis_inherits_the_origin_of_its_track(admin_cloud: SimpleNamespace, media: SimpleNamespace) -> None:
    env = admin_cloud
    res = upload_with(env.client, media.a, "alice", origin="mic")
    track_id = wait_job(env.client, res.json()["id"], H("alice"))["trackId"]
    again = env.client.post(f"/api/tracks/{track_id}/reanalyze", headers=H("alice"))
    assert wait_job(env.client, again.json()["id"], H("alice"))["status"] == "done"
    assert [j["origin"] for j in settled(env, 2)] == ["mic", "mic"]


@needs_ffmpeg
def test_projection_failure_does_not_fail_the_job(admin_cloud: SimpleNamespace, media: SimpleNamespace) -> None:
    env = admin_cloud

    def refuse(*_a: Any, **_k: Any) -> Any:
        raise IndexError_("Firestore is down", retryable=True)

    env.db.run_transaction = refuse  # type: ignore[method-assign]
    job, track = upload_and_wait(env, media.a, "alice")
    assert job["status"] == "done" and track["id"] == job["trackId"]
    assert env.jobs() == {}
    pending = history.pending_path(env.settings.data_dir)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:  # the finish is buffered a moment after the job reads as done
        if pending.exists() and '"finish"' in pending.read_text("utf-8"):
            break
        time.sleep(0.02)
    ops = json.loads(pending.read_text("utf-8"))["ops"]
    assert [op["op"] for op in ops] == ["accept", "finish"]


@needs_ffmpeg
def test_jobs_accepted_before_a_restriction_complete_into_the_library(admin_cloud: SimpleNamespace, media: SimpleNamespace) -> None:
    """AC-19: nothing in the lifecycle hooks looks at the restriction an administrator sets after the accept."""
    env = admin_cloud
    env.engine.gate = threading.Event()
    res = upload_with(env.client, media.a, "alice")
    job_id = res.json()["id"]
    env.db.docs["adminAccounts/alice"] = {
        "restriction": {"reason": "abuse", "since": "2026-10-08T00:00:00Z", "byAdminUid": "admin-1"},
        "deletion": None, "personalLimit": None,
    }
    env.engine.gate.set()
    done = wait_job(env.client, job_id, H("alice"))
    assert done["status"] == "done", done
    assert [t["id"] for t in env.client.get("/api/tracks", headers=H("alice")).json()] == [done["trackId"]]


@needs_ffmpeg
def test_late_job_result_for_a_tombstoned_user_is_discarded(admin_cloud: SimpleNamespace, media: SimpleNamespace) -> None:
    """AC-22 / ADR-0011: a job that finishes after the purge began does not bring the song back."""
    env = admin_cloud
    env.engine.gate = threading.Event()
    res = upload_with(env.client, media.a, "alice")
    job_id = res.json()["id"]
    env.db.docs["adminTombstones/alice"] = {
        "status": "purging", "purgeAfter": "2026-10-01T00:00:00Z", "startedAt": "2026-10-08T00:00:00Z", "doneAt": None,
    }
    env.engine.gate.set()
    done = wait_job(env.client, job_id, H("alice"))
    assert done["status"] == "error" and done["trackId"] is None, done
    assert env.client.get("/api/tracks", headers=H("alice")).json() == []
    assert env.index.docs == {} and not list(env.settings.data_dir.glob("users/alice/tracks/*"))
    assert list(env.settings.work_dir.iterdir()) == []


@needs_ffmpeg
def test_a_tombstone_of_one_user_does_not_touch_another(admin_cloud: SimpleNamespace, media: SimpleNamespace) -> None:
    env = admin_cloud
    env.db.docs["adminTombstones/alice"] = {"status": "done"}
    job, _ = upload_and_wait(env, media.a, "bob")
    assert job["status"] == "done"


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


def test_bucket_sweep_glob_for_fragments(cloud: SimpleNamespace) -> None:
    from app.gcs import FETCH_GLOB

    cloud.gcs.put("fetch/0123456789abcdef/source.webm", b"1", age_s=2 * 3600)
    cloud.gcs.put("fetch/fedcba9876543210/source.webm", b"2", age_s=60)
    cloud.gcs.put("users/alice/uploads/u1/a.mp3", b"3", age_s=2 * 3600)
    assert cloud.app.state.bucket.sweep(max_age_s=3600, glob=FETCH_GLOB) == 1
    assert {n for (_, n) in cloud.gcs.objects} == {"fetch/fedcba9876543210/source.webm", "users/alice/uploads/u1/a.mp3"}


def test_the_hourly_sweep_removes_old_uploads_and_fragments(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import app.main as main_module

    def upload_sweeps() -> list[threading.Thread]:
        return [t for t in threading.enumerate() if t.name == "chords-upload-sweep"]

    def left() -> set[str]:
        return {n for (_, n) in gcs.objects}

    gcs = FakeGcs()
    gcs.put("fetch/0123456789abcdef/source.webm", b"1", age_s=2 * 3600)  # a fragment nobody took: over an hour
    gcs.put("fetch/fedcba9876543210/source.webm", b"2", age_s=60)  # a fragment a job is about to take
    gcs.put("users/alice/uploads/u1/a.mp3", b"3", age_s=2 * 3600)  # an upload: kept for a day
    gcs.put("users/alice/uploads/u2/b.mp3", b"4", age_s=2 * 86400)
    monkeypatch.setattr(main_module, "BUCKET_SWEEP_INTERVAL_S", 0.01)
    settings = Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist", auth="firebase",
                        signing_key=SIGNING_KEY, scratch_dir=tmp_path / "scratch", upload_bucket=BUCKET, publish=False)
    app = create_app(settings, analyzer=FakeEngine(), token_verifier=FakeVerifier(), gcs_client_factory=lambda: gcs)
    others = upload_sweeps()  # earlier tests' apps may still have one winding down (a real GCS client times out)
    with TestClient(app):
        wait_for(lambda: left() == {"fetch/fedcba9876543210/source.webm", "users/alice/uploads/u1/a.mp3"})
        gcs.put("fetch/aaaaaaaaaaaaaaaa/source.webm", b"5", age_s=3 * 3600)  # left behind after start-up: the next pass
        wait_for(lambda: "fetch/aaaaaaaaaaaaaaaa/source.webm" not in left())
        assert left() == {"fetch/fedcba9876543210/source.webm", "users/alice/uploads/u1/a.mp3"}
        mine = [t for t in upload_sweeps() if t not in others]
        assert [t.daemon for t in mine] == [True]
    wait_for(lambda: not any(t.is_alive() for t in mine))  # the app's shutdown ends the loop


def test_bucket_upload(cloud: SimpleNamespace, tmp_path: Path) -> None:
    src = tmp_path / "source.webm"
    src.write_bytes(b"abc")
    assert cloud.app.state.bucket.upload("fetch/0123456789abcdef/source.webm", src, content_type="audio/webm") == 3
    obj = cloud.gcs.objects[(BUCKET, "fetch/0123456789abcdef/source.webm")]
    assert obj["data"] == b"abc" and obj["content_type"] == "audio/webm"
    # the name is new: the precondition makes the create idempotent (a retried upload can never overwrite another object)
    assert cloud.gcs.uploads == [{"name": "fetch/0123456789abcdef/source.webm", "if_generation_match": 0}]

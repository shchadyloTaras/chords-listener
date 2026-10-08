"""Admin access gate (docs/features/admin: AC-31, AC-32, AC-34, AC-36; ADR-0006).

Offline and fast: the allowlist is a fake Firestore client, time is a mutable clock, the token check is a fake that
reads the age of the sign-in from the token. The contract tests compare the real app with a reference app that has
no admin router at all, so "the same as an unknown address" is checked byte for byte, not by hand-written constants.
"""
from __future__ import annotations

import base64
import json
import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import pytest
from fastapi import APIRouter, Depends, Request
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from admin.fixtures import MemDb
from app.admin.authz import (
    FRESH_LOGIN_MAX_AGE_S,
    AdminAuthz,
    ProbeLimiter,
    current_admin_uid,
    is_fresh,
    require_fresh_login,
    unguarded_admin_routes,
)
from app.admin.router import new_admin_router
from app.admin.router import router as admin_router
from app.auth import AuthError, FirebaseTokenVerifier, auth_time_of
from app.firestore import Document, IndexError_
from app.main import create_app
from app.models import Settings

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

ENGINE_INFO = {"name": "fake", "version": "1.0", "features": {}}
PROJECT = "build-chords-listener"
SIGNING_KEY = "test-signing-key-0123456789abcdef"
T0 = 1_800_000_000.0


# --------------------------------------------------------------------------- fakes


class Clock:
    def __init__(self, now: float = T0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeDb(MemDb):
    """The shared ``MemDb`` over an ``adminAllowlist`` kept as the mutable set ``admins``; ``fail`` makes ``get`` raise."""

    def __init__(self, *admins: str) -> None:
        super().__init__()
        self.admins = set(admins)
        self.fail = False

    def get(self, path: str) -> Optional[Document]:
        if self.fail:
            self.gets.append(path)
            raise IndexError_("down", retryable=True)
        collection, _, uid = path.partition("/")
        assert collection == "adminAllowlist", path
        self.docs.pop(path, None)
        if uid in self.admins:
            self.docs[path] = {"grantedAt": "2026-10-01T00:00:00Z"}
        return super().get(path)


class FakeVerifier:
    """``tok-<uid>`` is a sign-in just now, ``tok-<uid>:<seconds>`` one that many seconds ago."""

    def __init__(self, clock: Clock, *, with_auth_time: bool = True) -> None:
        self.clock = clock
        self.with_auth_time = with_auth_time

    def verify_claims(self, token: str) -> tuple[str, Optional[float]]:
        if not token.startswith("tok-") or len(token) <= 4:
            raise AuthError("Invalid token")
        uid, _, age = token[4:].partition(":")
        return uid, (self.clock() - float(age or 0)) if self.with_auth_time else None

    def verify(self, token: str) -> str:
        return self.verify_claims(token)[0]


def H(uid: str, age_s: Optional[float] = None) -> dict[str, str]:
    return {"Authorization": f"Bearer tok-{uid}" + (f":{age_s}" if age_s is not None else "")}


def build_router(calls: list[str]) -> APIRouter:
    """A router like the later tasks will write: reads, a body, path and query parameters, a fresh-login action."""
    router = new_admin_router()

    @router.get("/ping")
    def ping() -> dict[str, Any]:
        calls.append("ping")
        return {"ok": True}

    @router.get("/users/{uid}")
    def user_card(uid: str, limit: int = 50) -> dict[str, Any]:
        calls.append(f"card:{uid}")
        return {"uid": uid, "limit": limit}

    @router.post("/users/{uid}/limit")
    def set_limit(uid: str, body: dict[str, int]) -> dict[str, Any]:
        calls.append(f"limit:{uid}")
        return {"uid": uid, **body}

    @router.post("/users/{uid}/deletion", dependencies=[Depends(require_fresh_login)])
    def schedule_deletion(uid: str) -> dict[str, Any]:
        calls.append(f"deletion:{uid}")
        return {"scheduled": uid}

    @router.get("/whoami")
    def whoami(request: Request) -> dict[str, Any]:
        calls.append("whoami")
        return {"uid": current_admin_uid(request)}

    @router.get("/auth-time")
    def auth_time(request: Request) -> dict[str, Any]:
        calls.append("auth-time")
        return {"auth_time": auth_time_of(request)}

    return router


def settings_for(tmp_path: Path, *, cloud: bool = True) -> Settings:
    return Settings(
        data_dir=tmp_path / "data",
        frontend_dist=tmp_path / "no-dist",
        auth="firebase" if cloud else "off",
        signing_key=SIGNING_KEY,
        publish=False,
        allowed_hosts=("testserver", "localhost"),
    )


def never(*_: Any, **__: Any) -> dict:
    raise AssertionError("the engine must not run in these tests")


@pytest.fixture
def env(tmp_path: Path):
    clients: list[TestClient] = []

    def factory(*admins: str, cloud: bool = True, with_auth_time: bool = True) -> SimpleNamespace:
        clock, db, calls = Clock(), FakeDb(*admins), []
        authz = AdminAuthz(db, clock=clock)

        def make(admin_router: APIRouter) -> TestClient:
            app = create_app(
                settings_for(tmp_path, cloud=cloud),
                analyzer=never,
                engine_info_fn=lambda: ENGINE_INFO,
                token_verifier=FakeVerifier(clock, with_auth_time=with_auth_time),
                admin_router=admin_router,
                admin_authz=authz,
            )
            client = TestClient(app)
            client.__enter__()
            clients.append(client)
            return client

        router = build_router(calls)
        client = make(router)
        reference = make(APIRouter(prefix="/api/admin"))  # no admin routes: /api/admin/* is an unknown address
        return SimpleNamespace(
            client=client, reference=reference, router=router, clock=clock, db=db, calls=calls, authz=authz
        )

    yield factory
    for c in clients:
        c.__exit__(None, None, None)


def admin_routes(router: APIRouter) -> list[APIRoute]:
    return [r for r in router.routes if isinstance(r, APIRoute) and r.path.startswith("/api/admin")]


def concrete(path: str) -> str:
    return path.replace("{uid}", "victim-1")


def same_response(a: Any, b: Any) -> None:
    assert (a.status_code, a.content) == (b.status_code, b.content)
    assert dict(a.headers) == dict(b.headers)


# --------------------------------------------------------------------------- AC-31: a non-admin sees "not found"


def test_every_admin_route_answers_a_non_admin_exactly_like_an_unknown_route(env: Any) -> None:
    e = env("boss")
    routes = admin_routes(e.router)
    assert len(routes) >= 5, "the probe router should expose several routes"
    for route in routes:
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            url = concrete(route.path)
            variants: list[dict[str, Any]] = [
                {},
                {"json": {"x": 1}},
                {"content": b"{not json", "headers": {"content-type": "application/json"}},
                {"params": {"limit": "not-a-number"}},
            ]
            for kwargs in variants:
                kwargs = {**kwargs, "headers": {**H("mallory"), **kwargs.get("headers", {})}}
                got = e.client.request(method, url, **kwargs)
                want = e.reference.request(method, url, **kwargs)
                assert want.status_code == 404 and want.json()["code"] == "not_found"
                same_response(got, want)
    assert e.calls == [], "a handler ran for a non-admin"


def test_non_admin_response_names_nothing_about_the_admin_area(env: Any) -> None:
    e = env("boss")
    res = e.client.post("/api/admin/users/victim-1/deletion", headers=H("mallory"))
    assert res.status_code == 404
    assert set(res.json()) == {"detail", "code"}
    assert res.json()["code"] == "not_found"


def test_an_unauthenticated_request_is_refused_like_for_any_other_api_route(env: Any) -> None:
    e = env("boss")
    for route in admin_routes(e.router):
        method = sorted(route.methods - {"HEAD", "OPTIONS"})[0]
        same_response(e.client.request(method, concrete(route.path)), e.reference.request(method, concrete(route.path)))
    assert e.client.get("/api/admin/ping").status_code == 401


def test_local_mode_has_no_admin_area_for_anyone(env: Any) -> None:
    e = env("boss", cloud=False)
    res = e.client.get("/api/admin/ping")
    assert res.status_code == 404
    same_response(res, e.reference.get("/api/admin/ping"))
    assert e.calls == []


def test_an_admin_reaches_the_handlers(env: Any) -> None:
    e = env("boss")
    assert e.client.get("/api/admin/ping", headers=H("boss")).json() == {"ok": True}
    assert e.client.get("/api/admin/users/u9?limit=3", headers=H("boss")).json() == {"uid": "u9", "limit": 3}
    assert e.client.post("/api/admin/users/u9/limit", json={"analyses": 5}, headers=H("boss")).json() == {
        "uid": "u9",
        "analyses": 5,
    }
    assert e.client.get("/api/admin/whoami", headers=H("boss")).json() == {"uid": "boss"}


def test_a_route_without_the_guard_is_found_and_refused_at_start_up(tmp_path: Path) -> None:
    plain = APIRouter(prefix="/api/admin")

    @plain.get("/leak")
    def leak() -> dict[str, bool]:
        return {"leaked": True}

    def build(router: APIRouter) -> Any:
        return create_app(
            settings_for(tmp_path),
            analyzer=never,
            engine_info_fn=lambda: ENGINE_INFO,
            token_verifier=FakeVerifier(Clock()),
            admin_router=router,
            admin_authz=AdminAuthz(FakeDb()),
        )

    with pytest.raises(RuntimeError, match="/api/admin/leak"):
        build(plain)

    guarded = new_admin_router()

    @guarded.get("/ok")
    def ok() -> dict[str, bool]:
        return {"ok": True}

    build(guarded)  # the start-up accepts it
    assert unguarded_admin_routes(guarded) == []
    assert unguarded_admin_routes(plain) == ["GET /api/admin/leak"]


def test_the_routes_the_project_ships_are_all_guarded(tmp_path: Path) -> None:
    shipped = create_app(
        settings_for(tmp_path), analyzer=never, engine_info_fn=lambda: ENGINE_INFO, token_verifier=FakeVerifier(Clock())
    )
    assert unguarded_admin_routes(admin_router) == []
    assert shipped.state.admin_authz is not None


def test_the_admin_routes_are_not_in_the_public_openapi_document(env: Any) -> None:
    e = env("boss")
    spec = e.client.get("/api/openapi.json").json()  # served without sign-in
    assert not [p for p in spec["paths"] if "admin" in p]
    assert "admin" not in e.client.get("/api/openapi.json").text.lower()


# --------------------------------------------------------------------------- AC-32: revoking takes effect within 60 s


def test_allowlist_is_read_at_most_once_a_minute_per_user(env: Any) -> None:
    e = env("boss")
    for _ in range(5):
        assert e.client.get("/api/admin/ping", headers=H("boss")).status_code == 200
        e.clock.advance(10)
    assert e.db.gets == ["adminAllowlist/boss"]
    e.clock.advance(10)  # 60 s after the first read
    assert e.client.get("/api/admin/ping", headers=H("boss")).status_code == 200
    assert e.db.gets == ["adminAllowlist/boss"] * 2


def test_revoked_admin_is_refused_within_a_minute(env: Any) -> None:
    e = env("boss")
    assert e.client.get("/api/admin/ping", headers=H("boss")).status_code == 200  # cached as admin at T0
    e.clock.advance(5)
    e.db.admins.discard("boss")  # the owner's script removes the mark at T0+5
    removed_at = e.clock()
    denied_after: Optional[float] = None
    for _ in range(61):  # a check every second, like the e2e test
        res = e.client.get("/api/admin/ping", headers=H("boss"))
        if res.status_code == 404:
            denied_after = e.clock() - removed_at
            same_response(res, e.reference.get("/api/admin/ping", headers=H("boss")))
            break
        e.clock.advance(1)
    assert denied_after is not None and denied_after <= 60
    # and it stays denied for every kind of call
    assert e.client.post("/api/admin/users/u1/limit", json={"a": 1}, headers=H("boss")).status_code == 404
    assert e.client.get("/api/admin/users/u1", headers=H("boss")).status_code == 404


def test_a_new_admin_is_let_in_within_a_minute(env: Any) -> None:
    e = env()
    assert e.client.get("/api/admin/ping", headers=H("newbie")).status_code == 404
    e.db.admins.add("newbie")
    e.clock.advance(60)
    assert e.client.get("/api/admin/ping", headers=H("newbie")).status_code == 200


def test_an_unreachable_allowlist_denies_like_an_unknown_address(env: Any) -> None:
    e = env("boss")
    e.db.fail = True
    res = e.client.get("/api/admin/ping", headers=H("boss"))
    same_response(res, e.reference.get("/api/admin/ping", headers=H("boss")))
    assert e.calls == []
    e.db.fail = False  # the failure was not cached as a verdict
    assert e.client.get("/api/admin/ping", headers=H("boss")).status_code == 200


def test_authz_unit_cache_expiry_and_unknown_user() -> None:
    clock, db = Clock(), FakeDb("a")
    authz = AdminAuthz(db, clock=clock)
    assert authz.is_admin("a") and not authz.is_admin("b") and not authz.is_admin(None)
    db.admins.clear()
    clock.advance(59.9)
    assert authz.is_admin("a")  # still the cached verdict
    clock.advance(0.2)
    assert not authz.is_admin("a")
    assert AdminAuthz(None, clock=clock).is_admin("a") is False  # local mode: there is no allowlist


# --------------------------------------------------------------------------- AC-36: probe limit for non-admins


def test_non_admin_probe_limit_is_30_per_rolling_60_seconds() -> None:
    clock = Clock()
    limiter = ProbeLimiter(clock=clock)
    assert [limiter.hit("u") for _ in range(30)] == [True] * 30
    assert limiter.hit("u") is False  # the 31st
    assert limiter.hit("u") is False
    assert limiter.hit("other") is True  # the limit is per account
    clock.advance(59)
    assert limiter.hit("u") is False
    clock.advance(1.01)  # the first 30 left the window
    assert limiter.hit("u") is True


def test_probe_limiter_window_slides() -> None:
    clock = Clock()
    limiter = ProbeLimiter(clock=clock)
    for _ in range(30):  # one request a second: T0 .. T0+29
        assert limiter.hit("u")
        clock.advance(1)
    clock.advance(30.5)  # T0+60.5: the request of T0 is out of the window, 29 are in
    assert limiter.hit("u") is True  # takes the freed slot
    assert limiter.hit("u") is False  # the window is full again


def test_over_limit_non_admin_is_refused_identically_and_keeps_normal_features(env: Any) -> None:
    e = env("boss")
    first = e.client.get("/api/admin/ping", headers=H("mallory"))
    refused = [e.client.get("/api/admin/ping", headers=H("mallory")) for _ in range(40)]
    for res in refused:
        same_response(res, first)  # the 31st and later look exactly like the first
    same_response(first, e.reference.get("/api/admin/ping", headers=H("mallory")))
    assert e.calls == []
    # the library and the identity of the same user work as always
    assert e.client.get("/api/tracks", headers=H("mallory")).status_code == 200
    assert e.client.get("/api/me", headers=H("mallory")).status_code == 200
    # a minute later the counter has started over
    e.clock.advance(61)
    assert e.authz.limiter.hit("mallory") is True


def test_the_limit_does_not_apply_to_admins(env: Any) -> None:
    e = env("boss")
    for _ in range(100):
        assert e.client.get("/api/admin/ping", headers=H("boss")).status_code == 200
    assert len(e.calls) == 100


def test_requests_to_every_admin_route_count_towards_the_limit(env: Any) -> None:
    e = env()
    for i in range(30):
        e.client.get(f"/api/admin/users/u{i}", headers=H("mallory"))  # reads
    # the writes are counted in the same window: the 31st request is over the limit whatever it is
    assert e.client.post("/api/admin/users/u1/limit", json={"a": 1}, headers=H("mallory")).status_code == 404
    assert e.authz.limiter.hit("mallory") is False


def test_a_granted_admin_is_not_held_back_by_earlier_probing(env: Any) -> None:
    e = env()
    for _ in range(35):
        e.client.get("/api/admin/ping", headers=H("flip"))
    e.db.admins.add("flip")
    e.clock.advance(60)  # the allowlist cache has expired
    assert e.client.get("/api/admin/ping", headers=H("flip")).status_code == 200


# --------------------------------------------------------------------------- AC-34: fresh login


def test_fresh_login_rule_is_15_minutes() -> None:
    assert FRESH_LOGIN_MAX_AGE_S == 15 * 60
    assert is_fresh(T0 - (14 * 60 + 59), T0) is True
    assert is_fresh(T0 - (15 * 60), T0) is True
    assert is_fresh(T0 - (15 * 60 + 1), T0) is False
    assert is_fresh(None, T0) is False  # no auth_time: can't prove a recent sign-in


def test_stale_login_blocks_a_fresh_login_route_until_reauth(env: Any) -> None:
    e = env("boss")
    url = "/api/admin/users/u1/deletion"
    stale = e.client.post(url, headers=H("boss", age_s=15 * 60 + 1))
    assert stale.status_code == 401
    assert stale.json() == {"detail": "Sign in again to confirm this action", "code": "reauth_required"}
    assert "deletion:u1" not in e.calls
    ok = e.client.post(url, headers=H("boss", age_s=14 * 60 + 59))
    assert ok.status_code == 200 and ok.json() == {"scheduled": "u1"}
    assert e.calls.count("deletion:u1") == 1
    assert e.client.post(url, headers=H("boss")).status_code == 200  # a re-authenticated token works right away


def test_a_sign_in_without_auth_time_is_not_fresh(env: Any) -> None:
    e = env("boss", with_auth_time=False)
    res = e.client.post("/api/admin/users/u1/deletion", headers=H("boss"))
    assert res.status_code == 401 and res.json()["code"] == "reauth_required"
    assert e.calls == []


def test_reads_do_not_need_a_fresh_login(env: Any) -> None:
    e = env("boss")
    assert e.client.get("/api/admin/ping", headers=H("boss", age_s=3 * 3600)).status_code == 200


def test_a_non_admin_with_a_stale_login_still_only_sees_not_found(env: Any) -> None:
    e = env("boss")
    headers = H("mallory", age_s=3 * 3600)
    same_response(
        e.client.post("/api/admin/users/u1/deletion", headers=headers),
        e.reference.post("/api/admin/users/u1/deletion", headers=headers),
    )


# --------------------------------------------------------------------------- the token check hands out auth_time


def _emulator_token(claims: dict[str, Any]) -> str:
    def seg(obj: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")

    return f"{seg({'alg': 'none', 'typ': 'JWT'})}.{seg(claims)}."


def test_verifier_exposes_auth_time() -> None:
    verifier = FirebaseTokenVerifier(PROJECT, emulator=True, clock=lambda: T0)
    claims = {"aud": PROJECT, "iss": f"https://securetoken.google.com/{PROJECT}", "sub": "boss",
              "iat": T0 - 10, "exp": T0 + 3600, "auth_time": T0 - 20}
    token = _emulator_token(claims)
    assert verifier.verify_claims(token) == ("boss", T0 - 20)
    assert verifier.verify(token) == "boss"
    claims.pop("auth_time")
    assert verifier.verify_claims(_emulator_token(claims)) == ("boss", None)


def test_auth_time_reaches_the_handler_through_the_middleware(env: Any) -> None:
    e = env("boss")
    res = e.client.get("/api/admin/auth-time", headers=H("boss", age_s=100))
    assert res.json() == {"auth_time": T0 - 100}


# --------------------------------------------------------------------------- logging


def test_admin_requests_are_logged_with_route_status_and_duration(env: Any, caplog: pytest.LogCaptureFixture) -> None:
    e = env("boss")
    with caplog.at_level(logging.INFO, logger="chords.admin"):
        e.client.get("/api/admin/users/secret-looking-id", headers=H("boss"))
        e.client.post("/api/admin/users/u1/deletion", headers=H("boss", age_s=9999))
        e.client.get("/api/admin/ping", headers=H("mallory"))
    lines = [r.getMessage() for r in caplog.records if r.name == "chords.admin"]
    assert any(
        l.startswith("admin_request") and "route=/api/admin/users/{uid}" in l and "status=200" in l
        and "duration_ms=" in l and "uid=boss" in l
        for l in lines
    ), lines
    assert any("status=401" in l and "route=/api/admin/users/{uid}/deletion" in l for l in lines), lines
    assert not any("secret-looking-id" in l for l in lines), "the log carries the route template, not the ids"
    assert not any("mallory" in l for l in lines), "a refused account is not an admin request"

"""Cloud-mode authentication (docs/CLOUD.md → Auth, Media URLs).

* ``FirebaseTokenVerifier`` checks Firebase ID tokens (RS256, Google's public certs cached per
  their Cache-Control) for one project. With ``FIREBASE_AUTH_EMULATOR_HOST`` set it also accepts
  the Auth emulator's unsigned tokens (claims are still checked).
* ``MediaSigner`` signs media URLs (``?u=<uid>&exp=<unix>&sig=<hmac>``) so ``<audio>`` elements can
  load them without an Authorization header.
* ``AuthMiddleware`` guards ``/api/*``: Bearer token, signed media URL or ``X-Smoke-Key``;
  sets the request's uid (``app.users``) and its sign-in time (``auth_time_of``).
  Missing/invalid credentials → 401 ``unauthorized``.
* ``SchedulerTokenVerifier`` checks the Google OIDC token Cloud Scheduler sends to ``POST /api/internal/sweep``
  (issuer, audience, the scheduler's service-account email). ``AuthMiddleware`` lets only that token reach the
  path; anyone else gets the 404 an unknown address gets (docs/features/admin T24).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
import urllib.request
from typing import Any, Callable, Optional
from urllib.parse import parse_qs, quote

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .users import SMOKE_UID, reset_current_uid, set_current_uid, valid_uid

log = logging.getLogger("chords.auth")

GOOGLE_CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"
AUTH_TIME_KEY = "auth_time"  # request.scope["state"] key set by AuthMiddleware
CertsFetcher = Callable[[], tuple[dict[str, str], float]]  # -> ({kid: PEM}, max-age seconds)


class AuthError(Exception):
    """The credentials are missing or invalid (401)."""


class AuthUnavailable(Exception):
    """Tokens can't be checked right now, e.g. Google's certificates are unreachable (503)."""


# --------------------------------------------------------------------------- Firebase ID tokens


def _b64json(segment: str) -> dict[str, Any]:
    padded = segment + "=" * (-len(segment) % 4)
    value = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    if not isinstance(value, dict):
        raise ValueError("not a JSON object")
    return value


def fetch_google_certs(url: str = GOOGLE_CERTS_URL, timeout: float = 10.0) -> tuple[dict[str, str], float]:
    with urllib.request.urlopen(url, timeout=timeout) as res:  # noqa: S310 - fixed https URL
        certs = json.loads(res.read().decode("utf-8"))
        cache_control = res.headers.get("Cache-Control", "")
    match = re.search(r"max-age=(\d+)", cache_control)
    if not isinstance(certs, dict) or not certs:
        raise ValueError("unexpected certificate document")
    return {str(k): str(v) for k, v in certs.items()}, float(match.group(1)) if match else 3600.0


class _CertCache:
    """Google's public certificates, refetched per their Cache-Control (clamped to 1 min .. 6 h); a failed refresh
    keeps serving the previous ones for another minute, a failed first fetch is ``AuthUnavailable``."""

    def __init__(self, fetch: CertsFetcher, clock: Callable[[], float]) -> None:
        self._fetch = fetch
        self._clock = clock
        self._lock = threading.Lock()
        self._certs: dict[str, str] = {}
        self._expiry = 0.0

    def current(self) -> dict[str, str]:
        with self._lock:
            now = self._clock()
            if self._certs and now < self._expiry:
                return self._certs
            try:
                certs, max_age = self._fetch()
            except Exception as exc:
                if self._certs:  # stale-if-error: keep serving with the previous certificates
                    log.warning("refreshing Google certificates failed (%s); using cached ones", exc)
                    self._expiry = now + 60
                    return self._certs
                raise AuthUnavailable("Sign-in can't be verified right now") from exc
            self._certs = certs
            self._expiry = now + min(max(max_age, 60.0), 6 * 3600.0)
            return certs


class FirebaseTokenVerifier:
    """Verifies Firebase Auth ID tokens for ``project_id`` and returns the uid (``sub``)."""

    def __init__(
        self,
        project_id: str,
        *,
        emulator: Optional[bool] = None,
        fetch_certs: Optional[CertsFetcher] = None,
        clock: Callable[[], float] = time.time,
        leeway_s: float = 60.0,
    ) -> None:
        self.project_id = project_id
        self.issuer = f"https://securetoken.google.com/{project_id}"
        self.emulator = bool(os.environ.get("FIREBASE_AUTH_EMULATOR_HOST")) if emulator is None else emulator
        self._clock = clock
        self._leeway = leeway_s
        self._cache = _CertCache(fetch_certs or fetch_google_certs, clock)
        if self.emulator:
            log.warning("FIREBASE_AUTH_EMULATOR_HOST is set: unsigned Auth-emulator tokens are accepted")

    def _current_certs(self) -> dict[str, str]:
        return self._cache.current()

    def verify(self, token: str) -> str:
        return self.verify_claims(token)[0]

    def verify_claims(self, token: str) -> tuple[str, Optional[float]]:
        """``(uid, auth_time)``: ``auth_time`` is when the user last typed their credentials (Unix seconds),
        None when the token carries none."""
        token = (token or "").strip()
        parts = token.split(".")
        if len(parts) != 3 or not parts[0] or not parts[1]:
            raise AuthError("Malformed token")
        try:
            header = _b64json(parts[0])
        except ValueError as exc:
            raise AuthError("Malformed token") from exc
        alg = header.get("alg")
        if alg == "none" and self.emulator:
            try:
                claims = _b64json(parts[1])
            except ValueError as exc:
                raise AuthError("Malformed token") from exc
            self._check_times(claims)
        elif alg == "RS256" and header.get("kid"):
            from google.auth import exceptions as gexc
            from google.auth import jwt

            try:
                claims = jwt.decode(
                    token, certs=self._current_certs(), audience=self.project_id, clock_skew_in_seconds=int(self._leeway)
                )
            except (ValueError, gexc.GoogleAuthError) as exc:
                raise AuthError(f"Invalid token: {exc}") from exc
        else:
            raise AuthError("Unsupported token")
        uid = self._check_claims(claims)
        auth_time = claims.get("auth_time")
        return uid, float(auth_time) if isinstance(auth_time, (int, float)) and not isinstance(auth_time, bool) else None

    def _check_times(self, claims: dict[str, Any]) -> None:
        now = self._clock()
        exp, iat = claims.get("exp"), claims.get("iat")
        if not isinstance(exp, (int, float)) or exp + self._leeway < now:
            raise AuthError("Token expired")
        if not isinstance(iat, (int, float)) or iat - self._leeway > now:
            raise AuthError("Token issued in the future")

    def _check_claims(self, claims: dict[str, Any]) -> str:
        if claims.get("aud") != self.project_id:
            raise AuthError("Token is for another project")
        if claims.get("iss") != self.issuer:
            raise AuthError("Token has the wrong issuer")
        auth_time = claims.get("auth_time")
        if isinstance(auth_time, (int, float)) and auth_time - self._leeway > self._clock():
            raise AuthError("Token auth_time is in the future")
        uid = claims.get("sub")
        if not isinstance(uid, str) or not valid_uid(uid):
            raise AuthError("Token has no usable subject")
        return uid


GOOGLE_OIDC_CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs"  # PEM certificates by kid (OIDC id tokens)
GOOGLE_OIDC_ISSUERS = ("https://accounts.google.com", "accounts.google.com")
SWEEP_PATH = "/api/internal/sweep"
SCHEDULER_KEY = "scheduler"  # request.scope["state"] key set by AuthMiddleware for a verified scheduler call


def fetch_google_oidc_certs() -> tuple[dict[str, str], float]:
    return fetch_google_certs(GOOGLE_OIDC_CERTS_URL)


class SchedulerTokenVerifier:
    """Verifies the Google OIDC ID token Cloud Scheduler sends with ``POST /api/internal/sweep``: Google's
    signature, the issuer, the audience (this service's URL), a verified email equal to the scheduler's
    service account (``chords-scheduler@...``) and the usual time claims. ``verify`` returns that email.
    With no audience or no email configured nothing is accepted."""

    def __init__(
        self,
        audience: str,
        email: str,
        *,
        fetch_certs: Optional[CertsFetcher] = None,
        clock: Callable[[], float] = time.time,
        leeway_s: float = 60.0,
    ) -> None:
        self.audience = audience.strip()
        self.email = email.strip().lower()
        self._leeway = leeway_s
        self._cache = _CertCache(fetch_certs or fetch_google_oidc_certs, clock)

    def verify(self, token: str) -> str:
        if not self.audience or not self.email:
            raise AuthError("The scheduler is not configured")
        token = (token or "").strip()
        parts = token.split(".")
        if len(parts) != 3 or not parts[0] or not parts[1]:
            raise AuthError("Malformed token")
        from google.auth import exceptions as gexc
        from google.auth import jwt

        try:
            claims = jwt.decode(
                token, certs=self._cache.current(), audience=self.audience, clock_skew_in_seconds=int(self._leeway)
            )
        except (ValueError, gexc.GoogleAuthError) as exc:
            raise AuthError(f"Invalid token: {exc}") from exc
        if claims.get("iss") not in GOOGLE_OIDC_ISSUERS:
            raise AuthError("Token has the wrong issuer")
        email = claims.get("email")
        if claims.get("email_verified") is not True or not isinstance(email, str) or email.lower() != self.email:
            raise AuthError("Token is not from the scheduler account")
        return self.email


def auth_time_of(request: Request) -> Optional[float]:
    """When the signed-in user last entered their credentials (the ID token's ``auth_time``, Unix seconds);
    None for a signed media URL, the smoke key, a verifier that doesn't report it, or outside ``AuthMiddleware``."""
    value = request.scope.get("state", {}).get(AUTH_TIME_KEY)
    return float(value) if isinstance(value, (int, float)) else None


# --------------------------------------------------------------------------- signed media URLs


class MediaSigner:
    """HMAC-SHA256 over (uid, path, exp). URLs stay valid for ``ttl_s``..``ttl_s + step_s`` and are
    identical within one ``step_s`` window, so browsers can cache the media."""

    def __init__(self, key: bytes | str, ttl_s: int = 12 * 3600, step_s: int = 3600) -> None:
        self._key = key.encode("utf-8") if isinstance(key, str) else key
        if len(self._key) < 16:
            raise ValueError("the signing key must be at least 16 bytes")
        self.ttl_s = ttl_s
        self.step_s = step_s

    @classmethod
    def random(cls, **kw: Any) -> MediaSigner:
        return cls(secrets.token_bytes(32), **kw)

    def _mac(self, uid: str, path: str, exp: int) -> str:
        msg = f"v1\n{uid}\n{path}\n{exp}".encode("utf-8")
        digest = hmac.new(self._key, msg, hashlib.sha256).digest()
        return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")

    def expiry(self, now: Optional[float] = None) -> int:
        now = time.time() if now is None else now
        return (int(now) // self.step_s + 1) * self.step_s + self.ttl_s

    def sign(self, uid: str, path: str, now: Optional[float] = None) -> str:
        """``path`` + the signature query (``path`` is an absolute URL path without a query)."""
        exp = self.expiry(now)
        return f"{path}?u={quote(uid, safe='')}&exp={exp}&sig={self._mac(uid, path, exp)}"

    def verify(self, uid: str, path: str, exp: str, sig: str, now: Optional[float] = None) -> bool:
        now = time.time() if now is None else now
        if not (valid_uid(uid) and exp.isdigit() and sig and len(sig) <= 64):
            return False
        exp_i = int(exp)
        if exp_i < now or exp_i > now + self.ttl_s + self.step_s + 300:
            return False
        return hmac.compare_digest(self._mac(uid, path, exp_i), sig)


# --------------------------------------------------------------------------- middleware

# Media that <audio> elements load directly (no headers): the track audio and separated stems.
MEDIA_PATH_RE = re.compile(r"^/api/tracks/[0-9a-f]{6,64}/(?:audio|stems/[A-Za-z0-9_-]{1,32})$")
PUBLIC_PATHS = frozenset({"/api/health", "/api/openapi.json"})
PUBLIC_PREFIXES = ("/api/docs",)


def unknown_endpoint_response(path: str) -> JSONResponse:
    """The answer for an address no route serves (what ``main.py`` gives an unknown ``/api/...`` path)."""
    return JSONResponse({"detail": f"Unknown API endpoint: {path}", "code": "not_found"}, status_code=404)


def _unauthorized(detail: str) -> JSONResponse:
    return JSONResponse(
        {"detail": detail, "code": "unauthorized"}, status_code=401, headers={"WWW-Authenticate": "Bearer"}
    )


class AuthMiddleware:
    """Authenticates ``/api/*`` (except health and docs) and runs the request as that user."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        verifier: Any,
        signer: Optional[MediaSigner],
        smoke_key: str = "",
        scheduler_verifier: Any = None,
    ) -> None:
        self.app = app
        self.verifier = verifier
        self.signer = signer
        self.scheduler_verifier = scheduler_verifier
        self.smoke_key = smoke_key.encode("utf-8") if len(smoke_key) >= 16 else b""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if (
            scope["type"] != "http"
            or not (path == "/api" or path.startswith("/api/"))
            or path in PUBLIC_PATHS
            or path.startswith(PUBLIC_PREFIXES)
            or scope.get("method") == "OPTIONS"
        ):
            await self.app(scope, receive, send)
            return
        if path == SWEEP_PATH:
            await self._scheduler_call(scope, receive, send, path)
            return
        try:
            uid, auth_time = await self._authenticate(scope, path)
        except AuthError as exc:
            await _unauthorized(str(exc) or "Sign in to use the cloud server")(scope, receive, send)
            return
        except AuthUnavailable as exc:
            await JSONResponse({"detail": str(exc), "code": "internal"}, status_code=503)(scope, receive, send)
            return
        scope.setdefault("state", {})[AUTH_TIME_KEY] = auth_time
        token = set_current_uid(uid)
        try:
            await self.app(scope, receive, send)
        finally:
            reset_current_uid(token)

    async def _scheduler_call(self, scope: Scope, receive: Receive, send: Send, path: str) -> None:
        """``/api/internal/sweep`` takes the scheduler's OIDC token and nothing else: every other caller (a user, an
        admin, a bad or missing token) is answered as for an unknown address. The request runs without a user."""
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        scheme, _, token = headers.get("authorization", "").partition(" ")
        verified = False
        if self.scheduler_verifier is not None and scheme.lower() == "bearer" and token.strip():
            try:
                await run_in_threadpool(self.scheduler_verifier.verify, token.strip())
                verified = True
            except AuthError:
                pass
            except AuthUnavailable as exc:  # Google's certificates are unreachable: let the scheduler retry
                await JSONResponse({"detail": str(exc), "code": "internal"}, status_code=503)(scope, receive, send)
                return
        if not verified:
            await unknown_endpoint_response(path)(scope, receive, send)
            return
        scope.setdefault("state", {})[SCHEDULER_KEY] = True
        await self.app(scope, receive, send)

    async def _authenticate(self, scope: Scope, path: str) -> tuple[str, Optional[float]]:
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        if scope.get("method") in ("GET", "HEAD") and self.signer is not None and MEDIA_PATH_RE.fullmatch(path):
            query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
            if "sig" in query:
                uid, exp, sig = (query.get(k, [""])[0] for k in ("u", "exp", "sig"))
                if self.signer.verify(uid, path, exp, sig):
                    return uid, None
                raise AuthError("This media link has expired or is invalid - reload the track")
        authorization = headers.get("authorization", "")
        if authorization:
            scheme, _, token = authorization.partition(" ")
            if scheme.lower() != "bearer" or not token.strip():
                raise AuthError("Use an Authorization: Bearer <Firebase ID token> header")
            verify_claims = getattr(self.verifier, "verify_claims", None)
            if verify_claims is not None:
                return await run_in_threadpool(verify_claims, token.strip())
            return await run_in_threadpool(self.verifier.verify, token.strip()), None
        smoke = headers.get("x-smoke-key", "")
        if smoke:
            if self.smoke_key and hmac.compare_digest(smoke.encode("utf-8"), self.smoke_key):
                return SMOKE_UID, None
            raise AuthError("Invalid smoke-test key")
        raise AuthError("Sign in to use the cloud server")


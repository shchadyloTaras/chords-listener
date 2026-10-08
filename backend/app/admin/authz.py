"""Who may use ``/api/admin/*`` (docs/features/admin: AC-31, AC-32, AC-34, AC-36; ADR-0006).

* ``AdminAuthz`` - the allowlist ``adminAllowlist/{uid}`` (written only by the owner's script), read with a
  60 s cache, so a revoked admin is refused within a minute. An unreachable allowlist means "not an admin".
* ``ProbeLimiter`` - a non-admin's 31st request in 60 s is refused (in process memory: one instance serves).
* ``AdminRoute`` - the route class of every admin route. It runs the check *before* the request body or
  parameters are read, so a non-admin can't tell a real route from a missing one by sending bad input; the
  answer is the one an unknown ``/api/...`` address gets (``HiddenFromCaller``, rendered by ``main.py``).
* ``require_fresh_login`` - a dependency for the destructive actions: the ID token's ``auth_time`` must be
  at most 15 minutes old, otherwise ``reauth_required`` (the admin UI re-authenticates and retries).
* ``admin_request`` log line (route template, status, duration; uids only) for every admin request.
"""
from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Any, Awaitable, Callable, Optional

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from starlette.concurrency import run_in_threadpool
from starlette.responses import Response

from ..auth import auth_time_of
from ..users import current_uid

log = logging.getLogger("chords.admin")

ALLOWLIST_PATH = "adminAllowlist/{uid}"
ALLOWLIST_TTL_S = 60.0
PROBE_LIMIT = 30  # non-admin requests to /api/admin/* ...
PROBE_WINDOW_S = 60.0  # ... per rolling window
FRESH_LOGIN_MAX_AGE_S = 15 * 60
ADMIN_PREFIX = "/api/admin"

_MAX_TRACKED = 4096  # accounts remembered by the cache / limiter before stale entries are dropped
Clock = Callable[[], float]


class HiddenFromCaller(Exception):
    """The caller isn't an admin: answer exactly as for an unknown address (404 ``not_found``)."""

    def __init__(self, path: str) -> None:
        super().__init__(path)
        self.path = path


class ReauthRequired(Exception):
    """The admin's sign-in is older than 15 minutes (401 ``reauth_required``)."""

    status = 401


class ProbeLimiter:
    """At most ``limit`` requests per ``window_s`` per account; the refused ones count as requests too."""

    def __init__(self, *, limit: int = PROBE_LIMIT, window_s: float = PROBE_WINDOW_S, clock: Clock = time.time) -> None:
        self._limit, self._window, self._clock = limit, window_s, clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def hit(self, uid: str) -> bool:
        """Record a request of ``uid``; False when it is over the limit (it must not be processed)."""
        with self._lock:
            now = self._clock()
            if len(self._hits) >= _MAX_TRACKED and uid not in self._hits:
                self._hits = {u: d for u, d in self._hits.items() if d[-1] > now - self._window}
            recent = self._hits.setdefault(uid, deque(maxlen=self._limit))
            over = len(recent) == self._limit and recent[0] > now - self._window
            recent.append(now)
            return not over


class AdminAuthz:
    """``db`` needs ``get(path) -> Optional[Document]`` (``FirestoreIndex``); None = no allowlist (local mode)."""

    def __init__(
        self,
        db: Any,
        *,
        clock: Clock = time.time,
        ttl_s: float = ALLOWLIST_TTL_S,
        limiter: Optional[ProbeLimiter] = None,
    ) -> None:
        self._db = db
        self.clock = clock
        self._ttl = ttl_s
        self.limiter = limiter or ProbeLimiter(clock=clock)
        self._verdicts: dict[str, tuple[bool, float]] = {}  # uid -> (is admin, valid until)
        self._lock = threading.Lock()

    def is_admin(self, uid: Optional[str]) -> bool:
        if not uid or self._db is None:
            return False
        now = self.clock()
        with self._lock:
            cached = self._verdicts.get(uid)
        if cached and now < cached[1]:
            return cached[0]
        try:
            verdict = self._db.get(ALLOWLIST_PATH.format(uid=uid)) is not None
        except Exception as exc:  # an allowlist we can't read grants nothing; the failure is not cached
            log.warning("admin allowlist unreadable (%s): denying", exc)
            return False
        with self._lock:
            if len(self._verdicts) >= _MAX_TRACKED:
                self._verdicts = {u: v for u, v in self._verdicts.items() if now < v[1]}
            self._verdicts[uid] = (verdict, now + self._ttl)
        return verdict

    def admit(self, uid: Optional[str]) -> bool:
        """True for an admin. A non-admin is counted against the probe limit and refused."""
        if self.is_admin(uid):
            return True
        if uid and not self.limiter.hit(uid):
            log.debug("admin probe over the limit: uid=%s", uid)
        return False


async def require_admin(request: Request) -> str:
    """The uid of the admin making this request; ``HiddenFromCaller`` for anyone else (idempotent)."""
    uid: Optional[str] = getattr(request.state, "admin_uid", None)
    if uid:
        return uid
    authz: Optional[AdminAuthz] = getattr(request.app.state, "admin_authz", None)
    caller = current_uid()
    if authz is None or not caller or not await run_in_threadpool(authz.admit, caller):
        raise HiddenFromCaller(request.scope["path"])
    request.state.admin_uid = caller
    return caller


def current_admin_uid(request: Request) -> str:
    """For handlers: the admin's uid (set by ``AdminRoute`` before the handler runs)."""
    uid: Optional[str] = getattr(request.state, "admin_uid", None)
    if not uid:  # unreachable behind AdminRoute; fail closed all the same
        raise HiddenFromCaller(request.scope["path"])
    return uid


def is_fresh(auth_time: Optional[float], now: float, max_age_s: float = FRESH_LOGIN_MAX_AGE_S) -> bool:
    return auth_time is not None and now - auth_time <= max_age_s


async def require_fresh_login(request: Request) -> None:
    """Dependency for the actions that need a sign-in at most 15 minutes old (AC-34)."""
    authz: Optional[AdminAuthz] = getattr(request.app.state, "admin_authz", None)
    now = authz.clock() if authz is not None else time.time()
    if not is_fresh(auth_time_of(request), now):
        raise ReauthRequired("Sign in again to confirm this action")


def _status_of(exc: BaseException) -> int:
    if isinstance(exc, RequestValidationError):
        return 422
    status = getattr(exc, "status", None) or getattr(exc, "status_code", None)
    return status if isinstance(status, int) else 500


class AdminRoute(APIRoute):
    """Every route of the admin router: admins only, logged as ``admin_request``."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        handler = super().get_route_handler()
        template = self.path

        async def guarded(request: Request) -> Response:
            uid = await require_admin(request)  # before the body is read or validated
            started = time.perf_counter()
            status = 500
            try:
                response = await handler(request)
                status = response.status_code
                return response
            except Exception as exc:
                status = _status_of(exc)
                raise
            finally:
                log.info(
                    "admin_request route=%s method=%s status=%d duration_ms=%d uid=%s",
                    template, request.method, status, round((time.perf_counter() - started) * 1000), uid,
                )

        return guarded


def unguarded_admin_routes(*routers: Any) -> list[str]:
    """Routes of ``routers`` under ``/api/admin`` that don't use ``AdminRoute`` ("METHODS path"); must be empty."""
    found: list[str] = []
    for router in routers:
        for route in router.routes:
            path = getattr(route, "path", "")
            if (path == ADMIN_PREFIX or path.startswith(ADMIN_PREFIX + "/")) and not isinstance(route, AdminRoute):
                methods = ",".join(sorted(getattr(route, "methods", None) or ())) or "*"
                found.append(f"{methods} {path}")
    return found

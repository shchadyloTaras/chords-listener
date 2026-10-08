"""Firebase Auth lookups for the admin (docs/features/admin, data-model "Not in Firestore").

``AuthLookup.account(uid)`` is what Firebase Auth knows of an account (Identity Toolkit ``accounts:lookup``): its
e-mail, ``lastLoginAt`` (the user card's «останній вхід») and ``createdAt``, read live so nothing about it is stored or
has to be purged. It also tells the admin an account exists when nothing in Firestore does (a profile never written,
review S2-1). Any failure (no credentials, the service down) means "unknown": None, never an error.

``FIREBASE_AUTH_EMULATOR_HOST`` points it at the Auth emulator, which takes ``Authorization: Bearer owner``.
"""
from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Optional

import requests

log = logging.getLogger("chords.admin")

LOOKUP_URL = "https://identitytoolkit.googleapis.com/v1/projects/{project}/accounts:lookup"
EMULATOR_LOOKUP_URL = "http://{host}/identitytoolkit.googleapis.com/v1/projects/{project}/accounts:lookup"
SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]
TIMEOUT_S = 5.0


def _default_session() -> Any:
    from google.auth import default
    from google.auth.transport.requests import AuthorizedSession

    credentials, _ = default(scopes=SCOPES)
    return AuthorizedSession(credentials)


@dataclass(frozen=True)
class AuthAccount:
    """An account as Firebase Auth has it."""

    uid: str
    email: Optional[str]                 # None for an account without one
    last_login_at: Optional[datetime]    # None when it never signed in
    created_at: Optional[datetime]


def _millis(value: Any) -> Optional[datetime]:
    """An Identity Toolkit time (milliseconds since the epoch, as a string) in UTC; None when absent or zero."""
    if value in (None, "", "0", 0):
        return None
    return datetime.fromtimestamp(int(value) / 1000, timezone.utc)


class AuthLookup:
    def __init__(
        self,
        project: str,
        *,
        session_factory: Optional[Callable[[], Any]] = None,
        emulator_host: Optional[str] = None,
    ) -> None:
        host = emulator_host or os.environ.get("FIREBASE_AUTH_EMULATOR_HOST")
        if host:
            self._url = EMULATOR_LOOKUP_URL.format(host=host, project=project)
            self._headers: Optional[dict[str, str]] = {"Authorization": "Bearer owner"}
            self._factory: Optional[Callable[[], Any]] = session_factory or requests.Session
        else:
            self._url = LOOKUP_URL.format(project=project)
            self._headers = None  # the AuthorizedSession adds the service account's token
            self._factory = session_factory  # None: ``_default_session``, looked up when first needed
        self._session_obj: Any = None
        self._lock = threading.Lock()

    def _session(self) -> Any:
        with self._lock:
            if self._session_obj is None:
                self._session_obj = (self._factory or _default_session)()
            return self._session_obj

    def account(self, uid: str) -> Optional[AuthAccount]:
        """The Firebase Auth account of ``uid``, or None when Auth has none or the answer is not available."""
        try:
            res = self._session().post(self._url, json={"localId": [uid]}, headers=self._headers, timeout=TIMEOUT_S)
            if res.status_code != 200:
                log.warning("auth lookup answered %s", res.status_code)
                return None
            users = res.json().get("users") or []
            if not users:
                return None
            user = users[0]
            email = user.get("email")
            return AuthAccount(
                uid=uid, email=email if isinstance(email, str) and email else None,
                last_login_at=_millis(user.get("lastLoginAt")), created_at=_millis(user.get("createdAt")),
            )
        except Exception as exc:  # noqa: BLE001 - the admin works on without what Auth would have said
            log.warning("auth lookup failed: %s", type(exc).__name__)
            return None

    def last_login_at(self, uid: str) -> Optional[datetime]:
        """When ``uid`` last signed in (UTC), or None when it never did or the answer is not available."""
        account = self.account(uid)
        return account.last_login_at if account is not None else None

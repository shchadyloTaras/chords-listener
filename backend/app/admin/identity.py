"""Firebase Auth lookups for the admin (docs/features/admin, data-model "Not in Firestore").

``AuthLookup.last_login_at(uid)`` is the account's ``lastLoginAt`` (the user card's «останній вхід»), read live from
Firebase Auth (Identity Toolkit ``accounts:lookup``) so nothing about it is stored or has to be purged. Any failure
(no credentials, the service down, an unknown account) means "unknown": the card shows no date instead of failing.

``FIREBASE_AUTH_EMULATOR_HOST`` points it at the Auth emulator, which takes ``Authorization: Bearer owner``.
"""
from __future__ import annotations

import logging
import os
import threading
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
            self._factory = session_factory or requests.Session
        else:
            self._url = LOOKUP_URL.format(project=project)
            self._headers = None  # the AuthorizedSession adds the service account's token
            self._factory = session_factory or _default_session
        self._session_obj: Any = None
        self._lock = threading.Lock()

    def _session(self) -> Any:
        with self._lock:
            if self._session_obj is None:
                self._session_obj = self._factory()
            return self._session_obj

    def last_login_at(self, uid: str) -> Optional[datetime]:
        """When ``uid`` last signed in (UTC), or None when it never did or the answer is not available."""
        try:
            res = self._session().post(self._url, json={"localId": [uid]}, headers=self._headers, timeout=TIMEOUT_S)
            if res.status_code != 200:
                log.warning("auth lookup answered %s", res.status_code)
                return None
            users = res.json().get("users") or []
            millis = users[0].get("lastLoginAt") if users else None
            if millis in (None, "", "0", 0):
                return None
            return datetime.fromtimestamp(int(millis) / 1000, timezone.utc)
        except Exception as exc:  # noqa: BLE001 - the card must open without the date
            log.warning("auth lookup failed: %s", type(exc).__name__)
            return None

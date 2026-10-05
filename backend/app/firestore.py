"""Firestore index for the library (docs/superpowers/specs/2026-10-05-library-firestore-storage-design.md).

``FirestoreIndex`` upserts / deletes one document per track, ``users/{uid}/tracks/{trackId}``, over the
Firestore REST API with the service account's credentials (``google.auth`` + ``requests``: no gRPC client).
``FIRESTORE_EMULATOR_HOST`` (e.g. ``127.0.0.1:8080``) points it at the Firestore emulator, which takes
``Authorization: Bearer owner`` as an admin. Failures raise ``IndexError_`` saying whether a retry may help.
"""
from __future__ import annotations

import logging
import os
import threading
from datetime import datetime, timezone
from typing import Any, Callable, Optional
from urllib.parse import quote

import requests
from google.auth import exceptions as gexc

log = logging.getLogger("chords.firestore")

BASE_URL = "https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents"
SCOPES = ["https://www.googleapis.com/auth/datastore"]
TIMEOUT_S = 10.0


class IndexError_(Exception):
    """A Firestore call failed. ``retryable``: 429 / 5xx / network (worth trying again), else False."""

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


# --------------------------------------------------------------------------- typed values


def to_value(v: Any) -> dict[str, Any]:
    """A Python value as a Firestore REST typed value."""
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):  # before int: bool is an int
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, datetime):
        if v.tzinfo is None:
            raise ValueError("naive datetime: give it a timezone")
        return {"timestampValue": v.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [to_value(x) for x in v]}}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {str(k): to_value(x) for k, x in v.items()}}}
    raise TypeError(f"can't store a {type(v).__name__} in Firestore")


def from_value(d: dict[str, Any]) -> Any:
    """A Firestore REST typed value as a Python value (a timestamp stays its ISO string)."""
    if "nullValue" in d:
        return None
    if "booleanValue" in d:
        return bool(d["booleanValue"])
    if "integerValue" in d:
        return int(d["integerValue"])
    if "doubleValue" in d:
        return float(d["doubleValue"])
    if "stringValue" in d:
        return d["stringValue"]
    if "timestampValue" in d:
        return d["timestampValue"]
    if "arrayValue" in d:
        return [from_value(x) for x in d["arrayValue"].get("values", [])]
    if "mapValue" in d:
        return {k: from_value(x) for k, x in d["mapValue"].get("fields", {}).items()}
    raise ValueError(f"unsupported Firestore value: {sorted(d)}")


# --------------------------------------------------------------------------- the client


def default_session() -> Any:
    from google.auth import default
    from google.auth.transport.requests import AuthorizedSession

    credentials, _ = default(scopes=SCOPES)
    return AuthorizedSession(credentials)


class FirestoreIndex:
    def __init__(
        self,
        project: str,
        *,
        session_factory: Optional[Callable[[], Any]] = None,
        emulator_host: Optional[str] = None,
    ) -> None:
        host = emulator_host or os.environ.get("FIRESTORE_EMULATOR_HOST")
        if host:
            self._base = f"http://{host}/v1/projects/{project}/databases/(default)/documents"
            self._headers: Optional[dict[str, str]] = {"Authorization": "Bearer owner"}
            self._factory = session_factory or requests.Session
        else:
            self._base = BASE_URL.format(project=project)
            self._headers = None  # the AuthorizedSession adds the service account's token
            self._factory = session_factory or default_session
        self._session_obj: Any = None
        self._lock = threading.Lock()

    def _session(self) -> Any:
        with self._lock:
            if self._session_obj is None:
                self._session_obj = self._factory()
            return self._session_obj

    def _send(
        self, method: str, uid: str, track_id: str, *, body: Optional[dict] = None, also_ok: tuple[int, ...] = ()
    ) -> int:
        url = f"{self._base}/users/{quote(uid, safe='')}/tracks/{quote(track_id, safe='')}"
        try:
            res = self._session().request(method, url, json=body, headers=self._headers, timeout=TIMEOUT_S)
        except requests.RequestException as exc:
            raise IndexError_(f"Firestore {method} failed: {exc}", retryable=True) from exc
        except gexc.GoogleAuthError as exc:
            raise IndexError_(
                f"Firestore {method} failed: {exc}", retryable=isinstance(exc, gexc.TransportError) or exc.retryable
            ) from exc
        status = res.status_code
        if 200 <= status < 300 or status in also_ok:
            return status
        detail = (res.text or "")[:200]
        message = f"Firestore {method} answered {status}" + (f": {detail}" if detail else "")
        raise IndexError_(message, retryable=status == 429 or status >= 500)

    def upsert(self, uid: str, track_id: str, data: dict[str, Any]) -> None:
        """Create or fully replace the track's document with ``data`` (no update mask: absent fields go)."""
        self._send("PATCH", uid, track_id, body={"fields": {k: to_value(v) for k, v in data.items()}})

    def delete(self, uid: str, track_id: str) -> None:
        """Remove the document; one that is already gone counts as done."""
        self._send("DELETE", uid, track_id, also_ok=(404,))

    def exists(self, uid: str, track_id: str) -> bool:
        return self._send("GET", uid, track_id, also_ok=(404,)) != 404

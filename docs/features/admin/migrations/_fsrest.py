"""Shared helpers for the admin data migrations (docs/features/admin/data-model.md).

Firestore REST like ``app.firestore`` (no gRPC client): list, query, get and batched commit with
preconditions. ``FIRESTORE_EMULATOR_HOST`` points it at the emulator (``Bearer owner``). Run every
migration from ``backend/`` with the service's environment, e.g. as a Cloud Run job on the service image
(the ``python -m app.publish backfill`` pattern), so ``/data`` and the service account are available.
"""
from __future__ import annotations

import os
from typing import Any, Iterator, Optional
from urllib.parse import quote

import requests

from app.firestore import IndexError_, default_session, from_value, to_value

TIMEOUT_S = 30.0
BATCH = 400  # Firestore caps a commit at 500 writes


class Rest:
    def __init__(self, project: str) -> None:
        host = os.environ.get("FIRESTORE_EMULATOR_HOST")
        self.root = f"projects/{project}/databases/(default)/documents"
        if host:
            self.url = f"http://{host}/v1/{self.root}"
            self.session: Any = requests.Session()
            self.headers: Optional[dict[str, str]] = {"Authorization": "Bearer owner"}
        else:
            self.url = f"https://firestore.googleapis.com/v1/{self.root}"
            self.session = default_session()
            self.headers = None

    def name(self, path: str) -> str:
        return f"{self.root}/{path}"

    def _call(self, method: str, url: str, *, body: Optional[dict] = None, params: Optional[dict] = None,
              also_ok: tuple[int, ...] = ()) -> Any:
        res = self.session.request(method, url, json=body, params=params, headers=self.headers, timeout=TIMEOUT_S)
        if 200 <= res.status_code < 300:
            return res.json() if res.content else None
        if res.status_code in also_ok:
            return None
        raise IndexError_(f"Firestore {method} answered {res.status_code}: {(res.text or '')[:300]}",
                          retryable=res.status_code == 429 or res.status_code >= 500)

    def get(self, path: str) -> Optional[dict[str, Any]]:
        doc = self._call("GET", f"{self.url}/{quote(path, safe='/')}", also_ok=(404,))
        return decode(doc) if doc else None

    def list(self, collection: str, *, mask: Optional[list[str]] = None) -> Iterator[tuple[str, dict[str, Any]]]:
        """Every document of a collection (``users`` or ``users/<uid>/tracks``) as (relative path, fields)."""
        params: dict[str, Any] = {"pageSize": 300}
        if mask is not None:
            params["mask.fieldPaths"] = mask
        while True:
            page = self._call("GET", f"{self.url}/{quote(collection, safe='/')}", params=params) or {}
            for doc in page.get("documents", []):
                yield self.rel(doc["name"]), decode(doc)
            token = page.get("nextPageToken")
            if not token:
                return
            params["pageToken"] = token

    def query(self, structured: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
        """``runQuery`` at the database root (use ``allDescendants`` for a collection group)."""
        for row in self._call("POST", f"{self.url}:runQuery", body={"structuredQuery": structured}) or []:
            doc = row.get("document")
            if doc:
                yield self.rel(doc["name"]), decode(doc)

    def commit(self, writes: list[dict[str, Any]]) -> None:
        """Commit in chunks; each chunk is atomic, the whole list is not (every migration is idempotent)."""
        for i in range(0, len(writes), BATCH):
            self._call("POST", f"{self.url}:commit", body={"writes": writes[i:i + BATCH]})

    def rel(self, name: str) -> str:
        return name.split("/documents/", 1)[1]

    # ----------------------------------------------------------------- write builders

    def create(self, path: str, data: dict[str, Any]) -> dict[str, Any]:
        """A write that fails if the document exists (use one per commit when re-runs must skip it)."""
        return {"update": {"name": self.name(path), "fields": encode(data)}, "currentDocument": {"exists": False}}

    def patch(self, path: str, data: dict[str, Any], *, fields: list[str]) -> dict[str, Any]:
        """Set (or, when absent from ``data``, delete) only ``fields`` of an existing document."""
        return {"update": {"name": self.name(path), "fields": encode(data)},
                "updateMask": {"fieldPaths": fields}, "currentDocument": {"exists": True}}

    def delete(self, path: str) -> dict[str, Any]:
        return {"delete": self.name(path)}


def encode(data: dict[str, Any]) -> dict[str, Any]:
    return {k: to_value(v) for k, v in data.items()}


def decode(doc: dict[str, Any]) -> dict[str, Any]:
    return {k: from_value(v) for k, v in doc.get("fields", {}).items()}


def already_exists(exc: IndexError_) -> bool:
    """The ``exists=false`` precondition of a ``create`` write failed (409 ALREADY_EXISTS)."""
    return "answered 409" in str(exc) or "ALREADY_EXISTS" in str(exc)

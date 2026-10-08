#!/usr/bin/env python3
"""Grant or revoke the admin mark: the owner's only way to change ``adminAllowlist/{uid}`` (ADR-0006).

    backend/.venv/bin/python scripts/admin_grant.py grant  <email|uid> [--note TEXT] [--project ID]
    backend/.venv/bin/python scripts/admin_grant.py revoke <email|uid> [--project ID]

Runs on the owner's machine with the owner's own Google credentials (Application Default Credentials after
``gcloud auth application-default login``): no key file, no service account, and the server's code has no path
that writes the allowlist. An email is resolved to the account's uid through Firebase Auth and is never stored;
the document holds ``grantedAt`` and an optional ``note`` (at most 200 characters, never an email). A revoke
takes effect on the server within a minute (the allowlist is cached for 60 s: AC-32).

``FIRESTORE_EMULATOR_HOST`` / ``FIREBASE_AUTH_EMULATOR_HOST`` point it at the emulators (no credentials needed).
Exit code: 0 done (also "already granted" / "was not an admin"), 1 refused or failed.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.firestore import FirestoreIndex, IndexError_, PreconditionFailed  # noqa: E402

DEFAULT_PROJECT = "build-chords-listener"
COLLECTION = "adminAllowlist"
NOTE_MAX = 200
UID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")  # what the server accepts as a uid
EMAIL_IN_TEXT = re.compile(r"\S+@\S+")
LOOKUP_URL = "https://identitytoolkit.googleapis.com/v1/projects/{project}/accounts:lookup"
EMULATOR_LOOKUP_URL = "http://{host}/identitytoolkit.googleapis.com/v1/projects/{project}/accounts:lookup"
SCOPES = ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/datastore"]
TIMEOUT_S = 15.0


class Refused(Exception):
    """The request can't be carried out; the message is for the owner."""


def adc_session_factory(project: str) -> Callable[[], Any]:
    """A session with the owner's ADC; ``x-goog-user-project`` bills the call to the project (user credentials)."""

    def make() -> Any:
        from google.auth import default
        from google.auth.transport.requests import AuthorizedSession

        credentials, _ = default(scopes=SCOPES)
        session = AuthorizedSession(credentials)
        session.headers["x-goog-user-project"] = project
        return session

    return make


class AuthEmailLookup:
    """Email -> uid through Identity Toolkit ``accounts:lookup`` (Firebase Auth emulator when its host is set)."""

    def __init__(self, project: str, *, session_factory: Optional[Callable[[], Any]] = None) -> None:
        host = os.environ.get("FIREBASE_AUTH_EMULATOR_HOST")
        if host:
            self._url = EMULATOR_LOOKUP_URL.format(host=host, project=project)
            self._headers: Optional[dict[str, str]] = {"Authorization": "Bearer owner"}
            import requests

            self._factory: Callable[[], Any] = session_factory or requests.Session
        else:
            self._url = LOOKUP_URL.format(project=project)
            self._headers = None
            self._factory = session_factory or adc_session_factory(project)

    def uid_for_email(self, email: str) -> Optional[str]:
        self.verified = True
        res = self._factory().post(self._url, json={"email": [email.strip().lower()]}, headers=self._headers,
                                   timeout=TIMEOUT_S)
        if res.status_code != 200:
            raise Refused(f"Firebase Auth answered {res.status_code} when looking the account up: {res.text[:200]}")
        users = res.json().get("users") or []
        uid = users[0].get("localId") if users else None
        self.verified = bool(users and users[0].get("emailVerified"))
        return uid if isinstance(uid, str) and uid else None


def resolve_uid(target: str, lookup: Any, *, require_verified: bool = False) -> str:
    target = target.strip()
    if "@" in target:
        uid = lookup.uid_for_email(target)
        if not uid:
            raise Refused("no account with that email in Firebase Auth: nothing changed")
        if require_verified and not getattr(lookup, "verified", True):
            raise Refused("that account's email is not verified in Firebase Auth: nothing changed "
                          "(grant by uid once you have checked who owns it)")
        return uid
    if not UID_RE.match(target):
        raise Refused("not a uid (letters, digits, - and _ only) and not an email: nothing changed")
    return target


def check_note(note: Optional[str]) -> Optional[str]:
    if note is None:
        return None
    if len(note) > NOTE_MAX:
        raise Refused(f"the note is {len(note)} characters, at most {NOTE_MAX} are allowed: nothing changed")
    if EMAIL_IN_TEXT.search(note):
        raise Refused("the note must not contain an email address: nothing changed")
    return note


def grant(db: Any, uid: str, note: Optional[str], now: datetime) -> str:
    path = f"{COLLECTION}/{uid}"
    existing = db.get(path)
    if existing is not None:
        return f"{uid} is already an admin (granted {existing.data.get('grantedAt')}); left as is"
    try:
        db.commit([db.update_op(path, {"grantedAt": now, "note": note}, exists=False)])
    except PreconditionFailed:  # granted by a concurrent run
        return f"{uid} is already an admin; left as is"
    return f"granted: {uid} is an admin (the server sees it within a minute)"


def revoke(db: Any, uid: str) -> str:
    path = f"{COLLECTION}/{uid}"
    if db.get(path) is None:
        return f"{uid} is not an admin: nothing to revoke"
    db.commit([db.delete_op(path)])
    return f"revoked: {uid} is refused by the server within a minute"


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("action", choices=("grant", "revoke"))
    p.add_argument("target", help="the person's email (resolved through Firebase Auth, never stored) or uid")
    p.add_argument("--note", help=f"free note, at most {NOTE_MAX} characters, never an email (grant only)")
    p.add_argument("--project", default=os.environ.get("CHORDS_FIREBASE_PROJECT", DEFAULT_PROJECT))
    return p


def run(argv: list[str], *, db: Any = None, lookup: Any = None, now: Optional[datetime] = None) -> int:
    args = parser().parse_args(argv)
    try:
        note = check_note(args.note) if args.action == "grant" else None
        lookup = lookup or AuthEmailLookup(args.project)
        uid = resolve_uid(args.target, lookup, require_verified=args.action == "grant")
        # with the Firestore emulator host set, FirestoreIndex talks to the emulator without credentials
        db = db or FirestoreIndex(args.project, session_factory=None if os.environ.get("FIRESTORE_EMULATOR_HOST")
                                  else adc_session_factory(args.project))
        message = (grant(db, uid, note, now or datetime.now(timezone.utc)) if args.action == "grant"
                   else revoke(db, uid))
    except Refused as exc:
        print(f"admin_grant: {exc}", file=sys.stderr)
        return 1
    except IndexError_ as exc:
        print(f"admin_grant: Firestore failed ({exc}); nothing was assumed. Are you the project owner, signed in with "
              "`gcloud auth application-default login`?", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - e.g. no Application Default Credentials: say so plainly
        print(f"admin_grant: {type(exc).__name__}: {exc}\nSign in first: gcloud auth application-default login",
              file=sys.stderr)
        return 1
    print(message)
    return 0


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))

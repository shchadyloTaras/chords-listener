"""The final deletion of an account (docs/features/admin T25; AC-22; ADR-0011; sad §6 «Critical flow 3»).

``Purger.run()`` is the ``purges`` step of the sweep (``sweeps.py``) and nothing else calls it: a purge never runs
from an admin request. It finds the accounts whose 7-day window has passed (``adminAccounts.deletion.purgeAfter <=
now``) and the purges that were interrupted (``adminTombstones`` with ``status == purging``) and takes each uid through
these steps, every one idempotent:

1. the tombstone  ``adminTombstones/{uid}`` ``purging`` (uid and times only), written in a transaction that re-reads
                  the account, so a deletion cancelled meanwhile is not purged. From here the publish path, the job
                  results and the admission gate treat the uid as gone;
2. the files      ``<data>/users/<uid>`` (tracks, audio, edits, ``quota.json``, a queued publish retry) and every bucket
                  object under ``users/<uid>/``;
3. Firestore      the library ``users/<uid>/tracks/*``, ``users/<uid>``, ``adminAccounts/<uid>`` and the e-mail index entry;
4. the history    ``adminJobs`` of the uid: ``title`` and ``trackId`` nulled, ``anonymizedAt`` set (the uid stays, so the
                  UI can say «видалений» and the counted days stay as they were); ``adminAudit`` of the uid: the
                  restriction reasons removed from ``before`` / ``after``, and the search query (and the uid) removed
                  from every search that matched it - the records stay, ``redactedAt`` says what was done;
5. Firebase Auth  the account is deleted, last, so an interrupted purge never leaves data whose owner can no longer be
                  found from Auth (ADR-0011); then the profile, admin state and index entry are erased once more, in
                  case a client still holding a valid ID token wrote its profile back in the meantime;
6. the tombstone  ``done`` and ``doneAt``.

A step that raises stops that uid (its tombstone stays ``purging``, so the next sweep resumes it) and the others go on;
``run`` then raises ``PurgeFailed`` and the sweep fails, which makes Cloud Scheduler retry. A uid still not done a day
after its window logs the metric ``deletion_overdue`` (SAD §7). The logs carry the uid only: never an e-mail, a title or
the text of an error.
"""
from __future__ import annotations

import logging
import shutil
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

import requests

from app.firestore import FirestoreIndex, PreconditionFailed, Transaction, field_path
from app.users import valid_uid

from .actions import ACCOUNTS
from .audit import COLLECTION as AUDIT
from .directory import USERS, Directory, parse_time
from .history import JOBS
from .identity import _default_session

log = logging.getLogger("chords.admin")

TOMBSTONES = "adminTombstones"
PURGING, DONE = "purging", "done"
OVERDUE_AFTER = timedelta(hours=24)   # NFR: every scheduled deletion is complete within 24 h of its window's end
PAGE = 400                            # documents per commit (a commit takes at most 500 writes)

AUTH_DELETE_URL = "https://identitytoolkit.googleapis.com/v1/projects/{project}/accounts:delete"
EMULATOR_AUTH_DELETE_URL = "http://{host}/identitytoolkit.googleapis.com/v1/projects/{project}/accounts:delete"
AUTH_TIMEOUT_S = 10.0


class PurgeFailed(Exception):
    """At least one purge did not finish (each stays resumable). ``uids`` are the accounts it concerns."""

    def __init__(self, uids: list[str]) -> None:
        super().__init__(f"{len(uids)} purge(s) not finished")
        self.uids = uids


class AuthDeleteFailed(Exception):
    """Firebase Auth did not delete the account (the purge is resumed by the next sweep)."""


@dataclass
class PurgeReport:
    purged: list[str] = field(default_factory=list)   # purges completed in this run
    failed: list[str] = field(default_factory=list)   # purges that stopped at a failing step
    overdue: int = 0                                  # of those still open, how many are > 24 h past their window


# --------------------------------------------------------------------------- Firebase Auth and the bucket


class AuthAdmin:
    """Deletes Firebase Auth accounts (Identity Toolkit ``accounts:delete``, as the Admin SDK does).
    ``FIREBASE_AUTH_EMULATOR_HOST`` (or ``emulator_host``) points it at the Auth emulator (``Bearer owner``)."""

    def __init__(
        self,
        project: str,
        *,
        session_factory: Optional[Callable[[], Any]] = None,
        emulator_host: Optional[str] = None,
    ) -> None:
        import os

        host = emulator_host or os.environ.get("FIREBASE_AUTH_EMULATOR_HOST")
        if host:
            self._url = EMULATOR_AUTH_DELETE_URL.format(host=host, project=project)
            self._headers: Optional[dict[str, str]] = {"Authorization": "Bearer owner"}
            self._factory = session_factory or requests.Session
        else:
            self._url = AUTH_DELETE_URL.format(project=project)
            self._headers = None   # the AuthorizedSession adds the service account's token
            self._factory = session_factory or _default_session
        self._session_obj: Any = None
        self._lock = threading.Lock()

    def _session(self) -> Any:
        with self._lock:
            if self._session_obj is None:
                self._session_obj = self._factory()
            return self._session_obj

    def delete_user(self, uid: str) -> None:
        """Delete the account; one that is already gone counts as done. Anything else raises ``AuthDeleteFailed``
        (its message names no account data)."""
        try:
            res = self._session().post(self._url, json={"localId": uid}, headers=self._headers, timeout=AUTH_TIMEOUT_S)
        except Exception as exc:  # noqa: BLE001 - network, credentials: all mean "try again later"
            raise AuthDeleteFailed(f"auth delete failed: {type(exc).__name__}") from exc
        if res.status_code == 200:
            return
        if res.status_code == 400 and _auth_error(res) == "USER_NOT_FOUND":
            return
        raise AuthDeleteFailed(f"auth delete answered {res.status_code}")


def _auth_error(res: Any) -> Optional[str]:
    try:
        message = res.json().get("error", {}).get("message")
    except Exception:  # noqa: BLE001 - an unparseable body is just "unknown"
        return None
    return message.split(" ")[0] if isinstance(message, str) else None


class BucketEraser:
    """Deletes every object of ``bucket`` under a prefix. ``client_factory`` makes the google-cloud-storage client."""

    def __init__(self, bucket: str, client_factory: Callable[[], Any]) -> None:
        self._bucket = bucket
        self._factory = client_factory
        self._client: Any = None
        self._lock = threading.Lock()

    def _storage(self) -> Any:
        with self._lock:
            if self._client is None:
                self._client = self._factory()
            return self._client

    def erase(self, prefix: str) -> int:
        """Delete the objects named ``prefix...`` and return how many; one that is already gone counts as done."""
        removed = 0
        for blob in list(self._storage().list_blobs(self._bucket, prefix=prefix)):
            try:
                blob.delete()
                removed += 1
            except Exception as exc:  # noqa: BLE001
                if type(exc).__name__ != "NotFound":
                    raise
        return removed


# --------------------------------------------------------------------------- the purge


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Purger:
    """``db`` is a ``FirestoreIndex``; ``directory`` the e-mail index; ``users_dir`` the data mount's ``users``;
    ``auth`` needs ``delete_user(uid)``; ``erase_objects(prefix)`` removes bucket objects (None: the mount alone)."""

    def __init__(
        self,
        db: FirestoreIndex,
        *,
        directory: Directory,
        users_dir: Path,
        auth: Any,
        erase_objects: Optional[Callable[[str], Any]] = None,
        now: Callable[[], datetime] = _utc_now,
        users_collection: str = USERS,
        accounts_collection: str = ACCOUNTS,
        tombstones_collection: str = TOMBSTONES,
        jobs_collection: str = JOBS,
        audit_collection: str = AUDIT,
    ) -> None:
        self._db = db
        self._directory = directory
        self._users_dir = users_dir
        self._auth = auth
        self._erase_objects: Callable[[str], Any] = erase_objects or (lambda prefix: 0)
        self._now = now
        self._users = users_collection
        self._accounts = accounts_collection
        self._tombstones = tombstones_collection
        self._jobs = jobs_collection
        self._audit = audit_collection

    # ----------------------------------------------------------------------- public

    def run(self, *, raise_on_failure: bool = True) -> PurgeReport:
        """Purge every account that is due and resume every interrupted purge. With ``raise_on_failure`` a run in
        which a purge stopped ends in ``PurgeFailed`` (after the others were tried)."""
        now = self._now()
        report = PurgeReport()
        due = self._due(now)
        for uid in sorted(due):
            if not valid_uid(uid):
                log.error("purge skipped: invalid uid %r", uid[:40])
                continue
            try:
                if self.purge(uid):
                    report.purged.append(uid)
            except Exception as exc:  # noqa: BLE001 - the next sweep resumes it
                report.failed.append(uid)
                log.error("purge failed uid=%s error=%s", uid, type(exc).__name__)
        overdue = [uid for uid in report.failed if due[uid] + OVERDUE_AFTER <= now]
        report.overdue = len(overdue)
        if overdue:
            log.error("deletion_overdue count=%d uids=%s", len(overdue), ",".join(overdue))
        if report.failed and raise_on_failure:
            raise PurgeFailed(report.failed)
        return report

    def purge(self, uid: str) -> bool:
        """Take ``uid`` through every step. True when it was completed now; False when there was nothing to do (not
        due, cancelled, already done). A step that raises propagates; the tombstone then stays ``purging``."""
        if not valid_uid(uid):
            raise ValueError("invalid uid")
        if not self._begin(uid):
            return False
        log.info("purge started uid=%s", uid)
        self._step(uid, "files", lambda: self._erase_files(uid))
        self._step(uid, "library", lambda: self._erase_library(uid))
        self._step(uid, "jobs", lambda: self._anonymize_jobs(uid))
        self._step(uid, "audit", lambda: self._redact_audit(uid))
        self._step(uid, "auth", lambda: self._auth.delete_user(uid))
        # A client still holding a valid ID token may have written its profile back before the account went.
        self._step(uid, "profile", lambda: self._erase_profile(uid))
        self._finish(uid)
        log.info("purge done uid=%s", uid)
        return True

    # ----------------------------------------------------------------------- who is due

    def _due(self, now: datetime) -> dict[str, datetime]:
        """uid -> the end of its window, for the accounts past it and the purges still open."""
        due: dict[str, datetime] = {}
        for doc in self._db.run_query(self._accounts, filters=[("deletion.purgeAfter", "<=", now)]):
            deletion = doc.data.get("deletion")
            when = parse_time(deletion.get("purgeAfter")) if isinstance(deletion, dict) else None
            due[doc.id] = when or now
        for doc in self._db.run_query(self._tombstones, filters=[("status", "==", PURGING)]):
            due[doc.id] = parse_time(doc.data.get("purgeAfter")) or due.get(doc.id) or now
        return due

    # ----------------------------------------------------------------------- the tombstone

    def _begin(self, uid: str) -> bool:
        """Write the tombstone (or find it): True when the purge is to run (new, or resumed), False when the deletion
        is not due any more (cancelled) or the purge is done. The account is read in the same transaction."""
        now = self._now()
        path = f"{self._tombstones}/{uid}"

        def work(tx: Transaction) -> bool:
            tomb = tx.get(path)
            if tomb is not None:
                return tomb.data.get("status") == PURGING
            account = tx.get(f"{self._accounts}/{uid}")
            deletion = account.data.get("deletion") if account is not None else None
            due = parse_time(deletion.get("purgeAfter")) if isinstance(deletion, dict) else None
            if due is None or due > now:
                return False
            tx.commit([self._db.update_op(
                path, {"status": PURGING, "purgeAfter": due, "startedAt": now, "doneAt": None}, exists=False)])
            return True

        try:
            return bool(self._db.run_transaction(work))
        except PreconditionFailed:   # another instance wrote it first: it is running the purge
            return False

    def _finish(self, uid: str) -> None:
        self._db.commit([self._db.update_op(
            f"{self._tombstones}/{uid}", {"status": DONE, "doneAt": self._now()},
            mask=["status", "doneAt"], exists=True)])

    @staticmethod
    def _step(uid: str, name: str, action: Callable[[], Any]) -> None:
        try:
            action()
        except Exception as exc:
            log.error("purge step failed uid=%s step=%s error=%s", uid, name, type(exc).__name__)
            raise

    # ----------------------------------------------------------------------- the steps

    def _erase_files(self, uid: str) -> None:
        try:
            shutil.rmtree(self._users_dir / uid)
        except FileNotFoundError:
            pass
        self._erase_objects(f"users/{uid}/")

    def _erase_library(self, uid: str) -> None:
        tracks = f"{self._users}/{uid}/tracks"
        while True:
            page = self._db.run_query(tracks, limit=PAGE)
            if page:
                self._db.commit([self._db.delete_op(doc.path) for doc in page])
            if len(page) < PAGE:
                break
        self._erase_profile(uid)

    def _erase_profile(self, uid: str) -> None:
        self._db.commit([self._db.delete_op(f"{self._users}/{uid}"), self._db.delete_op(f"{self._accounts}/{uid}")])
        self._directory.remove(uid)

    def _pages(self, collection: str, filters: list[tuple[str, str, Any]], order: str) -> Iterator[list[Any]]:
        """The documents matching ``filters``, ``order``-ed, one page of ``PAGE`` at a time (a cursor walks them)."""
        last = None
        while True:
            page = self._db.run_query(collection, filters=filters, order_by=[order], limit=PAGE, start_after=last)
            if not page:
                return
            yield page
            if len(page) < PAGE:
                return
            last = page[-1]

    def _anonymize_jobs(self, uid: str) -> None:
        now = self._now()
        for page in self._pages(self._jobs, [("uid", "==", uid)], "acceptedAt"):
            writes = [
                self._db.update_op(doc.path, {"title": None, "trackId": None, "anonymizedAt": now},
                                   mask=["title", "trackId", "anonymizedAt"], exists=True)
                for doc in page
                if doc.data.get("anonymizedAt") is None or doc.data.get("title") is not None
                or doc.data.get("trackId") is not None
            ]
            if writes:
                self._db.commit(writes)

    def _redact_audit(self, uid: str) -> None:
        now = self._now()
        # the records about the uid: the restriction reasons go, the record and its target uid stay
        for page in self._pages(self._audit, [("targetUid", "==", uid)], "at"):
            writes = []
            for doc in page:
                mask = [field_path(side, "reason") for side in ("before", "after")
                        if isinstance(doc.data.get(side), dict) and "reason" in doc.data[side]]
                if mask or doc.data.get("redactedAt") is None:
                    writes.append(self._db.update_op(
                        doc.path, {"redactedAt": now}, mask=[*mask, "redactedAt"], exists=True))
            if writes:
                self._db.commit(writes)
        # the searches that returned the uid: the query (it may hold the address) and the uid go
        while True:
            page = self._db.run_query(self._audit, filters=[("matchedUids", "array-contains", uid)], limit=PAGE)
            if not page:
                break
            self._db.commit([
                self._db.update_op(
                    doc.path,
                    {"query": None, "matchedUids": [u for u in doc.data.get("matchedUids") or [] if u != uid],
                     "redactedAt": now},
                    mask=["query", "matchedUids", "redactedAt"], exists=True)
                for doc in page])
            if len(page) < PAGE:
                break

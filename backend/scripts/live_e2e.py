"""Helper of the live admin e2e suite (frontend/e2e-live, docs/features/admin/test-plan.md): seeds the Firebase emulators
with the canonical factories of ``tests/admin/fixtures.py`` and runs the background sweep the way the server does.

    python scripts/live_e2e.py seed < spec.json        users, library, job history, bucket objects, a load dataset
    python scripts/live_e2e.py backdate-deletion UID   the scheduled deletion of UID is due now (the 7 days "passed")
    python scripts/live_e2e.py sweep                   one sweep of a fresh slot, purges included; prints the run

Why a helper for the sweep: ``POST /api/internal/sweep`` takes only a Google-signed OIDC token of the scheduler's
service account (``SchedulerTokenVerifier``: Google's certificates, audience, e-mail), which cannot be minted locally.
``sweep`` therefore imports the server's own module and runs ``app.state.sweeper`` - the ``Sweeper`` and ``Purger``
``create_app`` builds from the same ``CHORDS_*`` environment as the running server - against the same emulators and
data directory. Only the HTTP entry and the token check are skipped.

It refuses to run unless FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST and STORAGE_EMULATOR_HOST are all set:
it never touches a real project.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

EMULATOR_VARS = ("FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "STORAGE_EMULATOR_HOST")


LOOPBACK = re.compile(r"^(https?://)?(127\.0\.0\.1|localhost|\[::1\]):\d+/?$")


def _emulators_only() -> None:
    missing = [name for name in EMULATOR_VARS if not os.environ.get(name, "").strip()]
    if missing:
        raise SystemExit(f"live_e2e: refusing to run without {', '.join(missing)}: this helper only talks to the emulators")
    remote = [name for name in EMULATOR_VARS if not LOOPBACK.match(os.environ[name].strip())]
    if remote:
        raise SystemExit(f"live_e2e: refusing to run: {', '.join(remote)} must point at a local emulator (127.0.0.1, localhost or [::1])")


def _when(value: Any, now: datetime) -> datetime:
    """``"now"`` (default), ``"-90s"`` style offsets in seconds, or an ISO time."""
    if value in (None, "now"):
        return now
    if isinstance(value, str) and value.endswith("s") and value[:-1].lstrip("+-").isdigit():
        return now + timedelta(seconds=int(value[:-1]))
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def seed(spec: dict[str, Any]) -> dict[str, int]:
    """Write what ``spec`` asks for. Keys (all optional):

    * ``users``   ``[{uid, email, created?}]``        -> ``users/{uid}`` (``make_user``)
    * ``tracks``  ``[{uid, count, titles?}]``          -> ``users/{uid}/tracks/*`` (``make_tracks``), dated now
    * ``jobs``    ``[{uid, title, status?, reason?}]`` -> ``adminJobs/*`` (``make_job``), accepted now
    * ``objects`` ``[{path, text}]``                   -> bucket objects (the server's ``CHORDS_UPLOAD_BUCKET``)
    * ``dataset`` ``{users, tracks, prefix}``          -> that many users registered today, each with that many songs
    """
    from app.firestore import FirestoreIndex
    from app.models import Settings
    from tests.admin.fixtures import make_job, make_stats_day, make_tracks, make_user, seed as write

    settings = Settings.from_env()
    db = FirestoreIndex(settings.firebase_project)
    now = datetime.now(timezone.utc)
    seeds = []
    for user in spec.get("users", []):
        seeds.append(make_user(user["uid"], email=user["email"], created_at=_when(user.get("created"), now)))
    for lib in spec.get("tracks", []):
        seeds += make_tracks(lib["uid"], int(lib["count"]), start=now - timedelta(hours=1), titles=lib.get("titles"))
    for job in spec.get("jobs", []):
        status = job.get("status", "done")
        seeds.append(make_job(job["uid"], status=status, reason=job.get("reason") if status == "error" else None,
                              origin=job.get("origin", "file"), accepted_at=now - timedelta(minutes=30),
                              title=job["title"]))
    dataset = spec.get("dataset")
    if dataset:
        prefix = dataset.get("prefix", "load")
        for i in range(int(dataset["users"])):
            uid = f"{prefix}-{i:06d}"
            seeds.append(make_user(uid, email=f"{uid}@example.test", created_at=now - timedelta(seconds=i)))
            seeds += make_tracks(uid, int(dataset.get("tracks", 0)), start=now - timedelta(days=1))
        day = now.strftime("%Y-%m-%d")
        seeds.append(make_stats_day(day, analyses={"link": 7, "file": 5, "mic": 2, "tab": 1}, vocals=3, failed=1,
                                    failedByReason={"other": 1}, active=int(dataset["users"]), updatedAt=now))
    written = write(db, seeds) if seeds else 0
    objects = spec.get("objects", [])
    if objects:
        from app.gcs import default_client

        bucket = default_client(settings.firebase_project).bucket(settings.upload_bucket)
        for obj in objects:
            bucket.blob(obj["path"]).upload_from_string(obj["text"].encode(), content_type="application/json", timeout=30)
    return {"documents": written, "objects": len(objects)}


def backdate_deletion(uid: str, minutes: int) -> str:
    """Move ``adminAccounts/{uid}.deletion.purgeAfter`` ``minutes`` into the past: the 7-day window has passed."""
    from app.firestore import FirestoreIndex, field_path
    from app.models import Settings

    db = FirestoreIndex(Settings.from_env().firebase_project)
    doc = db.get(f"adminAccounts/{uid}")
    deletion = doc.data.get("deletion") if doc is not None else None
    if not isinstance(deletion, dict) or "purgeAfter" not in deletion:
        raise SystemExit(f"live_e2e: no scheduled deletion for {uid}")
    due = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    db.commit([db.update_op(f"adminAccounts/{uid}", {"deletion": {"purgeAfter": due}},
                            mask=[field_path("deletion", "purgeAfter")], exists=True)])
    return due.isoformat()


def sweep(slot: str | None) -> dict[str, Any]:
    """One run of the server's own sweeper (``app.main.create_app`` built it from this environment)."""
    from app.main import app

    sweeper = app.state.sweeper
    if sweeper is None:
        raise SystemExit("live_e2e: this environment builds no sweeper (is CHORDS_AUTH=firebase set?)")
    slot = slot or f"live-e2e-{datetime.now(timezone.utc):%Y%m%dT%H%M%S%f}"
    return sweeper.run(slot, woke_by="live-e2e")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("seed", help="read a JSON spec on stdin and write it to the emulators")
    back = sub.add_parser("backdate-deletion", help="make the scheduled deletion of UID due now")
    back.add_argument("uid")
    back.add_argument("--minutes", type=int, default=1)
    run = sub.add_parser("sweep", help="run the background sweep once (a fresh slot unless --slot)")
    run.add_argument("--slot")
    args = parser.parse_args(argv)
    _emulators_only()
    if args.command == "seed":
        result: Any = seed(json.load(sys.stdin))
    elif args.command == "backdate-deletion":
        result = {"purgeAfter": backdate_deletion(args.uid, args.minutes)}
    else:
        result = sweep(args.slot)
    print(json.dumps(result, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

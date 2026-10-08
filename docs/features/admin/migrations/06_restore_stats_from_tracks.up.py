"""06 up: rebuild ``adminStats/<day>`` with ``state: restored`` for the days before launch (AC-08; idempotent).

Counts the tracks every user added per UTC day by ``source.type`` (``youtube`` | ``url`` | ``file``) from the
library index ``users/*/tracks`` (``createdAt`` is an ISO string there). Every UTC day from the first counted
track's day up to ``--before`` (the feature's launch day, YYYY-MM-DD, not included) is written, a day nobody added
a song on too (zero songs): the admin then reads every pre-launch day as «відновлено з пісень», never as an ordinary
day of zeros. Each day is created with ``exists=false`` so a live, frozen or already restored day is never touched.
The smoke-test account is left out (spec §8, resolved 2026-10-08).
"""
from __future__ import annotations

import argparse
import re
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from _fsrest import Rest, already_exists
from app.firestore import IndexError_
from app.models import Settings
from app.users import SMOKE_UID

SOURCE_TYPES = ("youtube", "url", "file")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--before", required=True, help="launch day, YYYY-MM-DD (UTC); earlier days are restored")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        launch = date.fromisoformat(args.before) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.before) else None
    except ValueError:
        launch = None
    if launch is None:
        parser.error("--before must be YYYY-MM-DD")
    fs = Rest(Settings.from_env().firebase_project)
    days: dict[str, dict[str, int]] = defaultdict(lambda: dict.fromkeys(SOURCE_TYPES, 0))
    query = {"from": [{"collectionId": "tracks", "allDescendants": True}],
             "select": {"fields": [{"fieldPath": "createdAt"}, {"fieldPath": "source"}]}}
    for path, doc in fs.query(query):
        if not path.startswith("users/") or path.split("/")[1] == SMOKE_UID:
            continue
        day = str(doc.get("createdAt") or "")[:10]
        kind = (doc.get("source") or {}).get("type")
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) and day < args.before and kind in SOURCE_TYPES:
            days[day][kind] += 1
    if days:  # the quiet days in between are restored too, with no songs
        first = date.fromisoformat(min(days))
        for n in range((launch - first).days):
            days.setdefault((first + timedelta(days=n)).isoformat(), dict.fromkeys(SOURCE_TYPES, 0))
    now = datetime.now(timezone.utc)
    created = skipped = 0
    for day in sorted(days):
        doc = {
            "state": "restored",
            "analyses": {"link": 0, "file": 0, "mic": 0, "tab": 0},
            "vocals": 0, "failed": 0, "failedByReason": {}, "active": 0,
            "newUsers": None, "restoredTracks": days[day],
            "reconciledDiff": None, "frozenAt": None, "updatedAt": now,
        }
        if args.dry_run:
            print(f"{day}: {days[day]}")
            continue
        try:
            fs.commit([fs.create(f"adminStats/{day}", doc)])
            created += 1
        except IndexError_ as exc:
            if not already_exists(exc):
                raise
            skipped += 1
    print(f"{len(days)} day(s) found, {created} restored, {skipped} already present")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

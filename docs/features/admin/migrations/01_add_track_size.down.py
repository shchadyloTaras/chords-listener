"""01 down: remove ``sizeBytes`` from every ``users/<uid>/tracks/<id>`` document (idempotent).

Run only after the code that writes and reads ``sizeBytes`` is rolled back, or the publish path adds it again.
"""
from __future__ import annotations

import argparse

from _fsrest import Rest
from app.models import Settings
from app.users import valid_uid


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    settings = Settings.from_env()
    fs = Rest(settings.firebase_project)
    removed = 0
    # The same uids as the up step: every user directory on /data (a uid may have tracks but no users doc).
    for user_dir in sorted(p for p in (settings.data_dir / "users").iterdir() if p.is_dir()):
        if not valid_uid(user_dir.name):
            continue
        writes = [
            fs.patch(path, {}, fields=["sizeBytes"])  # in the mask, absent from the data: the field is deleted
            for path, doc in fs.list(f"users/{user_dir.name}/tracks", mask=["sizeBytes"])
            if "sizeBytes" in doc
        ]
        removed += len(writes)
        if writes and not args.dry_run:
            fs.commit(writes)
    print(f"sizeBytes {'would be' if args.dry_run else 'was'} removed from {removed} track document(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

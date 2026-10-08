"""01 up: add ``sizeBytes`` to every ``users/<uid>/tracks/<id>`` document (expand step; idempotent).

The size is the bytes of the track directory on ``/data`` (audio, stems, track.json, edits); the admin card
sums it for «зайняте місце». Only documents that exist are patched (a track that was never published stays
unpublished). Run from ``backend/`` with the service's environment:
``PYTHONPATH=.:<this dir> python <this file> [--dry-run]``.
"""
from __future__ import annotations

import argparse

from _fsrest import Rest
from app.models import Settings
from app.publish import dir_size  # the publish path's own count, so the backfill and new publishes agree
from app.storage import TrackStore
from app.users import valid_uid


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    settings = Settings.from_env()
    store = TrackStore(settings)
    fs = Rest(settings.firebase_project)
    users_root = settings.data_dir / "users"
    patched = 0
    for user_dir in sorted(p for p in users_root.iterdir() if p.is_dir()):
        uid = user_dir.name
        if not valid_uid(uid):
            continue
        writes = []
        for path, doc in fs.list(f"users/{uid}/tracks", mask=["sizeBytes"]):
            track_id = path.rsplit("/", 1)[-1]
            track_dir = store.user_dir(uid) / "tracks" / track_id
            if not track_dir.is_dir():
                continue
            size = dir_size(track_dir)
            if doc.get("sizeBytes") == size:
                continue
            writes.append(fs.patch(path, {"sizeBytes": size}, fields=["sizeBytes"]))
        patched += len(writes)
        if writes and not args.dry_run:
            fs.commit(writes)
    print(f"{patched} track document(s) {'would get' if args.dry_run else 'got'} sizeBytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""05 down: delete every ``adminEmailIndex`` shard (a projection of ``users``: nothing is lost)."""
from __future__ import annotations

import argparse

from _fsrest import Rest
from app.models import Settings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    fs = Rest(Settings.from_env().firebase_project)
    writes = [fs.delete(path) for path, _ in fs.list("adminEmailIndex", mask=[])]
    if writes and not args.dry_run:
        fs.commit(writes)
    print(f"{len(writes)} shard(s) {'would be deleted' if args.dry_run else 'deleted'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

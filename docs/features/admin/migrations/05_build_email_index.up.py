"""05 up: build ``adminEmailIndex/s000…`` from ``users`` (ADR-0009; idempotent full rebuild).

Every shard holds ``entries`` (uid → lower-cased email), ``count``, ``syncedThrough`` (the newest
``users.createdAt`` folded in) and ``fullSyncAt``. Shards are fully replaced, and shards left over from a
bigger earlier build are deleted, so a re-run converges to the current ``users``. The sweep's full sync
does the same at runtime.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone

from _fsrest import Rest, encode
from app.models import Settings

SHARD_SIZE = 20_000  # ~1 MiB document limit (SAD §7)


def shard_id(n: int) -> str:
    return f"s{n:03d}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    fs = Rest(Settings.from_env().firebase_project)
    entries: dict[str, str] = {}
    synced_through = ""
    for path, doc in fs.list("users", mask=["email", "createdAt"]):
        email = doc.get("email")
        if isinstance(email, str) and email:
            entries[path.rsplit("/", 1)[-1]] = email.lower()
        created = doc.get("createdAt") or ""
        synced_through = max(synced_through, created)  # ISO strings compare in time order
    now = datetime.now(timezone.utc)
    cursor = datetime.fromisoformat(synced_through.replace("Z", "+00:00")) if synced_through else now
    uids = sorted(entries)
    chunks = [uids[i:i + SHARD_SIZE] for i in range(0, len(uids), SHARD_SIZE)] or [[]]
    writes = [
        {"update": {"name": fs.name(f"adminEmailIndex/{shard_id(n)}"),
                    "fields": encode({
                        "entries": {u: entries[u] for u in chunk},
                        "count": len(chunk),
                        "syncedThrough": cursor,
                        "fullSyncAt": now,
                    })}}
        for n, chunk in enumerate(chunks)
    ]
    keep = {shard_id(n) for n in range(len(chunks))}
    writes += [fs.delete(path) for path, _ in fs.list("adminEmailIndex", mask=[]) if path.rsplit("/", 1)[-1] not in keep]
    if not args.dry_run:
        for w in writes:  # one shard (up to ~1 MiB) per commit
            fs.commit([w])
    print(f"{len(entries)} email(s) in {len(chunks)} shard(s){' (dry run)' if args.dry_run else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

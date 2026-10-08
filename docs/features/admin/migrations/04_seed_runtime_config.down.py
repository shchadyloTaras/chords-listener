"""04 down: delete ``adminConfig/settings`` and ``publicStatus/current``.

Loses whatever an admin changed in them (limits, switches, banner); the server falls back to the env
defaults. Run only together with rolling back the code that reads them.
"""
from __future__ import annotations

import argparse

from _fsrest import Rest
from app.models import Settings

PATHS = ["adminConfig/settings", "publicStatus/current"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    fs = Rest(Settings.from_env().firebase_project)
    if not args.dry_run:
        fs.commit([fs.delete(p) for p in PATHS])  # deleting a missing document is not an error
    print(f"{'would delete' if args.dry_run else 'deleted'}: {', '.join(PATHS)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

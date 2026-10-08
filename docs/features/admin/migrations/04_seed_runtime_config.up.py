"""04 up: create ``adminConfig/settings`` and ``publicStatus/current`` from the env defaults, if absent.

Bootstrap seed (ADR-0005): ``CHORDS_QUOTA_*`` / ``CHORDS_MAX_*`` become the first values of the documents;
every switch starts in its current behaviour (no pause, YouTube and vocals enabled) and the banner is off (with valid placeholder texts).
Each document is created with ``exists=false``, so a re-run never overwrites what an admin changed.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone

from _fsrest import Rest, already_exists
from app.admin.settings import PLACEHOLDER_BANNER
from app.firestore import IndexError_
from app.models import Settings

# Contract (openapi Banner): uk/en are 1-250 characters even while the banner is off, so the seed is the server's own
# placeholder (a short maintenance notice, validated through BannerIn): the same banner GET /settings answers while
# there is none. It stays disabled until an admin publishes.
BANNER = PLACEHOLDER_BANNER.model_dump()

SWITCHES = {"analysesPaused": False, "youtubeEnabled": True, "vocalsEnabled": True}


def clamp(value: float, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(round(value))))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    s = Settings.from_env()
    now = datetime.now(timezone.utc)
    docs = {
        "adminConfig/settings": {
            # Ranges of AC-25; an env value outside them is clamped (the admin UI could not save it either).
            "limits": {
                "analyses": clamp(s.quota_analyses, 1, 1000),
                "vocals": clamp(s.quota_vocals, 1, 150),
                "jobs": clamp(s.max_user_jobs, 1, 4),
                "maxDurationMin": clamp(s.max_duration_min, 1, 120),
                "maxUploadMb": clamp(s.max_upload_mb, 1, 512),
            },
            "switches": dict(SWITCHES),
            "updatedBy": None,
            "updatedAt": now,
        },
        "publicStatus/current": {
            "banner": dict(BANNER),
            "switches": dict(SWITCHES),
            "updatedAt": now,
        },
    }
    fs = Rest(s.firebase_project)
    for path, data in docs.items():
        if args.dry_run:
            print(f"would create {path} if absent: {data}")
            continue
        try:
            fs.commit([fs.create(path, data)])
            print(f"created {path}")
        except IndexError_ as exc:
            if not already_exists(exc):
                raise
            print(f"{path} already exists, left as is")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

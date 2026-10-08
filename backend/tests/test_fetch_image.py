"""The chords-fetch image (backend/fetch.Dockerfile) pins what backend/uv.lock locks: yt-dlp must move in step with
the API's (YouTube changes often), the rest so both run the same code. It copies only what the service imports."""
from __future__ import annotations

import re
import tomllib
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
DOCKERFILE = BACKEND / "fetch.Dockerfile"


def locked(name: str) -> str:
    lock = tomllib.loads((BACKEND / "uv.lock").read_text())
    return next(p["version"] for p in lock["package"] if p["name"] == name)


def test_fetch_image_pins_the_locked_versions() -> None:
    text = DOCKERFILE.read_text()
    ytdlp = re.search(r"^ARG YTDLP_VERSION=(\S+)$", text, re.M)
    assert ytdlp and ytdlp.group(1) == locked("yt-dlp")
    pins = dict(re.findall(r'"([a-z0-9-]+)(?:\[[a-z]+\])?==([0-9][^"]*)"', text))
    assert pins == {name: locked(name) for name in ("fastapi", "uvicorn", "google-cloud-storage", "google-auth")}


def test_fetch_image_copies_only_what_the_service_imports() -> None:
    copy = re.search(r"^COPY ((?:app/\S+ )+)\./app/$", DOCKERFILE.read_text(), re.M)
    assert copy
    copied = set(copy.group(1).split())
    assert copied == {"app/__init__.py", "app/models.py", "app/sources.py", "app/gcs.py", "app/warp.py", "app/fetch_service.py"}
    for name in copied:  # ... and those modules import nothing else of the app
        imports = set(re.findall(r"^from \.(\w+) import", (BACKEND / name).read_text(), re.M))
        assert {f"app/{m}.py" for m in imports} <= copied, name


def test_cloud_build_upload_includes_the_fetch_dockerfile() -> None:
    assert "!/fetch.Dockerfile" in (BACKEND / ".gcloudignore").read_text().splitlines()

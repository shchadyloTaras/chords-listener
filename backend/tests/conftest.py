"""Shared pytest setup: make the ``app`` package importable when running ``uv run pytest`` from backend/."""
from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def pytest_configure(config) -> None:
    # starlette.testclient warns that it still uses httpx; irrelevant for these tests.
    config.addinivalue_line("filterwarnings", "ignore:Using `httpx` with `starlette.testclient`")

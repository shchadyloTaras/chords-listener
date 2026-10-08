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


# ---------------------------------------------------------------- admin fixtures (docs/features/admin, T02)
import os  # noqa: E402

import pytest  # noqa: E402

EMULATOR_PROJECT = "build-chords-listener"


@pytest.fixture
def admin_db():
    """A ``FirestoreIndex`` on the Firestore emulator (``FIRESTORE_EMULATOR_HOST``); skips when there is none."""
    host = os.environ.get("FIRESTORE_EMULATOR_HOST")
    if not host:
        pytest.skip("needs the Firestore emulator (FIRESTORE_EMULATOR_HOST)")
    from app.firestore import FirestoreIndex

    return FirestoreIndex(EMULATOR_PROJECT, emulator_host=host)


@pytest.fixture
def read_counter(monkeypatch):
    """Counts the Firestore document reads of every client for the test (NFR: at most 200 reads per request)."""
    from admin.fixtures import ReadCounter

    counter = ReadCounter()
    counter.install(monkeypatch)
    return counter

"""Fixtures of the admin API tests (the helpers they use live in ``fixtures.py``)."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Callable, Optional

import pytest
from fastapi.testclient import TestClient

from admin.fixtures import (
    ADMIN_EMAIL,
    BOSS,
    DEFAULT_LIMITS,
    ENGINE_INFO,
    LOGIN_AT,
    Clock,
    FakeVerifier,
    H,
    UsersDb,
    make_admin,
    make_user,
    never,
    settings_for,
)
from app.admin.router import get_services
from app.main import create_app


@pytest.fixture
def world(tmp_path: Path):
    """``world()`` builds the real app (admin router, allowlist authz, audit writer, email-index directory, runtime
    settings) over a ``UsersDb`` holding the admin ``BOSS`` and the default limits. Firebase Auth's last sign-in is
    faked: ``login(uid)``."""
    clients: list[TestClient] = []

    def build(login: Callable[[str], Optional[datetime]] = lambda uid: LOGIN_AT) -> SimpleNamespace:
        db = UsersDb()
        db.put(make_admin(BOSS), make_user(BOSS, ADMIN_EMAIL))
        db.docs["adminConfig/settings"] = {
            "limits": dict(DEFAULT_LIMITS),
            "switches": {"analysesPaused": False, "youtubeEnabled": True, "vocalsEnabled": True},
            "updatedBy": None, "updatedAt": "2026-10-01T00:00:00Z",
        }
        app = create_app(
            settings_for(tmp_path), analyzer=never, engine_info_fn=lambda: ENGINE_INFO,
            token_verifier=FakeVerifier(Clock()), admin_db=db,
        )
        services = get_services(app)
        services.last_login = login
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return SimpleNamespace(
            db=db, app=app, client=client, services=services, data=tmp_path / "data",
            get=lambda path, who=BOSS, **kw: client.get(path, headers=H(who), **kw),
        )

    yield build
    for c in clients:
        c.__exit__(None, None, None)

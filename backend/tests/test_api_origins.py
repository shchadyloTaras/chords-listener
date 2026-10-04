"""Cross-origin access: the GitHub Pages build of the UI talks to the local server (CORS, the cross-site
guard and Chrome's Private Network Access preflight). Offline and fast: no media, no engine."""
from __future__ import annotations

from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models import DEFAULT_ALLOWED_ORIGINS, Settings, normalize_origin

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

PAGES = "https://shchadylotaras.github.io"
ENGINE_INFO = {"name": "fake", "version": "1.0", "features": {}}
LOCAL = "http://localhost:8765"


def _never_called(*_: Any, **__: Any) -> dict:
    raise AssertionError("the engine must not run in these tests")


@pytest.fixture
def make_client(tmp_path: Path) -> Iterator[Any]:
    clients: list[TestClient] = []

    def factory(**overrides: Any) -> TestClient:
        settings = Settings(
            data_dir=tmp_path / "data",
            frontend_dist=tmp_path / "no-dist",
            allowed_hosts=overrides.pop("allowed_hosts", ("localhost", "127.0.0.1", "::1")),
            **overrides,
        )
        app = create_app(settings, analyzer=_never_called, engine_info_fn=lambda: ENGINE_INFO)
        client = TestClient(app, base_url=LOCAL)
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for c in clients:
        c.__exit__(None, None, None)


def preflight(client: TestClient, origin: str, *, pna: bool = True, method: str = "POST") -> Any:
    headers = {
        "Origin": origin,
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": "content-type",
    }
    if pna:
        headers["Access-Control-Request-Private-Network"] = "true"
    return client.options("/api/jobs", headers=headers)


# --------------------------------------------------------------------------- settings


def test_default_origins_include_github_pages_and_vite() -> None:
    assert PAGES in DEFAULT_ALLOWED_ORIGINS
    assert "http://localhost:5173" in DEFAULT_ALLOWED_ORIGINS
    assert Settings().allowed_origins == DEFAULT_ALLOWED_ORIGINS


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("https://ShchadyloTaras.github.io/", PAGES),
        ("https://example.com:443/some/path", "https://example.com"),
        ("http://localhost:80", "http://localhost"),
        ("http://localhost:5184", "http://localhost:5184"),
    ],
)
def test_normalize_origin(raw: str, expected: str) -> None:
    assert normalize_origin(raw) == expected


def test_allowed_origins_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHORDS_ALLOWED_ORIGINS", " https://a.example/ , *, https://b.example:8443 ,")
    assert Settings.from_env().allowed_origins == ("https://a.example", "https://b.example:8443")
    monkeypatch.setenv("CHORDS_ALLOWED_ORIGINS", "")
    assert Settings.from_env().allowed_origins == DEFAULT_ALLOWED_ORIGINS


# --------------------------------------------------------------------------- CORS + PNA


def test_pages_origin_reads_the_api(make_client) -> None:
    c = make_client()
    res = c.get("/api/health", headers={"Origin": PAGES})
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == PAGES
    # audio is fetched into a blob when the browser refuses to stream it cross-origin
    assert c.get("/api/tracks/0123456789ab/audio", headers={"Origin": PAGES}).headers.get(
        "access-control-allow-origin"
    ) == PAGES


def test_pages_preflight_allows_private_network_access(make_client) -> None:
    c = make_client()
    res = preflight(c, PAGES)
    assert res.status_code == 200, res.text
    assert res.headers["access-control-allow-origin"] == PAGES
    assert res.headers["access-control-allow-private-network"] == "true"
    assert "POST" in res.headers["access-control-allow-methods"]

    plain = preflight(c, PAGES, pna=False, method="PATCH")
    assert plain.status_code == 200
    assert "access-control-allow-private-network" not in plain.headers


@pytest.mark.parametrize("origin", ["http://localhost:5184", "http://127.0.0.1:4173", "http://localhost:5173"])
def test_local_dev_origins_any_port(make_client, origin: str) -> None:
    c = make_client()
    res = preflight(c, origin)
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == origin
    assert res.headers["access-control-allow-private-network"] == "true"
    assert c.get("/api/health", headers={"Origin": origin}).headers["access-control-allow-origin"] == origin


@pytest.mark.parametrize("origin", ["https://evil.example", "https://shchadylotaras.github.io.evil.example", "null"])
def test_foreign_origins_get_nothing(make_client, origin: str) -> None:
    c = make_client()
    res = preflight(c, origin)
    # Starlette rejects the preflight; without Access-Control-Allow-Origin the browser blocks the request
    # (whatever the private-network header says).
    assert res.status_code == 400 and "Disallowed CORS origin" in res.text
    assert "access-control-allow-origin" not in res.headers
    assert "access-control-allow-origin" not in c.get("/api/health", headers={"Origin": origin}).headers


# --------------------------------------------------------------------------- cross-site (CSRF) guard


def test_pages_origin_passes_the_cross_site_guard(make_client) -> None:
    c = make_client()
    res = c.post("/api/jobs", json={"url": "not a url"}, headers={"Origin": PAGES})
    assert res.status_code == 400 and res.json()["code"] == "invalid_url"  # guard passed, validation failed
    assert res.headers["access-control-allow-origin"] == PAGES
    patch = c.patch("/api/tracks/0123456789ab", json={"title": "x"}, headers={"Origin": PAGES})
    assert patch.status_code == 404 and patch.json()["code"] == "not_found"


@pytest.mark.parametrize(
    "origin", ["https://evil.example", "http://shchadylotaras.github.io", "https://other.github.io", "null"]
)
def test_other_origins_are_still_rejected(make_client, origin: str) -> None:
    c = make_client()
    for res in (
        c.post("/api/jobs", json={"url": "https://youtu.be/dQw4w9WgXcQ"}, headers={"Origin": origin}),
        c.delete("/api/tracks/0123456789ab", headers={"Origin": origin}),
        c.post("/api/jobs/upload", files={"file": ("a.mp3", b"x", "audio/mpeg")}, headers={"Origin": origin}),
    ):
        assert res.status_code == 403, res.text
        assert res.json()["code"] == "internal"


def test_custom_origin_list_replaces_the_default(make_client) -> None:
    c = make_client(allowed_origins=("https://mirror.example",))
    assert c.post("/api/jobs", json={"url": "x"}, headers={"Origin": PAGES}).status_code == 403
    ok = c.post("/api/jobs", json={"url": "x"}, headers={"Origin": "https://mirror.example"})
    assert ok.status_code == 400 and ok.json()["code"] == "invalid_url"
    assert preflight(c, "https://mirror.example").headers["access-control-allow-private-network"] == "true"
    # local pages keep working whatever the list says
    assert c.post("/api/jobs", json={"url": "x"}, headers={"Origin": "http://localhost:5173"}).status_code == 400


def test_host_check_still_applies_to_allowed_origins(make_client) -> None:
    c = make_client()
    rebound = c.get("/api/health", headers={"Origin": PAGES, "Host": "attacker.example"})
    assert rebound.status_code == 400 and rebound.json()["code"] == "internal"

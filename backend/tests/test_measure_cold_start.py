"""``scripts/measure_cold_start.py`` (docs/features/admin NFR «сервер спав — p95 ≤ 15 с», docs/CLOUD.md): the parts that
run without the cloud - the percentile, the dry run (nothing sent), the admin token taken from the environment only and
never printed, and one real timing loop against a local test server.
"""
from __future__ import annotations

import base64
import importlib.util
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "measure_cold_start.py"


@pytest.fixture(scope="module")
def script() -> Any:
    spec = importlib.util.spec_from_file_location("measure_cold_start_script", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _token(exp_in_s: int) -> str:
    part = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")  # noqa: E731
    return f"{part({'alg': 'none'})}.{part({'exp': int(time.time()) + exp_in_s, 'sub': 'admin'})}.sig"


@pytest.fixture
def server() -> Iterator[tuple[str, list[dict[str, str]]]]:
    """A local HTTP server that answers 200 and records each request's path and Authorization header."""
    seen: list[dict[str, str]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            seen.append({"path": self.path, "auth": self.headers.get("Authorization", "")})
            body = b'{"ok": true}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: Any) -> None:
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}", seen
    finally:
        httpd.shutdown()


def test_p95_is_the_nearest_rank(script):
    assert script.p95([3.0, 1.0, 5.0, 2.0, 4.0]) == 5.0  # 5 attempts: the slowest
    assert script.p95([float(i) for i in range(1, 21)]) == 19.0  # 20 values: the 19th


def test_dry_run_sends_nothing(script, monkeypatch, capsys):
    monkeypatch.setattr(script.urllib.request, "urlopen", lambda *a, **k: pytest.fail("a request was sent"))
    assert script.main(["--dry-run"], env={}) == 0
    out = capsys.readouterr().out
    assert "/api/health" in out and "5 attempt(s)" in out and "dry run: nothing sent" in out


def test_admin_needs_a_token_from_the_environment(script, capsys):
    assert script.main(["--dry-run", "--admin"], env={}) == 2
    assert "CHORDS_ADMIN_REFRESH_TOKEN" in capsys.readouterr().err


def test_a_short_lived_id_token_is_flagged_and_never_printed(script, capsys):
    token = _token(exp_in_s=3600)
    assert script.main(["--dry-run", "--admin"], env={"CHORDS_ADMIN_ID_TOKEN": token}) == 0
    out = capsys.readouterr().out
    assert "expires before the last attempt" in out  # 5 × 20 min > 1 h
    assert token not in out and token.split(".")[1] not in out


def test_times_each_attempt_and_passes_under_the_bound(script, server, capsys):
    url, seen = server
    token = _token(exp_in_s=3600)
    code = script.main(["--url", url, "--admin", "--attempts", "3", "--idle-min", "0"], env={"CHORDS_ADMIN_ID_TOKEN": token})
    out = capsys.readouterr().out
    assert code == 0
    assert [s["path"] for s in seen] == ["/api/admin/overview"] * 3
    assert all(s["auth"] == f"Bearer {token}" for s in seen)
    assert "p95 = " in out and "PASS" in out
    assert token not in out


def test_fails_over_the_bound(script, server, capsys):
    url, _ = server
    assert script.main(["--url", url, "--attempts", "2", "--idle-min", "0", "--bound-s", "0"], env={}) == 1
    assert "FAIL" in capsys.readouterr().out

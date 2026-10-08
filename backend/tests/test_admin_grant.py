"""The owner's grant script, the max-instances guard, the scheduler jobs and the alerts (docs/features/admin T26).

* ``scripts/admin_grant.py grant|revoke <email|uid>`` writes / deletes ``adminAllowlist/{uid}`` with the owner's
  ADC (ADR-0006); it resolves an email to a uid through Firebase Auth and never stores the email. Tested against
  the Firestore emulator (and the Auth emulator for the email form); the rest runs on fakes.
* The server has no write path to the allowlist (grep test over ``backend/app``).
* ``scripts/deploy_cloud.sh`` refuses ``max-instances`` other than 1, creates the two Cloud Scheduler jobs
  (00:15 / 12:15 UTC, OIDC as ``chords-scheduler@``) and defines the log-based metrics and alerts; ``DRY_RUN=1``
  prints that plan without touching Google Cloud.
* The server logs a warning at start-up when the instance cap is not 1 (AC-32 / sad §11).

Skipped parts: the emulator tests need ``FIRESTORE_EMULATOR_HOST``, the email form ``FIREBASE_AUTH_EMULATOR_HOST``.
"""
from __future__ import annotations

import importlib.util
import json
import logging
import os
import re
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from admin.fixtures import MemDb
from app.admin.authz import AdminAuthz
from app.firestore import FirestoreIndex
from app.main import create_app
from app.models import Settings

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "admin_grant.py"
DEPLOY = ROOT / "scripts" / "deploy_cloud.sh"
APP_DIR = ROOT / "backend" / "app"
FS_HOST = os.environ.get("FIRESTORE_EMULATOR_HOST")
AUTH_HOST = os.environ.get("FIREBASE_AUTH_EMULATOR_HOST")
PROJECT = "build-chords-listener"
NOW = datetime(2026, 10, 7, 12, 0, 0, tzinfo=timezone.utc)
NOW_STORED = "2026-10-07T12:00:00Z"  # a timestamp as ``MemDb`` (like Firestore) hands it back

needs_firestore = pytest.mark.skipif(not FS_HOST, reason="needs the Firestore emulator (FIRESTORE_EMULATOR_HOST)")
needs_auth = pytest.mark.skipif(not (FS_HOST and AUTH_HOST),
                                reason="needs the Firestore and Auth emulators (FIREBASE_AUTH_EMULATOR_HOST)")


def load_script() -> Any:
    assert SCRIPT.is_file(), f"{SCRIPT} is missing"
    spec = importlib.util.spec_from_file_location("admin_grant_script", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeLookup:
    """Stands in for the Identity Toolkit ``accounts:lookup`` call: email -> (uid, verified); every address it knows
    is verified unless listed in ``unverified``."""

    def __init__(self, accounts: dict[str, str], unverified: frozenset[str] = frozenset()) -> None:
        self.accounts = accounts
        self.unverified = unverified
        self.asked: list[str] = []

    def uid_for_email(self, email: str):
        self.asked.append(email)
        uid = self.accounts.get(email.lower())
        return (uid, email.lower() not in self.unverified) if uid else (None, False)


# ------------------------------------------------------------------------------------------------- script, offline


def test_grant_writes_the_allowlist_document_with_a_timestamp_and_the_note():
    script, db = load_script(), MemDb()
    code = script.run(["grant", "uid-1", "--note", "co-owner"], db=db, lookup=FakeLookup({}), now=NOW)
    assert code == 0
    assert db.docs == {"adminAllowlist/uid-1": {"grantedAt": NOW_STORED, "note": "co-owner"}}


def test_grant_without_a_note_stores_null():
    script, db = load_script(), MemDb()
    script.run(["grant", "uid-1"], db=db, lookup=FakeLookup({}), now=NOW)
    assert db.docs["adminAllowlist/uid-1"] == {"grantedAt": NOW_STORED, "note": None}


def test_grant_by_email_resolves_the_uid_and_never_stores_the_email():
    script, db, lookup = load_script(), MemDb(), FakeLookup({"person@example.test": "uid-77"})
    code = script.run(["grant", "Person@Example.test", "--note", "ops"], db=db, lookup=lookup, now=NOW)
    assert code == 0 and lookup.asked == ["Person@Example.test"]
    assert list(db.docs) == ["adminAllowlist/uid-77"]
    assert "example.test" not in json.dumps(db.docs, default=str) and "@" not in json.dumps(db.docs, default=str)


def test_an_email_without_an_account_grants_nothing_and_fails(capsys):
    script, db = load_script(), MemDb()
    code = script.run(["grant", "nobody@example.test"], db=db, lookup=FakeLookup({}), now=NOW)
    assert code != 0 and db.docs == {} and db.commits == 0
    assert "no account" in capsys.readouterr().err.lower()


def test_a_note_that_looks_like_an_email_or_is_too_long_is_refused(capsys):
    script, db = load_script(), MemDb()
    assert script.run(["grant", "uid-1", "--note", "me@example.test"], db=db, lookup=FakeLookup({}), now=NOW) != 0
    assert script.run(["grant", "uid-1", "--note", "x" * 201], db=db, lookup=FakeLookup({}), now=NOW) != 0
    assert db.docs == {} and db.commits == 0
    assert script.run(["grant", "uid-1", "--note", "x" * 200], db=db, lookup=FakeLookup({}), now=NOW) == 0


def test_granting_twice_keeps_the_first_grant_time():
    script, db = load_script(), MemDb()
    script.run(["grant", "uid-1", "--note", "first"], db=db, lookup=FakeLookup({}), now=NOW)
    later = datetime(2026, 11, 1, tzinfo=timezone.utc)
    assert script.run(["grant", "uid-1", "--note", "second"], db=db, lookup=FakeLookup({}), now=later) == 0
    assert db.docs["adminAllowlist/uid-1"] == {"grantedAt": NOW_STORED, "note": "first"}


def test_revoke_deletes_the_document_and_is_a_no_op_when_there_is_none(capsys):
    script, db = load_script(), MemDb()
    script.run(["grant", "uid-1"], db=db, lookup=FakeLookup({}), now=NOW)
    assert script.run(["revoke", "uid-1"], db=db, lookup=FakeLookup({}), now=NOW) == 0
    assert db.docs == {}
    assert script.run(["revoke", "uid-1"], db=db, lookup=FakeLookup({}), now=NOW) == 0
    assert "not an admin" in capsys.readouterr().out.lower()


def test_revoke_by_email_resolves_the_uid():
    script, db = load_script(), MemDb()
    script.run(["grant", "uid-9"], db=db, lookup=FakeLookup({}), now=NOW)
    assert script.run(["revoke", "p@example.test"], db=db, lookup=FakeLookup({"p@example.test": "uid-9"}), now=NOW) == 0
    assert db.docs == {}


def test_a_uid_shaped_like_a_path_is_refused():
    script, db = load_script(), MemDb()
    assert script.run(["grant", "a/b"], db=db, lookup=FakeLookup({}), now=NOW) != 0
    assert db.docs == {}


# ------------------------------------------------------------------------------------------------- script, emulator


@pytest.fixture
def emulator_db() -> FirestoreIndex:
    return FirestoreIndex(PROJECT, emulator_host=FS_HOST)


@needs_firestore
def test_grant_then_revoke_on_the_emulator_and_the_server_follows_within_a_minute(emulator_db):
    script = load_script()
    uid = f"owner-test-{uuid.uuid4().hex[:10]}"
    clock = {"t": 1000.0}
    authz = AdminAuthz(emulator_db, clock=lambda: clock["t"])
    assert not authz.is_admin(uid)

    assert script.run(["grant", uid, "--note", "emulator"], db=emulator_db, lookup=FakeLookup({})) == 0
    doc = emulator_db.get(f"adminAllowlist/{uid}")
    assert doc is not None and doc.data["note"] == "emulator" and doc.data["grantedAt"] is not None
    clock["t"] += 61  # the cached "no" expires
    assert authz.is_admin(uid)

    assert script.run(["revoke", uid], db=emulator_db, lookup=FakeLookup({})) == 0
    assert emulator_db.get(f"adminAllowlist/{uid}") is None
    clock["t"] += 30
    assert authz.is_admin(uid)        # still inside the 60 s cache window
    clock["t"] += 31
    assert not authz.is_admin(uid)    # AC-32: refused no later than a minute after the revoke


@needs_auth
def test_grant_by_email_resolves_through_the_auth_emulator(emulator_db):
    import requests

    script = load_script()
    email = f"grant-{uuid.uuid4().hex[:10]}@example.test"
    sign_up = requests.post(
        f"http://{AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake",
        json={"email": email, "password": "not-a-real-secret-1"}, timeout=10)
    assert sign_up.status_code == 200, sign_up.text
    uid = sign_up.json()["localId"]
    # granting by email needs a verified address (e889edc); the Auth emulator marks one verified on request
    verify = requests.post(
        f"http://{AUTH_HOST}/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:update",
        headers={"Authorization": "Bearer owner"}, json={"localId": uid, "emailVerified": True}, timeout=10)
    assert verify.status_code == 200, verify.text
    try:
        assert script.run(["grant", email, "--project", PROJECT], db=emulator_db) == 0
        doc = emulator_db.get(f"adminAllowlist/{uid}")
        assert doc is not None and email not in json.dumps(doc.data, default=str)
        assert script.run(["revoke", email, "--project", PROJECT], db=emulator_db) == 0
        assert emulator_db.get(f"adminAllowlist/{uid}") is None
    finally:
        emulator_db.commit([emulator_db.delete_op(f"adminAllowlist/{uid}")])


# ------------------------------------------------------------------------------------------------- no server write path


def test_server_code_has_no_write_path_to_the_allowlist():
    """Only authz.py names the collection, and only to read it (ADR-0006: the owner's script is the one writer)."""
    needle = re.compile(r"adminAllowlist|ALLOWLIST_PATH", re.I)
    writers = re.compile(r"update_op|delete_op|\.commit\(|run_transaction|\.set\(|\.update\(|\.delete\(|\.create\(")
    mentions = {p.relative_to(APP_DIR).as_posix(): p.read_text() for p in APP_DIR.rglob("*.py")
                if needle.search(p.read_text())}
    assert set(mentions) == {"admin/authz.py"}, f"unexpected files name the allowlist: {sorted(mentions)}"
    authz = mentions["admin/authz.py"]
    assert not writers.search(authz), "authz.py must only read the allowlist"
    assert authz.count("ALLOWLIST_PATH") >= 1 and "self._db.get(ALLOWLIST_PATH" in authz


# ------------------------------------------------------------------------------------------------- deploy script


def run_deploy(tmp_path: Path, **env: str) -> subprocess.CompletedProcess:
    """``DRY_RUN=1 scripts/deploy_cloud.sh``: the guard and the ops plan, printed, with no call to Google Cloud.
    ``GCLOUD`` is a stub that fails loudly, so a dry run that reached for the real thing could not change anything."""
    stub = tmp_path / "gcloud"
    stub.write_text("#!/bin/sh\necho 'REAL GCLOUD CALLED' >&2\nexit 99\n")
    stub.chmod(0o755)
    base = {k: v for k, v in os.environ.items() if k not in {"MAX_INSTANCES", "DRY_RUN", "SKIP_SETUP", "SKIP_BUILD"}}
    return subprocess.run(["bash", str(DEPLOY)], env={**base, "GCLOUD": str(stub), "DRY_RUN": "1", **env},
                          capture_output=True, text=True, timeout=30, cwd=ROOT, stdin=subprocess.DEVNULL)


def test_deploy_script_is_valid_bash():
    res = subprocess.run(["bash", "-n", str(DEPLOY)], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr


def test_deploy_dry_run_shows_the_guard_and_both_scheduler_jobs(tmp_path):
    res = run_deploy(tmp_path)
    out = res.stdout
    assert res.returncode == 0, res.stderr
    assert "REAL GCLOUD CALLED" not in res.stderr
    assert "max-instances guard" in out.lower() and "1" in out
    jobs = [line for line in out.splitlines() if "scheduler jobs" in line and ("create" in line or "update" in line)]
    assert len(jobs) == 2, out
    assert any("--schedule" in j and "15 0 * * *" in j for j in jobs), jobs
    assert any("--schedule" in j and "15 12 * * *" in j for j in jobs), jobs
    for j in jobs:
        assert "--time-zone" in j and "UTC" in j
        assert "--oidc-service-account-email" in j and f"chords-scheduler@{PROJECT}.iam.gserviceaccount.com" in j
        assert "--oidc-token-audience" in j
        assert "/api/internal/sweep" in j and "POST" in j


def test_deploy_dry_run_defines_the_log_metrics_and_alerts_for_overdue_deletions_and_stats_mismatch(tmp_path):
    out = run_deploy(tmp_path).stdout
    for name in ("deletion_overdue", "stats_mismatch"):
        assert re.search(rf"logging metrics (create|update) {name}\b", out), (name, out)
        assert re.search(rf"alpha monitoring policies create.*{name}|monitoring policies create.*{name}", out), (name, out)
    assert "textPayload" in out or "jsonPayload" in out


@pytest.mark.parametrize("cap", ["2", "0", "10", ""])
def test_deploy_refuses_a_max_instances_other_than_one(tmp_path, cap):
    res = run_deploy(tmp_path, MAX_INSTANCES=cap)
    assert res.returncode != 0
    assert "max-instances" in res.stderr.lower()
    assert "scheduler jobs" not in res.stdout  # nothing is planned, let alone run, past the guard


def test_deploy_pins_the_service_to_the_guarded_cap_and_tells_the_server():
    text = DEPLOY.read_text()
    assert re.search(r'--max-instances "\$MAX_INSTANCES"', text)
    assert "--max-instances 1" not in text, "the cap must come from the guarded variable"
    assert 'CHORDS_MAX_INSTANCES: "$MAX_INSTANCES"' in text
    assert "CHORDS_SCHEDULER_EMAIL" in text and "CHORDS_SCHEDULER_AUDIENCE" in text


# ------------------------------------------------------------------------------------------------- start-up warning


def test_instance_cap_warning_text():
    from app.main import instance_cap_warning

    assert instance_cap_warning({"CHORDS_MAX_INSTANCES": "1"}) is None
    assert instance_cap_warning({"CHORDS_MAX_INSTANCES": " 1 "}) is None
    for bad in ("2", "0", "many"):
        assert "max-instances" in (instance_cap_warning({"CHORDS_MAX_INSTANCES": bad}) or "").lower()
    assert instance_cap_warning({}) is not None  # not declared: the guard cannot be confirmed


def _cloud_app(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist", auth="firebase",
                        signing_key="test-signing-key-0123456789abcdef", publish=False)
    return create_app(settings, analyzer=lambda *_a, **_k: {}, token_verifier=object(), admin_db=MemDb(),
                      wake_sweep=False)


def test_the_server_warns_at_start_up_when_the_instance_cap_is_not_one(tmp_path, monkeypatch, caplog):
    monkeypatch.setenv("CHORDS_MAX_INSTANCES", "3")
    with caplog.at_level(logging.WARNING):
        with TestClient(_cloud_app(tmp_path)):
            pass
    warned = [r for r in caplog.records if r.levelno == logging.WARNING and "max-instances" in r.getMessage().lower()]
    assert len(warned) == 1


def test_the_server_stays_quiet_about_the_cap_when_it_is_one(tmp_path, monkeypatch, caplog):
    monkeypatch.setenv("CHORDS_MAX_INSTANCES", "1")
    with caplog.at_level(logging.WARNING):
        with TestClient(_cloud_app(tmp_path)):
            pass
    assert not [r for r in caplog.records if "max-instances" in r.getMessage().lower()]


def test_local_mode_does_not_warn_about_the_cap(tmp_path, monkeypatch, caplog):
    monkeypatch.delenv("CHORDS_MAX_INSTANCES", raising=False)
    settings = Settings(data_dir=tmp_path / "data", frontend_dist=tmp_path / "no-dist", publish=False)
    with caplog.at_level(logging.WARNING):
        with TestClient(create_app(settings, analyzer=lambda *_a, **_k: {})):
            pass
    assert not [r for r in caplog.records if "max-instances" in r.getMessage().lower()]


# ------------------------------------------------------------------------------------------ T48 (review S2-6, S2-7)


def _snapshot(res):
    headers = {k: v for k, v in res.headers.items() if k not in ("content-length", "allow")}
    return res.status_code, res.text, headers, sorted(res.headers.get("allow", "").replace(" ", "").split(","))


@pytest.mark.parametrize("path", ["/api/admin/me", "/api/admin/users", "/api/internal/sweep"])
def test_an_unauthenticated_options_to_admin_or_internal_routes_answers_like_an_unknown_route(tmp_path, path):
    client = TestClient(_cloud_app(tmp_path), base_url="http://localhost")
    unknown = client.options("/api/admin/zzz-unknown" if "admin" in path else "/api/internal/zzz-unknown")
    assert _snapshot(client.options(path)) == _snapshot(unknown)


PAGES = "https://shchadylotaras.github.io"   # where admin.html is served from


@pytest.mark.parametrize("path, method", [
    ("/api/admin/overview", "GET"),
    ("/api/admin/users/u1/restriction", "PUT"),
    ("/api/admin/users/u1/deletion", "POST"),
])
def test_the_admin_pages_real_preflight_passes_from_an_allowed_origin_only(tmp_path, path, method):
    """hiding the admin routes from OPTIONS (T48) must not break the admin page itself: its browser preflight
    (Origin + method + the Authorization header) gets 200 and the origin back; another origin gets 400 and none (T57)."""
    client = TestClient(_cloud_app(tmp_path), base_url="http://localhost")
    asks = {"Access-Control-Request-Method": method, "Access-Control-Request-Headers": "authorization,content-type"}
    for origin in (PAGES, "http://localhost:5173"):
        ok = client.options(path, headers={"Origin": origin, **asks})
        assert ok.status_code == 200, (origin, ok.text)
        assert ok.headers["access-control-allow-origin"] == origin
        assert method in ok.headers["access-control-allow-methods"]
        assert "authorization" in ok.headers["access-control-allow-headers"].lower()
    refused = client.options(path, headers={"Origin": "https://evil.example", **asks})
    assert refused.status_code == 400
    assert "access-control-allow-origin" not in refused.headers


def test_a_real_cors_preflight_still_works_for_normal_routes(tmp_path):
    client = TestClient(_cloud_app(tmp_path), base_url="http://localhost")
    res = client.options("/api/jobs", headers={"Origin": "http://localhost:5173",
                                               "Access-Control-Request-Method": "POST"})
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_grant_by_email_refuses_an_unverified_email_and_revoke_still_works(capsys):
    script, db = load_script(), MemDb()
    lookup = FakeLookup({"a@x.io": "uidA"}, frozenset({"a@x.io"}))
    assert script.run(["grant", "a@x.io"], db=db, lookup=lookup, now=NOW) == 1
    assert "not verified" in capsys.readouterr().err and db.docs == {}
    db.docs["adminAllowlist/uidA"] = {"grantedAt": NOW, "note": None}
    assert script.run(["revoke", "a@x.io"], db=db, lookup=lookup, now=NOW) == 0
    assert db.docs == {}
    assert script.run(["grant", "uidB"], db=db, lookup=lookup, now=NOW) == 0  # a uid argument is as before


class SilentLookup:
    """A lookup that finds the account but says nothing about its address being verified."""

    def uid_for_email(self, email: str):
        return ("uidS", None)


def test_grant_by_email_fails_closed_when_nothing_says_the_email_is_verified(capsys):
    script, db = load_script(), MemDb()
    assert script.run(["grant", "s@x.io"], db=db, lookup=SilentLookup(), now=NOW) == 1
    assert "not verified" in capsys.readouterr().err and db.docs == {} and db.commits == 0


class AuthAnswer:
    def __init__(self, body: dict) -> None:
        self.status_code, self._body, self.text = 200, body, ""

    def json(self) -> dict:
        return self._body


@pytest.mark.parametrize("user, verified", [
    ({"localId": "uidV", "emailVerified": True}, True),
    ({"localId": "uidV", "emailVerified": False}, False),
    ({"localId": "uidV"}, False),                                         # no flag at all: not verified
    ({"localId": "uidV", "emailVerified": "true"}, False),                # only a real true counts
])
def test_the_auth_lookup_reports_the_uid_and_whether_the_email_is_verified(user, verified, monkeypatch):
    monkeypatch.delenv("FIREBASE_AUTH_EMULATOR_HOST", raising=False)
    script = load_script()
    session = type("S", (), {"post": lambda self, url, **kw: AuthAnswer({"users": [user]})})()
    lookup = script.AuthEmailLookup("p1", session_factory=lambda: session)
    assert lookup.uid_for_email("v@x.io") == ("uidV", verified)


@needs_auth
def test_granting_an_unverified_email_through_the_auth_emulator_fails_and_writes_nothing(emulator_db, capsys):
    import requests

    script = load_script()
    email = f"grant-unverified-{uuid.uuid4().hex[:10]}@example.test"
    sign_up = requests.post(
        f"http://{AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake",
        json={"email": email, "password": "not-a-real-secret-1"}, timeout=10)
    assert sign_up.status_code == 200, sign_up.text
    uid = sign_up.json()["localId"]
    assert script.run(["grant", email, "--project", PROJECT], db=emulator_db) == 1
    assert "not verified" in capsys.readouterr().err
    assert emulator_db.get(f"adminAllowlist/{uid}") is None


#!/usr/bin/env python3
"""Cold-start latency of the deployed cloud API: NFR «огляд адмінки, сервер спав — p95 ≤ 15 с» (docs/features/admin).

    python3 scripts/measure_cold_start.py [--url URL] [--attempts 5] [--idle-min 20] [--admin] [--verify-cold]
                                          [--bound-s 15] [--dry-run]

Each attempt first waits until the service has scaled to zero, then times its first request, from sending it to the
whole answer. Cloud Run runs chords-api with min instances 0 and shuts an idle instance down after about 15 minutes
(docs/CLOUD.md "Verified"), so the wait is --idle-min minutes (default 20) during which this script sends nothing.
Anything else that wakes the service meanwhile (a visitor, the 00:15 / 12:15 UTC sweep) makes that attempt warm:
--verify-cold asks Cloud Logging (`gcloud logging read`, the owner's gcloud login) whether a new server process started
for the request, counts only the attempts where one did, and keeps trying (up to 2 × --attempts) until it has
--attempts of them. Without it every attempt is counted and reported as unverified.

What is timed:
  default    GET /api/health - public, the first answer of a new instance;
  --admin    GET /api/admin/overview as an admin - what opening the admin page waits for. The ID token comes from the
             environment, never from the command line, and is never printed:
               CHORDS_ADMIN_REFRESH_TOKEN  a Firebase refresh token of the admin (preferred: a fresh ID token is minted
                                           from it before each attempt, from securetoken.googleapis.com - that call
                                           does not touch the service);
               CHORDS_ADMIN_ID_TOKEN       an ID token as it is (valid for an hour only: enough for 2 attempts at 20 min).

Prints every attempt and the p95 (nearest rank: with 5 attempts, the slowest); exits 1 when the p95 is over --bound-s
or an attempt failed. --dry-run prints the plan and sends nothing. The whole run takes about attempts × idle-min
(5 × 20 min ≈ 1 h 40 min). Standard library only (+ gcloud for --verify-cold).
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

DEFAULT_URL = "https://chords-api-84488579848.europe-west1.run.app"
PROJECT = "build-chords-listener"
SERVICE = "chords-api"
# The site's public Firebase web API key (frontend/src/lib/firebaseConfig.ts): it identifies the project, it is not a
# secret. Needed to mint an ID token from a refresh token.
FIREBASE_API_KEY = "AIzaSyBL5s4iSoBMrQNIlpYA4WQSjP5tP_4xmUU"
TOKEN_URL = "https://securetoken.googleapis.com/v1/token?key={key}"
REQUEST_TIMEOUT_S = 120.0


def p95(values: list[float]) -> float:
    """Nearest-rank 95th percentile (5 values: the largest; 20 values: the 19th)."""
    ordered = sorted(values)
    return ordered[max(0, math.ceil(0.95 * len(ordered)) - 1)]


# --------------------------------------------------------------------------- the admin's token (never printed)


def _jwt_exp(token: str) -> Optional[float]:
    try:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        exp = claims.get("exp")
        return float(exp) if isinstance(exp, (int, float)) else None
    except Exception:  # noqa: BLE001 - not a JWT: let the server say so
        return None


class AdminToken:
    """An ID token for the admin variant, from CHORDS_ADMIN_REFRESH_TOKEN (minted per attempt) or CHORDS_ADMIN_ID_TOKEN."""

    def __init__(self, env: dict[str, str]) -> None:
        self._refresh = env.get("CHORDS_ADMIN_REFRESH_TOKEN", "").strip()
        self._id = env.get("CHORDS_ADMIN_ID_TOKEN", "").strip()
        self.key = env.get("CHORDS_FIREBASE_API_KEY", "").strip() or FIREBASE_API_KEY

    @property
    def source(self) -> Optional[str]:
        if self._refresh:
            return "CHORDS_ADMIN_REFRESH_TOKEN (a fresh ID token before each attempt)"
        if self._id:
            return "CHORDS_ADMIN_ID_TOKEN"
        return None

    def expires_at(self) -> Optional[float]:
        return None if self._refresh or not self._id else _jwt_exp(self._id)

    def get(self) -> str:
        if not self._refresh:
            return self._id
        body = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": self._refresh}).encode()
        req = urllib.request.Request(TOKEN_URL.format(key=self.key), data=body, method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                token = json.loads(res.read()).get("id_token")
        except urllib.error.HTTPError as exc:
            raise SystemExit(f"measure_cold_start: the refresh token was refused (HTTP {exc.code})") from None
        if not isinstance(token, str) or not token:
            raise SystemExit("measure_cold_start: no ID token came back for the refresh token")
        return token


# --------------------------------------------------------------------------- one timed request


def timed_get(url: str, token: Optional[str]) -> tuple[int, float]:
    """(HTTP status, seconds from sending the request to the end of the answer)."""
    headers = {"Accept": "application/json", "User-Agent": "chords-cold-start/1"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as res:
            res.read()
            status = res.status
    except urllib.error.HTTPError as exc:
        exc.read()
        status = exc.code
    return status, time.monotonic() - started


def started_instance(since: datetime, until: datetime, project: str, service: str) -> Optional[bool]:
    """Did a new server process of ``service`` start between ``since`` and ``until``? None when Cloud Logging can't
    be asked (no gcloud, no login)."""
    if not shutil.which("gcloud"):
        return None
    zulu = lambda t: t.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")  # noqa: E731
    query = (
        f'resource.type="cloud_run_revision" AND resource.labels.service_name="{service}" '
        f'AND textPayload:"Started server process" AND timestamp>="{zulu(since)}" AND timestamp<="{zulu(until)}"'
    )
    try:
        out = subprocess.run(
            ["gcloud", "logging", "read", query, "--project", project, "--limit", "5", "--format", "json"],
            check=True, capture_output=True, text=True, timeout=120,
        ).stdout
        return bool(json.loads(out or "[]"))
    except (subprocess.SubprocessError, ValueError):
        return None


# --------------------------------------------------------------------------- the run


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__.splitlines()[0], formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="\n".join(__doc__.splitlines()[2:]),
    )
    p.add_argument("--url", default=os.environ.get("CHORDS_API_URL", DEFAULT_URL), help=f"the service (default {DEFAULT_URL})")
    p.add_argument("--attempts", type=int, default=5, help="cold starts to time (default 5)")
    p.add_argument("--idle-min", type=float, default=20.0, help="minutes of silence before each attempt (default 20)")
    p.add_argument("--admin", action="store_true", help="time GET /api/admin/overview as an admin (token from the environment)")
    p.add_argument("--verify-cold", action="store_true", help="count only attempts Cloud Logging shows started a new instance")
    p.add_argument("--bound-s", type=float, default=15.0, help="the p95 bound in seconds (default 15)")
    p.add_argument("--project", default=PROJECT)
    p.add_argument("--service", default=SERVICE)
    p.add_argument("--dry-run", action="store_true", help="print the plan, send nothing")
    return p


def main(argv: list[str], env: Optional[dict[str, str]] = None) -> int:
    args = parser().parse_args(argv)
    env = dict(os.environ) if env is None else env
    if args.attempts < 1 or args.idle_min < 0:
        print("measure_cold_start: --attempts must be ≥ 1 and --idle-min ≥ 0", file=sys.stderr)
        return 2
    base = args.url.rstrip("/")
    path = "/api/admin/overview" if args.admin else "/api/health"
    token = AdminToken(env) if args.admin else None
    if token is not None and token.source is None:
        print("measure_cold_start: --admin needs CHORDS_ADMIN_REFRESH_TOKEN or CHORDS_ADMIN_ID_TOKEN in the environment",
              file=sys.stderr)
        return 2
    total_min = args.attempts * args.idle_min
    print(f"cold start of {base}{path}: {args.attempts} attempt(s), each after {args.idle_min:g} min without a request "
          f"(≈ {total_min:g} min in all); p95 bound {args.bound_s:g} s")
    if token is not None:
        print(f"admin token: from {token.source}")
        exp = token.expires_at()
        if exp is not None and exp < time.time() + total_min * 60:
            print("warning: CHORDS_ADMIN_ID_TOKEN expires before the last attempt - use CHORDS_ADMIN_REFRESH_TOKEN")
    print("cold check: " + ("Cloud Logging (gcloud logging read) after each attempt" if args.verify_cold
                            else "none (every attempt counted; add --verify-cold to confirm a new instance started)"))
    if args.dry_run:
        print("dry run: nothing sent")
        return 0

    times: list[float] = []
    failed = 0
    tries = 0
    max_tries = args.attempts * 2 if args.verify_cold else args.attempts
    while len(times) < args.attempts and tries < max_tries:
        tries += 1
        if args.idle_min:
            until = datetime.now() + timedelta(minutes=args.idle_min)
            print(f"[{tries}] waiting {args.idle_min:g} min for the service to scale to zero (until {until:%H:%M:%S})", flush=True)
            time.sleep(args.idle_min * 60)
        bearer = token.get() if token is not None else None
        sent = datetime.now(timezone.utc)
        status, seconds = timed_get(base + path, bearer)
        bearer = None
        if status != 200:
            failed += 1
            print(f"[{tries}] HTTP {status} after {seconds:.2f} s - not counted"
                  + (" (is the token an admin's, and still valid?)" if args.admin and status in (401, 404) else ""))
            continue
        cold: Optional[bool] = None
        if args.verify_cold:
            time.sleep(20)  # log entries arrive with a delay
            cold = started_instance(sent - timedelta(seconds=60), datetime.now(timezone.utc), args.project, args.service)
        if cold is False:
            print(f"[{tries}] {seconds:.2f} s - warm (no new instance started for it), not counted")
            continue
        times.append(seconds)
        if cold:
            label = "cold: confirmed"
        elif args.verify_cold:
            label = "cold: unverified (Cloud Logging did not answer)"
        else:
            label = "cold: assumed" if args.idle_min >= 15 else f"cold: unlikely after only {args.idle_min:g} min"
        print(f"[{tries}] {seconds:.2f} s (HTTP {status}, {label})", flush=True)

    if not times:
        print("no attempt could be counted")
        return 1
    worst = p95(times)
    verdict = "PASS" if worst <= args.bound_s and len(times) == args.attempts and not failed else "FAIL"
    print(f"cold starts (s): {', '.join(f'{t:.2f}' for t in times)}")
    print(f"p95 = {worst:.2f} s over {len(times)} attempt(s) (bound {args.bound_s:g} s): {verdict}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

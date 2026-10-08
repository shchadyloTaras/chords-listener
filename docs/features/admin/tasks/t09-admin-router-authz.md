---
id: T09
title: "Mount the admin router behind allowlist authz, 404-identical denial, probe rate limit and fresh-login check"
layer: "app"
deps: ["T01", "T03"]
acs: ["AC-31", "AC-32", "AC-34", "AC-36"]
files_hint: ["backend/app/admin/router.py", "backend/app/admin/authz.py", "backend/app/auth.py", "backend/app/main.py", "backend/tests/admin/test_authz.py"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Stage 1 — view"
status: "todo"
---

# T09 — Mount the admin router behind allowlist authz, 404-identical denial, probe rate limit and fresh-login check

**Blocked by:** [T01](./t01-firestore-client-batch-tx-query.md), [T03](./t03-admin-error-codes.md) · **ACs:** AC-31, AC-32, AC-34, AC-36 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[ADR-0006](../adr/0006-authorize-admins-via-firestore-allowlist-with-60s-cache.md); [sad §6 Cross-cutting: допуск до адмінського API](../sad.md); [sad §8](../sad.md) Authorization / Fresh login / Probe rate limit.

## What

`auth.py` exposes `auth_time`. `admin/authz.py`: allowlist `get` with 60 s cache, sliding 60 s counter for non-admins (process memory), `require_fresh_login(15 min)` dependency. `admin/router.py`: `APIRouter(prefix='/api/admin')` with the authz dependency; mounted in `main.py`. Log `admin_request` (route, status, duration).

Files: `backend/app/admin/router.py`, `backend/app/admin/authz.py`, `backend/app/auth.py`, `backend/app/main.py`, `backend/tests/admin/test_authz.py`

## Definition of Done

**A contract test iterates every /api/admin/* route and gets a response byte-identical to FastAPI's 404 for a non-admin, removing a uid from the allowlist denies within 60 s, the 31st non-admin request in 60 s is refused unprocessed, and auth_time older than 15 min yields reauth_required on fresh-login routes.**

- [ ] Contract test over all routes (a new route without the dependency fails CI)
- [ ] Allowlist removal → denial ≤ 60 s (time-mocked)
- [ ] Rate-limit test: admins exempt; user's normal routes unaffected
- [ ] `reauth_required` for stale `auth_time`
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Router file is shared by T15/T17–T23 — they add handlers; serialize via files_hint.

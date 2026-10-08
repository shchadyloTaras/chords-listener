---
id: T02
title: "Add admin test fixtures, hostile strings and an emulator seeder"
layer: "tests"
deps: ["T01"]
acs: ["AC-05"]
files_hint: ["backend/tests/admin/__init__.py", "backend/tests/admin/fixtures.py", "backend/tests/conftest.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Foundation"
status: "todo"
---

# T02 — Add admin test fixtures, hostile strings and an emulator seeder

**Blocked by:** [T01](./t01-firestore-client-batch-tx-query.md) · **ACs:** AC-05 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

Read-budget, search-latency and XSS checks need shared fixtures ([data-model.md](../data-model.md) §Test fixtures, [sad §10](../sad.md)).

## What

Factories `make_admin`, `make_user`, `make_tracks`, `make_account_state`, `make_job`, `make_stats_day`, `make_audit`, `seed_synthetic_users(n)` and the `HOSTILE_STRINGS` list, all on `example.test`. A pytest fixture that counts emulator reads per request (for the ≤ 200 reads NFR).

Files: `backend/tests/admin/__init__.py`, `backend/tests/admin/fixtures.py`, `backend/tests/conftest.py`

## Definition of Done

**Fixture factories from data-model §Test fixtures exist and a smoke test seeds 1 000 users × 20 tracks into the emulator.**

- [ ] `seed_synthetic_users(10_000)` completes in the emulator
- [ ] Read-counter fixture reports reads for one request
- [ ] No real emails or names in fixtures
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

PII guard: only `example.test` addresses.

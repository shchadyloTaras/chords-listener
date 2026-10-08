---
id: T12
title: "Hook projections into JobManager, accept the origin hint and discard results for tombstoned uids"
layer: "wiring"
deps: ["T11"]
acs: ["AC-01", "AC-19", "AC-22"]
files_hint: ["backend/app/jobs.py", "backend/app/main.py", "backend/tests/test_api.py", "backend/tests/test_api_origins.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 1 — view"
status: "todo"
---

# T12 — Hook projections into JobManager, accept the origin hint and discard results for tombstoned uids

**Blocked by:** [T11](./t11-history-stats-projections.md) · **ACs:** AC-01, AC-19, AC-22 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[sad §6 Проєкції з життєвого циклу задачі](../sad.md); origin hint added in [api-sync-report.md](../contracts/api-sync-report.md) Notes.

## What

`JobManager` calls `history.accept` at accept and `history.finish` at completion (synchronous, never fails the job). Add `origin` form/JSON field. Check `adminTombstones/{uid}` before writing results (late-job discard, ADR-0011).

Files: `backend/app/jobs.py`, `backend/app/main.py`, `backend/tests/test_api.py`, `backend/tests/test_api_origins.py`

## Definition of Done

**An API test shows an accepted job creates adminJobs + bumps today's counters, a finished job records the outcome, a job whose uid has a tombstone does not republish, and /api/jobs/upload and /api/jobs/storage accept origin file|mic (absent → file).**

- [ ] Accepted job visible in `adminJobs` with origin
- [ ] Projection failure does not fail the job
- [ ] Tombstoned uid → result not written
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Restriction never stops an accepted job (AC-19) — nothing in this hook checks restriction.

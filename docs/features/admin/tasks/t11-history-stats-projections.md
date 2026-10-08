---
id: T11
title: "Build job-history and daily-stats projections with the failure-reason map and the pending buffer"
layer: "app"
deps: ["T01", "T04"]
acs: ["AC-01", "AC-07", "AC-08"]
files_hint: ["backend/app/admin/history.py", "backend/app/admin/stats.py", "backend/tests/admin/test_projections.py"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Stage 1 — view"
status: "todo"
---

# T11 — Build job-history and daily-stats projections with the failure-reason map and the pending buffer

**Blocked by:** [T01](./t01-firestore-client-batch-tx-query.md), [T04](./t04-admin-models-validators.md) · **ACs:** AC-01, AC-07, AC-08 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[ADR-0004](../adr/0004-precompute-admin-read-model-in-firestore.md), [ADR-0010](../adr/0010-count-daily-stats-live-and-freeze-after-nightly-reconciliation.md); write rules in [data-model.md](../data-model.md) Aggregates 2–3.

## What

`history.accept(job)` / `history.finish(job)` as transactions (create `adminJobs/{id}` exists=false; `activeUsers/{uid}` marker; `increment` counters; finish increments `failed`/`failedByReason` only while `state == live`). `ErrorCode → reason` table with uk/en labels key. GCS leaf-locked buffer `<data>/admin/projections-pending.json` + `replay_pending()`.

Files: `backend/app/admin/history.py`, `backend/app/admin/stats.py`, `backend/tests/admin/test_projections.py`

## Definition of Done

**Unit+emulator tests show accept/finish are idempotent on replay, a frozen day never changes, ErrorCode maps to the fixed 7-reason list, the smoke uid is flagged service and excluded, and a failed write lands in projections-pending.json and replays.**

- [ ] Replay of accept/finish is a no-op
- [ ] Finish on a frozen day changes nothing
- [ ] Write failure → op buffered; `replay_pending` drains it
- [ ] `service == true` for `SMOKE_UID`
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Pure module; wiring into JobManager is T12.

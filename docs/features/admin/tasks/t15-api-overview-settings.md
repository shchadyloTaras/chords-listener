---
id: T15
title: "Serve getOverview and getSettings"
layer: "ports"
deps: ["T09", "T11", "T13"]
acs: ["AC-01"]
files_hint: ["backend/app/admin/router.py", "backend/tests/admin/test_api_overview.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 1 — view"
status: "todo"
---

# T15 — Serve getOverview and getSettings

**Blocked by:** [T09](./t09-admin-router-authz.md), [T11](./t11-history-stats-projections.md), [T13](./t13-runtime-settings-cache.md) · **ACs:** AC-01 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[spec §5](../spec.md#5-acceptance-criteria) AC-01; [sad §6 Огляд адмінки](../sad.md); schemas in [openapi.yaml](../contracts/openapi.yaml).

## What

Handlers in `admin/router.py`; `newUsers` via `count()` on `users.createdAt` for the live day.

Files: `backend/app/admin/router.py`, `backend/tests/admin/test_api_overview.py`

## Definition of Done

**getOverview returns today's UTC totals by origin, vocals, failed, active and new users, running jobs from JobManager and switch states within ≤ 200 emulator reads, and getSettings returns limits, switches and banner.**

- [ ] Response matches openapi `Overview` example
- [ ] Read counter ≤ 200
- [ ] Non-admin → 404 (covered by T09 contract test)
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

No server-side polling; the UI decides refresh (AC-02).

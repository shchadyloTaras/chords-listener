---
id: T18
title: "Serve listJobHistory and getStats"
layer: "ports"
deps: ["T09", "T11"]
acs: ["AC-07", "AC-08", "AC-09"]
files_hint: ["backend/app/admin/router.py", "backend/tests/admin/test_api_history.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 1 — view"
status: "todo"
---

# T18 — Serve listJobHistory and getStats

**Blocked by:** [T09](./t09-admin-router-authz.md), [T11](./t11-history-stats-projections.md) · **ACs:** AC-07, AC-08, AC-09 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[spec §5](../spec.md#5-acceptance-criteria) AC-07/08/09; [sad §6 Історія задач / Статистика](../sad.md).

## What

History: combined filters over the three composite indexes, cursor pages of 50, 7 reason `count()`s. Stats: ≤ 90 `get`s by day id; missing days → zeros.

Files: `backend/app/admin/router.py`, `backend/tests/admin/test_api_history.py`

## Definition of Done

**Filtering by status=error and origin=link returns only such jobs with per-reason counts, a period > 90 days or end < start returns invalid_period, and a 30-day range returns one entry per day with restored days flagged.**

- [ ] Per-reason counts match fixture
- [ ] Page ≤ 200 reads
- [ ] Restored day has no failure fields
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Period validator from T04 is shared with the history filter (G5).

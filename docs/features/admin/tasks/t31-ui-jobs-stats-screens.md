---
id: T31
title: "Build the job-history and statistics screens"
layer: "ui"
deps: ["T28"]
acs: ["AC-07", "AC-08", "AC-09"]
files_hint: ["frontend/src/admin/screens/Jobs.tsx", "frontend/src/admin/screens/Stats.tsx", "frontend/src/admin/screens/JobsStats.test.tsx"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Stage 1 — view"
status: "todo"
---

# T31 — Build the job-history and statistics screens

**Blocked by:** [T28](./t28-ui-admin-api-client.md) · **ACs:** AC-07, AC-08, AC-09 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[spec §5](../spec.md#5-acceptance-criteria) AC-07/08/09.

## What

Filter bar + paged table; stats as a per-day table (no chart library added).

Files: `frontend/src/admin/screens/Jobs.tsx`, `frontend/src/admin/screens/Stats.tsx`, `frontend/src/admin/screens/JobsStats.test.tsx`

## Definition of Done

**Component tests show filters by result/reason/origin/period with per-reason counts and plain-text error snippets, a period > 90 days or reversed is blocked with the explanation, and restored days are labelled «відновлено з пісень».**

- [ ] Restored-day label test
- [ ] Invalid period message test
- [ ] lint + type-check clean (ruff / oxlint + tsc)

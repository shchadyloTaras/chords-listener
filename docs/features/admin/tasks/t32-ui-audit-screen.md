---
id: T32
title: "Build the admin journal screen"
layer: "ui"
deps: ["T28"]
acs: ["AC-10", "AC-10b", "AC-11"]
files_hint: ["frontend/src/admin/screens/Audit.tsx", "frontend/src/admin/screens/Audit.test.tsx"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 1 — view"
status: "todo"
---

# T32 — Build the admin journal screen

**Blocked by:** [T28](./t28-ui-admin-api-client.md) · **ACs:** AC-10, AC-10b, AC-11 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[spec §5](../spec.md#5-acceptance-criteria) AC-10/10b/11.

## What

Paged list + filters; `before`/`after` rendered as text key/value pairs.

Files: `frontend/src/admin/screens/Audit.tsx`, `frontend/src/admin/screens/Audit.test.tsx`

## Definition of Done

**Component test shows records newest-first with who/when/target/before→after and outcome, purged targets as «видалений» without email, filters by admin/user/action, and no edit/delete control.**

- [ ] Rejected and view records displayed
- [ ] No mutating control
- [ ] lint + type-check clean (ruff / oxlint + tsc)

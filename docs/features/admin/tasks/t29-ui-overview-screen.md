---
id: T29
title: "Build the Overview screen"
layer: "ui"
deps: ["T28"]
acs: ["AC-01", "AC-02"]
files_hint: ["frontend/src/admin/screens/Overview.tsx", "frontend/src/admin/screens/Overview.test.tsx"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 1 — view"
status: "todo"
---

# T29 — Build the Overview screen

**Blocked by:** [T28](./t28-ui-admin-api-client.md) · **ACs:** AC-01, AC-02 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[spec §5](../spec.md#5-acceptance-criteria) AC-01/02; [sad §6 Огляд адмінки](../sad.md).

## What

Cards + table built from existing Tailwind tokens and `components/ui/*`.

Files: `frontend/src/admin/screens/Overview.tsx`, `frontend/src/admin/screens/Overview.test.tsx`

## Definition of Done

**Component test renders today's totals by origin, vocals, failed, active/new users, running jobs and switch states from a fixture, with a Refresh button and no auto-refresh.**

- [ ] Fixture render test
- [ ] Refresh triggers exactly one request
- [ ] lint + type-check clean (ruff / oxlint + tsc)

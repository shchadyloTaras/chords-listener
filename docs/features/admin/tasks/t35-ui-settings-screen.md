---
id: T35
title: "Build the service-settings screen: default limits, switches and maintenance banner"
layer: "ui"
deps: ["T28"]
acs: ["AC-24", "AC-25", "AC-26", "AC-28", "AC-29", "AC-30", "AC-34"]
files_hint: ["frontend/src/admin/screens/Settings.tsx", "frontend/src/admin/screens/Settings.test.tsx"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Stage 3 — service settings"
status: "todo"
---

# T35 — Build the service-settings screen: default limits, switches and maintenance banner

**Blocked by:** [T28](./t28-ui-admin-api-client.md) · **ACs:** AC-24, AC-25, AC-26, AC-28, AC-29, AC-30, AC-34 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[spec §5](../spec.md#5-acceptance-criteria) AC-24…30, AC-34.

## What

Three sections on one screen; banner preview renders as plain text.

Files: `frontend/src/admin/screens/Settings.tsx`, `frontend/src/admin/screens/Settings.test.tsx`

## Definition of Done

**Component tests show the limits form explains allowed ranges and points to the pause switch on 0, switches toggle with re-auth only for enabling the pause, and the banner editor enforces 1–250 chars in uk and en.**

- [ ] Range hints
- [ ] Pause re-auth path
- [ ] Banner length validation
- [ ] lint + type-check clean (ruff / oxlint + tsc)

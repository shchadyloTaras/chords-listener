---
id: T34
title: "Add restriction and scheduled-deletion actions to the user card"
layer: "ui"
deps: ["T33"]
acs: ["AC-16", "AC-17", "AC-20", "AC-21", "AC-23", "AC-23b", "AC-34", "AC-35"]
files_hint: ["frontend/src/admin/screens/UserCard.tsx", "frontend/src/admin/actions/RestrictionActions.tsx", "frontend/src/admin/actions/DeletionDialog.tsx", "frontend/src/admin/actions/RestrictionActions.test.tsx"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Stage 2 — user actions"
status: "todo"
---

# T34 — Add restriction and scheduled-deletion actions to the user card

**Blocked by:** [T33](./t33-ui-card-quota-limit-actions.md) · **ACs:** AC-16, AC-17, AC-20, AC-21, AC-23, AC-23b, AC-34, AC-35 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[spec §5](../spec.md#5-acceptance-criteria) AC-16/17/20/21/23/23b/34/35.

## What

Restriction reason dialog; deletion dialog with email confirm; state badge with date.

Files: `frontend/src/admin/screens/UserCard.tsx`, `frontend/src/admin/actions/RestrictionActions.tsx`, `frontend/src/admin/actions/DeletionDialog.tsx`, `frontend/src/admin/actions/RestrictionActions.test.tsx`

## Definition of Done

**Component tests show restrict needs a reason, deletion requires typing the user's email, during a scheduled deletion only «Скасувати видалення» is offered, and self_target / deletion_rate_limit / reauth_required responses show their explanations (re-login then retry).**

- [ ] Email mismatch message
- [ ] Re-auth path test
- [ ] lint + type-check clean (ruff / oxlint + tsc)

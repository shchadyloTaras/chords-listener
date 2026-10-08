---
id: T33
title: "Add quota reset and personal-limit actions to the user card"
layer: "ui"
deps: ["T30"]
acs: ["AC-12", "AC-13", "AC-14", "AC-15"]
files_hint: ["frontend/src/admin/screens/UserCard.tsx", "frontend/src/admin/actions/LimitForm.tsx", "frontend/src/admin/actions/LimitForm.test.tsx"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 2 — user actions"
status: "todo"
---

# T33 — Add quota reset and personal-limit actions to the user card

**Blocked by:** [T30](./t30-ui-users-search-card.md) · **ACs:** AC-12, AC-13, AC-14, AC-15 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[spec §5](../spec.md#5-acceptance-criteria) AC-12…15.

## What

Confirm via `components/ui/Modal.tsx`; form uses existing input styles.

Files: `frontend/src/admin/screens/UserCard.tsx`, `frontend/src/admin/actions/LimitForm.tsx`, `frontend/src/admin/actions/LimitForm.test.tsx`

## Definition of Done

**Component tests show reset updates the card counters, the limit form shows the allowed range next to each invalid field (from details.fields and client checks), and an expired limit shows «завершився».**

- [ ] Per-field errors
- [ ] Remove limit action
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Shares UserCard.tsx with T34 — serialized.

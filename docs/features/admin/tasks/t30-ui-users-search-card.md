---
id: T30
title: "Build user search, the user card and paged songs (metadata only)"
layer: "ui"
deps: ["T28"]
acs: ["AC-03", "AC-04", "AC-05", "AC-06"]
files_hint: ["frontend/src/admin/screens/Users.tsx", "frontend/src/admin/screens/UserCard.tsx", "frontend/src/admin/screens/UserCard.test.tsx"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Stage 1 — view"
status: "todo"
---

# T30 — Build user search, the user card and paged songs (metadata only)

**Blocked by:** [T28](./t28-ui-admin-api-client.md) · **ACs:** AC-03, AC-04, AC-05, AC-06 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[spec §5](../spec.md#5-acceptance-criteria) AC-03…06; [ADR-0002](../adr/0002-ship-admin-ui-as-separate-strict-csp-entry.md).

## What

Search input + results; card: registration, last login, songs count, storage, quota vs limit, personal limit (incl. «завершився»), state; songs table with pager; recent jobs with reason labels.

Files: `frontend/src/admin/screens/Users.tsx`, `frontend/src/admin/screens/UserCard.tsx`, `frontend/src/admin/screens/UserCard.test.tsx`

## Definition of Done

**Component tests show < 3 chars prompts for 3 without a request, no matches shows «Нікого не знайдено», HOSTILE_STRINGS titles/emails/errors render verbatim as text with no script executed, songs page by 50 newest-first, and no open/play control exists.**

- [ ] Hostile-strings render test
- [ ] No link/button to audio or chords
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Card actions are T33/T34.

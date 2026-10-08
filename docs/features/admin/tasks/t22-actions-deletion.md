---
id: T22
title: "Implement scheduleDeletion and cancelDeletion with email confirm, fresh login and the 10-per-60-min cap"
layer: "app"
deps: ["T21"]
acs: ["AC-17", "AC-20", "AC-21", "AC-23", "AC-34", "AC-35"]
files_hint: ["backend/app/admin/actions.py", "backend/app/admin/router.py", "backend/tests/admin/test_actions_deletion.py"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Stage 2 — user actions"
status: "todo"
---

# T22 — Implement scheduleDeletion and cancelDeletion with email confirm, fresh login and the 10-per-60-min cap

**Blocked by:** [T21](./t21-actions-restriction.md) · **ACs:** AC-17, AC-20, AC-21, AC-23, AC-34, AC-35 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[sad §6 Запланувати / Скасувати видалення](../sad.md); [spec §5](../spec.md#5-acceptance-criteria) AC-20/21/23/34/35.

## What

Schedule: fresh-login dependency → email compare (case-insensitive) → in-process lock + `count()` of `deletion_scheduled`/`applied` in the last 60 min → transaction (deletion + restriction + audit). Cancel: within window only, else `not_scheduled` (journaled). **Resolves OQ-API-2:** when there was no prior restriction, `restriction.reason` = fixed server text `Scheduled deletion` (keeps reason non-null 1–500; `priorRestriction: null`).

Files: `backend/app/admin/actions.py`, `backend/app/admin/router.py`, `backend/tests/admin/test_actions_deletion.py`

## Definition of Done

**Tests show schedule sets purgeAfter = +7 d and an immediate restriction while saving the prior restriction, a wrong email → confirm_email_mismatch (not journaled), stale login → reauth_required, the 11th schedule in 60 min across admins → deletion_rate_limit (journaled), and cancel restores the prior restriction exactly.**

- [ ] Already scheduled → `deletion_pending`, journaled rejected (G3)
- [ ] Self → `self_target`
- [ ] Cancel with no prior restriction → no restriction
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

OQ-API-2 default chosen here — confirm with the owner before implement.

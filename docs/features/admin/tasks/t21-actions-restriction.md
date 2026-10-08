---
id: T21
title: "Implement restrictUser and unrestrictUser as transactions with the audit record"
layer: "app"
deps: ["T20"]
acs: ["AC-10b", "AC-16", "AC-17", "AC-19", "AC-23b", "AC-33"]
files_hint: ["backend/app/admin/actions.py", "backend/app/admin/router.py", "backend/tests/admin/test_actions_restriction.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 2 — user actions"
status: "todo"
---

# T21 — Implement restrictUser and unrestrictUser as transactions with the audit record

**Blocked by:** [T20](./t20-actions-quota-personal-limit.md) · **ACs:** AC-10b, AC-16, AC-17, AC-19, AC-23b, AC-33 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[sad §6 Critical flow 1 / Зняття хмарного обмеження](../sad.md); [spec §5](../spec.md#5-acceptance-criteria) AC-16/17/23b.

## What

Firestore transaction on `adminAccounts/{uid}` + audit in the same commit; rejected attempts journaled via `audit.record_with([], entry)`.

Files: `backend/app/admin/actions.py`, `backend/app/admin/router.py`, `backend/tests/admin/test_actions_restriction.py`

## Definition of Done

**Tests show restrict stores reason/since/by with an applied audit record and new jobs are refused within 60 s, self-target → self_target journaled as rejected, restrict/unrestrict during a scheduled deletion → deletion_pending journaled as rejected, and unrestrict when not restricted → not_set.**

- [ ] Accepted jobs keep running after restriction (AC-19)
- [ ] Reason never appears in any user-facing response
- [ ] lint + type-check clean (ruff / oxlint + tsc)

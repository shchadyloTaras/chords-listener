---
id: T20
title: "Implement resetQuota and set/remove personal limit"
layer: "app"
deps: ["T09", "T10", "T14"]
acs: ["AC-12", "AC-12b", "AC-13", "AC-14", "AC-15", "AC-33"]
files_hint: ["backend/app/admin/actions.py", "backend/app/admin/router.py", "backend/app/quotas.py", "backend/tests/admin/test_actions_limits.py"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Stage 2 — user actions"
status: "todo"
---

# T20 — Implement resetQuota and set/remove personal limit

**Blocked by:** [T09](./t09-admin-router-authz.md), [T10](./t10-admin-audit-writer.md), [T14](./t14-admission-gate.md) · **ACs:** AC-12, AC-12b, AC-13, AC-14, AC-15, AC-33 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[sad §6 Скидання денної квоти / Персональний ліміт](../sad.md); [ADR-0003](../adr/0003-host-admin-api-in-existing-backend-service.md), [ADR-0007](../adr/0007-write-audit-atomically-or-before-the-effect.md).

## What

Reset: journal-first under the `Quotas` lock → zero `analyses`/`vocals` → on failure `not_applied`. Limit: upsert `adminAccounts.personalLimit` + audit in one commit; remove → `limit_removed`.

Files: `backend/app/admin/actions.py`, `backend/app/admin/router.py`, `backend/app/quotas.py`, `backend/tests/admin/test_actions_limits.py`

## Definition of Done

**A concurrency test shows reset and an analysis accepted in parallel end with usage = analyses accepted after the reset, reset keeps running jobs counted, the journal holds old counters, and personal-limit set/remove is one batched write with its audit record (remove when unset → not_set).**

- [ ] AC-12b race test
- [ ] Journal write failure → counters unchanged
- [ ] Limit 100 until month end visible on card (AC-13)
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Repeated reset is harmless and writes a second journal record (api-sync-report deviations).

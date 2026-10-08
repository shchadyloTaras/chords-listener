---
id: T14
title: "Gate all five cloud-job entries through one admission check before Quotas.consume"
layer: "app"
deps: ["T03", "T12", "T13"]
acs: ["AC-12b", "AC-13", "AC-13b", "AC-15", "AC-18", "AC-24", "AC-26", "AC-27", "AC-28"]
files_hint: ["backend/app/admission.py", "backend/app/quotas.py", "backend/app/jobs.py", "backend/app/main.py", "backend/tests/test_admission.py"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Stage 2 — user actions"
status: "todo"
---

# T14 — Gate all five cloud-job entries through one admission check before Quotas.consume

**Blocked by:** [T03](./t03-admin-error-codes.md), [T12](./t12-jobmanager-projection-hooks.md), [T13](./t13-runtime-settings-cache.md) · **ACs:** AC-12b, AC-13, AC-13b, AC-15, AC-18, AC-24, AC-26, AC-27, AC-28 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[ADR-0008](../adr/0008-gate-every-cloud-job-through-one-admission-check.md); [sad §6 Critical flow 2](../sad.md); effective-limit rule [spec §5](../spec.md#5-acceptance-criteria) AC-13b/AC-15.

## What

`admission.check(uid, kind, origin)`: tombstone/restriction/deletion (adminAccounts cached 60 s) → switches → effective limit → `Quotas.consume`. `quotas.py`: `effective_limits(uid)` merges `personalLimit` fields over `settings.limits`; `reset(uid)` under the same lock (used by T20). Entries: `/api/jobs`, `/api/jobs/upload`, `/api/jobs/storage`, reanalyze, vocals.

Files: `backend/app/admission.py`, `backend/app/quotas.py`, `backend/app/jobs.py`, `backend/app/main.py`, `backend/tests/test_admission.py`

## Definition of Done

**API tests for each of the five entries show restriction/deletion → cloud_restricted, pause → analyses_paused, YouTube off → youtube_disabled, vocals off → vocals_disabled, each with quota unchanged, and the effective limit is personal-over-default per field until the inclusive end date.**

- [ ] Refusal never increments `quota.json`
- [ ] Personal 5 analyses + default vocals 10 → 5/10 (AC-13b)
- [ ] Expired `until` → default applies (AC-15)
- [ ] Change takes effect ≤ 60 s (cache test)
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Relies on max-instances = 1 (SAD §11). Shares jobs.py/main.py with T12 — hence the dep.

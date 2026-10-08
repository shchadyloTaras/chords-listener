---
id: T10
title: "Implement the audit writer: atomic with Firestore changes, journal-first otherwise, before any view response"
layer: "app"
deps: ["T01", "T04"]
acs: ["AC-10b", "AC-33", "AC-33b"]
files_hint: ["backend/app/admin/audit.py", "backend/tests/admin/test_audit.py"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Stage 1 — view"
status: "todo"
---

# T10 — Implement the audit writer: atomic with Firestore changes, journal-first otherwise, before any view response

**Blocked by:** [T01](./t01-firestore-client-batch-tx-query.md), [T04](./t04-admin-models-validators.md) · **ACs:** AC-10b, AC-33, AC-33b ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[ADR-0007](../adr/0007-write-audit-atomically-or-before-the-effect.md); data shape in [data-model.md](../data-model.md) Aggregate 4.

## What

`audit.record_with(writes, entry)` (one commit), `audit.record_first(entry)` → effect → `audit.mark_not_applied(ref)`, `audit.record_view(entry)` before responding. Sets `expireAt = at + 400 d`; stores `adminEmail`, never the target email. Metric `audit_write_failed`.

Files: `backend/app/admin/audit.py`, `backend/tests/admin/test_audit.py`

## Definition of Done

**Fault-injection tests show a failed audit write leaves state unchanged and returns not_applied/audit_unavailable, a journal-first effect failure writes a not_applied follow-up with refId, and validation errors are never journaled.**

- [ ] Broken commit → no state change, 503 `not_applied`
- [ ] View journal failure → 503 `audit_unavailable`, no data returned
- [ ] Records have `expireAt` and no target email
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

No update/delete API for audit records — append-only (AC-11).

---
id: T19
title: "Serve listAudit with email resolution and «видалений» for purged users"
layer: "ports"
deps: ["T09", "T10", "T16"]
acs: ["AC-10", "AC-10b", "AC-11"]
files_hint: ["backend/app/admin/router.py", "backend/tests/admin/test_api_audit.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 1 — view"
status: "todo"
---

# T19 — Serve listAudit with email resolution and «видалений» for purged users

**Blocked by:** [T09](./t09-admin-router-authz.md), [T10](./t10-admin-audit-writer.md), [T16](./t16-email-index-directory.md) · **ACs:** AC-10, AC-10b, AC-11 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[spec §5](../spec.md#5-acceptance-criteria) AC-10/10b/11; [data-model.md](../data-model.md) Aggregate 4.

## What

Query with the `adminAudit_*_at` indexes; resolve target email via `directory.email_of`, tombstone → `deleted: true`.

Files: `backend/app/admin/router.py`, `backend/tests/admin/test_api_audit.py`

## Definition of Done

**The journal lists records newest-first filtered by admin/user/action with who/when/target/before/after, a tombstoned target is shown as deleted without email, and no route can update or delete a record.**

- [ ] Rejected attempts and views appear (AC-10b)
- [ ] Purged target → no email
- [ ] Route table has no PUT/PATCH/DELETE on audit
- [ ] lint + type-check clean (ruff / oxlint + tsc)

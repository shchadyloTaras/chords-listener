---
id: T25
title: "Implement tombstone-first, idempotent account purge with anonymization"
layer: "app"
deps: ["T10", "T22", "T24"]
acs: ["AC-11", "AC-22"]
files_hint: ["backend/app/admin/deletion.py", "backend/app/admin/sweeps.py", "backend/app/publish.py", "backend/tests/admin/test_purge.py"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Background work, ops, verification"
status: "todo"
---

# T25 — Implement tombstone-first, idempotent account purge with anonymization

**Blocked by:** [T10](./t10-admin-audit-writer.md), [T22](./t22-actions-deletion.md), [T24](./t24-sweep-endpoint-reconcile.md) · **ACs:** AC-11, AC-22 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[ADR-0011](../adr/0011-purge-accounts-tombstone-first-with-idempotent-steps.md); [sad §6 Critical flow 3](../sad.md); [spec §5](../spec.md#5-acceptance-criteria) AC-22, NFR «Повнота видалення».

## What

Per due uid: tombstone(purging) → GCS erase → Firestore erase (tracks, users, adminAccounts, `directory.remove`) → anonymize `adminJobs` (uid kept) + redact `adminAudit` (`targetUid`, `matchedUids`) → Firebase Auth delete → tombstone(done). Resume `status == purging`. Metric `deletion_overdue`. Publish path checks the tombstone.

Files: `backend/app/admin/deletion.py`, `backend/app/admin/sweeps.py`, `backend/app/publish.py`, `backend/tests/admin/test_purge.py`

## Definition of Done

**An emulator test purges a seeded user and then finds no track, audio, quota, users doc, adminAccounts, index entry or Auth account, finds adminJobs with title/trackId null and audit with reasons and matching search queries redacted, frozen days unchanged, a re-run is a no-op, and a publish-pending retry for the uid is dropped.**

- [ ] Interrupted purge resumes on next sweep
- [ ] No email of the purged user anywhere, incl. index
- [ ] Logs carry uid only
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Purge runs only from the sweep — never from an admin request.

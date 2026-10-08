---
id: T24
title: "Add the OIDC-protected sweep endpoint: slot claim, buffer replay, stale jobs, reconcile+freeze, index sync"
layer: "app"
deps: ["T09", "T11", "T16"]
acs: ["AC-08"]
files_hint: ["backend/app/admin/sweeps.py", "backend/app/auth.py", "backend/app/main.py", "backend/tests/admin/test_sweeps.py"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Background work, ops, verification"
status: "todo"
---

# T24 — Add the OIDC-protected sweep endpoint: slot claim, buffer replay, stale jobs, reconcile+freeze, index sync

**Blocked by:** [T09](./t09-admin-router-authz.md), [T11](./t11-history-stats-projections.md), [T16](./t16-email-index-directory.md) · **ACs:** AC-08 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[sad §6 Cross-cutting: фонові роботи](../sad.md); [ADR-0010](../adr/0010-count-daily-stats-live-and-freeze-after-nightly-reconciliation.md); OIDC branch noted in [api-sync-report.md](../contracts/api-sync-report.md) Notes.

## What

`POST /api/internal/sweep`: AuthMiddleware branch verifying Google OIDC (issuer, audience, `chords-scheduler@…` email). Claim `adminSweeps/{slot}` with exists=false; steps: replay buffer → stale jobs → reconcile/freeze yesterday (+`newUsers`) → `directory.full_sync` → purge step hook (T25) → done. First natural wake after 00:00 UTC triggers the `-wake` slot.

Files: `backend/app/admin/sweeps.py`, `backend/app/auth.py`, `backend/app/main.py`, `backend/tests/admin/test_sweeps.py`

## Definition of Done

**Tests show a non-scheduler token gets the 404 response, a second call for the same slot is a no-op, running jobs older than 2 h close as other, yesterday is recomputed from adminJobs (service excluded) and frozen only when no job is still running, and stats_mismatch is logged when totals differ.**

- [ ] Idempotent slot
- [ ] Frozen day unchanged after a later delete
- [ ] `server_wake_by` logged
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Purge step is a no-op until T25 lands.

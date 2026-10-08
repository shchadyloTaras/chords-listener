---
id: T26
title: "Add the owner grant script, Cloud Scheduler jobs, max-instances guard and alerting"
layer: "wiring"
deps: ["T09", "T24"]
acs: ["AC-22", "AC-32"]
files_hint: ["scripts/admin_grant.py", "scripts/deploy_cloud.sh", "backend/app/main.py", "backend/tests/test_admin_grant.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Background work, ops, verification"
status: "todo"
---

# T26 — Add the owner grant script, Cloud Scheduler jobs, max-instances guard and alerting

**Blocked by:** [T09](./t09-admin-router-authz.md), [T24](./t24-sweep-endpoint-reconcile.md) · **ACs:** AC-22, AC-32 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[ADR-0006](../adr/0006-authorize-admins-via-firestore-allowlist-with-60s-cache.md); [sad §7](../sad.md) Infrastructure additions + Monitoring; [sad §11](../sad.md) max-instances risk.

## What

`scripts/admin_grant.py grant|revoke <email|uid> [--note]` (resolves uid via Auth, never stores email). `deploy_cloud.sh`: guard + idempotent `gcloud scheduler jobs create/update http … --oidc-service-account-email`. Startup warning log when instance cap is not 1. Metric/alert definitions as gcloud commands.

Files: `scripts/admin_grant.py`, `scripts/deploy_cloud.sh`, `backend/app/main.py`, `backend/tests/test_admin_grant.py`

## Definition of Done

**admin_grant.py grant/revoke writes/deletes adminAllowlist/{uid} with the owner's ADC (tested against the emulator), deploy_cloud.sh fails if max-instances ≠ 1 and creates two scheduler jobs at 00:15/12:15 UTC with the scheduler SA, and log-based metrics + alerts for deletion_overdue and stats_mismatch are defined.**

- [ ] Grant then revoke on emulator
- [ ] Deploy script dry-run shows both jobs and the guard
- [ ] Server code has no write path to the allowlist (grep test)
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

IAM: only the owner has write access to Firestore (SAD §11).

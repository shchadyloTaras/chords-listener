---
id: T38
title: "Add the NFR and security verification suite"
layer: "tests"
deps: ["T02", "T15", "T17", "T18", "T19", "T23", "T29", "T30", "T36"]
acs: ["AC-02", "AC-05", "AC-24", "AC-29", "AC-32"]
files_hint: ["backend/tests/admin/test_nfr.py", "frontend/e2e/admin.spec.ts"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Background work, ops, verification"
status: "todo"
---

# T38 — Add the NFR and security verification suite

**Blocked by:** [T02](./t02-admin-test-fixtures.md), [T15](./t15-api-overview-settings.md), [T17](./t17-api-search-card-tracks.md), [T18](./t18-api-job-history-stats.md), [T19](./t19-api-audit-list.md), [T23](./t23-actions-settings-switches-banner.md), [T29](./t29-ui-overview-screen.md), [T30](./t30-ui-users-search-card.md), [T36](./t36-ui-site-service-status-banner.md) · **ACs:** AC-02, AC-05, AC-24, AC-29, AC-32 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[sad §10](../sad.md) QG-1/QG-2/QG-3 How-verify; [spec §5](../spec.md#5-acceptance-criteria) §6 NFR.

## What

Backend pytest NFR module over the emulator + one e2e spec against a built `admin.html` with a stubbed API.

Files: `backend/tests/admin/test_nfr.py`, `frontend/e2e/admin.spec.ts`

## Definition of Done

**CI runs: ≤ 200 reads per admin endpoint on 1 000×20 and 1×1 000 fixtures, search p95 ≤ 1 s at 10 000 users, server-applied changes visible ≤ 60 s, an idle admin tab producing 0 server requests over 30 min (fake timers), and an e2e where hostile strings render as text and the CSP blocks an injected inline script.**

- [ ] All NFR checks green in CI
- [ ] Cold-start p95 ≤ 15 s documented as a manual check (needs real Cloud Run)
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

The repo has no browser e2e runner today (vitest + oxlint only); adding one for the CSP/e2e check is part of this task — `plan-tests` names the tier, `implement` picks the runner. Latency on real infra (p95 ≤ 2 s / ≤ 15 s) stays a manual post-deploy measurement.

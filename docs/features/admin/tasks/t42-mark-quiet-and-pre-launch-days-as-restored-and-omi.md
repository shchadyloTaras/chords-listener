---
id: T42
title: "Mark quiet and pre-launch days as restored and omit empty days from /stats"
layer: "app"
deps: ["T41"]
acs: ["AC-08"]
files_hint: ["backend/app/admin/router.py", "frontend/src/admin/screens/Stats.tsx", "backend/tests/admin/test_api_history.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 9 — review follow-ups"
status: "todo"
---

# T42 — Mark quiet and pre-launch days as restored and omit empty days from /stats

**Blocked by:** T41 · **ACs:** AC-08 · source: [review-2026-10-08](../_review/review-2026-10-08.md)

## Definition of Done

**Review S1-5, S1-9. Tests show a day with no live counters is shown as «відновлено з пісень» (not «триває»), and GET /stats omits the days the contract says are omitted.**

- [ ] lint + type-check clean (ruff / oxlint + tsc)

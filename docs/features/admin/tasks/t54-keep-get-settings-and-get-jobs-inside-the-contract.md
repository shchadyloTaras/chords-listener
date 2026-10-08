---
id: T54
title: "Keep GET /settings and GET /jobs inside the contract"
layer: "ports"
deps: ["T43", "T44"]
acs: ["AC-07", "AC-29"]
files_hint: ["backend/app/admin/settings.py", "docs/features/admin/migrations/04_seed_runtime_config.up.py", "docs/features/admin/contracts/openapi.yaml", "backend/tests/admin/test_settings.py", "backend/tests/admin/test_api_history.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 10 — re-review follow-ups"
status: "todo"
---

# T54 — Keep GET /settings and GET /jobs inside the contract

**Blocked by:** T43, T44 · **ACs:** AC-07, AC-29 · source: re-review of T40–T50, 2026-10-08 (after [review-2026-10-08](../_review/review-2026-10-08.md))

## Definition of Done

**Re-review fixes 5, 6. With publicStatus/current absent or invalid, GET /api/admin/settings returns the same validated placeholder banner migration 04 seeds (one shared constant); openapi.yaml declares both invalid_period and invalid_value for 422 on /api/admin/jobs, checked by a contract test.**

- [ ] lint + type-check clean (ruff / oxlint + tsc)

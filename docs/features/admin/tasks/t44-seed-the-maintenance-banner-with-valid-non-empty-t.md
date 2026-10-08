---
id: T44
title: "Seed the maintenance banner with valid non-empty texts"
layer: "migration"
deps: ["T43"]
acs: ["AC-29"]
files_hint: ["migrations/04_seed_runtime_config.up.py", "backend/app/admin/settings.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 9 — review follow-ups"
status: "todo"
---

# T44 — Seed the maintenance banner with valid non-empty texts

**Blocked by:** T43 · **ACs:** AC-29 · source: [review-2026-10-08](../_review/review-2026-10-08.md)

## Definition of Done

**Review S1-8. Tests show migration 04 builds the banner through validation (no model_construct bypass) so the seeded uk/en texts are non-empty and match the contract.**

- [ ] lint + type-check clean (ruff / oxlint + tsc)

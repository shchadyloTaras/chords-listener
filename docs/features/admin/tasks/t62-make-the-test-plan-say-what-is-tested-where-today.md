---
id: T62
title: "Make the test plan say what is tested where today"
layer: "docs"
deps: ["T50"]
acs: ["AC-16", "AC-24", "AC-26", "AC-32"]
files_hint: ["docs/features/admin/test-plan.md"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 10 — re-review follow-ups"
status: "done"
---

# T62 — Make the test plan say what is tested where today

**Blocked by:** T50 · **ACs:** AC-16, AC-24, AC-26, AC-32 · source: re-review of T40–T50, 2026-10-08 (after [review-2026-10-08](../_review/review-2026-10-08.md))

## Definition of Done

**Re-review fix 17. test-plan.md cites the AC-26 in-browser offer test and drops it from the known gaps, names only CI jobs that exist, and the AC-16/24/32 rows and the e2e rows name the level and clock actually used.**

- [x] lint + type-check clean (ruff / oxlint + tsc)

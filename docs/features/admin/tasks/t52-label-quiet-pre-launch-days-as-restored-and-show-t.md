---
id: T52
title: "Label quiet pre-launch days as restored and show the YouTube source in job rows"
layer: "migration"
deps: ["T42", "T41"]
acs: ["AC-07", "AC-08"]
files_hint: ["docs/features/admin/migrations/06_restore_stats_from_tracks.up.py", "backend/tests/admin/test_migration_06.py", "frontend/src/admin/screens/Jobs.tsx", "frontend/src/admin/screens/JobsStats.test.tsx"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 10 — re-review follow-ups"
status: "todo"
---

# T52 — Label quiet pre-launch days as restored and show the YouTube source in job rows

**Blocked by:** T42, T41 · **ACs:** AC-07, AC-08 · source: re-review of T40–T50, 2026-10-08 (after [review-2026-10-08](../_review/review-2026-10-08.md))

## Definition of Done

**Re-review fixes 2, 3. Emulator tests show migration 06 writes a restored day (zero counts) for every UTC day from the first track's day up to --before, idempotent, and .down removes them all; a Jobs test asserts on the row cell that a YouTube job reads «Посилання · YouTube».**

- [ ] lint + type-check clean (ruff / oxlint + tsc)

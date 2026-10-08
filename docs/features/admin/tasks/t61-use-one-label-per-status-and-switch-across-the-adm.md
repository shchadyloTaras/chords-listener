---
id: T61
title: "Use one label per status and switch across the admin screens"
layer: "ui"
deps: ["T52"]
acs: ["AC-01", "AC-07", "AC-08"]
files_hint: ["frontend/src/admin/screens/labels.ts", "frontend/src/admin/screens/Jobs.tsx", "frontend/src/admin/screens/UserCard.tsx", "frontend/src/admin/screens/Overview.tsx", "frontend/src/admin/screens/Settings.tsx", "frontend/src/admin/screens/Stats.tsx", "frontend/src/admin/screens/Audit.tsx"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 10 — re-review follow-ups"
status: "done"
---

# T61 — Use one label per status and switch across the admin screens

**Blocked by:** T52 · **ACs:** AC-01, AC-07, AC-08 · source: re-review of T40–T50, 2026-10-08 (after [review-2026-10-08](../_review/review-2026-10-08.md))

## Definition of Done

**Re-review fix 16. STATUS_LABEL and SWITCH_LABEL live in screens/labels.ts and are the only wording; the stats headers come from ORIGIN_LABEL / KIND_LABEL; the journal filters use the shared fieldClass; tests assert the shared words.**

- [x] lint + type-check clean (ruff / oxlint + tsc)

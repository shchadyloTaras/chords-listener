---
id: T53
title: "Pass the admin-set upload limit to the link and fragment downloads on every job"
layer: "app"
deps: ["T40"]
acs: ["AC-24", "AC-25"]
files_hint: ["backend/app/sources.py", "backend/app/fetch_client.py", "backend/app/jobs.py", "backend/tests/test_admission.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 10 — re-review follow-ups"
status: "done"
---

# T53 — Pass the admin-set upload limit to the link and fragment downloads on every job

**Blocked by:** T40 · **ACs:** AC-24, AC-25 · source: re-review of T40–T50, 2026-10-08 (after [review-2026-10-08](../_review/review-2026-10-08.md))

## Definition of Done

**Re-review fix 4 (review S1-1). Tests show a link download and a fragment download get the admin-set byte cap, not the deploy-time one, and a link longer than the admin-set duration fails too_long.**

- [x] lint + type-check clean (ruff / oxlint + tsc)

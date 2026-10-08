---
id: T40
title: "Enforce the admin-set duration and upload limits at every check"
layer: "app"
deps: ["T14", "T23"]
acs: ["AC-24", "AC-25"]
files_hint: ["backend/app/jobs.py", "backend/app/main.py", "backend/app/admin/settings.py", "backend/tests/admin/test_admission.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 9 — review follow-ups"
status: "todo"
---

# T40 — Enforce the admin-set duration and upload limits at every check

**Blocked by:** T14, T23 · **ACs:** AC-24, AC-25 · source: [review-2026-10-08](../_review/review-2026-10-08.md)

## Definition of Done

**Review S1-1. Tests show that after setDefaultLimits(maxDurationMin, maxUploadMb) a longer/larger input is refused with too_long / the upload-size error, and the deploy-time settings are the fallback only while adminConfig/settings is absent.**

- [ ] lint + type-check clean (ruff / oxlint + tsc)

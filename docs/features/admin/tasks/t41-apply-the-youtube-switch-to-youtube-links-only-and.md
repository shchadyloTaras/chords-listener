---
id: T41
title: "Apply the YouTube switch to YouTube links only and filter the history by source type"
layer: "app"
deps: ["T40"]
acs: ["AC-07", "AC-27"]
files_hint: ["backend/app/admission.py", "backend/app/jobs.py", "backend/app/admin/history.py", "backend/app/admin/router.py", "contracts/openapi.yaml", "frontend/src/admin/screens/Jobs.tsx"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 9 — review follow-ups"
status: "todo"
---

# T41 — Apply the YouTube switch to YouTube links only and filter the history by source type

**Blocked by:** T40 · **ACs:** AC-07, AC-27 · source: [review-2026-10-08](../_review/review-2026-10-08.md)

## Definition of Done

**Review S1-2, S1-4. Tests show youtubeEnabled=off refuses YouTube links (incl. fragments) but not SoundCloud/direct URLs, and adminJobs gets a sourceType (youtube|other) that listJobHistory can filter by (openapi + data-model updated).**

- [ ] lint + type-check clean (ruff / oxlint + tsc)

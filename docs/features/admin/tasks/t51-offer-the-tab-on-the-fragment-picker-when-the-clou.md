---
id: T51
title: "Offer the tab on the fragment picker when the cloud refuses for the admin's reason"
layer: "ui"
deps: ["T47"]
acs: ["AC-18", "AC-26", "AC-27"]
files_hint: ["frontend/src/components/clip/ClipPage.tsx", "frontend/src/components/clip/ClipPage.test.ts"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 10 — re-review follow-ups"
status: "todo"
---

# T51 — Offer the tab on the fragment picker when the cloud refuses for the admin's reason

**Blocked by:** T47 · **ACs:** AC-18, AC-26, AC-27 · source: re-review of T40–T50, 2026-10-08 (after [review-2026-10-08](../_review/review-2026-10-08.md))

## Definition of Done

**Re-review fix 1. A ClipPage test shows that an admin refusal (youtube_disabled, cloud_restricted, analyses_paused) of a fragment opens «Слухати у вкладці» at the same start with the reason shown, and that a picker opened while the site already knows YouTube is off goes straight to the tab page without sending anything.**

- [ ] lint + type-check clean (ruff / oxlint + tsc)

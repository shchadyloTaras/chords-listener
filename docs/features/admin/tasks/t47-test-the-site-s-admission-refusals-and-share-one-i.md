---
id: T47
title: "Test the site's admission refusals and share one isAdminRefusal helper"
layer: "ui"
deps: ["T46"]
acs: ["AC-18", "AC-26", "AC-28"]
files_hint: ["frontend/src/hooks/useJobs.ts", "frontend/src/components/chords/piano/LivePiano.tsx", "frontend/src/components/chords/ScoreView.tsx", "frontend/src/lib/serviceStatus.ts"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 9 — review follow-ups"
status: "todo"
---

# T47 — Test the site's admission refusals and share one isAdminRefusal helper

**Blocked by:** T46 · **ACs:** AC-18, AC-26, AC-28 · source: [review-2026-10-08](../_review/review-2026-10-08.md)

## Definition of Done

**Review S1-7, S2-11. Tests show the toast action, the support email and the hidden vocals retry on refusal; the refusal-code list lives in one helper used by useJobs, LivePiano and ScoreView.**

- [ ] lint + type-check clean (ruff / oxlint + tsc)

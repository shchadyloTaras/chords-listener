---
id: T50
title: "Run the emulator tests in CI and align the test plan with the levels used"
layer: "tests"
deps: ["T49"]
acs: ["AC-36"]
files_hint: ["/.github/workflows/pages.yml", "README.md", "test-plan.md"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 9 — review follow-ups"
status: "done"
---

# T50 — Run the emulator tests in CI and align the test plan with the levels used

**Blocked by:** T49 · **ACs:** AC-36 · source: [review-2026-10-08](../_review/review-2026-10-08.md)

## Definition of Done

**Review S2-5, S2-12. CI has a job running the backend emulator suite (README notes how to run it locally), and test-plan.md rows name the level each AC is actually tested at.**

- [x] lint + type-check clean (ruff / oxlint + tsc)

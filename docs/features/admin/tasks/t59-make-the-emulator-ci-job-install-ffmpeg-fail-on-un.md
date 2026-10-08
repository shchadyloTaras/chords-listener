---
id: T59
title: "Make the emulator CI job install ffmpeg, fail on unexpected skips and pin firebase-tools"
layer: "tests"
deps: ["T50"]
acs: ["AC-16", "AC-36"]
files_hint: [".github/workflows/backend-emulators.yml", "backend/tests/conftest.py", "README.md", "docs/CLOUD.md"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 10 — re-review follow-ups"
status: "done"
---

# T59 — Make the emulator CI job install ffmpeg, fail on unexpected skips and pin firebase-tools

**Blocked by:** T50 · **ACs:** AC-16, AC-36 · source: re-review of T40–T50, 2026-10-08 (after [review-2026-10-08](../_review/review-2026-10-08.md))

## Definition of Done

**Re-review fix 14. The workflow installs ffmpeg, runs the storage rules tests too, and sets a flag under which a test skipped for want of ffmpeg or an emulator fails the run (tested); firebase-tools is pinned to the current major in the workflow, README and docs/CLOUD.md.**

- [x] lint + type-check clean (ruff / oxlint + tsc)

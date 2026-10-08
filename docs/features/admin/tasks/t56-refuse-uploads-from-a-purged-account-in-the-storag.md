---
id: T56
title: "Refuse uploads from a purged account in the Storage rules"
layer: "wiring"
deps: ["T45"]
acs: ["AC-22"]
files_hint: ["storage.rules", "storage.rules.test.mjs", "docs/CLOUD.md"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 10 — re-review follow-ups"
status: "todo"
---

# T56 — Refuse uploads from a purged account in the Storage rules

**Blocked by:** T45 · **ACs:** AC-22 · source: re-review of T40–T50, 2026-10-08 (after [review-2026-10-08](../_review/review-2026-10-08.md))

## Definition of Done

**Re-review fix 9 (review S2-2). storage.rules refuses an upload create when adminTombstones/{uid} exists; a storage rules test (Auth + Firestore + Storage emulators) proves it; docs/CLOUD.md names the cross-service role the deploy needs.**

- [ ] lint + type-check clean (ruff / oxlint + tsc)

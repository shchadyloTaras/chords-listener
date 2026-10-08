---
id: T64
title: "Check every query against an index in its declared direction, and keep the 18 ascending/descending indexes in step"
layer: "tests"
deps: ["T58"]
acs: ["AC-07", "AC-08", "AC-10", "AC-22", "AC-35"]
files_hint: ["backend/tests/admin/fixtures.py", "firestore.indexes.json", "docs/features/admin/migrations/02_admin_indexes_and_ttl.up.json", "firestore.rules.test.mjs", "docs/features/admin/data-model.md", "backend/tests/admin/test_purge.py", "backend/tests/admin/test_api_history.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 10 — re-review follow-ups"
status: "done"
---

# T64 — Check every query against an index in its declared direction, and keep the 18 ascending/descending indexes in step

**Blocked by:** T58 · **ACs:** AC-07, AC-08, AC-10, AC-22, AC-35 · source: production probe of the deployed indexes, 2026-10-08

## Definition of Done

**Production evidence (2026-10-08, the 9 descending composites deployed and READY, read-only probes): Firestore reads a composite index only in its declared direction — `uid == x` orderBy acceptedAt ASC, the way back of the job history and the journal, the stale-jobs sweep (`status == running AND acceptedAt < t`, no orderBy: implicit ASC), per-reason `count()` over a period and the deletion cap's `count()` all answered FAILED_PRECONDITION; the wake sweep failed after 'replay'. Fixed by an ascending twin of every composite (aa023f4, 18 indexes, deployed by the coordinator). Here: MemDb's IndexGuard reads an index only in its declared direction (merged indexes each in the query's direction; a range without an order and an aggregation sort ascending), with tests; the guard is on in the sweep, purge, deletion/action, job-history (back-paging, counts over a period) and journal (back-paging) tests, which pass on the 18 and fail on the old 9; staged migration 02, the index-count rules test and the index docs follow the 18.**

- [x] lint + type-check clean (ruff / oxlint + tsc)

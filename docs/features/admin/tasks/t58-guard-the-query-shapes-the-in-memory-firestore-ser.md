---
id: T58
title: "Guard the query shapes the in-memory Firestore serves"
layer: "tests"
deps: ["T49"]
acs: ["AC-33"]
files_hint: ["backend/tests/admin/fixtures.py", "backend/tests/admin/test_fixtures.py", "backend/tests/admin/test_sweeps.py", "backend/tests/admin/test_api_audit.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 10 — re-review follow-ups"
status: "done"
---

# T58 — Guard the query shapes the in-memory Firestore serves

**Blocked by:** T49 · **ACs:** AC-33 · source: re-review of T40–T50, 2026-10-08 (after [review-2026-10-08](../_review/review-2026-10-08.md))

## Definition of Done

**Re-review fix 7. MemDb has an opt-in guard that refuses a query or aggregation whose filters and order no index in firestore.indexes.json (or a single-field index) can serve, and a sum where only count() is expected; the sweep and audit tests run with it on.**

- [x] lint + type-check clean (ruff / oxlint + tsc)

---
id: T16
title: "Implement the email-index directory: shard load, incremental catch-up and in-memory substring search"
layer: "infra"
deps: ["T01"]
acs: ["AC-03", "AC-04"]
files_hint: ["backend/app/admin/directory.py", "backend/tests/admin/test_directory.py"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Stage 1 — view"
status: "todo"
---

# T16 — Implement the email-index directory: shard load, incremental catch-up and in-memory substring search

**Blocked by:** [T01](./t01-firestore-client-batch-tx-query.md) · **ACs:** AC-03, AC-04 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[ADR-0009](../adr/0009-search-emails-in-memory-over-a-compact-firestore-index.md); [data-model.md](../data-model.md) Aggregate 5.

## What

`directory.search(q)` (≥ 3 chars, ≤ 50 results), `catch_up()` from `users.createdAt > min(syncedThrough)`, `full_sync()` (used by the sweep, T24), `remove(uid)` (used by purge, T25), `email_of(uid)` (audit list, T19).

Files: `backend/app/admin/directory.py`, `backend/tests/admin/test_directory.py`

## Definition of Done

**With 10 000 synthetic users, a case-insensitive substring search returns matches in p95 ≤ 1 s with ≤ 10 shard reads, users created after the cursor are found, and full_sync rebuilds shards ≤ 20 000 entries each.**

- [ ] «ivan» matches `ivan.p@…` and `John.Ivanov@…` (AC-03)
- [ ] 10k-user latency test
- [ ] New registration found without full sync
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Email changes land only at the next full sync (accepted debt, SAD §11).

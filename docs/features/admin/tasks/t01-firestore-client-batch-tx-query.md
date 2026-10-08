---
id: T01
title: "Extend the Firestore REST client with batched writes, transactions, queries and aggregations"
layer: "infra"
deps: []
acs: ["AC-33"]
files_hint: ["backend/app/firestore.py", "backend/tests/test_firestore.py"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Foundation"
status: "todo"
---

# T01 — Extend the Firestore REST client with batched writes, transactions, queries and aggregations

**Blocked by:** none — can start immediately · **ACs:** AC-33 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

Every admin write is a batched write or a transaction ([ADR-0007](../adr/0007-write-audit-atomically-or-before-the-effect.md)) and every screen reads via queries/aggregations ([ADR-0004](../adr/0004-precompute-admin-read-model-in-firestore.md)). [sad §11](../sad.md) lists the missing client capabilities as the first stage-1 task.

## What

Add to `backend/app/firestore.py` (REST, no Admin SDK): `commit(writes)` with `currentDocument.exists` and `updateMask`; `transaction()` context (begin/commit/rollback, retry on ABORTED); `run_query(collection, filters, order_by, limit, start_after)`; `aggregate(query, count|sum(field))`; field transforms (`increment`, `serverTimestamp`). Keep the existing `FirestoreIndex` API untouched.

Files: `backend/app/firestore.py`, `backend/tests/test_firestore.py`

## Definition of Done

**Emulator tests prove an atomic multi-doc commit with exists/updateMask preconditions, a read-write transaction with retry, a structured query with filters+order+cursor, and count()/sum() aggregations.**

- [ ] Emulator tests: a two-doc commit where one precondition fails leaves both docs unchanged
- [ ] A transaction that conflicts is retried and commits once
- [ ] `run_query` pages with a cursor; `aggregate` returns count and sum
- [ ] Existing `test_firestore.py` tests still pass; ruff clean
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Shared by almost every backend task — land it first. No behaviour change for the existing library sync.

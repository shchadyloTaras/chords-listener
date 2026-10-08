---
id: T06
title: "Promote migrations 02–03: composite indexes, TTL/exemptions and Firestore rules"
layer: "migration"
deps: ["T05"]
acs: ["AC-07", "AC-10", "AC-11", "AC-29", "AC-31", "AC-35"]
files_hint: ["docs/features/admin/migrations/02_admin_indexes_and_ttl.up.json", "docs/features/admin/migrations/02_admin_indexes_and_ttl.down.json", "docs/features/admin/migrations/03_admin_rules.up.rules", "docs/features/admin/migrations/03_admin_rules.down.rules", "firestore.rules.test.mjs"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Foundation"
status: "todo"
---

# T06 — Promote migrations 02–03: composite indexes, TTL/exemptions and Firestore rules

**Blocked by:** [T05](./t05-migration-track-size.md) · **ACs:** AC-07, AC-10, AC-11, AC-29, AC-31, AC-35 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

Indexes and TTL from [data-model.md](../data-model.md) §Indexes; rules from [sad §7](../sad.md) Infrastructure additions; append-only audit ([spec §5](../spec.md#5-acceptance-criteria) AC-11).

## What

Promote 02 into `firestore.indexes.json` (8 composite indexes, 4 TTL fields, exemptions) and 03 into `firestore.rules`. Extend `firestore.rules.test.mjs`: guest reads `publicStatus/current`; nobody writes it; `adminAccounts`, `adminAudit`, `adminJobs`, `adminStats`, `adminConfig`, `adminAllowlist`, `adminEmailIndex`, `adminTombstones`, `adminSweeps` denied for owner and stranger.

Files: `docs/features/admin/migrations/02_admin_indexes_and_ttl.up.json`, `docs/features/admin/migrations/02_admin_indexes_and_ttl.down.json`, `docs/features/admin/migrations/03_admin_rules.up.rules`, `docs/features/admin/migrations/03_admin_rules.down.rules`, `firestore.rules.test.mjs`

## Definition of Done

**firestore.indexes.json and firestore.rules carry the staged content, and rules tests prove publicStatus is publicly readable but not writable and every admin* collection is denied to clients.**

- [ ] Rules tests pass in the emulator
- [ ] Down files restore the previous rules/indexes
- [ ] `firebase deploy --only firestore:indexes,firestore:rules` dry-run is clean
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

TTL is what enforces history ≥ 90 d and audit ≥ 365 d (`expireAt` +400 d).

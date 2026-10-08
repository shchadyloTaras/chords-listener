---
id: T07
title: "Promote migrations 04–05: seed runtime config + public status and build the email index"
layer: "migration"
deps: ["T06"]
acs: ["AC-03", "AC-24", "AC-26", "AC-29"]
files_hint: ["docs/features/admin/migrations/04_seed_runtime_config.up.py", "docs/features/admin/migrations/04_seed_runtime_config.down.py", "docs/features/admin/migrations/05_build_email_index.up.py", "docs/features/admin/migrations/05_build_email_index.down.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Foundation"
status: "todo"
---

# T07 — Promote migrations 04–05: seed runtime config + public status and build the email index

**Blocked by:** [T06](./t06-migration-indexes-ttl-rules.md) · **ACs:** AC-03, AC-24, AC-26, AC-29 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

Bootstrap of [ADR-0005](../adr/0005-store-runtime-config-in-firestore-with-public-status-mirror.md) (config + mirror) and [ADR-0009](../adr/0009-search-emails-in-memory-over-a-compact-firestore-index.md) (email index).

## What

Promote both pairs; idempotent re-run (04 skips if present, 05 rebuilds).

Files: `docs/features/admin/migrations/04_seed_runtime_config.up.py`, `docs/features/admin/migrations/04_seed_runtime_config.down.py`, `docs/features/admin/migrations/05_build_email_index.up.py`, `docs/features/admin/migrations/05_build_email_index.down.py`

## Definition of Done

**On the emulator, 04 creates adminConfig/settings from env and publicStatus/current with only banner/switches/updatedAt, 05 builds shards matching users, and both down scripts remove what they created.**

- [ ] Up/down on emulator for both
- [ ] Re-running up is a no-op for 04
- [ ] `publicStatus/current` field set is exactly `banner`, `switches`, `updatedAt`
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Run before the first deploy of stage 1 code.

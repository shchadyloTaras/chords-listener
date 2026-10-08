---
id: T08
title: "Promote migration 06: restore pre-launch daily stats from tracks"
layer: "migration"
deps: ["T07"]
acs: ["AC-08"]
files_hint: ["docs/features/admin/migrations/06_restore_stats_from_tracks.up.py", "docs/features/admin/migrations/06_restore_stats_from_tracks.down.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Foundation"
status: "todo"
---

# T08 — Promote migration 06: restore pre-launch daily stats from tracks

**Blocked by:** [T07](./t07-migration-seed-config-email-index.md) · **ACs:** AC-08 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[spec §5](../spec.md#5-acceptance-criteria) AC-08 «відновлено з пісень»; [data-model.md](../data-model.md) Aggregate 3.

## What

Promote the pair; run once after launch with `--before <launch day>`.

Files: `docs/features/admin/migrations/06_restore_stats_from_tracks.up.py`, `docs/features/admin/migrations/06_restore_stats_from_tracks.down.py`

## Definition of Done

**On the emulator, 06 with --before <day> writes state=restored days with restoredTracks by source.type only, never touches live/frozen days, and down removes only restored days.**

- [ ] Restored days have no failure/active counters
- [ ] A live day for the same date is left untouched
- [ ] Down removes only `state == restored`
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Restored days are never reconciled (ADR-0010).

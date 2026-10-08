---
id: T05
title: "Promote migration 01 (tracks.sizeBytes backfill) and write sizeBytes on publish"
layer: "migration"
deps: []
acs: ["AC-03"]
files_hint: ["docs/features/admin/migrations/01_add_track_size.up.py", "docs/features/admin/migrations/01_add_track_size.down.py", "docs/features/admin/migrations/_fsrest.py", "backend/app/publish.py", "backend/tests/test_publish.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Foundation"
status: "todo"
---

# T05 — Promote migration 01 (tracks.sizeBytes backfill) and write sizeBytes on publish

**Blocked by:** none — can start immediately · **ACs:** AC-03 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

«Зайняте місце» on the card is `sum(sizeBytes)` ([data-model.md](../data-model.md) Aggregate 1, expand step).

## What

Promote `01_add_track_size.{up,down}.py` (+ `_fsrest.py`). Publish path computes the track directory size and writes `sizeBytes`.

Files: `docs/features/admin/migrations/01_add_track_size.up.py`, `docs/features/admin/migrations/01_add_track_size.down.py`, `docs/features/admin/migrations/_fsrest.py`, `backend/app/publish.py`, `backend/tests/test_publish.py`

## Definition of Done

**The staged 01 pair is promoted, up then down runs cleanly on the emulator, and a newly published track carries sizeBytes.**

- [ ] Staged migration promoted to the live migrations location; applies and reverts cleanly on the emulator
- [ ] `test_publish.py`: published track has `sizeBytes > 0`
- [ ] Clients ignore the field (no frontend change)
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Expand-only; no contract step. Runs as a Cloud Run job on the service image.

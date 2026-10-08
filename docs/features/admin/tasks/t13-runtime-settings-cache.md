---
id: T13
title: "Implement runtime settings: 30 s lazy cache, env fallback and the public-status mirror writer"
layer: "app"
deps: ["T01", "T04"]
acs: ["AC-24", "AC-27", "AC-29"]
files_hint: ["backend/app/admin/settings.py", "backend/tests/admin/test_settings.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 1 — view"
status: "todo"
---

# T13 — Implement runtime settings: 30 s lazy cache, env fallback and the public-status mirror writer

**Blocked by:** [T01](./t01-firestore-client-batch-tx-query.md), [T04](./t04-admin-models-validators.md) · **ACs:** AC-24, AC-27, AC-29 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[ADR-0005](../adr/0005-store-runtime-config-in-firestore-with-public-status-mirror.md); [data-model.md](../data-model.md) Aggregate 6; [sad §11](../sad.md) public-doc field allowlist risk.

## What

`settings.current()` (lazy TTL 30 s, no background poll), `settings.write_ops(limits|switches)`, `public_status.write_ops(banner|switches)` returning batched-write ops with `updateMask` limited to their own fields.

Files: `backend/app/admin/settings.py`, `backend/tests/admin/test_settings.py`

## Definition of Done

**Tests show a settings change is seen by the server within 30 s without polling, env values are used only when the doc is absent, and the mirror writer refuses any field outside banner/switches/updatedAt and writes with an updateMask.**

- [ ] Cache expiry test (time-mocked)
- [ ] Field allowlist test on the public doc
- [ ] Banner write does not clobber switches and vice versa
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Writes are composed with audit in T23; this task only builds the ops.

---
id: T23
title: "Implement setDefaultLimits, setSwitch and setBanner with mirrored, audited batched writes"
layer: "app"
deps: ["T09", "T10", "T13", "T15"]
acs: ["AC-13b", "AC-24", "AC-25", "AC-26", "AC-27", "AC-28", "AC-29", "AC-30", "AC-34"]
files_hint: ["backend/app/admin/actions.py", "backend/app/admin/router.py", "backend/tests/admin/test_actions_settings.py"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Stage 3 — service settings"
status: "todo"
---

# T23 — Implement setDefaultLimits, setSwitch and setBanner with mirrored, audited batched writes

**Blocked by:** [T09](./t09-admin-router-authz.md), [T10](./t10-admin-audit-writer.md), [T13](./t13-runtime-settings-cache.md), [T15](./t15-api-overview-settings.md) · **ACs:** AC-13b, AC-24, AC-25, AC-26, AC-27, AC-28, AC-29, AC-30, AC-34 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[ADR-0005](../adr/0005-store-runtime-config-in-firestore-with-public-status-mirror.md); [sad §6 Типові ліміти / Перемикачі / Банер](../sad.md).

## What

Handlers compose `settings.write_ops` / `public_status.write_ops` with `audit.record_with`. Pause on → `require_fresh_login`; pause off and other switches → no re-auth.

Files: `backend/app/admin/actions.py`, `backend/app/admin/router.py`, `backend/tests/admin/test_actions_settings.py`

## Definition of Done

**Tests show a limits change is one commit of config + audit (before/after) and applies within 60 s, a switch change writes config + publicStatus + audit in one commit, enabling the pause needs a fresh login, and an invalid limit or banner returns invalid_value with per-field details without journaling.**

- [ ] Banner write leaves switches intact (updateMask)
- [ ] Default 40→30 applies to users without a personal limit
- [ ] Accepted jobs finish after a switch flips
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Overlaps actions.py/router.py with T20–T22 — serialized lane.

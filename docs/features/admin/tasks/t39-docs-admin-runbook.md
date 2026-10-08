---
id: T39
title: "Document the admin: CLOUD.md section, grant/revoke runbook, migration order and alerts"
layer: "docs"
deps: ["T26"]
acs: ["AC-32"]
files_hint: ["docs/CLOUD.md", "README.md", "docs/features/admin/spec.md"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Background work, ops, verification"
status: "todo"
---

# T39 — Document the admin: CLOUD.md section, grant/revoke runbook, migration order and alerts

**Blocked by:** [T26](./t26-ops-grant-scheduler-alerts.md) · **ACs:** AC-32 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[sad §7](../sad.md); [sad §11](../sad.md) resolved OQs.

## What

Runbook section; README link to the admin page; tick spec §8 boxes for 2FA and emails (resolved 2026-10-07), support address and smoke-account (defaults applied).

Files: `docs/CLOUD.md`, `README.md`, `docs/features/admin/spec.md`

## Definition of Done

**docs/CLOUD.md describes granting/revoking admins, migration promotion order 01–06, the sweep schedule and the two alerts, and spec §8 OQs resolved at design are ticked.**

- [ ] Links resolve
- [ ] Commands copy-paste runnable
- [ ] lint + type-check clean (ruff / oxlint + tsc)

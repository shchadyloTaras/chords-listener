---
id: T37
title: "Show admission refusals on the site and send the origin hint"
layer: "ui"
deps: ["T36"]
acs: ["AC-18", "AC-26", "AC-27", "AC-28"]
files_hint: ["frontend/src/lib/api.ts", "frontend/src/i18n/cloud.ts", "frontend/src/components/account/BrowserAnalysisNote.tsx", "frontend/src/lib/api.cloud.test.ts"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 2 — user actions"
status: "todo"
---

# T37 — Show admission refusals on the site and send the origin hint

**Blocked by:** [T36](./t36-ui-site-service-status-banner.md) · **ACs:** AC-18, AC-26, AC-27, AC-28 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[spec §5](../spec.md#5-acceptance-criteria) AC-18/26/27/28; contract codes in [api-sync-report.md](../contracts/api-sync-report.md).

## What

Map the four codes in `lib/api.ts`; reuse `BrowserAnalysisNote.tsx` for the fallback; support address = owner email from README (spec §8 default).

Files: `frontend/src/lib/api.ts`, `frontend/src/i18n/cloud.ts`, `frontend/src/components/account/BrowserAnalysisNote.tsx`, `frontend/src/lib/api.cloud.test.ts`

## Definition of Done

**vitest shows cloud_restricted shows «Хмарний аналіз для вашого акаунта обмежено» with the support email (no admin reason) and a browser-recognition offer, analyses_paused / youtube_disabled / vocals_disabled show their explanations, and uploads send origin file|mic.**

- [ ] Each code → message test
- [ ] Library keeps working under restriction (no change to library paths)
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Spec §8 OQ «support address» is due before tasks — default applied, confirm with owner.

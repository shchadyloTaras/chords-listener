---
id: T36
title: "Read the public service status on the site: maintenance banner and YouTube-off fallback"
layer: "ui"
deps: []
acs: ["AC-27", "AC-29"]
files_hint: ["frontend/src/lib/serviceStatus.ts", "frontend/src/lib/serviceStatus.test.ts", "frontend/src/components/layout/ServiceBanner.tsx", "frontend/src/components/input"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Stage 3 — service settings"
status: "todo"
---

# T36 — Read the public service status on the site: maintenance banner and YouTube-off fallback

**Blocked by:** none — can start immediately · **ACs:** AC-27, AC-29 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[ADR-0005](../adr/0005-store-runtime-config-in-firestore-with-public-status-mirror.md); [spec §5](../spec.md#5-acceptance-criteria) AC-27/29; NFR «0 запитів до хмарного сервера».

## What

`serviceStatus.ts` via `lib/firestore.ts` with a 5-min cache; `ServiceBanner` styled like `HealthBanner.tsx`; YouTube input path consults `switches.youtubeEnabled`.

Files: `frontend/src/lib/serviceStatus.ts`, `frontend/src/lib/serviceStatus.test.ts`, `frontend/src/components/layout/ServiceBanner.tsx`, `frontend/src/components/input`

## Definition of Done

**vitest shows publicStatus/current is read from Firestore at most once per 5 min with zero calls to the cloud server, the banner renders in the UI language as plain text, and a YouTube link with youtubeEnabled=false offers «Слухати у вкладці» without a server request.**

- [ ] No `/api` request in banner test
- [ ] Banner disappears when `enabled=false`
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Independent of backend code — only needs the Firestore doc shape.

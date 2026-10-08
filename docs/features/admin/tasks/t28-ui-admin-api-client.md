---
id: T28
title: "Build the admin API client with re-auth flow, error-code i18n and the no-polling refresh policy"
layer: "ui"
deps: ["T27"]
acs: ["AC-02", "AC-33", "AC-33b", "AC-34"]
files_hint: ["frontend/src/lib/adminApi.ts", "frontend/src/lib/adminApi.test.ts", "frontend/src/admin/useAdminData.ts", "frontend/src/types.ts", "frontend/src/i18n/admin.ts", "frontend/src/i18n/index.ts"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Stage 1 — view"
status: "todo"
---

# T28 — Build the admin API client with re-auth flow, error-code i18n and the no-polling refresh policy

**Blocked by:** [T27](./t27-ui-admin-entry-csp.md) · **ACs:** AC-02, AC-33, AC-33b, AC-34 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[openapi.yaml](../contracts/openapi.yaml); [spec §5](../spec.md#5-acceptance-criteria) AC-02 and AC-34; [sad §8](../sad.md) Caching.

## What

Typed client for every `/api/admin/*` op (types mirrored in `types.ts`); `i18n/admin.ts` domain (uk/en) incl. failure-reason labels; `useAdminData` hook with `visibilitychange` gate.

Files: `frontend/src/lib/adminApi.ts`, `frontend/src/lib/adminApi.test.ts`, `frontend/src/admin/useAdminData.ts`, `frontend/src/types.ts`, `frontend/src/i18n/admin.ts`, `frontend/src/i18n/index.ts`

## Definition of Done

**vitest shows each call sends the ID token, reauth_required triggers re-login then retries once, every new error code maps to uk/en text, and useAdminData refetches only on mount, on tab return after ≥ 60 s, or on Refresh — no timers.**

- [ ] Fake-timer test: no request while tab idle 30 min
- [ ] `not_applied` → «зміну не застосовано, повторіть»
- [ ] Per-field `details.fields` exposed to forms
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Follows `lib/api.ts` conventions.

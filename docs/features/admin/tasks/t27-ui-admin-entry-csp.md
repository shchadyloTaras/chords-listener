---
id: T27
title: "Create the admin.html entry with strict CSP, admin shell, sign-in and not-found for non-admins"
layer: "ui"
deps: []
acs: ["AC-05", "AC-31"]
files_hint: ["frontend/admin.html", "frontend/vite.config.ts", "frontend/src/admin/main.tsx", "frontend/src/admin/AdminApp.tsx", "frontend/src/admin/useAdminRoute.ts", "frontend/.oxlintrc.json", ".github/workflows/pages.yml"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Stage 1 — view"
status: "todo"
---

# T27 — Create the admin.html entry with strict CSP, admin shell, sign-in and not-found for non-admins

**Blocked by:** none — can start immediately · **ACs:** AC-05, AC-31 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[ADR-0002](../adr/0002-ship-admin-ui-as-separate-strict-csp-entry.md); [sad §4 UI-architecture](../sad.md); [spec §5](../spec.md#5-acceptance-criteria) AC-05/AC-31.

## What

Second Vite input `admin.html`; shell reuses `index.css` Tailwind tokens, `lib/auth.ts` + `components/account/AuthModal.tsx` for sign-in, `components/layout/NotFoundPage.tsx` for denial, hash routing modelled on `hooks/useRoute.ts`, `components/ui/Toaster.tsx`. Nav: Огляд · Користувачі · Задачі · Статистика · Журнал · Налаштування.

Files: `frontend/admin.html`, `frontend/vite.config.ts`, `frontend/src/admin/main.tsx`, `frontend/src/admin/AdminApp.tsx`, `frontend/src/admin/useAdminRoute.ts`, `frontend/.oxlintrc.json`, `.github/workflows/pages.yml`

## Definition of Done

**The Vite build emits admin.html with a CSP meta forbidding inline scripts and eval, the admin bundle contains no TF.js/model assets (CI check), an oxlint rule fails on dangerouslySetInnerHTML/innerHTML under src/admin, and a non-admin sees only NotFoundPage.**

- [ ] vitest: route parsing
- [ ] CI step greps bundle + CSP meta
- [ ] Pages workflow publishes admin.html
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

No new primitives — reuse `components/ui/*`. Can start day 1 against the OpenAPI contract.

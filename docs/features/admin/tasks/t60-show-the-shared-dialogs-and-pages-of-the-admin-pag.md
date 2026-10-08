---
id: T60
title: "Show the shared dialogs and pages of the admin page in Ukrainian"
layer: "ui"
deps: ["T46"]
acs: ["AC-31", "AC-34"]
files_hint: ["frontend/src/i18n/index.ts", "frontend/src/admin/main.tsx", "frontend/src/admin/AdminApp.test.ts", "docs/features/admin/adr/0002-ship-admin-ui-as-separate-strict-csp-entry.md"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 10 — re-review follow-ups"
status: "done"
---

# T60 — Show the shared dialogs and pages of the admin page in Ukrainian

**Blocked by:** T46 · **ACs:** AC-31, AC-34 · source: re-review of T40–T50, 2026-10-08 (after [review-2026-10-08](../_review/review-2026-10-08.md))

## Definition of Done

**Re-review fix 15. The admin entry pins the interface language to Ukrainian without writing the site's stored choice; a test with the site language set to English shows the admin's re-login dialog and not-found page in Ukrainian; ADR-0002 records it.**

- [x] lint + type-check clean (ruff / oxlint + tsc)

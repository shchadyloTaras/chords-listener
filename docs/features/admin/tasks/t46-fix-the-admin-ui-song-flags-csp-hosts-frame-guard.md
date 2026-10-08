---
id: T46
title: "Fix the admin UI: song flags, CSP hosts, frame guard, one language, shared classes"
layer: "ui"
deps: ["T45"]
acs: ["AC-03", "AC-06"]
files_hint: ["frontend/src/admin/screens/UserCard.tsx", "frontend/admin.html", "frontend/src/admin/main.tsx", "frontend/src/admin/useAdminRoute.ts", "adr/0002-ship-admin-ui-as-separate-strict-csp-entry.md"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 9 — review follow-ups"
status: "todo"
---

# T46 — Fix the admin UI: song flags, CSP hosts, frame guard, one language, shared classes

**Blocked by:** T45 · **ACs:** AC-03, AC-06 · source: [review-2026-10-08](../_review/review-2026-10-08.md)

## Definition of Done

**Review S1-6, S1-13, S2-8, S2-9, S2-10. Tests show the song list shows edited/vocals flags, admin.html connect-src lists only ADR-0002 hosts (or the ADR is amended), a framed admin page breaks out, the admin pins lang=uk (recorded in ADR-0002), and label/input classes come from one module.**

- [ ] lint + type-check clean (ruff / oxlint + tsc)

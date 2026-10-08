---
id: T55
title: "Resolve accounts through Firebase Auth and let only the purge delete a profile"
layer: "app"
deps: ["T45"]
acs: ["AC-16", "AC-20", "AC-21", "AC-23"]
files_hint: ["firestore.rules", "docs/features/admin/migrations/03_admin_rules.up.rules", "firestore.rules.test.mjs", "backend/app/admin/identity.py", "backend/app/admin/router.py", "backend/app/admin/actions.py", "backend/tests/admin/test_actions_deletion.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 10 — re-review follow-ups"
status: "todo"
---

# T55 — Resolve accounts through Firebase Auth and let only the purge delete a profile

**Blocked by:** T45 · **ACs:** AC-16, AC-20, AC-21, AC-23 · source: re-review of T40–T50, 2026-10-08 (after [review-2026-10-08](../_review/review-2026-10-08.md))

## Definition of Done

**Re-review fix 8 (review S2-1). firestore.rules (and staged migration 03) refuse every client delete of users/{uid}; rules tests prove it. With no profile, no index entry and no admin state, an account Firebase Auth knows is found by the card, restricted, and scheduleDeletion confirms against its Auth e-mail.**

- [ ] lint + type-check clean (ruff / oxlint + tsc)

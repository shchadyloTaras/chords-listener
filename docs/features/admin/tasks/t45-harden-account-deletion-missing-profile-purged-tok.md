---
id: T45
title: "Harden account deletion: missing profile, purged-token reuse, buffered replay, cancel after purge"
layer: "app"
deps: ["T44"]
acs: ["AC-16", "AC-22", "AC-23", "AC-23b"]
files_hint: ["backend/app/admin/router.py", "backend/app/admin/deletion.py", "backend/app/admin/actions.py", "backend/app/admin/history.py", "backend/app/admin/directory.py", "firestore.rules"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 9 — review follow-ups"
status: "done"
---

# T45 — Harden account deletion: missing profile, purged-token reuse, buffered replay, cancel after purge

**Blocked by:** T44 · **ACs:** AC-16, AC-22, AC-23, AC-23b · source: [review-2026-10-08](../_review/review-2026-10-08.md)

## Definition of Done

**Review S2-1..S2-4. Tests show: admin actions work for a user whose users/{uid} is missing; a purged user's token cannot recreate the profile, uploads or email index entry; buffered history replay after purge does not restore the title; cancelDeletion reads the tombstone and refuses once purge began.**

- [ ] lint + type-check clean (ruff / oxlint + tsc)

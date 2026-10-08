---
id: T57
title: "Close the small security and infra gaps: sweep 401, grant fails closed, tombstone reads, admin preflight"
layer: "app"
deps: ["T48"]
acs: ["AC-31", "AC-32"]
files_hint: ["backend/app/auth.py", "scripts/admin_grant.py", "backend/app/admin/directory.py", "backend/app/firestore.py", "backend/tests/test_admin_grant.py", "backend/tests/admin/test_directory.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 10 — re-review follow-ups"
status: "done"
---

# T57 — Close the small security and infra gaps: sweep 401, grant fails closed, tombstone reads, admin preflight

**Blocked by:** T48 · **ACs:** AC-31, AC-32 · source: re-review of T40–T50, 2026-10-08 (after [review-2026-10-08](../_review/review-2026-10-08.md))

## Definition of Done

**Re-review fixes 10-13. Tests show an unverified call to /api/internal/sweep answers exactly like any other unauthenticated /api/* call; the grant script refuses an email whose verified flag is missing or false (offline and on the Auth emulator); a catch-up reads tombstones only for the uids it folds in; a real CORS preflight to /api/admin/* gets 200 from an allowed origin and 400 from another.**

- [x] lint + type-check clean (ruff / oxlint + tsc)

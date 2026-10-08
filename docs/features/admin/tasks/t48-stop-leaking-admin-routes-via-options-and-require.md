---
id: T48
title: "Stop leaking admin routes via OPTIONS and require a verified email in the grant script"
layer: "app"
deps: ["T45"]
acs: ["AC-32"]
files_hint: ["backend/app/auth.py", "backend/app/main.py", "scripts/admin_grant.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 9 — review follow-ups"
status: "done"
---

# T48 — Stop leaking admin routes via OPTIONS and require a verified email in the grant script

**Blocked by:** T45 · **ACs:** AC-32 · source: [review-2026-10-08](../_review/review-2026-10-08.md)

## Definition of Done

**Review S2-6, S2-7. Tests show an unauthenticated OPTIONS to admin/internal routes answers like an unknown route, and scripts/admin_grant.py refuses an account whose email is not verified.**

- [ ] lint + type-check clean (ruff / oxlint + tsc)

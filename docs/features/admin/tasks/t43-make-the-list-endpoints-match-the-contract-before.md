---
id: T43
title: "Make the list endpoints match the contract: before cursor, truncated, 422 cases"
layer: "ports"
deps: ["T42"]
acs: ["AC-03", "AC-06"]
files_hint: ["backend/app/admin/router.py", "backend/app/admin/directory.py", "contracts/openapi.yaml", "backend/tests/admin/test_api_search_card.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 9 — review follow-ups"
status: "todo"
---

# T43 — Make the list endpoints match the contract: before cursor, truncated, 422 cases

**Blocked by:** T42 · **ACs:** AC-03, AC-06 · source: [review-2026-10-08](../_review/review-2026-10-08.md)

## Definition of Done

**Review S1-10, S1-11, S1-12. Tests show listUserTracks honours `before`, truncated is true only when more than 50 match, and invalid track/audit cursors and q > 254 return the contract's error (or the contract lists the 422).**

- [ ] lint + type-check clean (ruff / oxlint + tsc)

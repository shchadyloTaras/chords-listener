---
id: T49
title: "Consolidate the in-memory Firestore fakes and fix the AC-13b settings test"
layer: "tests"
deps: ["T48"]
acs: ["AC-13b"]
files_hint: ["backend/tests/admin/fixtures.py", "backend/tests/test_cloud.py", "backend/tests/test_vocals_api.py", "backend/tests/admin/test_actions_settings.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 9 — review follow-ups"
status: "todo"
---

# T49 — Consolidate the in-memory Firestore fakes and fix the AC-13b settings test

**Blocked by:** T48 · **ACs:** AC-13b · source: [review-2026-10-08](../_review/review-2026-10-08.md)

## Definition of Done

**Review S2-13, S2-14. One MemDb in backend/tests/admin/fixtures.py replaces the 7 copies; test_actions_settings.py:150 seeds the right doc and asserts the behaviour.**

- [ ] lint + type-check clean (ruff / oxlint + tsc)

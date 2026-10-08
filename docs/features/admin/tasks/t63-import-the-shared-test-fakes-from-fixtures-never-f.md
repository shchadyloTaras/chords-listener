---
id: T63
title: "Import the shared test fakes from fixtures, never from another test module"
layer: "tests"
deps: ["T58"]
acs: ["AC-33"]
files_hint: ["backend/tests/admin/fixtures.py", "backend/tests/admin/conftest.py", "backend/tests/admin/test_actions_deletion.py", "backend/tests/admin/test_api_overview.py", "backend/tests/admin/test_settings.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Stage 10 — re-review follow-ups"
status: "todo"
---

# T63 — Import the shared test fakes from fixtures, never from another test module

**Blocked by:** T58 · **ACs:** AC-33 · source: re-review of T40–T50, 2026-10-08 (after [review-2026-10-08](../_review/review-2026-10-08.md))

## Definition of Done

**Re-review fix 18. FakeDb, FakeVerifier, Clock, settings_for, ENGINE_INFO, H, never and the world fixture live in tests/admin/fixtures.py or a conftest.py; no test module imports from another test module (a test checks it).**

- [ ] lint + type-check clean (ruff / oxlint + tsc)

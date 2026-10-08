---
id: T03
title: "Register the 16 admin error codes and map admin validation errors to invalid_value"
layer: "domain"
deps: []
acs: ["AC-14", "AC-25", "AC-30"]
files_hint: ["backend/app/models.py", "backend/app/main.py", "backend/tests/test_api.py"]
owner: "Тарас Щадило"
estimate: "S"
stage: "Foundation"
status: "todo"
---

# T03 — Register the 16 admin error codes and map admin validation errors to invalid_value

**Blocked by:** none — can start immediately · **ACs:** AC-14, AC-25, AC-30 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[api-sync-report.md](../contracts/api-sync-report.md) point 2 lists the 16 new codes; [sad §8 Error handling](../sad.md) keeps the `{detail, code}` shape.

## What

Extend the `ErrorCode` Literal and `STATUS_BY_CODE`: `cloud_restricted` 403, `analyses_paused`/`youtube_disabled`/`vocals_disabled` 503, `query_too_short`/`invalid_period`/`invalid_value`/`confirm_email_mismatch` 422, `reauth_required` 401, `self_target`/`deletion_pending`/`not_scheduled`/`not_set` 409, `deletion_rate_limit` 429, `not_applied`/`audit_unavailable` 503. The `RequestValidationError` handler emits `invalid_value` + `details.fields` for `/api/admin/*` (today: `internal`).

Files: `backend/app/models.py`, `backend/app/main.py`, `backend/tests/test_api.py`

## Definition of Done

**All 16 new codes exist in ErrorCode with their STATUS_BY_CODE status, and a 422 on any /api/admin/* route returns code invalid_value with details.fields per field.**

- [ ] Unit test per new code → status
- [ ] Validation error on an admin route returns `invalid_value` with field names
- [ ] Non-admin routes keep today's behaviour
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Backend messages in English; uk/en mapping is the UI's job (T28, T37).

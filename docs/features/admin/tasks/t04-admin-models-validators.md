---
id: T04
title: "Define admin request/response models with the spec'd validation ranges"
layer: "domain"
deps: ["T03"]
acs: ["AC-04", "AC-09", "AC-14", "AC-25", "AC-30"]
files_hint: ["backend/app/admin/__init__.py", "backend/app/admin/models.py", "backend/tests/admin/test_models.py"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Foundation"
status: "todo"
---

# T04 — Define admin request/response models with the spec'd validation ranges

**Blocked by:** [T03](./t03-admin-error-codes.md) · **ACs:** AC-04, AC-09, AC-14, AC-25, AC-30 ([spec §5](../spec.md#5-acceptance-criteria))

## Why

Schemas come from [openapi.yaml](../contracts/openapi.yaml); ranges are verbatim from [spec §5](../spec.md#5-acceptance-criteria) AC-14/AC-25/AC-30 and data-model ([data-model.md](../data-model.md)).

## What

`backend/app/admin/models.py` (CamelModel, like `backend/app/models.py`): Overview, UserSearchResult, UserCard, TrackMetaPage, JobHistoryPage, StatsRange, AuditPage, PersonalLimitIn (≥ 1 number; 1–1000 / 1–150 / 1–4; `until` ≥ today UTC), DefaultLimitsIn (+ 1–120 min, 1–512 MB), BannerIn (1–250 both languages), RestrictionIn (reason 1–500), DeletionIn (confirmEmail), period validator (≤ 90 days, end ≥ start), query ≥ 3 / ≤ 254 chars.

Files: `backend/app/admin/__init__.py`, `backend/app/admin/models.py`, `backend/tests/admin/test_models.py`

## Definition of Done

**Pydantic models mirror every openapi.yaml schema and unit tests reject each out-of-range value named in AC-04/09/14/25/30.**

- [ ] Boundary tests for every range (min−1, min, max, max+1)
- [ ] `until` = yesterday rejected, today accepted
- [ ] Empty personal limit rejected
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

New module-local DTO file beside the SAD §5 tree; keeps `backend/app/models.py` for public types.

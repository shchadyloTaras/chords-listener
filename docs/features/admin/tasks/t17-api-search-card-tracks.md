---
id: T17
title: "Serve searchUsers, getUserCard and listUserTracks with view journaling"
layer: "ports"
deps: ["T05", "T09", "T10", "T16"]
acs: ["AC-03", "AC-04", "AC-05", "AC-06", "AC-10b", "AC-15", "AC-16", "AC-33b"]
files_hint: ["backend/app/admin/router.py", "backend/tests/admin/test_api_users.py"]
owner: "Тарас Щадило"
estimate: "M"
stage: "Stage 1 — view"
status: "todo"
---

# T17 — Serve searchUsers, getUserCard and listUserTracks with view journaling

**Blocked by:** [T05](./t05-migration-track-size.md), [T09](./t09-admin-router-authz.md), [T10](./t10-admin-audit-writer.md), [T16](./t16-email-index-directory.md) · **ACs:** AC-03, AC-04, AC-05, AC-06, AC-10b, AC-15, AC-16, AC-33b ([spec §5](../spec.md#5-acceptance-criteria))

## Why

[sad §6 Пошук і картка користувача](../sad.md); [spec §5](../spec.md#5-acceptance-criteria) AC-03…06, AC-10b, AC-33b.

## What

Handlers: search (journal `search` with `query` + `matchedUids`), card (journal `view_card`; users + adminAccounts + tombstone + `count`/`sum(sizeBytes)` + 20 recent jobs + Firebase Auth `lastLoginAt`), tracks (cursor pages of 50; title/source/createdAt/duration/status only). Unknown or purged uid → 404 `not_found`.

Files: `backend/app/admin/router.py`, `backend/tests/admin/test_api_users.py`

## Definition of Done

**API tests show search < 3 chars → query_too_short without journaling, a search and a card view are journaled before the response (and withheld if journaling fails), the card shows quota vs effective limit, personal limit (incl. «завершився»), state and lastLoginAt, and track pages of 50 newest-first contain metadata only.**

- [ ] No audio/chords/edits fields in any response (schema test)
- [ ] Card read budget ≤ 200 with 1 user × 1 000 tracks
- [ ] Hostile titles returned verbatim (no server-side escaping games)
- [ ] lint + type-check clean (ruff / oxlint + tsc)

## Notes

Track pages after the card are not re-journaled (api-sync-report Notes).

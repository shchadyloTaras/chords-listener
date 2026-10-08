# Audit — data-model admin (2026-10-08)

**Mode:** greenfield entities in a brownfield repo. **Store:** Firestore (REST, service account) + GCS `/data`. There is no SQL and no migration tool, so the staged "migrations" are Firestore deltas: rules, indexes/TTL, and idempotent Python backfills run as Cloud Run jobs on the service image (the `python -m app.publish backfill` precedent).

> **The migrations are staged and not yet in the live tree.** `firestore.rules` and `firestore.indexes.json` are unchanged, and no backfill has run. `implement` promotes them when it runs the `layer: migration` tasks.

## Staged files

| # | Files | Kind |
|---|---|---|
| 01 | `docs/features/admin/migrations/01_add_track_size.{up,down}.py` | expand: nullable `users/*/tracks.sizeBytes` + backfill (no contract step: clients ignore the field) |
| 02 | `docs/features/admin/migrations/02_admin_indexes_and_ttl.{up,down}.json` | 8 composite indexes, 4 TTL policies, 5 index exemptions |
| 03 | `docs/features/admin/migrations/03_admin_rules.{up,down}.rules` | `publicStatus/current` public `get`; 9 admin collections explicitly denied; header data model updated |
| 04 | `docs/features/admin/migrations/04_seed_runtime_config.{up,down}.py` | bootstrap seed (create-if-absent) |
| 05 | `docs/features/admin/migrations/05_build_email_index.{up,down}.py` | projection build (full replace, converges) |
| 06 | `docs/features/admin/migrations/06_restore_stats_from_tracks.{up,down}.py` | restored days (create-if-absent), `--before <launch day>` |
| — | `docs/features/admin/migrations/_fsrest.py` | shared REST helper (list / runQuery / commit with preconditions) |

**Promote-time hint:** there is no sequence numbering in this repo. The rules and indexes files replace `firestore.rules` / `firestore.indexes.json` and deploy with `firebase deploy --only firestore:rules,firestore:indexes`. The scripts move to e.g. `backend/app/admin/migrations/` and run as `python -m …` jobs. Order: **02 → 03 → 01 → 04 → 05 → 06**. Indexes build first because a build takes minutes. 01 must run **after** the publish path writes `sizeBytes`, or new tracks miss it. 06 needs `--before` = the stage-1 launch day.

## Decisions taken in this pass (Socratic)

- **Aggregate: one sparse `adminAccounts/{uid}`** holds restriction, deletion and personal limit. Card and transaction both touch one doc. The directory projection was **dropped**: the track count and storage come from `count()`/`sum(sizeBytes)` aggregations on the user's tracks. Email and registration date come from `users`. Last sign-in is read live from Firebase Auth.
- **Smoke-test account** (spec §8 OQ, due before data-model): job records carry `service: true`, are labelled «службовий» and are excluded from stats and reconciliation. **Owner: mark the OQ closed in `spec.md`.**
- **Search PII on purge:** search audit records store `matchedUids` (≤ 50). Purge redacts `query` where `matchedUids` contains the uid, and restriction reasons where `targetUid` matches.
- **Projection write failure:** GCS buffer `<data>/admin/projections-pending.json`, replayed on the next write and by the sweep before reconciliation. Accept and finish writes are idempotent (create precondition; finish no-op unless `running`).

## Convention deviations (deliberate)

- **New collection prefix `admin*`**: there was no precedent beyond `users`. The prefix groups the server-only collections for rules and IAM review.
- **Anonymize in place** (`adminJobs`, `adminAudit`) instead of the repo's hard delete. Spec AC-22 requires the records to remain, anonymized.
- **Server-side validation in Pydantic, not in rules**: this matches `users/*/tracks`, where the service account writes and rules only gate access.

## Drift

- New entities: no domain layer exists yet (`backend/app/admin/` is unbuilt), so there is nothing to compare.
- Existing: the `firestore.rules` header data model matches `TrackSummary` + `version` + `publishedAt` (publish.py `summary_doc`). **No drift; no `_drift/` files.**
- Pre-existing inconsistency (not fixed): `users.createdAt` is a timestamp but `tracks.createdAt` is an ISO string. Migration 06 and the card's song paging handle the string form.

## Self-check

| Check | Result |
|---|---|
| Naming matches repo | ✅ camelCase fields, natural doc ids; `admin*` prefix flagged above |
| Down reversibility | ✅ each up has a down: field add↔remove, index/rules file↔original, create↔delete, rebuild↔delete |
| Reference-field indexes | ✅ every queried reference (`adminJobs.uid`, `adminAudit.adminUid/targetUid/matchedUids`) has an index; unqueried ones (`byAdminUid`) are not indexed by intent beyond Firestore's automatic single-field |
| Convention adherence | ✅ with the deviations above |
| erDiagram | ✅ structural lint (glyphs + `type name` lines). `mmdc` not installed, so no render-parse |
| Scripts | ✅ `py_compile` passes. ⚠️ **Not run against the emulator**: no Java runtime on this machine (`firebase emulators:exec` needs a JDK). Run each up → up (idempotency) → down on the emulator before promotion |
| PII in seeds | ✅ no seed contains an email or name. Fixtures use `@example.test` |

## Open / TBD

- `<!-- TBD -->` **Job `origin` for storage uploads**: the server can't tell `mic` from `file` today. The `api` stage needs a client origin hint on `POST /api/jobs/storage` (tab = has `videoId`). Re-analysis inherits the track's origin.
- `<!-- TBD -->` **Restriction reason length**: the spec sets no bound; 500 is proposed.
- **Composite-index merging** for combined history and journal filters: verify in a real project (the emulator doesn't enforce indexes). The fallback is a full composite `(status, reason, origin, acceptedAt DESC)`.
- **TTL via `firestore.indexes.json`** (`"ttl": true` field overrides) needs a recent firebase-tools. The fallback is `gcloud firestore fields ttls update expireAt --collection-group=…`.
- **Finish after freeze**: resolved in `data-model.md`. A day is frozen only when none of its jobs is still `running`, after the stale-job close. Otherwise it is reconciled but stays `live` until the next slot (12 h later), so a late failure still counts on its own day.

**Next stage:** `api admin`.

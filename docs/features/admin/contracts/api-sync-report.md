---
status: Draft
owner: "Тарас Щадило (Backend Lead)"
updated_at: "2026-10-08"
feature_size: "L"
contract: ./openapi.yaml
contract_version: 0.1.0
---

# API sync report — admin

**Interface kind:** `target_surfaces: [backend-service, web-frontend]` (sad.md frontmatter), so this is an HTTP/OpenAPI contract authored by the backend. The admin UI (`admin.html`) consumes it. **No `events.md`:** SAD §8 «Events» says there are no events between modules. The projection hooks are synchronous calls inside the process (ADR-0004). The only retry/dead-letter flow (background work) is a scheduler-driven HTTP call, `POST /api/internal/sweep`, made idempotent by its slot key.

**Inputs:** data-model.md ✓ · sad.md §6 ✓ (14 flows) · spec.md §4/§5 ✓ · ADR-0001…0011 ✓ · CONTEXT.md ✓ · repo error registry `backend/app/models.py` `ErrorCode` + `backend/app/main.py` `STATUS_BY_CODE` ✓.

**Lint:** `spectral lint` (ruleset `spectral:oas`) passes with 0 errors and 1 warning. The warning (`oas3-unused-component` on `PublicStatus`) is intentional: it is the Firestore `publicStatus/current` shape, which the site reads without HTTP, kept here for the consumer's types. Every `example` is validated against its schema by `oas3-valid-media-example`.

## Deviations from the skill defaults (decided 2026-10-08)

| Default | This contract | Why |
|---|---|---|
| `/api/v1/...` URL versioning | `/api/admin/*`, `/api/internal/sweep`, no version segment | ADR-0003. Every route of this service is unversioned `/api/*` |
| `{code, message, details?}`, `code` = `module.error_name` | `{detail, code, details?}`, flat snake_case `code` from `ErrorCode` | SAD §8 «Error handling». One error handler and one uk/en code mapper for the site and the admin. `details.fields` is **additive** (needed for per-field errors in AC-14/25/30) |
| `{items, has_next, has_prev, next_cursor}` | `{items, hasNext, hasPrev, nextCursor}` | repo JSON is camelCase (`CamelModel`) |
| `Idempotency-Key` on retriable mutations | none | no admin flow in §6 has a retry note or an async actor. The only retried call (sweep) is idempotent by slot. Admin mutations are state-checked (409 on a repeat) except `resetQuota`: a retried reset zeroes the counters again (harmless) and writes a second journal record |

## A. Field origins

Shared schemas are `$ref`-ed, so origins are listed **per schema field** once. The operation → schema map below makes every `operation.field` traceable.

**Operation → schemas**

| Operation | Story / AC | Request | 200 body |
|---|---|---|---|
| `getOverview` | US-01 · AC-01, AC-02 | — | `Overview` |
| `searchUsers` | US-02 · AC-03, AC-04, AC-10b, AC-33b | `q` | `UserSearchResult` |
| `getUserCard` | US-02, US-03 · AC-03, AC-05, AC-06, AC-15, AC-16, AC-33b | `uid` | `UserCard` |
| `listUserTracks` | US-03 · AC-03, AC-06 | `uid`, cursor, `limit` | `TrackMetaPage` |
| `listJobHistory` | US-04 · AC-07 | `status`, `reason`, `origin`, `from`, `to`, cursor | `JobHistoryPage` |
| `getStats` | US-05 · AC-08, AC-09 | `from`, `to` | `StatsRange` |
| `listAudit` | US-06 · AC-10, AC-10b, AC-11 | `adminUid`, `targetUid`, `action`, cursor | `AuditPage` |
| `resetQuota` | US-07 · AC-12, AC-12b, AC-33 | `uid` | `AccountState` |
| `setPersonalLimit` | US-08 · AC-13, AC-13b, AC-14, AC-15 | `PersonalLimitInput` | `AccountState` |
| `removePersonalLimit` | US-08 | `uid` | `AccountState` |
| `restrictUser` | US-09 · AC-16, AC-17, AC-23b | `RestrictionInput` | `AccountState` |
| `unrestrictUser` | US-09, US-10 · AC-19, AC-23b | `uid` | `AccountState` |
| `scheduleDeletion` | US-11 · AC-17, AC-20, AC-21, AC-34, AC-35 | `DeletionRequest` | `AccountState` |
| `cancelDeletion` | US-11 · AC-23 | `uid` | `AccountState` |
| `getSettings` | US-12, US-13, US-14 | — | `Settings` |
| `setDefaultLimits` | US-12 · AC-24, AC-25, AC-13b | `DefaultLimits` | `Settings` |
| `setSwitch` | US-13 · AC-26, AC-27, AC-28, AC-34 | `SwitchName`, `SwitchChange` | `Settings` |
| `setBanner` | US-14 · AC-29, AC-30 | `Banner` | `Settings` |
| `runSweep` | US-05, US-11 · AC-08, AC-22 (internal) | — | `SweepRun` |
| `createJob` / `uploadJob` / `storageJob` / `reanalyzeTrack` / `transcribeVocals` (delta) | US-08, US-10, US-13 · AC-13, AC-18, AC-26, AC-27, AC-28 | `origin` hint (upload, storage) | unchanged `Job` |

**Schema fields**

| schema_path | origin | confidence |
|---|---|---|
| `Uid` (pattern) | `backend/app/users.py` `_UID_RE` | high |
| `UtcDay` | data-model → `adminStats` doc id `YYYY-MM-DD`, `utc_day()` | high |
| `Cursor` | derived (cursor page convention; opaque sort key + id) | high |
| `Origin` enum | data-model → `adminJobs.origin` (`link\|file\|mic\|tab`) | high |
| `UploadOrigin` | data-model → `adminJobs.origin` TBD («client origin hint»), decided here: `file\|mic`, absent → `file` | medium |
| `JobKind` | data-model → `adminJobs.kind` | high |
| `HistoryStatus` | data-model → `adminJobs.status` | high |
| `FailureReason` | data-model → `adminJobs.reason` fixed list | high |
| `ReasonCounts` | data-model → `adminStats.failedByReason` (reason → int) | high |
| `AuditAction`, `AuditOutcome` | data-model → `adminAudit.action`, `.outcome` | high |
| `AccountStatus` | derived from `adminAccounts.deletion` / `.restriction` presence | medium |
| `SwitchName`, `Switches.*` | data-model → `adminConfig.switches` | high |
| `OriginCounts.*` | data-model → `adminStats.analyses {link,file,mic,tab}` ≥ 0 | high |
| `QuotaUsage`, `UserQuotas` | existing `GET /api/me` shape (`models.py` `UserQuotas`) + `quota.json`; `limit` = effective limit (ADR-0008) | high |
| `DefaultLimits.*` (1–1000, 1–150, 1–4, 1–120, 1–512) | data-model → `adminConfig.limits` = spec AC-25 | high |
| `Banner.enabled/uk/en` (1–250) | data-model → `publicStatus.banner` = AC-30 | high |
| `PublicStatus.*` | data-model → `publicStatus/current` (field allowlist) | high |
| `Overview.day` | data-model → `adminStats` doc id (today) | high |
| `Overview.analyses/vocals/failed/failedByReason/active` | data-model → `adminStats.{analyses,vocals,failed,failedByReason,active}` | high |
| `Overview.newUsers` | data-model → `adminStats.newUsers` (live: `count()` over `users.createdAt`) | high |
| `Overview.runningJobs` | sad.md §6 «Огляд» (JobManager in memory), not stored | medium |
| `RunningJob.id/uid/kind/origin/acceptedAt` | data-model → `adminJobs.{jobId,uid,kind,origin,acceptedAt}` (same values, read from memory) | high |
| `RunningJob.email`, `UserSearchItem.email`, `JobHistoryItem.email`, `AuditEntry.targetEmail` | data-model → `adminEmailIndex.entries[uid]` | high |
| `*.service` | data-model → `adminJobs.service` (`uid == SMOKE_UID`), spec OQ resolved 2026-10-08 | high |
| `UserSearchResult.query` | data-model → `adminAudit.query` (3–254) | high |
| `UserSearchResult.items` (≤ 50) | data-model → `adminAudit.matchedUids` ≤ 50 | high |
| `UserSearchResult.truncated` | derived (cap of 50), no column | medium |
| `UserProfile.uid/email/createdAt` | `users/{uid}` (`uid`, `email`, `createdAt`) | high |
| `UserProfile.lastLoginAt` | data-model «Not in Firestore»: Firebase Auth `lastLoginAt`, read live | high |
| `UserProfile.trackCount` | data-model → `count()` over `users/{uid}/tracks` | high |
| `UserProfile.storageBytes` | data-model → `sum(tracks.sizeBytes)` | high |
| `Restriction.reason` (1–500) | data-model → `adminAccounts.restriction.reason` (TBD 500, accepted here 2026-10-08) | high |
| `Restriction.since/byAdminUid` | data-model → `adminAccounts.restriction.{since,byAdminUid}` | high |
| `Deletion.scheduledAt/purgeAfter/byAdminUid` | data-model → `adminAccounts.deletion.*` (`priorRestriction` deliberately not exposed) | high |
| `PersonalLimit.analyses/vocals/jobs/until/setAt/byAdminUid` | data-model → `adminAccounts.personalLimit.*` (ranges from AC-14) | high |
| `PersonalLimit.expired` | derived (`until` < today UTC, AC-15) | medium |
| `PersonalLimitInput` (anyOf ≥ 1 number; `until` ≥ today) | data-model → `personalLimit` constraint «at least one number set» + AC-14 | high |
| `RestrictionInput.reason` | data-model → `restriction.reason` | high |
| `DeletionRequest.confirmEmail` | spec AC-20/AC-21 (typed email), compared with `users.email`; not stored | medium |
| `TrackMeta.id/title/createdAt/duration/edited/vocals` | `users/{uid}/tracks/{id}` = `TrackSummary` fields (CLOUD.md «Library in Firestore») | high |
| `TrackMeta.sourceType` | `tracks.source.type` (`youtube\|url\|file`) | high |
| `TrackMeta.sizeBytes` | data-model → `tracks.sizeBytes` (nullable during backfill) | high |
| `JobHistoryItem.id/uid/kind/origin/status/reason/errorText(≤200)/title(≤300)/acceptedAt/finishedAt` | data-model → `adminJobs.*` | high |
| `JobHistoryItem.userDeleted`, `AuditEntry.targetDeleted` | data-model → `adminTombstones/{uid}` exists | high |
| `JobHistoryPage.countsByReason` | data-model index `adminJobs_reason_acceptedAt` + `count()` (AC-07) | high |
| `StatsDay.*` | data-model → `adminStats.{state,analyses,vocals,failed,failedByReason,active,newUsers,restoredTracks,frozenAt}` | high |
| `AuditEntry.id/at/adminUid/adminEmail/action/outcome/targetUid/setting/before/after/rejectReason/query/refId/redactedAt` | data-model → `adminAudit.*` (`matchedUids`, `expireAt` deliberately internal) | high |
| `Settings.limits/switches/updatedAt/updatedBy` | data-model → `adminConfig.settings.*` | high |
| `Settings.banner` | data-model → `publicStatus.banner` | high |
| `SwitchChange.value` | data-model → `adminConfig.switches.<name>` bool | high |
| `SweepRun.*` | data-model → `adminSweeps/{slot}.{state,steps,startedAt,finishedAt}` | high |
| `StorageJobRequestDelta.*` (except `origin`) | existing `models.py` `StorageJobRequest` | high |
| `Error.details.fields` | derived — per-field messages for AC-14/25/30 (decided 2026-10-08) | medium |
| example `restriction.reason` on `scheduleDeletion` 200 | data-model says `restriction` is set while `deletion` is set (AC-20), but not which **reason** text a fresh restriction gets | **low** |

**Intentionally internal (in data-model, not in the contract):** `adminAccounts.deletion.priorRestriction`, `adminAccounts.updatedAt`, `adminJobs.trackId/day/expireAt/anonymizedAt`, `adminAudit.matchedUids/expireAt`, `adminStats.reconciledDiff/updatedAt`, `activeUsers/*`, `adminEmailIndex.count/syncedThrough/fullSyncAt`, `adminTombstones.*` (only its existence, as `userDeleted`), `adminAllowlist.*`, `adminSweeps.expireAt`. They are operational or purge-only data with no AC that shows them to the admin.

## B. Drift checklist

1. **Endpoint ↔ data-model** *(core)* — ✓. Every operation reads or writes at least one data-model entity: overview → `adminStats`, `adminConfig`; search → `adminEmailIndex`, `adminAudit`; card/tracks → `users`, `tracks`, `adminAccounts`, `adminJobs`, `adminAudit`; history → `adminJobs`; stats → `adminStats`; journal → `adminAudit`; actions → `adminAccounts`, `adminAudit` (+ `quota.json`); settings → `adminConfig`, `publicStatus`, `adminAudit`; sweep → `adminSweeps` and the rest; jobs delta → `adminJobs`/`adminStats` via admission.
2. **Error code ↔ repo error definition** *(core)* — ⚠ **proposal, not drift.** The registry is the `ErrorCode` Literal plus `STATUS_BY_CODE`. The 12 existing codes match. **16 new codes** are this contract's proposal and must be added in `implement`: `cloud_restricted` 403, `analyses_paused` 503, `youtube_disabled` 503, `vocals_disabled` 503, `query_too_short` 422, `invalid_period` 422, `invalid_value` 422, `confirm_email_mismatch` 422, `reauth_required` 401, `self_target` 409, `deletion_pending` 409, `not_scheduled` 409, `not_set` 409, `deletion_rate_limit` 429, `not_applied` 503, `audit_unavailable` 503. The data-model `adminAudit.rejectReason` values (`self_target`, `deletion_pending`, `deletion_rate_limit`, `not_scheduled`) are the same strings ✓. Also needed: the generic `RequestValidationError` handler maps `/api/admin/*` 422s to `invalid_value` + `details.fields` (today it emits `internal`).
3. **Validation ↔ constraint** *(core)* — ✓. Ranges match data-model and spec exactly: limits 1–1000 / 1–150 / 1–4 / 1–120 min / 1–512 MB (AC-25: «до 0,5 ГБ» = 512 MB); banner 1–250 (AC-30); query 3–254 (AC-04 + data-model); title ≤ 300, errorText ≤ 200; stats period ≤ 90 days (AC-09); restriction reason 1–500 (data-model TBD, **accepted 2026-10-08**). No conflict, so no stricter-value pick was needed.
4. **OpenAPI ↔ sequence** *(supporting)* — ✓ with 5 gaps (below). Every §6 `alt` branch has a response: not admin → 404 (every op); self target → 409 `self_target`; journal write failed → 503 `not_applied` / `audit_unavailable`; validation → 422 `invalid_value` / `query_too_short` / `invalid_period` (not journaled); deletion pending → 409 `deletion_pending`; email mismatch → 422 `confirm_email_mismatch`; 10 per 60 min → 429 `deletion_rate_limit`; stale login → 401 `reauth_required`; not scheduled / window passed → 409 `not_scheduled`; admission refusal → 403 / 503 / 429 with no quota change; non-scheduler token → 404.

### Back-feed (coverage)

- **Every AC → operation/response:** ✓ AC-01…AC-36 are all covered (table A). Some ACs are covered outside HTTP: AC-05 (CSP + text-only render, ADR-0002), AC-27 and AC-29 site side (Firestore `publicStatus`), AC-22 (sweep), AC-08 restore (one-off migration 06).
- **Every operation → story + AC:** ✓. `getSettings` maps to US-12/13/14 (the screen that hosts AC-24…AC-30). `runSweep` maps to US-05/US-11 (AC-08, AC-22).
- **Every §6 `alt` branch → response:** ✓ (point 4).
- **Sequence gaps** (responses the contract needs that no §6 flow shows). All are resolved as **Save-as-OQ, owner `sequences`** (decided 2026-10-08):

| # | Gap | Contract response (in place) |
|---|---|---|
| G1 | remove a personal limit that isn't set | 409 `not_set`, not journaled |
| G2 | unrestrict a user who isn't restricted | 409 `not_set`, not journaled |
| G3 | schedule a deletion that is already scheduled | 409 `deletion_pending`, journaled as rejected |
| G4 | card / action for an unknown or already purged uid | 404 `not_found` («User not found») |
| G5 | invalid period on the job-history filter | 422 `invalid_period` (≤ 90 days = history TTL) |

### Notes (supporting, no action blocks the contract)

- **Cancel deletion, «not scheduled»:** data-model lists `not_scheduled` as an `adminAudit.rejectReason` (journaled), but §6 «Скасувати видалення» draws no journal write on that branch. The contract follows data-model; redraw the branch along with the G1–G5 gaps.
- **Restriction reason while a deletion is scheduled:** AC-20 says the restriction applies at once, but no artifact says what `restriction.reason` contains when there was no prior restriction (the 200 example uses a placeholder). Low confidence; settle it in `tasks`. Two options: a fixed server text, or nullable `reason` during a deletion.
- **Track pages after the card** are not journaled again. This follows §6 (`opt наступна сторінка` has no journal write); the card view that precedes them is journaled.
- **`/api/internal/sweep` and AuthMiddleware:** the middleware accepts only Firebase tokens on `/api/*` today, so this path needs an OIDC branch. That is an implementation note for `tasks`; the contract fixes the path and the scheme.
- **Origin hint (`origin: file|mic`)** on `/api/jobs/upload` (form field) and `/api/jobs/storage` (JSON) was **added 2026-10-08** and closes the data-model TBD. The site must start sending it before the «мікрофон» column is accurate.

## Open questions

| # | Question | Owner | Due |
|---|---|---|---|
| OQ-API-1 | Draw §6 branches for G1–G5 and the journal write on «cancel deletion → not scheduled» | `sequences` | before the contract is finalized |
| OQ-API-2 | Text of `restriction.reason` set by a scheduled deletion with no prior restriction (fixed text vs nullable) | `data-model` | before `sdd:tasks` |

## Reconcile log

- 2026-10-08 — first derivation (v0.1.0). 0 `# stale` fields, 0 `# manual-addition` fields.

# Tracker — admin

> Status of every task in the epic. `implement` updates `done` as it commits each task.
> States: `todo` · `in_progress` · `blocked` · `review` · `done`. Estimates: S ≈ ½ day, M ≈ 1 day.

| # | Task | Layer | Owner | Estimate | Blocked by | Status |
|---|---|---|---|---|---|---|
| [T01](./t01-firestore-client-batch-tx-query.md) | Extend the Firestore REST client with batched writes, transactions, queries and aggregations | infra | Тарас Щадило | M | — | done |
| [T02](./t02-admin-test-fixtures.md) | Add admin test fixtures, hostile strings and an emulator seeder | tests | Тарас Щадило | S | T01 | done |
| [T03](./t03-admin-error-codes.md) | Register the 16 admin error codes and map admin validation errors to invalid_value | domain | Тарас Щадило | S | — | done |
| [T04](./t04-admin-models-validators.md) | Define admin request/response models with the spec'd validation ranges | domain | Тарас Щадило | M | T03 | done |
| [T05](./t05-migration-track-size.md) | Promote migration 01 (tracks.sizeBytes backfill) and write sizeBytes on publish | migration | Тарас Щадило | S | — | done |
| [T06](./t06-migration-indexes-ttl-rules.md) | Promote migrations 02–03: composite indexes, TTL/exemptions and Firestore rules | migration | Тарас Щадило | S | T05 | done |
| [T07](./t07-migration-seed-config-email-index.md) | Promote migrations 04–05: seed runtime config + public status and build the email index | migration | Тарас Щадило | S | T06 | done |
| [T08](./t08-migration-restore-stats.md) | Promote migration 06: restore pre-launch daily stats from tracks | migration | Тарас Щадило | S | T07 | done |
| [T09](./t09-admin-router-authz.md) | Mount the admin router behind allowlist authz, 404-identical denial, probe rate limit and fresh-login check | app | Тарас Щадило | M | T01, T03 | done |
| [T10](./t10-admin-audit-writer.md) | Implement the audit writer: atomic with Firestore changes, journal-first otherwise, before any view response | app | Тарас Щадило | M | T01, T04 | done |
| [T11](./t11-history-stats-projections.md) | Build job-history and daily-stats projections with the failure-reason map and the pending buffer | app | Тарас Щадило | M | T01, T04 | done |
| [T12](./t12-jobmanager-projection-hooks.md) | Hook projections into JobManager, accept the origin hint and discard results for tombstoned uids | wiring | Тарас Щадило | S | T11 | done |
| [T13](./t13-runtime-settings-cache.md) | Implement runtime settings: 30 s lazy cache, env fallback and the public-status mirror writer | app | Тарас Щадило | S | T01, T04 | done |
| [T14](./t14-admission-gate.md) | Gate all five cloud-job entries through one admission check before Quotas.consume | app | Тарас Щадило | M | T03, T12, T13 | done |
| [T15](./t15-api-overview-settings.md) | Serve getOverview and getSettings | ports | Тарас Щадило | S | T09, T11, T13 | done |
| [T16](./t16-email-index-directory.md) | Implement the email-index directory: shard load, incremental catch-up and in-memory substring search | infra | Тарас Щадило | M | T01 | done |
| [T17](./t17-api-search-card-tracks.md) | Serve searchUsers, getUserCard and listUserTracks with view journaling | ports | Тарас Щадило | M | T05, T09, T10, T16 | done |
| [T18](./t18-api-job-history-stats.md) | Serve listJobHistory and getStats | ports | Тарас Щадило | S | T09, T11 | done |
| [T19](./t19-api-audit-list.md) | Serve listAudit with email resolution and «видалений» for purged users | ports | Тарас Щадило | S | T09, T10, T16 | done |
| [T20](./t20-actions-quota-personal-limit.md) | Implement resetQuota and set/remove personal limit | app | Тарас Щадило | M | T09, T10, T14 | done |
| [T21](./t21-actions-restriction.md) | Implement restrictUser and unrestrictUser as transactions with the audit record | app | Тарас Щадило | S | T20 | done |
| [T22](./t22-actions-deletion.md) | Implement scheduleDeletion and cancelDeletion with email confirm, fresh login and the 10-per-60-min cap | app | Тарас Щадило | M | T21 | done |
| [T23](./t23-actions-settings-switches-banner.md) | Implement setDefaultLimits, setSwitch and setBanner with mirrored, audited batched writes | app | Тарас Щадило | M | T09, T10, T13, T15 | done |
| [T24](./t24-sweep-endpoint-reconcile.md) | Add the OIDC-protected sweep endpoint: slot claim, buffer replay, stale jobs, reconcile+freeze, index sync | app | Тарас Щадило | M | T09, T11, T16 | done |
| [T25](./t25-purge-deletion.md) | Implement tombstone-first, idempotent account purge with anonymization | app | Тарас Щадило | M | T10, T22, T24 | done |
| [T26](./t26-ops-grant-scheduler-alerts.md) | Add the owner grant script, Cloud Scheduler jobs, max-instances guard and alerting | wiring | Тарас Щадило | S | T09, T24 | done |
| [T27](./t27-ui-admin-entry-csp.md) | Create the admin.html entry with strict CSP, admin shell, sign-in and not-found for non-admins | ui | Тарас Щадило | M | — | done |
| [T28](./t28-ui-admin-api-client.md) | Build the admin API client with re-auth flow, error-code i18n and the no-polling refresh policy | ui | Тарас Щадило | M | T27 | done |
| [T29](./t29-ui-overview-screen.md) | Build the Overview screen | ui | Тарас Щадило | S | T28 | done |
| [T30](./t30-ui-users-search-card.md) | Build user search, the user card and paged songs (metadata only) | ui | Тарас Щадило | M | T28 | done |
| [T31](./t31-ui-jobs-stats-screens.md) | Build the job-history and statistics screens | ui | Тарас Щадило | M | T28 | done |
| [T32](./t32-ui-audit-screen.md) | Build the admin journal screen | ui | Тарас Щадило | S | T28 | done |
| [T33](./t33-ui-card-quota-limit-actions.md) | Add quota reset and personal-limit actions to the user card | ui | Тарас Щадило | S | T30 | done |
| [T34](./t34-ui-card-restriction-deletion-actions.md) | Add restriction and scheduled-deletion actions to the user card | ui | Тарас Щадило | M | T33 | done |
| [T35](./t35-ui-settings-screen.md) | Build the service-settings screen: default limits, switches and maintenance banner | ui | Тарас Щадило | M | T28 | done |
| [T36](./t36-ui-site-service-status-banner.md) | Read the public service status on the site: maintenance banner and YouTube-off fallback | ui | Тарас Щадило | M | — | done |
| [T37](./t37-ui-site-admission-refusals.md) | Show admission refusals on the site and send the origin hint | ui | Тарас Щадило | S | T36 | done |
| [T38](./t38-nfr-security-verification.md) | Add the NFR and security verification suite | tests | Тарас Щадило | M | T02, T15, T17, T18, T19, T23, T29, T30, T36 | done |
| [T39](./t39-docs-admin-runbook.md) | Document the admin: CLOUD.md section, grant/revoke runbook, migration order and alerts | docs | Тарас Щадило | S | T26 | done |

**Total:** 39 tasks, ~30 person-days.
| [T40](./t40-enforce-the-admin-set-duration-and-upload-limits-a.md) | Enforce the admin-set duration and upload limits at every check | app | Тарас Щадило | S | T14, T23 | done |
| [T41](./t41-apply-the-youtube-switch-to-youtube-links-only-and.md) | Apply the YouTube switch to YouTube links only and filter the history by source type | app | Тарас Щадило | S | T40 | done |
| [T42](./t42-mark-quiet-and-pre-launch-days-as-restored-and-omi.md) | Mark quiet and pre-launch days as restored and omit empty days from /stats | app | Тарас Щадило | S | T41 | done |
| [T43](./t43-make-the-list-endpoints-match-the-contract-before.md) | Make the list endpoints match the contract: before cursor, truncated, 422 cases | ports | Тарас Щадило | S | T42 | done |
| [T44](./t44-seed-the-maintenance-banner-with-valid-non-empty-t.md) | Seed the maintenance banner with valid non-empty texts | migration | Тарас Щадило | S | T43 | done |
| [T45](./t45-harden-account-deletion-missing-profile-purged-tok.md) | Harden account deletion: missing profile, purged-token reuse, buffered replay, cancel after purge | app | Тарас Щадило | S | T44 | done |
| [T46](./t46-fix-the-admin-ui-song-flags-csp-hosts-frame-guard.md) | Fix the admin UI: song flags, CSP hosts, frame guard, one language, shared classes | ui | Тарас Щадило | S | T45 | done |
| [T47](./t47-test-the-site-s-admission-refusals-and-share-one-i.md) | Test the site's admission refusals and share one isAdminRefusal helper | ui | Тарас Щадило | S | T46 | done |
| [T48](./t48-stop-leaking-admin-routes-via-options-and-require.md) | Stop leaking admin routes via OPTIONS and require a verified email in the grant script | app | Тарас Щадило | S | T45 | done |
| [T49](./t49-consolidate-the-in-memory-firestore-fakes-and-fix.md) | Consolidate the in-memory Firestore fakes and fix the AC-13b settings test | tests | Тарас Щадило | S | T48 | done |
| [T50](./t50-run-the-emulator-tests-in-ci-and-align-the-test-pl.md) | Run the emulator tests in CI and align the test plan with the levels used | tests | Тарас Щадило | S | T49 | done |
| [T51](./t51-offer-the-tab-on-the-fragment-picker-when-the-clou.md) | Offer the tab on the fragment picker when the cloud refuses for the admin's reason | ui | Тарас Щадило | S | T47 | done |
| [T52](./t52-label-quiet-pre-launch-days-as-restored-and-show-t.md) | Label quiet pre-launch days as restored and show the YouTube source in job rows | migration | Тарас Щадило | S | T42, T41 | done |
| [T53](./t53-pass-the-admin-set-upload-limit-to-the-link-and-fr.md) | Pass the admin-set upload limit to the link and fragment downloads on every job | app | Тарас Щадило | S | T40 | done |
| [T54](./t54-keep-get-settings-and-get-jobs-inside-the-contract.md) | Keep GET /settings and GET /jobs inside the contract | ports | Тарас Щадило | S | T43, T44 | done |
| [T55](./t55-resolve-accounts-through-firebase-auth-and-let-onl.md) | Resolve accounts through Firebase Auth and let only the purge delete a profile | app | Тарас Щадило | S | T45 | done |
| [T56](./t56-refuse-uploads-from-a-purged-account-in-the-storag.md) | Refuse uploads from a purged account in the Storage rules | wiring | Тарас Щадило | S | T45 | done |
| [T57](./t57-close-the-small-security-and-infra-gaps-sweep-401.md) | Close the small security and infra gaps: sweep 401, grant fails closed, tombstone reads, admin preflight | app | Тарас Щадило | S | T48 | done |
| [T58](./t58-guard-the-query-shapes-the-in-memory-firestore-ser.md) | Guard the query shapes the in-memory Firestore serves | tests | Тарас Щадило | S | T49 | done |
| [T59](./t59-make-the-emulator-ci-job-install-ffmpeg-fail-on-un.md) | Make the emulator CI job install ffmpeg, fail on unexpected skips and pin firebase-tools | tests | Тарас Щадило | S | T50 | done |
| [T60](./t60-show-the-shared-dialogs-and-pages-of-the-admin-pag.md) | Show the shared dialogs and pages of the admin page in Ukrainian | ui | Тарас Щадило | S | T46 | done |
| [T61](./t61-use-one-label-per-status-and-switch-across-the-adm.md) | Use one label per status and switch across the admin screens | ui | Тарас Щадило | S | T52 | done |
| [T62](./t62-make-the-test-plan-say-what-is-tested-where-today.md) | Make the test plan say what is tested where today | docs | Тарас Щадило | S | T50 | done |
| [T63](./t63-import-the-shared-test-fakes-from-fixtures-never-f.md) | Import the shared test fakes from fixtures, never from another test module | tests | Тарас Щадило | S | T58 | done |
| [T64](./t64-check-every-query-against-an-index-in-its-declared.md) | Check every query against an index in its declared direction, and keep the 18 ascending/descending indexes in step | tests | Тарас Щадило | S | T58 | done |

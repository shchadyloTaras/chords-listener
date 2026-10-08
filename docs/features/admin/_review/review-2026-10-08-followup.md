# Review — admin — 2026-10-08, follow-up rounds

**Gate result: PASS** (after the fixes below; nothing open at stage 1)

## Scope

- Round 1: the fixes for [review-2026-10-08.md](review-2026-10-08.md) (T40–T50, `92a7882..a96f277`) and the merge of `main` (`104b808`, the tuner). Three clean-context `sdd:reviewer` passes: stage-1 AC trace of S1-1..S1-13; security S2-1..S2-8; quality / CI S2-5, S2-9..S2-14.
- Production check after the first deploy (2026-10-08): every query shape against the deployed composite indexes, read-only.
- Round 2: T51–T64 and the live e2e layer (`ded3c33..66bf88e`), one clean-context `sdd:reviewer` pass.

## Round 1 — findings and verdicts

All **Fix now**, delivered as T51–T63 (task files `tasks/t51-*.md` … `t63-*.md`):

| Finding | Task |
|---|---|
| Fragment picker only toasted an admin refusal; no «Слухати у вкладці» (AC-27, AC-18/26) | T51 |
| Pre-launch quiet days not «відновлено з пісень» (AC-08); job rows without the YouTube label (AC-07), with a test that could not fail | T52 |
| Link and fragment downloads capped by the deploy-time size, not the admin's (AC-25) | T53 |
| Settings fallback answered an empty banner (openapi `Banner` minLength 1); `/jobs` 422 `invalid_value` undeclared | T54 |
| A user could delete their own profile and drop out of the admin's reach; profile-less accounts unresolvable (S2-1) | T55 |
| A purged account's token could still upload to Storage (S2-2) | T56 |
| Unauthenticated `/api/internal/sweep` told apart from other addresses; grant script failed open on a missing `emailVerified`; catch-up read every tombstone; no admin CORS preflight test | T57 |
| T49's shared fake lost the query-shape checks | T58 |
| CI emulator job had no ffmpeg, so the admission suite skipped silently; firebase-tools unpinned (S2-5) | T59 |
| Shared dialogs, toasts and not-found page followed the site language on the Ukrainian admin page (S2-9) | T60 |
| Labels still duplicated and disagreeing across admin screens (S2-10) | T61 |
| Test plan understated AC-26 and named levels without tests (S2-12) | T62 |
| Test modules still importing fakes from other test modules (S2-13) | T63 |

Also found while verifying: `ded3c33` — the admin page started settings sync (a Firestore listener) that its CSP blocks since T46; the browser e2e had been failing since `a04e36c`.

## Production check — indexes

Firestore served each composite index **only in its declared direction**; an inequality without `orderBy` is ordered ascending; `count()` needs the query's index. With the 9 descending indexes, production refused: the sweep's stale-jobs step (the deployed revision's first wake sweep failed on it), the deletion cap's count, per-reason counts over a period, back-paging (`before`) of jobs and journal, and the purge's ascending walks. The emulator does not enforce indexes, so no test had seen it.

- `aa023f4`: an ascending twin of each composite (18), deployed and probed: every shape served.
- T64 (`4922c90`): the in-test guard reads an index only in its direction, models the implicit ascending order and aggregations; 91 tests fail against the old 9-index file.

## Round 2 — findings and verdicts

| Finding | Severity | Verdict |
|---|---|---|
| Staged migration 03 drifted from `firestore.rules` after merging main (sopilka / flute) | med | Fixed — `91685df` (up = the rules; down = main's rules, keeping the new instruments) |
| MemDb ordered a range without `orderBy` by document name, unlike Firestore | low | Fixed — `fa35d04` |
| `live_e2e.py` accepted any emulator host | low | Fixed — `fa35d04` (loopback only) |
| Nightly live e2e lacks Linux banner baselines | low | Fixed at release — the workflow's `update_snapshots` run produces them (docs/CLOUD.md «Live e2e») |
| `/api/internal/sweep` answers a 503 instead of the generic 401 while Google's certificates are unreachable | low | Not an issue for v1 — only during a Google outage, it reveals that an internal route exists and nothing else; no data, no action |

Per task: T51–T63 OK; T55 and T64 OK after `91685df`.

## Test evidence (HEAD `fa35d04`)

| Suite | Result |
|---|---|
| Backend under Firestore + Auth emulators, `CHORDS_FAIL_ON_SKIP=1` | 1535 passed, 5 skipped (optional vocals extra ×4, one purge test that needs the real collections) |
| Backend offline | 1356 passed, 183 skipped (emulator-only) |
| Firestore rules / Storage rules | 57 / 57, 19 / 19 |
| Frontend vitest | 1572 passed |
| oxlint, `tsc -b`, `tsc -p tsconfig.e2e.json` | clean |
| Build + `check-admin-bundle.mjs` | strict CSP, no TF.js / models / wasm |
| Playwright e2e (stubbed API) | 2 / 2 |
| Live e2e (browser + server + emulators, real time) | 8 / 8; the 30-minute idle spec 1 / 1 (once, on the branch) |

## Next

Ship: merge into `main`, push (GitHub Pages builds the site and `admin.html`), produce the Linux banner baselines, measure the cloud cold start (`scripts/measure_cold_start.py`).

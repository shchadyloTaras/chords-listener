# YouTube in the browser, clearer UX, fewer cloud wake-ups — Implementation Plan (A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the hosted site the cloud never downloads YouTube (YouTube blocks Google Cloud IPs); YouTube is always listened to in the browser; the listening / phone / account / error flows become clear; a signed-in user wakes the Cloud Run server only for real work (a new analysis, vocals, an edit), not for opening the site or replaying a song.

**Architecture:** Frontend only (`frontend/src`). Link routing decides "listen here" vs "server job" before any request. Capture errors keep their browser detail. A small IndexedDB cache (`lib/cloud/cache.ts`) keeps the signed-in user's library list, track JSON, audio, notes and vocals on the device; health and job listing become lazy. The backend, rules and deploy scripts are untouched (plan B moves the library index to Firestore / Storage later).

**Tech Stack:** React 19, TypeScript, zustand, Tailwind, vitest (+ fake-indexeddb, jsdom), IndexedDB.

**Spec:** the owner's decisions recorded in "Decisions" below (from the 2026-10-05 session).

## Decisions (spec)

1. Keep Firebase as an option: guests use everything in the browser and make zero requests to Cloud Run / Firestore / Storage / Auth (already true on branch `guest-on-device`, must stay true).
2. The hosted cloud (`useConnection.backend === 'cloud'`) never downloads YouTube. A YouTube link — guest or signed-in — goes to the capture page `#/listen/youtube/<id>`. Where the browser can hear its tab (`canListenInTab()`), that page plays the video and listens to the tab; elsewhere it offers on-device ways (microphone with the song playing on another device, a file, or opening the page on a computer in Chrome / Edge). A signed-in user's tab recording still uploads to the cloud for the full analysis (existing `saveRecording`).
3. A local server (`backend === 'local'`, `./start.sh` or the user's own server) still downloads YouTube (home IP) and every other link.
4. Links to other sites: cloud / local server download them as today; a guest gets the account prompt (unchanged).
5. UX: (a) tab capture explains itself and shows the real cause of a failure; the sample dialog must not look clickable; (b) phones and other browsers get a clear on-device choice instead of an account wall; (c) account copy says what an account really gives — more precise chords (server engine), vocals, the library on every device — never "the server downloads YouTube"; (d) waiting / errors: cold start is visible, every error has a way forward.
6. Optimization phase 1 (this plan): device cache + lazy health / job listing + calmer polling. Phase 2 (separate plan B): library index in Firestore, files straight from Storage.

## Global Constraints

- Every new or changed UI string has `uk` (informal "ти", short and warm) and `en` entries in `frontend/src/i18n/*.ts`; remove keys that become unused.
- Do not touch `backend/`, `scripts/`, `.github/`, `firestore.rules`, `storage.rules`, `firebase.json`.
- A fresh guest still loads no Firebase SDK and makes no cross-origin request (see `src/lib/auth.test.ts`, `src/lib/authMarker.ts`).
- `cd frontend && npx vitest run`, `npm run build`, `npm run lint` pass after every task.
- Work on branch `guest-on-device`; one commit per task; message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.
- Code style: match the surrounding code (comment density, naming, no new dependencies).

## Review Focus

1. A signed-in user on desktop Chrome pastes a YouTube link → the capture page opens (no `POST /api/jobs`), and the saved recording is uploaded to the cloud with `source: {type:'youtube'}` and `startOffset` → pinned in Task 1 (`startLink` test "signed in on the cloud: YouTube is listened to here").
2. A cached track whose signed `audioUrl` has expired still plays (from the cached blob); a cache miss with an expired URL refetches the track JSON once → pinned in Task 7 (`cache.test.ts` "expired audio URL").
3. A track deleted or edited on this device never reappears from the cache; one changed on another device shows after the list TTL or a manual refresh → pinned in Task 7 ("delete removes it from the cached list", "edit replaces the cached track").
4. IndexedDB missing / quota exceeded (Safari private mode) → the cache is a silent no-op and everything goes to the network → pinned in Task 7 ("works without IndexedDB").
5. Sign-out or another account on the same browser → no cached data of the previous uid is shown → pinned in Task 7 ("keys by uid; clearCloudCache on sign-out").

---

### Task 1: Link routing — the cloud never downloads YouTube

**Files:**
- Modify: `frontend/src/components/input/startLink.ts` (whole file)
- Modify: `frontend/src/hooks/useJobs.ts:119-125` (blocked toast), `:294-307` (`retryJob`)
- Modify: `frontend/src/components/input/SmartInput.tsx:198-206, 262-299, 382-389`
- Delete: `frontend/src/components/account/YoutubeAccountCard.tsx`
- Modify: `frontend/src/components/capture/CapturePage.tsx:31, 158-228, 539-557` (remove the account / resume flow only; Task 2 reworks the rest)
- Modify: `frontend/src/i18n/cloud.ts` (remove `cloud.ytAccount.*`, `cloud.input.hintYoutubeAccount`, `cloud.input.accountTextNoTab`; reword `cloud.input.hintGuestNoTab`)
- Modify: `docs/SPEC.md:114` (browser mode paragraph), `docs/CLOUD.md` "YouTube" section (client side only: "the hosted site never sends YouTube links to the cloud")
- Test: `frontend/src/components/input/startLink.test.ts`

**Interfaces:**
- Produces: `startLink(url: string): Promise<LinkStart>` with `LinkStart = {kind:'job'; job: Job} | {kind:'capture'; videoId: string} | {kind:'account'}`; `linkTarget(url: string, conn: Pick<ConnectionState,'status'|'backend'>): 'capture' | 'server' | 'account'` — pure, lives in `frontend/src/components/input/url.ts` (so `hooks/useJobs.ts` can import it without a cycle) and is re-exported from `startLink.ts`. `submitWhenConnected` stays (non-YouTube links after sign-in). `submitAfterSignIn` is removed.

- [ ] **Step 1: Write the failing tests** — replace the YouTube cases in `startLink.test.ts` (keep the file's mocks):

```ts
describe('linkTarget', () => {
  const YT = 'https://youtu.be/dQw4w9WgXcQ'
  it.each([
    ['guest', { status: 'browser', backend: null }, YT, 'capture'],
    ['cloud', { status: 'server', backend: 'cloud' }, YT, 'capture'],
    ['local server', { status: 'server', backend: 'local' }, YT, 'server'],
    ['cloud, other site', { status: 'server', backend: 'cloud' }, 'https://soundcloud.com/a/b', 'server'],
    ['guest, other site', { status: 'browser', backend: null }, 'https://soundcloud.com/a/b', 'account'],
  ] as const)('%s', (_name, conn, url, target) => {
    expect(linkTarget(url, conn)).toBe(target)
  })
})

it('signed in on the cloud: YouTube is listened to here, nothing is sent', async () => {
  cloud()
  expect(await startLink(VIDEO)).toEqual({ kind: 'capture', videoId: 'dQw4w9WgXcQ' })
  expect(route.navigate).toHaveBeenCalledWith('/listen/youtube/dQw4w9WgXcQ')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('phone / Safari / Firefox: YouTube still opens the capture page (on-device ways), nothing is sent', async () => {
  guest()
  live.canListenInTab.mockReturnValue(false)
  expect(await startLink(VIDEO)).toEqual({ kind: 'capture', videoId: 'dQw4w9WgXcQ' })
  expect(fetchMock).not.toHaveBeenCalled()
})
```

Delete the tests for "guest on a phone … needs an account", "signed in: the cloud downloads the video" and the whole `submitAfterSignIn` describe block. Keep "local server: it downloads the video" and "guest with a link to another site".

- [ ] **Step 2: Run** `cd frontend && npx vitest run src/components/input/startLink.test.ts` — expected: FAIL (`linkTarget` is not exported; cloud case returns `job`).

- [ ] **Step 3: Implement** — add `linkTarget` (below) to `url.ts` (`import type { ConnectionState } from '../../lib/serverMode'`), then `startLink.ts` imports it and re-exports it (`export { linkTarget } from './url'`):

```ts
import { toApiError } from '../../lib/api'
import { useConnection, whenSettled, type ConnectionState } from '../../lib/serverMode'
import { submitUrl } from '../../hooks/useJobs'
import { navigate, paths } from '../../hooks/useRoute'
import type { Job } from '../../types'
import { parseYouTubeId } from './url'

export type LinkStart =
  /** a server took the link: its job page is open */
  | { kind: 'job'; job: Job }
  /** a YouTube video: played and listened to on the capture page (tab, or the on-device ways) */
  | { kind: 'capture'; videoId: string }
  /** another site and no server: only the cloud can fetch it (sign in) */
  | { kind: 'account' }

/**
 * Where a link goes. YouTube refuses the cloud's servers, so on the cloud (and without a server) a
 * YouTube video is listened to in the browser; a local server (home connection) downloads it.
 */
export function linkTarget(url: string, conn: Pick<ConnectionState, 'status' | 'backend'>): 'capture' | 'server' | 'account' {
  const server = conn.status === 'server'
  if (parseYouTubeId(url)) return server && conn.backend === 'local' ? 'server' : 'capture'
  return server ? 'server' : 'account'
}

/** Starts a link (see linkTarget). Throws ApiError when the server refuses it. */
export async function startLink(url: string): Promise<LinkStart> {
  // still choosing the API (auth restoring, first probe): wait, so a cloud user is not treated as a guest
  const conn = useConnection.getState().status === 'checking' ? await whenSettled() : useConnection.getState()
  const target = linkTarget(url, conn)
  const videoId = parseYouTubeId(url)
  if (target === 'capture' && videoId) {
    navigate(paths.capture(videoId))
    return { kind: 'capture', videoId }
  }
  if (target === 'account') return { kind: 'account' }
  try {
    return { kind: 'job', job: await submitUrl(url) }
  } catch (e) {
    const err = toApiError(e)
    if (err.code === 'server_required') return { kind: 'account' }
    throw err
  }
}
```

Keep `submitWhenConnected` unchanged below it; delete `submitAfterSignIn` and its `useAuth` import. (`whenSettled(timeoutMs = 10_000): Promise<ConnectionState>` is the existing export of `lib/serverMode.ts`.)

- [ ] **Step 4: `retryJob` and the blocked toast** (`useJobs.ts`): when the job's source is YouTube and the connection is the cloud, retry opens the capture page instead of re-sending:

```ts
if (job.source?.type !== 'file' && job.source?.url) {
  const videoId = parseYouTubeId(job.source.url)
  if (videoId && linkTarget(job.source.url, useConnection.getState()) === 'capture') {
    navigate(paths.capture(videoId))
    return true
  }
  await submitUrl(job.source.url)
  return true
}
```

(import `linkTarget` from `../components/input/url`.) The blocked toast action (lines 119-125) stays (`paths.capture(id, {blocked:true})`), it is only reached for old jobs.

- [ ] **Step 5: SmartInput** — the waiting link (`submitWhenConnected`) is armed only for non-YouTube links (`hint.kind === 'account' && !checkUrl(value).videoId`); remove `youtubeForAccount`, the `YoutubeAccountCard` import/render, and the device-dependent YouTube account hints. Hints for YouTube: tab-capable → `cloud.input.hintYoutubeGuest` («Відео з YouTube послухаємо прямо тут»); not tab-capable → new key `cloud.input.hintYoutubeHere` uk: «Відео з YouTube — відкриємо його тут і підкажемо, як його послухати», en: «YouTube video — we'll open it here and show how to listen to it». Cloud users get the same YouTube hints (not `core.input.hintYoutube`).

- [ ] **Step 6: CapturePage** — delete `needsAccount`, `resume`, `sending`, the `submitAfterSignIn` effect, and the `YoutubeAccountCard` / sending / failed cards (lines 160-228, 539-557). `NoTabCapture` shows whenever `!tabCapture`. Delete `YoutubeAccountCard.tsx`.

- [ ] **Step 7: Run** `npx vitest run && npm run build && npm run lint` — expected: PASS. Update `docs/SPEC.md:114` and `docs/CLOUD.md` (YouTube → "Client: the hosted site never sends YouTube links to the cloud; a local server still downloads them").

- [ ] **Step 8: Commit** `git add -A frontend docs && git commit -m "YouTube is always listened to in the browser on the hosted site"` (+ trailer).

---

### Task 2: Capture page and the on-device ways (phones, Safari, Firefox)

**Files:**
- Modify: `frontend/src/components/capture/CapturePage.tsx:100-143` (`NoTabCapture`), `:430-450` (header), `:457-474` (player overlays), `:413-422` (status text), `:497` (status bar), `:614` (guest line)
- Modify: `frontend/src/hooks/useRoute.ts:22` (`paths.listen` gets an optional title)
- Modify: `frontend/src/components/capture/ListenPage.tsx:94-102, 238`
- Modify: `frontend/src/i18n/cloud.ts` (`cloud.capture.phone.*`, `cloud.capture.intro`, `cloud.capture.signInHint`, new keys below)
- Test: `frontend/src/hooks/useRoute.test.ts` (create if missing), `frontend/src/components/capture/machine.test.ts` (starting hint)

**Interfaces:**
- Consumes: Task 1 (capture page is reached for every YouTube link on the cloud / without a server).
- Produces: `paths.listen(source?: 'mic'|'tab', opts?: {title?: string})` → `/listen?src=mic&title=<enc>`; `Route` `{name:'listen'; source; title: string | null}`; `STARTING_HINT_MS = 8000` exported from `machine.ts`.

- [ ] **Step 1: Failing tests**

```ts
// useRoute.test.ts
import { describe, expect, it } from 'vitest'
import { parseHash, paths } from './useRoute'

describe('listen route title', () => {
  it('round-trips a title', () => {
    const p = paths.listen('mic', { title: 'Анна — Пісня & co' })
    expect(parseHash(`#${p}`)).toEqual({ name: 'listen', source: 'mic', title: 'Анна — Пісня & co' })
  })
  it('no title', () => {
    expect(parseHash('#/listen?src=mic')).toEqual({ name: 'listen', source: 'mic', title: null })
  })
})
```

- [ ] **Step 2: Run** `npx vitest run src/hooks/useRoute.test.ts` — FAIL.

- [ ] **Step 3: Implement** `paths.listen`:

```ts
listen: (source?: 'mic' | 'tab', opts: { title?: string } = {}) => {
  const q = new URLSearchParams()
  if (source) q.set('src', source)
  if (opts.title) q.set('title', opts.title.slice(0, 200))
  const s = q.toString()
  return s ? `/listen?${s}` : '/listen'
},
```

and in `parseHash` for `/listen`: `title: query.get('title') || null`. ListenPage reads `route.title` and saves with `title: route.title ?? recordingTitle()` (lines 99-102); App passes the route's title to ListenPage (check `App.tsx` route switch).

- [ ] **Step 4: NoTabCapture** — device-neutral, three ways, video title kept. Replace the card body with:
  - title `cloud.capture.here.title` uk «Тут звук вкладки не послухати», en «This browser can't share a tab's sound»
  - text `cloud.capture.here.text` uk «Телефони, Safari та Firefox не дають сайтам звук вкладки. Обери інший спосіб:», en «Phones, Safari and Firefox don't give sites a tab's sound. Pick another way:»
  - button 1 (primary) `cloud.capture.here.mic` uk «Увімкни відео на іншому пристрої — я послухаю мікрофоном», en «Play the video on another device — I'll listen with the microphone» → `navigate(paths.listen('mic', { title: videoTitle ?? undefined }))` (pass the page's `title` state as a prop)
  - button 2 `cloud.capture.phone.file` (existing «Вибрати файл»)
  - button 3 `cloud.capture.here.copy` uk «Скопіювати посилання для компʼютера», en «Copy the link for a computer» → `copyText(location.href)` (`lib/clipboard.ts`) + toast `cloud.capture.here.copied` uk «Посилання скопійовано — відкрий його в Chrome або Edge на компʼютері», en «Link copied — open it in Chrome or Edge on a computer»
  - keep the «Відкрити на YouTube» link.
  Remove `cloud.capture.phone.title` / `.text` / `.mic`.

- [ ] **Step 5: Header and side lines** — intro (`cloud.capture.intro` / `.blocked`) only when `tabCapture`; when `!tabCapture` show `cloud.capture.here.intro` uk «Відео можна дивитися тут, а акорди — розпізнати одним зі способів нижче.», en «You can watch the video here and get its chords one of the ways below.». The sign-in line (lines 442-449) shows only when `useCloudInvite()` (not on a local server) and uses new `cloud.capture.accountHint` uk «З акаунтом цей запис розпізнає сервер — точніше, з вокалом і на всіх пристроях.», en «With an account the server analyzes this recording — more precise, with vocals, on all your devices.». Delete line 614 (`!cloud && signedIn` guest text) and `cloud.capture.signInHint`.

- [ ] **Step 6: Player overlays** — `playerStatus === 'error'`: add a «Спробувати ще раз» button (`core.retry`) that re-creates the player (bump a `playerKey` state included in the player effect's deps). `playerStatus === 'embed'`: add a link button to `paths.listen('tab', { title })` labelled `cloud.capture.embedListen` uk «Слухати іншу вкладку», en «Listen to another tab» (only when `tabCapture`).

- [ ] **Step 7: Starting hint** — in `CapturePage`, when `state.phase === 'starting'` for more than `STARTING_HINT_MS` (8000, exported from `machine.ts`), status text becomes `cloud.capture.startingSlow` uk «Відео не стартує? Натисни ▶ на самому відео.», en «Video not starting? Press ▶ on the video itself.» (a `useEffect` with `setTimeout`, cleared on phase change). Also show the Pause/Cancel controls in `starting` (Cancel only).

- [ ] **Step 8: Recording bar** — `CapturePage.tsx:497` `border-danger/40` → `border-accent/40` (recording is not an error).

- [ ] **Step 9: ListenPage footer** (line 238) — `cloud.listen.saveGuest` only when `useCloudInvite()`; on a local server show nothing.

- [ ] **Step 10: Run** `npx vitest run && npm run build && npm run lint` — PASS. Commit "Capture page: clear on-device ways where the tab can't be heard".

---

### Task 3: Capture errors with their real cause

**Files:**
- Modify: `frontend/src/lib/live/types.ts:86` (`CaptureErrorCode` += `'blocked'`)
- Modify: `frontend/src/lib/live/capture.ts:80-106` (`toCaptureError`)
- Modify: `frontend/src/components/capture/machine.ts:37-42, 72-104` (`detail`)
- Modify: `frontend/src/components/capture/useCapture.ts:31-33, 148, 161`
- Modify: `frontend/src/components/capture/CapturePage.tsx:57-72, 562-613`, `ListenPage.tsx:19-25, 180-240`
- Modify: `frontend/src/components/capture/ShareTabIllustration.tsx`
- Modify: `frontend/src/i18n/cloud.ts:90-100, 229-238`, `frontend/src/i18n/live.ts:40-45`
- Test: `frontend/src/lib/live/capture.test.ts`, `frontend/src/components/capture/machine.test.ts`

**Interfaces:**
- Produces: `CaptureState.detail: string | null`; event `{type:'failed'; error: CaptureFailure; detail?: string}`; `failureOf(err: unknown): {code: CaptureFailure; detail: string | null}`; `isRetryable(code: CaptureFailure): boolean` in `machine.ts`.

- [ ] **Step 1: Failing tests**

```ts
// capture.test.ts
it.each([
  [{ name: 'NotAllowedError', message: 'Permission denied' }, 'tab', 'denied'],
  [{ name: 'NotAllowedError', message: 'Permission denied by system' }, 'tab', 'blocked'],
  [{ name: 'SecurityError', message: 'Access to the feature "display-capture" is disallowed by permission policy.' }, 'tab', 'blocked'],
  [{ name: 'NotAllowedError', message: 'Permission dismissed' }, 'mic', 'denied'],
])('maps %o (%s) to %s', (err, source, code) => {
  const e = Object.assign(new Error(err.message), { name: err.name })
  const mapped = toCaptureError(e, source as 'tab' | 'mic')
  expect(mapped.code).toBe(code)
  expect(mapped.message).toContain(err.message)
})

// machine.test.ts
it('keeps the failure detail and clears it on start', () => {
  let s = captureReducer(initialCapture, { type: 'start' })
  s = captureReducer(s, { type: 'failed', error: 'blocked', detail: 'NotAllowedError: Permission denied by system' })
  expect(s).toMatchObject({ phase: 'error', error: 'blocked', detail: 'NotAllowedError: Permission denied by system' })
  expect(captureReducer(s, { type: 'start' }).detail).toBeNull()
})
it('retryable codes', () => {
  expect(isRetryable('denied')).toBe(true)
  expect(isRetryable('unsupported')).toBe(false)
  expect(isRetryable('insecure')).toBe(false)
})
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** `toCaptureError`: keep `detail = \`${name}: ${message}\`` (name may be empty); `NotAllowedError`/`PermissionDeniedError` → `/by system|policy/i.test(message) ? 'blocked' : 'denied'`; `SecurityError` → `'blocked'`. `CaptureState` gets `detail: string | null` (initial `null`; `start` → `null`; `failed` → `event.detail ?? null`; other transitions keep it). `failureOf` returns `{ code, detail }` (non-CaptureError: `{code:'failed', detail: String(err?.message ?? err)}`) and both dispatch sites pass `detail`. `isRetryable = (c) => c !== 'unsupported' && c !== 'insecure'`.

- [ ] **Step 4: Copy** (uk / en), tab (`cloud.capture.error.*`):
  - `denied` «Вікно «Поділитися цією вкладкою?» закрили або натиснули «Скасувати». Натисни «Почати» й у вікні вгорі сторінки вибери «Поділитися».» / «The "Share this tab?" window was closed or cancelled. Press Start and choose Share in the window at the top of the page.»
  - `blocked` «Браузер або система не дозволяють показ вкладки. Натисни на значок біля адреси сайту → «Налаштування сайту» і дозволь показ екрана; на macOS ще перевір «Системні параметри → Конфіденційність → Запис екрана».» / «The browser or the system doesn't allow sharing the tab. Click the icon next to the address → Site settings and allow screen sharing; on macOS also check System Settings → Privacy → Screen Recording.»
  - every "Chrome" alone → «Chrome або Edge» / «Chrome or Edge» (`cloud.ts:62, 68, 92, 124, 128`).
  Mic errors: ListenPage uses `live.error.${code}` when the source is the microphone and `cloud.capture.error.${code}` for the tab; add `live.error.blocked` uk «Браузер не дає доступу до мікрофона. Дозволь його в налаштуваннях сайту (значок біля адреси).» / en «The browser blocks the microphone. Allow it in the site settings (the icon next to the address).».
  Under every error alert (CapturePage and ListenPage) a `<details>` «Технічні деталі» / «Technical details» shows `state.detail` when present.

- [ ] **Step 5: Not retryable** — when `!isRetryable(state.error)`, hide the Start buttons and show the NoTabCapture ways (CapturePage) / a «Вибрати файл» button (ListenPage).

- [ ] **Step 6: ShareTabIllustration** — make it read as a picture: a caption above it `cloud.capture.example` uk «Приклад: так виглядатиме вікно браузера вгорі сторінки», en «Example: this is what the browser's window at the top of the page looks like»; dashed border (`border-dashed`), `opacity-80`, and the fake «Поділитися» pill gets an outline style (`border border-line text-muted`, no `bg-accent`) so the only filled button on the page is the real «Почати».

- [ ] **Step 7: Run** tests/build/lint — PASS. Commit "Capture errors: real cause, mic-specific text, the example dialog no longer looks clickable".

---

### Task 4: What an account gives (copy and one gentle hint)

**Files:**
- Modify: `frontend/src/i18n/cloud.ts:29, 31, 34-51`, `frontend/src/i18n/account.ts:14-18`, `frontend/src/i18n/web.ts:25, 59, 70-75`, `frontend/src/i18n/core.ts:28`
- Modify: `frontend/src/components/layout/ServerStatus.tsx:202-220`
- Modify: `frontend/src/components/account/AccountCta.tsx:9-21` (optional `reason`)
- Modify: `frontend/src/lib/auth.ts:193` (`AuthReason` += `'accuracy' | 'vocals'`), `frontend/src/components/account/AuthModal.tsx:115-116`
- Create: `frontend/src/components/account/BrowserAnalysisNote.tsx`
- Modify: `frontend/src/components/layout/TrackPage.tsx` (render the note for local tracks of a guest)
- Test: `frontend/src/components/account/BrowserAnalysisNote.test.tsx`

**Interfaces:**
- Produces: `AccountButtons({ reason?: AuthReason })`; `openAuthDialog(mode: 'signIn'|'signUp', reason?: AuthReason)` (extend the existing signature; check it in `lib/auth.ts`); `BrowserAnalysisNote({ trackId: string })` hidden after dismiss (localStorage key `chords-listener-note-browser`, try/catch).

- [ ] **Step 1: Failing test**

```tsx
// BrowserAnalysisNote.test.tsx (jsdom)
import { render, screen, fireEvent } from '@testing-library/react'
...
it('shows once, hides after dismiss and stays hidden', () => {
  localStorage.clear()
  const { unmount } = render(<BrowserAnalysisNote trackId="local-abc" />)
  expect(screen.getByText(/точніш/i)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /закрити|close/i }))
  unmount()
  render(<BrowserAnalysisNote trackId="local-abc" />)
  expect(screen.queryByText(/точніш/i)).toBeNull()
})
```

(If `@testing-library/react` is not installed, test the pure helpers `noteDismissed()` / `dismissNote()` instead — do not add dependencies.)

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement the note** (only when `useCloudInvite()` and the track id `isLocalId`): uk «Ці акорди розпізнано в браузері. З безкоштовним акаунтом сервер визначає їх точніше (7, maj7, sus), розпізнає вокал і зберігає пісні на всіх пристроях.» + `AccountButtons reason="accuracy"` + close button; en equivalent.

- [ ] **Step 4: Copy rewrite** — no copy may say the server/cloud downloads YouTube:
  - `cloud.cta.benefit` uk «Точніші акорди, вокал і бібліотека на всіх пристроях» / en «More precise chords, vocals and your library on every device»
  - `account.intro.signUp` uk «Безкоштовний акаунт: сервер точніше розпізнає акорди й вокал, а пісні будуть на всіх твоїх пристроях.» / en …
  - `account.intro.accuracy` / `.vocals` (new): «Увійди — і сервер розпізнає цю пісню точніше.» / «Увійди — і сервер розпізнає вокал цієї пісні.»
  - `web.browser.cta` uk «Увійди — і отримаєш точніші акорди, вокал і бібліотеку на всіх пристроях.»
  - `core.input.hintIdle` for cloud users: «Встав посилання на YouTube або інший сайт, чи перетягни файл» (no promise about who downloads).
  - `ServerStatus.tsx:210`: browser mode line about YouTube → `cloud.input.hintYoutubeGuest` when tab-capable, else `cloud.input.hintYoutubeHere` (Task 1 keys).
  - Score vocals guest card passes `reason="vocals"`.

- [ ] **Step 5: Run** tests/build/lint — PASS. Commit "Account copy says what an account gives".

---

### Task 5: Waiting and errors always have a way forward

**Files:**
- Modify: `frontend/src/components/layout/ServerStatus.tsx:233, 286-292` (waking chip), `frontend/src/i18n/web.ts:15`
- Modify: `frontend/src/components/input/SmartInput.tsx:180-193, 331, 353, 372` (cold-start line + cancel)
- Modify: `frontend/src/store.ts:168-172` (toast duration)
- Modify: `frontend/src/components/jobs/JobPage.tsx:70-77, 131-150`
- Modify: `frontend/src/components/jobs/StageStepper.tsx:7`, `frontend/src/components/jobs/stages.ts`
- Modify: `frontend/src/hooks/useJobs.ts:294-307` (`retryJob(job, opts?: {inBrowser?: boolean})`)
- Test: `frontend/src/store.test.ts` (create if missing), `frontend/src/components/jobs/stages.test.ts`

**Interfaces:**
- Produces: `toastDuration(text: string, hasAction: boolean, kind: 'info'|'error'): number`; `stepsFor(job: Pick<Job,'source'>): StageKey[]` in `stages.ts`; `retryJob(job: Job, opts?: { inBrowser?: boolean }): Promise<boolean>`.

- [ ] **Step 1: Failing tests**

```ts
// store.test.ts
import { describe, expect, it } from 'vitest'
import { toastDuration } from './store'
describe('toastDuration', () => {
  it('keeps short info toasts short', () => expect(toastDuration('Готово', false, 'info')).toBe(2400))
  it('gives errors time to read', () => expect(toastDuration('x'.repeat(120), false, 'error')).toBeGreaterThanOrEqual(6000))
  it('caps at 12 s', () => expect(toastDuration('x'.repeat(1000), true, 'error')).toBe(12000))
})
// stages.test.ts
it('uploads and recordings have no download step', () => {
  expect(stepsFor({ source: { type: 'file', filename: 'a.mp3' } })).toEqual(['decode', 'analyze'])
  expect(stepsFor({ source: { type: 'youtube', videoId: 'x', url: null, filename: null } })).toEqual(['download', 'decode', 'analyze'])
})
```

(Adjust the `source` literals to the `TrackSource` type in `types.ts`.)

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement**
  - `toastDuration`: info without action 2400; otherwise `Math.min(12000, Math.max(hasAction ? 6000 : 4000, 2000 + text.length * 50))`, errors at least 6000.
  - `stepsFor`: drop `'download'` when `source?.type === 'file'`; StageStepper takes `steps` from it.
  - Waking: when `backend === 'cloud' && !health && !failure`, the header chip shows an amber dot and title `web.cloud.waking` (copy → «Хмара прокидається — перший запит може тривати до хвилини.» / en «The cloud is waking up — the first request can take up to a minute.»). SmartInput, while busy for more than 3 s on the cloud, shows that line under the input and a «Скасувати» button that aborts the request (pass an `AbortController.signal` into `startLink` → `submitUrl` → `createJob`; extend their signatures with an optional `signal`).
  - JobPage: when `loadError` and no job → «Спробувати ще раз» re-runs `ensureJob` (state `attempt` in the effect deps); the effect also depends on `useAuth(s => s.user?.uid)` so it re-runs after signing in. For `quota_exceeded` on a file job with the file still in memory → button «Розпізнати в браузері» → `retryJob(job, { inBrowser: true })` (passes `{ inBrowser: true }` as `submitFile`'s third argument). `retryGone` gets a «Вибрати файл» button (`startFiles`).
  - «Технічні деталі» summary → «Технічні деталі (англійською)» in uk.

- [ ] **Step 4: Run** tests/build/lint — PASS. Commit "Waiting and errors: visible cold start, readable toasts, retry everywhere".

---

### Task 6: Wake the cloud only for real work

**Files:**
- Modify: `frontend/src/lib/serverMode.ts:379-415` (`selectCloud`, `refreshCloudHealth`)
- Modify: `frontend/src/lib/vocals.ts:37, 60, 150-193` (feature flag, polling)
- Modify: `frontend/src/hooks/useJobs.ts:76-104, 157-185` (polling cadence, lazy `syncServerJobs`)
- Modify: `frontend/src/lib/cloud/transfer.ts:45` (`POLL_MS`)
- Modify: `frontend/src/lib/api.ts:243-248` (`withServerUrls` resolves `stemUrls`)
- Create: `frontend/src/lib/cloud/activity.ts` (this device's recent server jobs, localStorage)
- Test: `frontend/src/lib/cloud/activity.test.ts`, `frontend/src/lib/api.cloud.test.ts` (stemUrls), `frontend/src/hooks/useJobs` cadence via exported constants

**Interfaces:**
- Produces: `rememberServerJob(id: string): void`, `recentServerJobs(now?: number): string[]` (ids started on this device in the last 2 h, max 20), `forgetServerJob(id: string): void`; `JOB_POLL_MS = { visible: 1000, hidden: 3000, signedOut: 5000 }`; `VOCALS_POLL_MS = 1500`; health cache `cachedFeatures(): Health['engine']['features'] | null` (localStorage `chords-listener-cloud-health`, 24 h).

- [ ] **Step 1: Failing tests**

```ts
// activity.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { forgetServerJob, recentServerJobs, rememberServerJob } from './activity'
beforeEach(() => localStorage.clear())
describe('recent server jobs', () => {
  it('keeps jobs of the last 2 hours', () => {
    rememberServerJob('a')
    expect(recentServerJobs()).toEqual(['a'])
    expect(recentServerJobs(Date.now() + 2 * 3600_000 + 1)).toEqual([])
  })
  it('forgets finished jobs', () => {
    rememberServerJob('a'); forgetServerJob('a')
    expect(recentServerJobs()).toEqual([])
  })
  it('survives blocked storage', () => {
    const orig = Storage.prototype.getItem
    Storage.prototype.getItem = () => { throw new Error('blocked') }
    try { expect(recentServerJobs()).toEqual([]) } finally { Storage.prototype.getItem = orig }
  })
})
// api.cloud.test.ts — add
it('resolves stem URLs against the cloud origin', async () => {
  // reuse the file's cloud setup; GET /tracks/abc returns stemUrls {vocals: '/api/tracks/abc/stems/vocals?u=1&exp=2&sig=3'}
  const track = await getTrack('abc')
  expect(track.stemUrls?.vocals).toBe(`${CLOUD}/api/tracks/abc/stems/vocals?u=1&exp=2&sig=3`)
})
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement**
  - `selectCloud` no longer calls `refreshCloudHealth()`; health is fetched only when something needs it: the ServerStatus popover opens (`onOpen` → `refreshCloudHealth()`), vocals support is asked (`vocalsSupport` uses `cachedFeatures()` first, then `refreshCloudHealth()`), or a request just failed with `network`. `refreshCloudHealth` stores `features` + timestamp in localStorage on success.
  - `syncServerJobs` calls `api.listJobs()` only when `recentServerJobs().length > 0`; `createJob`, `createStorageJob`, `uploadFile` (multipart) and `startVocals` call `rememberServerJob(job.id)`; `applyUpdate` calls `forgetServerJob` when a server job leaves the active states.
  - Job polling: `schedulePoll(signedOut ? JOB_POLL_MS.signedOut : document.hidden ? JOB_POLL_MS.hidden : JOB_POLL_MS.visible)`; first poll after 600 ms.
  - Vocals: `vocalsPolling.ms = 1500`; skip a tick while `document.hidden` (reschedule); do not poll a job that `useJobs` already polls (check `useJobs.getState().jobs[jobId]` and subscribe to it instead).
  - Transfer `POLL_MS = 1500`.
  - `withServerUrls` maps `stemUrls` values through the same resolver as `audioUrl`.

- [ ] **Step 4: Run** tests/build/lint — PASS. Check in the browser (hosted preview, signed-out is enough for the guest check): a fresh load of the home page as a guest still makes zero cross-origin requests. Commit "Wake the cloud only for real work: lazy health and job listing, calmer polling".

---

### Task 7: Keep the signed-in user's library on the device

**Files:**
- Create: `frontend/src/lib/cloud/cache.ts`
- Modify: `frontend/src/lib/api.ts:311-358, 363-399` (listTracks, getTrack, updateTrack, resetTrack, deleteTrack, notes, fetchTrackAudio), `frontend/src/lib/vocals.ts:122-139`
- Modify: `frontend/src/components/history/tracksStore.ts:21-43`, `frontend/src/components/history/RecentTracks.tsx:161-166, 184` (refresh button)
- Modify: `frontend/src/components/player/PlayerHost.tsx:21-28` / `components/player/sources/audioSource.ts` (play a cached blob)
- Modify: `frontend/src/lib/auth.ts` (sign-out → `clearCloudCache()`)
- Modify: `docs/SPEC.md` (new "Cloud cache" paragraph under "Where the API lives")
- Test: `frontend/src/lib/cloud/cache.test.ts` (fake-indexeddb, as in `src/lib/authMarker.test.ts`)

**Interfaces:**
- Consumes: Task 6 (`withServerUrls` resolves all URLs).
- Produces (all async, never throw — a broken / missing IndexedDB makes them no-ops returning `null`):
  - `cachedList(uid: string): Promise<{ tracks: TrackSummary[]; savedAt: number } | null>`, `saveList(uid, tracks): Promise<void>`
  - `cachedTrack(uid, id): Promise<Track | null>`, `saveTrack(uid, track): Promise<void>`
  - `cachedAudio(uid, id): Promise<Blob | null>`, `saveAudio(uid, id, blob): Promise<void>` (LRU, total ≤ `AUDIO_BUDGET_BYTES = 300 * 1024 * 1024`)
  - `cachedJson<T>(uid, kind: 'notes' | 'vocals', id): Promise<T | null>`, `saveJson(uid, kind, id, value): Promise<void>`
  - `forgetTrack(uid, id): Promise<void>` (track, audio, notes, vocals, and the entry in the cached list)
  - `clearCloudCache(): Promise<void>` (deletes the database)
  - constants `LIST_TTL_MS = 10 * 60_000`, `TRACK_TTL_MS = 6 * 3600_000`
  - database `chords-listener-cloud` v1, stores `lists` (key uid), `tracks` / `audio` / `json` (key `${uid}|${id}` / `${uid}|${kind}|${id}`), each row `{ key, value, savedAt, size? }`.

- [ ] **Step 1: Failing tests** (`cache.test.ts`, `import 'fake-indexeddb/auto'` at the top):

```ts
it('stores and returns a list per uid', async () => {
  await saveList('u1', [summary('a')])
  expect((await cachedList('u1'))?.tracks.map((t) => t.id)).toEqual(['a'])
  expect(await cachedList('u2')).toBeNull()
})
it('delete removes it from the cached list', async () => {
  await saveList('u1', [summary('a'), summary('b')]); await saveTrack('u1', track('a'))
  await forgetTrack('u1', 'a')
  expect((await cachedList('u1'))?.tracks.map((t) => t.id)).toEqual(['b'])
  expect(await cachedTrack('u1', 'a')).toBeNull()
})
it('edit replaces the cached track', async () => {
  await saveTrack('u1', track('a', { title: 'old' })); await saveTrack('u1', track('a', { title: 'new' }))
  expect((await cachedTrack('u1', 'a'))?.title).toBe('new')
})
it('evicts the least recently used audio over budget', async () => {
  const big = new Blob([new Uint8Array(AUDIO_BUDGET_BYTES / 2 + 1)])
  await saveAudio('u1', 'a', big); await saveAudio('u1', 'b', big)
  expect(await cachedAudio('u1', 'a')).toBeNull()
  expect(await cachedAudio('u1', 'b')).not.toBeNull()
})
it('works without IndexedDB', async () => {
  const idb = globalThis.indexedDB
  // @ts-expect-error simulate a browser without it
  delete globalThis.indexedDB
  try {
    await saveList('u1', [summary('a')])
    expect(await cachedList('u1')).toBeNull()
  } finally { globalThis.indexedDB = idb }
})
it('clearCloudCache removes everything', async () => {
  await saveList('u1', [summary('a')]); await clearCloudCache()
  expect(await cachedList('u1')).toBeNull()
})
it('expired audio URL: a cached blob still plays', async () => {
  await saveAudio('u1', 'a', new Blob(['x']))
  expect(await cachedAudio('u1', 'a')).not.toBeNull()
})
```

(`summary(id)` / `track(id, patch)` are tiny local factories filling the required `TrackSummary` / `Track` fields from `types.ts`.)

- [ ] **Step 2: Run** — FAIL (module missing).

- [ ] **Step 3: Implement `cache.ts`** — open the database lazily once (`indexedDB.open('chords-listener-cloud', 1)`, create the four stores in `onupgradeneeded`); every function wraps its work in try/catch and resolves `null` / `undefined` on any error or when `globalThis.indexedDB` is missing. Audio LRU: on `saveAudio`, put the row (`size = blob.size`, `savedAt = Date.now()`), then read all audio rows' `{key, size, savedAt}`, sort by `savedAt` ascending and delete until the total ≤ budget; `cachedAudio` updates `savedAt` (touch). Store Blobs; on `DataCloneError` store `{buffer, type}` like `lib/local/db.ts:173-188`.

- [ ] **Step 4: Wire it in** (`uid = useAuth.getState().user?.uid`, only when `conn.backend === 'cloud'`):
  - `listTracks(signal?, opts?: { force?: boolean })`: if a cached list exists and (`!force` and `Date.now() - savedAt < LIST_TTL_MS`) → return it merged with browser tracks, no request; else request, `saveList`, return. `tracksStore.refreshTracks(force = false)` passes it; it shows the cached list immediately (state `tracks` from cache) and refreshes in the background when stale. Job-done / transfer-done / the Retry button call `refreshTracks(true)`; `RecentTracks` mount calls `refreshTracks()` (cache-first).
  - `getTrack(id)`: cached and younger than `TRACK_TTL_MS` → return it (with `audioUrl` as cached); else fetch + `saveTrack`. `updateTrack` / `resetTrack` responses → `saveTrack` + update the cached list entry; `deleteTrack` → `forgetTrack`; a reanalyze or vocals job reaching `done` → `forgetTrack` (the next open refetches).
  - Audio: `PlayerHost` asks `cachedAudio(uid, track.id)` first and plays `URL.createObjectURL(blob)` (revoke on change); on a miss it plays the signed URL as today and, after `canplaythrough`, fetches the blob once in the background (`fetchTrackAudio`) and `saveAudio`. `fetchTrackAudio` itself checks `cachedAudio` first and saves what it downloads (the notes transcription then fills the cache too). If the signed URL answers 401 (expired), `forgetTrack` the JSON and `getTrack` again once.
  - Notes (`getTrackNotes` / `putTrackNotes`) and vocals (`fetchVocals` when found) read / write `cachedJson`.
  - `signOut` (and a uid change in `mirror`) → `clearCloudCache()`.
  - `RecentTracks` gets a small «Оновити» / «Refresh» icon button → `refreshTracks(true)`.

- [ ] **Step 5: Run** `npx vitest run && npm run build && npm run lint` — PASS. Update `docs/SPEC.md` ("Cloud cache": what is cached, TTLs, budget, invalidation, cleared on sign-out). Commit "Keep the signed-in library on the device: opening and replaying no longer wake the cloud".

---

### Task 8: Whole-branch check

- [ ] **Step 1:** `cd frontend && npx vitest run && npm run build && npm run lint` — all PASS.
- [ ] **Step 2:** Hosted build preview (`VITE_BASE=/chords-listener/ npx vite build --outDir <scratchpad>/www/chords-listener`, static server from the scratchpad): as a fresh guest on phone and desktop emulation — zero cross-origin requests at start, after submitting a YouTube link, after opening and closing the auth dialog; the phone YouTube page shows the three on-device ways; the desktop page shows the example dialog captioned «Приклад».
- [ ] **Step 3:** Request a whole-branch code review (superpowers:requesting-code-review) against `f8a6a9a..HEAD`.

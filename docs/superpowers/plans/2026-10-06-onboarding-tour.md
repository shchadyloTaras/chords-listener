# Onboarding Tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A guided tour over the real controls (dimmed page, a spotlight cut-out, a bubble) that opens by itself once per device on each of six screens and can be opened again from «Інструкція» in the ⋯ menu, the desktop header and the shortcuts dialog.

**Architecture:** Pure logic in `src/lib/tour/` (tour definitions, the step machine, the auto-start gate and the re-open mapping, bubble placement, the seen-state storage), all unit-tested. `src/components/tour/` holds a small zustand store for the running tour, hooks that screens call to report readiness and flags (`useTourTrigger`, `useTourFlags`, `useTourBlock`), and `TourHost` (overlay, cut-out, bubble, keys, focus) mounted once in `App.tsx`. Screens mark their controls with `data-tour="<id>"` (43 ids); the tour finds them in the DOM, so no component state is lifted.

**Tech Stack:** React 19, TypeScript 6, zustand 5, Tailwind v4, lucide-react, vitest 5 (+ jsdom per file via `// @vitest-environment jsdom`), Vite 8.

**Spec:** `docs/superpowers/specs/2026-10-06-onboarding-tour-design.md`

## Global Constraints

- Frontend + docs only. Backend, `firestore.rules`, `storage.rules` untouched. No new dependencies.
- Every UI string has `uk` (informal «ти») and `en` entries, in a new `src/i18n/tour.ts` (keys `tour.*`).
- `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build` pass after every task.
- Branch `piano-levels` (already checked out); one commit per task, message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never push or deploy.
- Match the surrounding code: comment density, naming, pure logic in `lib/`, tests next to code.
- The "seen" state is device-local: `localStorage["chords-listener-tours"] = { "<tourId>": true }`, never in `SYNCED_KEYS` (`lib/syncedSettings.ts`), nothing in Firestore; every read and write in try/catch.
- Six tours: Home 8 steps, Song 12 (13 on phones < 640 px), Score 5, Live keys 4, Listen 6, YouTube 4 (tab) / 2 (no tab); 43 anchor ids.
- Overlay `z-[75]` (above Modal / Floating `z-[60]` and Toaster `z-[70]`, below the drop overlay `z-[80]`); dim ~60 % black; cut-out padding 6 px with a thin accent ring.
- Auto-start ~500 ms after all conditions hold; an anchor counts as gone only if still missing 300 ms after it vanished.
- Bubble bottom edge ≥ 8 px above `var(--player-h)` and clear of the floating video; phones (< 640 px) dock it at the bottom.
- The tour root is `role="dialog"` + `aria-modal="true"`; keys → ← Enter Space Esc handled in a capture-phase listener on `window`.
- `prefers-reduced-motion`: no animated transitions or smooth scrolling.
- Browser checks use the in-app preview `pages-preview` on port 4173 (port 5173 is taken by another project).

## Review Focus

1. **Desktop Home with an empty, autofocused link field** (`SmartInput` autofocuses on a fine pointer, `SmartInput.tsx:160`): the spec's "focus is not in a text field" rule must not hold the Home tour back forever (acceptance criterion 1), while a field that already has text, or the chord editor, must. Pinned in Task 5 (`hooks.test.ts` "an empty, autofocused link field does not hold it back").
2. **Two tours due at the same moment** (a keyboard player opening a song: Song + Live keys; a saved «Ноти» view: Song + Score): exactly one opens, the other opens ~500 ms after the first closes, and «Пропустити» on the first does not mark the second seen. Pinned in Task 5 (`hooks.test.ts` "two tours due at once").
3. **Song step 4 with a keyboard instrument** (the live-piano panel sits between the hero and the toolbar): the step must keep the hero on screen, because the toolbar shows the key badge (`song.key`) only while the hero is more than 25 % visible below 64 px (`ChordWorkspace.tsx` `useMostlyVisible`, `Toolbar.tsx:45-49`) and swaps in the mini "now → next" otherwise. `scrollToStep` therefore scrolls `scrollTop` steps as little as possible (`nearestDelta`) instead of centring them. Checked in Task 15 Step 7 (piano, live keys on, 1280 × 800: step 4's cut-out includes the key badge).
4. **A short viewport with a long bubble** (phone in landscape, 667 × 375, the chord-marks cheat sheet): the bubble stays on screen between 8 px from the top and 8 px above the player bar and scrolls inside. 667 px is above `PHONE_QUERY` (`max-width: 639px`), so in the app this takes the *desktop* branch; the test checks both branches. Pinned in Task 6 (`placement.test.ts` "a long bubble on a short screen stays on screen and gets a max height").
5. **A file dropped while a tour runs:** nothing starts *and* the browser does not navigate to the file (the drop is still swallowed). Pinned in Task 8 (`inertDuringTour.test.ts` "a dropped file does nothing during a tour, and the browser does not open it").

---

## File Structure

Create:

| File | Responsibility |
|---|---|
| `frontend/src/lib/tour/storage.ts` | Seen-state in `localStorage["chords-listener-tours"]`, try/catch everywhere |
| `frontend/src/lib/tour/tours.ts` | Tour ids, flags, conditions, the six tours' steps / anchors / variants, i18n key helpers |
| `frontend/src/lib/tour/machine.ts` | Step inclusion, start / next / back, vanished anchors, counter, close reasons, the re-open chain |
| `frontend/src/lib/tour/trigger.ts` | Auto-start gate + 500 ms timer, re-open mapping, guide availability, route key, per-screen readiness predicates |
| `frontend/src/lib/tour/placement.ts` | Pure geometry: rect union / clip, bubble placement (desktop / phone / tall / video), scroll deltas |
| `frontend/src/i18n/tour.ts` | Every `tour.*` string, uk + en |
| `frontend/src/components/tour/dom.ts` | Anchor lookup (first visible match), DOM blockers for auto-start, waiting for a modal to leave |
| `frontend/src/components/tour/tourStore.ts` | zustand store (running tour, chain queue, flags, blocks) + actions: start / next / back / close / re-open |
| `frontend/src/components/tour/hooks.ts` | `useTourTrigger`, `useTourFlags`, `useTourBlock`, `useGuideAvailable` |
| `frontend/src/components/tour/geometry.ts` | Real-page measuring: anchor boxes, insets, clipping, scrolling a step into view |
| `frontend/src/components/tour/ChordMarks.tsx` | The chord-marks cheat sheet (Song step 7 body) |
| `frontend/src/components/tour/TourHost.tsx` | Overlay, cut-out, bubble, keys, focus trap / restore, aria-live; route-change close |
| `frontend/src/components/layout/useGlobalPaste.ts` | The home page paste handler (moved out of `HomePage.tsx`), inert while a modal is open |
| tests next to each (`*.test.ts`), plus `frontend/src/components/tour/anchors.test.ts`, `frontend/src/components/layout/inertDuringTour.test.ts`, `frontend/src/components/layout/guideEntries.test.ts`, `frontend/src/i18n/tour.test.ts` | |

Modify:

| File | Change |
|---|---|
| `frontend/src/i18n/index.ts` | register the `tour` dictionary |
| `frontend/src/App.tsx` | mount `TourHost`; pass `onGuide` to the header and the shortcuts dialog |
| `frontend/src/hooks/useHotkeys.ts` | export `modalOpen()` |
| `frontend/src/lib/auth.ts` | `import.meta.hot?.data?.` guard (as in `lib/serverMode.ts`), so jsdom tests can import it |
| `frontend/src/components/layout/HomePage.tsx` | use `useGlobalPaste`; Home readiness + library flags |
| `frontend/src/components/layout/DropOverlay.tsx` | inert while a modal is open (still swallows the drop) |
| `frontend/src/components/layout/AppHeader.tsx` | `header.settings` / `header.more` anchors; `onGuide` prop → `GuideButton` + `HeaderMenu` |
| `frontend/src/components/layout/HeaderSettings.tsx` | `GuideButton` (lucide `CircleHelp`) |
| `frontend/src/components/layout/TrackActions.tsx` | «Інструкція» menu item |
| `frontend/src/components/layout/ShortcutsModal.tsx` | «Інструкція» line at the bottom |
| `frontend/src/components/layout/ServerStatus.tsx`, `account/AccountButton.tsx` | `header.mode`, `header.signin` anchors |
| `frontend/src/components/input/SmartInput.tsx`, `history/RecentTracks.tsx` | Home anchors; `useTourBlock` while a link / file is on its way or the field has text |
| `frontend/src/components/chords/{ChordWorkspace,NowPlaying,InstrumentPicker,Toolbar,CopyButton,SheetView,ChordLegend}.tsx`, `chords/ui/controls.tsx`, `chords/tempo/TempoReadout.tsx`, `player/PlayerBar.tsx` | Song anchors, Song readiness and flags |
| `frontend/src/components/player/VideoPanel.tsx` | `data-tour-avoid` (floating) / `data-tour-top` (docked on phones) |
| `frontend/src/components/chords/score/ScoreView.tsx`, `chords/piano/{LivePiano,SyncControl}.tsx` | Score / Live keys anchors, readiness, flags |
| `frontend/src/components/capture/{ListenPage,CapturePage}.tsx`, `live/{LiveChordsView,LiveLevelMeter}.tsx` | Listen / YouTube anchors and readiness |
| `docs/SPEC.md`, `README.md` | "Guide / tour" section; feature + structure lines |

Anchor helper attributes used besides `data-tour`: `data-tour-until="<selector>"` (the anchor's box ends at the bottom of its first match: a heading with its first row), `data-tour-avoid` (the bubble keeps clear: the floating video), `data-tour-top` (adds to the top inset: the video docked under the header on phones).

---

### Task 1: Seen-state storage

**Files:**
- Create: `frontend/src/lib/tour/storage.ts`
- Test: `frontend/src/lib/tour/storage.test.ts`

**Interfaces:**
- Consumes: `SYNCED_KEYS` from `lib/syncedSettings.ts:8` (test only).
- Produces: `export const TOURS_KEY = 'chords-listener-tours'`; `export function seenTours(): Record<string, true>`; `export function isTourSeen(id: string): boolean`; `export function markTourSeen(id: string): void`.

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/tour/storage.test.ts`:

```ts
// Which tours this device has seen: localStorage["chords-listener-tours"] = { "<tourId>": true }. Blocked or
// broken storage must never break the page — it reads as "nothing seen", so a tour simply shows again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNCED_KEYS } from '../syncedSettings'
import { isTourSeen, markTourSeen, seenTours, TOURS_KEY } from './storage'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the seen-tours flag', () => {
  it('lives under its own device-local key, never synced', () => {
    expect(TOURS_KEY).toBe('chords-listener-tours')
    expect((SYNCED_KEYS as readonly string[]).some((k) => /tour/i.test(k))).toBe(false)
  })

  it('reads nothing seen at first, then remembers each tour separately', () => {
    expect(seenTours()).toEqual({})
    expect(isTourSeen('home')).toBe(false)
    markTourSeen('home')
    markTourSeen('song')
    expect(isTourSeen('home')).toBe(true)
    expect(isTourSeen('score')).toBe(false)
    expect(JSON.parse(localStorage.getItem(TOURS_KEY)!)).toEqual({ home: true, song: true })
  })

  it.each(['not json', 'null', '[]', '"home"', '{"home":1,"song":true}'])(
    'reads a broken value %j as nothing seen (keeping only valid entries) and repairs it on write',
    (raw) => {
      localStorage.setItem(TOURS_KEY, raw)
      expect(isTourSeen('home')).toBe(false)
      markTourSeen('listen')
      const saved = JSON.parse(localStorage.getItem(TOURS_KEY)!) as Record<string, unknown>
      expect(saved.listen).toBe(true)
      expect(saved.home).toBeUndefined()
    },
  )

  it('never throws where storage is blocked: reads as not seen, writes are dropped', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
    })
    expect(isTourSeen('home')).toBe(false)
    expect(() => markTourSeen('home')).not.toThrow()
    expect(isTourSeen('home')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/lib/tour/storage.test.ts`
Expected: FAIL with `Error: Cannot find module './storage' imported from …/src/lib/tour/storage.test.ts` (a node-environment test; jsdom files print `Failed to resolve import` instead)

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/tour/storage.ts`:

```ts
// Which guided tours this device has seen (docs/superpowers/specs/2026-10-06-onboarding-tour-design.md):
// localStorage["chords-listener-tours"] = { "<tourId>": true }. Device-local on purpose — never in
// SYNCED_KEYS, nothing in Firestore. Blocked or broken storage reads as "nothing seen": the tour simply
// shows again (the same rule as components/account/browserNote.ts).

export const TOURS_KEY = 'chords-listener-tours'

export function seenTours(): Record<string, true> {
  try {
    const raw = localStorage.getItem(TOURS_KEY)
    if (!raw) return {}
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const seen: Record<string, true> = {}
    for (const [id, value] of Object.entries(data)) if (value === true) seen[id] = true
    return seen
  } catch {
    return {}
  }
}

export function isTourSeen(id: string): boolean {
  return seenTours()[id] === true
}

export function markTourSeen(id: string): void {
  try {
    localStorage.setItem(TOURS_KEY, JSON.stringify({ ...seenTours(), [id]: true }))
  } catch {
    /* storage blocked: the tour shows again next time */
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && npx vitest run src/lib/tour/storage.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full checks**

Run: `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/tour/storage.ts frontend/src/lib/tour/storage.test.ts
git commit -m "Tour: seen state on this device (chords-listener-tours, never synced)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Tour definitions and their texts (uk + en)

**Files:**
- Create: `frontend/src/lib/tour/tours.ts`, `frontend/src/i18n/tour.ts`
- Modify: `frontend/src/i18n/index.ts:2-13` (imports), `:22` (`dicts` array)
- Test: `frontend/src/lib/tour/tours.test.ts`, `frontend/src/i18n/tour.test.ts`

**Interfaces:**
- Consumes: `Dict` type from `i18n/index.ts:20`.
- Produces (from `lib/tour/tours.ts`):
  - `export type TourId = 'home' | 'song' | 'score' | 'keys' | 'listen' | 'capture'`; `export const TOUR_IDS: readonly TourId[]`
  - `export type TourFlag = 'phone' | 'touch' | 'demo' | 'cloudInvite' | 'canListenInTab' | 'libraryEmpty' | 'libraryList' | 'hasChords' | 'sheetView' | 'scoreRendered' | 'keysPanel' | 'keysReady'`; `export type TourFlags = Partial<Record<TourFlag, boolean>>`; `export type Condition = TourFlag | \`!${TourFlag}\``
  - `export type TextVariant = 'demo' | 'touch' | 'noTab'`; `export const VARIANT_CONDITION: Record<TextVariant, Condition>`
  - `export interface TourStep { id: string; anchors: readonly string[]; when?: readonly Condition[]; centre?: boolean; body?: 'chordMarks'; keys?: readonly string[]; scrollTop?: boolean; variants?: readonly TextVariant[] }`; `export interface Tour { id: TourId; steps: readonly TourStep[] }`
  - `export function conditionHolds(condition: Condition, flags: TourFlags): boolean`
  - `export function titleKey(tourId: TourId, step: TourStep): string` → `tour.<tourId>.<stepId>.title`
  - `export function textKey(tourId: TourId, step: TourStep, flags: TourFlags): string` → `tour.<tourId>.<stepId>.text[.<variant>…]`
  - `export function textKeys(tourId: TourId, step: TourStep): string[]` (every variant combination)
  - `export function tourAnchors(): string[]` (43 unique ids)
  - `export const TOURS: Record<TourId, Tour>`
- Produces (from `i18n/tour.ts`): `export const tour: Dict` with the generic keys `tour.open`, `tour.next`, `tour.back`, `tour.done`, `tour.skip`, `tour.counter` (`{n} / {total}`), `tour.shortcuts.hint`, the chord-marks keys `tour.marks.{colour,unsure,none,bass,m,7,maj7,sus,dim,aug,add9}`, and every step title / text.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/tour/tours.test.ts`:

```ts
// The six tours as data: step counts per screen and breakpoint, 43 distinct anchors, conditions, text keys.
import { describe, expect, it } from 'vitest'
import { conditionHolds, textKey, textKeys, titleKey, tourAnchors, TOUR_IDS, TOURS, type TourFlags } from './tours'

/** steps whose conditions hold for these flags, anchors ignored */
const shown = (id: (typeof TOUR_IDS)[number], flags: TourFlags) =>
  TOURS[id].steps.filter((s) => (s.when ?? []).every((c) => conditionHolds(c, flags))).map((s) => s.id)

describe('tour definitions', () => {
  it('has the six tours in a fixed order', () => {
    expect(TOUR_IDS).toEqual(['home', 'song', 'score', 'keys', 'listen', 'capture'])
    for (const id of TOUR_IDS) expect(TOURS[id].id).toBe(id)
  })

  it('anchors 43 distinct ids', () => {
    expect(tourAnchors()).toHaveLength(43)
  })

  it('keeps step ids unique inside each tour', () => {
    for (const id of TOUR_IDS) {
      const ids = TOURS[id].steps.map((s) => s.id)
      expect(new Set(ids).size, id).toBe(ids.length)
    }
  })

  it('Home: 8 steps; step 8 is the settings group on a desktop and ⋯ on a phone', () => {
    const all = { libraryEmpty: true, libraryList: true, cloudInvite: true }
    expect(shown('home', all)).toHaveLength(8)
    expect(shown('home', all)).toContain('settings')
    expect(shown('home', { ...all, phone: true })).toHaveLength(8)
    expect(shown('home', { ...all, phone: true })).toContain('more')
  })

  it('Song: 12 steps on a desktop, 13 on a phone (step 4 split in two)', () => {
    const all = { sheetView: true, hasChords: true }
    expect(shown('song', all)).toHaveLength(12)
    expect(shown('song', { ...all, phone: true })).toHaveLength(13)
    expect(shown('song', { ...all, phone: true })).toEqual(expect.arrayContaining(['keyTranspose', 'keyShape']))
  })

  it('Score 5, Live keys 4 either way, Listen 6, YouTube 4 with a tab and 2 without', () => {
    expect(shown('score', { scoreRendered: true })).toHaveLength(5)
    expect(shown('keys', { keysReady: true })).toEqual(['canvas', 'edges', 'sync', 'voice'])
    expect(shown('keys', {})).toEqual(['intro', 'sync', 'voice'])
    expect(shown('listen', {})).toHaveLength(6)
    expect(shown('capture', { canListenInTab: true })).toEqual(['video', 'start', 'howto', 'controls'])
    expect(shown('capture', {})).toEqual(['videoNoTab', 'alt'])
  })

  it('conditions: a flag, its negation, and a missing flag as false', () => {
    expect(conditionHolds('phone', { phone: true })).toBe(true)
    expect(conditionHolds('phone', {})).toBe(false)
    expect(conditionHolds('!phone', {})).toBe(true)
    expect(conditionHolds('!phone', { phone: true })).toBe(false)
  })

  it('text keys: the base plus the variants that hold, in the declared order', () => {
    const player = TOURS.song.steps.find((s) => s.id === 'player')!
    expect(titleKey('song', player)).toBe('tour.song.player.title')
    expect(textKey('song', player, {})).toBe('tour.song.player.text')
    expect(textKey('song', player, { touch: true })).toBe('tour.song.player.text.touch')
    expect(textKey('song', player, { demo: true, touch: true })).toBe('tour.song.player.text.demo.touch')
    expect(textKeys('song', player)).toEqual([
      'tour.song.player.text',
      'tour.song.player.text.demo',
      'tour.song.player.text.touch',
      'tour.song.player.text.demo.touch',
    ])
    const sources = TOURS.listen.steps.find((s) => s.id === 'sources')!
    expect(textKey('listen', sources, { canListenInTab: true })).toBe('tour.listen.sources.text')
    expect(textKey('listen', sources, {})).toBe('tour.listen.sources.text.noTab')
  })

  it('Song steps 1–4 scroll to the top first; step 7 is a centred card with the chord-marks body', () => {
    const top = TOURS.song.steps.filter((s) => s.scrollTop).map((s) => s.id)
    expect(top).toEqual(['now', 'instrument', 'tempo', 'keyAll', 'keyTranspose', 'keyShape'])
    const marks = TOURS.song.steps.find((s) => s.id === 'marks')!
    expect(marks).toMatchObject({ anchors: [], centre: true, body: 'chordMarks' })
  })
})
```

`frontend/src/i18n/tour.test.ts`:

```ts
// The repo's first i18n completeness test: every tour.* key has a non-empty uk and en entry, every step has
// its title and every text variant, nothing is left over, and the Ukrainian speaks informally («ти»).
import { describe, expect, it } from 'vitest'
import { textKeys, titleKey, TOUR_IDS, TOURS } from '../lib/tour/tours'
import { tour } from './tour'

const stepKeys = TOUR_IDS.flatMap((id) => TOURS[id].steps.flatMap((s) => [titleKey(id, s), ...textKeys(id, s)]))
const L = 'а-яіїєґʼ'
const FORMAL = new RegExp(`(^|[^${L}])(ви|вас|вам|ваш[${L}]*|[${L}]+(іть|айте|уйте|ийте))(?=$|[^${L}])`, 'iu')

describe('tour texts', () => {
  it('every tour.* key has a non-empty uk and en entry', () => {
    const keys = new Set([...Object.keys(tour.uk), ...Object.keys(tour.en)])
    for (const key of keys) {
      expect(key.startsWith('tour.'), key).toBe(true)
      expect(tour.uk[key]?.trim(), `uk ${key}`).toBeTruthy()
      expect(tour.en[key]?.trim(), `en ${key}`).toBeTruthy()
    }
  })

  it('every step has its title and every text variant', () => {
    for (const key of stepKeys) {
      expect(tour.uk[key], `uk ${key}`).toBeTruthy()
      expect(tour.en[key], `en ${key}`).toBeTruthy()
    }
  })

  it('has no step keys that no step uses', () => {
    const used = new Set(stepKeys)
    const stepish = Object.keys(tour.uk).filter((k) => TOUR_IDS.some((id) => k.startsWith(`tour.${id}.`)))
    expect(stepish.filter((k) => !used.has(k))).toEqual([])
  })

  it('speaks to the reader informally in Ukrainian («ти», not «ви»)', () => {
    for (const [key, text] of Object.entries(tour.uk)) expect(FORMAL.test(text), `${key}: ${text}`).toBe(false)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/lib/tour/tours.test.ts src/i18n/tour.test.ts`
Expected: FAIL with `Error: Cannot find module './tours' imported from …` and `Error: Cannot find module '../lib/tour/tours' imported from …`

- [ ] **Step 3: Write `tours.ts`**

`frontend/src/lib/tour/tours.ts`:

```ts
// The guided tours (docs/superpowers/specs/2026-10-06-onboarding-tour-design.md §1): their steps, the
// `data-tour` anchors each step spotlights, when a step is included, and the i18n keys of its texts.
// Pure data and small helpers; the step logic is in machine.ts, the page side in components/tour.

export type TourId = 'home' | 'song' | 'score' | 'keys' | 'listen' | 'capture'
export const TOUR_IDS: readonly TourId[] = ['home', 'song', 'score', 'keys', 'listen', 'capture']

/** What the page reports about itself (components/tour/hooks.ts useTourFlags); a missing flag reads as false. */
export type TourFlag =
  /** narrower than 640 px */
  | 'phone'
  /** no fine pointer (useIsDesktopPointer() false): no key chips, touch texts */
  | 'touch'
  /** #/demo: no recording, the song itself is silent */
  | 'demo'
  /** useCloudInvite(): a cloud is configured, nobody is signed in, not a same-origin local server */
  | 'cloudInvite'
  /** useCanListenInTab(): this browser can hear another tab */
  | 'canListenInTab'
  /** the library has loaded and is empty / has songs (both false while loading or after a failure) */
  | 'libraryEmpty'
  | 'libraryList'
  /** the open song has chords; its view is the chord sheet */
  | 'hasChords'
  | 'sheetView'
  /** the score has been drawn (not computing, not unavailable, a part is on) */
  | 'scoreRendered'
  /** the live piano panel is on screen; its notes are ready (at least one note) */
  | 'keysPanel'
  | 'keysReady'

export type TourFlags = Partial<Record<TourFlag, boolean>>
export type Condition = TourFlag | `!${TourFlag}`

/** Text variants: `tour.<tour>.<step>.text` + `.<variant>` for each that holds, in the step's order. */
export type TextVariant = 'demo' | 'touch' | 'noTab'
export const VARIANT_CONDITION: Record<TextVariant, Condition> = { demo: 'demo', touch: 'touch', noTab: '!canListenInTab' }

export interface TourStep {
  /** unique inside its tour; the i18n stem `tour.<tourId>.<id>` */
  id: string
  /** `data-tour` ids; the spotlight is the union of those on screen */
  anchors: readonly string[]
  /** all must hold for the step to be included */
  when?: readonly Condition[]
  /** shown as a centred card while its anchors are absent (instead of being left out) */
  centre?: boolean
  /** extra content TourHost renders under the text */
  body?: 'chordMarks'
  /** key chips (hidden on touch devices) */
  keys?: readonly string[]
  /** scroll the page to the top first (the hero's key and BPM badges exist only while it is on screen) */
  scrollTop?: boolean
  variants?: readonly TextVariant[]
}

export interface Tour {
  id: TourId
  steps: readonly TourStep[]
}

export function conditionHolds(condition: Condition, flags: TourFlags): boolean {
  return condition.startsWith('!') ? !flags[condition.slice(1) as TourFlag] : !!flags[condition as TourFlag]
}

export function titleKey(tourId: TourId, step: TourStep): string {
  return `tour.${tourId}.${step.id}.title`
}

export function textKey(tourId: TourId, step: TourStep, flags: TourFlags): string {
  const on = (step.variants ?? []).filter((v) => conditionHolds(VARIANT_CONDITION[v], flags))
  return [`tour.${tourId}.${step.id}.text`, ...on].join('.')
}

/** Every text key a step can use (each combination of its variants), for the i18n completeness test. */
export function textKeys(tourId: TourId, step: TourStep): string[] {
  const variants = step.variants ?? []
  const keys: string[] = []
  for (let mask = 0; mask < 1 << variants.length; mask++) {
    const on = variants.filter((_, i) => mask & (1 << i))
    keys.push([`tour.${tourId}.${step.id}.text`, ...on].join('.'))
  }
  return keys
}

/** Every anchor id the tours use, once each. */
export function tourAnchors(): string[] {
  return [...new Set(TOUR_IDS.flatMap((id) => TOURS[id].steps.flatMap((s) => s.anchors)))]
}

export const TOURS: Record<TourId, Tour> = {
  // §1.1 — route `home`
  home: {
    id: 'home',
    steps: [
      { id: 'welcome', anchors: [] },
      { id: 'input', anchors: ['home.input'], variants: ['touch'] },
      { id: 'sources', anchors: ['home.sources'] },
      { id: 'demo', anchors: ['home.demo'], when: ['libraryEmpty'] },
      { id: 'mode', anchors: ['header.mode'] },
      { id: 'signin', anchors: ['header.signin'], when: ['cloudInvite'] },
      { id: 'library', anchors: ['home.library'], when: ['libraryList'] },
      { id: 'settings', anchors: ['header.settings'], when: ['!phone'] },
      { id: 'more', anchors: ['header.more'], when: ['phone'] },
    ],
  },
  // §1.2 — routes `track` and `demo` (one seen flag)
  song: {
    id: 'song',
    steps: [
      { id: 'now', anchors: ['song.now'], scrollTop: true, variants: ['demo'] },
      { id: 'instrument', anchors: ['song.instrument'], scrollTop: true, keys: ['I'] },
      { id: 'tempo', anchors: ['song.tempo'], scrollTop: true, keys: ['T', 'K'] },
      {
        id: 'keyAll',
        anchors: ['song.key', 'song.transpose', 'song.simplify', 'song.accidentals'],
        when: ['!phone'],
        scrollTop: true,
        keys: ['−', '=', 'S'],
      },
      // phones: the four do not fit the toolbar's visible strip
      { id: 'keyTranspose', anchors: ['song.key', 'song.transpose'], when: ['phone'], scrollTop: true },
      { id: 'keyShape', anchors: ['song.simplify', 'song.accidentals'], when: ['phone'], scrollTop: true },
      { id: 'views', anchors: ['song.views', 'song.follow'], keys: ['V', 'F'] },
      { id: 'grid', anchors: ['song.grid'], when: ['sheetView', 'hasChords'], keys: ['E'], variants: ['touch'] },
      { id: 'marks', anchors: [], centre: true, body: 'chordMarks' },
      { id: 'bars', anchors: ['song.barNumber'], when: ['sheetView', 'hasChords'], keys: ['L'], variants: ['touch'] },
      { id: 'legend', anchors: ['song.legend'], when: ['hasChords'] },
      { id: 'copy', anchors: ['song.copy'], keys: ['C'] },
      { id: 'settings', anchors: ['song.settings'] },
      { id: 'player', anchors: ['song.player'], keys: ['?'], variants: ['demo', 'touch'] },
    ],
  },
  // §1.3 — the «Ноти» view
  score: {
    id: 'score',
    steps: [
      { id: 'parts', anchors: ['score.parts'] },
      { id: 'chords', anchors: ['score.chords'] },
      { id: 'level', anchors: ['score.level'] },
      { id: 'export', anchors: ['score.export'] },
      { id: 'canvas', anchors: ['score.canvas'], when: ['scoreRendered'], variants: ['demo'] },
    ],
  },
  // §1.4 — the «Живе фортепіано» panel; without notes, steps 1–2 become one centred card
  keys: {
    id: 'keys',
    steps: [
      { id: 'intro', anchors: [], when: ['!keysReady'] },
      { id: 'canvas', anchors: ['keys.canvas'], when: ['keysReady'] },
      { id: 'edges', anchors: ['keys.canvas'], when: ['keysReady'] },
      { id: 'sync', anchors: ['keys.sync'] },
      { id: 'voice', anchors: ['keys.voice'] },
    ],
  },
  // §1.5 — route `listen`; the live elements exist only during a recording
  listen: {
    id: 'listen',
    steps: [
      { id: 'sources', anchors: ['listen.sources'], variants: ['noTab'] },
      { id: 'start', anchors: ['listen.start'] },
      { id: 'chord', anchors: ['live.chord'], centre: true },
      { id: 'keyTempo', anchors: ['live.key', 'live.tempo'], centre: true },
      { id: 'level', anchors: ['live.level'], centre: true },
      { id: 'controls', anchors: ['listen.controls'], centre: true },
    ],
  },
  // §1.6 — route `capture`: the tab can be heard (desktop Chrome / Edge) or it cannot
  capture: {
    id: 'capture',
    steps: [
      { id: 'video', anchors: ['capture.video'], when: ['canListenInTab'] },
      { id: 'start', anchors: ['capture.start'], when: ['canListenInTab'] },
      { id: 'howto', anchors: ['capture.howto'], when: ['canListenInTab'] },
      { id: 'controls', anchors: ['capture.controls'], when: ['canListenInTab'], centre: true },
      { id: 'videoNoTab', anchors: ['capture.video'], when: ['!canListenInTab'] },
      { id: 'alt', anchors: ['capture.alt'], when: ['!canListenInTab'] },
    ],
  },
}
```

- [ ] **Step 4: Write `i18n/tour.ts`**

`frontend/src/i18n/tour.ts`:

```ts
import type { Dict } from './index'

// The guided tour (src/lib/tour, src/components/tour). Keys prefixed "tour.": the bubble's buttons, the
// «Інструкція» entries, the chord-marks cheat sheet, and tour.<tourId>.<stepId>.title / .text[.<variant>].
export const tour: Dict = {
  uk: {
    'tour.open': 'Інструкція',
    'tour.next': 'Далі',
    'tour.back': 'Назад',
    'tour.done': 'Готово',
    'tour.skip': 'Пропустити',
    'tour.counter': '{n} / {total}',
    'tour.shortcuts.hint': 'Що робить кожна кнопка, покаже інструкція.',

    'tour.marks.colour': 'колір — основна нота; мінор того ж кольору, лише приглушений',
    'tour.marks.unsure': 'пунктир — програма не впевнена',
    'tour.marks.none': 'тут акорду немає (N)',
    'tour.marks.bass': 'після риски — нота в басі',
    'tour.marks.m': 'мінор — сумніше звучання',
    'tour.marks.7': 'септакорд — тягне до наступного',
    'tour.marks.maj7': 'мʼякий «джазовий» мажор',
    'tour.marks.sus': 'ні мажор, ні мінор',
    'tour.marks.dim': 'зменшений, напружений',
    'tour.marks.aug': 'збільшений, «у повітрі»',
    'tour.marks.add9': 'додана девʼята нота',

    'tour.home.welcome.title': 'Привіт! Це Chords Listener',
    'tour.home.welcome.text': 'Тут ти отримаєш акорди до будь-якої пісні. Вони підсвічуються в такт музиці, а скопіювати їх можна одним кліком.',
    'tour.home.input.title': 'Посилання або файл',
    'tour.home.input.text': 'Встав сюди посилання на YouTube або перетягни аудіо чи відео будь-куди у вікно. Ctrl/⌘+V теж працює будь-де на цій сторінці.',
    'tour.home.input.text.touch': 'Встав сюди посилання на YouTube чи інше відео — розпізнавання почнеться одразу.',
    'tour.home.sources.title': 'Файл або «Слухати»',
    'tour.home.sources.text': '«Файл» відкриває пісню з твого пристрою. «Слухати» — сайт слухає мікрофон чи звук іншої вкладки й показує акорди наживо.',
    'tour.home.demo.title': 'Спробуй демо',
    'tour.home.demo.text': 'Поки пісень немає, відкрий демо: там можна спробувати все, нічого не завантажуючи.',
    'tour.home.mode.title': 'Де розпізнаються пісні',
    'tour.home.mode.text': 'Без акаунта пісні розпізнаються просто в браузері, з акаунтом — у хмарі. Зелена крапка — хмара на звʼязку, помаранчева блимає — вона прокидається. Натисни, щоб дізнатися більше.',
    'tour.home.signin.title': 'Безкоштовний акаунт',
    'tour.home.signin.text': 'З акаунтом хмара розпізнає акорди точніше й знаходить вокал, а твоя бібліотека буде на всіх пристроях.',
    'tour.home.library.title': 'Нещодавні',
    'tour.home.library.text': 'Тут твої пісні. Натисни на будь-яку, щоб відкрити її акорди.',
    'tour.home.settings.title': 'Налаштування й допомога',
    'tour.home.settings.text': 'Мова, тема, гарячі клавіші й кнопка «Інструкція» — вона будь-коли покаже цей огляд знову.',
    'tour.home.more.title': 'Меню ⋯',
    'tour.home.more.text': 'Тут тема, мова, гарячі клавіші й «Інструкція» — вона будь-коли покаже цей огляд знову.',

    'tour.song.now.title': 'Зараз грає',
    'tour.song.now.text': 'Великий акорд звучить просто зараз, поруч — наступний і відлік долей до зміни, а праворуч аплікатура. Натисни на акорд, щоб почути його.',
    'tour.song.now.text.demo': 'Великий акорд — той, що в цьому місці пісні, поруч — наступний і відлік долей, а праворуч аплікатура. У демо немає запису, але натисни на акорд — і почуєш його.',
    'tour.song.instrument.title': 'Інструмент',
    'tour.song.instrument.text': 'Обери свій інструмент, і під нього підлаштуються аплікатури, звук акорду й підказки: капо для гітари й укулеле, живе фортепіано для клавішних, покриття для хендпана.',
    'tour.song.tempo.title': 'Темп',
    'tour.song.tempo.text': 'Число — удари за хвилину, крапки — долі такту. Натисни, щоб виправити темп ×½ чи ×2, відбити його самому або ввімкнути метроном.',
    'tour.song.keyAll.title': 'Тональність і запис акордів',
    'tour.song.keyAll.text': 'Це тональність пісні: після транспонування стара закреслена, а нова кольорова. − / + зсувають пісню на півтона, «Спростити» замінює складні акорди простими, а поруч обираєш дієзи чи бемолі.',
    'tour.song.keyTranspose.title': 'Тональність',
    'tour.song.keyTranspose.text': 'Це тональність пісні: після транспонування стара закреслена, а нова кольорова. − / + зсувають пісню на півтона, наприклад під твій голос.',
    'tour.song.keyShape.title': 'Спростити й знаки',
    'tour.song.keyShape.text': '«Спростити» замінює складні акорди простими: Am7 → Am. Поруч обираєш, як писати чорні клавіші — дієзами чи бемолями.',
    'tour.song.views.title': 'Вигляд і «Слідкувати»',
    'tour.song.views.text': 'Перемикай вигляд: акорди по тактах, таймлайн або ноти. Приціл — це «Слідкувати»: сторінка сама гортається за піснею.',
    'tour.song.grid.title': 'Сітка акордів',
    'tour.song.grid.text': 'Кожна клітинка — такт. Натисни на акорд — пісня перемотається туди, наведи мишею — побачиш картку акорду, а подвійний клік відкриє виправлення.',
    'tour.song.grid.text.touch': 'Кожна клітинка — такт. Натисни на акорд — перемотка, затисни — картка акорду, двічі натисни — виправити.',
    'tour.song.marks.title': 'Що означають позначки',
    'tour.song.marks.text': 'Колір, підкреслення й маленькі літери після назви теж щось кажуть. Ось шпаргалка.',
    'tour.song.bars.title': 'Номери тактів',
    'tour.song.bars.text': 'Натисни на номер, щоб виділити такт, а з Shift — кілька поспіль. Виділене можна зациклити чи скопіювати.',
    'tour.song.bars.text.touch': 'Натисни на номер, щоб виділити такт. Потім його можна зациклити чи скопіювати в панелі внизу.',
    'tour.song.legend.title': 'Акорди в пісні',
    'tour.song.legend.text': 'Усі акорди цієї пісні, з аплікатурами, коли ввімкнено «Показувати аплікатури». Натисни на картку, щоб почути акорд.',
    'tour.song.copy.title': 'Копіювати',
    'tour.song.copy.text': 'Копіює всі акорди текстом. Стрілка ▾ поруч — інші формати й файли: PDF, MusicXML, MIDI.',
    'tour.song.settings.title': 'Налаштування вигляду',
    'tour.song.settings.text': 'Тут «Тактів у рядку», аплікатури, живе фортепіано, «Звук акорду при натисканні» й «Не вимикати екран».',
    'tour.song.player.title': 'Плеєр',
    'tour.song.player.text': 'Пробіл — пауза, ← / → — на 5 секунд, Shift зі стрілкою — до сусіднього акорду. Тут же швидкість без зміни тону, а кольорова смужка показує зміни акордів. «?» покаже всі клавіші й цю інструкцію.',
    'tour.song.player.text.demo': 'У демо немає запису, тож пісня мовчить, але час іде, як у справжній. Пробіл — пауза, ← / → — на 5 секунд, а кольорова смужка показує зміни акордів. «?» покаже всі клавіші й цю інструкцію.',
    'tour.song.player.text.touch': 'Тут пауза, перемотка на 5 секунд і швидкість без зміни тону. Кольорова смужка під хвилею показує, де змінюються акорди.',
    'tour.song.player.text.demo.touch': 'У демо немає запису, тож пісня мовчить, але час іде, як у справжній. Тут пауза, перемотка й швидкість, а кольорова смужка показує зміни акордів.',

    'tour.score.parts.title': 'Партії',
    'tour.score.parts.text': 'Вмикай чи ховай мелодію вокалу й партію фортепіано — праву й ліву руку.',
    'tour.score.chords.title': 'Назви акордів',
    'tour.score.chords.text': 'Показує над нотами ті самі назви акордів, що в сітці.',
    'tour.score.level.title': 'Складність',
    'tour.score.level.text': '«Складний» — усі розпізнані ноти, «Середній» — простіший ритм, «Спрощений» — лише акорди: акорд у правій руці, бас у лівій.',
    'tour.score.export.title': 'Завантажити ноти',
    'tour.score.export.text': 'PDF — щоб друкувати, MusicXML — для нотних редакторів, MIDI — для GarageBand чи Logic.',
    'tour.score.canvas.title': 'Ноти',
    'tour.score.canvas.text': 'Натисни на будь-яку ноту, і пісня гратиме з цього місця. Світла лінія показує, що звучить зараз.',
    'tour.score.canvas.text.demo': 'Натисни на будь-яку ноту, щоб перейти до цього місця. Світла лінія показує, де ти зараз.',

    'tour.keys.intro.title': 'Живе фортепіано',
    'tour.keys.intro.text': 'На твоїх піснях ноти падають згори на ці клавіші й натискають їх разом зі звуком. ▼ чи ▲ біля краю — нота нижча чи вища за клавіатуру.',
    'tour.keys.canvas.title': 'Живе фортепіано',
    'tour.keys.canvas.text': 'Ноти падають згори й натискають клавіші разом зі звуком. Колір — яка це нота, такий самий, як в акорду з цією основною нотою.',
    'tour.keys.edges.title': 'За краєм клавіатури',
    'tour.keys.edges.text': '▼ чи ▲ біля краю означає, що нота нижча чи вища за показані клавіші.',
    'tour.keys.sync.title': 'Синхронізація',
    'tour.keys.sync.text': 'Якщо клавіші світяться не в такт зі звуком (наприклад, з Bluetooth-навушниками), зсунь їх тут.',
    'tour.keys.voice.title': 'Голос',
    'tour.keys.voice.text': '«Відокремити голос» — сервер відділить спів, і клавіші гратимуть лише інструменти. Коли голос уже відокремлено, цей перемикач показує чи ховає його мелодію.',

    'tour.listen.sources.title': 'Що слухати',
    'tour.listen.sources.text': '«Мікрофон» — коли музика грає поруч. «Вкладка браузера» — коли вона грає в іншій вкладці: звук піде напряму, без шуму кімнати.',
    'tour.listen.sources.text.noTab': 'Обирай «Мікрофон», коли музика грає поруч. Звук іншої вкладки цей браузер не передає — це працює в Chrome чи Edge на компʼютері.',
    'tour.listen.start.title': 'Почати',
    'tour.listen.start.text': 'Браузер спитає дозволу на мікрофон чи запропонує вибрати вкладку, і акорди почнуть зʼявлятися під час гри.',
    'tour.listen.chord.title': 'Акорд наживо',
    'tour.listen.chord.text': 'Великий акорд — той, що звучить зараз. Блідий ще уточнюється, а смугаста смужка під ним означає, що акорд ще не остаточний.',
    'tour.listen.keyTempo.title': 'Тональність і темп',
    'tour.listen.keyTempo.text': 'Тональність, яку чути останні півтори хвилини, і приблизний темп. На початку вони можуть мінятися.',
    'tour.listen.level.title': 'Рівень звуку',
    'tour.listen.level.text': 'Зелені смужки — гучність у нормі, жовтогарячі — гучно, червона — перевантаження. Якщо світяться одна-дві, зроби звук гучніше.',
    'tour.listen.controls.title': 'Пауза, скасувати, зберегти',
    'tour.listen.controls.text': '«Пауза» зупиняє запис, «Скасувати» нічого не зберігає. «Зупинити й зберегти» збереже пісню й розпізнає акорди точніше, ніж наживо.',

    'tour.capture.video.title': 'Відео тут',
    'tour.capture.video.text': 'Відео гратиме на цій сторінці, а сайт слухатиме звук цієї вкладки й показуватиме акорди наживо.',
    'tour.capture.start.title': 'Почати',
    'tour.capture.start.text': 'Натисни, і браузер запропонує поділитися цією вкладкою.',
    'tour.capture.howto.title': 'Головне — звук вкладки',
    'tour.capture.howto.text': 'У вікні браузера постав галочку «Також поділитися звуком вкладки» й натисни «Поділитися». Без неї сайт нічого не почує.',
    'tour.capture.controls.title': 'Зупинити й зберегти',
    'tour.capture.controls.text': 'Коли пісня скінчиться, натисни «Зупинити й зберегти»: запис збережеться як пісня, а акорди розпізнаються точніше. «Скасувати» нічого не зберігає.',
    'tour.capture.videoNoTab.title': 'Відео тут',
    'tour.capture.videoNoTab.text': 'Відео гратиме на цій сторінці, але цей браузер не може слухати звук вкладки.',
    'tour.capture.alt.title': 'Як отримати акорди',
    'tour.capture.alt.text': 'Увімкни пісню на іншому пристрої й слухай мікрофоном, вибери файл або відкрий це посилання на компʼютері в Chrome чи Edge.',
  },
  en: {
    'tour.open': 'Guide',
    'tour.next': 'Next',
    'tour.back': 'Back',
    'tour.done': 'Done',
    'tour.skip': 'Skip',
    'tour.counter': '{n} / {total}',
    'tour.shortcuts.hint': 'The guide shows what every button does.',

    'tour.marks.colour': 'colour = the root note; minor is the same colour, muted',
    'tour.marks.unsure': 'dotted underline: the app is unsure',
    'tour.marks.none': 'no chord here (N)',
    'tour.marks.bass': 'after the slash: the bass note',
    'tour.marks.m': 'minor: a sadder sound',
    'tour.marks.7': 'seventh: pulls to the next chord',
    'tour.marks.maj7': 'a soft, jazzy major',
    'tour.marks.sus': 'neither major nor minor',
    'tour.marks.dim': 'diminished, tense',
    'tour.marks.aug': 'augmented, hanging in the air',
    'tour.marks.add9': 'an added ninth',

    'tour.home.welcome.title': 'Hi! This is Chords Listener',
    'tour.home.welcome.text': 'Get the chords to any song here. They light up in time with the music, and you can copy them in one click.',
    'tour.home.input.title': 'A link or a file',
    'tour.home.input.text': 'Paste a YouTube link here or drag an audio or video file anywhere into the window. Ctrl/⌘+V works anywhere on this page too.',
    'tour.home.input.text.touch': 'Paste a YouTube or other video link here and recognition starts right away.',
    'tour.home.sources.title': 'File or Listen',
    'tour.home.sources.text': 'File opens a song from your device. Listen lets the site hear your microphone or another tab and shows the chords live.',
    'tour.home.demo.title': 'Try the demo',
    'tour.home.demo.text': 'No songs yet? Open the demo and try everything without uploading anything.',
    'tour.home.mode.title': 'Where songs are analysed',
    'tour.home.mode.text': 'Without an account songs are analysed right in your browser; with one, in the cloud. A green dot means the cloud is connected, a blinking amber one that it is waking up. Open it to learn more.',
    'tour.home.signin.title': 'A free account',
    'tour.home.signin.text': 'With an account the cloud recognises chords more accurately and finds the vocals, and your library is on all your devices.',
    'tour.home.library.title': 'Recent',
    'tour.home.library.text': 'Your songs live here. Open any of them to see its chords.',
    'tour.home.settings.title': 'Settings and help',
    'tour.home.settings.text': 'Language, theme, keyboard shortcuts and the Guide button, which shows this tour again any time.',
    'tour.home.more.title': 'The ⋯ menu',
    'tour.home.more.text': 'Theme, language, shortcuts and Guide, which shows this tour again any time.',

    'tour.song.now.title': 'Now playing',
    'tour.song.now.text': 'The big chord is playing right now; next to it are the next chord and a beat countdown to the change, and on the right how to play it. Click the chord to hear it.',
    'tour.song.now.text.demo': 'The big chord is the one at this point of the song; next to it are the next chord and a beat countdown, and on the right how to play it. The demo has no recording, but click the chord to hear it.',
    'tour.song.instrument.title': 'Instrument',
    'tour.song.instrument.text': 'Pick your instrument and the shapes, chord sound and hints follow it: a capo for guitar and ukulele, the live piano for keyboards, coverage for the handpan.',
    'tour.song.tempo.title': 'Tempo',
    'tour.song.tempo.text': 'The number is beats per minute, the dots are the beats of a bar. Click it to fix the tempo ×½ or ×2, tap it in yourself or turn on the metronome.',
    'tour.song.keyAll.title': 'Key and chord spelling',
    'tour.song.keyAll.text': 'This is the song’s key: once you transpose, the old one is struck through and the new one is in colour. − / + move the song a semitone, Simplify swaps hard chords for easy ones, and next to it you pick sharps or flats.',
    'tour.song.keyTranspose.title': 'Key',
    'tour.song.keyTranspose.text': 'This is the song’s key: once you transpose, the old one is struck through and the new one is in colour. − / + move the song a semitone, say to suit your voice.',
    'tour.song.keyShape.title': 'Simplify and accidentals',
    'tour.song.keyShape.text': 'Simplify swaps hard chords for easy ones: Am7 → Am. Next to it you choose how black keys are written — sharps or flats.',
    'tour.song.views.title': 'Views and Follow',
    'tour.song.views.text': 'Switch the view: chords by bar, a timeline or sheet music. The crosshair is Follow: the page scrolls along with the song.',
    'tour.song.grid.title': 'The chord grid',
    'tour.song.grid.text': 'Each cell is a bar. Click a chord to jump there, hover for its chord card, and double-click to fix it.',
    'tour.song.grid.text.touch': 'Each cell is a bar. Tap a chord to jump there, hold for its chord card, double-tap to fix it.',
    'tour.song.marks.title': 'What the marks mean',
    'tour.song.marks.text': 'Colours, underlines and the small letters after a name all mean something. Here is a cheat sheet.',
    'tour.song.bars.title': 'Bar numbers',
    'tour.song.bars.text': 'Click a number to select a bar, Shift-click for several in a row. Then loop or copy the selection.',
    'tour.song.bars.text.touch': 'Tap a number to select a bar. Then loop or copy it from the bar at the bottom.',
    'tour.song.legend.title': 'Chords in the song',
    'tour.song.legend.text': 'Every chord of this song, with its shape when Show chord shapes is on. Click a tile to hear the chord.',
    'tour.song.copy.title': 'Copy',
    'tour.song.copy.text': 'Copies all the chords as text. The ▾ next to it has other formats and files: PDF, MusicXML, MIDI.',
    'tour.song.settings.title': 'View settings',
    'tour.song.settings.text': 'Bars per line, chord shapes, the live piano, Chord sound on click and Keep the screen on.',
    'tour.song.player.title': 'The player',
    'tour.song.player.text': 'Space pauses, ← / → jump 5 seconds, Shift with an arrow goes to the next chord. Here too: speed without changing the pitch, and a coloured strip of the chord changes. “?” lists every key and opens this guide.',
    'tour.song.player.text.demo': 'The demo has no recording, so the song is silent, but time runs as in a real one. Space pauses, ← / → jump 5 seconds, and the coloured strip shows the chord changes. “?” lists every key and opens this guide.',
    'tour.song.player.text.touch': 'Pause, jump 5 seconds and change the speed without changing the pitch. The coloured strip under the waveform shows where the chords change.',
    'tour.song.player.text.demo.touch': 'The demo has no recording, so the song is silent, but time runs as in a real one. Pause, jump and change the speed here; the coloured strip shows the chord changes.',

    'tour.score.parts.title': 'Parts',
    'tour.score.parts.text': 'Show or hide the vocal melody and the piano part — right and left hand.',
    'tour.score.chords.title': 'Chord names',
    'tour.score.chords.text': 'Shows the same chord names as the grid, above the notes.',
    'tour.score.level.title': 'Difficulty',
    'tour.score.level.text': 'Complex has every recognised note, Medium a simpler rhythm, Simple only the chords: a chord in the right hand, the bass in the left.',
    'tour.score.export.title': 'Download the score',
    'tour.score.export.text': 'PDF to print, MusicXML for notation editors, MIDI for GarageBand or Logic.',
    'tour.score.canvas.title': 'The notes',
    'tour.score.canvas.text': 'Click any note and the song plays from there. The bright line shows what is playing now.',
    'tour.score.canvas.text.demo': 'Click any note to jump there. The bright line shows where you are.',

    'tour.keys.intro.title': 'Live piano',
    'tour.keys.intro.text': 'On your own songs the notes fall onto these keys and press them along with the sound. ▼ or ▲ at an edge means a note below or above the keyboard.',
    'tour.keys.canvas.title': 'Live piano',
    'tour.keys.canvas.text': 'Notes fall from above and press the keys along with the sound. The colour tells the note — the same as a chord with that root.',
    'tour.keys.edges.title': 'Past the keyboard',
    'tour.keys.edges.text': '▼ or ▲ at an edge means the note is below or above the keys shown.',
    'tour.keys.sync.title': 'Sync',
    'tour.keys.sync.text': 'If the keys light up out of time with the sound (Bluetooth headphones, say), shift them here.',
    'tour.keys.voice.title': 'Voice',
    'tour.keys.voice.text': 'Separate the voice: the server splits off the singing and the keys play only the instruments. Once the voice is separated, this switch shows or hides its melody.',

    'tour.listen.sources.title': 'What to listen to',
    'tour.listen.sources.text': 'Microphone when the music plays nearby. Browser tab when it plays in another tab: the sound comes straight in, without the room’s noise.',
    'tour.listen.sources.text.noTab': 'Pick Microphone when the music plays nearby. This browser cannot pass on another tab’s sound — that works in Chrome or Edge on a computer.',
    'tour.listen.start.title': 'Start',
    'tour.listen.start.text': 'The browser asks to use the microphone or to pick a tab, and the chords appear as the music plays.',
    'tour.listen.chord.title': 'The live chord',
    'tour.listen.chord.text': 'The big chord is the one playing now. A pale one is still being refined, and a striped bar under it means the chord is not final yet.',
    'tour.listen.keyTempo.title': 'Key and tempo',
    'tour.listen.keyTempo.text': 'The key heard over the last minute and a half, and an approximate tempo. They may change at the start.',
    'tour.listen.level.title': 'Sound level',
    'tour.listen.level.text': 'Green bars mean the level is fine, amber is loud, red is overload. If only one or two light up, turn the sound up.',
    'tour.listen.controls.title': 'Pause, cancel, save',
    'tour.listen.controls.text': 'Pause stops the recording, Cancel keeps nothing. Stop and save keeps the song and recognises the chords more accurately than live.',

    'tour.capture.video.title': 'The video plays here',
    'tour.capture.video.text': 'The video plays on this page while the site listens to this tab and shows the chords live.',
    'tour.capture.start.title': 'Start',
    'tour.capture.start.text': 'Press it and the browser offers to share this tab.',
    'tour.capture.howto.title': 'The key part: tab audio',
    'tour.capture.howto.text': 'In the browser’s window tick “Also share tab audio” and press “Share”. Without it the site hears nothing.',
    'tour.capture.controls.title': 'Stop and save',
    'tour.capture.controls.text': 'When the song ends, press Stop and save: the recording is kept as a song and the chords are recognised more accurately. Cancel keeps nothing.',
    'tour.capture.videoNoTab.title': 'The video plays here',
    'tour.capture.videoNoTab.text': 'The video plays on this page, but this browser cannot listen to a tab’s sound.',
    'tour.capture.alt.title': 'How to get the chords',
    'tour.capture.alt.text': 'Play the song on another device and listen with the microphone, pick a file, or open this link on a computer in Chrome or Edge.',
  },
}
```

- [ ] **Step 5: Register the dictionary**

In `frontend/src/i18n/index.ts` add `import { tour } from './tour'` after `import { score } from './score'` (line 13), and change line 22 to:

```ts
const dicts: Dict[] = [core, chords, account, handpan, tempo, web, sound, keys, cloud, live, score, tour]
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/tour/tours.test.ts src/i18n/tour.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full checks**

Run: `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/tour/tours.ts frontend/src/lib/tour/tours.test.ts frontend/src/i18n/tour.ts frontend/src/i18n/tour.test.ts frontend/src/i18n/index.ts
git commit -m "Tour: the six tours as data, every text in uk and en, an i18n completeness test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Step machine

**Files:**
- Create: `frontend/src/lib/tour/machine.ts`
- Test: `frontend/src/lib/tour/machine.test.ts`

**Interfaces:**
- Consumes: `conditionHolds`, `Tour`, `TourFlags`, `TourId`, `TourStep` from `lib/tour/tours.ts` (Task 2).
- Produces:
  - `export interface StepEnv { flags: TourFlags; present(anchor: string): boolean }`
  - `export interface TourRun { index: number; history: readonly number[] }`
  - `export type CloseReason = 'done' | 'skip' | 'escape' | 'exhausted' | 'route'`
  - `export type Advance = { run: TourRun } | { end: CloseReason }`
  - `export interface Counter { ordinal: number; total: number; first: boolean; last: boolean }`
  - `export function stepIncluded(step: TourStep, env: StepEnv): boolean`
  - `export function startRun(tour: Tour, env: StepEnv): TourRun | null`
  - `export function advance(tour: Tour, run: TourRun, env: StepEnv): Advance` (no later step → `{ end: 'done' }`)
  - `export function goBack(tour: Tour, run: TourRun, env: StepEnv): TourRun | null`
  - `export function anchorsGone(tour: Tour, run: TourRun, env: StepEnv): Advance` (centre → same run; none left → `{ end: 'exhausted' }`)
  - `export function counter(tour: Tour, run: TourRun, env: StepEnv): Counter`
  - `export function marksSeen(reason: CloseReason): boolean`
  - `export function afterClose(queue: readonly TourId[], reason: CloseReason): { next: TourId | null; queue: TourId[] }`

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/tour/machine.test.ts`:

```ts
// The step machine: which steps are included (conditions + anchors on screen, re-evaluated at every step
// change), the counter and «Готово», back / next at the ends, a vanished anchor vs a centre card, close
// reasons, and the chain of a re-opened tour (Song → Live keys only after «Готово»).
import { describe, expect, it } from 'vitest'
import { advance, afterClose, anchorsGone, counter, goBack, marksSeen, startRun, stepIncluded, type StepEnv, type TourRun } from './machine'
import type { Tour, TourFlags } from './tours'

const TOUR: Tour = {
  id: 'home',
  steps: [
    { id: 'a', anchors: [] }, // 0: no anchor → always (a centred card)
    { id: 'b', anchors: ['x'] }, // 1: needs x
    { id: 'c', anchors: ['y'], when: ['libraryEmpty'] }, // 2: needs y and a flag
    { id: 'd', anchors: ['z'], centre: true }, // 3: centre → kept without z
    { id: 'e', anchors: ['x', 'y'] }, // 4: either anchor
  ],
}

const env = (present: string[], flags: TourFlags = {}): StepEnv => ({ flags, present: (a) => present.includes(a) })
const run = (index: number, history: number[] = []): TourRun => ({ index, history })

describe('which steps are included', () => {
  it('needs every condition and, unless centre or anchorless, one anchor on screen', () => {
    const included = (e: StepEnv) => TOUR.steps.map((s, i) => (stepIncluded(s, e) ? i : -1)).filter((i) => i >= 0)
    expect(included(env([]))).toEqual([0, 3])
    expect(included(env(['x']))).toEqual([0, 1, 3, 4])
    expect(included(env(['y']))).toEqual([0, 3, 4])
    expect(included(env(['y'], { libraryEmpty: true }))).toEqual([0, 2, 3, 4])
  })

  it('starts at the first included step; with none it does not start', () => {
    expect(startRun(TOUR, env([]))).toEqual(run(0))
    const anchoredOnly: Tour = { id: 'score', steps: [{ id: 'p', anchors: ['p'] }, { id: 'q', anchors: ['q'] }] }
    expect(startRun(anchoredOnly, env([]))).toBeNull()
    expect(startRun(anchoredOnly, env(['q']))).toEqual(run(1))
  })
})

describe('next, back and the counter', () => {
  it('counts among the steps included now («2 / 4» when one was left out)', () => {
    const e = env(['x'])
    expect(counter(TOUR, run(0), e)).toEqual({ ordinal: 1, total: 4, first: true, last: false })
    const r1 = advance(TOUR, run(0), e)
    expect(r1).toEqual({ run: run(1, [0]) })
    expect(counter(TOUR, run(1, [0]), e)).toEqual({ ordinal: 2, total: 4, first: false, last: false })
    expect(counter(TOUR, run(4, [0, 1, 3]), e)).toEqual({ ordinal: 4, total: 4, first: false, last: true })
  })

  it('re-evaluates at each step change: a step that became available is shown', () => {
    expect(advance(TOUR, run(1, [0]), env(['x', 'y'], { libraryEmpty: true }))).toEqual({ run: run(2, [0, 1]) })
  })

  it('«Далі» on the last included step ends the tour as done', () => {
    expect(advance(TOUR, run(4, [0, 1, 3]), env(['x']))).toEqual({ end: 'done' })
    expect(advance(TOUR, run(3, [0]), env([]))).toEqual({ end: 'done' })
  })

  it('«Назад» goes to the previous shown step, skipping one that is gone, and not before the first', () => {
    expect(goBack(TOUR, run(0), env(['x']))).toBeNull()
    expect(goBack(TOUR, run(3, [0, 1]), env(['x']))).toEqual(run(1, [0]))
    expect(goBack(TOUR, run(3, [0, 1]), env([]))).toEqual(run(0, []))
  })

  it('the counter does not count a shown step whose anchor has gone since', () => {
    expect(counter(TOUR, run(3, [0, 1]), env([]))).toEqual({ ordinal: 2, total: 2, first: false, last: true })
  })
})

describe('a vanished anchor', () => {
  it('keeps a centre step open as a centred card', () => {
    expect(anchorsGone(TOUR, run(3, [0]), env([]))).toEqual({ run: run(3, [0]) })
  })

  it('moves any other step on to the next available one', () => {
    expect(anchorsGone(TOUR, run(1, [0]), env([]))).toEqual({ run: run(3, [0, 1]) })
  })

  it('ends the tour as exhausted when nothing is left', () => {
    expect(anchorsGone(TOUR, run(4, [0, 1, 3]), env([]))).toEqual({ end: 'exhausted' })
  })
})

describe('closing', () => {
  it('«Готово», «Пропустити», Esc and running out mark the tour seen; leaving the screen does not', () => {
    expect(marksSeen('done')).toBe(true)
    expect(marksSeen('skip')).toBe(true)
    expect(marksSeen('escape')).toBe(true)
    expect(marksSeen('exhausted')).toBe(true)
    expect(marksSeen('route')).toBe(false)
  })

  it('a chained tour follows only «Готово»; anything else drops the queue', () => {
    expect(afterClose(['keys'], 'done')).toEqual({ next: 'keys', queue: [] })
    expect(afterClose(['score', 'keys'], 'done')).toEqual({ next: 'score', queue: ['keys'] })
    for (const reason of ['skip', 'escape', 'exhausted', 'route'] as const) expect(afterClose(['keys'], reason)).toEqual({ next: null, queue: [] })
    expect(afterClose([], 'done')).toEqual({ next: null, queue: [] })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/lib/tour/machine.test.ts`
Expected: FAIL with `Error: Cannot find module './machine' imported from …`

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/tour/machine.ts`:

```ts
// The step machine of a running tour (spec §1 "Which steps show", §2 "Movement" and "Seen" state): which
// steps are included right now, next / back, a vanished anchor, close reasons, and the chained tours of a
// re-open. Pure: the page is seen through StepEnv (the flags and which anchors are on screen).
import { conditionHolds, type Tour, type TourFlags, type TourId, type TourStep } from './tours'

export interface StepEnv {
  flags: TourFlags
  /** the anchor is in the page and rendered (the first visible `data-tour` match) */
  present(anchor: string): boolean
}

/** The step on screen and the steps shown before it («Назад», the counter). */
export interface TourRun {
  index: number
  history: readonly number[]
}

/** done = «Готово» (or «Далі» with nothing after); exhausted = the anchors vanished and nothing is left */
export type CloseReason = 'done' | 'skip' | 'escape' | 'exhausted' | 'route'

export type Advance = { run: TourRun } | { end: CloseReason }

export interface Counter {
  ordinal: number
  total: number
  first: boolean
  last: boolean
}

export function stepIncluded(step: TourStep, env: StepEnv): boolean {
  if (step.when && !step.when.every((c) => conditionHolds(c, env.flags))) return false
  return step.anchors.length === 0 || !!step.centre || step.anchors.some((a) => env.present(a))
}

function nextIncluded(tour: Tour, after: number, env: StepEnv): number | null {
  for (let i = after + 1; i < tour.steps.length; i++) if (stepIncluded(tour.steps[i], env)) return i
  return null
}

export function startRun(tour: Tour, env: StepEnv): TourRun | null {
  const index = nextIncluded(tour, -1, env)
  return index === null ? null : { index, history: [] }
}

export function advance(tour: Tour, run: TourRun, env: StepEnv): Advance {
  const index = nextIncluded(tour, run.index, env)
  return index === null ? { end: 'done' } : { run: { index, history: [...run.history, run.index] } }
}

export function goBack(tour: Tour, run: TourRun, env: StepEnv): TourRun | null {
  const history = [...run.history]
  while (history.length) {
    const index = history.pop()!
    if (stepIncluded(tour.steps[index], env)) return { index, history }
  }
  return null
}

/** The step's anchors stayed missing for 300 ms: a centre step stays as a card, any other moves on. */
export function anchorsGone(tour: Tour, run: TourRun, env: StepEnv): Advance {
  if (tour.steps[run.index].centre) return { run }
  const index = nextIncluded(tour, run.index, env)
  return index === null ? { end: 'exhausted' } : { run: { index, history: [...run.history, run.index] } }
}

export function counter(tour: Tour, run: TourRun, env: StepEnv): Counter {
  const before = run.history.filter((i) => stepIncluded(tour.steps[i], env)).length
  let after = 0
  for (let i = run.index + 1; i < tour.steps.length; i++) if (stepIncluded(tour.steps[i], env)) after++
  const ordinal = before + 1
  return { ordinal, total: ordinal + after, first: before === 0, last: after === 0 }
}

export function marksSeen(reason: CloseReason): boolean {
  return reason !== 'route'
}

/** A re-opened Song / Score tour chains Live keys: it follows «Готово» only; «Пропустити» or Esc ends both. */
export function afterClose(queue: readonly TourId[], reason: CloseReason): { next: TourId | null; queue: TourId[] } {
  if (reason !== 'done' || !queue.length) return { next: null, queue: [] }
  return { next: queue[0], queue: queue.slice(1) }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && npx vitest run src/lib/tour/machine.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full checks**

Run: `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/tour/machine.ts frontend/src/lib/tour/machine.test.ts
git commit -m "Tour: step machine — included steps, counter, back / next, vanished anchors, close reasons, chain

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Auto-start gate and the re-open mapping

**Files:**
- Create: `frontend/src/lib/tour/trigger.ts`
- Test: `frontend/src/lib/tour/trigger.test.ts`

**Interfaces:**
- Consumes: `Route` type from `hooks/useRoute.ts:8`; `ChordView` type from `store.ts:18`; `TourId` from Task 2.
- Produces:
  - `export const AUTO_START_DELAY_MS = 500`
  - `export interface GateInput { seen: boolean; ready: boolean; running: boolean; modal: boolean; menu: boolean; expanded: boolean; typing: boolean; playing: boolean; recording: boolean; hidden: boolean; blocked: boolean }`
  - `export function gateOpen(input: GateInput): boolean`
  - `export type StartResult = 'started' | 'busy' | 'empty'`
  - `export interface AutoStart { update(open: boolean): void; dispose(): void }`; `export function createAutoStart(start: () => StartResult, delay?: number): AutoStart`
  - `export interface ReopenContext { view: ChordView; keysPanel: boolean }`; `export function reopenTours(route: Route, ctx: ReopenContext): TourId[]`
  - `export function guideAvailable(route: Route, trackLoaded: boolean): boolean`
  - `export function tourRouteKey(route: Route): string`

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/tour/trigger.test.ts`:

```ts
// The auto-start gate (not before ready, not while anything else is open or busy, 500 ms after the last
// condition clears, never once seen) and which tour the «Інструкція» entries open on each screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Route } from '../../hooks/useRoute'
import { createAutoStart, gateOpen, guideAvailable, reopenTours, tourRouteKey, type GateInput } from './trigger'

const QUIET: GateInput = {
  seen: false,
  ready: true,
  running: false,
  modal: false,
  menu: false,
  expanded: false,
  typing: false,
  playing: false,
  recording: false,
  hidden: false,
  blocked: false,
}

const home: Route = { name: 'home' }
const listen: Route = { name: 'listen', source: null, title: null }
const capture = (blocked: boolean): Route => ({ name: 'capture', videoId: 'dQw4w9WgXcQ', blocked })
const track: Route = { name: 'track', id: 't1' }
const demo: Route = { name: 'demo' }
const job: Route = { name: 'job', id: 'j1' }
const notFound: Route = { name: 'notFound' }

describe('the gate', () => {
  it('opens on a ready, quiet, unseen screen', () => {
    expect(gateOpen(QUIET)).toBe(true)
  })

  it.each([
    ['not ready', { ready: false }],
    ['already seen', { seen: true }],
    ['another tour running', { running: true }],
    ['an aria-modal dialog', { modal: true }],
    ['a menu', { menu: true }],
    ['an expanded control (an anchored panel)', { expanded: true }],
    ['focus in a text field', { typing: true }],
    ['the song playing', { playing: true }],
    ['a recording running', { recording: true }],
    ['the page hidden', { hidden: true }],
    ['a screen holding it back (a link on its way)', { blocked: true }],
  ] as const)('stays shut: %s', (_, change) => {
    expect(gateOpen({ ...QUIET, ...change })).toBe(false)
  })
})

describe('the 500 ms auto-start', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts 500 ms after the gate opens, waits again when it shuts, and starts once', () => {
    const start = vi.fn(() => 'started' as const)
    const auto = createAutoStart(start)
    auto.update(true)
    vi.advanceTimersByTime(499)
    auto.update(false)
    vi.advanceTimersByTime(1000)
    expect(start).not.toHaveBeenCalled()
    auto.update(true)
    vi.advanceTimersByTime(250)
    auto.update(true) // a later check while waiting does not restart the wait
    vi.advanceTimersByTime(250)
    expect(start).toHaveBeenCalledTimes(1)
    auto.update(true)
    vi.advanceTimersByTime(2000)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('tries again after "busy" (another tour won the race) and gives up after "empty"', () => {
    const results = ['busy', 'empty'] as const
    let call = 0
    const start = vi.fn(() => results[call++])
    const auto = createAutoStart(start)
    auto.update(true)
    vi.advanceTimersByTime(500)
    auto.update(true)
    vi.advanceTimersByTime(500)
    auto.update(true)
    vi.advanceTimersByTime(2000)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('dispose cancels a pending start', () => {
    const start = vi.fn(() => 'started' as const)
    const auto = createAutoStart(start)
    auto.update(true)
    auto.dispose()
    vi.advanceTimersByTime(1000)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('re-opening', () => {
  it('runs the current screen’s tour', () => {
    expect(reopenTours(home, { view: 'sheet', keysPanel: false })).toEqual(['home'])
    expect(reopenTours(listen, { view: 'sheet', keysPanel: false })).toEqual(['listen'])
    expect(reopenTours(capture(false), { view: 'sheet', keysPanel: false })).toEqual(['capture'])
    expect(reopenTours(capture(true), { view: 'sheet', keysPanel: true })).toEqual(['capture'])
  })

  it.each([
    ['sheet', false, ['song']],
    ['timeline', false, ['song']],
    ['score', false, ['score']],
    ['sheet', true, ['song', 'keys']],
    ['timeline', true, ['song', 'keys']],
    ['score', true, ['score', 'keys']],
  ] as const)('track and demo, view %s, live keys %s → %j', (view, keysPanel, tours) => {
    expect(reopenTours(track, { view, keysPanel })).toEqual(tours)
    expect(reopenTours(demo, { view, keysPanel })).toEqual(tours)
  })

  it('has no tour on the processing and not-found pages', () => {
    expect(reopenTours(job, { view: 'sheet', keysPanel: true })).toEqual([])
    expect(reopenTours(notFound, { view: 'sheet', keysPanel: true })).toEqual([])
  })

  it('shows the entries where a tour exists, and on a song page only once it has loaded', () => {
    expect(guideAvailable(home, false)).toBe(true)
    expect(guideAvailable(listen, false)).toBe(true)
    expect(guideAvailable(capture(false), false)).toBe(true)
    expect(guideAvailable(track, false)).toBe(false)
    expect(guideAvailable(track, true)).toBe(true)
    expect(guideAvailable(demo, true)).toBe(true)
    expect(guideAvailable(job, true)).toBe(false)
    expect(guideAvailable(notFound, true)).toBe(false)
  })

  it('names a screen by its route (a different song or video is a different screen)', () => {
    expect(tourRouteKey(track)).toBe('track:t1')
    expect(tourRouteKey(capture(false))).toBe('capture:dQw4w9WgXcQ')
    expect(tourRouteKey(listen)).toBe('listen')
    expect(tourRouteKey(home)).toBe('home')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/lib/tour/trigger.test.ts`
Expected: FAIL with `Error: Cannot find module './trigger' imported from …`

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/tour/trigger.ts`:

```ts
// When a tour starts by itself and which tour the «Інструкція» entries open (spec §2 "Auto-start" and
// "Re-opening"). Pure; components/tour/hooks.ts feeds it the page's state.
import type { Route } from '../../hooks/useRoute'
import type { ChordView } from '../../store'
import type { TourId } from './tours'

export const AUTO_START_DELAY_MS = 500

export interface GateInput {
  seen: boolean
  /** the screen says it is ready (useTourTrigger's `ready`) */
  ready: boolean
  /** another tour is on screen */
  running: boolean
  /** an [aria-modal="true"] dialog is open */
  modal: boolean
  /** a [role="menu"] is open */
  menu: boolean
  /** an [aria-expanded="true"] control: an anchored panel is open */
  expanded: boolean
  /** focus is in a text field that has text (components/tour/dom.ts typingNow) */
  typing: boolean
  playing: boolean
  recording: boolean
  /** document.visibilityState === 'hidden' */
  hidden: boolean
  /** a component holds tours back (useTourBlock: a link sending, a file uploading, text in the link field) */
  blocked: boolean
}

export function gateOpen(i: GateInput): boolean {
  return (
    !i.seen && i.ready && !i.running && !i.modal && !i.menu && !i.expanded && !i.typing && !i.playing && !i.recording && !i.hidden && !i.blocked
  )
}

/** started; busy = another tour runs (try again later); empty = no step available (not opened, not seen) */
export type StartResult = 'started' | 'busy' | 'empty'

export interface AutoStart {
  /** called on every check with the gate's state */
  update(open: boolean): void
  dispose(): void
}

/** Starts `delay` ms after the gate opened and stayed open; a shut gate restarts the wait. Starts once. */
export function createAutoStart(start: () => StartResult, delay = AUTO_START_DELAY_MS): AutoStart {
  let timer: ReturnType<typeof setTimeout> | null = null
  let done = false
  const cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  return {
    update(open) {
      if (done) return
      if (!open) return cancel()
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        done = start() !== 'busy'
      }, delay)
    },
    dispose() {
      cancel()
      done = true
    },
  }
}

export interface ReopenContext {
  view: ChordView
  /** the live piano panel is on screen */
  keysPanel: boolean
}

/** The tours «Інструкція» runs here, in order (a second one follows only «Готово», machine.ts afterClose). */
export function reopenTours(route: Route, ctx: ReopenContext): TourId[] {
  switch (route.name) {
    case 'home':
      return ['home']
    case 'listen':
      return ['listen']
    case 'capture':
      return ['capture']
    case 'track':
    case 'demo': {
      const first: TourId = ctx.view === 'score' ? 'score' : 'song'
      return ctx.keysPanel ? [first, 'keys'] : [first]
    }
    default:
      return []
  }
}

/** The «Інструкція» entries show where a tour exists; on a song page only once it has loaded (no error). */
export function guideAvailable(route: Route, trackLoaded: boolean): boolean {
  if (route.name === 'track' || route.name === 'demo') return trackLoaded
  return reopenTours(route, { view: 'sheet', keysPanel: false }).length > 0
}

/** One screen = one key: leaving it (Back, a link, a new song) closes the running tour. */
export function tourRouteKey(route: Route): string {
  switch (route.name) {
    case 'job':
    case 'track':
      return `${route.name}:${route.id}`
    case 'capture':
      return `capture:${route.videoId}`
    default:
      return route.name
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && npx vitest run src/lib/tour/trigger.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full checks**

Run: `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/tour/trigger.ts frontend/src/lib/tour/trigger.test.ts
git commit -m "Tour: auto-start gate (500 ms, once, one at a time) and the re-open mapping

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Tour store, hooks and the DOM probes

**Files:**
- Create: `frontend/src/components/tour/dom.ts`, `frontend/src/components/tour/tourStore.ts`, `frontend/src/components/tour/hooks.ts`
- Test: `frontend/src/components/tour/dom.test.ts`, `frontend/src/components/tour/tourStore.test.ts`, `frontend/src/components/tour/hooks.test.ts`

**Interfaces:**
- Consumes: `isTypingTarget` (`hooks/useHotkeys.ts:12`); `parseHash` (`hooks/useRoute.ts:36`); `useApp` (`store.ts:149`: `isPlaying`, `pause()`, `view`); `useChordUi` (`components/chords/uiStore.ts:58`: `followPaused`, `setFollowPaused`); from Tasks 1–4: `isTourSeen`, `markTourSeen`; `TOURS`, `TourId`, `TourFlags`, `TourFlag`; `advance`, `afterClose`, `anchorsGone`, `goBack`, `marksSeen`, `startRun`, `CloseReason`, `StepEnv`, `TourRun`, `Advance`; `createAutoStart`, `gateOpen`, `reopenTours`, `tourRouteKey`, `StartResult`.
- Produces:
  - `dom.ts`: `export function anchorElement(id: string): HTMLElement | null`; `export function anchorPresent(id: string): boolean`; `export function typingNow(): boolean`; `export interface DomBlockers { modal: boolean; menu: boolean; expanded: boolean; typing: boolean; hidden: boolean }`; `export function domBlockers(): DomBlockers`; `export function whenNoModal(run: () => void, tries?: number): void`
  - `tourStore.ts`: `export interface ActiveTour { tourId: TourId; run: TourRun; routeKey: string; followPaused: boolean | null }`; `export const useTourStore` (zustand: `{ active: ActiveTour | null; queue: TourId[]; flags: TourFlags; blocks: Record<string, true> }`); `export function tourEnv(): StepEnv`; `export function startTour(tourId: TourId, queue?: TourId[]): StartResult`; `export function nextStep(): void`; `export function prevStep(): void`; `export function reportAnchorsGone(): void`; `export function closeTour(reason: CloseReason): void`; `export function closeIfRouteChanged(routeKey: string): void`; `export function startCurrentTour(opts?: { afterModal?: boolean }): void`
  - `hooks.ts`: `export const CHECK_MS = 250`; `export function useTourTrigger(tourId: TourId, ready: boolean, recording?: boolean): void`; `export function useTourFlags(flags: TourFlags): void`; `export function useTourBlock(blocked: boolean): void`

- [ ] **Step 1: Write the failing tests**

`frontend/src/components/tour/dom.test.ts`:

```ts
// @vitest-environment jsdom
// The DOM probes: an anchor is its first *visible* match (a copy hidden for the other breakpoint is skipped),
// and what on the page holds an automatic start back.
import { afterEach, describe, expect, it } from 'vitest'
import { anchorElement, domBlockers, typingNow } from './dom'

const made: HTMLElement[] = []
function add(html: string, visible = true): HTMLElement {
  const box = document.createElement('div')
  box.innerHTML = html
  const el = box.firstElementChild as HTMLElement
  el.getClientRects = () => (visible ? [{}] : []) as unknown as DOMRectList
  document.body.append(el)
  made.push(el)
  return el
}

afterEach(() => {
  made.splice(0).forEach((el) => el.remove())
})

describe('anchors', () => {
  it('skips a hidden copy and takes the first visible match', () => {
    add('<div data-tour="song.views">phone copy</div>', false)
    const shown = add('<div data-tour="song.views">desktop copy</div>')
    expect(anchorElement('song.views')).toBe(shown)
  })

  it('is absent when no copy is rendered', () => {
    add('<div data-tour="song.follow"></div>', false)
    expect(anchorElement('song.follow')).toBeNull()
    expect(anchorElement('song.copy')).toBeNull()
  })
})

describe('typing', () => {
  it('an empty focused field is not typing; a field with text is; a button never is', () => {
    const input = add('<input type="url" />') as HTMLInputElement
    input.focus()
    expect(typingNow()).toBe(false)
    input.value = 'https://youtu.be/x'
    expect(typingNow()).toBe(true)
    const area = add('<textarea></textarea>') as HTMLTextAreaElement
    area.focus()
    expect(typingNow()).toBe(false)
    area.value = 'Am F'
    expect(typingNow()).toBe(true)
    add('<button>b</button>').focus()
    expect(typingNow()).toBe(false)
  })
})

describe('blockers', () => {
  it('sees open dialogs, menus and expanded controls', () => {
    expect(domBlockers()).toEqual({ modal: false, menu: false, expanded: false, typing: false, hidden: false })
    add('<div aria-modal="true"></div>')
    add('<div role="menu"></div>')
    add('<button aria-expanded="true"></button>')
    expect(domBlockers()).toMatchObject({ modal: true, menu: true, expanded: true })
  })
})
```

`frontend/src/components/tour/tourStore.test.ts`:

```ts
// @vitest-environment jsdom
// The running tour: one at a time, an empty tour never opens (and is not seen), pause + follow on song pages,
// close reasons and the seen flag, a vanished anchor, a route change, and «Інструкція» on each screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isTourSeen } from '../../lib/tour/storage'
import { useApp, type PlayerController } from '../../store'
import { useChordUi } from '../chords/uiStore'
import { closeIfRouteChanged, closeTour, nextStep, prevStep, reportAnchorsGone, startCurrentTour, startTour, useTourStore } from './tourStore'

const made: HTMLElement[] = []
function anchor(id: string): HTMLElement {
  const el = document.createElement('div')
  el.dataset.tour = id
  el.getClientRects = () => [{}] as unknown as DOMRectList
  document.body.append(el)
  made.push(el)
  return el
}
const active = () => useTourStore.getState().active
const stepId = () => {
  const a = active()
  return a ? `${a.tourId}.${a.run.index}` : null
}

beforeEach(() => {
  localStorage.clear()
  window.location.hash = '#/'
  useTourStore.setState({ active: null, queue: [], flags: {}, blocks: {} })
  useApp.setState({ isPlaying: false, controller: null, view: 'sheet' })
  useChordUi.setState({ followPaused: false })
})

afterEach(() => {
  made.splice(0).forEach((el) => el.remove())
  vi.useRealTimers()
})

describe('starting', () => {
  it('starts at the first available step; with none it does not open and is not marked seen', () => {
    expect(startTour('score')).toBe('empty')
    expect(active()).toBeNull()
    expect(isTourSeen('score')).toBe(false)
    expect(startTour('home')).toBe('started')
    expect(stepId()).toBe('home.0')
  })

  it('runs one tour at a time', () => {
    startTour('home')
    expect(startTour('listen')).toBe('busy')
    expect(active()?.tourId).toBe('home')
  })

  it('on a song page pauses the song and suspends following, restoring following on close', () => {
    window.location.hash = '#/demo'
    const pause = vi.fn()
    useApp.setState({ isPlaying: true, controller: { pause } as unknown as PlayerController })
    startTour('home')
    expect(pause).toHaveBeenCalledTimes(1)
    expect(useChordUi.getState().followPaused).toBe(true)
    closeTour('skip')
    expect(useChordUi.getState().followPaused).toBe(false)

    useChordUi.setState({ followPaused: true })
    startTour('home')
    closeTour('escape')
    expect(useChordUi.getState().followPaused).toBe(true)
  })

  it('leaves a recording alone on the listen page', () => {
    window.location.hash = '#/listen'
    const pause = vi.fn()
    useApp.setState({ isPlaying: true, controller: { pause } as unknown as PlayerController })
    startTour('listen')
    expect(pause).not.toHaveBeenCalled()
    expect(active()?.followPaused).toBeNull()
  })
})

describe('moving and closing', () => {
  it('next / back; a vanished anchor moves on; nothing left ends it as exhausted (seen)', () => {
    const input = anchor('home.input')
    const sources = anchor('home.sources')
    startTour('home')
    nextStep()
    expect(stepId()).toBe('home.1')
    prevStep()
    expect(stepId()).toBe('home.0')
    prevStep()
    expect(stepId()).toBe('home.0')
    nextStep()
    input.remove()
    reportAnchorsGone()
    expect(stepId()).toBe('home.2')
    sources.remove()
    reportAnchorsGone()
    expect(active()).toBeNull()
    expect(isTourSeen('home')).toBe(true)
  })

  it.each(['done', 'skip', 'escape', 'exhausted'] as const)('%s marks the tour seen', (reason) => {
    startTour('home')
    closeTour(reason)
    expect(active()).toBeNull()
    expect(isTourSeen('home')).toBe(true)
  })

  it('«Далі» on the last step closes it as done', () => {
    startTour('home')
    nextStep()
    expect(active()).toBeNull()
    expect(isTourSeen('home')).toBe(true)
  })

  it('a route change closes it at once, unseen, and drops the chained tour', () => {
    window.location.hash = '#/track/t1'
    useTourStore.setState({ flags: { keysPanel: true } })
    startCurrentTour()
    expect(useTourStore.getState().queue).toEqual(['keys'])
    closeIfRouteChanged('track:t1')
    expect(active()?.tourId).toBe('song')
    closeIfRouteChanged('home')
    expect(active()).toBeNull()
    expect(useTourStore.getState().queue).toEqual([])
    expect(isTourSeen('song')).toBe(false)
  })
})

describe('«Інструкція»', () => {
  it('on a song page runs Song (Score in «Ноти»), then Live keys after «Готово» only', () => {
    window.location.hash = '#/track/t1'
    useTourStore.setState({ flags: { keysPanel: true } })
    startCurrentTour()
    expect(active()?.tourId).toBe('song') // only the centred chord-marks step is available here
    nextStep()
    expect(active()?.tourId).toBe('keys')
    closeTour('skip')
    expect(active()).toBeNull()

    anchor('score.parts')
    useApp.setState({ view: 'score' })
    startCurrentTour()
    expect(active()?.tourId).toBe('score')
    closeTour('skip')
    expect(useTourStore.getState().queue).toEqual([])
    expect(active()).toBeNull()
  })

  it('does nothing on the processing and not-found pages', () => {
    window.location.hash = '#/job/j1'
    startCurrentTour()
    expect(active()).toBeNull()
    window.location.hash = '#/nope'
    startCurrentTour()
    expect(active()).toBeNull()
  })

  it('from the shortcuts dialog waits until the dialog has left the page', () => {
    vi.useFakeTimers()
    const dialog = document.createElement('div')
    dialog.setAttribute('aria-modal', 'true')
    document.body.append(dialog)
    startCurrentTour({ afterModal: true })
    vi.advanceTimersByTime(200)
    expect(active()).toBeNull()
    dialog.remove()
    vi.advanceTimersByTime(50)
    expect(active()?.tourId).toBe('home')
  })
})
```

`frontend/src/components/tour/hooks.test.ts`:

```ts
// @vitest-environment jsdom
// Auto-start: a screen reports readiness with useTourTrigger; its tour opens ~500 ms after the page is quiet,
// once per device and one at a time. Flags and blocks come and go with the components that report them.
import { act, createElement, Fragment, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isTourSeen, markTourSeen } from '../../lib/tour/storage'
import type { TourId } from '../../lib/tour/tours'
import { useApp } from '../../store'
import { useTourBlock, useTourFlags, useTourTrigger } from './hooks'
import { closeTour, useTourStore } from './tourStore'

function Trigger({ id, ready, recording = false }: { id: TourId; ready: boolean; recording?: boolean }) {
  useTourTrigger(id, ready, recording)
  return null
}
function Block() {
  useTourBlock(true)
  return null
}
function Flags() {
  useTourFlags({ libraryEmpty: true })
  return null
}

let root: Root
let host: HTMLDivElement
const made: HTMLElement[] = []
function add(html: string): HTMLElement {
  const box = document.createElement('div')
  box.innerHTML = html
  const el = box.firstElementChild as HTMLElement
  document.body.append(el)
  made.push(el)
  return el
}

const render = (...nodes: ReactNode[]) => act(() => root.render(createElement(Fragment, null, ...nodes)))
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })
const running = () => useTourStore.getState().active?.tourId ?? null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  localStorage.clear()
  window.location.hash = '#/'
  useApp.setState({ isPlaying: false })
  useTourStore.setState({ active: null, queue: [], flags: {}, blocks: {} })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  made.splice(0).forEach((el) => el.remove())
  useTourStore.setState({ active: null, queue: [] })
  vi.useRealTimers()
})

describe('auto-start', () => {
  it('opens 500 ms after the screen is ready', () => {
    render(createElement(Trigger, { key: 'h', id: 'home', ready: true }))
    wait(499)
    expect(running()).toBeNull()
    wait(1)
    expect(running()).toBe('home')
  })

  it('waits for the screen to be ready', () => {
    render(createElement(Trigger, { key: 'h', id: 'home', ready: false }))
    wait(2000)
    expect(running()).toBeNull()
    render(createElement(Trigger, { key: 'h', id: 'home', ready: true }))
    wait(500)
    expect(running()).toBe('home')
  })

  it.each([
    [
      'an open dialog',
      () => {
        const el = add('<div aria-modal="true"></div>')
        return () => el.remove()
      },
    ],
    [
      'an open menu',
      () => {
        const el = add('<div role="menu"></div>')
        return () => el.remove()
      },
    ],
    [
      'an open panel',
      () => {
        const el = add('<button aria-expanded="true"></button>')
        return () => el.remove()
      },
    ],
    [
      'text being typed',
      () => {
        const input = add('<input type="text" value="Am" />') as HTMLInputElement
        input.focus()
        return () => input.blur()
      },
    ],
    [
      'the song playing',
      () => {
        useApp.setState({ isPlaying: true })
        return () => useApp.setState({ isPlaying: false })
      },
    ],
    [
      'a hidden page',
      () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
        return () => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      },
    ],
  ] as const)('holds back while %s, then opens ~500 ms after it clears', (_, setup) => {
    const clear = setup()
    render(createElement(Trigger, { key: 'h', id: 'home', ready: true }))
    wait(2000)
    expect(running()).toBeNull()
    clear()
    wait(750)
    expect(running()).toBe('home')
  })

  it('holds back while a recording runs', () => {
    render(createElement(Trigger, { key: 'l', id: 'listen', ready: true, recording: true }))
    wait(2000)
    expect(running()).toBeNull()
    render(createElement(Trigger, { key: 'l', id: 'listen', ready: true, recording: false }))
    wait(500)
    expect(running()).toBe('listen')
  })

  it('an empty, autofocused link field does not hold it back', () => {
    const input = add('<input type="url" />') as HTMLInputElement
    input.focus()
    render(createElement(Trigger, { key: 'h', id: 'home', ready: true }))
    wait(500)
    expect(running()).toBe('home')
  })

  it('a component that blocks (a link on its way) holds it back until it lets go', () => {
    render(createElement(Trigger, { key: 'h', id: 'home', ready: true }), createElement(Block, { key: 'b' }))
    wait(2000)
    expect(running()).toBeNull()
    render(createElement(Trigger, { key: 'h', id: 'home', ready: true }))
    wait(750)
    expect(running()).toBe('home')
  })

  it('never opens a tour this device has seen', () => {
    markTourSeen('home')
    render(createElement(Trigger, { key: 'h', id: 'home', ready: true }))
    wait(3000)
    expect(running()).toBeNull()
  })

  it('two tours due at once: one opens, the other ~500 ms after it closes, and «Пропустити» does not mark it seen', () => {
    render(createElement(Trigger, { key: 'h', id: 'home', ready: true }), createElement(Trigger, { key: 'l', id: 'listen', ready: true }))
    wait(500)
    expect(running()).toBe('home')
    wait(2000)
    expect(running()).toBe('home')
    act(() => closeTour('skip'))
    expect(isTourSeen('home')).toBe(true)
    expect(isTourSeen('listen')).toBe(false)
    wait(250)
    expect(running()).toBeNull()
    wait(750)
    expect(running()).toBe('listen')
  })
})

describe('flags and blocks', () => {
  it('a screen’s flags merge into the store and leave with it', () => {
    render(createElement(Flags, { key: 'f' }))
    expect(useTourStore.getState().flags.libraryEmpty).toBe(true)
    render()
    expect(useTourStore.getState().flags.libraryEmpty).toBeUndefined()
  })

  it('a block is held while its component is mounted', () => {
    render(createElement(Block, { key: 'b' }))
    expect(Object.keys(useTourStore.getState().blocks)).toHaveLength(1)
    render()
    expect(useTourStore.getState().blocks).toEqual({})
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/components/tour`
Expected: FAIL with `Failed to resolve import "./dom"`, `"./tourStore"` and `"./hooks"`

- [ ] **Step 3: Write `dom.ts`**

`frontend/src/components/tour/dom.ts`:

```ts
// The DOM side of the tour that the store and the auto-start need: which anchors are on screen, and what on
// the page holds an automatic start back (an open dialog, menu or panel, typing, a hidden page).
import { isTypingTarget } from '../../hooks/useHotkeys'

/** The first rendered `data-tour="<id>"` (a copy hidden for the other breakpoint has no boxes). */
export function anchorElement(id: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${id}"]`)) {
    if (el.getClientRects().length > 0) return el
  }
  return null
}

export function anchorPresent(id: string): boolean {
  return anchorElement(id) !== null
}

/**
 * Focus is in a text field that has text. An empty field does not count: the home link field is autofocused
 * on desktops and would otherwise hold the Home tour back forever.
 */
export function typingNow(): boolean {
  const el = document.activeElement
  if (!isTypingTarget(el)) return false
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value !== ''
  return true
}

export interface DomBlockers {
  modal: boolean
  menu: boolean
  expanded: boolean
  typing: boolean
  hidden: boolean
}

export function domBlockers(): DomBlockers {
  return {
    modal: document.querySelector('[aria-modal="true"]') !== null,
    menu: document.querySelector('[role="menu"]') !== null,
    expanded: document.querySelector('[aria-expanded="true"]') !== null,
    typing: typingNow(),
    hidden: document.visibilityState === 'hidden',
  }
}

/** Runs once no aria-modal dialog is in the page (a closing Modal keeps it for its exit animation), ≤ 2 s. */
export function whenNoModal(run: () => void, tries = 40): void {
  if (tries <= 0 || !document.querySelector('[aria-modal="true"]')) return run()
  window.setTimeout(() => whenNoModal(run, tries - 1), 50)
}
```

- [ ] **Step 4: Write `tourStore.ts`**

`frontend/src/components/tour/tourStore.ts`:

```ts
// The running tour (not persisted): which tour and step, the tour chained after it, the flags screens report
// and the blocks that hold auto-starts back. Actions wrap the pure step machine (lib/tour/machine.ts) with the
// page: anchors from the DOM, the song paused and following suspended on song pages, the seen flag.
import { create } from 'zustand'
import { parseHash } from '../../hooks/useRoute'
import {
  advance,
  afterClose,
  anchorsGone,
  goBack,
  marksSeen,
  startRun,
  type Advance,
  type CloseReason,
  type StepEnv,
  type TourRun,
} from '../../lib/tour/machine'
import { markTourSeen } from '../../lib/tour/storage'
import { TOURS, type Tour, type TourFlags, type TourId } from '../../lib/tour/tours'
import { reopenTours, tourRouteKey, type StartResult } from '../../lib/tour/trigger'
import { useApp } from '../../store'
import { useChordUi } from '../chords/uiStore'
import { anchorPresent, whenNoModal } from './dom'

export interface ActiveTour {
  tourId: TourId
  run: TourRun
  /** the screen it started on (trigger.ts tourRouteKey) */
  routeKey: string
  /** followPaused before the tour (song pages), restored on close; null elsewhere */
  followPaused: boolean | null
}

interface TourState {
  active: ActiveTour | null
  /** tours chained after the running one (a re-open: Song / Score → Live keys) */
  queue: TourId[]
  flags: TourFlags
  /** components holding auto-starts back (hooks.ts useTourBlock) */
  blocks: Record<string, true>
}

export const useTourStore = create<TourState>()(() => ({ active: null, queue: [], flags: {}, blocks: {} }))

export function tourEnv(): StepEnv {
  return { flags: useTourStore.getState().flags, present: anchorPresent }
}

const currentRoute = () => parseHash(window.location.hash)

export function startTour(tourId: TourId, queue: TourId[] = []): StartResult {
  if (useTourStore.getState().active) return 'busy'
  const run = startRun(TOURS[tourId], tourEnv())
  if (!run) return 'empty'
  const route = currentRoute()
  let followPaused: boolean | null = null
  // a song page: the song stops (and stays paused) and following waits; a recording keeps running
  if (route.name === 'track' || route.name === 'demo') {
    const app = useApp.getState()
    if (app.isPlaying) app.pause()
    const ui = useChordUi.getState()
    followPaused = ui.followPaused
    ui.setFollowPaused(true)
  }
  useTourStore.setState({ active: { tourId, run, routeKey: tourRouteKey(route), followPaused }, queue })
  return 'started'
}

export function closeTour(reason: CloseReason): void {
  const { active, queue } = useTourStore.getState()
  if (!active) return
  if (marksSeen(reason)) markTourSeen(active.tourId)
  if (active.followPaused !== null) useChordUi.getState().setFollowPaused(active.followPaused)
  const after = afterClose(queue, reason)
  useTourStore.setState({ active: null, queue: after.queue })
  if (after.next) startTour(after.next, after.queue)
}

function apply(step: (tour: Tour, run: TourRun, env: StepEnv) => Advance): void {
  const { active } = useTourStore.getState()
  if (!active) return
  const result = step(TOURS[active.tourId], active.run, tourEnv())
  if ('end' in result) closeTour(result.end)
  else useTourStore.setState({ active: { ...active, run: result.run } })
}

export function nextStep(): void {
  apply(advance)
}

/** TourHost: the step's anchors stayed missing for 300 ms. */
export function reportAnchorsGone(): void {
  apply(anchorsGone)
}

export function prevStep(): void {
  const { active } = useTourStore.getState()
  if (!active) return
  const run = goBack(TOURS[active.tourId], active.run, tourEnv())
  if (run) useTourStore.setState({ active: { ...active, run } })
}

/** Leaving the screen closes the tour at once without marking it seen, and drops the chained tours. */
export function closeIfRouteChanged(routeKey: string): void {
  const { active } = useTourStore.getState()
  if (active && active.routeKey !== routeKey) closeTour('route')
}

/** «Інструкція»: the current screen's tour (+ Live keys after «Готово» when its panel is on screen). */
export function startCurrentTour(opts: { afterModal?: boolean } = {}): void {
  const run = () => {
    const ids = reopenTours(currentRoute(), { view: useApp.getState().view, keysPanel: !!useTourStore.getState().flags.keysPanel })
    if (ids.length) startTour(ids[0], ids.slice(1))
  }
  if (opts.afterModal) whenNoModal(run)
  else run()
}
```

- [ ] **Step 5: Write `hooks.ts`**

`frontend/src/components/tour/hooks.ts`:

```ts
// How screens talk to the tour: useTourTrigger (this screen's tour may start by itself once `ready`),
// useTourFlags (facts the step conditions read), useTourBlock (hold every auto-start back for now).
import { useEffect, useId } from 'react'
import { isTourSeen } from '../../lib/tour/storage'
import type { TourFlag, TourFlags, TourId } from '../../lib/tour/tours'
import { createAutoStart, gateOpen } from '../../lib/tour/trigger'
import { useApp } from '../../store'
import { domBlockers } from './dom'
import { startTour, useTourStore } from './tourStore'

/** How often a pending auto-start looks at the page (dialogs, menus, focus change without React knowing). */
export const CHECK_MS = 250

/** The tour starts ~500 ms after `ready` and a quiet page, once per device, never while another runs. */
export function useTourTrigger(tourId: TourId, ready: boolean, recording = false): void {
  useEffect(() => {
    if (!ready || isTourSeen(tourId)) return
    const auto = createAutoStart(() => startTour(tourId))
    const check = () => {
      const tour = useTourStore.getState()
      auto.update(
        gateOpen({
          seen: isTourSeen(tourId),
          ready,
          running: tour.active !== null,
          blocked: Object.keys(tour.blocks).length > 0,
          playing: useApp.getState().isPlaying,
          recording,
          ...domBlockers(),
        }),
      )
    }
    check()
    const id = window.setInterval(check, CHECK_MS)
    return () => {
      window.clearInterval(id)
      auto.dispose()
    }
  }, [tourId, ready, recording])
}

/** Reports flags while the component is mounted; they are removed with it. */
export function useTourFlags(flags: TourFlags): void {
  const json = JSON.stringify(flags)
  useEffect(() => {
    const own = JSON.parse(json) as TourFlags
    useTourStore.setState((s) => ({ flags: { ...s.flags, ...own } }))
    return () =>
      useTourStore.setState((s) => {
        const flags = { ...s.flags }
        for (const key of Object.keys(own)) delete flags[key as TourFlag]
        return { flags }
      })
  }, [json])
}

/** While `blocked`, no tour starts by itself (a link on its way, a file uploading, text in the link field). */
export function useTourBlock(blocked: boolean): void {
  const id = useId()
  useEffect(() => {
    if (!blocked) return
    useTourStore.setState((s) => ({ blocks: { ...s.blocks, [id]: true } }))
    return () =>
      useTourStore.setState((s) => {
        const blocks = { ...s.blocks }
        delete blocks[id]
        return { blocks }
      })
  }, [id, blocked])
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/tour`
Expected: PASS

- [ ] **Step 7: Run the full checks**

Run: `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/tour/dom.ts frontend/src/components/tour/dom.test.ts frontend/src/components/tour/tourStore.ts frontend/src/components/tour/tourStore.test.ts frontend/src/components/tour/hooks.ts frontend/src/components/tour/hooks.test.ts
git commit -m "Tour: store, auto-start hooks, pause + follow on song pages, route change, «Інструкція» chain

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Bubble placement and scroll arithmetic

**Files:**
- Create: `frontend/src/lib/tour/placement.ts`
- Test: `frontend/src/lib/tour/placement.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface Rect { left: number; top: number; right: number; bottom: number }`
  - `export interface View { width: number; height: number; top: number; bottom: number }` (`top` = below the sticky header / stuck toolbar, `bottom` = above the player bar)
  - `export interface Size { width: number; height: number }`; `export interface Placement { left: number; top: number; width: number; maxHeight: number }`
  - `export const MARGIN = 8`, `GAP = 12`, `PAD = 6`, `PHONE_GUTTER = 16`
  - `export function unionRect(rects: readonly Rect[]): Rect | null`; `export function intersectRect(a: Rect, b: Rect): Rect | null`
  - `export function nearestDelta(start: number, end: number, viewStart: number, viewEnd: number): number`
  - `export function scrollDelta(spot: Rect, band: { top: number; bottom: number }): number`
  - `export function freeBand(view: View, phone: boolean, bubbleHeight: number): { top: number; bottom: number }`
  - `export function placeBubble(input: { spot: Rect | null; size: Size; view: View; phone: boolean; avoid: readonly Rect[] }): Placement`

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/tour/placement.test.ts`:

```ts
// Where the bubble goes: below or above the spotlight on a desktop, docked at the bottom on phones and for
// spotlights taller than the free area, never over the player bar or the floating video, always on screen.
import { describe, expect, it } from 'vitest'
import { freeBand, intersectRect, MARGIN, nearestDelta, placeBubble, scrollDelta, unionRect, type Rect, type View } from './placement'

const DESK: View = { width: 1280, height: 800, top: 56, bottom: 704 } // 96 px player bar
const PHONE: View = { width: 375, height: 812, top: 56, bottom: 702 } // 110 px player bar
const SIZE = { width: 352, height: 180 }
const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom })
const place = (spot: Rect | null, view = DESK, phone = false, avoid: Rect[] = [], size = SIZE) => placeBubble({ spot, size, view, phone, avoid })

describe('desktop', () => {
  it('goes below the spotlight when it fits, centred on it and clamped to the viewport', () => {
    expect(place(rect(100, 100, 300, 140))).toEqual({ left: 24, top: 158, width: 352, maxHeight: 704 - 2 * MARGIN })
    expect(place(rect(1250, 100, 1270, 140)).left).toBe(1280 - 352 - MARGIN)
  })

  it('goes above when there is no room below', () => {
    expect(place(rect(500, 600, 700, 650)).top).toBe(600 - 6 - 12 - 180)
  })

  it('docks at the bottom of the free area when the spotlight is taller than it', () => {
    expect(place(rect(200, 60, 1000, 900)).top).toBe(704 - MARGIN - 180)
  })

  it('a centred card sits in the middle, above the player bar', () => {
    expect(place(null)).toEqual({ left: 464, top: 310, width: 352, maxHeight: 704 - 2 * MARGIN })
  })

  it('never overlaps the player bar: its bottom edge stays ≥ 8 px above it', () => {
    for (let top = 0; top < 800; top += 37) {
      const p = place(rect(400, top, 600, top + 40))
      expect(p.top + SIZE.height).toBeLessThanOrEqual(DESK.bottom - MARGIN)
    }
  })

  it('picks the side clear of the floating video, or moves left of it', () => {
    const video = rect(900, 450, 1264, 690)
    expect(place(rect(1000, 380, 1200, 420), DESK, false, [video]).top).toBe(380 - 6 - 12 - 180)
    const tall = place(rect(1000, 60, 1200, 900), DESK, false, [video])
    expect(tall.left + 352).toBeLessThanOrEqual(900 - MARGIN)
  })
})

describe('phones', () => {
  it('always docks at the bottom, full width with 16 px gutters, 8 px above the player bar', () => {
    for (const spot of [null, rect(16, 80, 200, 120), rect(16, 600, 200, 640)]) {
      expect(place(spot, PHONE, true)).toEqual({ left: 16, top: 702 - MARGIN - 180, width: 343, maxHeight: 702 - 2 * MARGIN })
    }
  })

  it('a long bubble on a short screen stays on screen and gets a max height', () => {
    const landscape: View = { width: 667, height: 375, top: 56, bottom: 285 }
    const p = place(null, landscape, true, [], { width: 352, height: 400 })
    expect(p.top).toBe(MARGIN)
    expect(p.maxHeight).toBe(285 - 2 * MARGIN)
    expect(p.top + Math.min(400, p.maxHeight)).toBeLessThanOrEqual(285 - MARGIN)
    // 667 px is wider than PHONE_QUERY (max-width: 639px): in the app this screen takes the desktop branch
    expect(place(null, landscape, false, [], { width: 352, height: 400 })).toEqual({ left: 157.5, top: MARGIN, width: 352, maxHeight: 285 - 2 * MARGIN })
    expect(place(rect(16, 100, 300, 140), landscape, false, [], { width: 352, height: 400 }).top).toBe(MARGIN)
  })
})

describe('scrolling', () => {
  it('leaves a spotlight that is in the free band alone, centres one that is not', () => {
    const band = { top: 64, bottom: 696 }
    expect(scrollDelta(rect(0, 200, 10, 300), band)).toBe(0)
    expect(scrollDelta(rect(0, 900, 10, 1000), band)).toBe(950 - 380)
    expect(scrollDelta(rect(0, -300, 10, -200), band)).toBe(-250 - 380)
  })

  it('brings a spotlight taller than the band to just below the header', () => {
    expect(scrollDelta(rect(0, 400, 10, 1400), { top: 64, bottom: 696 })).toBe(400 - 64)
  })

  it('the free band ends above the docked bubble on phones', () => {
    expect(freeBand(DESK, false, 180)).toEqual({ top: 64, bottom: 696 })
    expect(freeBand(PHONE, true, 180)).toEqual({ top: 64, bottom: 702 - 8 - 180 - 8 })
  })

  it('sideways: the nearest edge, the start when it does not fit', () => {
    expect(nearestDelta(10, 50, 0, 100)).toBe(0)
    expect(nearestDelta(80, 140, 0, 100)).toBe(40)
    expect(nearestDelta(-30, 10, 0, 100)).toBe(-30)
    expect(nearestDelta(20, 180, 0, 100)).toBe(20)
  })
})

describe('rects', () => {
  it('union and intersection', () => {
    expect(unionRect([])).toBeNull()
    expect(unionRect([rect(0, 0, 10, 10), rect(5, 20, 30, 25)])).toEqual(rect(0, 0, 30, 25))
    expect(intersectRect(rect(0, 0, 10, 10), rect(5, 5, 20, 20))).toEqual(rect(5, 5, 10, 10))
    expect(intersectRect(rect(0, 0, 10, 10), rect(10, 0, 20, 10))).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/lib/tour/placement.test.ts`
Expected: FAIL with `Error: Cannot find module './placement' imported from …`

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/tour/placement.ts`:

```ts
// Where the tour's bubble goes and how far to scroll (spec §2 "Placement"), in viewport pixels. Desktop: below
// or above the spotlight, whichever fits, clamped to the viewport, never over the player bar or the floating
// video; a spotlight taller than the free area docks the bubble at its bottom. Phones: the bubble always docks
// at the bottom, above the player bar. Pure; components/tour/geometry.ts measures the page.

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** The viewport; `top` = below the sticky header (and a stuck toolbar), `bottom` = above the player bar. */
export interface View {
  width: number
  height: number
  top: number
  bottom: number
}

export interface Size {
  width: number
  height: number
}

export interface Placement {
  left: number
  top: number
  width: number
  /** the bubble scrolls inside beyond this */
  maxHeight: number
}

export const MARGIN = 8
/** between the cut-out and the bubble */
export const GAP = 12
/** cut-out padding around the spotlight */
export const PAD = 6
export const PHONE_GUTTER = 16

export function unionRect(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null
  return {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  }
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const r = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) }
  return r.right > r.left && r.bottom > r.top ? r : null
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/** Scroll needed to show [start, end] inside [viewStart, viewEnd] ("nearest"; the start when it is too long). */
export function nearestDelta(start: number, end: number, viewStart: number, viewEnd: number): number {
  if (start >= viewStart && end <= viewEnd) return 0
  if (start < viewStart || end - start > viewEnd - viewStart) return start - viewStart
  return end - viewEnd
}

/** Page scroll that puts the spotlight in the band: untouched if inside, centred if not, top-aligned if taller. */
export function scrollDelta(spot: Rect, band: { top: number; bottom: number }): number {
  if (spot.bottom - spot.top >= band.bottom - band.top) return spot.top - band.top
  if (spot.top >= band.top && spot.bottom <= band.bottom) return 0
  return (spot.top + spot.bottom) / 2 - (band.top + band.bottom) / 2
}

/** Where a spotlight may sit: below the header, above the player bar (and above the docked bubble on phones). */
export function freeBand(view: View, phone: boolean, bubbleHeight: number): { top: number; bottom: number } {
  const top = view.top + MARGIN
  const bottom = view.bottom - MARGIN - (phone ? bubbleHeight + MARGIN : 0)
  return { top, bottom: Math.max(top, bottom) }
}

export function placeBubble({
  spot,
  size,
  view,
  phone,
  avoid,
}: {
  spot: Rect | null
  size: Size
  view: View
  phone: boolean
  avoid: readonly Rect[]
}): Placement {
  const floor = view.bottom - MARGIN
  const maxHeight = Math.max(0, floor - MARGIN)
  const height = Math.min(size.height, maxHeight)
  const dockTop = Math.max(MARGIN, floor - height)
  if (phone) return { left: PHONE_GUTTER, top: dockTop, width: Math.max(0, view.width - 2 * PHONE_GUTTER), maxHeight }

  const width = Math.min(size.width, view.width - 2 * MARGIN)
  const clampX = (x: number) => Math.max(MARGIN, Math.min(x, view.width - width - MARGIN))
  const at = (left: number, top: number): Placement => ({ left, top, width, maxHeight })
  const box = (p: Placement): Rect => ({ left: p.left, top: p.top, right: p.left + width, bottom: p.top + height })

  const options: Placement[] = []
  if (!spot) {
    options.push(at(clampX((view.width - width) / 2), Math.max(MARGIN, Math.min((view.height - height) / 2, floor - height))))
  } else {
    const x = clampX((spot.left + spot.right) / 2 - width / 2)
    const below = spot.bottom + PAD + GAP
    const above = spot.top - PAD - GAP - height
    if (below + height <= floor) options.push(at(x, below))
    if (above >= MARGIN && above + height <= floor) options.push(at(x, above))
    options.push(at(x, dockTop))
  }
  const clear = options.find((p) => !avoid.some((a) => overlaps(box(p), a)))
  if (clear) return clear
  // every option covers the floating video: keep the first, moved to its left
  const first = options[0]
  const video = avoid.find((a) => overlaps(box(first), a))!
  return { ...first, left: Math.max(MARGIN, Math.min(first.left, video.left - MARGIN - width)) }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && npx vitest run src/lib/tour/placement.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full checks**

Run: `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/tour/placement.ts frontend/src/lib/tour/placement.test.ts
git commit -m "Tour: bubble placement (desktop, phone dock, tall spotlights, player bar, floating video) and scroll math

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: TourHost — overlay, cut-out, bubble, keys and focus

**Files:**
- Create: `frontend/src/components/tour/geometry.ts`, `frontend/src/components/tour/ChordMarks.tsx`, `frontend/src/components/tour/TourHost.tsx`
- Modify: `frontend/src/App.tsx:14` (import) and `:89` (mount after `<Toaster />`); `frontend/src/components/player/VideoPanel.tsx:137-151` (the `motion.section`); `frontend/src/lib/auth.ts:35-36, :223-224` (the dev-only hot-reload guard)
- Test: `frontend/src/components/tour/TourHost.test.ts`

**Interfaces:**
- Consumes: `useMediaQuery`, `useIsDesktopPointer`, `useCanListenInTab` (`hooks/useMediaQuery.ts:4,21,26`); `useRoute` (`hooks/useRoute.ts:77`); `useT` (`i18n/index.ts:36`); `useCloudInvite` (`account/cloudInvite.ts:8`); `Button` (`ui/IconButton.tsx:61`, forwardRef); `Kbd` (`ui/Kbd.tsx:4`); `ChordName` (`chords/ChordName.tsx:9`); `chordTone` (`lib/music/color.ts:21`); `parseChord` (`lib/music/chord.ts:133`); Task 2 `TOURS`, `TourStep`, `titleKey`, `textKey`; Task 3 `counter`; Task 4 `tourRouteKey`; Task 5 `anchorElement`, `useTourStore`, `ActiveTour`, `tourEnv`, `nextStep`, `prevStep`, `closeTour`, `reportAnchorsGone`, `closeIfRouteChanged`, `useTourFlags`; Task 6 `placeBubble`, `freeBand`, `scrollDelta`, `nearestDelta`, `unionRect`, `intersectRect`, `PAD`, `Rect`, `View`, `Placement`.
- Produces:
  - `geometry.ts`: `export const PHONE_QUERY = '(max-width: 639px)'`; `export const GONE_MS = 300`; `export interface Geo { present: boolean; spot: Rect | null; place: Placement }`; `export function stepElements(step: TourStep): HTMLElement[]`; `export function measureStep(step: TourStep, bubble: HTMLElement | null, phone: boolean): Geo`; `export function sameGeo(a: Geo, b: Geo): boolean`; `export function scrollToStep(step: TourStep, opts: { phone: boolean; reduce: boolean; bubbleHeight: number }): void`
  - `ChordMarks.tsx`: `export function ChordMarks({ className }: { className?: string })`
  - `TourHost.tsx`: `export function TourHost()` (no props; mounted once in `App.tsx`)
  - Global flags reported by `TourHost`: `phone`, `touch`, `demo`, `cloudInvite`, `canListenInTab`.

- [ ] **Step 1: Write the failing test**

`frontend/src/components/tour/TourHost.test.ts`:

```ts
// @vitest-environment jsdom
// The tour on screen: a modal dialog with the step's title, text and counter; → ← Enter Space Esc (also with a
// Floating panel open), Tab kept inside the bubble, focus start and restore, the layer swallowing presses,
// key auto-repeat ignored, the chord-marks card and key chips, an anchor gone only after 300 ms, smooth vs
// reduced motion, and a route change closing it unseen.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isTourSeen } from '../../lib/tour/storage'
import { useApp } from '../../store'
import { Floating } from '../chords/ui/Floating'
import { TourHost } from './TourHost'
import { startTour, useTourStore } from './tourStore'

const RECT = { x: 100, y: 100, left: 100, top: 100, right: 220, bottom: 140, width: 120, height: 40, toJSON: () => ({}) } as DOMRect
const made: HTMLElement[] = []
function anchor(id: string): HTMLElement {
  const el = document.createElement('button')
  el.dataset.tour = id
  el.textContent = id
  el.getClientRects = () => [RECT] as unknown as DOMRectList
  el.getBoundingClientRect = () => RECT
  document.body.append(el)
  made.push(el)
  return el
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  window.location.hash = '#/'
  // a desktop: a fine pointer, wider than 640 px
  window.matchMedia = ((query: string) => ({
    matches: query === '(hover: hover) and (pointer: fine)',
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
  window.scrollBy = vi.fn() as unknown as typeof window.scrollBy
  useApp.setState({ lang: 'uk', isPlaying: false, controller: null })
  useTourStore.setState({ active: null, queue: [], flags: {}, blocks: {} })
  for (const id of ['home.input', 'home.sources', 'header.mode']) anchor(id)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(TourHost)))
})

afterEach(() => {
  act(() => useTourStore.setState({ active: null, queue: [] }))
  act(() => root.unmount())
  host.remove()
  made.splice(0).forEach((el) => el.remove())
})

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')
const title = () => dialog()?.querySelector('h2')?.textContent ?? null
const buttons = () => [...(dialog()?.querySelectorAll('button') ?? [])].map((b) => b.textContent)
const counterText = () => [...(dialog()?.querySelectorAll('span') ?? [])].map((s) => s.textContent).find((s) => /^\d+ \/ \d+$/.test(s ?? ''))
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    ;(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
const begin = (id: Parameters<typeof startTour>[0] = 'home') =>
  act(() => {
    startTour(id)
  })
const go = (hash: string) =>
  act(() => {
    window.location.hash = hash
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })

describe('the bubble', () => {
  it('is a modal dialog with the title, the text in a live region and the counter; focus starts on «Далі»', () => {
    begin()
    expect(dialog()).not.toBeNull()
    expect(title()).toBe('Привіт! Це Chords Listener')
    expect(dialog()!.querySelector('[aria-live="polite"] p')?.textContent).toContain('акорди до будь-якої пісні')
    expect(counterText()).toBe('1 / 4') // welcome, link field, sources, mode chip (the rest are left out here)
    expect(buttons()).toEqual(['Пропустити', 'Далі'])
    expect(document.activeElement?.textContent).toBe('Далі')
  })

  it('→ ← Enter and Space move between steps; «Готово» on the last one closes and marks it seen', () => {
    begin()
    press('ArrowRight')
    expect(title()).toBe('Посилання або файл')
    expect(counterText()).toBe('2 / 4')
    expect(buttons()).toEqual(['Пропустити', 'Назад', 'Далі'])
    press('ArrowLeft')
    expect(title()).toBe('Привіт! Це Chords Listener')
    press('Enter')
    expect(title()).toBe('Посилання або файл')
    press(' ')
    expect(title()).toBe('Файл або «Слухати»')
    press('ArrowRight')
    expect(buttons().at(-1)).toBe('Готово')
    press('Enter')
    expect(dialog()).toBeNull()
    expect(isTourSeen('home')).toBe(true)
  })

  it('«Пропустити» closes it and marks it seen', () => {
    begin()
    act(() => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Пропустити')!.click())
    expect(dialog()).toBeNull()
    expect(isTourSeen('home')).toBe(true)
  })

  it('Esc closes it even with a Floating panel open, and the panel does not see the key', () => {
    const onClose = vi.fn()
    const panelHost = document.createElement('div')
    document.body.append(panelHost)
    const panelRoot = createRoot(panelHost)
    // FloatingProps.children is required, so createElement needs it in the props
    // oxlint-disable-next-line react/no-children-prop
    act(() => panelRoot.render(createElement(Floating, { anchor: made[0], open: true, onClose, children: 'panel' })))
    begin()
    press('Escape')
    expect(dialog()).toBeNull()
    expect(isTourSeen('home')).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    act(() => panelRoot.unmount())
    panelHost.remove()
  })

  it('keeps Tab inside the bubble', () => {
    begin()
    press('ArrowRight')
    expect(document.activeElement?.textContent).toBe('Далі')
    press('Tab')
    expect(document.activeElement?.textContent).toBe('Пропустити')
    press('Tab', { shiftKey: true })
    expect(document.activeElement?.textContent).toBe('Далі')
  })

  it('returns focus to where it was when the tour closes', () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    made.push(outside)
    outside.focus()
    begin()
    expect(document.activeElement).not.toBe(outside)
    press('Escape')
    expect(document.activeElement).toBe(outside)
  })

  it('the layer swallows presses on the page around the bubble', () => {
    begin()
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
    act(() => {
      dialog()!.dispatchEvent(down)
    })
    expect(down.defaultPrevented).toBe(true)
    expect(dialog()!.className).toContain('fixed inset-0 z-[75]')
  })

  it('a held key does not race through the tour', () => {
    begin()
    for (let i = 0; i < 5; i++) press('ArrowRight', { repeat: true })
    press('Enter', { repeat: true })
    expect(counterText()).toBe('1 / 4')
  })
})

describe('content', () => {
  it('Song step 7 is a centred card with the chord marks (an unsure example underlined)', () => {
    go('#/demo')
    begin('song')
    expect(title()).toBe('Що означають позначки')
    expect(dialog()!.querySelector('.cw-lowconf')).not.toBeNull()
    expect(dialog()!.textContent).toContain('після риски — нота в басі')
    expect(buttons().at(-1)).toBe('Готово')
  })

  it('shows key chips with a fine pointer and none on touch', () => {
    go('#/demo')
    anchor('song.instrument')
    begin('song')
    expect(dialog()!.querySelector('kbd')?.textContent).toBe('I')
    act(() => useTourStore.setState((s) => ({ flags: { ...s.flags, touch: true } })))
    expect(dialog()!.querySelector('kbd')).toBeNull()
  })
})

describe('anchors and motion', () => {
  it('an anchor counts as gone only if it is still missing 300 ms after it vanished', async () => {
    // the MutationObserver callback is a microtask: the async advance runs it before the timers
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    try {
      begin()
      press('ArrowRight')
      const input = made.find((el) => el.dataset.tour === 'home.input')!
      // a re-render that swaps the anchor out and back: the step stays
      input.remove()
      await act(() => vi.advanceTimersByTimeAsync(200))
      document.body.append(input)
      await act(() => vi.advanceTimersByTimeAsync(400))
      expect(title()).toBe('Посилання або файл')
      // gone for good: the tour moves on to the next step
      input.remove()
      await act(() => vi.advanceTimersByTimeAsync(350))
      expect(title()).toBe('Файл або «Слухати»')
    } finally {
      vi.useRealTimers()
    }
  })

  it('scrolls a step into view smoothly and animates the cut-out and the bubble', () => {
    made[0].getBoundingClientRect = () => ({ ...RECT, top: 2000, bottom: 2040, y: 2000 })
    begin()
    press('ArrowRight')
    expect(window.scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'smooth' }))
    expect(dialog()!.querySelector('h2')!.closest('div.absolute')!.className).toContain('transition-[')
  })

  it('with prefers-reduced-motion: no smooth scrolling, no transitions', () => {
    act(() => root.unmount())
    window.matchMedia = ((query: string) => ({
      matches: query === '(hover: hover) and (pointer: fine)' || query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia
    root = createRoot(host)
    act(() => root.render(createElement(TourHost)))
    made[0].getBoundingClientRect = () => ({ ...RECT, top: 2000, bottom: 2040, y: 2000 })
    begin()
    press('ArrowRight')
    expect(window.scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'auto' }))
    expect(dialog()!.querySelector('h2')!.closest('div.absolute')!.className).not.toContain('transition-[')
  })
})

it('leaving the screen closes the tour at once without marking it seen', () => {
  begin()
  go('#/listen')
  expect(dialog()).toBeNull()
  expect(isTourSeen('home')).toBe(false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/components/tour/TourHost.test.ts`
Expected: FAIL with `Failed to resolve import "./TourHost"`

- [ ] **Step 3: Write `geometry.ts`**

`frontend/src/components/tour/geometry.ts`:

```ts
// Where the tour's spotlight and bubble go on the real page: anchor boxes clipped to their scroller, the
// viewport and the header / player bar, and scrolling a step's anchors into view on both axes. The arithmetic
// is in lib/tour/placement.ts.
import { freeBand, intersectRect, nearestDelta, placeBubble, scrollDelta, unionRect, type Placement, type Rect, type View } from '../../lib/tour/placement'
import type { TourStep } from '../../lib/tour/tours'
import { anchorElement } from './dom'

/** below Tailwind's `sm`: the bubble docks at the bottom */
export const PHONE_QUERY = '(max-width: 639px)'
/** an anchor counts as gone only if it is still missing this long after it vanished */
export const GONE_MS = 300
/** the bubble's size before it has been measured */
const FALLBACK = { width: 352, height: 180 }

export interface Geo {
  /** at least one of the step's anchors is rendered */
  present: boolean
  /** the visible union of the anchors (null: a centred card) */
  spot: Rect | null
  place: Placement
}

const box = (r: DOMRect): Rect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })

export function stepElements(step: TourStep): HTMLElement[] {
  return step.anchors.map(anchorElement).filter((el): el is HTMLElement => el !== null)
}

/** The anchor's box; `data-tour-until="<selector>"` ends it at its first match (a heading with its first row). */
function anchorRect(el: HTMLElement): Rect {
  const r = box(el.getBoundingClientRect())
  const until = el.dataset.tourUntil
  const stop = until ? el.querySelector(until) : null
  if (stop && stop.getClientRects().length) r.bottom = Math.min(r.bottom, stop.getBoundingClientRect().bottom)
  return r
}

/** Inside the fixed player bar, or a sticky bar that is stuck right now (the header, the toolbar). */
function inStickyOrFixed(el: HTMLElement): boolean {
  for (let p: HTMLElement | null = el; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p)
    if (cs.position === 'fixed') return true
    if (cs.position === 'sticky') {
      const top = parseFloat(cs.top)
      if (Number.isFinite(top) && p.getBoundingClientRect().top <= top + 1) return true
    }
  }
  return false
}

function scrollingAncestor(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p)
    if (/(auto|scroll)/.test(cs.overflowX + cs.overflowY)) return p
  }
  return null
}

function horizontalScroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowX
    if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth) return p
  }
  return null
}

function playerHeight(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--player-h'))
  return Number.isFinite(v) ? v : 0
}

/** The bottom of the sticky app header, a video docked under it, or the toolbar while it is stuck. */
function topInset(): number {
  let inset = document.querySelector('header.sticky')?.getBoundingClientRect().bottom ?? 0
  for (const el of document.querySelectorAll('[data-tour-top]')) inset = Math.max(inset, el.getBoundingClientRect().bottom)
  const bar = document.querySelector('[data-cw-toolbar]')?.getBoundingClientRect()
  if (bar && bar.top <= inset + 1 && bar.bottom > inset) inset = bar.bottom
  return Math.max(0, inset)
}

function currentView(): View {
  const height = window.innerHeight
  return { width: document.documentElement.clientWidth || window.innerWidth, height, top: topInset(), bottom: height - playerHeight() }
}

function visibleRect(el: HTMLElement, view: View): Rect | null {
  let r: Rect | null = anchorRect(el)
  const sc = scrollingAncestor(el)
  if (sc) r = intersectRect(r, box(sc.getBoundingClientRect()))
  // in-flow anchors are clipped to the free area; pinned ones (header, player bar) only to the viewport
  const clip: Rect = inStickyOrFixed(el)
    ? { left: 0, top: 0, right: view.width, bottom: view.height }
    : { left: 0, top: view.top, right: view.width, bottom: view.bottom }
  return r && intersectRect(r, clip)
}

function avoidRects(): Rect[] {
  return [...document.querySelectorAll<HTMLElement>('[data-tour-avoid]')]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => box(el.getBoundingClientRect()))
}

export function measureStep(step: TourStep, bubble: HTMLElement | null, phone: boolean): Geo {
  const view = currentView()
  const els = stepElements(step)
  const spot = unionRect(els.map((el) => visibleRect(el, view)).filter((r): r is Rect => r !== null))
  const size = bubble && bubble.offsetWidth ? { width: bubble.offsetWidth, height: bubble.offsetHeight } : FALLBACK
  return { present: els.length > 0, spot, place: placeBubble({ spot, size, view, phone, avoid: avoidRects() }) }
}

export function sameGeo(a: Geo, b: Geo): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Before a step: its anchors into view — sideways inside their own scrollers, then the page (if not pinned):
 *  centred in the free band, except `scrollTop` steps, which move only as far as needed. */
export function scrollToStep(step: TourStep, opts: { phone: boolean; reduce: boolean; bubbleHeight: number }): void {
  const behavior: ScrollBehavior = opts.reduce ? 'auto' : 'smooth'
  // the hero's key and BPM badges exist only while the hero is on screen
  if (step.scrollTop && window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'auto' })
  const els = stepElements(step)
  const groups = new Map<HTMLElement, Rect[]>()
  for (const el of els) {
    const sc = horizontalScroller(el)
    if (sc) groups.set(sc, [...(groups.get(sc) ?? []), anchorRect(el)])
  }
  for (const [sc, rects] of groups) {
    const u = unionRect(rects)!
    const c = sc.getBoundingClientRect()
    const dx = nearestDelta(u.left, u.right, c.left, c.right)
    if (dx) sc.scrollBy({ left: dx, behavior })
  }
  const target = unionRect(els.filter((el) => !inStickyOrFixed(el)).map(anchorRect))
  if (!target) return
  const band = freeBand(currentView(), opts.phone, opts.bubbleHeight)
  // Song steps 1–4 scroll as little as possible: centring the toolbar under the live-piano panel would scroll
  // the hero away, and the toolbar then swaps the key badge (song.key) for the mini "now → next"
  const dy = step.scrollTop ? nearestDelta(target.top, target.bottom, band.top, band.bottom) : scrollDelta(target, band)
  if (Math.abs(dy) > 1) window.scrollBy({ top: dy, behavior })
}
```

- [ ] **Step 4: Write `ChordMarks.tsx`**

`frontend/src/components/tour/ChordMarks.tsx`:

```tsx
// The chord-marks cheat sheet of the Song tour (step 7): real ChordName examples in their chord colours
// (chordTone), an unsure one with the sheet's dotted underline, "no chord", a slash bass and the suffixes.
import clsx from 'clsx'
import { useT } from '../../i18n'
import { parseChord } from '../../lib/music/chord'
import { chordTone } from '../../lib/music/color'
import { ChordName } from '../chords/ChordName'

const ROWS: Array<{ labels: string[]; text: string; unsure?: boolean }> = [
  { labels: ['C', 'A', 'Am'], text: 'tour.marks.colour' },
  { labels: ['G'], text: 'tour.marks.unsure', unsure: true },
  { labels: ['N'], text: 'tour.marks.none' },
  { labels: ['G/B'], text: 'tour.marks.bass' },
  { labels: ['Am'], text: 'tour.marks.m' },
  { labels: ['G7'], text: 'tour.marks.7' },
  { labels: ['Cmaj7'], text: 'tour.marks.maj7' },
  { labels: ['Dsus4'], text: 'tour.marks.sus' },
  { labels: ['Bdim'], text: 'tour.marks.dim' },
  { labels: ['Caug'], text: 'tour.marks.aug' },
  { labels: ['Cadd9'], text: 'tour.marks.add9' },
]

function Mark({ label, unsure }: { label: string; unsure?: boolean }) {
  const p = parseChord(label)
  return (
    <span className="font-display text-base font-semibold" style={{ color: chordTone(p?.rootPc ?? null, p?.quality ?? null) }}>
      <ChordName label={label} className={clsx(unsure && 'cw-lowconf')} />
    </span>
  )
}

export function ChordMarks({ className }: { className?: string }) {
  const t = useT()
  return (
    <dl className={clsx('grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-sm', className)}>
      {ROWS.map((row) => (
        <div key={row.text} className="contents">
          <dt className="flex items-baseline gap-2">
            {row.labels.map((label) => (
              <Mark key={label} label={label} unsure={row.unsure} />
            ))}
          </dt>
          <dd className="text-muted">{t(row.text)}</dd>
        </div>
      ))}
    </dl>
  )
}
```

- [ ] **Step 5: Write `TourHost.tsx`**

`frontend/src/components/tour/TourHost.tsx`:

```tsx
// The guided tour on screen (docs/superpowers/specs/2026-10-06-onboarding-tour-design.md §2): one full-screen
// layer at z-[75] that dims the page around the step's anchors, swallows every press, and shows the bubble.
// It is role="dialog" + aria-modal, which mutes the app's hotkeys (their modalOpen() checks); its own keys run
// in a capture listener on window, ahead of Floating / Modal / Menu. Mounted once in App; renders nothing
// while no tour runs. Step logic: lib/tour; the running tour: tourStore.
import clsx from 'clsx'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCanListenInTab, useIsDesktopPointer, useMediaQuery } from '../../hooks/useMediaQuery'
import { useRoute } from '../../hooks/useRoute'
import { useT } from '../../i18n'
import { counter } from '../../lib/tour/machine'
import { PAD } from '../../lib/tour/placement'
import { textKey, titleKey, TOURS } from '../../lib/tour/tours'
import { tourRouteKey } from '../../lib/tour/trigger'
import { useCloudInvite } from '../account/cloudInvite'
import { Button } from '../ui/IconButton'
import { Kbd } from '../ui/Kbd'
import { ChordMarks } from './ChordMarks'
import { GONE_MS, measureStep, PHONE_QUERY, sameGeo, scrollToStep, stepElements, type Geo } from './geometry'
import { useTourFlags } from './hooks'
import { closeIfRouteChanged, closeTour, nextStep, prevStep, reportAnchorsGone, tourEnv, useTourStore, type ActiveTour } from './tourStore'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

export function TourHost() {
  const route = useRoute()
  const phone = useMediaQuery(PHONE_QUERY)
  const touch = !useIsDesktopPointer()
  const cloudInvite = useCloudInvite()
  const canListenInTab = useCanListenInTab()
  useTourFlags({ phone, touch, demo: route.name === 'demo', cloudInvite, canListenInTab })

  // leaving the screen (Back, a link, a pasted or dropped file that starts a song) ends the tour, unseen
  const routeKey = tourRouteKey(route)
  useEffect(() => {
    closeIfRouteChanged(routeKey)
  }, [routeKey])

  const active = useTourStore((s) => s.active)
  if (!active) return null
  return createPortal(<TourLayer key={active.tourId} active={active} phone={phone} />, document.body)
}

function TourLayer({ active, phone }: { active: ActiveTour; phone: boolean }) {
  const t = useT()
  const flags = useTourStore((s) => s.flags)
  const reduce = useMediaQuery(REDUCED_MOTION)
  const titleId = useId()
  const textId = useId()
  const bubble = useRef<HTMLDivElement>(null)
  const next = useRef<HTMLButtonElement>(null)
  const [geo, setGeo] = useState<Geo | null>(null)

  const tour = TOURS[active.tourId]
  const step = tour.steps[active.run.index]
  const pos = counter(tour, active.run, tourEnv())
  const first = useRef(pos.first)
  useEffect(() => {
    first.current = pos.first
  })

  // focus goes back to where it was when the tour closes
  useLayoutEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      if (prev?.isConnected) prev.focus({ preventScroll: true })
    }
  }, [])

  // each step: its anchors into view, then focus on «Далі»
  useEffect(() => {
    scrollToStep(step, { phone, reduce, bubbleHeight: bubble.current?.offsetHeight ?? 0 })
    next.current?.focus({ preventScroll: true })
  }, [step, phone, reduce])

  // the spotlight follows scrolling (inner scrollers too), resizing and the anchors, at most once a frame;
  // a step's anchors count as gone only after GONE_MS
  useEffect(() => {
    let raf = 0
    let gone: number | undefined
    const anchored = step.anchors.length > 0 && !step.centre
    const update = () => {
      raf = 0
      const g = measureStep(step, bubble.current, phone)
      setGeo((prev) => (prev && sameGeo(prev, g) ? prev : g))
      if (!anchored || g.present) {
        window.clearTimeout(gone)
        gone = undefined
      } else if (gone === undefined) {
        gone = window.setTimeout(() => {
          gone = undefined
          if (!measureStep(step, bubble.current, phone).present) reportAnchorsGone()
        }, GONE_MS)
      }
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    ro?.observe(document.body)
    for (const el of stepElements(step)) ro?.observe(el)
    if (bubble.current) ro?.observe(bubble.current)
    const mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    window.addEventListener('orientationchange', schedule)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(gone)
      ro?.disconnect()
      mo.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('orientationchange', schedule)
    }
  }, [step, phone])

  // → next, ← back, Enter / Space press the focused button, Esc closes, Tab stays in the bubble; held keys
  // (auto-repeat) are swallowed so a long press cannot race through the tour
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const box = bubble.current
      if (!box || !['Escape', 'ArrowRight', 'ArrowLeft', 'Enter', ' ', 'Tab'].includes(e.key)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat && e.key !== 'Tab') return
      if (e.key === 'Escape') closeTour('escape')
      else if (e.key === 'ArrowRight') nextStep()
      else if (e.key === 'ArrowLeft') {
        if (!first.current) prevStep()
      } else if (e.key === 'Tab') {
        const items = [...box.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
        if (!items.length) return
        const i = items.indexOf(document.activeElement as HTMLButtonElement)
        items[e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length].focus()
      } else {
        const el = document.activeElement
        if (el instanceof HTMLButtonElement && box.contains(el)) el.click()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const spot = geo?.spot ?? null
  const place = geo?.place
  const keys = !flags.touch && step.keys?.length ? step.keys : null
  const moving = !reduce && 'transition-[left,top,width,height] duration-200 ease-out'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={textId}
      data-tour-root=""
      className="fixed inset-0 z-[75]"
      onPointerDown={(e) => {
        // the page under the layer gets nothing, and focus stays in the bubble
        if (!bubble.current?.contains(e.target as Node)) e.preventDefault()
      }}
    >
      {spot ? (
        <div
          aria-hidden="true"
          className={clsx('pointer-events-none absolute rounded-xl shadow-[0_0_0_9999px_rgb(0_0_0/0.6)] ring-2 ring-accent', moving)}
          style={{ left: spot.left - PAD, top: spot.top - PAD, width: spot.right - spot.left + 2 * PAD, height: spot.bottom - spot.top + 2 * PAD }}
        />
      ) : (
        <div aria-hidden="true" className="absolute inset-0 bg-black/60" />
      )}
      <div
        ref={bubble}
        className={clsx(
          'absolute flex w-[22rem] max-w-[calc(100vw-16px)] flex-col overflow-y-auto rounded-2xl border border-border-strong bg-surface p-4 text-text shadow-2xl shadow-black/40',
          moving,
        )}
        style={place ? { left: place.left, top: place.top, width: phone ? place.width : undefined, maxHeight: place.maxHeight } : { left: -9999, top: 0 }}
      >
        <div aria-live="polite">
          <h2 id={titleId} className="font-display text-[17px] leading-snug font-semibold tracking-tight">
            {t(titleKey(active.tourId, step))}
          </h2>
          <p id={textId} className="mt-1.5 text-sm leading-relaxed text-muted">
            {t(textKey(active.tourId, step, flags))}
          </p>
        </div>
        {step.body === 'chordMarks' && <ChordMarks className="mt-3" />}
        {keys && (
          <div className="mt-3 flex flex-wrap items-center gap-1">
            {keys.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="mr-auto font-mono text-xs text-faint tabular-nums">{t('tour.counter', { n: pos.ordinal, total: pos.total })}</span>
          <Button size="sm" variant="ghost" onClick={() => closeTour('skip')}>
            {t('tour.skip')}
          </Button>
          {!pos.first && (
            <Button size="sm" onClick={() => prevStep()}>
              {t('tour.back')}
            </Button>
          )}
          <Button ref={next} size="sm" variant="primary" onClick={() => nextStep()}>
            {t(pos.last ? 'tour.done' : 'tour.next')}
          </Button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Mount it in `App.tsx`**

In `frontend/src/App.tsx` add after line 14 (`import { Toaster } …`):

```ts
import { TourHost } from './components/tour/TourHost'
```

and in the JSX, right after `<Toaster />` (line 89):

```tsx
      <TourHost />
```

- [ ] **Step 7: Mark the video for placement**

In `frontend/src/components/player/VideoPanel.tsx`, directly above `<motion.section aria-label={t('core.video.title')} …>` (line 137, a child of the portal's fragment) add the JSX comment

```tsx
      {/* the tour's bubble keeps clear of the floating video; the video docked under the header on phones adds to its top inset */}
```

and add two attributes to that `motion.section` (keep the rest):

```tsx
        data-tour-avoid={docked ? undefined : ''}
        data-tour-top={docked && !isDesktop ? '' : undefined}
```

(`docked` and `isDesktop` are the variables this component already uses at lines 149–151.)

- [ ] **Step 8: Let jsdom tests load `lib/auth`**

`TourHost` imports `account/cloudInvite`, which imports `lib/auth`; Tasks 8 and 13 reach it too (through `lib/api`, `history/tracksStore`). `lib/auth.ts` reads `import.meta.hot?.data.useAuth`, and under vitest's jsdom environment `import.meta.hot` exists without `.data`, so the import throws `Cannot read properties of undefined (reading 'useAuth')`. Use the guard `lib/serverMode.ts:74-75` already has. In `frontend/src/lib/auth.ts` replace lines 35–36

```ts
export const useAuth: ReturnType<typeof createAuthStore> = import.meta.hot?.data.useAuth ?? createAuthStore()
if (import.meta.hot) import.meta.hot.data.useAuth = useAuth
```

with

```ts
export const useAuth: ReturnType<typeof createAuthStore> = import.meta.hot?.data?.useAuth ?? createAuthStore()
if (import.meta.hot?.data) import.meta.hot.data.useAuth = useAuth
```

and lines 223–224

```ts
export const useAuthDialog: ReturnType<typeof createDialogStore> = import.meta.hot?.data.useAuthDialog ?? createDialogStore()
if (import.meta.hot) import.meta.hot.data.useAuthDialog = useAuthDialog
```

with

```ts
export const useAuthDialog: ReturnType<typeof createDialogStore> = import.meta.hot?.data?.useAuthDialog ?? createDialogStore()
if (import.meta.hot?.data) import.meta.hot.data.useAuthDialog = useAuthDialog
```

Both are needed: with only the first, line 224 throws `Cannot set properties of undefined (setting 'useAuthDialog')`. In the browser nothing changes (Vite's dev `import.meta.hot` always has `data`; production builds have no `import.meta.hot`).

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/tour/TourHost.test.ts`
Expected: PASS (14 tests)

- [ ] **Step 10: Run the full checks**

Run: `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build`
Expected: all pass, oxlint with 0 warnings

- [ ] **Step 11: Commit**

```bash
git add frontend/src/components/tour/geometry.ts frontend/src/components/tour/ChordMarks.tsx frontend/src/components/tour/TourHost.tsx frontend/src/components/tour/TourHost.test.ts frontend/src/App.tsx frontend/src/components/player/VideoPanel.tsx frontend/src/lib/auth.ts
git commit -m "Tour: TourHost — dim + cut-out, bubble placement, keys in a window capture listener, focus trap and restore

lib/auth: guard import.meta.hot.data like lib/serverMode (jsdom tests have import.meta.hot without data).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Paste and drop do nothing during a tour

**Files:**
- Create: `frontend/src/components/layout/useGlobalPaste.ts`
- Modify: `frontend/src/hooks/useHotkeys.ts:22-24` (export `modalOpen`); `frontend/src/components/layout/HomePage.tsx` (whole file, below); `frontend/src/components/layout/DropOverlay.tsx:18-35`
- Test: `frontend/src/components/layout/inertDuringTour.test.ts`

**Interfaces:**
- Consumes: `isTypingTarget` (`hooks/useHotkeys.ts:12`); `startFiles`, `startLink`, `checkUrl`, `findUrl`, `errorText`, `announceServerRequired`, `toApiError`, `t` — exactly as `HomePage.tsx:1-46` uses them today.
- Produces: `export function modalOpen(): boolean` from `hooks/useHotkeys.ts`; `export function useGlobalPaste(): void` from `components/layout/useGlobalPaste.ts`.

- [ ] **Step 1: Write the failing test**

`frontend/src/components/layout/inertDuringTour.test.ts`:

```ts
// @vitest-environment jsdom
// While a tour (any aria-modal dialog) is open, pasting on the home page and dropping a file start nothing,
// the drop overlay does not appear, and a dropped file is still swallowed so the browser does not open it.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { translate } from '../../i18n'
import { useApp } from '../../store'
import { DropOverlay } from './DropOverlay'
import { useGlobalPaste } from './useGlobalPaste'

const { startFiles } = vi.hoisted(() => ({ startFiles: vi.fn() }))
vi.mock('../input/startFiles', () => ({ startFiles }))
vi.mock('../input/startLink', () => ({ startLink: vi.fn(() => new Promise(() => {})) }))

function PasteProbe() {
  useGlobalPaste()
  return null
}

let root: Root
let host: HTMLDivElement
let modal: HTMLDivElement | null = null
const file = new File(['x'], 'song.mp3', { type: 'audio/mpeg' })

function fire(type: 'dragenter' | 'dragover' | 'drop'): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files: [file], dropEffect: 'none' } })
  act(() => {
    window.dispatchEvent(e)
  })
  return e
}

function paste(): void {
  const e = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'clipboardData', { value: { files: [file], getData: () => '' } })
  act(() => {
    document.body.dispatchEvent(e)
  })
}

function openModal(): void {
  modal = document.createElement('div')
  modal.setAttribute('aria-modal', 'true')
  document.body.append(modal)
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useApp.setState({ lang: 'uk' })
  startFiles.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render([createElement(DropOverlay, { key: 'd' }), createElement(PasteProbe, { key: 'p' })]))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  modal?.remove()
  modal = null
})

it('a dropped or pasted file starts a song normally', () => {
  fire('drop')
  paste()
  expect(startFiles).toHaveBeenCalledTimes(2)
})

it('a dropped file does nothing during a tour, and the browser does not open it', () => {
  openModal()
  const over = fire('dragover')
  const drop = fire('drop')
  expect(startFiles).not.toHaveBeenCalled()
  expect(over.defaultPrevented).toBe(true)
  expect(drop.defaultPrevented).toBe(true)
})

it('dragging a file over a tour shows no drop overlay', () => {
  openModal()
  fire('dragenter')
  expect(document.body.textContent).not.toContain(translate('uk', 'core.drop.title'))
})

it('pasting during a tour does nothing', () => {
  openModal()
  paste()
  expect(startFiles).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/components/layout/inertDuringTour.test.ts`
Expected: FAIL with `Failed to resolve import "./useGlobalPaste"`

- [ ] **Step 3: Export `modalOpen`**

In `frontend/src/hooks/useHotkeys.ts` replace lines 21–24 with:

```ts
/** Another dialog is open (ours, the chord editor's, the tour) — global shortcuts, paste and drop stay quiet. */
export function modalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null
}
```

- [ ] **Step 4: Move the paste handler into its own file, inert during a modal**

`frontend/src/components/layout/useGlobalPaste.ts`:

```ts
// Paste a link or a file anywhere on the home page (outside text fields) to start. Quiet while an aria-modal
// dialog is open (the tour, the account dialog, the shortcuts), the same check as the hotkeys.
import { useEffect } from 'react'
import { t as tNow } from '../../i18n'
import { isTypingTarget, modalOpen } from '../../hooks/useHotkeys'
import { toApiError } from '../../lib/api'
import { announceServerRequired } from '../../lib/serverMode'
import { useApp } from '../../store'
import { startFiles } from '../input/startFiles'
import { startLink } from '../input/startLink'
import { checkUrl, findUrl } from '../input/url'
import { errorText } from '../jobs/errorText'

export function useGlobalPaste(): void {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (modalOpen() || isTypingTarget(e.target) || !e.clipboardData) return
      if (e.clipboardData.files.length) {
        e.preventDefault()
        startFiles(e.clipboardData.files)
        return
      }
      const url = findUrl(e.clipboardData.getData('text'))
      const check = url ? checkUrl(url) : null
      if (check?.ok && check.url) {
        e.preventDefault()
        const link = check.url
        startLink(link).then(
          (started) => {
            // another site without a server: the link field takes it and explains the account
            if (started.kind === 'account' && !announceServerRequired(link))
              useApp.getState().toast(errorText('server_required'), 'info')
            // a YouTube playlist or channel: nothing was sent, say what to paste instead
            if (started.kind === 'notVideo') useApp.getState().toast(tNow('cloud.input.notVideo'), 'info')
          },
          (err) => useApp.getState().toast(errorText(toApiError(err).code), 'error'),
        )
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])
}
```

Replace `frontend/src/components/layout/HomePage.tsx` with:

```tsx
import { useT } from '../../i18n'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { AccountCta } from '../account/AccountCta'
import { RecentTracks } from '../history/RecentTracks'
import { SmartInput } from '../input/SmartInput'
import { useGlobalPaste } from './useGlobalPaste'

export function HomePage() {
  const t = useT()
  useDocumentTitle(null)
  useGlobalPaste()

  return (
    <div className="mx-auto w-full max-w-[52rem] px-4 pt-10 pb-24 sm:px-6 sm:pt-16">
      <h1 className="max-w-[16ch] font-display text-[2.6rem] leading-[1.02] font-semibold tracking-[-0.035em] text-balance sm:text-[3.75rem]">
        {t('core.home.title')}
      </h1>
      <p className="mt-4 max-w-[56ch] text-[17px] leading-relaxed text-muted sm:text-lg">{t('core.home.subtitle')}</p>
      <AccountCta className="mt-7" />
      <SmartInput className="mt-7" />
      <RecentTracks />
    </div>
  )
}
```

- [ ] **Step 5: Make the drop overlay inert during a modal**

In `frontend/src/components/layout/DropOverlay.tsx` add `import { modalOpen } from '../../hooks/useHotkeys'` after line 4, and replace `onEnter`, `onOver` and `onDrop` (lines 18–35) with:

```ts
    const onEnter = (e: DragEvent) => {
      // the tour (or another dialog) is open: no overlay
      if (!hasFiles(e) || modalOpen()) return
      e.preventDefault()
      depth.current += 1
      setActive(true)
    }
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      // still prevented during a dialog: otherwise the browser would open the file in place of the app
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = modalOpen() ? 'none' : 'copy'
    }
```

and

```ts
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setActive(false)
      if (modalOpen()) return
      const files = e.dataTransfer?.files
      if (files?.length) startFiles(files)
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/layout/inertDuringTour.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full checks**

Run: `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/layout/useGlobalPaste.ts frontend/src/components/layout/inertDuringTour.test.ts frontend/src/components/layout/HomePage.tsx frontend/src/components/layout/DropOverlay.tsx frontend/src/hooks/useHotkeys.ts
git commit -m "Tour: home paste and file drop do nothing while a dialog or the tour is open

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Home and header anchors, Home readiness

**Files:**
- Modify: `frontend/src/lib/tour/trigger.ts` (append), `frontend/src/components/layout/HomePage.tsx`, `frontend/src/components/input/SmartInput.tsx:139-160, :360, :437`, `frontend/src/components/history/RecentTracks.tsx:201, :209`, `frontend/src/components/layout/ServerStatus.tsx:316-317`, `frontend/src/components/account/AccountButton.tsx:29-32`, `frontend/src/components/layout/AppHeader.tsx:46, :53`
- Create test: `frontend/src/components/tour/anchors.test.ts`
- Test: `frontend/src/lib/tour/trigger.test.ts` (append)

**Interfaces:**
- Consumes: `useConnection` (`lib/serverMode.ts:73`, `status: 'checking' | 'server' | 'browser'`); `useAuth` (`lib/auth.ts:35`, `ready`); `useTracks` (`history/tracksStore.ts:19`, `tracks`, `error`, `pendingDelete`); `useJobs` uploads (already in `SmartInput.tsx:150`); Task 5 `useTourTrigger`, `useTourFlags`, `useTourBlock`.
- Produces (trigger.ts): `export type LibraryState = 'loading' | 'failed' | 'empty' | 'list'`; `export function libraryState(tracks: readonly { id: string }[] | null, error: unknown, pendingDelete: Readonly<Record<string, true>>): LibraryState`; `export function homeReady(i: { settled: boolean; authReady: boolean; library: LibraryState }): boolean`. Anchors: `home.input`, `home.sources`, `home.demo`, `home.library`, `header.mode`, `header.signin`, `header.settings`, `header.more`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/tour/trigger.test.ts` (and add `homeReady, libraryState` to its import from `./trigger`):

```ts
describe('Home readiness', () => {
  it('the library: loading, failed, empty (also when every song waits for its undo) or with songs', () => {
    expect(libraryState(null, null, {})).toBe('loading')
    expect(libraryState(null, 'network', {})).toBe('failed')
    expect(libraryState([], null, {})).toBe('empty')
    expect(libraryState([{ id: 'a' }], null, { a: true })).toBe('empty')
    expect(libraryState([{ id: 'a' }, { id: 'b' }], null, { a: true })).toBe('list')
  })

  it('ready once the connection is settled, auth is ready and the library loaded or failed', () => {
    expect(homeReady({ settled: true, authReady: true, library: 'empty' })).toBe(true)
    expect(homeReady({ settled: true, authReady: true, library: 'failed' })).toBe(true)
    expect(homeReady({ settled: true, authReady: true, library: 'loading' })).toBe(false)
    expect(homeReady({ settled: false, authReady: true, library: 'list' })).toBe(false)
    expect(homeReady({ settled: true, authReady: false, library: 'list' })).toBe(false)
  })
})
```

Create `frontend/src/components/tour/anchors.test.ts`:

```ts
// Every anchor a wired tour names is set on a real element in src/components: the tour finds its spotlight by
// these ids, so a renamed or deleted attribute would silently drop a step.
import { describe, expect, it } from 'vitest'
import { TOURS, type TourId } from '../../lib/tour/tours'

const sources = import.meta.glob<string>('/src/components/**/*.tsx', { query: '?raw', import: 'default', eager: true })
const code = Object.values(sources).join('\n')

/** tours whose screens are wired so far (each wiring task adds its own) */
const WIRED: TourId[] = ['home']

describe('tour anchors in the code', () => {
  it.each(WIRED)('%s: every anchor is set in a component', (id) => {
    for (const step of TOURS[id].steps)
      for (const anchor of step.anchors) expect(code.includes(`"${anchor}"`) || code.includes(`'${anchor}'`), anchor).toBe(true)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/lib/tour/trigger.test.ts src/components/tour/anchors.test.ts`
Expected: FAIL with `libraryState is not a function` and `home.input: expected false to be true`

- [ ] **Step 3: Add the readiness predicates**

Append to `frontend/src/lib/tour/trigger.ts`:

```ts
/** The home library as the Home tour sees it (RecentTracks: songs waiting for their undo do not count). */
export type LibraryState = 'loading' | 'failed' | 'empty' | 'list'

export function libraryState(
  tracks: readonly { id: string }[] | null,
  error: unknown,
  pendingDelete: Readonly<Record<string, true>>,
): LibraryState {
  if (tracks === null) return error ? 'failed' : 'loading'
  return tracks.some((tr) => !pendingDelete[tr.id]) ? 'list' : 'empty'
}

/** Home: the connection settled, auth ready, the library loaded or failed (the link field: useTourBlock). */
export function homeReady(i: { settled: boolean; authReady: boolean; library: LibraryState }): boolean {
  return i.settled && i.authReady && i.library !== 'loading'
}
```

- [ ] **Step 4: Home readiness in `HomePage.tsx`**

Replace `frontend/src/components/layout/HomePage.tsx` with:

```tsx
import { useT } from '../../i18n'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { useAuth } from '../../lib/auth'
import { useConnection } from '../../lib/serverMode'
import { homeReady, libraryState } from '../../lib/tour/trigger'
import { AccountCta } from '../account/AccountCta'
import { useTracks } from '../history/tracksStore'
import { RecentTracks } from '../history/RecentTracks'
import { SmartInput } from '../input/SmartInput'
import { useTourFlags, useTourTrigger } from '../tour/hooks'
import { useGlobalPaste } from './useGlobalPaste'

export function HomePage() {
  const t = useT()
  useDocumentTitle(null)
  useGlobalPaste()

  // the Home tour: once the mode, the account and the library are known (a failed library leaves both library steps out)
  const settled = useConnection((s) => s.status !== 'checking')
  const authReady = useAuth((s) => s.ready)
  const library = useTracks((s) => libraryState(s.tracks, s.error, s.pendingDelete))
  useTourFlags({ libraryEmpty: library === 'empty', libraryList: library === 'list' })
  useTourTrigger('home', homeReady({ settled, authReady, library }))

  return (
    <div className="mx-auto w-full max-w-[52rem] px-4 pt-10 pb-24 sm:px-6 sm:pt-16">
      <h1 className="max-w-[16ch] font-display text-[2.6rem] leading-[1.02] font-semibold tracking-[-0.035em] text-balance sm:text-[3.75rem]">
        {t('core.home.title')}
      </h1>
      <p className="mt-4 max-w-[56ch] text-[17px] leading-relaxed text-muted sm:text-lg">{t('core.home.subtitle')}</p>
      <AccountCta className="mt-7" />
      <SmartInput className="mt-7" />
      <RecentTracks />
    </div>
  )
}
```

- [ ] **Step 5: SmartInput — block and anchors**

In `frontend/src/components/input/SmartInput.tsx`:
1. Add `import { useTourBlock } from '../tour/hooks'` with the other imports.
2. After `const tabCapable = useCanListenInTab()` (line 158) add:

```ts
  // no tour starts by itself while a link or a file is on its way or the field has text
  useTourBlock(busy || uploading || value !== '')
```

3. On the input row `<div className={clsx('group flex h-16 …` (line 360) add `data-tour="home.input"`.
4. On `<div className="mt-4 grid gap-3 sm:grid-cols-2">` (line 437) add `data-tour="home.sources"`.

- [ ] **Step 6: RecentTracks anchors**

In `frontend/src/components/history/RecentTracks.tsx`:
1. On the empty state's demo link `<a href={`#${paths.demo()}`} …>` (line 201) add `data-tour="home.demo"`.
2. On `<section className="mt-14" aria-labelledby="recent-heading">` (line 209) add `data-tour="home.library" data-tour-until="li"` (the spotlight is the heading with the first row).

- [ ] **Step 7: Header anchors**

1. `frontend/src/components/layout/ServerStatus.tsx`: on the chip `<button ref={buttonRef} …>` (line 316) add `data-tour="header.mode"`.
2. `frontend/src/components/account/AccountButton.tsx`: on the signed-out `<Button variant="ghost" size="sm" aria-label={t('account.signIn')} …>` (line 29) add `data-tour="header.signin"`.
3. `frontend/src/components/layout/AppHeader.tsx`: line 46 becomes `<div className="hidden items-center gap-1 sm:flex" data-tour="header.settings">` and line 53 becomes `<div className="sm:hidden" data-tour="header.more">`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/tour/trigger.test.ts src/components/tour/anchors.test.ts`
Expected: PASS

- [ ] **Step 9: Run the full checks**

Run: `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build`
Expected: all pass

- [ ] **Step 10: Commit**

```bash
git add frontend/src/lib/tour/trigger.ts frontend/src/lib/tour/trigger.test.ts frontend/src/components/tour/anchors.test.ts frontend/src/components/layout/HomePage.tsx frontend/src/components/input/SmartInput.tsx frontend/src/components/history/RecentTracks.tsx frontend/src/components/layout/ServerStatus.tsx frontend/src/components/account/AccountButton.tsx frontend/src/components/layout/AppHeader.tsx
git commit -m "Tour: Home tour wired — anchors on the home page and header, readiness, library flags

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Song anchors and readiness

**Files:**
- Modify: `frontend/src/components/chords/ui/controls.tsx:61-78` (`Segmented`), `frontend/src/components/chords/InstrumentPicker.tsx:16-38`, `frontend/src/components/chords/NowPlaying.tsx:73, :89`, `frontend/src/components/chords/tempo/TempoReadout.tsx:37`, `frontend/src/components/chords/Toolbar.tsx:50, :82, :108, :117, :165, :202, :233`, `frontend/src/components/chords/CopyButton.tsx:30`, `frontend/src/components/chords/SheetView.tsx:222, :312`, `frontend/src/components/chords/ChordLegend.tsx:27`, `frontend/src/components/player/PlayerBar.tsx:33`, `frontend/src/components/chords/ChordWorkspace.tsx:54-64`, `frontend/src/components/tour/anchors.test.ts`
- Test: `frontend/src/components/chords/InstrumentPicker.test.ts` (append), `frontend/src/components/tour/anchors.test.ts`

**Interfaces:**
- Consumes: Task 5 `useTourTrigger`, `useTourFlags`; `useChordModel().hasChords` (`chords/model.ts`), `useApp((s) => s.view)`.
- Produces: `Segmented` gains `tour?: string` (rendered as `data-tour`); `InstrumentPicker` gains `tour?: string` (on both the segmented and the phone `<select>` wrapper). Anchors `song.now`, `song.instrument`, `song.tempo`, `song.key`, `song.transpose`, `song.simplify`, `song.accidentals`, `song.views`, `song.follow`, `song.grid`, `song.barNumber`, `song.legend`, `song.copy`, `song.settings`, `song.player`. Flags `hasChords`, `sheetView`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/components/chords/InstrumentPicker.test.ts`:

```ts
it('carries its tour anchor on a wide and on a narrow screen', () => {
  for (const isWide of [true, false]) {
    wide = isWide
    act(() => root!.render(createElement(InstrumentPicker, { tour: 'song.instrument' })))
    expect(host.querySelector('[data-tour="song.instrument"]'), `wide=${isWide}`).not.toBeNull()
  }
})
```

In `frontend/src/components/tour/anchors.test.ts` change the list to:

```ts
const WIRED: TourId[] = ['home', 'song']
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/components/chords/InstrumentPicker.test.ts src/components/tour/anchors.test.ts`
Expected: FAIL — `expected null not to be null` (wide=true) and `song.now: expected false to be true`

- [ ] **Step 3: `Segmented` and `InstrumentPicker` take a tour anchor**

In `frontend/src/components/chords/ui/controls.tsx`, `Segmented` (line 61): add `tour,` to the destructured props, `tour?: string` to the props type (with the comment `/** a guided-tour anchor (data-tour) */`), and `data-tour={tour}` on its root `<div role="radiogroup" …>`.

In `frontend/src/components/chords/InstrumentPicker.tsx` change the signature (line 16) to:

```ts
export function InstrumentPicker({ className, tour }: { className?: string; tour?: string }) {
```

pass `tour={tour}` to the `<Segmented<Instrument> …>` (line 27) and add `data-tour={tour}` to the phone `<span className={clsx('relative inline-flex h-7 …` (line 38).

- [ ] **Step 4: Hero and tempo**

- `frontend/src/components/chords/NowPlaying.tsx`: on the `<section ref={ref} aria-live="off" …>` (line 73) add `data-tour="song.now"`; line 89 becomes `<InstrumentPicker tour="song.instrument" />`.
- `frontend/src/components/chords/tempo/TempoReadout.tsx`: on the hero tempo `<button ref={setBtn} type="button" aria-haspopup="dialog" …>` (line 37) add `data-tour="song.tempo"`.

- [ ] **Step 5: Toolbar**

In `frontend/src/components/chords/Toolbar.tsx`:
- key badge `<span className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-surface-2 px-3 text-sm" …>` (line 50): add `data-tour="song.key"`;
- transpose `<div className="flex shrink-0 items-center gap-0.5" role="group" …>` (line 82): add `data-tour="song.transpose"`;
- `<ToggleChip pressed={simplify} …>` (line 108): add `data-tour="song.simplify"`;
- accidentals `<Segmented<Accidentals> …>` (line 117): add `tour="song.accidentals"`;
- in `ViewControls`, the view `<Segmented<ChordView> …>` (line 165): add `tour="song.views"`; the follow `<IconButton label={t('chords.follow.title')} …>` (line 202): add `data-tour="song.follow"`;
- in `SettingsMenu`, the `<IconButton ref={setBtn} label={t('chords.settings')} …>` (line 233): add `data-tour="song.settings"`.

(`ViewControls` renders twice — the phone copy in the scroll strip, the ≥ 640 px copy pinned right; the tour takes the first visible one.)

- [ ] **Step 6: Copy, sheet, legend, player**

- `frontend/src/components/chords/CopyButton.tsx`: on the root `<div className="inline-flex shrink-0 items-stretch rounded-lg bg-accent …">` (line 30) add `data-tour="song.copy"`.
- `frontend/src/components/chords/SheetView.tsx`: line 222 becomes `<div data-group={gi} data-tour={gi === 0 ? 'song.grid' : undefined} className="group/line relative flex items-stretch">`; on the bar-number `<button type="button" onClick={(e) => selectBar(bar.index, e.shiftKey)} …>` (line 312) add `data-tour={bar.index === 0 ? 'song.barNumber' : undefined}`.
- `frontend/src/components/chords/ChordLegend.tsx`: on `<section aria-labelledby="cw-legend" className="flex flex-col gap-3">` (line 27) add `data-tour="song.legend" data-tour-until="li"`.
- `frontend/src/components/player/PlayerBar.tsx`: on the root `<div ref={ref} role="region" aria-label={t('core.player.region')} …>` (line 33) add `data-tour="song.player"`.

- [ ] **Step 7: Song readiness and flags**

In `frontend/src/components/chords/ChordWorkspace.tsx` add `import { useTourFlags, useTourTrigger } from '../tour/hooks'` and, in `Workspace` after `useChordHotkeys(model)` (line 60):

```ts
  // the Song tour: the track has loaded with no error (this component exists only then)
  useTourFlags({ hasChords: model.hasChords, sheetView: view === 'sheet' })
  useTourTrigger('song', true)
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/chords/InstrumentPicker.test.ts src/components/tour/anchors.test.ts`
Expected: PASS

- [ ] **Step 9: Run the full checks**

Run: `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build`
Expected: all pass

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/chords/ui/controls.tsx frontend/src/components/chords/InstrumentPicker.tsx frontend/src/components/chords/InstrumentPicker.test.ts frontend/src/components/chords/NowPlaying.tsx frontend/src/components/chords/tempo/TempoReadout.tsx frontend/src/components/chords/Toolbar.tsx frontend/src/components/chords/CopyButton.tsx frontend/src/components/chords/SheetView.tsx frontend/src/components/chords/ChordLegend.tsx frontend/src/components/player/PlayerBar.tsx frontend/src/components/chords/ChordWorkspace.tsx frontend/src/components/tour/anchors.test.ts
git commit -m "Tour: Song tour wired — hero, toolbar, sheet, legend and player anchors, readiness and flags

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Score and Live keys anchors and readiness

**Files:**
- Modify: `frontend/src/lib/tour/trigger.ts` (append), `frontend/src/components/chords/score/ScoreView.tsx:75-118, :393-404, :463, :636-645`, `frontend/src/components/chords/piano/LivePiano.tsx:30-39, :158-168, :190, :279-288`, `frontend/src/components/chords/piano/SyncControl.tsx:42`, `frontend/src/components/tour/anchors.test.ts`
- Test: `frontend/src/lib/tour/trigger.test.ts` (append), `frontend/src/components/tour/anchors.test.ts`

**Interfaces:**
- Consumes: `NotesState` type (`lib/transcription`, `service.ts:29`; `ready` carries `index: NoteIndex` with `count`); Task 5 `useTourTrigger`, `useTourFlags`; Task 10 `Segmented` `tour` prop.
- Produces: `export function keysNotesReady(notes: NotesState): boolean` (trigger.ts). Anchors `score.parts`, `score.chords`, `score.level`, `score.export`, `score.canvas`, `keys.canvas`, `keys.sync`, `keys.voice`. Flags `scoreRendered`, `keysPanel`, `keysReady`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/tour/trigger.test.ts` (add `keysNotesReady` to the `./trigger` import and `import type { NotesState } from '../transcription'`):

```ts
describe('Live keys readiness', () => {
  it('needs the notes ready with at least one note; never the demo (no audio → unavailable)', () => {
    const ready = (count: number) => ({ status: 'ready', index: { count } }) as unknown as NotesState
    expect(keysNotesReady(ready(3))).toBe(true)
    expect(keysNotesReady(ready(0))).toBe(false)
    expect(keysNotesReady({ status: 'unavailable' })).toBe(false)
    expect(keysNotesReady({ status: 'loading' })).toBe(false)
    expect(keysNotesReady({ status: 'idle' })).toBe(false)
  })
})
```

In `frontend/src/components/tour/anchors.test.ts`:

```ts
const WIRED: TourId[] = ['home', 'song', 'score', 'keys']
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/lib/tour/trigger.test.ts src/components/tour/anchors.test.ts`
Expected: FAIL with `keysNotesReady is not a function` and `score.parts: expected false to be true`

- [ ] **Step 3: Add the predicate**

Append to `frontend/src/lib/tour/trigger.ts` (and add `import type { NotesState } from '../transcription'` at the top):

```ts
/** Live keys: the panel's notes are ready with at least one note (the demo stays "unavailable"). */
export function keysNotesReady(notes: NotesState): boolean {
  return notes.status === 'ready' && notes.index.count > 0
}
```

- [ ] **Step 4: Score anchors, readiness and the rendered flag**

In `frontend/src/components/chords/score/ScoreView.tsx`:
1. Add `import { useTourFlags, useTourTrigger } from '../../tour/hooks'`.
2. In `ScoreView` (the default export, line 75), after `const settings = useScoreSettings()`:

```ts
  // the Score tour: the view's header is on screen (the notes need not be ready)
  useTourTrigger('score', true)
```

3. Wrap the Вокал and Фортепіано chips (lines 93–104) so they form one anchor:

```tsx
          <span className="flex shrink-0 items-center gap-1" data-tour="score.parts">
            <ToggleChip
              pressed={settings.vocals}
              onClick={() => set('vocals', !settings.vocals)}
              title={t('score.toggle.vocals.title')}
              icon={<Mic size={15} />}
              className={clsx(!vocalsReady && settings.vocals && 'opacity-80')}
            >
              {t('score.toggle.vocals')}
            </ToggleChip>
            <ToggleChip pressed={settings.piano} onClick={() => set('piano', !settings.piano)} title={t('score.toggle.piano.title')} icon={<Piano size={15} />}>
              {t('score.toggle.piano')}
            </ToggleChip>
          </span>
```

4. On the Акорди `<ToggleChip pressed={settings.chords} …>` (line 106) add `data-tour="score.chords"`; on the level `<Segmented<ScoreLevel> …>` (line 110) add `tour="score.level"`.
5. In `ExportMenu`, on the `<button ref={setBtn} type="button" aria-haspopup="menu" …>` (line 398) add `data-tour="score.export"`.
6. In `ScoreCanvas`, after `const [phase, setPhase] = useState<Phase>('lib')` (line 463):

```ts
  // the Score tour's canvas step only once the notes are drawn
  useTourFlags({ scoreRendered: phase === 'ready' })
```

and on the `<div ref={wrap} role="img" …>` (line 636) add `data-tour="score.canvas"`.

- [ ] **Step 5: Live keys anchors, readiness and flags**

In `frontend/src/components/chords/piano/LivePiano.tsx`:
1. Add `import { keysNotesReady } from '../../../lib/tour/trigger'` and `import { useTourFlags, useTourTrigger } from '../../tour/hooks'`.
2. After `const { notes, source } = usePianoNotes(track)` (line 38):

```ts
  // the Live keys tour: the panel is shown with its notes ready (never the demo: it has no audio)
  const notesReady = keysNotesReady(notes)
  useTourFlags({ keysPanel: true, keysReady: notesReady })
  useTourTrigger('keys', notesReady)
```

3. On the vocals `<IconButton label={t('score.live.vocals.title')} …>` (line 165) add `data-tour="keys.voice"`.
4. Line 190 becomes `<div ref={wrap} className="relative border-t border-border" data-tour="keys.canvas">`.
5. In `VocalsLine`, on the «Відокремити голос» `<button type="button" onClick={() => void startVocals(track)} …>` (line 281) add `data-tour="keys.voice"`.

In `frontend/src/components/chords/piano/SyncControl.tsx`, on the `<button ref={setBtn} type="button" onClick={toggle} …>` (line 42) add `data-tour="keys.sync"`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/tour/trigger.test.ts src/components/tour/anchors.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full checks**

Run: `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/tour/trigger.ts frontend/src/lib/tour/trigger.test.ts frontend/src/components/chords/score/ScoreView.tsx frontend/src/components/chords/piano/LivePiano.tsx frontend/src/components/chords/piano/SyncControl.tsx frontend/src/components/tour/anchors.test.ts
git commit -m "Tour: Score and Live keys tours wired — anchors, readiness, rendered / notes-ready flags

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Listen and YouTube anchors and readiness

**Files:**
- Modify: `frontend/src/lib/tour/trigger.ts` (append), `frontend/src/components/capture/ListenPage.tsx:118-120, :165, :225, :246`, `frontend/src/components/live/LiveChordsView.tsx:165, :236, :314`, `frontend/src/components/live/LiveLevelMeter.tsx:28`, `frontend/src/components/capture/CapturePage.tsx:75-77, :108, :403-409, :454, :512, :581-591, :593`, `frontend/src/components/tour/anchors.test.ts`
- Test: `frontend/src/lib/tour/trigger.test.ts` (append), `frontend/src/components/tour/anchors.test.ts`

**Interfaces:**
- Consumes: `isCapturing` (`capture/machine.ts:70`); the capture `phase` and `playerStatus` (`CapturePage.tsx:44`, `'loading' | 'ready' | 'embed' | 'error'`); Task 5 `useTourTrigger`.
- Produces: `export function listenReady(phase: string): boolean`; `export function captureReady(phase: string, player: string): boolean` (trigger.ts). Anchors `listen.sources`, `listen.start`, `listen.controls`, `live.chord`, `live.key`, `live.tempo`, `live.level`, `capture.video`, `capture.start`, `capture.howto`, `capture.controls`, `capture.alt`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/tour/trigger.test.ts` (add `captureReady, listenReady` to the import):

```ts
describe('Listen and YouTube readiness', () => {
  it('only at the start button: not while asking, failing, stopping or saving', () => {
    expect(listenReady('idle')).toBe(true)
    for (const phase of ['requesting', 'starting', 'live', 'paused', 'stopping', 'saving', 'done', 'error']) expect(listenReady(phase), phase).toBe(false)
  })

  it('YouTube also needs its player loaded', () => {
    expect(captureReady('idle', 'ready')).toBe(true)
    expect(captureReady('idle', 'loading')).toBe(false)
    expect(captureReady('idle', 'embed')).toBe(false)
    expect(captureReady('requesting', 'ready')).toBe(false)
  })
})
```

In `frontend/src/components/tour/anchors.test.ts`:

```ts
const WIRED: TourId[] = ['home', 'song', 'score', 'keys', 'listen', 'capture']
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/lib/tour/trigger.test.ts src/components/tour/anchors.test.ts`
Expected: FAIL with `listenReady is not a function` and `listen.sources: expected false to be true`

- [ ] **Step 3: Add the predicates**

Append to `frontend/src/lib/tour/trigger.ts`:

```ts
/** Listen: the capture phase is `idle` (not requesting, error, stopping or saving). */
export function listenReady(phase: string): boolean {
  return phase === 'idle'
}

/** YouTube in a tab: idle, and the embedded player has loaded. */
export function captureReady(phase: string, player: string): boolean {
  return phase === 'idle' && player === 'ready'
}
```

- [ ] **Step 4: Listen page**

In `frontend/src/components/capture/ListenPage.tsx`:
1. Add `import { listenReady } from '../../lib/tour/trigger'` and `import { useTourTrigger } from '../tour/hooks'`.
2. After `const busy = phase === 'stopping' || phase === 'saving' || phase === 'done'` (line 120):

```ts
  // the Listen tour: at the start button; a recording keeps running if the tour is opened during it
  useTourTrigger('listen', listenReady(phase), capturing)
```

3. Add `data-tour="listen.controls"` to `<div className="flex gap-2">` (line 165), `data-tour="listen.sources"` to `<div role="radiogroup" …>` (line 225) and `data-tour="listen.start"` to the «Почати» `<Button variant="primary" …>` (line 246).

- [ ] **Step 5: Live view**

- `frontend/src/components/live/LiveChordsView.tsx`: on the tempo `<span className="inline-flex h-7 items-center rounded-lg px-1.5 font-mono …">` (line 165) add `data-tour="live.tempo"`; the `Hero` root (line 236) becomes `<div className="min-w-0 flex-1" data-tour="live.chord">` (the stable wrapper, not the animated child); on the `KeyBadge` `<span className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 text-sm" …>` (line 314) add `data-tour="live.key"`.
- `frontend/src/components/live/LiveLevelMeter.tsx`: on the root `<div role="meter" …>` (line 28) add `data-tour="live.level"` (it has one use, in the live view).

- [ ] **Step 6: YouTube capture page**

In `frontend/src/components/capture/CapturePage.tsx`:
1. Add `import { captureReady } from '../../lib/tour/trigger'` and `import { useTourTrigger } from '../tour/hooks'`.
2. `Card` (line 75) becomes:

```tsx
function Card({ children, className, tour }: { children: ReactNode; className?: string; tour?: string }) {
  return (
    <div data-tour={tour} className={clsx('rounded-3xl border border-border bg-surface p-5 sm:p-6', className)}>
      {children}
    </div>
  )
}
```

3. In `NoTabCapture` (line 108) `<Card>` becomes `<Card tour="capture.alt">`.
4. After `const gaveUp = …` (line 409):

```ts
  // the YouTube tour: at the start button with the player loaded; a recording keeps running if opened during it
  useTourTrigger('capture', captureReady(phase, playerStatus), capturing)
```

5. Add `data-tour="capture.video"` to `<div className="relative aspect-video overflow-hidden …">` (line 454) and `data-tour="capture.controls"` to the recording bar `<div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl …">` (line 512).
6. Wrap the steps list and the share-dialog example (lines 581–591) in one anchor:

```tsx
                  <div data-tour="capture.howto">
                    <ol className="mt-3 space-y-2.5 text-[15px] leading-snug text-muted">
                      {['cloud.capture.step1', 'cloud.capture.step2', 'cloud.capture.step3'].map((key, i) => (
                        <li key={key} className="flex gap-2.5">
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 font-mono text-xs text-text">
                            {i + 1}
                          </span>
                          <span className={clsx(i === 1 && 'text-text')}>{t(key)}</span>
                        </li>
                      ))}
                    </ol>
                    <ShareTabIllustration className="mt-4" />
                  </div>
```

7. On the first «Почати» `<Button variant="primary" disabled={playerStatus !== 'ready' || phase === 'requesting'} … onClick={() => void begin(false)}>` (line 593) add `data-tour="capture.start"`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/tour/trigger.test.ts src/components/tour/anchors.test.ts`
Expected: PASS

- [ ] **Step 8: Run the full checks**

Run: `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build`
Expected: all pass

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/tour/trigger.ts frontend/src/lib/tour/trigger.test.ts frontend/src/components/capture/ListenPage.tsx frontend/src/components/live/LiveChordsView.tsx frontend/src/components/live/LiveLevelMeter.tsx frontend/src/components/capture/CapturePage.tsx frontend/src/components/tour/anchors.test.ts
git commit -m "Tour: Listen and YouTube tours wired — anchors, readiness at the start button

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: «Інструкція» entries and the full anchors check

**Files:**
- Modify: `frontend/src/components/tour/hooks.ts` (append), `frontend/src/components/layout/HeaderSettings.tsx:1-2, :66-73`, `frontend/src/components/layout/AppHeader.tsx:7, :16, :43, :50, :54`, `frontend/src/components/layout/TrackActions.tsx:1, :35-44, :97-123`, `frontend/src/components/layout/ShortcutsModal.tsx:1-4, :54-58, :86`, `frontend/src/App.tsx`, `frontend/src/components/tour/anchors.test.ts` (replace)
- Test: `frontend/src/components/layout/guideEntries.test.ts`, `frontend/src/components/tour/anchors.test.ts`

**Interfaces:**
- Consumes: Task 4 `guideAvailable`; Task 5 `startCurrentTour`; `Route` (`hooks/useRoute.ts`); `IconButton` (`ui/IconButton.tsx:22`); `MenuItem`, `MenuSeparator` (`ui/Menu.tsx`); lucide `CircleHelp`.
- Produces: `export function useGuideAvailable(route: Route): boolean` (hooks.ts); `export function GuideButton({ onGuide }: { onGuide(): void })` (HeaderSettings.tsx); `AppHeader` prop `onGuide?: () => void`; `HeaderMenu` prop `onGuide?: () => void`; `ShortcutsModal` prop `onGuide?: () => void`. An entry is rendered only when `onGuide` is passed.

- [ ] **Step 1: Write the failing tests**

`frontend/src/components/layout/guideEntries.test.ts`:

```ts
// @vitest-environment jsdom
// «Інструкція» in three places — the ⋯ menu (phones: every route; desktop: track pages), the desktop header
// button, the shortcuts dialog — each shown only when the app passes onGuide (a screen with a tour).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from '../../store'
import type { Track } from '../../types'
import { GuideButton } from './HeaderSettings'
import { ShortcutsModal } from './ShortcutsModal'
import { HeaderMenu } from './TrackActions'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom has no CSS.escape (Menu focuses its trigger with it when an item is chosen)
  vi.stubGlobal('CSS', { escape: (s: string) => s })
  useApp.setState({ lang: 'uk' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const render = (node: Parameters<Root['render']>[0]) => act(() => root.render(node))
const byText = (text: string) => [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.includes(text)) ?? null
const click = (el: HTMLElement | null) => act(() => el!.click())
const TRACK = { id: 't1', title: 'Song', source: { type: 'file' } } as unknown as Track

describe('the shortcuts dialog', () => {
  it('ends with an «Інструкція» line that runs the guide', () => {
    const onGuide = vi.fn()
    render(createElement(ShortcutsModal, { open: true, onClose: () => {}, onGuide }))
    expect(document.body.textContent).toContain('Що робить кожна кнопка, покаже інструкція.')
    click(byText('Інструкція'))
    expect(onGuide).toHaveBeenCalledTimes(1)
  })

  it('has no such line where there is no tour', () => {
    render(createElement(ShortcutsModal, { open: true, onClose: () => {} }))
    expect(byText('Інструкція')).toBeNull()
  })
})

describe('the ⋯ menu', () => {
  it('phones: «Інструкція» after the shortcuts, on any route', () => {
    const onGuide = vi.fn()
    render(createElement(HeaderMenu, { track: null, demo: false, withSettings: true, onHelp: () => {}, onGuide }))
    click(document.querySelector<HTMLElement>('[aria-label="Більше дій"]'))
    const items = [...document.querySelectorAll('[role^="menuitem"]')].map((i) => i.textContent)
    expect(items.at(-1)).toContain('Інструкція')
    click(byText('Інструкція'))
    expect(onGuide).toHaveBeenCalledTimes(1)
  })

  it('desktop track menu: «Інструкція» after the track actions', () => {
    render(createElement(HeaderMenu, { track: TRACK, demo: false, withSettings: false, onHelp: () => {}, onGuide: () => {} }))
    click(document.querySelector<HTMLElement>('[aria-label="Більше дій"]'))
    const items = [...document.querySelectorAll('[role^="menuitem"]')].map((i) => i.textContent)
    expect(items.at(-1)).toContain('Інструкція')
  })

  it('no item without a tour', () => {
    render(createElement(HeaderMenu, { track: null, demo: false, withSettings: true, onHelp: () => {} }))
    click(document.querySelector<HTMLElement>('[aria-label="Більше дій"]'))
    expect(byText('Інструкція')).toBeNull()
  })
})

it('the desktop header button is an icon button labelled «Інструкція»', () => {
  const onGuide = vi.fn()
  render(createElement(GuideButton, { onGuide }))
  const button = document.querySelector<HTMLElement>('[aria-label="Інструкція"]')
  expect(button).not.toBeNull()
  click(button)
  expect(onGuide).toHaveBeenCalledTimes(1)
})
```

Replace `frontend/src/components/tour/anchors.test.ts` with:

```ts
// Every anchor the tours name is set on a real element in src/components, and every literal data-tour in the
// components is one the tours use (the tour finds its spotlight by these ids; a renamed or deleted attribute
// would silently drop a step). 43 ids.
import { describe, expect, it } from 'vitest'
import { tourAnchors, TOUR_IDS, TOURS } from '../../lib/tour/tours'

const sources = import.meta.glob<string>('/src/components/**/*.tsx', { query: '?raw', import: 'default', eager: true })
const code = Object.values(sources).join('\n')

describe('tour anchors in the code', () => {
  it('there are 43 of them', () => {
    expect(tourAnchors()).toHaveLength(43)
  })

  it.each(TOUR_IDS)('%s: every anchor is set in a component', (id) => {
    for (const step of TOURS[id].steps)
      for (const anchor of step.anchors) expect(code.includes(`"${anchor}"`) || code.includes(`'${anchor}'`), anchor).toBe(true)
  })

  it('every literal data-tour / tour prop names a known anchor', () => {
    const known = new Set(tourAnchors())
    const literals = [...code.matchAll(/\b(?:data-)?tour="([^"]+)"/g)].map((m) => m[1])
    expect(literals.length).toBeGreaterThan(30)
    expect(literals.filter((id) => !known.has(id))).toEqual([])
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/components/layout/guideEntries.test.ts src/components/tour/anchors.test.ts`
Expected: FAIL — `GuideButton` is not exported (`Element type is invalid … got: undefined`) and the shortcuts dialog test fails on the missing text; `anchors.test.ts` PASSES already (all tours wired in Tasks 9–12) — that is fine, it is the regression guard.

- [ ] **Step 3: `useGuideAvailable`**

Append to `frontend/src/components/tour/hooks.ts` (add `import type { Route } from '../../hooks/useRoute'` and `guideAvailable` to the `../../lib/tour/trigger` import):

```ts
/** Whether the «Інструкція» entries show here (no tour on job / not-found; a song page only once loaded). */
export function useGuideAvailable(route: Route): boolean {
  const trackLoaded = useApp((s) => s.track !== null)
  return guideAvailable(route, trackLoaded)
}
```

- [ ] **Step 4: The header button**

In `frontend/src/components/layout/HeaderSettings.tsx` change line 2 to `import { CircleHelp, Keyboard, Monitor, Moon, Sun } from 'lucide-react'` and append:

```tsx
/** «Інструкція»: the current screen's guided tour (desktop header, right after the shortcuts button). */
export function GuideButton({ onGuide }: { onGuide(): void }) {
  const t = useT()
  return (
    <IconButton label={t('tour.open')} onClick={onGuide}>
      <CircleHelp className="size-[18px]" />
    </IconButton>
  )
}
```

- [ ] **Step 5: The ⋯ menu item**

In `frontend/src/components/layout/TrackActions.tsx`:
1. Line 1: add `CircleHelp` to the lucide import.
2. `HeaderMenuProps` (line 35): add

```ts
  /** «Інструкція» (only where the current screen has a tour) */
  onGuide?(): void
```

and destructure it: `export function HeaderMenu({ track, demo, withSettings, onHelp, onGuide }: HeaderMenuProps) {`.
3. Inside the `withSettings` block, right after the shortcuts `<MenuItem icon={<Keyboard />} …>` (line 119–121) add:

```tsx
          {onGuide && (
            <MenuItem icon={<CircleHelp />} onSelect={onGuide}>
              {t('tour.open')}
            </MenuItem>
          )}
```

4. After the `withSettings` block (after line 123, before `</Menu>`) add the desktop track-menu entry:

```tsx
      {!withSettings && onGuide && (
        <>
          {track && (href || canEdit) && <MenuSeparator />}
          <MenuItem icon={<CircleHelp />} onSelect={onGuide}>
            {t('tour.open')}
          </MenuItem>
        </>
      )}
```

- [ ] **Step 6: The shortcuts dialog line**

In `frontend/src/components/layout/ShortcutsModal.tsx`:
1. Add `import { CircleHelp } from 'lucide-react'`.
2. Signature (line 54): `export function ShortcutsModal({ open, onClose, onGuide }: { open: boolean; onClose(): void; onGuide?(): void }) {`
3. After `<p className="mt-5 text-sm text-faint">{t('core.shortcuts.note')}</p>` (line 86):

```tsx
      {onGuide && (
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          {t('tour.shortcuts.hint')}
          <button type="button" onClick={onGuide} className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline">
            <CircleHelp className="size-4" aria-hidden="true" />
            {t('tour.open')}
          </button>
        </p>
      )}
```

- [ ] **Step 7: The header passes `onGuide` on**

In `frontend/src/components/layout/AppHeader.tsx`:
1. Line 7: `import { GuideButton, HelpButton, LangSwitch, ThemeMenu } from './HeaderSettings'`
2. Line 16: `export function AppHeader({ route, onHelp, onGuide }: { route: Route; onHelp(): void; onGuide?: () => void }) {`
3. Line 43: `<HeaderMenu track={track} demo={demo} withSettings={false} onHelp={onHelp} onGuide={onGuide} />`
4. After `<HelpButton onHelp={onHelp} />` (line 50): `{onGuide && <GuideButton onGuide={onGuide} />}`
5. Line 54: `<HeaderMenu track={track} demo={demo} withSettings onHelp={onHelp} onGuide={onGuide} />`

- [ ] **Step 8: Wire it in `App.tsx`**

In `frontend/src/App.tsx`:
1. Add imports:

```ts
import { useGuideAvailable } from './components/tour/hooks'
import { startCurrentTour } from './components/tour/tourStore'
```

2. After `const openHelp = useCallback(() => setHelpOpen(true), [])` (line 45):

```ts
  // «Інструкція»: the current screen's tour (the entries hide on job / not-found and while a song loads)
  const guide = useGuideAvailable(route)
  const openGuide = useCallback(() => startCurrentTour(), [])
  // from the shortcuts dialog: close it, start once it has left the page
  const openGuideFromHelp = useCallback(() => {
    setHelpOpen(false)
    startCurrentTour({ afterModal: true })
  }, [])
```

3. `<AppHeader route={route} onHelp={openHelp} />` becomes `<AppHeader route={route} onHelp={openHelp} onGuide={guide ? openGuide : undefined} />`.
4. `<ShortcutsModal open={helpOpen} onClose={() => setHelpOpen(false)} />` becomes `<ShortcutsModal open={helpOpen} onClose={() => setHelpOpen(false)} onGuide={guide ? openGuideFromHelp : undefined} />`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/layout/guideEntries.test.ts src/components/tour/anchors.test.ts`
Expected: PASS

- [ ] **Step 10: Run the full checks**

Run: `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build`
Expected: all pass

- [ ] **Step 11: Commit**

```bash
git add frontend/src/components/tour/hooks.ts frontend/src/components/layout/HeaderSettings.tsx frontend/src/components/layout/AppHeader.tsx frontend/src/components/layout/TrackActions.tsx frontend/src/components/layout/ShortcutsModal.tsx frontend/src/App.tsx frontend/src/components/layout/guideEntries.test.ts frontend/src/components/tour/anchors.test.ts
git commit -m "Tour: «Інструкція» in the ⋯ menu, the desktop header and the shortcuts dialog; full anchors check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Docs

**Files:**
- Modify: `docs/SPEC.md` (insert before `### Tempo`, after the "Keep the screen on" section at lines 163–166), `README.md` (`## Як користуватись` before `### Гарячі клавіші`, line 242; the structure tree, lines 381–398)

**Interfaces:**
- Consumes: the names produced by Tasks 1–13.
- Produces: documentation only.

- [ ] **Step 1: `docs/SPEC.md` — a "Guide / tour" section**

Insert before `### Tempo`:

```markdown
### Guide / tour (`src/lib/tour`, `src/components/tour`)

A guided tour over the real controls: a full-screen layer (`z-[75]`, above Modal / Floating `z-[60]` and the Toaster `z-[70]`, below the drop overlay `z-[80]`) dims the page ~60 % around a rounded cut-out (6 px padding, accent ring) and shows a bubble (title, 1–3 sentences, key chips on fine pointers, «3 / 10», «Назад» / «Далі» → «Готово» / «Пропустити»). It never opens menus or popovers. Design: `docs/superpowers/specs/2026-10-06-onboarding-tour-design.md`.

- **Tours** (`lib/tour/tours.ts`): Home (`home`, 8 steps), Song (`track` + `demo`, one seen flag, 12; 13 on phones), Score (the «Ноти» view, 5), Live keys (the «Живе фортепіано» panel, 4), Listen (`listen`, 6), YouTube (`capture`, 4 where the tab can be heard, else 2). A step names `data-tour` anchors (43 ids); its spotlight is the union of the visible ones. Conditions read flags the page reports (`useTourFlags`: `phone`, `touch`, `demo`, `cloudInvite`, `canListenInTab`, `libraryEmpty` / `libraryList`, `hasChords`, `sheetView`, `scoreRendered`, `keysPanel`, `keysReady`); conditions and anchor presence are re-evaluated at every step change; steps without anchors and `centre` steps without their anchors are centred cards. Texts: `src/i18n/tour.ts` (`tour.<tour>.<step>.title` / `.text[.demo|.touch|.noTab]`).
- **Anchors**: `data-tour="<id>"` on existing elements, the first *visible* match wins (copies hidden for the other breakpoint are skipped); `data-tour-until="<selector>"` ends an anchor's box at its first match (a heading with its first row); `data-tour-avoid` keeps the bubble clear (the floating video); `data-tour-top` adds to the top inset (the video docked on phones). `components/tour/anchors.test.ts` checks every anchor exists in the code.
- **Auto-start** (`lib/tour/trigger.ts`, `components/tour/hooks.ts` `useTourTrigger(tourId, ready, recording)`): once per device, ~500 ms after the screen is ready (Home: connection settled, auth ready, library loaded or failed, no link / file on its way and an empty link field — `useTourBlock`; Song: track loaded; Score: header shown; Live keys: notes ready, never the demo; Listen / YouTube: capture phase `idle`, YouTube's player loaded) and the page is quiet (no `aria-modal`, `[role=menu]` or `[aria-expanded=true]`, no text being typed — an empty focused field does not count —, the song not playing, no recording, the page visible). One tour at a time; a due tour waits and re-checks after the running one closes.
- **Behaviour**: starting on `track` / `demo` pauses the song and sets `followPaused`, restored on close; a recording keeps running. Any route change closes the tour unseen and drops chained tours. The root is `role="dialog"` + `aria-modal="true"` (the hotkeys, the home paste handler and `DropOverlay` stay quiet; a dropped file is still swallowed); → / ← / Enter / Space / Esc and Tab are handled in a capture listener on `window`; focus starts on «Далі», is trapped in the bubble and returns on close. An anchor counts as gone after 300 ms (a `centre` step stays as a card, others move on). Desktop: the bubble sits below or above the spotlight, ≥ 8 px above `--player-h`; phones (< 640 px) dock it at the bottom; spotlights taller than the free area dock it too. `prefers-reduced-motion`: no transitions, no smooth scrolling.
- **Seen state** (`lib/tour/storage.ts`): `localStorage["chords-listener-tours"] = { "<tourId>": true }`, device-local (not in `SYNCED_KEYS`, nothing in Firestore), try/catch everywhere. «Готово», «Пропустити», Esc and running out of steps mark it seen; a tour with no available step does not open and is not marked.
- **Re-opening** («Інструкція» / "Guide"): the ⋯ menu (phones: every route, after the shortcuts; desktop: track pages), a desktop header `IconButton` (lucide `CircleHelp`) after the shortcuts button, and a line at the bottom of the shortcuts dialog (starts once the dialog has left the page). Hidden on `job` / `notFound` and while a song loads or fails. It runs the current screen's tour (track / demo: Score in «Ноти», else Song); with the live piano on screen, Live keys follows after «Готово» («Пропустити» / Esc end both).
```

- [ ] **Step 2: `README.md` — the feature and the structure**

1. In `## Як користуватись`, before `### Гарячі клавіші` (line 242), insert:

```markdown
### Інструкція

Коли вперше відкриваєш головну, сторінку пісні, ноти, живе фортепіано, «Слухати» чи відео з YouTube, сайт сам проведе тебе по кнопках: підсвітить кожну й коротко пояснить, що вона робить і що означають значення. «Пропустити» чи Esc закривають огляд, і сам він більше не зʼявиться (запамʼятовується лише на цьому пристрої). Повторити його можна будь-коли: «Інструкція» в меню ⋯, кнопка зі знаком питання в шапці на компʼютері або рядок унизу вікна гарячих клавіш.
```

2. In the structure tree, replace the line

```
│       │   └── history/     список «Нещодавні»
```

with

```
│       │   ├── history/     список «Нещодавні»
│       │   └── tour/        інструкція поверх сторінки: підсвітка, підказка, клавіші
```

and after the line `│       ├── lib/score/       ноти: …` add

```
│       ├── lib/tour/        інструкція: кроки, умови показу, автозапуск, «вже бачив»
```

- [ ] **Step 3: Run the full checks**

Run: `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build`
Expected: all pass

- [ ] **Step 4: Commit**

```bash
git add docs/SPEC.md README.md
git commit -m "Docs: the guided tour — SPEC section, README feature and structure

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Browser verification of the acceptance criteria

**Files:**
- No source changes expected. If a criterion fails, fix it in the file of the task that owns it, add a test there that reproduces the failure, run the full checks, and commit as `Tour: fix <what> (browser check)` with the attribution line.

**Interfaces:**
- Consumes: the built app.
- Produces: a pass / fail line per criterion in the final report.

- [ ] **Step 1: Build the hosted build and a test song**

Run:

```bash
cd frontend && VITE_BASE=/chords-listener/ npx vite build
ffmpeg -f lavfi -i "sine=frequency=261.63:duration=30" -f lavfi -i "sine=frequency=329.63:duration=30" -f lavfi -i "sine=frequency=392:duration=30" -filter_complex "amix=inputs=3" -y dist-pages/tour-test.wav
```

Expected: build succeeds; `frontend/dist-pages/tour-test.wav` exists (gitignored build output, a 30 s C major chord).

- [ ] **Step 2: Open the preview**

Start the preview with the Browser tool `preview_start` and `name: "pages-preview"` (port 4173; never 5173), then navigate to `http://localhost:4173/chords-listener/`. With `javascript_tool` run `localStorage.removeItem('chords-listener-tours'); location.reload()`.

- [ ] **Step 3: AC1 — Home at 1280 px as a guest**

`resize_window` width 1280, height 800. Expected: ~0.5 s after «Нещодавні» / the demo card appears, the Home tour opens at «1 / N» with «Привіт! Це Chords Listener»; the cut-out moves to the link field, «Файл / Слухати», the demo link, the mode chip, «Увійти» (when a cloud is configured), and the header settings group. Press → through it; «Готово» closes it. Reload: it does not open again (`localStorage['chords-listener-tours']` contains `"home":true`).

- [ ] **Step 4: AC2 — Home at 375 px**

Clear storage (Step 2 snippet), `resize_window` preset `mobile`, reload. Expected: the bubble docks at the bottom (16 px gutters), no key chips anywhere, step 2 shows the touch text (no Ctrl/⌘+V), the last step spotlights ⋯. Screenshot each step.

- [ ] **Step 5: AC3 — `#/demo` at 1280 px and 375 px**

At 1280: navigate to `#/demo`. Expected: once the track loads the Song tour opens, the player shows ▶ (paused), steps 1 and 12 use the demo texts («У демо немає запису…»), 12 steps. Finish it. At 375 (clear storage first): the same tour has 13 steps; step 4 is «Тональність» then «Спростити й знаки», each spotlighting its half of the toolbar strip (scrolled sideways into view).

- [ ] **Step 6: AC4 — Score**

On `#/demo` (Song tour seen) switch the view to «Ноти». Expected: the Score tour opens once; on «Складний» (demo: notes unavailable) there are 4 steps; switch the level to «Спрощений», clear `score` from the seen map (`localStorage` edit), switch views away and back: 5 steps, the last spotlights the notation (tall: the bubble docks at the bottom).

- [ ] **Step 7: AC5 — Live keys on a real track, after the Song tour; Song step 4 with the piano panel**

At 1280 × 800 on `#/demo` (Song tour seen), switch the view back to «Акорди» and pick «Фортепіано» first (live piano is on by default; the demo never starts Live keys — its notes are unavailable). Then in `javascript_tool` remove the Song tour from the seen map and drop the test song (the drop overlay works on every page):

```js
const seen = JSON.parse(localStorage.getItem('chords-listener-tours') ?? '{}')
delete seen.song
localStorage.setItem('chords-listener-tours', JSON.stringify(seen))
const blob = await fetch('/chords-listener/tour-test.wav').then((r) => r.blob())
const dt = new DataTransfer()
dt.items.add(new File([blob], 'tour-test.wav', { type: 'audio/wav' }))
window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
```

Expected: on the track page the Song tour opens, and Live keys does not open while it runs (even after the notes are ready). On step 4 («Тональність і запис акордів»), with the live-piano panel between the hero and the toolbar: the cut-out includes the key badge (`song.key`), the hero is still on screen, and the toolbar does not show the mini "now → next". About 0.5 s after «Готово» (or «Пропустити»), once the notes are ready, the Live keys tour opens (canvas, ▼/▲, «Синхронізація», and «Відокремити голос» only if offered).

- [ ] **Step 8: AC6 — inertness and restore**

During any tour: click the spotlighted control (nothing happens), press Space / V / S (no playback, no view change). Esc with a Floating panel open: on `#/demo` at 1280 px open ⚙ «Налаштування вигляду» in the toolbar (a Floating panel), then start the tour without a pointer press (a click outside would close the panel) — `javascript_tool`: `document.querySelector('[aria-label="Інструкція"]').click()` — and press Esc. Expected: the tour closes and is marked seen, the panel is still open; a second Esc closes the panel. On a song page with follow on: start the tour from «Інструкція», close it — `useChordUi` following resumes (the page follows playback again when you press Space). Drag a file over the window during a tour: no drop overlay, the page stays.

- [ ] **Step 9: AC7 — re-open entries**

Desktop: the header `CircleHelp` button and the shortcuts dialog line («Інструкція») start the current screen's tour on `#/`, `#/demo`, `#/listen`; the track page ⋯ has «Інструкція» last. Phone width: ⋯ has «Інструкція» after «Гарячі клавіші» on every route. On `#/job/x` and `#/nope` none of the three entries exists (check with `find "Інструкція"`).

- [ ] **Step 10: AC8 — Listen and YouTube**

Desktop Chrome: `#/listen` → the Listen tour (sources, Почати, then centred cards for the live parts). `#/listen/youtube/dQw4w9WgXcQ` → after the player loads, 4 steps ending on the centred «Зупинити й зберегти» card. Phone width (mobile preset, reload): Listen's first step says the tab works in Chrome / Edge on a computer; YouTube shows 2 steps (video, then the «Тут звук вкладки не послухати» card).

- [ ] **Step 11: AC9 — themes, languages, console**

Repeat one Home and one Song step in light and dark themes and in English (switch language before starting the tour). Expected: readable bubble and ring in both themes, English texts everywhere, `read_console_messages` with `onlyErrors: true` shows nothing from the tour. Reset the viewport with `resize_window` preset `desktop`.

- [ ] **Step 12: Final checks**

Run: `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build`
Expected: all pass. Report each criterion 1–9 as pass / fail with the screenshot that shows it.
```

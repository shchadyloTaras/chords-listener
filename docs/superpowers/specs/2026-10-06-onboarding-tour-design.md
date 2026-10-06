# Onboarding tour — Design

**Date:** 2026-10-06 · **Status:** approved in chat (both sections, in summary form), awaiting
written-spec review. Details added while writing it up are marked *(added)*.

## Intent

The owner asked: the first time someone opens the app, walk them through what each button does and
what each displayed value means; the same guide must open again whenever they want it. Done when the
acceptance criteria at the end pass.

Decisions taken with the owner:

1. A **tour over the real controls** (spotlight + bubble), not a separate help page.
2. **Grouped steps**: 8 on Home, 12 on the song page, 4–6 on the smaller screens and panels (one step
   may explain a group of related controls).
3. **Own lightweight component**, no new dependency.
4. The tour list, steps and triggers (section 1) and the look and behaviour (section 2) were approved
   in chat in summary form.

## Global constraints

- Frontend + docs only. Backend, `firestore.rules`, `storage.rules` untouched. No new dependencies.
- Every UI string has `uk` (informal «ти») and `en` entries, in a new `src/i18n/tour.ts` (keys `tour.*`).
- `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build` pass after every task.
- Work on the feature branch; one commit per task; never push or deploy without the owner's go-ahead.
- Match the surrounding code: comment density, naming, pure logic in `lib/`, tests next to code.
- The "seen" state is **device-local**: never in `SYNCED_KEYS` (`lib/syncedSettings.ts`), nothing in
  Firestore.

## 1. Tours and steps

Six tours. Each step names one or more **anchors** (`data-tour="<id>"` on existing elements; 43 ids in
total, listed below). The spotlight is the union of the step's visible anchors, clipped to the visible
box of each anchor's nearest scrolling ancestor and to the viewport. Steps without anchors, and steps
marked *centre* whose anchors are absent, are shown as a centred card.

**Anchors are the smallest stable element that shows the thing**, never an element re-keyed on every
update (e.g. the live chord's wrapper, not its animated child). `song.grid` is the first line of the
sheet, `song.barNumber` is bar 1's number button, `song.legend` is the «Акорди в пісні» heading with
its first row of tiles, `home.library` is the «Нещодавні» heading with its first row. Where an element
is rendered twice (a hidden copy for the other breakpoint), the first *visible* match wins.

**Which steps show.** Bracketed conditions decide whether a step is included. Conditions and anchor
presence are evaluated for every remaining step when the tour starts and again at each step change.
The counter shows the position among the steps included at that moment («3 / 10» when two were left
out); «Готово» replaces «Далі» when no later step is included; «Назад» goes to the previous shown step
and is hidden on the first one.

**Touch devices.** Without a fine pointer (`useIsDesktopPointer()` false) the bubble shows no key chip,
and texts that name keys or hover use a touch variant (home 2: no drag, no Ctrl/⌘+V; song 6: «натисни —
перемотка, затисни — картка акорду, двічі натисни — виправити»; song 12: no key names, no «?»).

### 1.1 Home — route `home` (8 steps)

| # | Anchor(s) | Content |
|---|---|---|
| 1 | — | Welcome: what the app does (chords for any song, in time with the music, copied in one click). |
| 2 | `home.input` | The field: paste a YouTube link, drag a file in, or Ctrl/⌘+V. |
| 3 | `home.sources` | «Файл» and «Слухати»: a microphone or another tab's sound, chords live. |
| 4 | `home.demo` | «Подивитися демо» [library loaded and empty]. |
| 5 | `header.mode` | The mode chip: where songs are analysed (in the browser for guests, in the cloud with an account); in cloud / server mode, the dot: green = connected, amber blinking = waking up. |
| 6 | `header.signin` | «Увійти» [`useCloudInvite()`: a cloud is configured, nobody is signed in, not a same-origin local server]: what a free account adds (more accurate chords, vocals, the library on every device). |
| 7 | `home.library` | «Нещодавні»: your songs [library loaded and not empty]. |
| 8 | `header.settings` (desktop) / `header.more` (phone) | Desktop: language, theme, shortcuts and the «Інструкція» button. Phone: the ⋯ menu with theme, language, shortcuts and «Інструкція». |

### 1.2 Song — routes `track` and `demo` (12 steps; 13 on phones)

| # | Anchor(s) | Content |
|---|---|---|
| 1 | `song.now` | «Зараз грає»: the chord now, «далі» with the beat countdown, the shape; click to hear it. |
| 2 | `song.instrument` | Instrument (I): shapes, chord sound and hints (capo for guitar/ukulele, live piano for keyboards, handpan coverage). |
| 3 | `song.tempo` | Tempo: BPM, the beat dots; inside: ×½/×2, tap (T), metronome (K). |
| 4 | `song.key`, `song.transpose`, `song.simplify`, `song.accidentals` | Key badge (original struck through, new in colour), transpose −/+/0, «Спростити» (S), sharps or flats. *(added)* On phones (< 640 px) this is two steps: `song.key` + `song.transpose`, then `song.simplify` + `song.accidentals`, because the four do not fit the toolbar's visible strip. |
| 5 | `song.views`, `song.follow` | Views «Акорди / Таймлайн / Ноти» (V) and «Слідкувати» (F). |
| 6 | `song.grid` | The chord grid: click a chord to jump there, hold / hover for the chord card, double-click or E to fix it [view = sheet]. |
| 7 | — (centre) | What the marks mean: colour = root note (minor = muted shade of the same colour), dotted underline = the app is unsure, «—» / N = no chord, «/B» = bass note, and the suffixes m, 7, maj7, sus, dim, aug, add9 in a few words. The step has `body: 'chordMarks'`: `tours.ts` only names the body kind; TourHost renders the examples with `ChordName` inside spans coloured by `chordTone(rootPc, quality)` (`lib/music/color.ts`), with `.cw-lowconf` on the unsure example. |
| 8 | `song.barNumber` | Bar numbers: select bars, then «Зациклити» (L) or copy [view = sheet]. |
| 9 | `song.legend` | «Акорди в пісні»: every chord of the song, with its shape when «Показувати аплікатури» is on; click to hear [the song has chords]. |
| 10 | `song.copy` | «Копіювати» (C) and ▾: chord text, PDF, MusicXML, MIDI. |
| 11 | `song.settings` | ⚙ «Налаштування вигляду»: bars per line, shapes, live piano, chord sound, «Не вимикати екран». |
| 12 | `song.player` | The player: Space, ←/→ 5 s, Shift+arrows to the next chord, speed without changing pitch, the coloured chord strip; «?» lists every key and opens this guide. |

`track` and `demo` share one seen flag. On `#/demo` (no audio) steps 1 and 12 use a variant that does
not promise the song plays; chord sounds and the metronome do work there.

### 1.3 Score — the «Ноти» view (5 steps)

Triggered the first time the view's header is shown (the lazy `ScoreView` has mounted; the notes need
not be ready).

`score.parts` (Вокал / Фортепіано) · `score.chords` (chord names above the notes) · `score.level`
(Складний / Середній / Спрощений) · `score.export` (PDF / MusicXML / MIDI) · `score.canvas` (click a
note to play from there) [this step only: the score has rendered — it is left out while the notes are
computing or unavailable, e.g. `#/demo` at «Складний», or when both parts are off].

### 1.4 Live keys — the «Живе фортепіано» panel (4 steps)

Triggered the first time the panel is shown with its notes ready (`notes.status === 'ready'` and at
least one note); it never auto-starts on `#/demo` (no audio). Re-opened where the notes are not ready,
steps 1–2 become one centred card («on your own songs the notes fall onto these keys»).

`keys.canvas` (notes fall and press the keys; colour = the note) · `keys.canvas` again for ▼/▲ (a note
is outside the keyboard) · `keys.sync` («Синхронізація» when the keys are out of time, e.g. Bluetooth) ·
`keys.voice` («Відокремити голос» / the vocals switch) [one of them is shown].

### 1.5 Listen — route `listen` (6 steps)

`listen.sources` (Мікрофон / Вкладка браузера; where the tab cannot be heard — `useCanListenInTab()`
false — the text names only the microphone and says the tab works in desktop Chrome / Edge) ·
`listen.start` («Почати») · `live.chord` *centre* (the big chord: pale = still being refined; striped
bar = not final) · `live.key`, `live.tempo` *centre* (key and ≈BPM) · `live.level` *centre* (green =
fine, amber = loud, red = overload) · `listen.controls` *centre* («Пауза», «Скасувати», «Зупинити й
зберегти»: saving recognises the chords more accurately).

*(added)* Before a recording the live elements do not exist, so steps 3–6 are centred cards; when the
tour is re-opened during a recording they spotlight the real elements.

### 1.6 YouTube in a tab — route `capture`

*(added)* Approved as «guests»; in fact guests and cloud users both reach this page (YouTube links are
never sent to the cloud), so the tour runs for everyone who opens it. Two variants by
`useCanListenInTab()`:

- **The tab can be heard** (desktop Chrome / Edge), 4 steps: `capture.video` (the video plays here, the
  site listens to this tab) · `capture.start` («Почати») · `capture.howto` (the key part: tick «Також
  поділитися звуком вкладки») · `capture.controls` *centre* (what «Зупинити й зберегти» does).
- *(added)* **It cannot** (phones, Safari, Firefox), 2 steps: `capture.video` (the video plays here;
  this browser cannot hear a tab) · `capture.alt` on the «Тут звук вкладки не послухати» card
  (`NoTabCapture`): the microphone with the song playing on another device, a file, or the link opened
  on a computer in Chrome / Edge.

## 2. Look and behaviour

**Overlay.** One full-screen layer at `z-[75]`: above Modal and Floating panels (`z-[60]`) and the
Toaster (`z-[70]`), below the drop overlay (`z-[80]`). A dim (~60 % black) with a rounded cut-out around
the spotlight (padding 6 px) and a thin accent ring. The layer catches every pointer event, so clicking
the dim does nothing and the highlighted control cannot be pressed during the tour.

**Bubble.** App-styled card (surface, border, radius, theme tokens): title, 1–3 sentences, an optional
key chip (`Kbd`), the counter, buttons «Назад», «Далі» (accent; «Готово» when no later step is
included) and «Пропустити». Centred cards use the same bubble without a cut-out.

**Placement.** Desktop (≥ 640 px): the bubble sits below or above the spotlight, whichever fits,
clamped to the viewport; it never overlaps the player bar (its bottom edge stays ≥ 8 px above
`var(--player-h)` and clear of the floating video). Phones: the bubble docks at the bottom above the
player bar, and the page is scrolled so the spotlight sits between the sticky header / toolbar and the
bubble's top edge. *(added)* Short screens (under 500 px tall, e.g. a phone in landscape) dock the
bubble the same way whatever their width, centred and at most 640 px wide: a spotlight centred in so
little height leaves room neither below nor above it. Only the placement changes; the steps stay the
desktop ones. When a spotlight is taller than that free area (e.g. `score.canvas`), the page
scrolls its top to just below the header, the cut-out is clipped to the visible part, and the bubble
docks at the bottom of the free area (on desktop too).

**Movement.**
- Before each step the anchor is scrolled into view on both axes, inner scroll containers included
  (`inline: 'nearest'`). Anchors inside fixed or sticky containers (header, player bar, the stuck
  toolbar) are only scrolled sideways inside their own scroller. Song steps 1–4 scroll to the top first
  (the hero's key and BPM badges exist only while the hero is visible).
- The position is recomputed at most once per animation frame on scroll (capture phase, so inner
  scrollers count), resize, orientation change, and whenever an anchor or `document.body` changes size
  (ResizeObserver).
- An anchor counts as gone only if it is still missing 300 ms after it vanished. Then a *centre* step
  stays open as a centred card and any other step moves on to the next available step.
- *(added)* Starting a tour on `track` / `demo` pauses the song (it stays paused afterwards) and
  suspends following (`followPaused`), restored to its previous value on close. A recording on
  `listen` / `capture` keeps running.
- Leaving the screen during a tour (any route change: browser Back, a link, a pasted or dropped file
  that starts a song) closes it at once without marking it seen, and drops queued tours of the old
  screen. While a tour runs, the home page's paste handler and `DropOverlay` do nothing: they check
  `[aria-modal="true"]` the way the hotkeys do.
- `prefers-reduced-motion`: no animated transitions or smooth scrolling.

**Panels.** The tour never opens menus or popovers (they close on any outside click and keep local
state). It spotlights the button and describes what is inside.

**Keyboard and a11y.** The tour root is `role="dialog"` with `aria-modal="true"`, which mutes the
app's hotkeys through the existing `modalOpen()` checks. Focus starts on «Далі» and is trapped in the
bubble; Enter and Space activate the focused button; → next and ← back work wherever the focus is in
the bubble; Esc closes. These keys are handled in a capture-phase listener on `window` (ahead of the
document-level capture listeners of Floating, Modal, Menu and the mode popover), which stops their
propagation. The step text is announced (`aria-live="polite"`); focus returns to where it was when the
tour closes.

**Auto-start.** A tour starts by itself once per device, ~500 ms after all of these hold:

- its screen is *ready*:
  - Home: the connection is settled (`useConnection` status ≠ `checking`), auth is ready
    (`useAuth.ready`), the library has loaded or failed (after a failure both library steps are left
    out), no link is sending, no file is uploading, and the link field is empty;
  - Song: the track has loaded with no error;
  - Score: the view's header is shown;
  - Live keys: the panel is shown with its notes ready (never on `#/demo`);
  - Listen and YouTube: the capture phase is `idle` (not `requesting`, `error`, `stopping`, `saving`);
    YouTube also needs its player loaded;
- *(added)* no `aria-modal` dialog, menu (`[role="menu"]`) or anchored panel is open (no
  `[aria-expanded="true"]` control in the page), no text is being typed (a focused but empty link field does not count — the home field autofocuses on desktop), the song is not playing,
  no recording or capture is running, and the page is visible.

Only one tour runs at a time. A tour that becomes due while another runs waits; when that one ends, the
queued tour re-checks the conditions above, waits the same 500 ms and starts. It is not marked seen by
the other tour's «Пропустити».

**"Seen" state.** `localStorage["chords-listener-tours"] = { "<tourId>": true }`, every read and write
in try/catch (blocked storage → the tour simply shows again, as `browserNote.ts` does). «Готово»,
«Пропустити», Esc, and running out of available steps mark the tour seen. A tour with no available
step when it becomes due does not open and is not marked seen.

**Re-opening.** «Інструкція» appears in three places:

- the ⋯ menu: on phones on every route, in the settings block of `TrackActions.tsx`; on desktop in the
  ⋯ of `track` pages, outside the `withSettings` block (the desktop header has no ⋯ on home, demo,
  listen or capture);
- a header button on desktop: an `IconButton` labelled «Інструкція» / "Guide" (lucide `CircleHelp`),
  right after `HelpButton` in `HeaderSettings.tsx`;
- a line at the bottom of `ShortcutsModal` (an «Інструкція» button), which closes the dialog and starts
  the tour once the dialog has left the DOM.

The entries are hidden on routes without a tour (`job`, `notFound`) and on a track page while it loads
or shows its error. Each runs the current screen's tour: home → Home; listen → Listen; capture →
YouTube; track / demo → Score when the «Ноти» view is active, otherwise Song. *(added)* When the live
keys panel is visible, the Live keys tour follows the Song or Score tour if that one ended with
«Готово»; «Пропустити» or Esc ends both.

## 3. Structure

- `src/lib/tour/` (pure, tested): tour definitions (`tours.ts`: ids, steps, anchors, conditions,
  *centre* flags, body kinds, i18n keys incl. touch / demo / no-tab variants), the step machine
  (`machine.ts`: filtering, next / back, vanished anchors, close reasons, the queue), the auto-start gate
  and the re-open mapping (`trigger.ts`), storage (`storage.ts`).
- `src/components/tour/`: `TourHost.tsx` (overlay, cut-out, bubble, placement, focus, keys), mounted
  once in `App.tsx`; a small zustand store for the running tour and the queue; a hook for screens to
  report readiness (`useTourTrigger(tourId, ready)`); `startCurrentTour()` for the re-open entries.
- `data-tour` attributes on the 43 anchor ids of section 1.
- `src/i18n/tour.ts`: every title and text, uk + en.

## 4. Tests

Written first (red), in the repo's vitest layout:

- `lib/tour/machine`: step filtering by condition and anchor presence; counter and «Готово» placement;
  back / next at the ends; a vanished anchor (300 ms) vs *centre* fallback; running out of steps marks
  seen; no available step → not opened, not seen; route change closes without marking seen; queue.
- `lib/tour/trigger`: the auto-start gate — not before ready, not while an `aria-modal` / menu /
  expanded control is open, focus is in a text field, the song plays, a recording runs or the page is
  hidden; starts 500 ms after the last condition clears; never once seen. The re-open mapping: home,
  listen, capture (both variants), track / demo × view ∈ {sheet, timeline, score} × live keys on / off;
  `job` / `notFound` → none.
- `lib/tour/storage`: read / write, and both throwing.
- A static test that every anchor id in `tours.ts` exists as a `data-tour="…"` in `src/`.
- `i18n/tour.test.ts`: every `tour.*` key has a non-empty uk and en entry (the repo has no i18n
  completeness test today).
- `TourHost`: renders the bubble and counter; keys (→ ← Enter Space Esc) incl. with a Floating panel
  open; focus trap and restore; `aria-modal`; the paste handler and DropOverlay inert during a tour.

## 5. Acceptance criteria

1. Clean storage, `#/` as a guest at 1280 px: the Home tour opens ~0.5 s after the library has loaded;
   «Готово» closes it; after a reload it does not open again.
2. The same at 375 px: the bubble docks at the bottom above the player, there are no key chips, and
   step 8 spotlights ⋯.
3. `#/demo` at 1280 px and 375 px: the Song tour opens once the track has loaded, the song is paused,
   no text promises sound; on a phone step 4 is two steps.
4. Switching to «Ноти» opens the Score tour once; the canvas step appears only when the score has
   rendered.
5. On a real track with a keyboard instrument and live keys on, the Live keys tour opens once, after
   any running tour, once the notes are ready.
6. During any tour: clicks on the page do nothing, the app's hotkeys and the home paste / drop do
   nothing, Esc closes the tour even with a Floating panel open; after it, everything works again and
   following is back to its previous state.
7. «Інструкція» from the ⋯ menu, the desktop header button and the shortcuts dialog each start the
   current screen's tour; they are hidden on the processing and not-found pages.
8. Listen and YouTube tours behave as in 1.5 / 1.6 in desktop Chrome and at phone width.
9. Light and dark themes, uk and en, no console errors; the checks pass.

## 6. Docs

`docs/SPEC.md` (a "Guide / tour" section: tours, triggers, storage, re-open entry points) and
`README.md` (feature list, `src/lib/tour`, `src/components/tour`).

## Out of scope

Syncing the seen state across devices, analytics, animated or video illustrations, tours for the job
(processing) page and the sign-in dialog, opening panels from the tour, re-showing a tour after its
content changes (no versions).

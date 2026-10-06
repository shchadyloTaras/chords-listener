# Onboarding tour — Design

**Date:** 2026-10-06 · **Status:** approved in chat (both sections), awaiting written-spec review

## Intent

The owner asked: the first time someone opens the app, walk them through what each button does and
what each displayed value means; the same guide must open again whenever they want it. Done when a
first-time visitor gets a short guided tour on each main screen, every tour can be re-opened from the
menu, the tours work on phones and desktops in both themes and both languages, and the checks pass.

Decisions taken with the owner:

1. A **tour over the real controls** (spotlight + bubble), not a separate help page.
2. **Grouped steps, 8–12 per screen** (one step may explain a group of related controls).
3. **Own lightweight component**, no new dependency.
4. The tour list, the steps and their trigger moments below (section 1) and the look and behaviour
   (section 2) were approved as written here.

## Global constraints

- Frontend + docs only. Backend, `firestore.rules`, `storage.rules` untouched. No new dependencies.
- Every UI string has `uk` (informal «ти») and `en` entries, in a new `src/i18n/tour.ts` (keys `tour.*`).
- `cd frontend && npx tsc -b && npx vitest run && npx oxlint && npx vite build` pass after every task.
- Work on the feature branch; one commit per task; never push or deploy without the owner's go-ahead.
- Match the surrounding code: comment density, naming, pure logic in `lib/`, tests next to code.
- The "seen" state is **device-local**: never in `SYNCED_KEYS` (`lib/syncedSettings.ts`), nothing in
  Firestore.

## 1. Tours and steps

Six tours. Each step names one or more **anchors** (`data-tour="<id>"` attributes added to existing
elements). The spotlight is the bounding box of the step's visible anchors. When a step's anchors are
all missing or hidden, the step is **skipped** unless it says *centre*, in which case it is shown as a
centred card without a spotlight. Steps without anchors are centred cards.

Conditions in brackets decide whether a step is included at all (evaluated when the step is reached).

### 1.1 Home — route `home` (8 steps)

| # | Anchor(s) | Content |
|---|---|---|
| 1 | — | Welcome: what the app does (chords for any song, in time with the music, copied in one click). |
| 2 | `home.input` | The field: paste a YouTube link, drag a file in, or Ctrl/⌘+V. |
| 3 | `home.sources` | «Файл» and «Слухати»: a microphone or another tab's sound, chords live. |
| 4 | `home.demo` | «Подивитися демо» [library empty]. |
| 5 | `header.mode` | The mode chip: where songs are analysed (browser for guests, cloud with an account); the dot's colour. |
| 6 | `header.signin` | «Увійти» [guest]: what a free account adds (more accurate chords, vocals, library on every device). |
| 7 | `home.library` | «Нещодавні»: your songs [library not empty]. |
| 8 | `header.settings` (desktop) / `header.more` (phone) | Language, theme, the ⋯ menu, and where to open this guide again. |

### 1.2 Song — routes `track` and `demo` (12 steps)

| # | Anchor(s) | Content |
|---|---|---|
| 1 | `song.now` | «Зараз грає»: the chord now, «далі» with the beat countdown, the shape; click to hear it. |
| 2 | `song.instrument` | Instrument (I): shapes, chord sound and hints (capo for guitar/ukulele, live piano for keyboards, handpan coverage). |
| 3 | `song.tempo` | Tempo: BPM, the beat dots; inside: ×½/×2, tap (T), metronome (K). |
| 4 | `song.key`, `song.transpose`, `song.simplify`, `song.accidentals` | Key badge (original struck through, new in colour), transpose −/+/0, «Спростити» (S), sharps or flats. |
| 5 | `song.views`, `song.follow` | Views «Акорди / Таймлайн / Ноти» (V) and «Слідкувати» (F). |
| 6 | `song.grid` | The chord grid: click a chord to jump there, hold / hover for the chord card, double-click or E to fix it [view = sheet]. |
| 7 | — (centre) | What the marks mean: colour = root note (minor = muted shade of the same colour), dotted underline = the app is unsure, «—» / N = no chord, «/B» = bass note, and the suffixes m, 7, maj7, sus, dim, aug, add9 in a few words. Rendered with the real `ChordName` component for the examples. |
| 8 | `song.barNumber` | Bar numbers: select bars, then «Зациклити» (L) or copy [view = sheet]. |
| 9 | `song.legend` | «Акорди в пісні»: every shape; click to hear [diagrams shown and the song has chords]. |
| 10 | `song.copy` | «Копіювати» (C) and ▾: chord text, PDF, MusicXML, MIDI. |
| 11 | `song.settings` | ⚙ «Налаштування вигляду»: bars per line, shapes, live piano, chord sound, «Не вимикати екран». |
| 12 | `song.player` | The player: Space, ←/→ 5 s, Shift+arrows to the next chord, speed without changing pitch, the coloured chord strip; «?» lists every key and opens this guide. |

On `#/demo` (no audio) the texts must not promise that the song plays; chord sounds and the metronome
do work there.

### 1.3 Score — the «Ноти» view (5 steps), first time the view is shown

`score.parts` (Вокал / Фортепіано) · `score.chords` (chord names above the notes) · `score.level`
(Складний / Середній / Спрощений) · `score.export` (PDF / MusicXML / MIDI) · `score.canvas` (click a
note to play from there) [score rendered].

### 1.4 Live keys — the «Живе фортепіано» panel (4 steps), first time the panel is shown

`keys.canvas` (notes fall and press the keys; colour = the note) · `keys.canvas` again for ▼/▲ (a note
is outside the keyboard) · `keys.sync` («Синхронізація» when the keys are out of time, e.g. Bluetooth) ·
`keys.voice` («Відокремити голос» / the vocals switch) [one of them is shown].

### 1.5 Listen — route `listen` (6 steps)

`listen.sources` (Мікрофон / Вкладка браузера) · `listen.start` («Почати») · `live.chord` *centre* (the
big chord: pale = still being refined; striped bar = not final) · `live.key`, `live.tempo` *centre*
(key and ≈BPM) · `live.level` *centre* (green = fine, amber = loud, red = overload) · `listen.controls`
*centre* («Пауза», «Скасувати», «Зупинити й зберегти»: saving recognises the chords more accurately).

Before a recording the live elements do not exist, so steps 3–6 are centred cards; when the tour is
re-opened during a recording they spotlight the real elements.

### 1.6 YouTube in a tab — route `capture` (4 steps)

`capture.video` (the video plays here, the site listens to this tab) · `capture.start` («Почати») ·
`capture.howto` (the key part: tick «Також поділитися звуком вкладки») · `capture.controls` *centre*
(what «Зупинити й зберегти» does).

## 2. Look and behaviour

**Overlay.** One full-screen layer: a dim (~60 % black) with a rounded cut-out around the spotlight
(padding 6 px) and a thin accent ring. The layer catches every pointer event, so clicking the dim does
nothing and the highlighted control cannot be pressed during the tour.

**Bubble.** App-styled card (surface, border, radius, tokens for both themes): title, 1–3 sentences,
an optional key chip (`Kbd`), the counter «3 / 12», buttons «Назад», «Далі» (accent; «Готово» on the
last step) and «Пропустити». Centred cards use the same bubble without a cut-out.

**Placement.** Desktop (≥ 640 px): next to the spotlight, below or above whichever fits, clamped to the
viewport and always above the fixed player bar (`--player-h`) and the bottom overlays. Phones: the
bubble docks at the bottom above the player bar, and the spotlight is scrolled into the space above it.

**Movement.** Before each step the anchor is scrolled into view (`block: 'center'`; steps 1–4 of the
song tour scroll to the top first, because the hero badges exist only while the hero is visible).
Position is recomputed on scroll, resize and orientation change. If an anchor disappears mid-step, the
tour moves on to the next available step. `prefers-reduced-motion`: no animated transitions.

**Panels.** The tour never opens menus or popovers (they close on any outside click and keep local
state). It spotlights the button and describes what is inside.

**Keyboard and a11y.** The tour root is `role="dialog"` with `aria-modal="true"` (this also mutes the
app's hotkeys through the existing `modalOpen()` checks). → / Enter: next, ←: back, Esc: close. Focus
moves into the bubble and is trapped there; the step text is announced (`aria-live="polite"`). Focus
returns to where it was when the tour closes.

**Auto-start.** A tour starts by itself once per device when its screen is shown and *ready*: the page
has loaded (track loaded, no error, score rendered, panel visible), no other `aria-modal` dialog is
open, no recording or capture is running, and the page is visible. It starts ~500 ms after it becomes
ready. Only one tour runs at a time; a tour that becomes due while another runs waits for it to end.

**"Seen" state.** `localStorage["chords-listener-tours"] = { "<tourId>": <tourVersion> }`, every read
and write in try/catch (blocked storage → the tour simply shows again, as `browserNote.ts` does).
«Готово», «Пропустити» and Esc mark the tour seen. A tour whose stored version is lower than its
current version shows again (lets a later release re-show a changed tour).

**Re-opening.** «Інструкція» in the ⋯ menu (phones: every route, in the settings block of
`TrackActions.tsx`; desktop: the track pages' ⋯), a header button next to the shortcuts button on
desktop (`HeaderSettings.tsx` `HelpButton`), and a line in `ShortcutsModal`. All of them run the
current screen's tour: home → Home; listen → Listen; capture → YouTube; track / demo → Score when
the «Ноти» view is active, otherwise Song, followed by Live keys when that panel is visible.

## 3. Structure

- `src/lib/tour/` (pure, tested): tour definitions (`tours.ts`: ids, versions, steps, anchors,
  conditions, *centre* flags, i18n keys), the step machine (`machine.ts`: next / back / skip-missing /
  close, queueing), storage (`storage.ts`).
- `src/components/tour/`: `TourHost.tsx` (overlay, cut-out, bubble, placement, focus, keys), mounted once
  in `App.tsx`; a small store (zustand, like the others) for the running tour and the queue; a hook
  for screens to report readiness (`useTourTrigger(tourId, ready)`); `startCurrentTour()` for the menu
  items.
- `data-tour` attributes on about 35 existing elements. Where an element is rendered twice (hidden
  duplicate for another breakpoint), the first *visible* match wins.
- `src/i18n/tour.ts`: every title and text, uk + en.

## 4. Tests

Written first (red), in the repo's vitest layout:

- `lib/tour`: step filtering by condition; skip-missing vs *centre* fallback; back / next at the ends;
  queueing; versions; storage throwing on read and write.
- A static test that every anchor id used in `tours.ts` exists as a `data-tour="…"` in `src/` (catches a
  renamed or deleted control).
- `TourHost`: renders the bubble and counter, keyboard (→ ← Enter Esc), focus trap and restore,
  `aria-modal`, marks seen on close.
- Every `tour.*` key has a non-empty uk and en entry (new `i18n/tour.test.ts`; the repo has no i18n
  completeness test today).
- Manual check in the browser: every tour at 375 px and 1280 px, light and dark, uk and en, on
  `#/demo` and a real track; the hotkeys stay muted during a tour and work after it.

## 5. Docs

`docs/SPEC.md` (a "Guide / tour" section: tours, triggers, storage, re-open entry points) and
`README.md` (feature list, `src/lib/tour`, `src/components/tour`).

## Out of scope

Syncing the seen state across devices, analytics, animated or video illustrations, tours for the job
(processing) page and the sign-in dialog, opening panels from the tour.

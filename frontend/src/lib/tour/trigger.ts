// When a tour starts by itself and which tour the «Інструкція» entries open (spec §2 "Auto-start" and
// "Re-opening"). Pure; components/tour/hooks.ts feeds it the page's state.
import type { Route } from '../../hooks/useRoute'
import type { ChordView } from '../../store'
import type { NotesState } from '../transcription'
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

/** Live keys: the panel's notes are ready with at least one note (the demo stays "unavailable"). */
export function keysNotesReady(notes: NotesState): boolean {
  return notes.status === 'ready' && notes.index.count > 0
}

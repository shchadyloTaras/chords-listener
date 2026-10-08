// The guided tours (docs/superpowers/specs/2026-10-06-onboarding-tour-design.md §1): their steps, the
// `data-tour` anchors each step spotlights, when a step is included, and the i18n keys of its texts.
// Pure data and small helpers; the step logic is in machine.ts, the page side in components/tour.

export type TourId = 'home' | 'song' | 'score' | 'keys' | 'listen' | 'capture' | 'clip'
export const TOUR_IDS: readonly TourId[] = ['home', 'song', 'score', 'keys', 'listen', 'capture', 'clip']

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
  /** the Listen page records the microphone (no live chords: they come from the analysis afterwards) */
  | 'listenMic'
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
export type TextVariant = 'demo' | 'touch' | 'noTab' | 'mic'
export const VARIANT_CONDITION: Record<TextVariant, Condition> = {
  demo: 'demo',
  touch: 'touch',
  noTab: '!canListenInTab',
  mic: 'listenMic',
}

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
  // §1.5 — route `listen`; the live elements exist only during a recording, and the microphone has
  // no live chord, key or tempo (it is only recorded)
  listen: {
    id: 'listen',
    steps: [
      { id: 'sources', anchors: ['listen.sources'], variants: ['noTab'] },
      { id: 'start', anchors: ['listen.start'], variants: ['mic'] },
      { id: 'chord', anchors: ['live.chord'], when: ['!listenMic'], centre: true },
      { id: 'keyTempo', anchors: ['live.key', 'live.tempo'], when: ['!listenMic'], centre: true },
      { id: 'level', anchors: ['live.level'], centre: true },
      { id: 'controls', anchors: ['listen.controls'], variants: ['mic'], centre: true },
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
  // route `clip` (docs/superpowers/specs/2026-10-07-youtube-warp-fetch-design.md): the window, «Звідси»,
  // «Прослухати», «Розібрати акорди»
  clip: {
    id: 'clip',
    steps: [
      { id: 'window', anchors: ['clip.window'], variants: ['touch'] },
      { id: 'from', anchors: ['clip.from'] },
      { id: 'preview', anchors: ['clip.preview'] },
      { id: 'analyze', anchors: ['clip.analyze'] },
    ],
  },
}

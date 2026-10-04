import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Track } from './types'

/** Implemented by the Shell's player (HTML audio or YouTube iframe). */
export interface PlayerController {
  play(): void
  pause(): void
  seek(time: number): void
  setRate(rate: number): void
  setVolume(volume: number): void
  getTime(): number
}

export type Instrument = 'guitar' | 'ukulele' | 'piano' | 'handpan'
export type Accidentals = 'auto' | 'sharp' | 'flat'
export type ChordView = 'sheet' | 'timeline'
export type ThemePref = 'dark' | 'light' | 'system'
export type Lang = 'uk' | 'en'
export type CopyFormat = 'bars' | 'timestamps' | 'chordpro' | 'unique'

export interface Toast {
  id: number
  message: string
  kind: 'success' | 'error' | 'info'
  /** optional action button (e.g. Undo) */
  action?: { label: string; run: () => void }
}

export interface Loop {
  start: number
  end: number
}

/** Persisted user preferences. */
export interface Settings {
  transpose: number // -11..11
  simplify: boolean
  accidentals: Accidentals
  instrument: Instrument
  view: ChordView
  barsPerLine: number // 2 | 4 | 8
  follow: boolean
  showDiagrams: boolean
  copyFormat: CopyFormat
  theme: ThemePref
  lang: Lang
  volume: number // 0..1
  muted: boolean
  playbackRate: number // 0.5..1.5
  showVideo: boolean
  /** handpan scale preset id ('custom' = the user's own notes below) */
  handpanScale: string
  /** user's own handpan: [ding, ...tone fields in physical order around the instrument] */
  handpanNotes: string[]
  /** beat-synced metronome click */
  metronome: boolean
  metronomeVolume: number // 0..2 (up to 200%)
  /** per-track tempo correction factor (0.5 | 1 | 2), keyed by track id */
  tempoFactors: Record<string, number>
  /** local chord server used when the page is not served by it (e.g. GitHub Pages) */
  serverUrl: string
  /** clicking a chord plays its sound (explicit play buttons always play) */
  chordSound: boolean
  chordSoundVolume: number // 0..1
  /** live piano (transcribed notes lighting the keys) shown under the hero when the instrument is piano */
  liveKeys: boolean
  /** manual audio/visual sync correction for the live piano, ms (positive = keys light later) */
  syncOffsetMs: number
}

export interface AppState extends Settings {
  // ---- track ----
  track: Track | null
  setTrack(track: Track | null): void

  // ---- playback (pushed by the player) ----
  currentTime: number
  duration: number
  isPlaying: boolean
  controller: PlayerController | null
  registerController(c: PlayerController | null): void
  setPlayback(p: Partial<Pick<AppState, 'currentTime' | 'duration' | 'isPlaying'>>): void
  play(): void
  pause(): void
  toggle(): void
  seek(time: number): void
  loop: Loop | null
  setLoop(loop: Loop | null): void

  // ---- settings ----
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void
  setTranspose(n: number): void

  // ---- toasts ----
  toasts: Toast[]
  toast(message: string, kind?: Toast['kind'], action?: Toast['action']): void
  dismissToast(id: number): void
}

const defaultSettings: Settings = {
  transpose: 0,
  simplify: false,
  accidentals: 'auto',
  instrument: 'guitar',
  view: 'sheet',
  barsPerLine: 4,
  follow: true,
  showDiagrams: true,
  copyFormat: 'bars',
  theme: 'dark',
  lang: 'uk',
  volume: 1,
  muted: false,
  playbackRate: 1,
  showVideo: false,
  handpanScale: 'custom',
  handpanNotes: ['A', 'D', 'F', 'A', 'C', 'G', 'E', 'C', 'A'],
  metronome: false,
  metronomeVolume: 1,
  tempoFactors: {},
  serverUrl: 'http://localhost:8765',
  chordSound: true,
  chordSoundVolume: 0.8,
  liveKeys: true,
  syncOffsetMs: 0,
}

let toastSeq = 1

/** Wrap into -11..11 (12 semitones up == original key). */
function clampTranspose(n: number): number {
  return (Math.round(n) % 12) || 0
}

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      ...defaultSettings,

      track: null,
      setTrack: (track) =>
        set({ track, currentTime: 0, isPlaying: false, loop: null, duration: track?.duration ?? 0 }),

      currentTime: 0,
      duration: 0,
      isPlaying: false,
      controller: null,
      registerController: (controller) => set({ controller }),
      setPlayback: (p) => set(p),
      play: () => get().controller?.play(),
      pause: () => get().controller?.pause(),
      toggle: () => (get().isPlaying ? get().pause() : get().play()),
      seek: (time) => {
        const d = get().duration || get().track?.duration || 0
        const t = Math.max(0, d ? Math.min(time, d) : time)
        get().controller?.seek(t)
        set({ currentTime: t })
      },
      loop: null,
      setLoop: (loop) => set({ loop }),

      setSetting: (key, value) => set({ [key]: value } as Partial<AppState>),
      setTranspose: (n) => set({ transpose: clampTranspose(n) }),

      toasts: [],
      toast: (message, kind = 'success', action) => {
        const id = toastSeq++
        set({ toasts: [...get().toasts.slice(-3), { id, message, kind, action }] })
        window.setTimeout(() => get().dismissToast(id), action ? 6000 : 2400)
      },
      dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
    }),
    {
      name: 'chords-listener-settings',
      version: 1,
      partialize: (s): Settings => ({
        transpose: s.transpose,
        simplify: s.simplify,
        accidentals: s.accidentals,
        instrument: s.instrument,
        view: s.view,
        barsPerLine: s.barsPerLine,
        follow: s.follow,
        showDiagrams: s.showDiagrams,
        copyFormat: s.copyFormat,
        theme: s.theme,
        lang: s.lang,
        volume: s.volume,
        muted: s.muted,
        playbackRate: s.playbackRate,
        showVideo: s.showVideo,
        handpanScale: s.handpanScale,
        handpanNotes: s.handpanNotes,
        metronome: s.metronome,
        metronomeVolume: s.metronomeVolume,
        tempoFactors: s.tempoFactors,
        serverUrl: s.serverUrl,
        chordSound: s.chordSound,
        chordSoundVolume: s.chordSoundVolume,
        liveKeys: s.liveKeys,
        syncOffsetMs: s.syncOffsetMs,
      }),
    },
  ),
)

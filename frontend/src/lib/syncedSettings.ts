// The subset of persisted Settings that follows a signed-in user across devices.
// Playback state (volume, mute, speed), per-song transpose/tempo, handpan notes, metronome
// and the server URL stay device-local.
// Shape and allowed values must match `isValidSettings` in /firestore.rules.
import type { Settings } from '../store'
import { INSTRUMENTS } from './instruments'

export const SYNCED_KEYS = [
  'simplify',
  'accidentals',
  'instrument',
  'view',
  'barsPerLine',
  'follow',
  'showDiagrams',
  'copyFormat',
  'theme',
  'lang',
  'showVideo',
] as const satisfies ReadonlyArray<keyof Settings>

export type SyncedKey = (typeof SYNCED_KEYS)[number]
export type SyncedSettings = Pick<Settings, SyncedKey>

/** Allowed values per key; keys not listed here are booleans. */
const ENUMS: Partial<Record<SyncedKey, readonly unknown[]>> = {
  accidentals: ['auto', 'sharp', 'flat'],
  instrument: INSTRUMENTS,
  view: ['sheet', 'timeline', 'score'],
  barsPerLine: [2, 4, 8],
  copyFormat: ['bars', 'timestamps', 'chordpro', 'unique'],
  theme: ['dark', 'light', 'system'],
  lang: ['uk', 'en'],
}

/** Used in place of a local value the server would reject (mirrors the store's defaults). */
export const SYNCED_DEFAULTS: SyncedSettings = {
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
  showVideo: false,
}

export function isValidSynced(key: SyncedKey, value: unknown): boolean {
  const allowed = ENUMS[key]
  return allowed ? allowed.includes(value) : typeof value === 'boolean'
}

/**
 * The synced keys of `s`, ready to write. A value the rules would reject (e.g. a new local-only
 * option) is replaced by `fallback`'s (the last synced value), so one key never blocks the rest.
 */
export function pickSynced(s: Settings, fallback: Partial<SyncedSettings> = {}): SyncedSettings {
  const out = {} as Record<SyncedKey, unknown>
  for (const k of SYNCED_KEYS) {
    out[k] = isValidSynced(k, s[k]) ? s[k] : isValidSynced(k, fallback[k]) ? fallback[k] : SYNCED_DEFAULTS[k]
  }
  return out as SyncedSettings
}

export function syncedChanged(a: Settings, b: Settings): boolean {
  return SYNCED_KEYS.some((k) => a[k] !== b[k])
}

/** Keeps only well-formed values from a Firestore `settings` map; anything else is dropped. */
export function parseSynced(raw: unknown): Partial<SyncedSettings> {
  if (!raw || typeof raw !== 'object') return {}
  const src = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of SYNCED_KEYS) {
    if (isValidSynced(k, src[k])) out[k] = src[k]
  }
  return out as Partial<SyncedSettings>
}

/** Order-independent fingerprint for comparing synced settings (Firestore returns map keys sorted). */
export function syncedKey(s: Partial<SyncedSettings>): string {
  return JSON.stringify(SYNCED_KEYS.map((k) => s[k] ?? null))
}

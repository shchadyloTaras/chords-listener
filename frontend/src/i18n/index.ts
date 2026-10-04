import { useCallback } from 'react'
import { useApp, type Lang } from '../store'
import { core } from './core'
import { chords } from './chords'
import { account } from './account'
import { handpan } from './handpan'
import { tempo } from './tempo'
import { web } from './web'
import { sound } from './sound'
import { keys } from './keys'
import { cloud } from './cloud'
import { live } from './live'
import { score } from './score'

/**
 * Each dictionary: { uk: Record<key, string>, en: Record<key, string> }.
 * Keys are namespaced by owner ("core.*" for the Shell, "chords.*" for the chord UI, "account.*" for sign-in).
 * Interpolation: "{name}" placeholders replaced from `vars`.
 */
export type Dict = Record<Lang, Record<string, string>>

const dicts: Dict[] = [core, chords, account, handpan, tempo, web, sound, keys, cloud, live, score]

const merged: Record<Lang, Record<string, string>> = { uk: {}, en: {} }
for (const d of dicts) {
  Object.assign(merged.uk, d.uk)
  Object.assign(merged.en, d.en)
}

export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  let s = merged[lang][key] ?? merged.en[key] ?? key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
  return s
}

export function useT() {
  const lang = useApp((s) => s.lang)
  return useCallback((key: string, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang])
}

/** Non-hook access (event handlers, utilities). */
export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(useApp.getState().lang, key, vars)
}

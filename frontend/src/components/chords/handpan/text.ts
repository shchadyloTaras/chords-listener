// Small text helpers for the handpan UI: plural forms and spoken descriptions.

import { translate } from '../../../i18n'
import type { HandpanPlayability, HandpanScale } from '../../../lib/handpan'
import { pcToName, type Spelling } from '../../../lib/music/notes'
import type { Lang } from '../../../store'

export type PluralForm = 'one' | 'few' | 'many'

/** Ukrainian: 1 поле · 2–4 поля · 5+ полів; English: 1 field · N fields. */
export function pluralForm(lang: Lang, n: number): PluralForm {
  const abs = Math.abs(n)
  if (lang !== 'uk') return abs === 1 ? 'one' : 'many'
  const d = abs % 10
  const dd = abs % 100
  if (d === 1 && dd !== 11) return 'one'
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 'few'
  return 'many'
}

/** "2 поля", "1 field" — `base` is a key prefix with .one/.few/.many variants. */
export function countWord(lang: Lang, base: string, n: number): string {
  return translate(lang, `${base}.${pluralForm(lang, n)}`)
}

/** Name of a chord tone as written on the instrument (its own spelling), else in the chord's spelling. */
export function toneName(scale: HandpanScale, pc: number, fields: number[], spelling: Spelling): string {
  return fields.length ? scale.notes[fields[0]].name : pcToName(pc, spelling)
}

/**
 * Screen-reader description: "Am на хендпані. Грай: A — дінг і 2 поля, C — 2 поля, E — 1 поле.
 * Бракує: G#."
 */
export function describePlay(lang: Lang, label: string, play: HandpanPlayability, scale: HandpanScale, spelling: Spelling): string {
  const tr = (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars)
  const parts = play.tones
    .filter((tone) => tone.fields.length)
    .map((tone) => {
      const name = toneName(scale, tone.pc, tone.fields, spelling)
      const fields = tone.fields.filter((i) => i > 0).length
      const ding = tone.fields.includes(0)
      const count = `${fields} ${countWord(lang, 'handpan.field', fields)}`
      const where = ding ? (fields ? tr('handpan.aria.dingAnd', { fields: count }) : tr('handpan.ding')) : count
      return `${name} — ${where}`
    })
  const missing = play.missing.map((m) => pcToName(m.pc, spelling)).join(', ')
  if (!parts.length) return tr('handpan.aria.none', { chord: label })
  let text = tr('handpan.aria', { chord: label, notes: parts.join(', ') })
  if (missing) text += ` ${tr('handpan.aria.missing', { notes: missing })}`
  return text
}

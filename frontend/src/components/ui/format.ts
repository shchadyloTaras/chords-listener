/** "m:ss" (or "h:mm:ss" when the reference duration is an hour or longer). */
export function formatTime(seconds: number, reference = seconds): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  if (h > 0 || reference >= 3600) return `${h}:${String(m).padStart(2, '0')}:${sec}`
  return `${m}:${sec}`
}

export function formatSpeed(rate: number): string {
  return `${Number(rate.toFixed(2))}×`
}

export function formatBytes(bytes: number, lang: 'uk' | 'en'): string {
  const units = lang === 'uk' ? ['Б', 'КБ', 'МБ', 'ГБ'] : ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** Short relative date ("щойно", "5 хв тому", "вчора", or a date). */
export function formatRelative(iso: string, lang: 'uk' | 'en', now = Date.now()): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'short' })
  const diff = (then - now) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return lang === 'uk' ? 'щойно' : 'just now'
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day')
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: abs > 86400 * 300 ? 'numeric' : undefined }).format(then)
}

export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** CLDR plural category ("one" | "few" | "many" | "other") for i18n keys like "x.count.few". */
export function pluralCategory(lang: 'uk' | 'en', n: number): string {
  return new Intl.PluralRules(lang).select(n)
}

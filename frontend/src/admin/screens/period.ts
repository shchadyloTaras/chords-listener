// The period of the job history and the statistics: UTC days "YYYY-MM-DD", both ends included, at most 90 days
// (AC-09). Shared by both screens, so the rule is checked in one place and the server (422 invalid_period) is the
// second line.

export const MAX_PERIOD_DAYS = 90

/** What the admin sees when a period is refused (before any request is made). */
export const PERIOD_RULE = 'Період має бути не довшим за 90 днів і закінчуватися не раніше, ніж починається'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

function dayMs(day: string): number | null {
  if (!DAY.test(day)) return null
  const ms = Date.parse(`${day}T00:00:00Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day ? ms : null
}

export const utcToday = (): string => new Date().toISOString().slice(0, 10)

export function addDays(day: string, n: number): string {
  const ms = dayMs(day)
  return new Date((ms ?? 0) + n * DAY_MS).toISOString().slice(0, 10)
}

/** The `days` days that end on `to`, as a from/to pair (days = 7 → to − 6 … to). */
export function lastDays(days: number, to: string = utcToday()): { from: string; to: string } {
  return { from: addDays(to, -(days - 1)), to }
}

/** Every day from `from` to `to`, oldest first (empty for an invalid period). */
export function daysOf(from: string, to: string): string[] {
  if (!isValidPeriod(from, to)) return []
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

/** Both ends are real days, the end is not before the start, and at most 90 days are covered. */
export function isValidPeriod(from: string, to: string): boolean {
  const a = dayMs(from)
  const b = dayMs(to)
  if (a === null || b === null || b < a) return false
  return (b - a) / DAY_MS + 1 <= MAX_PERIOD_DAYS
}

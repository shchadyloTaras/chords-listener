// NFR «огляд адмінки, сервер прогрітий — p95 ≤ 2 с» (spec.md §6, test-plan «NFR validation»), live: 20 openings of
// the admin overview in a real browser against the warm local server and the emulators holding the planned data set
// (1 000 users × 20 songs, today's statistics). One opening = a new tab of the signed-in admin loading admin.html:
// the bundle, the session restored by Firebase, the access check and the overview's own request. It is timed in the
// page itself, from the start of the navigation (performance.timeOrigin) to the moment the totals are on screen.
// The cold-start bound (p95 ≤ 15 s) needs the deployed service: scripts/measure_cold_start.py (docs/CLOUD.md).
import { ADMIN_PAGE } from './support/env'
import { seed } from './support/backend'
import { expect, signInOnAdminPage, test } from './support/fixtures'
import { percentile } from './support/time'

const OPENINGS = 20
const WARMUP = 2
const BOUND_MS = 2000
const USERS = Number(process.env.LIVE_P95_USERS || 1000)
const SONGS = Number(process.env.LIVE_P95_SONGS || 20)

test('NFR: the admin overview opens with p95 ≤ 2 s on a warm server (20 openings in the browser)', async ({ world, browser }) => {
  const seeded = seed({ dataset: { users: USERS, tracks: SONGS } })
  expect(seeded.documents).toBe(USERS * (SONGS + 1) + 1)

  const context = await browser.newContext()
  // in every page: the time (ms since the navigation started) at which the overview's totals appear
  await context.addInitScript(() => {
    const w = window as unknown as { __overviewAt?: number }
    const seen = () => document.querySelector('[data-testid="analyses-total"]')
    new MutationObserver((_, observer) => {
      if (w.__overviewAt === undefined && seen()) {
        w.__overviewAt = performance.now()
        observer.disconnect()
      }
    }).observe(document, { childList: true, subtree: true })
  })
  const first = await context.newPage()
  await signInOnAdminPage(first, world.admin, '#/')
  await expect(first.getByTestId('analyses-total')).toHaveText('15') // 7 + 5 + 2 + 1 of the seeded day

  const open = async (): Promise<number> => {
    const page = await context.newPage()
    await page.goto(`${ADMIN_PAGE}#/`)
    await expect(page.getByTestId('analyses-total')).toHaveText('15')
    const at = await page.evaluate(() => (window as unknown as { __overviewAt?: number }).__overviewAt)
    await page.close()
    expect(at, 'the overview was seen rendering').toBeDefined()
    return at as number
  }
  for (let i = 0; i < WARMUP; i++) await open() // the server and the browser cache are warm from here on
  const times: number[] = []
  for (let i = 0; i < OPENINGS; i++) times.push(await open())

  const p95 = percentile(times, 95)
  const rounded = times.map((t) => Math.round(t))
  console.log(`NFR overview (warm, ${USERS} users × ${SONGS} songs): openings ms = [${rounded.join(', ')}]`)
  console.log(`NFR overview: min ${Math.min(...rounded)} ms, median ${Math.round(percentile(times, 50))} ms, p95 ${Math.round(p95)} ms, max ${Math.max(...rounded)} ms (bound ${BOUND_MS} ms)`)
  expect(times).toHaveLength(OPENINGS)
  expect(p95).toBeLessThanOrEqual(BOUND_MS)
  await context.close()
})

// AC-02 and NFR «0 запитів від вкладки без дій», live and slow (@slow: runs only with LIVE_SLOW=1, the scheduled CI
// run): admin tabs left open for 30 real minutes — one in front, one in the background, at the same time — send no
// request to the cloud server, by the browser's record of both tabs and by the server's own access log, so the server
// is free to scale to zero. A guest's site tab open alongside never asks the server either and does not poll the
// public status (≤ 1 read per 5 minutes). At the end the background tab comes back to the front: being older than a
// minute, its data refreshes once — the request both records were waiting to catch.
//
// Headless Chromium reports every tab as visible, so the background tab is put there the way the page itself learns
// it: document.visibilityState / document.hidden and a `visibilitychange` event (as the stubbed e2e/admin.spec.ts).
import type { Page } from '@playwright/test'
import { ADMIN_PAGE, EMULATORS, SITE_HOME } from './support/env'
import { serverLog } from './support/backend'
import { expect, recordRequests, signInOnAdminPage, siteContext, test } from './support/fixtures'
import { sleep } from './support/time'

const IDLE_MIN = Number(process.env.LIVE_IDLE_MIN || 30)
const STATUS_TTL_MIN = 5

async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

test(`AC-02 @slow: admin tabs left alone for ${IDLE_MIN} real minutes, in front and in the background, send no request`, async ({ world, browser }) => {
  test.setTimeout((IDLE_MIN + 10) * 60_000)
  const context = await browser.newContext()
  const admin = recordRequests(context)
  const front = await context.newPage()
  await signInOnAdminPage(front, world.admin, '#/')
  await expect(front.getByTestId('analyses-total')).toBeVisible()
  const back = await context.newPage()
  await back.goto(`${ADMIN_PAGE}#/settings`)
  await expect(back.getByRole('region', { name: 'Типові ліміти' })).toBeVisible()
  await setVisibility(back, 'hidden')
  await front.bringToFront()

  const guestContext = await siteContext(browser)
  const guest = recordRequests(guestContext)
  const site = await guestContext.newPage()
  await site.goto(SITE_HOME)
  await expect(site.getByRole('group', { name: 'Мова' })).toBeVisible()

  await sleep(3000) // the opening requests have settled
  const mark = serverLog.mark()
  const adminSeen = admin.backend.length
  const adminAll = admin.all.length
  // a read of the public status opens a Firestore listen stream (a channel POST without a session id); the stream's
  // own long-poll and its close after a minute idle are the tail of that one read
  const statusReads = () => guest.all.filter((r) => r.startsWith('POST ') && r.includes(`${EMULATORS.firestore}/`) && r.includes('/Listen/channel') && !r.includes('SID=')).length
  const readsAtStart = statusReads()
  const started = Date.now()
  for (let minute = 1; minute <= IDLE_MIN; minute++) {
    await sleep(started + minute * 60_000 - Date.now())
    expect(serverLog.requestsSince(mark), `requests the server logged by minute ${minute}`).toEqual([])
    expect(admin.backend.slice(adminSeen), `admin tabs' requests to the server by minute ${minute}`).toEqual([])
    expect(guest.backend, `the guest's requests to the server by minute ${minute}`).toEqual([])
  }
  const reads = statusReads() - readsAtStart
  const adminOther = admin.all.slice(adminAll)
  console.log(`AC-02: ${IDLE_MIN} min idle — server log: 0 requests; admin tabs: 0 requests to the server, ${adminOther.length} of any kind; guest tab: 0 to the server, ${reads} new reads of the public status`)
  if (adminOther.length) console.log(adminOther.join('\n'))
  expect(reads, 'the site does not poll the public status').toBeLessThanOrEqual(Math.floor(IDLE_MIN / STATUS_TTL_MIN))

  // the background tab comes back after more than a minute: one refresh, seen by both records
  await setVisibility(back, 'visible')
  await back.bringToFront()
  await expect.poll(() => serverLog.requestsSince(mark), { timeout: 15_000 }).toContainEqual('GET /api/admin/settings 200')
  expect(admin.backend.slice(adminSeen).some((r) => r.startsWith('GET ') && r.endsWith('/api/admin/settings'))).toBe(true)
  await guestContext.close()
  await context.close()
})

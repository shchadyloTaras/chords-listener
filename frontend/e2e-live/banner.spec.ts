// AC-29 (spec.md §5) and NFR «банер / перемикачі на сайті ≤ 5 хв», live: the admin publishes a maintenance banner on
// the real Settings screen; a guest opening the site sees it in the interface language (UA, then EN), read straight
// from Firestore — no request reaches the cloud server, by the browser's record and by the server's own access log;
// the banner matches its approved screenshots (visual regression, one baseline per platform); after the admin turns
// it off, the next visit shows none. A new visit reads the status once, so the change reaches it at once — far inside
// the 5-minute bound (an open tab re-reads at most every 5 minutes). The same holds for a service switch: with
// YouTube downloads turned off (AC-27), the next visit of a signed-in user sends a YouTube link to «Слухати у вкладці»
// instead of the fragment picker, again without a request to the server.
import { serverLog } from './support/backend'
import { getDoc } from './support/emulators'
import { SITE_HOME } from './support/env'
import { accountButton, expect, recordRequests, signInOnAdminPage, signInOnSite, siteContext, test } from './support/fixtures'
import type { Locator, Page } from '@playwright/test'

const BANNER = {
  uk: 'Технічні роботи: хмарний аналіз повернеться сьогодні о 18:00 за Києвом.',
  en: 'Maintenance: cloud analysis is back today at 6 pm Kyiv time.',
}
const PROPAGATION_BOUND_S = 5 * 60

/** The Settings screen's banner card: set the switch, publish, wait for «Збережено». */
async function publishBanner(admin: Page, enabled: boolean, texts?: { uk: string; en: string }): Promise<number> {
  const card = admin.getByRole('region', { name: 'Банер обслуговування' })
  if (texts) {
    await card.getByLabel('Текст банера (українською)').fill(texts.uk)
    await card.getByLabel('Текст банера (English)').fill(texts.en)
  }
  const toggle = card.getByRole('switch', { name: 'Показувати банер' })
  if ((await toggle.getAttribute('aria-checked')) !== String(enabled)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(enabled))
  const answer = admin.waitForResponse((r) => r.url().endsWith('/api/admin/settings/banner') && r.request().method() === 'PUT')
  await card.getByRole('button', { name: 'Опублікувати банер' }).click()
  expect((await answer).status()).toBe(200)
  await expect(card.getByRole('status')).toHaveText('Збережено')
  return Date.now()
}

/** The site's banner showing `text` (the notice is a `role=status` strip under the header). */
const bannerWith = (page: Page, text: string): Locator => page.locator('div[role="status"]').filter({ hasText: text })

/** A guest's first visit: resolves once the page has asked Firestore for the public status. */
async function guestVisit(page: Page): Promise<void> {
  const statusRead = page.waitForResponse((r) => r.url().startsWith('http://127.0.0.1:8080/'), { timeout: 30_000 })
  await page.goto(SITE_HOME)
  await statusRead
  await expect(page.getByRole('group', { name: 'Мова' })).toBeVisible()
}

test('AC-29: a guest sees the published banner in the interface language without waking the server; it matches the approved baseline; the next visit after it is off shows none', async ({ world, browser }) => {
  const adminContext = await browser.newContext()
  const admin = await adminContext.newPage()
  await signInOnAdminPage(admin, world.admin, '#/settings')
  const publishedAt = await publishBanner(admin, true, BANNER)
  // the public mirror the site reads holds both texts (written by the server with the journal record, ADR-0005)
  expect(await getDoc('publicStatus/current')).toMatchObject({ banner: { enabled: true, ...BANNER } })

  // ---- a guest: a new visit, nobody signed in
  await admin.waitForTimeout(500) // the admin page has settled: from here on the server must hear nothing
  const mark = serverLog.mark()
  const guestContext = await siteContext(browser)
  const requests = recordRequests(guestContext)
  const guest = await guestContext.newPage()
  await guestVisit(guest)
  const uk = bannerWith(guest, BANNER.uk)
  await expect(uk).toBeVisible()
  const seenAfterS = (Date.now() - publishedAt) / 1000
  console.log(`AC-29 / NFR: the banner reached a new visit ${seenAfterS.toFixed(1)} s after it was published (bound ${PROPAGATION_BOUND_S} s)`)
  expect(seenAfterS).toBeLessThanOrEqual(PROPAGATION_BOUND_S)
  await expect(uk).toHaveText(BANNER.uk)
  await expect(uk).toHaveScreenshot('banner-uk.png')

  await guest.getByRole('group', { name: 'Мова' }).getByRole('button', { name: 'EN' }).click()
  const en = bannerWith(guest, BANNER.en)
  await expect(en).toHaveText(BANNER.en)
  await expect(guest.getByText(BANNER.uk)).toHaveCount(0)
  await expect(en).toHaveScreenshot('banner-en.png')

  await guest.waitForTimeout(1000)
  expect(requests.all.some((r) => r.includes('127.0.0.1:8080/')), 'the status came from Firestore').toBe(true)
  expect(requests.backend, 'requests from the guest to the cloud server').toEqual([])
  expect(serverLog.requestsSince(mark), 'requests the server logged during the guest visit').toEqual([])
  await guestContext.close()

  // ---- the admin turns it off: the next visit shows nothing
  const offAt = await publishBanner(admin, false)
  // (the log does record what reaches the server: here, the admin's save)
  expect(serverLog.requestsSince(mark)).toContain('PUT /api/admin/settings/banner 200')
  expect(await getDoc('publicStatus/current')).toMatchObject({ banner: { enabled: false } })
  const nextContext = await siteContext(browser)
  const nextRequests = recordRequests(nextContext)
  const next = await nextContext.newPage()
  await guestVisit(next)
  await next.waitForTimeout(2000) // the visit that showed the banner had it on screen well within this
  await expect(bannerWith(next, BANNER.uk)).toHaveCount(0)
  await expect(next.locator('div[role="status"]').filter({ hasText: /Технічні роботи|Maintenance/ })).toHaveCount(0)
  const goneAfterS = (Date.now() - offAt) / 1000
  console.log(`NFR: the banner was gone for a new visit ${goneAfterS.toFixed(1)} s after it was turned off (bound ${PROPAGATION_BOUND_S} s)`)
  expect(goneAfterS).toBeLessThanOrEqual(PROPAGATION_BOUND_S)
  expect(nextRequests.backend).toEqual([])
  await nextContext.close()
  await adminContext.close()
})

test('NFR / AC-27: a switch turned off reaches the next visit at once, and the site acts on it without asking the server', async ({ world, browser }) => {
  const VIDEO = 'dQw4w9WgXcQ'
  const adminContext = await browser.newContext()
  const admin = await adminContext.newPage()
  await signInOnAdminPage(admin, world.admin, '#/settings')

  const userContext = await siteContext(browser)
  // the capture page embeds YouTube's player: nothing of it is needed here, and the suite stays off the internet
  await userContext.route(/^https:\/\/([a-z0-9-]+\.)*(youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com)\//, (route) => route.abort())
  const requests = recordRequests(userContext)
  const before = await userContext.newPage()
  await signInOnSite(before, world.user)
  const startLink = async (page: Page) => {
    const input = page.getByLabel('Посилання на відео або аудіо')
    await input.fill(`https://www.youtube.com/watch?v=${VIDEO}`)
    await input.press('Enter')
  }
  // YouTube on: a signed-in user's link opens the fragment picker (the cloud would download it)
  await startLink(before)
  await expect(before).toHaveURL(new RegExp(`#/youtube/${VIDEO}`))
  await before.close()

  const toggle = admin.getByRole('switch', { name: 'Завантаження з YouTube' })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  const answer = admin.waitForResponse((r) => r.url().endsWith('/api/admin/settings/switches/youtubeEnabled') && r.request().method() === 'PUT')
  await toggle.click()
  expect((await answer).status()).toBe(200)
  const offAt = Date.now()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  expect(await getDoc('publicStatus/current')).toMatchObject({ switches: { youtubeEnabled: false } })

  // the next visit: the same link goes straight to «Слухати у вкладці», nothing sent to the server
  await admin.waitForTimeout(500)
  const mark = serverLog.mark()
  const seen = requests.backend.length
  const next = await userContext.newPage()
  await next.goto(SITE_HOME)
  await expect(accountButton(next, world.user.email)).toBeVisible()
  await startLink(next)
  await expect(next).toHaveURL(new RegExp(`#/listen/youtube/${VIDEO}`))
  const reachedAfterS = (Date.now() - offAt) / 1000
  console.log(`NFR: the YouTube switch reached a new visit ${reachedAfterS.toFixed(1)} s after it was turned off (bound ${PROPAGATION_BOUND_S} s)`)
  expect(reachedAfterS).toBeLessThanOrEqual(PROPAGATION_BOUND_S)
  await next.waitForTimeout(1000)
  expect(requests.backend.slice(seen), 'requests from the site to the cloud server').toEqual([])
  expect(serverLog.requestsSince(mark), 'requests the server logged during the visit').toEqual([])
  await userContext.close()

  // back on, for the specs that follow (this also refreshes the server's settings cache)
  const on = admin.waitForResponse((r) => r.url().endsWith('/api/admin/settings/switches/youtubeEnabled') && r.request().method() === 'PUT')
  await toggle.click()
  expect((await on).status()).toBe(200)
  await adminContext.close()
})

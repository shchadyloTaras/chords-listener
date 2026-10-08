// The `world` every live spec starts from: empty emulators, the runtime config of migration 04, an admin granted by
// the owner's script and an ordinary user, both with fresh uids (the server caches per uid, so a spec never sees
// what an earlier one left in its memory). Plus the browser-side helpers: sign in through the real dialogs, and a
// record of every request a page or context makes.
import { randomBytes } from 'node:crypto'
import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { TOUR_IDS } from '../../src/lib/tour/tours'
import { TOURS_KEY } from '../../src/lib/tour/storage'
import { adminGrant, seed, seedRuntimeConfig, serverLog } from './backend'
import { clearEmulators, createAccount, emulatorsUp, idToken, type Account } from './emulators'
import { ADMIN_PAGE, API, BASE_PATH, SITE_HOME } from './env'

export interface Person extends Account {
  /** a fresh ID token of a password sign-in (as the site gets one) */
  token(): Promise<string>
}

export interface World {
  /** suffix of this spec's uids and e-mails */
  id: string
  admin: Person
  user: Person
}

function person(uid: string, email: string): Person {
  const account = { uid, email, password: `pw-${uid}` }
  return { ...account, token: () => idToken(account) }
}

export const test = base.extend<{ world: World }>({
  // a fixture with no dependencies still takes Playwright's (empty) fixtures object first
  // oxlint-disable-next-line no-empty-pattern
  world: async ({}, provide, testInfo) => {
    if (!(await emulatorsUp())) {
      throw new Error('The Firebase emulators are not running on 8080 / 9099 / 9199: start the suite with `npm run test:e2e:live`')
    }
    await clearEmulators()
    seedRuntimeConfig()
    const id = randomBytes(3).toString('hex')
    const admin = person(`live-admin-${id}`, `admin-${id}@example.test`)
    const user = person(`live-user-${id}`, `user-${id}@example.test`)
    for (const p of [admin, user]) await createAccount(p)
    seed({ users: [admin, user].map((p) => ({ uid: p.uid, email: p.email })) })
    adminGrant('grant', admin.uid)
    await provide({ id, admin, user })
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('backend.log (tail)', { body: serverLog.tail(200), contentType: 'text/plain' })
    }
  },
})

export { expect }

// ---------------------------------------------------------------------------------------------- browser contexts

/**
 * A fresh browser (no session, no settings) of someone who has seen the site's guided tours: the home tour starts by
 * itself half a second into a first visit and dims the page, which is not what these specs look at.
 */
export async function siteContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext()
  const seen = JSON.stringify(Object.fromEntries(TOUR_IDS.map((id) => [id, true])))
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [TOURS_KEY, seen] as const)
  return context
}

// ---------------------------------------------------------------------------------------------- the account dialog

async function fillSignIn(page: Page, who: Account): Promise<void> {
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel(/^(Електронна пошта|Email)$/).fill(who.email)
  await dialog.getByLabel(/^(Пароль|Password)$/).fill(who.password)
  await dialog.getByRole('button', { name: /^(Увійти|Sign in)$/ }).click()
}

/** Opens the admin page signed out and signs in through its dialog; resolves when the admin shell is shown. */
export async function signInOnAdminPage(page: Page, who: Account, hash = '#/'): Promise<void> {
  await page.goto(`${ADMIN_PAGE}${hash}`)
  await page.getByRole('button', { name: 'Увійти' }).click()
  await fillSignIn(page, who)
  await expect(page.getByRole('navigation', { name: 'Адмінка' })).toBeVisible({ timeout: 30_000 })
}

/** The site header's account menu of a signed-in `email` («Акаунт <email>»). */
export const accountButton = (page: Page, email: string) =>
  page.getByRole('banner').getByRole('button', { name: new RegExp(`${email.replace(/[.+]/g, '\\$&')}$`) })

/** Opens the site and signs in through the header's account button; resolves when the header shows the account. */
export async function signInOnSite(page: Page, who: Account): Promise<void> {
  await page.goto(SITE_HOME)
  await page.getByRole('banner').getByRole('button', { name: /^(Увійти|Sign in)$/ }).click()
  await fillSignIn(page, who)
  await expect(accountButton(page, who.email)).toBeVisible({ timeout: 30_000 })
}

// ---------------------------------------------------------------------------------------------- the request record

export interface RequestRecord {
  /** every http(s) request: "METHOD url" */
  all: string[]
  /** those that reached (or tried to reach) our backend: the cloud API origin, or /api through the site's origin */
  backend: string[]
}

/** Records every request `target` (a page, or a whole context with all its pages) makes from now on. */
export function recordRequests(target: Page | BrowserContext): RequestRecord {
  const record: RequestRecord = { all: [], backend: [] }
  target.on('request', (req) => {
    const url = req.url()
    if (!/^https?:/.test(url)) return
    const line = `${req.method()} ${url}`
    record.all.push(line)
    const { pathname } = new URL(url)
    if (url.startsWith(`${API}/`) || pathname.startsWith('/api/') || pathname.startsWith(`${BASE_PATH}api/`)) record.backend.push(line)
  })
  return record
}

// ---------------------------------------------------------------------------------------------- admin screens

/** «Користувачі»: searches for `email` and opens its card (both journaled by the server, AC-10b). */
export async function openUserCard(admin: Page, email: string): Promise<void> {
  await admin.goto(`${ADMIN_PAGE}#/users`)
  await admin.getByLabel('Пошук за email').fill(email)
  await admin.getByRole('button', { name: 'Шукати' }).click()
  await admin.getByRole('link', { name: email, exact: true }).click()
  await expect(admin.getByRole('heading', { level: 1 })).toHaveText(email)
}

/** «Журнал»: the rows of the newest page as text, one string per row. */
export async function auditRows(admin: Page): Promise<string[]> {
  await admin.goto(`${ADMIN_PAGE}#/audit`)
  await expect(admin.getByRole('heading', { name: 'Журнал дій адміністратора' })).toBeVisible()
  const rows = admin.locator('[data-screen="audit"] tbody tr')
  await expect(rows.first()).toBeVisible()
  return (await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
}

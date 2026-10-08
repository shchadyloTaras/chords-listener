// AC-22 (+ AC-20, AC-11, NFR «повнота видалення»), live: the admin, freshly signed in, schedules the deletion of a
// user on the card by typing their e-mail; the 7 days are simulated by moving the scheduled time into the past in the
// emulator; the purge then runs the way the scheduled sweep runs it. After it the user cannot sign in (Auth, and the
// site's sign-in dialog), their songs are gone (library index, server files, bucket objects), a search for their
// e-mail finds nobody, and the journal and the job history keep their rows as «видалений» — without the e-mail or
// any song title.
//
// The sweep: `POST /api/internal/sweep` accepts only a Google-signed OIDC token of the scheduler's service account,
// which cannot be minted locally, so backend/scripts/live_e2e.py runs the server's own `app.state.sweeper` (the same
// Sweeper + Purger that create_app builds, from the server's environment) against the same emulators and data
// directory. Only the HTTP entry and its token check are skipped.
import { existsSync } from 'node:fs'
import { API, SITE_HOME } from './support/env'
import { backdateDeletion, seed, seedUserFiles, sweep } from './support/backend'
import { getDoc, listDocs, listObjects, signInWithPassword } from './support/emulators'
import { accountButton, auditRows, expect, openUserCard, signInOnAdminPage, siteContext, test } from './support/fixtures'
import { everySecondUntil } from './support/time'

const TITLES = ['Пісня, якої більше не буде', 'Another goodbye song']
const SEARCH_BOUND_S = 60

test('AC-22: after the 7 days and the sweep the account is gone everywhere and the journal keeps only «видалений»', async ({ world, browser }) => {
  const { uid, email } = world.user
  // the user's library: index documents, the server's files, bucket objects; and a job in the history
  seed({
    tracks: [{ uid, count: 2, titles: TITLES }],
    jobs: [{ uid, title: TITLES[0] }],
    objects: [{ path: `users/${uid}/tracks/000000000000/track.json`, text: JSON.stringify({ title: TITLES[0] }) }],
  })
  const filesDir = seedUserFiles(uid, '000000000000')
  expect((await listDocs(`users/${uid}/tracks`)).length).toBe(2)
  expect(await listObjects(`users/${uid}/`)).toHaveLength(1)

  // ---- the admin (signed in just now: a fresh login) schedules the deletion on the card
  const adminContext = await browser.newContext()
  const admin = await adminContext.newPage()
  await signInOnAdminPage(admin, world.admin, '#/users')
  await openUserCard(admin, email)
  await admin.getByRole('button', { name: 'Запланувати видалення' }).click()
  const dialog = admin.getByRole('dialog', { name: 'Запланувати видалення акаунта' })
  await dialog.getByLabel('Email користувача').fill(email)
  const scheduled = admin.waitForResponse((r) => r.url() === `${API}/api/admin/users/${uid}/deletion` && r.request().method() === 'POST')
  await dialog.getByRole('button', { name: 'Підтвердити видалення' }).click()
  expect((await scheduled).status()).toBe(200)
  await expect(admin.locator('dd').filter({ hasText: 'Заплановане видалення' })).toContainText('видалення після')
  const account = await getDoc(`adminAccounts/${uid}`)
  const purgeAfter = Date.parse(String((account?.deletion as { purgeAfter?: string } | undefined)?.purgeAfter))
  expect((purgeAfter - Date.now()) / 86_400_000).toBeGreaterThan(6.99) // seven days out

  // ---- seven days later: the window has passed, the sweep runs
  backdateDeletion(uid)
  const run = sweep()
  const sweptAt = Date.now()
  console.log(`AC-22: sweep ${JSON.stringify(run)}`)
  expect(run.state).toBe('done')
  expect(run.steps.purges).toBe('done')
  expect(await getDoc(`adminTombstones/${uid}`)).toMatchObject({ status: 'done' })

  // ---- the user cannot sign in: Firebase Auth has no such account, and the site says so
  expect(await signInWithPassword(email, world.user.password)).toEqual({ error: 'EMAIL_NOT_FOUND' })
  const siteContext_ = await siteContext(browser)
  const site = await siteContext_.newPage()
  await site.goto(SITE_HOME)
  await site.getByRole('banner').getByRole('button', { name: 'Увійти' }).click()
  const signIn = site.getByRole('dialog')
  await signIn.getByLabel('Електронна пошта').fill(email)
  await signIn.getByLabel('Пароль', { exact: true }).fill(world.user.password)
  await signIn.getByRole('button', { name: 'Увійти' }).click()
  await expect(signIn.getByRole('alert')).toHaveText('Неправильна пошта або пароль.')
  await expect(accountButton(site, email)).toHaveCount(0)
  await siteContext_.close()

  // ---- the songs are gone: the library index, the profile, the server's files, the bucket
  expect(await listDocs(`users/${uid}/tracks`)).toEqual([])
  expect(await getDoc(`users/${uid}`)).toBeNull()
  expect(await getDoc(`adminAccounts/${uid}`)).toBeNull()
  expect(existsSync(filesDir), filesDir).toBe(false)
  expect(await listObjects(`users/${uid}/`)).toEqual([])

  // ---- the journal: the rows over this user stay, as «видалений», with no e-mail and no title on the page
  const rows = await auditRows(admin)
  const page = (await admin.locator('main').innerText()).toLowerCase()
  expect(page).not.toContain(email.toLowerCase())
  for (const title of TITLES) expect(page).not.toContain(title.toLowerCase())
  expect(rows.filter((r) => r.includes('видалений')).length, rows.join('\n')).toBeGreaterThanOrEqual(2) // the card view, the deletion
  expect(rows.some((r) => r.includes('Заплановано видалення') && r.includes('видалений')), rows.join('\n')).toBe(true)
  // ... and the job history: the job is there, «Користувача видалено», without its title
  await admin.goto(`${admin.url().split('#')[0]}#/jobs`)
  await expect(admin.getByRole('heading', { name: 'Історія задач' })).toBeVisible()
  await expect(admin.locator('tbody tr').filter({ hasText: 'Користувача видалено' })).toHaveCount(1)
  const jobs = (await admin.locator('main').innerText()).toLowerCase()
  expect(jobs).not.toContain(email.toLowerCase())
  for (const title of TITLES) expect(jobs).not.toContain(title.toLowerCase())

  // ---- a search for the e-mail finds nobody (the server's index cache may hold the old shard for up to 30 s)
  await admin.goto(`${admin.url().split('#')[0]}#/users`)
  const found = await everySecondUntil(
    async () => {
      const answer = admin.waitForResponse((r) => r.url().startsWith(`${API}/api/admin/users?`))
      await admin.getByLabel('Пошук за email').fill(email)
      await admin.getByRole('button', { name: 'Шукати' }).click()
      return ((await (await answer).json()) as { items: unknown[] }).items.length
    },
    (n) => n === 0,
    { boundS: SEARCH_BOUND_S, since: sweptAt },
  )
  console.log(`AC-22: a search for the e-mail found nobody ${found.seconds.toFixed(1)} s after the sweep (attempt ${found.attempts})`)
  expect(found.ok).toBe(true)
  await expect(admin.getByText('Нікого не знайдено')).toBeVisible()
  await adminContext.close()
})

// AC-26 (+ AC-34), live: the admin switches «Пауза нових аналізів» on in Settings (a login at most 15 minutes old is
// required — this admin has just signed in); a signed-in user's upload is then refused at the admission gate with
// `analyses_paused`, nothing is counted in the day's quota, and the site explains the pause and offers to analyze the
// song in the browser instead. Turning the pause off needs no fresh login.
import { API } from './support/env'
import { callApi } from './support/backend'
import { getDoc } from './support/emulators'
import { expect, signInOnAdminPage, signInOnSite, siteContext, test } from './support/fixtures'
import { wav } from './support/audio'

type Me = { quotas: { analyses: { used: number } } }

test('AC-26: with the pause on, a user\'s upload is refused without spending quota, explained, and offered in the browser', async ({ world, browser }) => {
  const userToken = await world.user.token()
  const usedBefore = ((await callApi('/api/me', userToken)).body as Me).quotas.analyses.used

  const adminContext = await browser.newContext()
  const admin = await adminContext.newPage()
  await signInOnAdminPage(admin, world.admin, '#/settings')
  const pause = admin.getByRole('switch', { name: 'Пауза нових аналізів' })
  await expect(pause).toHaveAttribute('aria-checked', 'false')
  const paused = admin.waitForResponse((r) => r.url() === `${API}/api/admin/settings/switches/analysesPaused` && r.request().method() === 'PUT')
  await pause.click()
  expect((await paused).status()).toBe(200)
  await expect(pause).toHaveAttribute('aria-checked', 'true')
  expect(await getDoc('adminConfig/settings')).toMatchObject({ switches: { analysesPaused: true } })

  // ---- the user uploads a file on the site
  const userContext = await siteContext(browser)
  const site = await userContext.newPage()
  await signInOnSite(site, world.user)
  const job = site.waitForResponse((r) => r.url().startsWith(`${API}/api/jobs/`) && r.request().method() === 'POST', { timeout: 60_000 })
  await site.locator('input[type="file"]').first().setInputFiles({ name: 'song.wav', mimeType: 'audio/wav', buffer: wav(1) })
  const answer = await job
  expect(answer.status()).toBe(503)
  expect(await answer.json()).toMatchObject({ code: 'analyses_paused' })
  const toast = site.getByRole('alert').filter({ hasText: 'Нові хмарні аналізи тимчасово на паузі' })
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('розпізнати просто зараз у браузері')
  await expect(toast.getByRole('button', { name: 'У браузері' })).toBeVisible()
  expect(((await callApi('/api/me', userToken)).body as Me).quotas.analyses.used).toBe(usedBefore)
  await userContext.close()

  // ---- off again (no fresh login asked), for the specs that follow
  const resumed = admin.waitForResponse((r) => r.url() === `${API}/api/admin/settings/switches/analysesPaused` && r.request().method() === 'PUT')
  await pause.click()
  expect((await resumed).status()).toBe(200)
  await expect(pause).toHaveAttribute('aria-checked', 'false')
  await adminContext.close()
})

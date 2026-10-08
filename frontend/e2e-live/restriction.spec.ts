// AC-16 (+ AC-18, AC-10), live: the admin restricts a user in the user card with the reason «автоматичні масові
// запити»; from then on (bound: 60 s, checked once a second in real time) that user's next cloud analysis is refused
// with `cloud_restricted` at the admission gate — before any download or analysis, without spending quota and without
// the admin's reason in the answer — and the site explains the refusal and offers the in-browser analysis. The journal
// shows the action. The probe is the cheapest entry that passes the gate: a link (`POST /api/jobs`) is admitted
// before anything is fetched (jobs.py submit_url → admit); the link points at a closed local port, so an admitted
// probe fails at once instead of downloading.
import { API } from './support/env'
import { callApi } from './support/backend'
import { getDoc } from './support/emulators'
import { auditRows, expect, openUserCard, signInOnAdminPage, signInOnSite, siteContext, test } from './support/fixtures'
import { wav } from './support/audio'
import { everySecondUntil } from './support/time'

const REASON = 'автоматичні масові запити'
const BOUND_S = 60
let probe = 0
const link = () => ({ url: `http://127.0.0.1:9/live-e2e-probe-${Date.now()}-${++probe}.mp3` })

test('AC-16: a restricted user\'s next cloud analysis is refused within a minute, the site explains it, the journal shows it', async ({ world, browser }) => {
  const userToken = await world.user.token()
  // before: the same entry admits this user (and counts one analysis)
  const before = await callApi('/api/jobs', userToken, { method: 'POST', json: link() })
  expect(before.status, JSON.stringify(before.body)).toBe(201)
  const usedBefore = ((await callApi('/api/me', userToken)).body as { quotas: { analyses: { used: number } } }).quotas.analyses.used

  // ---- the admin restricts the user on the card
  const adminContext = await browser.newContext()
  const admin = await adminContext.newPage()
  await signInOnAdminPage(admin, world.admin, '#/users')
  await openUserCard(admin, world.user.email)
  await admin.getByRole('button', { name: 'Обмежити хмару' }).click()
  const dialog = admin.getByRole('dialog', { name: 'Накласти хмарне обмеження' })
  await dialog.getByLabel('Причина обмеження').fill(REASON)
  const answer = admin.waitForResponse((r) => r.url() === `${API}/api/admin/users/${world.user.uid}/restriction` && r.request().method() === 'PUT')
  await dialog.getByRole('button', { name: 'Накласти обмеження' }).click()
  expect((await answer).status()).toBe(200)
  const restrictedAt = Date.now()
  await expect(admin.locator('dd').filter({ hasText: 'Хмарне обмеження' })).toContainText(REASON)
  expect(await getDoc(`adminAccounts/${world.user.uid}`)).toMatchObject({ restriction: { reason: REASON } })

  // ---- the user's next cloud job: refused at the gate within the bound
  const refused = await everySecondUntil(
    () => callApi('/api/jobs', userToken, { method: 'POST', json: link() }),
    (a) => a.status === 403 && a.body?.code === 'cloud_restricted',
    { boundS: BOUND_S, since: restrictedAt },
  )
  console.log(`AC-16: the first refused job came ${refused.seconds.toFixed(1)} s after the restriction (attempt ${refused.attempts}; bound ${BOUND_S} s)`)
  expect(refused.ok, `last answer: ${JSON.stringify(refused.value)}`).toBe(true)
  expect(refused.seconds).toBeLessThanOrEqual(BOUND_S)
  expect(refused.value.body).toEqual({ detail: 'Cloud analysis is restricted for your account', code: 'cloud_restricted' })
  // nothing counted for the refusal (an attempt admitted before it took effect would count one)
  const usedAfter = ((await callApi('/api/me', userToken)).body as { quotas: { analyses: { used: number } } }).quotas.analyses.used
  expect(usedAfter).toBe(usedBefore + refused.attempts - 1)

  // ---- on the site: the user uploads a file and is told why, with the in-browser way out (AC-18)
  const siteContext_ = await siteContext(browser)
  const site = await siteContext_.newPage()
  await signInOnSite(site, world.user)
  const job = site.waitForResponse((r) => r.url().startsWith(`${API}/api/jobs/`) && r.request().method() === 'POST', { timeout: 60_000 })
  await site.locator('input[type="file"]').first().setInputFiles({ name: 'song.wav', mimeType: 'audio/wav', buffer: wav(1) })
  const siteAnswer = await job
  expect(siteAnswer.status()).toBe(403)
  expect(await siteAnswer.json()).toMatchObject({ code: 'cloud_restricted' })
  const toast = site.getByRole('alert').filter({ hasText: 'Нові хмарні аналізи й транскрипції вокалу для твого акаунта зараз недоступні' })
  await expect(toast).toBeVisible()
  await expect(toast.getByRole('button', { name: 'У браузері' })).toBeVisible()
  expect(await site.content()).not.toContain(REASON) // the admin's reason is never shown to the user
  await siteContext_.close()

  // ---- the journal shows the action: who, over whom, the reason as the new state
  const rows = await auditRows(admin)
  const row = rows.find((r) => r.includes('Хмарне обмеження') && r.includes(world.user.email))
  expect(row, rows.join('\n')).toBeDefined()
  expect(row).toContain(world.admin.email)
  expect(row).toContain(REASON)
  expect(row).toContain('Застосовано')
  await adminContext.close()
})

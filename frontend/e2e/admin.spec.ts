// E2E of the built admin page (docs/features/admin T38; AC-02, AC-05; SAD §10 QG-1 and QG-2):
//  · hostile strings (markup, script URLs, bidi controls, very long text) in a song title, a job error and an
//    email render verbatim as text, and the page's strict CSP rejects a script injected into it;
//  · an admin tab nobody touches sends no request at all for 30 minutes (fake timers), visible or hidden, so
//    the cloud server is free to sleep; coming back to it after that refreshes the data, which proves the
//    request log would have caught a poll.
// Everything the page talks to is stubbed: the cloud API (/api/admin/*) and Firebase's account lookup; the
// signed-in admin session is the one Firebase would have saved in this browser.
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test'
import { AUTH_MARKER_KEY } from '../src/lib/authMarker'
import { firebaseConfig } from '../src/lib/firebaseConfig'
import type { AdminOverview, AdminUserCard } from '../src/types'

const CLOUD_API = 'https://chords-api-84488579848.europe-west1.run.app'
const NOW = new Date('2026-10-08T12:00:00Z')
const DAY_MS = 24 * 3600 * 1000
const ADMIN = { uid: 'e2e-admin', email: 'admin@example.test' }

/** The strings of backend/tests/admin/fixtures.py HOSTILE_STRINGS (AC-05), plus a script that would set a flag. */
const HOSTILE_STRINGS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  'javascript:alert(1)',
  '‮txet desrever', // right-to-left override
  'x+<b>@example.test',
  '<b>bold</b> & &amp; &lt;i&gt;',
  'A'.repeat(300),
  "<script>window.__pwned = 'title'</script>",
]
const HOSTILE_EMAIL = 'x+<img src=x onerror=window.__pwned=1>@example.test'

// ---------------------------------------------------------------------------------------------- stubs

const OVERVIEW: AdminOverview = {
  day: '2026-10-08',
  analyses: { link: 4, file: 3, mic: 1, tab: 0 },
  vocals: 2,
  failed: 1,
  failedByReason: { youtube_blocked: 1 },
  active: 5,
  newUsers: 2,
  runningJobs: [],
  switches: { analysesPaused: false, youtubeEnabled: true, vocalsEnabled: true },
}

function card(): AdminUserCard {
  const quota = { used: 0, limit: 40 }
  return {
    profile: {
      uid: 'u-mallory', email: HOSTILE_EMAIL, createdAt: '2026-09-01T10:00:00Z', lastLoginAt: '2026-10-07T18:20:00Z',
      service: false, trackCount: HOSTILE_STRINGS.length, storageBytes: 8_000_000,
    },
    account: {
      uid: 'u-mallory', status: 'normal', restriction: null, deletion: null, personalLimit: null,
      quota: { day: '2026-10-08', analyses: quota, vocals: { used: 0, limit: 15 }, jobs: { used: 0, limit: 2 } },
    },
    recentJobs: [
      {
        id: 'j1', uid: 'u-mallory', email: HOSTILE_EMAIL, userDeleted: false, service: false, kind: 'analysis', origin: 'link',
        status: 'error', reason: 'other', errorText: HOSTILE_STRINGS[1], title: HOSTILE_STRINGS[0],
        acceptedAt: '2026-10-08T09:00:00Z', finishedAt: '2026-10-08T09:00:30Z',
      },
    ],
    tracks: {
      items: HOSTILE_STRINGS.map((title, i) => ({
        id: `t${i}`, title, sourceType: 'file' as const, createdAt: '2026-10-01T10:00:00Z', duration: 180, edited: false,
        vocals: false, sizeBytes: 1_000_000,
      })),
      hasNext: false, hasPrev: false, nextCursor: null,
    },
  }
}

function jwt(): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const iat = Math.floor(NOW.getTime() / 1000)
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iss: 'https://securetoken.google.com/x', aud: 'x', sub: ADMIN.uid, user_id: ADMIN.uid, email: ADMIN.email, iat, exp: iat + 86400, auth_time: iat })}.signature`
}

/** The session Firebase Auth keeps in this browser (restored at startup because AUTH_MARKER_KEY says "signed in before"). */
function savedSession() {
  return {
    uid: ADMIN.uid, email: ADMIN.email, emailVerified: true, isAnonymous: false,
    providerData: [{ providerId: 'password', uid: ADMIN.email, displayName: null, email: ADMIN.email, phoneNumber: null, photoURL: null }],
    stsTokenManager: { refreshToken: 'e2e-refresh', accessToken: jwt(), expirationTime: NOW.getTime() + DAY_MS },
    createdAt: String(NOW.getTime() - 30 * DAY_MS), lastLoginAt: String(NOW.getTime() - 3600_000),
    apiKey: firebaseConfig.apiKey, appName: '[DEFAULT]',
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, accept, content-type',
  'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
}

interface World {
  /** every request that reached the (stubbed) cloud server, preflights included: "METHOD /path" */
  server: string[]
  /** every http(s) request the page made except those to Google (Firebase sign-in and Firestore are not our server) */
  ours: string[]
}

async function open(context: BrowserContext, page: Page): Promise<World> {
  const world: World = { server: [], ours: [] }
  page.on('request', (req) => {
    const url = req.url()
    if (/^https?:/.test(url) && !/^https:\/\/([a-z0-9-]+\.)*(googleapis|google)\.com\//.test(url)) world.ours.push(`${req.method()} ${url}`)
  })
  const session = JSON.stringify(savedSession())
  await context.addInitScript(
    ([marker, key, value]) => {
      localStorage.setItem(marker, '1')
      localStorage.setItem(key, value)
      const w = window as unknown as { __csp: string[] }
      w.__csp = []
      document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
    },
    [AUTH_MARKER_KEY, `firebase:authUser:${firebaseConfig.apiKey}:[DEFAULT]`, session] as const,
  )
  // Firebase: the account lookup that confirms a restored session; anything else it asks gets an empty answer
  await context.route(/^https:\/\/([a-z]+\.)?googleapis\.com\//, (route: Route) => {
    if (route.request().url().startsWith('https://firestore.')) return route.abort('failed') // settings sync: offline
    if (route.request().url().includes('accounts:lookup')) {
      return route.fulfill({
        json: {
          users: [{
            localId: ADMIN.uid, email: ADMIN.email, emailVerified: true, createdAt: String(NOW.getTime() - 30 * DAY_MS),
            lastLoginAt: String(NOW.getTime() - 3600_000),
            providerUserInfo: [{ providerId: 'password', federatedId: ADMIN.email, email: ADMIN.email, rawId: ADMIN.email }],
          }],
        },
      })
    }
    return route.fulfill({ json: {} })
  })
  await context.route(`${CLOUD_API}/**`, (route: Route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    world.server.push(`${req.method()} ${path}`)
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    if (path === '/api/admin/overview') return route.fulfill({ json: OVERVIEW, headers: CORS })
    if (path === '/api/admin/users/u-mallory') return route.fulfill({ json: card(), headers: CORS })
    return route.fulfill({ status: 404, json: { detail: `Unknown API endpoint: ${path}`, code: 'not_found' }, headers: CORS })
  })
  return world
}

// ---------------------------------------------------------------------------------------------- AC-05

test('hostile strings render as text and the CSP rejects an injected inline script', async ({ context, page }) => {
  await open(context, page)
  await page.goto('/admin.html#/users/u-mallory')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(HOSTILE_EMAIL)

  // every hostile string shows up verbatim, as the text of a table cell (title) or of a span inside one (error text)
  const texts = await page.locator('main td, main td span').allTextContents()
  for (const hostile of HOSTILE_STRINGS) expect(texts, hostile.slice(0, 40)).toContain(hostile)

  // ... and none of them became markup: no element, no handler, no script, nothing evaluated
  const page_ = await page.evaluate(() => ({
    pwned: (window as unknown as { __pwned?: unknown }).__pwned ?? null,
    injected: document.querySelectorAll('main img, main script, main b, main i, main svg[onload]').length,
    handlers: document.querySelectorAll('[onerror], [onload], [onclick], [onmouseover]').length,
    scriptUrls: document.querySelectorAll('a[href^="javascript:"], [src^="javascript:"]').length,
    inlineScripts: document.querySelectorAll('script:not([src])').length,
    // (Firestore's connectivity probe for a channel that failed is an image from google.com: only our offline stub causes it)
    csp: (window as unknown as { __csp: string[] }).__csp.filter((v) => !v.includes('/images/cleardot.gif')),
  }))
  expect(page_).toEqual({ pwned: null, injected: 0, handlers: 0, scriptUrls: 0, inlineScripts: 0, csp: [] })

  // the second line of defence: a script put into the page anyway does not run. The policy is in the page itself
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  expect(policy).toMatch(/script-src 'self'(;|$)/)
  expect(policy).not.toMatch(/unsafe-inline|unsafe-eval/)
  // (no eval probe: code run by page.evaluate is exempt from the policy; `unsafe-eval` is excluded above instead)
  const blocked = await page.evaluate(
    () =>
      new Promise<{ violation: string | null; inline: unknown; foreign: unknown; viaLink: unknown; handler: unknown }>((resolve) => {
        const w = window as unknown as { __inline?: unknown; __foreign?: unknown; __link?: unknown; __handler?: unknown }
        let violation: string | null = null
        document.addEventListener('securitypolicyviolation', (e) => (violation ??= e.violatedDirective), { once: true })
        // 1. an inline script element
        const script = document.createElement('script')
        script.textContent = "window.__inline = 'ran'"
        document.body.appendChild(script)
        // 2. a script from somewhere other than the page's own origin
        const foreign = document.createElement('script')
        foreign.src = 'data:text/javascript,window.__foreign=1'
        document.body.appendChild(foreign)
        // 3. an inline event handler
        const img = document.createElement('img')
        img.setAttribute('onerror', "window.__handler = 'ran'")
        img.src = 'data:image/x-nothing;base64,AAAA'
        document.body.appendChild(img)
        // 4. a javascript: link
        const link = document.createElement('a')
        link.href = "javascript:window.__link='ran'"
        document.body.appendChild(link)
        link.click()
        setTimeout(
          () => resolve({ violation, inline: w.__inline ?? null, foreign: w.__foreign ?? null, viaLink: w.__link ?? null, handler: w.__handler ?? null }),
          500,
        )
      }),
  )
  expect(blocked.violation).toMatch(/^script-src/)
  expect(blocked).toMatchObject({ inline: null, foreign: null, viaLink: null, handler: null })
})

// ---------------------------------------------------------------------------------------------- AC-02

/** Pretend the tab is in the background (or back in front): what the page sees when the visibility changes. */
async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

test('an admin tab left alone for 30 minutes, in front or behind, sends no request; coming back refreshes it', async ({ context, page }) => {
  const world = await open(context, page)
  await page.clock.install({ time: NOW })
  await page.goto('/admin.html')
  await expect(page.getByTestId('analyses-total')).toHaveText('8') // 4 + 3 + 1: the overview has loaded
  await expect.poll(() => world.server.filter((r) => r.startsWith('GET /api/admin/overview')).length).toBeGreaterThanOrEqual(1)
  await page.waitForTimeout(500) // let the opening requests settle (access probe, the screen's own load)
  const server = [...world.server]
  const ours = [...world.ours]

  await page.clock.runFor('30:00') // in front, nobody does anything
  await page.waitForTimeout(300)
  expect(world.server, 'cloud requests while the tab was idle in front').toEqual(server)
  expect(world.ours, 'requests of any kind while the tab was idle in front').toEqual(ours)

  await setVisibility(page, 'hidden')
  await page.clock.runFor('30:00') // 30 more minutes in the background
  await page.waitForTimeout(300)
  expect(world.server, 'cloud requests while the tab was in the background').toEqual(server)
  expect(world.ours, 'requests of any kind while the tab was in the background').toEqual(ours)

  // a quick return does not refresh again: the data is older than a minute only after 60 s (T28); here it IS older,
  // so the return refreshes once, and a second return right after it asks nothing
  await setVisibility(page, 'visible')
  await expect.poll(() => world.server.length, 'the return after 60 minutes refreshes').toBeGreaterThan(server.length)
  const refreshed = world.server.length
  expect(world.server.slice(server.length)).toContain('GET /api/admin/overview')
  await page.clock.runFor('00:30')
  await setVisibility(page, 'hidden')
  await setVisibility(page, 'visible')
  await page.waitForTimeout(300)
  expect(world.server.length, 'a return within a minute asks nothing').toBe(refreshed)
})

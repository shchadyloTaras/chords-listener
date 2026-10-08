import { defineConfig } from '@playwright/test'
import { API, API_PORT, BACKEND_DIR, BASE_PATH, DATA_DIR, PYTHON, RUN_DIR, SERVER_LOG, SITE, SITE_PORT, SLOW, backendEnv } from './e2e-live/support/env'

// Live e2e of the admin feature (docs/features/admin/test-plan.md, the scheduled level): a real browser, the real
// backend (uvicorn, cloud mode) and the Firebase emulators (Auth, Firestore, Storage), in real time — no stubs, no
// fake clocks. The stubbed suite stays in playwright.config.ts / e2e/.
//
//   npm run test:e2e:live                 starts the emulators (firebase-tools 15) and runs this config inside them
//   LIVE_SLOW=1 npm run test:e2e:live     also the 30-minute idle-tab spec (@slow)
//   npm run test:e2e:live -- --update-snapshots    re-take the banner baselines of this platform
//
// The backend starts fresh for every run (its data directory and log under RUN_DIR are wiped); the site is the hosted
// build (VITE_BASE=/chords-listener/, as on GitHub Pages) made against the emulators and this backend, in its own
// folder. One worker: the specs share the emulators and the server.
export default defineConfig({
  testDir: './e2e-live',
  outputDir: './test-results/live',
  timeout: 180_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env.CI,
  grepInvert: SLOW ? undefined : /@slow/,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-live' }]] : 'list',
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.01 },
  },
  use: {
    baseURL: SITE,
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      name: 'backend',
      // stdout and stderr (uvicorn's access log included) go to SERVER_LOG: the specs read it as the server's own record
      command: `rm -rf "${RUN_DIR}" && mkdir -p "${DATA_DIR}" && cd "${BACKEND_DIR}" && exec "${PYTHON}" -m uvicorn app.main:app --host 127.0.0.1 --port ${API_PORT} > "${SERVER_LOG}" 2>&1`,
      url: `${API}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: backendEnv(),
    },
    {
      name: 'site',
      command: `npx vite build --outDir dist-e2e-live --emptyOutDir && npx vite preview --outDir dist-e2e-live --host 127.0.0.1 --port ${SITE_PORT} --strictPort`,
      url: `http://127.0.0.1:${SITE_PORT}${BASE_PATH}admin.html`,
      // a server that is already up is the one built from the sources the developer is editing: only CI starts clean
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: {
        VITE_BASE: BASE_PATH,
        VITE_FIREBASE_EMULATORS: 'true',
        VITE_CLOUD_API_URL: API,
        // vite preview proxies /api to this: anything the site sent there would reach (and be logged by) the backend
        CHORDS_BACKEND_URL: API,
      },
    },
  ],
})

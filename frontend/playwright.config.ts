import { defineConfig } from '@playwright/test'

// Browser e2e for the admin page (docs/features/admin T38, SAD §10 QG-1/QG-2). The specs run against the BUILT
// admin.html (the real CSP <meta> and bundle, not the dev server, which drops the CSP) served by `vite preview`,
// with every network call stubbed in the spec. The build goes to its own folder: dist/ stays the local build that
// ./start.sh serves.
//
//   npx playwright install chromium     (once)
//   npm run test:e2e
const PORT = 4173
const CLOUD_API = 'https://chords-api-84488579848.europe-west1.run.app'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npx vite build --outDir dist-e2e && npx vite preview --outDir dist-e2e --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/admin.html`,
    // a server that is already up is the one built from the sources the developer is editing: only CI starts clean
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    // the API origin the specs stub; admin.html's CSP names it in connect-src (same value the page falls back to)
    env: { VITE_CLOUD_API_URL: CLOUD_API },
  },
})

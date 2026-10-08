import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import { configDefaults, defineConfig } from 'vitest/config'

const BACKEND = process.env.CHORDS_BACKEND_URL ?? 'http://127.0.0.1:8765'

/**
 * Public base path. Local builds (served by the backend at "/") keep "/"; the GitHub Pages build sets
 * `VITE_BASE=/chords-listener/` — that build then talks to the user's own server (see src/lib/serverMode.ts).
 */
function basePath(raw: string | undefined): string {
  const value = (raw ?? '').trim()
  if (!value || value === '/') return '/'
  if (/^(https?:)?\/\//.test(value) || value === './') return value.endsWith('/') ? value : `${value}/`
  return `/${value.replace(/^\/+|\/+$/g, '')}/`
}

const base = basePath(process.env.VITE_BASE)
// The hosted build goes to its own folder: frontend/dist stays the local build that ./start.sh serves at "/".
const outDir = base === '/' ? 'dist' : 'dist-pages'

const proxy = {
  '/api': {
    target: BACKEND,
    changeOrigin: false,
    // long uploads / analysis polling should never be cut by the proxy
    timeout: 0,
    proxyTimeout: 0,
  },
}

/** GitHub Pages answers unknown paths with 404.html: make it the app too (routes are in the hash anyway). */
function pagesFallback(): Plugin {
  return {
    name: 'chords:pages-404',
    apply: 'build',
    async writeBundle(options) {
      if (base === '/' || !options.dir) return
      await copyFile(join(options.dir, 'index.html'), join(options.dir, '404.html'))
    },
  }
}

/**
 * The Firebase Auth emulator a `VITE_FIREBASE_EMULATORS=true` build signs in with (src/lib/firebase.ts:
 * EMULATOR_HOST, AUTH_EMULATOR_PORT). The admin page uses Auth only — no Firestore, no Storage (ADR-0002) — so this is
 * the one emulator origin its policy needs.
 */
export const AUTH_EMULATOR_ORIGIN = 'http://127.0.0.1:9099'

/**
 * admin.html's policy for a build: the page's own CSP, plus in connect-src the origin of a build-time
 * `VITE_CLOUD_API_URL` override and, for a `VITE_FIREBASE_EMULATORS=true` build (the live e2e suite), the Auth
 * emulator. A production build (neither variable set, or the deployed API URL) gets the policy exactly as written.
 */
export function adminBuildCsp(html: string, env: Record<string, string | undefined>): string {
  const origins: string[] = []
  const override = env.VITE_CLOUD_API_URL?.trim()
  if (override) {
    try {
      origins.push(new URL(override).origin)
    } catch {
      // not a URL: the page falls back to the deployed API, which the policy names already
    }
  }
  if (env.VITE_FIREBASE_EMULATORS === 'true') origins.push(AUTH_EMULATOR_ORIGIN)
  const missing = origins.filter((origin, i) => origins.indexOf(origin) === i && !html.includes(origin))
  if (!missing.length) return html
  return html.replace(/(connect-src 'self')/, `$1 ${missing.join(' ')}`)
}

/**
 * admin.html carries a strict CSP in a <meta> (ADR-0002). The dev server injects inline scripts (React refresh,
 * the HMR client), which that policy would block, so it serves the page without the tag; the build keeps it
 * (adminBuildCsp: plus a build-time API override and, in an emulator build, the Auth emulator).
 */
function adminCsp(): Plugin {
  const meta = /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>\s*/i
  let serve = false
  return {
    name: 'chords:admin-csp',
    configResolved(config) {
      serve = config.command === 'serve'
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!ctx.filename.endsWith('admin.html')) return html
        if (serve) return html.replace(meta, '')
        return adminBuildCsp(html, process.env)
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react(), tailwindcss(), pagesFallback(), adminCsp()],
  server: {
    port: 5173,
    proxy,
  },
  preview: {
    port: 4173,
    proxy,
  },
  // e2e/*.spec.ts and e2e-live/*.spec.ts belong to Playwright (`npm run test:e2e`, `npm run test:e2e:live`), not to vitest
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**', 'e2e-live/**'],
  },
  build: {
    outDir,
    target: 'es2022',
    // two pages: the app and the admin page (strict CSP, no TF.js — see admin.html)
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
    },
    // chords-db (chord diagrams) is large by nature; keep the warning meaningful
    chunkSizeWarningLimit: 1500,
  },
})

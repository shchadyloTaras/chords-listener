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
 * admin.html carries a strict CSP in a <meta> (ADR-0002). The dev server injects inline scripts (React refresh,
 * the HMR client), which that policy would block, so it serves the page without the tag; the build keeps it and
 * adds the origin of a build-time `VITE_CLOUD_API_URL` override to connect-src.
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
        const override = process.env.VITE_CLOUD_API_URL?.trim()
        if (!override) return html
        let origin: string
        try {
          origin = new URL(override).origin
        } catch {
          return html
        }
        if (html.includes(origin)) return html
        return html.replace(/(connect-src 'self')/, `$1 ${origin}`)
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
  // e2e/*.spec.ts belong to Playwright (`npm run test:e2e`), not to vitest
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**'],
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

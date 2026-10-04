import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

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

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react(), tailwindcss(), pagesFallback()],
  server: {
    port: 5173,
    proxy,
  },
  preview: {
    port: 4173,
    proxy,
  },
  build: {
    outDir,
    target: 'es2022',
    // chords-db (chord diagrams) is large by nature; keep the warning meaningful
    chunkSizeWarningLimit: 1500,
  },
})

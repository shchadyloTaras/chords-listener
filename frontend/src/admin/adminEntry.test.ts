// AC-05 (second line of defence) + ADR-0002: admin.html carries a strict CSP in a <meta>, the build has it as a
// second input, the bundle check catches TF.js / models, and oxlint forbids HTML rendering under src/admin.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM script that CI runs too (no type declarations)
import { checkAdminBundle } from '../../scripts/check-admin-bundle.mjs'

const root = resolve(__dirname, '../..')
const html = readFileSync(join(root, 'admin.html'), 'utf8')

function cspOf(source: string): Record<string, string[]> {
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(source)
  expect(m, 'CSP <meta> present').not.toBeNull()
  const out: Record<string, string[]> = {}
  for (const part of m![1].split(';')) {
    const [name, ...values] = part.trim().split(/\s+/)
    if (name) out[name] = values
  }
  return out
}

describe('admin.html', () => {
  const csp = cspOf(html)

  it('forbids inline scripts and eval', () => {
    expect(csp['script-src']).toEqual(["'self'"])
  })

  it('forbids framing, plugins, base rewriting and form posts elsewhere', () => {
    expect(csp['default-src']).toEqual(["'none'"])
    expect(csp['frame-src']).toEqual(["'none'"])
    expect(csp['object-src']).toEqual(["'none'"])
    expect(csp['base-uri']).toEqual(["'none'"])
    expect(csp['form-action']).toEqual(["'none'"])
  })

  it('lets the page talk only to itself, the cloud API and Firebase', () => {
    for (const origin of csp['connect-src']) {
      expect(origin === "'self'" || /^https:\/\/[a-z0-9.-]+\.(googleapis\.com|run\.app)$/.test(origin), origin).toBe(true)
    }
    expect(csp['connect-src']).toContain('https://identitytoolkit.googleapis.com')
  })

  it('connects to exactly the hosts ADR-0002 lists (no Firestore) (S1-13)', () => {
    const adr = readFileSync(join(root, '../docs/features/admin/adr/0002-ship-admin-ui-as-separate-strict-csp-entry.md'), 'utf8')
    const hosts = csp['connect-src'].filter((o) => o.startsWith('https://'))
    expect(hosts).not.toContain('https://firestore.googleapis.com')
    expect([...hosts].sort()).toEqual([
      'https://chords-api-84488579848.europe-west1.run.app',
      'https://identitytoolkit.googleapis.com',
      'https://securetoken.googleapis.com',
      'https://www.googleapis.com',
    ])
    for (const h of hosts) expect(adr, `${h} named in the ADR`).toContain(h.replace('https://', ''))
  })

  it('is pinned to Ukrainian (S2-9)', () => {
    expect(html).toMatch(/<html\s+lang="uk"/)
  })

  it('pins the interface language before it renders anything, shared dialogs and pages included (T60)', () => {
    const entry = readFileSync(join(root, 'src/admin/main.tsx'), 'utf8')
    const pin = entry.indexOf('pinAdminLanguage()')
    expect(pin, 'main.tsx calls pinAdminLanguage()').toBeGreaterThan(-1)
    expect(pin).toBeLessThan(entry.indexOf('createRoot('))
  })

  it('has no inline script and loads the admin entry as a module', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1])
    expect(scripts.length).toBeGreaterThan(0)
    for (const attrs of scripts) expect(attrs).toMatch(/\bsrc="/)
    expect(html).toContain('src="/src/admin/main.tsx"')
  })
})

describe('vite config', () => {
  it('builds admin.html next to index.html', async () => {
    const { default: config } = await import('../../vite.config')
    const input = (config as { build?: { rollupOptions?: { input?: Record<string, string> } } }).build?.rollupOptions?.input
    expect(Object.keys(input ?? {}).sort()).toEqual(['admin', 'main'])
    expect(input?.admin).toMatch(/admin\.html$/)
    expect(input?.main).toMatch(/index\.html$/)
  })
})

describe('checkAdminBundle', () => {
  const good = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src 'self'"><script type="module" src="/x/assets/admin-1.js"></script>`
  function build(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'admin-bundle-'))
    mkdirSync(join(dir, 'assets'))
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
    return dir
  }

  it('accepts a clean bundle', () => {
    const dir = build({ 'admin.html': good, 'assets/admin-1.js': 'console.log(1)' })
    try {
      expect(checkAdminBundle(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('reports a missing, loosened or absent CSP and inline scripts', () => {
    const none = build({ 'admin.html': good.replace(/<meta[^>]*>/, ''), 'assets/admin-1.js': '' })
    const loose = build({ 'admin.html': good.replace("script-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'"), 'assets/admin-1.js': '' })
    const inline = build({ 'admin.html': good + '<script>alert(1)</script>', 'assets/admin-1.js': '' })
    try {
      expect(checkAdminBundle(none).join()).toMatch(/CSP/)
      expect(checkAdminBundle(loose).join()).toMatch(/unsafe-inline/)
      expect(checkAdminBundle(loose).join()).toMatch(/unsafe-eval/)
      expect(checkAdminBundle(inline).join()).toMatch(/inline/)
    } finally {
      for (const d of [none, loose, inline]) rmSync(d, { recursive: true })
    }
  })

  it('reports TF.js reachable from the admin entry, including through a lazy chunk, but not from the main site', () => {
    const dir = build({
      'admin.html': good,
      'assets/admin-1.js': 'import("./lazy-2.js")',
      'assets/lazy-2.js': 'export const x="@tensorflow/tfjs-core"',
      'index.html': '<script type="module" src="/x/assets/main-3.js"></script>',
      'assets/main-3.js': 'export const y="@tensorflow/tfjs-core"',
    })
    try {
      const problems = checkAdminBundle(dir).join('\n')
      expect(problems).toMatch(/lazy-2\.js/)
      expect(problems).not.toMatch(/main-3\.js/)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('reports a model or wasm file reachable from the admin entry', () => {
    const dir = build({ 'admin.html': good, 'assets/admin-1.js': 'fetch("/models/model.json"); load("x.wasm")' })
    try {
      expect(checkAdminBundle(dir).length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})

describe('oxlint under src/admin', () => {
  function lint(code: string): { status: number | null; out: string } {
    const dir = join(root, 'src/admin/__lintprobe__')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'probe.tsx')
    writeFileSync(file, code)
    try {
      const r = spawnSync('npx', ['oxlint', '--quiet', file], { cwd: root, encoding: 'utf8' })
      return { status: r.status, out: r.stdout + r.stderr }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('fails on dangerouslySetInnerHTML', () => {
    const r = lint('export const A = ({ h }: { h: string }) => <div dangerouslySetInnerHTML={{ __html: h }} />\n')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/danger/i)
  }, 60_000)

  it('fails on innerHTML, outerHTML and insertAdjacentHTML', () => {
    for (const code of [
      'export const a = (el: HTMLElement, h: string) => { el.innerHTML = h }\n',
      'export const b = (el: HTMLElement, h: string) => { el.outerHTML = h }\n',
      "export const c = (el: HTMLElement, h: string) => el.insertAdjacentHTML('beforeend', h)\n",
    ]) {
      const r = lint(code)
      expect(r.status, code).not.toBe(0)
    }
  }, 120_000)

  it('passes plain text rendering', () => {
    const r = lint('export const A = ({ s }: { s: string }) => <div>{s}</div>\n')
    expect(r.status).toBe(0)
  }, 60_000)
})

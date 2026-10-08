// CI check for the admin page (ADR-0002, docs/features/admin): run after `vite build`.
//   node scripts/check-admin-bundle.mjs [outDir]      (default: dist-pages)
// Fails when
//   - admin.html is missing, has no Content-Security-Policy <meta>, allows inline scripts / eval in script-src,
//     or contains an inline <script>;
//   - anything reachable from admin.html (its scripts, lazy chunks, stylesheets) is TensorFlow.js, a model or wasm.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** What the admin page must never ship: the analysis engine and its models. */
const FORBIDDEN = /@tensorflow|tfjs|basic-pitch|\.wasm\b|model\.json|group\d+-shard\d+of\d+/
const FILE_REF = /[A-Za-z0-9_.\-/]+\.(?:js|mjs|css|wasm|json|bin|onnx|tflite)\b/g

function listFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
}

/** Problems found in a build output folder (empty = fine). */
export function checkAdminBundle(outDir) {
  const problems = []
  const htmlPath = join(outDir, 'admin.html')
  if (!existsSync(htmlPath)) return [`admin.html is missing in ${outDir}`]
  const html = readFileSync(htmlPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '')

  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html)
  if (!meta) problems.push('admin.html has no CSP (Content-Security-Policy) meta tag')
  else {
    const script = meta[1].split(';').map((d) => d.trim().split(/\s+/)).find(([name]) => name === 'script-src')
    if (!script) problems.push("CSP has no script-src directive (it would fall back to default-src)")
    else {
      for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'"]) {
        if (script.includes(bad)) problems.push(`CSP script-src allows ${bad}`)
      }
    }
  }
  for (const [, attrs] of html.matchAll(/<script\b([^>]*)>/gi)) {
    if (!/\bsrc\s*=/.test(attrs)) problems.push('admin.html has an inline script')
  }

  // everything reachable from admin.html by file name (hashed asset names are unique)
  const byName = new Map(listFiles(outDir).map((f) => [basename(f), f]))
  const seen = new Set()
  const queue = [htmlPath]
  const refs = (text) => [...text.matchAll(FILE_REF)].map((m) => basename(m[0]))
  const enqueue = (names) => {
    for (const name of names) {
      const file = byName.get(name)
      if (file && !seen.has(file) && file !== join(outDir, 'index.html') && file !== join(outDir, '404.html')) queue.push(file)
    }
  }
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (file !== htmlPath && FORBIDDEN.test(basename(file))) problems.push(`admin bundle reaches ${basename(file)}`)
    if (!/\.(?:html|js|mjs|css)$/.test(file)) continue
    const text = file === htmlPath ? html : readFileSync(file, 'utf8')
    if (file !== htmlPath) {
      const hit = FORBIDDEN.exec(text)
      if (hit) problems.push(`admin bundle reaches ${basename(file)} which contains "${hit[0]}"`)
    }
    enqueue(refs(text))
  }
  return problems
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outDir = process.argv[2] ?? 'dist-pages'
  const problems = checkAdminBundle(outDir)
  if (problems.length) {
    for (const p of problems) console.error(`admin check: ${p}`)
    process.exit(1)
  }
  console.log(`admin check: ${outDir}/admin.html has a strict CSP and its bundle is free of TF.js, models and wasm`)
}

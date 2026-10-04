#!/usr/bin/env node
// Mints a short-lived (~1 h) Google OAuth access token from the firebase-tools login on this machine
// (`npx firebase-tools login`) and writes it to a file with mode 0600. The token is never printed.
// Lets gcloud work without `gcloud auth login`:
//
//   node scripts/gcloud_token.cjs /path/to/token-file
//   gcloud ... --access-token-file /path/to/token-file      (or CLOUDSDK_AUTH_ACCESS_TOKEN_FILE=...)
//
// firebase-tools is located via $FT (its package directory), the `firebase` binary on PATH, the global
// npm modules, or the npx cache (~/.npm/_npx/*/node_modules/firebase-tools, newest version first). When
// none is found, `npx -y firebase-tools@latest --version` runs once to fill the npx cache.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

function die(message) {
  console.error(`gcloud_token: ${message}`)
  process.exit(1)
}

function versionOf(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null
  } catch {
    return null
  }
}

function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function candidates() {
  const dirs = []
  const bin = run('which', ['firebase'])
  if (bin) {
    try {
      // .../firebase-tools/lib/bin/firebase.js -> .../firebase-tools
      dirs.push(path.resolve(path.dirname(fs.realpathSync(bin)), '..', '..'))
    } catch {}
  }
  const globalRoot = run('npm', ['root', '-g'])
  if (globalRoot) dirs.push(path.join(globalRoot, 'firebase-tools'))
  const npxCache = path.join(os.homedir(), '.npm', '_npx')
  try {
    for (const entry of fs.readdirSync(npxCache)) dirs.push(path.join(npxCache, entry, 'node_modules', 'firebase-tools'))
  } catch {}
  return [...new Set(dirs)].filter((d) => versionOf(d) && fs.existsSync(path.join(d, 'lib', 'auth.js')))
}

function findFirebaseTools() {
  if (process.env.FT) {
    if (!fs.existsSync(path.join(process.env.FT, 'lib', 'auth.js'))) die(`FT=${process.env.FT} is not a firebase-tools package directory`)
    return process.env.FT
  }
  let found = candidates()
  if (!found.length) {
    console.error('gcloud_token: firebase-tools not found, fetching it with npx (one time)...')
    try {
      execFileSync('npx', ['-y', 'firebase-tools@latest', '--version'], { stdio: 'ignore' })
    } catch {}
    found = candidates()
  }
  if (!found.length) die('firebase-tools is not installed (npm i -g firebase-tools) - or set FT to its package directory')
  found.sort((a, b) => compareVersions(versionOf(b), versionOf(a)))
  return found[0]
}

function readLogin() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  const file = path.join(base, 'configstore', 'firebase-tools.json')
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    die(`no firebase-tools login (${file}); run: npx firebase-tools login`)
  }
  const tokens = cfg.tokens || {}
  if (!tokens.refresh_token) die('the firebase-tools login has no refresh token; run: npx firebase-tools login --reauth')
  return { refreshToken: tokens.refresh_token, scopes: Array.isArray(tokens.scopes) ? tokens.scopes : [], user: (cfg.user || {}).email }
}

async function main() {
  const out = process.argv[2]
  if (!out) die('usage: node scripts/gcloud_token.cjs <token-file>')
  const ft = findFirebaseTools()
  const login = readLogin()
  const auth = require(path.join(ft, 'lib', 'auth.js'))
  if (typeof auth.getAccessToken !== 'function') die(`firebase-tools ${versionOf(ft)} has no getAccessToken()`)
  const result = await auth.getAccessToken(login.refreshToken, login.scopes)
  const token = result && result.access_token
  if (!token) die('no access token returned')
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(out, token, { mode: 0o600 })
  fs.chmodSync(out, 0o600)
  console.log(`access token for ${login.user || 'the firebase-tools user'} written to ${out} (expires in ${result.expires_in || '?'} s; firebase-tools ${versionOf(ft)})`)
}

main().catch((err) => die(err && err.message ? err.message : String(err)))

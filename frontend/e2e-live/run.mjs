// `npm run test:e2e:live [-- <playwright args>]`: runs playwright.live.config.ts inside the Firebase emulators.
//
// · Emulators already listening on 8080 (Firestore), 9099 (Auth) and 9199 (Storage) — e.g. a
//   `firebase emulators:start --only auth,firestore,storage` of your own — are reused (their data is wiped by the specs).
// · Otherwise `firebase-tools@15 emulators:exec --only auth,firestore,storage` starts them from the repository's
//   firebase.json (rules included), runs Playwright and stops them. They need Java 21+ (on macOS the Homebrew
//   openjdk is put on PATH when `java` is missing).
// · Some of those ports taken but not all: something else is there — stop it first.
// The started emulators get a temp directory of their own: the Storage emulator keeps its blobs under
// <tmp>/firebase/storage and deletes that folder when it stops, so another emulator suite on this machine (another
// checkout, other ports) stopping mid-run would otherwise pull the files out from under this one.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND = fileURLToPath(new URL('..', import.meta.url))
const ROOT = dirname(FRONTEND.replace(/\/$/, ''))
const PORTS = { firestore: 8080, auth: 9099, storage: 9199 }
const PROJECT = 'build-chords-listener'
const FIREBASE_TOOLS = process.env.LIVE_FIREBASE_TOOLS || 'firebase-tools@15'

function listening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => socket.end(() => resolve(true)))
    socket.once('error', () => resolve(false))
  })
}

const quote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`

const env = { ...process.env }
// macOS has a /usr/bin/java stub that only says "Unable to locate a Java Runtime": ask the real thing
const brewJava = '/opt/homebrew/opt/openjdk/bin'
if (existsSync(join(brewJava, 'java')) && spawnSync('java', ['-version'], { env, stdio: 'ignore' }).status !== 0) {
  env.PATH = `${brewJava}:${env.PATH ?? ''}`
}

const playwright = ['npx', 'playwright', 'test', '-c', 'playwright.live.config.ts', ...process.argv.slice(2)]
const up = await Promise.all(Object.values(PORTS).map(listening))

let command
let args
let cwd = FRONTEND
if (up.every(Boolean)) {
  console.log('live e2e: reusing the emulators already running on 8080 / 9099 / 9199 (their data will be wiped)')
  ;[command, ...args] = playwright
} else if (up.some(Boolean)) {
  const taken = Object.entries(PORTS).filter((_, i) => up[i]).map(([name, port]) => `${port} (${name})`)
  console.error(`live e2e: port ${taken.join(', ')} is taken but not every emulator port is: stop what is listening there first`)
  process.exit(1)
} else {
  // from the repository root, where firebase.json (ports, rules) is
  cwd = ROOT
  env.TMPDIR = join(tmpdir(), 'chords-live-e2e-emulators')
  mkdirSync(env.TMPDIR, { recursive: true })
  command = 'npx'
  args = [
    '-y', FIREBASE_TOOLS, 'emulators:exec', '--only', 'auth,firestore,storage', '--project', PROJECT,
    `cd ${quote(FRONTEND)} && ${playwright.map(quote).join(' ')}`,
  ]
}

const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))

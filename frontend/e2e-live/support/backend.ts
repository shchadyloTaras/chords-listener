// The backend side of the live suite: the owner's scripts and the migration run against the emulators exactly as
// docs/CLOUD.md shows them, the seeding / sweep helper (backend/scripts/live_e2e.py), calls to the API as a user,
// and the server's own log as the record of every request it received.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { API, BACKEND_DIR, DATA_DIR, PYTHON, ROOT_DIR, SERVER_LOG, backendEnv } from './env'

function python(args: string[], { input, extraEnv }: { input?: string; extraEnv?: Record<string, string> } = {}): string {
  try {
    return execFileSync(PYTHON, args, {
      cwd: BACKEND_DIR,
      env: { ...process.env, ...backendEnv(), ...extraEnv },
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    })
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string }
    throw new Error(`${args.join(' ')} failed: ${e.message}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`)
  }
}

/** Migration 04 (docs/features/admin/migrations): `adminConfig/settings` and `publicStatus/current` from the env defaults. */
export function seedRuntimeConfig(): string {
  const migrations = join(ROOT_DIR, 'docs/features/admin/migrations')
  return python([join(migrations, '04_seed_runtime_config.up.py')], { extraEnv: { PYTHONPATH: `${BACKEND_DIR}:${migrations}` } })
}

/** The owner's `scripts/admin_grant.py grant|revoke <uid>` (the e-mail lookup and Firestore go to the emulators). */
export function adminGrant(action: 'grant' | 'revoke', uid: string): string {
  return python([join(ROOT_DIR, 'scripts/admin_grant.py'), action, uid])
}

export interface SeedSpec {
  users?: Array<{ uid: string; email: string; created?: string }>
  tracks?: Array<{ uid: string; count: number; titles?: string[] }>
  jobs?: Array<{ uid: string; title: string; status?: 'done' | 'error'; reason?: string }>
  objects?: Array<{ path: string; text: string }>
  dataset?: { users: number; tracks: number; prefix?: string }
}

/** Firestore documents and bucket objects through the canonical factories (backend/tests/admin/fixtures.py). */
export function seed(spec: SeedSpec): { documents: number; objects: number } {
  return JSON.parse(python(['scripts/live_e2e.py', 'seed'], { input: JSON.stringify(spec) }))
}

/** The scheduled deletion of `uid` is due: its `purgeAfter` moves a minute into the past (the 7 days "pass"). */
export function backdateDeletion(uid: string): string {
  return JSON.parse(python(['scripts/live_e2e.py', 'backdate-deletion', uid])).purgeAfter
}

/** One run of the server's background sweep (purges included), built from the server's own environment. */
export function sweep(): { slot: string; state: string; steps: Record<string, string>; [k: string]: unknown } {
  return JSON.parse(python(['scripts/live_e2e.py', 'sweep']))
}

/** Files the server keeps for a user (`<data>/users/<uid>`): a song's directory, to see the purge remove it. */
export function seedUserFiles(uid: string, trackId: string): string {
  const dir = join(DATA_DIR, 'users', uid, 'tracks', trackId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id: trackId, title: 'seeded' }))
  return join(DATA_DIR, 'users', uid)
}

/** Today's (UTC) usage counters of a user, as the server persists them (`<data>/users/<uid>/quota.json`). */
export function seedQuotaUsage(uid: string, analyses: number): void {
  const dir = join(DATA_DIR, 'users', uid)
  mkdirSync(dir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  writeFileSync(join(dir, 'quota.json'), JSON.stringify({ day, analyses, vocals: 0 }))
}

// ---------------------------------------------------------------------------------------------- the API

export interface Answer {
  status: number
  body: Record<string, unknown> | null
}

/** One call to the cloud API with a user's ID token (what the site's own fetches carry). */
export async function callApi(path: string, token: string, init: { method?: string; json?: unknown } = {}): Promise<Answer> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.json === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  })
  const text = await res.text()
  let body: Record<string, unknown> | null = null
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : null
  } catch {
    body = { text }
  }
  return { status: res.status, body }
}

/** The answer the server gives for an address no route serves (and for every admin route, to a non-admin: AC-31). */
export function unknownRouteAnswer(path: string): Answer {
  return { status: 404, body: { detail: `Unknown API endpoint: ${path}`, code: 'not_found' } }
}

// ---------------------------------------------------------------------------------------------- the server's log

const REQUEST_LINE = /"([A-Z]+) (\/[^ "]*) HTTP\/[\d.]+" (\d{3})/

/** The server's own record of the requests it received (uvicorn's access log in SERVER_LOG). */
export const serverLog = {
  /** A position in the log: requests after it are returned by `requestsSince`. */
  mark(): number {
    return statSync(SERVER_LOG).size
  },
  /** "METHOD /path STATUS" of every request the server logged after `mark`. */
  requestsSince(mark: number): string[] {
    const text = readFileSync(SERVER_LOG).subarray(mark).toString('utf8')
    return text
      .split('\n')
      .map((line) => REQUEST_LINE.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => `${m[1]} ${m[2].split('?')[0]} ${m[3]}`)
  },
  /** How many times the server process started (a restart would show up as a second line). */
  starts(): number {
    return (readFileSync(SERVER_LOG, 'utf8').match(/Started server process/g) ?? []).length
  },
  tail(lines = 80): string {
    return readFileSync(SERVER_LOG, 'utf8').split('\n').slice(-lines).join('\n')
  },
}

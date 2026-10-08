// The Firebase emulators over their REST APIs, as the project owner (`Authorization: Bearer owner` bypasses the
// security rules): clearing everything between specs, creating accounts, reading documents and bucket objects.
// Seeding Firestore and the bucket goes through backend/scripts/live_e2e.py (the canonical test factories).
import { BUCKET, EMULATORS, PROJECT } from './env'

const OWNER = { Authorization: 'Bearer owner' }
const FIRESTORE = `http://${EMULATORS.firestore}/v1/projects/${PROJECT}/databases/(default)/documents`
const IDENTITY = `http://${EMULATORS.auth}/identitytoolkit.googleapis.com/v1`
const STORAGE = `http://${EMULATORS.storage}/storage/v1/b/${BUCKET}/o`

async function ok(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`${what}: ${res.status} ${(await res.text()).slice(0, 300)}`)
  return res
}

/** Whether all three emulators answer (the suite needs them running: `npm run test:e2e:live` starts them). */
export async function emulatorsUp(): Promise<boolean> {
  try {
    const answers = await Promise.all([
      fetch(`http://${EMULATORS.firestore}/`),
      fetch(`http://${EMULATORS.auth}/`),
      fetch(`${STORAGE}?maxResults=1`, { headers: OWNER }),
    ])
    return answers.every((r) => r.status < 500)
  } catch {
    return false
  }
}

/** Every document, every account and every bucket object: each spec starts from nothing. */
export async function clearEmulators(): Promise<void> {
  await ok(await fetch(`http://${EMULATORS.firestore}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' }), 'clear Firestore')
  await ok(await fetch(`http://${EMULATORS.auth}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' }), 'clear Auth')
  for (const name of await listObjects('')) {
    await ok(await fetch(`${STORAGE}/${encodeURIComponent(name)}`, { method: 'DELETE', headers: OWNER }), `delete ${name}`)
  }
}

// ---------------------------------------------------------------------------------------------- Auth

export interface Account {
  uid: string
  email: string
  password: string
}

/** An email/password account with this uid (the Admin SDK's createUser), its e-mail verified. */
export async function createAccount(account: Account): Promise<void> {
  await ok(
    await fetch(`${IDENTITY}/projects/${PROJECT}/accounts`, {
      method: 'POST',
      headers: { ...OWNER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ localId: account.uid, email: account.email, password: account.password, emailVerified: true }),
    }),
    `create account ${account.uid}`,
  )
}

/** A password sign-in, as the site does it: the ID token, or the Identity Toolkit error code (EMAIL_NOT_FOUND …). */
export async function signInWithPassword(email: string, password: string): Promise<{ idToken: string } | { error: string }> {
  const res = await fetch(`${IDENTITY}/accounts:signInWithPassword?key=emulator`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  })
  const body = (await res.json()) as { idToken?: string; error?: { message?: string } }
  if (res.ok && body.idToken) return { idToken: body.idToken }
  return { error: (body.error?.message ?? `HTTP ${res.status}`).split(' ')[0] }
}

/** The ID token of a password sign-in (fails the test when the sign-in is refused). */
export async function idToken(account: Account): Promise<string> {
  const result = await signInWithPassword(account.email, account.password)
  if ('error' in result) throw new Error(`sign-in of ${account.email} refused: ${result.error}`)
  return result.idToken
}

// ---------------------------------------------------------------------------------------------- Firestore

type Value = Record<string, unknown>

function fromValue(v: Value): unknown {
  if ('nullValue' in v) return null
  if ('booleanValue' in v) return v.booleanValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return Number(v.doubleValue)
  if ('stringValue' in v) return v.stringValue
  if ('timestampValue' in v) return v.timestampValue
  if ('arrayValue' in v) return ((v.arrayValue as { values?: Value[] }).values ?? []).map(fromValue)
  if ('mapValue' in v) return fromFields((v.mapValue as { fields?: Record<string, Value> }).fields ?? {})
  return v
}

function fromFields(fields: Record<string, Value>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fromValue(v)]))
}

/** The document's fields (timestamps as ISO strings), or null when it does not exist. */
export async function getDoc(path: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${FIRESTORE}/${path}`, { headers: OWNER })
  if (res.status === 404) return null
  const body = (await (await ok(res, `get ${path}`)).json()) as { fields?: Record<string, Value> }
  return fromFields(body.fields ?? {})
}

/** The documents of a collection: id and fields. */
export async function listDocs(collection: string): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const res = await ok(await fetch(`${FIRESTORE}/${collection}?pageSize=300`, { headers: OWNER }), `list ${collection}`)
  const body = (await res.json()) as { documents?: Array<{ name: string; fields?: Record<string, Value> }> }
  return (body.documents ?? []).map((d) => ({ id: d.name.split('/').pop() ?? '', data: fromFields(d.fields ?? {}) }))
}

// ---------------------------------------------------------------------------------------------- Storage

/** Names of the bucket's objects under `prefix`. */
export async function listObjects(prefix: string): Promise<string[]> {
  const names: string[] = []
  let page = ''
  do {
    const res = await ok(await fetch(`${STORAGE}?prefix=${encodeURIComponent(prefix)}${page ? `&pageToken=${page}` : ''}`, { headers: OWNER }), 'list objects')
    const body = (await res.json()) as { items?: Array<{ name: string }>; nextPageToken?: string }
    names.push(...(body.items ?? []).map((i) => i.name))
    page = body.nextPageToken ?? ''
  } while (page)
  return names
}

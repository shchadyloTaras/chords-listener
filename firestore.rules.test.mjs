// Security-rules tests for /firestore.rules, run against the local emulators only:
//
//   PATH=/opt/homebrew/opt/openjdk/bin:$PATH npx -y firebase-tools@latest emulators:exec \
//     --only auth,firestore --project build-chords-listener "node --test firestore.rules.test.mjs"
//
// No dependencies: users come from the Auth emulator REST API, reads/writes go through the
// Firestore emulator REST API with each user's ID token (the same requests the web SDK sends,
// including server timestamps as REQUEST_TIME transforms). The published library index
// (users/{uid}/tracks/{trackId}) is written the way the API's service account writes it: the
// emulator's admin bearer token ("owner") bypasses the rules.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

const PROJECT = 'build-chords-listener'
const FIRESTORE = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080'
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'

for (const host of [FIRESTORE, AUTH]) {
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) {
    throw new Error(`Refusing to run: ${host} is not a local emulator`)
  }
}

const DOCS = `http://${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents`

const VALID_SETTINGS = {
  simplify: false,
  accidentals: 'auto',
  instrument: 'handpan',
  view: 'sheet',
  barsPerLine: 4,
  follow: true,
  showDiagrams: true,
  copyFormat: 'bars',
  theme: 'dark',
  lang: 'uk',
  showVideo: false,
}

// ---- Firestore REST value encoding ----

function encode(v) {
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }
  if (typeof v === 'string') return { stringValue: v }
  if (v === null) return { nullValue: null }
  if (v instanceof Date) return { timestampValue: v.toISOString() }
  return { mapValue: { fields: encodeFields(v) } }
}

function encodeFields(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, encode(v)]))
}

// ---- emulator helpers ----

async function createUser() {
  const res = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `rules-${randomUUID().slice(0, 8)}@example.test`,
      password: randomUUID(),
      returnSecureToken: true,
    }),
  })
  assert.equal(res.status, 200, 'auth emulator signUp')
  const body = await res.json()
  return { uid: body.localId, email: body.email, token: body.idToken }
}

/**
 * One write via documents:commit, as the web SDK does it.
 * `fields` excludes server timestamps; `serverTime` lists fields set to REQUEST_TIME.
 */
async function write(user, uid, { fields, serverTime = [], exists, mask } = {}) {
  const w = {
    update: { name: `projects/${PROJECT}/databases/(default)/documents/users/${uid}`, fields: encodeFields(fields) },
    updateTransforms: serverTime.map((fieldPath) => ({ fieldPath, setToServerValue: 'REQUEST_TIME' })),
  }
  if (exists !== undefined) w.currentDocument = { exists }
  if (mask) w.updateMask = { fieldPaths: mask }
  const res = await fetch(`${DOCS}:commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(user) },
    body: JSON.stringify({ writes: [w] }),
  })
  return res.status
}

function createProfile(user, uid = user.uid, { email = user?.email, settings = VALID_SETTINGS, extra = {} } = {}) {
  return write(user, uid, {
    fields: { email, settings, ...extra },
    serverTime: ['createdAt', 'updatedAt'],
    exists: false,
  })
}

/** updateDoc({ email, settings, updatedAt: serverTimestamp() }) */
function updateProfile(user, uid = user.uid, { email = user.email, settings = VALID_SETTINGS, extra = {} } = {}) {
  const fields = { email, settings, ...extra }
  return write(user, uid, {
    fields,
    serverTime: ['updatedAt'],
    exists: true,
    mask: Object.keys(fields),
  })
}

async function read(user, uid) {
  const res = await fetch(`${DOCS}/users/${uid}`, { headers: authHeader(user) })
  return res.status
}

async function remove(user, uid) {
  const res = await fetch(`${DOCS}/users/${uid}`, { method: 'DELETE', headers: authHeader(user) })
  return res.status
}

function authHeader(user) {
  return user ? { Authorization: `Bearer ${user.token}` } : {}
}

// ---- published library index: users/{uid}/tracks/{trackId} ----

const TRACK_FIELDS = { title: 'Wonderwall', createdAt: '2026-10-05T10:00:00+00:00', version: 3 }

/** Written like the API does (service account): admin token, rules bypassed. */
async function seedTrack(uid, id, fields = TRACK_FIELDS) {
  const res = await fetch(`${DOCS}/users/${uid}/tracks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ fields: encodeFields(fields) }),
  })
  assert.equal(res.status, 200, 'seed the track index document')
}

async function readTrack(user, uid, id) {
  const res = await fetch(`${DOCS}/users/${uid}/tracks/${id}`, { headers: authHeader(user) })
  return res.status
}

/** The library's live query: collection(db, 'users', uid, 'tracks') ordered by createdAt, newest first. */
function listTracks(user, uid) {
  return fetch(`${DOCS}/users/${uid}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(user) },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'tracks' }],
        orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
      },
    }),
  })
}

function writeTrack(user, uid, id, { fields = TRACK_FIELDS, exists } = {}) {
  const w = { update: { name: `projects/${PROJECT}/databases/(default)/documents/users/${uid}/tracks/${id}`, fields: encodeFields(fields) } }
  if (exists !== undefined) w.currentDocument = { exists }
  return fetch(`${DOCS}:commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(user) },
    body: JSON.stringify({ writes: [w] }),
  }).then((res) => res.status)
}

async function removeTrack(user, uid, id) {
  const res = await fetch(`${DOCS}/users/${uid}/tracks/${id}`, { method: 'DELETE', headers: authHeader(user) })
  return res.status
}

async function clearEmulators() {
  await fetch(`http://${FIRESTORE}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
  await fetch(`http://${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' })
}

const OK = 200
const DENIED = 403

// ---- tests ----

describe('users/{uid}', () => {
  let alice
  let bob

  before(async () => {
    await clearEmulators()
    alice = await createUser()
    bob = await createUser()
  })

  after(clearEmulators)

  test('owner creates a valid profile (instrument "handpan" allowed)', async () => {
    assert.equal(await createProfile(alice), OK)
  })

  test('owner reads their profile', async () => {
    assert.equal(await read(alice, alice.uid), OK)
  })

  test('owner updates their settings', async () => {
    assert.equal(await updateProfile(alice, alice.uid, { settings: { ...VALID_SETTINGS, theme: 'light', instrument: 'piano' } }), OK)
  })

  test('the score view ("score") is a valid view', async () => {
    assert.equal(await updateProfile(alice, alice.uid, { settings: { ...VALID_SETTINGS, view: 'score' } }), OK)
  })

  test('the bass, the harmonium, the sopilka and the flute are valid instruments', async () => {
    for (const instrument of ['bass', 'harmonium', 'sopilka', 'flute']) {
      assert.equal(await updateProfile(alice, alice.uid, { settings: { ...VALID_SETTINGS, instrument } }), OK)
    }
  })

  test('another user cannot read it', async () => {
    assert.equal(await read(bob, alice.uid), DENIED)
  })

  test('a signed-out visitor cannot read it', async () => {
    assert.equal(await read(null, alice.uid), DENIED)
  })

  test('another user cannot overwrite or update it', async () => {
    assert.equal(await updateProfile(bob, alice.uid, { email: bob.email }), DENIED)
    assert.equal(await updateProfile(bob, alice.uid), DENIED)
  })

  test('another user cannot delete it', async () => {
    assert.equal(await remove(bob, alice.uid), DENIED)
  })

  test('nobody can create a profile under someone else’s uid', async () => {
    assert.equal(await createProfile(bob, `not-${bob.uid}`), DENIED)
    assert.equal(await createProfile(null, 'anonymous', { email: 'anonymous@example.test' }), DENIED)
  })

  test('collection queries are denied', async () => {
    const res = await fetch(`${DOCS}:runQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(alice) },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'users' }] } }),
    })
    assert.equal(res.status, DENIED)
  })

  test('other collections are denied', async () => {
    const res = await fetch(`${DOCS}/tracks/x`, { headers: authHeader(alice) })
    assert.equal(res.status, DENIED)
  })

  const invalid = {
    'barsPerLine = 3': { barsPerLine: 3 },
    'barsPerLine as a string': { barsPerLine: '4' },
    'theme = "blue"': { theme: 'blue' },
    'unknown instrument': { instrument: 'banjo' },
    'string instead of bool': { simplify: 'yes' },
    'unknown lang': { lang: 'de' },
    'unknown view': { view: 'tabs' },
  }
  for (const [name, patch] of Object.entries(invalid)) {
    test(`invalid settings are rejected: ${name}`, async () => {
      const settings = { ...VALID_SETTINGS, ...patch }
      assert.equal(await updateProfile(alice, alice.uid, { settings }), DENIED)
      assert.equal(await createProfile(bob, bob.uid, { settings }), DENIED)
    })
  }

  test('settings with a missing or an extra key are rejected', async () => {
    const { showVideo: _omit, ...missing } = VALID_SETTINGS
    assert.equal(await updateProfile(alice, alice.uid, { settings: missing }), DENIED)
    assert.equal(await updateProfile(alice, alice.uid, { settings: { ...VALID_SETTINGS, volume: 1 } }), DENIED)
  })

  test('extra top-level fields are rejected', async () => {
    assert.equal(await updateProfile(alice, alice.uid, { extra: { isAdmin: true } }), DENIED)
    assert.equal(await createProfile(bob, bob.uid, { extra: { isAdmin: true } }), DENIED)
  })

  test('email must match the signed-in account', async () => {
    assert.equal(await updateProfile(alice, alice.uid, { email: bob.email }), DENIED)
    assert.equal(await createProfile(bob, bob.uid, { email: alice.email }), DENIED)
  })

  test('createdAt is immutable and updatedAt must be the server time', async () => {
    assert.equal(
      await write(alice, alice.uid, {
        fields: { createdAt: new Date('2020-01-01T00:00:00Z') },
        serverTime: ['updatedAt'],
        exists: true,
        mask: ['createdAt'],
      }),
      DENIED,
    )
    assert.equal(
      await write(alice, alice.uid, {
        fields: { updatedAt: new Date('2020-01-01T00:00:00Z') },
        exists: true,
        mask: ['updatedAt'],
      }),
      DENIED,
    )
  })

  test('a client-chosen createdAt is rejected on create', async () => {
    assert.equal(
      await write(bob, bob.uid, {
        fields: { email: bob.email, settings: VALID_SETTINGS, createdAt: new Date('2020-01-01T00:00:00Z') },
        serverTime: ['updatedAt'],
        exists: false,
      }),
      DENIED,
    )
  })

  test('owner can delete their profile', async () => {
    assert.equal(await remove(alice, alice.uid), OK)
  })
})

describe('users/{uid}/tracks/{trackId} (the published library index)', () => {
  const TRACK = '0123456789ab'
  let alice
  let bob

  before(async () => {
    await clearEmulators()
    alice = await createUser()
    bob = await createUser()
    await seedTrack(alice.uid, TRACK)
  })

  after(clearEmulators)

  test('owner gets a track document', async () => {
    assert.equal(await readTrack(alice, alice.uid, TRACK), OK)
  })

  test('owner lists their library (the live query, ordered by createdAt)', async () => {
    const res = await listTracks(alice, alice.uid)
    assert.equal(res.status, OK)
    const rows = (await res.json()).filter((row) => row.document)
    assert.equal(rows.length, 1)
    assert.match(rows[0].document.name, new RegExp(`/users/${alice.uid}/tracks/${TRACK}$`))
  })

  test('another user can neither get nor list it', async () => {
    assert.equal(await readTrack(bob, alice.uid, TRACK), DENIED)
    assert.equal((await listTracks(bob, alice.uid)).status, DENIED)
  })

  test('a signed-out visitor can neither get nor list it', async () => {
    assert.equal(await readTrack(null, alice.uid, TRACK), DENIED)
    assert.equal((await listTracks(null, alice.uid)).status, DENIED)
  })

  test('a collection-group query over every user’s tracks is denied', async () => {
    const res = await fetch(`${DOCS}:runQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(alice) },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'tracks', allDescendants: true }] } }),
    })
    assert.equal(res.status, DENIED)
  })

  test('the owner cannot create, update or delete a track document', async () => {
    assert.equal(await writeTrack(alice, alice.uid, 'ba9876543210', { exists: false }), DENIED)
    assert.equal(await writeTrack(alice, alice.uid, TRACK, { fields: { title: 'Mine now', version: 99 } }), DENIED)
    assert.equal(await removeTrack(alice, alice.uid, TRACK), DENIED)
    assert.equal(await readTrack(alice, alice.uid, 'ba9876543210'), 404, 'nothing was created')
    assert.equal(await readTrack(alice, alice.uid, TRACK), OK, 'the document is still there')
  })

  test('another user cannot write one into the owner’s library', async () => {
    assert.equal(await writeTrack(bob, alice.uid, 'ba9876543210', { exists: false }), DENIED)
    assert.equal(await writeTrack(bob, alice.uid, TRACK), DENIED)
    assert.equal(await removeTrack(bob, alice.uid, TRACK), DENIED)
  })

  test('other subcollections under the user stay denied', async () => {
    const res = await fetch(`${DOCS}/users/${alice.uid}/publish-pending/x`, { headers: authHeader(alice) })
    assert.equal(res.status, DENIED)
  })
})

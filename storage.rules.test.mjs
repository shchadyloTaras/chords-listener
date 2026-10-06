// Security-rules tests for /storage.rules, run against the local emulators only:
//
//   PATH=/opt/homebrew/opt/openjdk/bin:$PATH npx -y firebase-tools@latest emulators:exec \
//     --only auth,storage --project build-chords-listener "node --test storage.rules.test.mjs"
//
// No dependencies: users come from the Auth emulator REST API, client reads/writes go through the
// Storage emulator's Firebase REST API (/v0/b/<bucket>/o, the requests the web SDK sends) with each
// user's ID token. The library files are put in place the way the API's service account does it:
// the emulator's admin bearer token ("owner") bypasses the rules.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

const PROJECT = 'build-chords-listener'
const BUCKET = `${PROJECT}.firebasestorage.app`
const STORAGE = process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '127.0.0.1:9199'
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'

for (const host of [STORAGE, AUTH]) {
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) {
    throw new Error(`Refusing to run: ${host} is not a local emulator`)
  }
}

const OBJECTS = `http://${STORAGE}/v0/b/${BUCKET}/o`
const TRACK = '0123456789ab'
const BASE = (uid) => `users/${uid}/tracks/${TRACK}`

const OK = 200
const DENIED = 403
const NOT_FOUND = 404

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
  return { uid: body.localId, token: body.idToken }
}

function authHeader(user) {
  return user ? { Authorization: `Firebase ${user.token}` } : {}
}

/** The API's service account puts an object there (admin token, rules bypassed). */
async function put(path, body = 'x', contentType = 'application/octet-stream') {
  const res = await fetch(
    `http://${STORAGE}/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(path)}`,
    { method: 'POST', headers: { 'Content-Type': contentType, Authorization: 'Bearer owner' }, body },
  )
  assert.equal(res.status, 200, `seed ${path}`)
}

/** getBytes(ref(storage, path)): the object's content, with the user's ID token. */
async function read(user, path) {
  const res = await fetch(`${OBJECTS}/${encodeURIComponent(path)}?alt=media`, { headers: authHeader(user) })
  return res.status
}

/** uploadBytes(ref(storage, path), …) as a client. */
async function upload(user, path, contentType = 'audio/mpeg') {
  const res = await fetch(`${OBJECTS}?name=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, ...authHeader(user) },
    body: 'x',
  })
  return res.status
}

async function remove(user, path) {
  const res = await fetch(`${OBJECTS}/${encodeURIComponent(path)}`, { method: 'DELETE', headers: authHeader(user) })
  return res.status
}

async function clearEmulators() {
  await fetch(`http://${STORAGE}/emulator/v1/projects/${PROJECT}/buckets/${BUCKET}`, { method: 'DELETE' })
  await fetch(`http://${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' })
}

const READABLE = ['track.json', 'notes.json', 'vocals.json', 'audio.mp3', 'stems/vocals.mp3', 'stems/instruments.mp3']
const PRIVATE = ['meta.json', 'analysis.json', 'edits.json', 'stems/drums.mp3', 'stems/vocals.wav']

describe('users/{uid}/tracks/{trackId}/… (the published library files)', () => {
  let alice
  let bob

  before(async () => {
    await clearEmulators()
    alice = await createUser()
    bob = await createUser()
    for (const file of [...READABLE, ...PRIVATE]) await put(`${BASE(alice.uid)}/${file}`)
    await put(`users/${alice.uid}/quota.json`)
    await put(`users/${alice.uid}/publish-pending.json`)
  })

  after(clearEmulators)

  for (const file of READABLE) {
    test(`owner reads ${file}`, async () => {
      assert.equal(await read(alice, `${BASE(alice.uid)}/${file}`), OK)
    })
  }

  test('another user and a signed-out visitor cannot read any of them', async () => {
    for (const file of READABLE) {
      assert.equal(await read(bob, `${BASE(alice.uid)}/${file}`), DENIED, `bob reads ${file}`)
      assert.equal(await read(null, `${BASE(alice.uid)}/${file}`), DENIED, `anonymous reads ${file}`)
    }
  })

  test('a file that is not there yet is "not found" for the owner (notes / vocals not computed)', async () => {
    assert.equal(await read(alice, `users/${alice.uid}/tracks/ba9876543210/vocals.json`), NOT_FOUND)
    assert.equal(await read(bob, `users/${alice.uid}/tracks/ba9876543210/vocals.json`), DENIED)
  })

  for (const file of PRIVATE) {
    test(`the owner cannot read ${file} (only the API does)`, async () => {
      assert.equal(await read(alice, `${BASE(alice.uid)}/${file}`), DENIED)
    })
  }

  test('quota.json and publish-pending.json stay private', async () => {
    assert.equal(await read(alice, `users/${alice.uid}/quota.json`), DENIED)
    assert.equal(await read(alice, `users/${alice.uid}/publish-pending.json`), DENIED)
  })

  test('nobody can write, overwrite or delete a library file, the owner included', async () => {
    for (const user of [alice, bob, null]) {
      for (const file of ['track.json', 'audio.mp3', 'stems/vocals.mp3', 'new.json']) {
        const path = `${BASE(alice.uid)}/${file}`
        const who = user === alice ? 'alice' : user === bob ? 'bob' : 'anonymous'
        assert.equal(await upload(user, path), DENIED, `${who} uploads ${file}`)
        assert.equal(await remove(user, path), DENIED, `${who} deletes ${file}`)
      }
    }
    assert.equal(await read(alice, `${BASE(alice.uid)}/track.json`), OK, 'still there')
  })

  test('a client cannot upload into a track of its own either', async () => {
    assert.equal(await upload(bob, `${BASE(bob.uid)}/track.json`, 'application/json'), DENIED)
  })

  test('uploads are unchanged: the owner creates one, nobody reads it from the client', async () => {
    const path = `users/${bob.uid}/uploads/${randomUUID()}/recording.mp3`
    assert.equal(await upload(bob, path), OK)
    assert.equal(await read(bob, path), DENIED)
    assert.equal(await upload(alice, `users/${bob.uid}/uploads/${randomUUID()}/recording.mp3`), DENIED)
  })
})

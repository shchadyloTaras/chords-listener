// Where the live e2e suite runs (playwright.live.config.ts): the Firebase emulators on the ports the frontend
// hardcodes for a VITE_FIREBASE_EMULATORS=true build (src/lib/firebase.ts, src/lib/cloud/storage.ts), the real backend
// in cloud mode on API_PORT, and the hosted build (base /chords-listener/) served by `vite preview` on SITE_PORT.
// Read by the Playwright config (runner process) and by the specs (worker process): everything here is a pure
// function of the environment, so both agree.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT = 'build-chords-listener'
export const BUCKET = 'build-chords-listener.firebasestorage.app'
export const EMULATORS = { auth: '127.0.0.1:9099', firestore: '127.0.0.1:8080', storage: '127.0.0.1:9199' } as const

export const API_PORT = Number(process.env.LIVE_API_PORT || 8775)
export const SITE_PORT = Number(process.env.LIVE_SITE_PORT || 4183)
/** The cloud API the build talks to (VITE_CLOUD_API_URL): the backend under test. */
export const API = `http://127.0.0.1:${API_PORT}`
export const BASE_PATH = '/chords-listener/'
/** The site's origin. `localhost`, not 127.0.0.1: index.html moves a page opened on a bare IP to localhost. */
export const SITE = `http://localhost:${SITE_PORT}`
export const SITE_HOME = `${SITE}${BASE_PATH}`
export const ADMIN_PAGE = `${SITE}${BASE_PATH}admin.html`

export const FRONTEND_DIR = fileURLToPath(new URL('../../', import.meta.url))
export const ROOT_DIR = fileURLToPath(new URL('../../../', import.meta.url))
export const BACKEND_DIR = join(ROOT_DIR, 'backend')
/** The backend's interpreter: `uv sync` puts it in backend/.venv (LIVE_PYTHON overrides). */
export const PYTHON = process.env.LIVE_PYTHON || join(BACKEND_DIR, '.venv', 'bin', 'python')

/** Scratch of one run: the server's data directory and its log (wiped when the server starts). */
export const RUN_DIR = process.env.LIVE_RUN_DIR || join(tmpdir(), `chords-live-e2e-${API_PORT}`)
export const DATA_DIR = join(RUN_DIR, 'data')
/** Everything the server prints, uvicorn's access log included: the server-side record of every request. */
export const SERVER_LOG = join(RUN_DIR, 'backend.log')

/** Whether the 30-minute specs run (the scheduled CI run sets it). */
export const SLOW = process.env.LIVE_SLOW === '1'

/**
 * The server's environment: cloud mode against the emulators (README «Розробка», docs/CLOUD.md «Cloud Run settings»).
 * The Python helpers get the same, so the sweep they run is built exactly like the server's.
 */
export function backendEnv(): Record<string, string> {
  return {
    CHORDS_AUTH: 'firebase',
    CHORDS_FIREBASE_PROJECT: PROJECT,
    CHORDS_DATA_DIR: DATA_DIR,
    CHORDS_WORK_DIR: join(RUN_DIR, 'work'),
    CHORDS_UPLOAD_BUCKET: BUCKET,
    CHORDS_SIGNING_KEY: 'live-e2e-signing-key-not-a-secret',
    CHORDS_MAX_INSTANCES: '1',
    CHORDS_QUOTA_ANALYSES: '40',
    CHORDS_QUOTA_VOCALS: '15',
    CHORDS_QUOTA_JOBS: '2',
    FIRESTORE_EMULATOR_HOST: EMULATORS.firestore,
    FIREBASE_AUTH_EMULATOR_HOST: EMULATORS.auth,
    STORAGE_EMULATOR_HOST: `http://${EMULATORS.storage}`,
    PYTHONUNBUFFERED: '1',
  }
}

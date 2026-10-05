// Where the chord server is, if anywhere (docs/CLOUD.md "Frontend config"), in this order:
//  1. same origin — the page is served by the backend (./start.sh, http://localhost:8765) or proxied by Vite;
//  2. cloud — the signed-in user's cloud API (Cloud Run, `CLOUD_API_URL`); every call carries the
//     Firebase ID token (lib/api.ts). Selected right away, without a request: any request wakes an instance
//     that then bills for a while, so the cloud is asked only for real work (its health too, see
//     refreshCloudHealth); a cold start only delays the first answer;
//  3. remote — the user's own server at `serverUrl` (advanced, opt-in `useServerPrefs.localServer`);
//  4. none — "browser mode": files and recordings are analyzed in the page and kept in IndexedDB.
//
// Chrome's Local Network Access (Chrome 142+): a public https page needs the user's permission
// ("loopback-network" / "local-network", formerly "local-network-access") before it may reach
// http://localhost or a LAN address. The first request shows the browser prompt, so a page that is still
// at "prompt" is only probed when the user asks for it (a click), never in the background.
// http://localhost itself is a potentially trustworthy origin (no mixed-content block in Chrome/Firefox);
// LAN host names need fetch(..., { targetAddressSpace: 'local' }) to be exempt from mixed-content checks.
import { useEffect } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { CLOUD_API_URL } from '../config'
import { useApp } from '../store'
import type { Health } from '../types'
import { useAuth } from './auth'

/** Static build hosted away from the backend (GitHub Pages, base "/chords-listener/"). */
export const HOSTED = import.meta.env.BASE_URL !== '/'

export const SAME_ORIGIN_API = '/api'
export const PROJECT_REPO = 'https://github.com/shchadyloTaras/chords-listener.git'

export type ConnectionStatus = 'checking' | 'server' | 'browser'
/** who answers while `status === 'server'`: a local server (same origin or the user's own) or the cloud API */
export type Backend = 'local' | 'cloud'
export type NetworkPermission = 'granted' | 'prompt' | 'denied' | 'unsupported'
/** why the last probe did not reach a server */
export type ProbeFailure = 'unreachable' | 'permission' | 'blocked' | 'invalid-url' | 'not-chords'
export type AddressSpace = 'loopback' | 'local' | 'public'

export interface ConnectionState {
  status: ConnectionStatus
  backend: Backend | null
  /** API base of the connected server: "/api" or "http://localhost:8765/api" */
  apiBase: string | null
  /** origin of the connected server (absolute), used to resolve URLs it returns */
  serverOrigin: string | null
  /** the connected server is on another origin than the page */
  remote: boolean
  health: Health | null
  /** browser permission to reach the configured server (Local Network Access) */
  permission: NetworkPermission
  probing: boolean
  failure: ProbeFailure | null
  checkedAt: number
  /** a health check or a request the user is waiting for is on its way to the cloud (see cloudWaking) */
  cloudBusy: boolean
}

const createConnectionStore = () =>
  create<ConnectionState>()(() => ({
    status: 'checking',
    backend: null,
    apiBase: null,
    serverOrigin: null,
    remote: false,
    health: null,
    permission: 'unsupported',
    probing: false,
    failure: null,
    checkedAt: 0,
    cloudBusy: false,
  }))

// Dev only: keep the one store across hot reloads of this module (components and lib/api must agree).
export const useConnection: ReturnType<typeof createConnectionStore> =
  import.meta.hot?.data?.useConnection ?? createConnectionStore()
if (import.meta.hot?.data) import.meta.hot.data.useConnection = useConnection

interface ServerPrefs {
  /** use the user's own server at `serverUrl` (opt-in on the hosted site, always on in local builds) */
  localServer: boolean
}

export const useServerPrefs = create<ServerPrefs>()(
  persist(() => ({ localServer: !HOSTED }), { name: 'chords-listener-server', version: 1 }),
)

export function setLocalServerEnabled(on: boolean): void {
  useServerPrefs.setState({ localServer: on })
}

// ------------------------------------------------------------------ addresses

/**
 * Cloud API prefix ("https://chords-api-….run.app", no trailing "/" or "/api"), or null when not
 * configured / not a valid http(s) URL.
 */
export function normalizeCloudUrl(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim().replace(/\/+$/, '').replace(/\/api$/, '')
  if (!text) return null
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return null
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

/** The configured cloud API prefix (null = this build has no cloud). */
export function cloudPrefix(): string | null {
  return normalizeCloudUrl(CLOUD_API_URL)
}

/** "localhost:8765", "http://127.0.0.1:8765/api/" → "http://localhost:8765"-style origin, or null. */
export function normalizeServerUrl(raw: string): string | null {
  let text = raw.trim()
  if (!text) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return null
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null
  return u.origin
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

/** Address space a host name belongs to, as far as the name alone tells. */
export function addressSpaceOf(hostname: string): AddressSpace {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '::1' || h === '0.0.0.0') return 'loopback'
  if (
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^f[cd][0-9a-f]{2}:/.test(h) ||
    /^fe80:/.test(h) ||
    h.endsWith('.local')
  )
    return 'local'
  return 'public'
}

function pageSpace(): AddressSpace {
  return typeof location === 'undefined' ? 'loopback' : addressSpaceOf(location.hostname)
}

/**
 * Address space Chrome will gate a request to `origin` with, when the page itself is public
 * (null = no Local Network Access permission involved).
 */
export function gatedSpace(origin: string, page: AddressSpace = pageSpace()): 'loopback' | 'local' | null {
  if (page !== 'public') return null
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    return null
  }
  const space = addressSpaceOf(host)
  if (space !== 'public') return space
  // a LAN name like "studio-mac.lan" over plain http: we can only assume it is local
  return origin.startsWith('http:') && !isIpLiteral(host.replace(/^\[|\]$/g, '')) ? 'local' : null
}

/**
 * `targetAddressSpace` to pass to fetch(): needed only for http LAN names on an https page (mixed content);
 * loopback and private IP literals are recognized by the browser on its own.
 */
export function addressHint(url: string, page: AddressSpace = pageSpace(), secure = isSecurePage()): 'local' | null {
  if (!secure) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'http:') return null
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (addressSpaceOf(host) !== 'public' || isIpLiteral(host)) return null
  return gatedSpace(u.origin, page) === 'local' ? 'local' : null
}

function isSecurePage(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'https:'
}

/** fetch() towards the chord server, with the Local Network Access hint when the browser needs one. */
export function serverFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const hint = addressHint(url)
  if (hint) {
    try {
      return fetch(new Request(url, { ...init, targetAddressSpace: hint } as RequestInit & { targetAddressSpace: string }))
    } catch {
      /* this browser does not know the option */
    }
  }
  return fetch(url, init)
}

/** Whether uploads must use fetch() (no progress events) instead of XHR, which cannot carry the hint. */
export function needsFetchUpload(url: string): boolean {
  return addressHint(url) !== null
}

/**
 * Resolves a path the server returned ("/api/tracks/…/audio", signed "…/audio?u=…&exp=…&sig=…" in the
 * cloud) against the connected server.
 */
export function resolveServerUrl(path: string): string {
  const { remote, serverOrigin } = useConnection.getState()
  if (!path || !remote || !serverOrigin || !path.startsWith('/') || path.startsWith('//')) return path
  return serverOrigin + path
}

// ------------------------------------------------------------------ permission (Chrome LNA)

const watched = new WeakSet<PermissionStatus>()

async function queryPermission(space: 'loopback' | 'local'): Promise<NetworkPermission> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unsupported'
  const names = space === 'loopback' ? ['loopback-network', 'local-network-access'] : ['local-network', 'local-network-access']
  for (const name of names) {
    try {
      const status = await navigator.permissions.query({ name } as unknown as PermissionDescriptor)
      if (!watched.has(status)) {
        watched.add(status)
        status.addEventListener('change', () => {
          useConnection.setState({ permission: status.state })
          if (status.state === 'granted') void probeServer()
        })
      }
      return status.state
    } catch {
      /* permission name unknown to this browser: try the next one */
    }
  }
  return 'unsupported'
}

// ------------------------------------------------------------------ probing

export interface Candidate {
  base: string
  /** prefix that server-relative URLs ("/api/…") are resolved against */
  origin: string
  remote: boolean
  backend: Backend
}

export interface CandidateInput {
  /** static build hosted away from the backend (GitHub Pages) */
  hosted: boolean
  /** the page's origin */
  here: string
  signedIn: boolean
  /** CLOUD_API_URL ('' = none) */
  cloudUrl: string
  /** the user opted into their own server */
  localServer: boolean
  serverUrl: string
}

/**
 * API bases to try, in the order of docs/CLOUD.md: same-origin server → cloud (signed in) →
 * the user's own server (opt-in). Empty = browser mode. `invalidServerUrl` flags an unusable address.
 */
export function candidateList(i: CandidateInput): { list: Candidate[]; invalidServerUrl: boolean } {
  const list: Candidate[] = []
  if (!i.hosted && i.here) list.push({ base: SAME_ORIGIN_API, origin: i.here, remote: false, backend: 'local' })
  const cloud = normalizeCloudUrl(i.cloudUrl)
  if (i.signedIn && cloud) list.push({ base: `${cloud}/api`, origin: new URL(cloud).origin, remote: true, backend: 'cloud' })
  let invalidServerUrl = false
  if (i.localServer) {
    const origin = normalizeServerUrl(i.serverUrl)
    if (!origin) invalidServerUrl = true
    else if (i.hosted || origin !== i.here) list.push({ base: `${origin}/api`, origin, remote: true, backend: 'local' })
  }
  return { list, invalidServerUrl }
}

function currentCandidates() {
  return candidateList({
    hosted: HOSTED,
    here: typeof location !== 'undefined' ? location.origin : '',
    signedIn: !!useAuth.getState().user,
    cloudUrl: CLOUD_API_URL,
    localServer: useServerPrefs.getState().localServer,
    serverUrl: useApp.getState().serverUrl,
  })
}

/** Waits (bounded) until Firebase has restored or ruled out a saved session. */
function authSettled(timeoutMs: number): Promise<void> {
  if (useAuth.getState().ready) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      unsubscribe()
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    const unsubscribe = useAuth.subscribe((s) => {
      if (s.ready) done()
    })
  })
}

/** How long the first selection waits for Firebase to restore a session before going without it. */
const AUTH_WAIT_MS = 8000
/** Cloud Run scales to zero: the first health check may wait for an instance to start. */
const CLOUD_HEALTH_TIMEOUT_MS = 60_000

function isHealth(v: unknown): v is Health {
  if (!v || typeof v !== 'object') return false
  const h = v as Partial<Health>
  return typeof h.ok === 'boolean' && !!h.engine && typeof h.engine === 'object'
}

type HealthResult = { health: Health } | { failure: ProbeFailure }

async function fetchHealth(base: string, timeoutMs: number): Promise<HealthResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await serverFetch(`${base}/health`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    })
    if (!res.ok) return { failure: res.status === 404 ? 'not-chords' : 'unreachable' }
    const body: unknown = await res.json().catch(() => null)
    return isHealth(body) ? { health: body } : { failure: 'not-chords' }
  } catch {
    return { failure: 'unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

let inflight: Promise<boolean> | null = null
let pendingInteractive: Promise<boolean> | null = null
/** a probe was asked for while one was running (e.g. the user signed in meanwhile): run again after it */
let rerun = false

/**
 * Picks the API (same origin → cloud → `serverUrl` → browser mode) and updates the connection state.
 * `interactive` = the user asked for it (a click): may show the browser's local-network prompt and waits for it.
 */
export function probeServer(opts: { interactive?: boolean } = {}): Promise<boolean> {
  if (!opts.interactive) {
    if (inflight) {
      rerun = true
      return inflight
    }
    inflight = (async () => {
      let ok = await run(false)
      while (rerun) {
        rerun = false
        ok = await run(false)
      }
      return ok
    })().finally(() => (inflight = null))
    return inflight
  }
  if (pendingInteractive) return pendingInteractive
  const prev = inflight ?? Promise.resolve(false)
  pendingInteractive = prev
    .catch(() => false)
    .then(() => (inflight = run(true).finally(() => (inflight = null))))
    .finally(() => (pendingInteractive = null))
  return pendingInteractive
}

// ------------------------------------------------------------------ the cloud's health (asked only when needed)

let cloudHolds = 0

/** Something waits for the cloud to answer until the returned release is called (see cloudWaking). */
export function holdCloudBusy(): () => void {
  if (++cloudHolds === 1) useConnection.setState({ cloudBusy: true })
  let held = true
  return () => {
    if (!held) return
    held = false
    if (--cloudHolds === 0) useConnection.setState({ cloudBusy: false })
  }
}

/**
 * The cloud is being asked and has not answered yet: Cloud Run may be starting an instance (up to a minute).
 * Health that nobody has asked for is not "waking" — an idle page asks the cloud nothing.
 */
export function cloudWaking(s: Pick<ConnectionState, 'status' | 'backend' | 'health' | 'failure' | 'cloudBusy'>): boolean {
  return s.status === 'server' && s.backend === 'cloud' && !s.health && !s.failure && s.cloudBusy
}

/** The cloud's engine features seen at its last health check, kept for a day (vocals or not, without asking). */
const FEATURES_KEY = 'chords-listener-cloud-health'
const FEATURES_TTL_MS = 24 * 3600_000

type Features = Health['engine']['features']

function saveFeatures(base: string, features: Features): void {
  try {
    localStorage.setItem(FEATURES_KEY, JSON.stringify({ base, features, savedAt: Date.now() }))
  } catch {
    /* storage blocked: the next page asks again when it needs to */
  }
}

/** The connected cloud's features from its last health check (younger than a day), or null. */
export function cachedFeatures(): Features | null {
  const { apiBase } = useConnection.getState()
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(FEATURES_KEY) ?? 'null')
    if (!saved || typeof saved !== 'object') return null
    const { base, features, savedAt } = saved as { base?: unknown; features?: unknown; savedAt?: unknown }
    if (base !== apiBase || typeof savedAt !== 'number' || Date.now() - savedAt > FEATURES_TTL_MS) return null
    return features && typeof features === 'object' ? (features as Features) : null
  } catch {
    return null
  }
}

let cloudHealth: { base: string; promise: Promise<void> } | null = null

/**
 * Asks the cloud's /health (deduplicated). Only when something needs it: the mode popover opens, vocals
 * support is asked (lib/vocals), a request just failed at the network level. Never polled, never on connect:
 * an idle tab must let Cloud Run scale to zero.
 */
export function refreshCloudHealth(): Promise<void> {
  const { backend, apiBase } = useConnection.getState()
  if (backend !== 'cloud' || !apiBase) return Promise.resolve()
  if (cloudHealth?.base === apiBase) return cloudHealth.promise
  const base = apiBase
  const release = holdCloudBusy()
  const promise = fetchHealth(base, CLOUD_HEALTH_TIMEOUT_MS)
    .then((result) => {
      const now = useConnection.getState()
      if (now.backend !== 'cloud' || now.apiBase !== base) return
      if ('health' in result) {
        if (result.health.engine.features) saveFeatures(base, result.health.engine.features)
        useConnection.setState({ health: result.health, failure: null, checkedAt: Date.now() })
      } else useConnection.setState({ failure: result.failure, checkedAt: Date.now() })
    })
    .finally(() => {
      release()
      if (cloudHealth?.base === base) cloudHealth = null
    })
  cloudHealth = { base, promise }
  return promise
}

/** Asks the cloud's health if nothing is known about it yet (it was not needed so far on this page). */
export function needCloudHealth(): void {
  const s = useConnection.getState()
  if (s.backend === 'cloud' && !s.health && !s.failure) void refreshCloudHealth()
}

/** The cloud answers for the signed-in user from now on (nothing is asked: see refreshCloudHealth). */
function selectCloud(c: Candidate): void {
  const prev = useConnection.getState()
  const same = prev.status === 'server' && prev.backend === 'cloud' && prev.apiBase === c.base
  useConnection.setState({
    status: 'server',
    backend: 'cloud',
    apiBase: c.base,
    serverOrigin: c.origin,
    remote: true,
    health: same ? prev.health : null,
    permission: 'unsupported',
    probing: false,
    failure: same ? prev.failure : null,
    checkedAt: Date.now(),
  })
}

async function run(interactive: boolean): Promise<boolean> {
  useConnection.setState({ probing: true })
  let { list, invalidServerUrl } = currentCandidates()
  let failure: ProbeFailure | null = null
  let permission: NetworkPermission = 'unsupported'
  // Everything after the same-origin server depends on the session: wait (once) for Firebase to
  // restore it before choosing between the cloud and the user's own server.
  let authChecked = !cloudPrefix() || useAuth.getState().ready
  const settleAuth = async () => {
    authChecked = true
    await authSettled(AUTH_WAIT_MS)
    const fresh = currentCandidates()
    invalidServerUrl = fresh.invalidServerUrl
    return fresh.list.filter((f) => f.base !== SAME_ORIGIN_API)
  }
  for (let i = 0; i < list.length; i++) {
    if (!authChecked && list[i].remote) {
      list = [...list.slice(0, i), ...(await settleAuth())]
      if (i >= list.length) break
    }
    const c = list[i]
    if (c.backend === 'cloud') {
      selectCloud(c)
      return true
    }
    const gated = c.remote ? gatedSpace(c.origin) : null
    let timeout = interactive ? 8000 : 4000
    if (gated) {
      permission = await queryPermission(gated)
      if (permission === 'denied' && !interactive) {
        failure = 'blocked'
        continue
      }
      if (permission === 'prompt') {
        if (!interactive) {
          failure = 'permission'
          continue
        }
        timeout = 90_000 // the browser is asking the user
      }
    }
    const result = await fetchHealth(c.base, timeout)
    if ('health' in result) {
      useConnection.setState({
        status: 'server',
        backend: 'local',
        apiBase: c.base,
        serverOrigin: c.origin,
        remote: c.remote,
        health: result.health,
        permission: gated ? 'granted' : permission,
        probing: false,
        failure: null,
        checkedAt: Date.now(),
      })
      return true
    }
    failure = result.failure
    if (gated && failure === 'unreachable') {
      // a refused prompt looks like a network error: tell the two apart
      permission = await queryPermission(gated)
      if (permission === 'denied') failure = 'blocked'
    }
  }
  if (!authChecked) {
    // nothing else was tried: a restored session may still bring in the cloud
    const cloud = (await settleAuth()).find((c) => c.backend === 'cloud')
    if (cloud) {
      selectCloud(cloud)
      return true
    }
  }
  useConnection.setState({
    status: 'browser',
    backend: null,
    apiBase: null,
    serverOrigin: null,
    remote: false,
    health: null,
    permission,
    probing: false,
    failure: failure ?? (invalidServerUrl ? 'invalid-url' : null),
    checkedAt: Date.now(),
  })
  return false
}

/** Resolves once the first probe has finished (or after `timeoutMs`). */
export function whenSettled(timeoutMs = 10_000): Promise<ConnectionState> {
  const now = useConnection.getState()
  if (now.status !== 'checking') return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      unsubscribe()
      resolve(useConnection.getState())
    }
    const timer = setTimeout(done, timeoutMs)
    const unsubscribe = useConnection.subscribe((s) => {
      if (s.status !== 'checking') done()
    })
  })
}

let troubleTimer: ReturnType<typeof setTimeout> | null = null

/** A server request failed at the network level: re-check soon (the server may have stopped, the cloud may be down). */
export function noteServerTrouble(): void {
  if (troubleTimer) return
  troubleTimer = setTimeout(() => {
    troubleTimer = null
    void probeServer()
    if (useConnection.getState().backend === 'cloud') void refreshCloudHealth()
  }, 300)
}

/**
 * Probes on start, when the session / address / opt-in changes, on focus, and periodically (every 10 s while
 * not connected). The cloud is never polled: an idle tab must let Cloud Run scale to zero (on focus it is
 * asked again only after it did not answer).
 */
export function useConnectionPolling(): void {
  const status = useConnection((s) => s.status)
  const backend = useConnection((s) => s.backend)
  const serverUrl = useApp((s) => s.serverUrl)
  const localServer = useServerPrefs((s) => s.localServer)
  const uid = useAuth((s) => s.user?.uid ?? null)
  const authReady = useAuth((s) => s.ready)

  useEffect(() => {
    void probeServer()
  }, [serverUrl, localServer, uid, authReady])

  useEffect(() => {
    const onFocus = () => {
      const now = useConnection.getState()
      if (now.backend !== 'cloud') void probeServer()
      else if (now.failure) void refreshCloudHealth()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => {
    if (backend === 'cloud') return
    const every = status === 'server' ? 30_000 : HOSTED ? 10_000 : 3_000
    const id = window.setInterval(() => {
      if (!document.hidden) void probeServer()
    }, every)
    return () => window.clearInterval(id)
  }, [status, backend])
}

// ------------------------------------------------------------------ "this needs the server" hand-off

type ServerRequiredListener = (url: string) => void
const serverRequiredListeners = new Set<ServerRequiredListener>()

/** A link was given while no server is connected (e.g. pasted anywhere on the page): let the input explain. */
export function announceServerRequired(url: string): boolean {
  serverRequiredListeners.forEach((fn) => fn(url))
  return serverRequiredListeners.size > 0
}

export function onServerRequired(fn: ServerRequiredListener): () => void {
  serverRequiredListeners.add(fn)
  return () => {
    serverRequiredListeners.delete(fn)
  }
}

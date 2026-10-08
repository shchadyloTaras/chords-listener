// The public service status: the maintenance banner and the service switches the admin sets
// (Firestore `publicStatus/current`, a public mirror of the admin settings, ADR-0005).
//
// Read straight from Firestore, never from the cloud server: showing a banner must not wake it. One read
// per visit, then at most one per 5 minutes. A read that fails leaves the last known status (nothing is
// shown, nothing is switched off) and is retried within a minute.
//
// Firebase is loaded on demand (lib/firebase.ts, lib/firestore.ts are never imported statically).
import { create } from 'zustand'
import type { Lang } from '../store'

export interface ServiceSwitches {
  analysesPaused: boolean
  youtubeEnabled: boolean
  vocalsEnabled: boolean
}
export interface ServiceBannerDoc {
  enabled: boolean
  uk: string
  en: string
}
export interface ServiceStatus {
  banner: ServiceBannerDoc | null
  switches: ServiceSwitches
}

/** How long a read of the status is reused (the admin's banner and switches reach the site within this). */
export const STATUS_TTL_MS = 5 * 60_000
/** How soon a failed read is tried again. */
export const RETRY_MS = 60_000

const DEFAULT_STATUS: ServiceStatus = {
  banner: null,
  switches: { analysesPaused: false, youtubeEnabled: true, vocalsEnabled: true },
}

export const useServiceStatus = create<{ status: ServiceStatus }>()(() => ({ status: DEFAULT_STATUS }))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The document as the site uses it: only the allowed fields, and a bad value never switches anything off. */
export function parseServiceStatus(data: unknown): ServiceStatus {
  if (!isRecord(data)) return DEFAULT_STATUS
  const b = data.banner
  const banner =
    isRecord(b) && typeof b.enabled === 'boolean' && typeof b.uk === 'string' && typeof b.en === 'string'
      ? { enabled: b.enabled, uk: b.uk, en: b.en }
      : null
  const sw = isRecord(data.switches) ? data.switches : {}
  const on = (key: keyof ServiceSwitches) => (typeof sw[key] === 'boolean' ? sw[key] : true)
  return {
    banner,
    switches: { analysesPaused: sw.analysesPaused === true, youtubeEnabled: on('youtubeEnabled'), vocalsEnabled: on('vocalsEnabled') },
  }
}

/** The banner text in the interface language; null when there is nothing to show. Plain text, never HTML. */
export function bannerText(status: ServiceStatus, lang: Lang): string | null {
  const banner = status.banner
  if (!banner?.enabled) return null
  const text = banner[lang].trim()
  return text || null
}

const ADMIN_REFUSALS: ReadonlySet<string> = new Set(['cloud_restricted', 'analyses_paused', 'youtube_disabled', 'vocals_disabled'])

/** Whether the cloud refused for the administrator's reason (restriction, pause, a switch): a retry would be refused again. */
export function isAdminRefusal(code: string | null | undefined): boolean {
  return !!code && ADMIN_REFUSALS.has(code)
}

/** Whether the cloud downloads YouTube, as far as the site knows (on until it has learnt otherwise). Asks nothing. */
export function youtubeEnabled(): boolean {
  return useServiceStatus.getState().status.switches.youtubeEnabled
}

let freshUntil = 0
let inFlight: Promise<ServiceStatus> | null = null

async function readStatus(): Promise<ServiceStatus> {
  const [{ db }, { doc, getDoc }] = await Promise.all([import('./firestore'), import('firebase/firestore')])
  const snap = await getDoc(doc(db, 'publicStatus', 'current'))
  return parseServiceStatus(snap.exists() ? snap.data() : undefined)
}

/** The public status, read from Firestore at most once per 5 minutes (callers meanwhile share the result). */
export function loadServiceStatus(): Promise<ServiceStatus> {
  if (Date.now() < freshUntil) return Promise.resolve(useServiceStatus.getState().status)
  inFlight ??= readStatus()
    .then(
      (status) => {
        useServiceStatus.setState({ status })
        freshUntil = Date.now() + STATUS_TTL_MS
        return status
      },
      () => {
        freshUntil = Date.now() + RETRY_MS
        return useServiceStatus.getState().status
      },
    )
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** Forgets what was read (tests). */
export function resetServiceStatusForTests(): void {
  freshUntil = 0
  inFlight = null
  useServiceStatus.setState({ status: DEFAULT_STATUS })
}

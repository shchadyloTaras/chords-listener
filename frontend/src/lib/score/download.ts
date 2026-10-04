// Saving a generated file. A Blob URL on an <a download> works in every current browser, iOS Safari
// (13+, "Download" sheet → Files) and Android included. Where the attribute is not supported the file
// opens in a new tab; when that is blocked too (no user gesture left after a long export) the caller
// gets 'blocked' and offers an "Open" button — a fresh tap may always open it.

import { safeFileName } from '../music/formats'

export type SaveResult = 'downloaded' | 'opened' | 'blocked'

/** URLs are kept alive for a while: iOS reads the file after the click returns. */
const KEEP_URL_MS = 120_000

/** iPhone / iPad (iPadOS reports a Mac with touch): downloads started after a long task may need a tap. */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export function scoreFileName(title: string | null | undefined, word: string, ext: string): string {
  return `${safeFileName(title, 'Chords Listener')} — ${word}.${ext}`
}

function supportsDownload(): boolean {
  return typeof document !== 'undefined' && 'download' in document.createElement('a')
}

export function saveBlob(blob: Blob, filename: string): SaveResult {
  const url = URL.createObjectURL(blob)
  window.setTimeout(() => URL.revokeObjectURL(url), KEEP_URL_MS)
  if (supportsDownload()) {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.rel = 'noopener'
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    window.setTimeout(() => a.remove(), 0)
    return 'downloaded'
  }
  const win = window.open(url, '_blank', 'noopener')
  return win ? 'opened' : 'blocked'
}

/** Opens a file in a new tab from a user gesture (the fallback button). */
export function openBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob)
  window.setTimeout(() => URL.revokeObjectURL(url), KEEP_URL_MS)
  if (!window.open(url, '_blank')) location.href = url
}

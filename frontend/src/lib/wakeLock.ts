// Keeps the phone screen on while the app is open and visible (settings.keepAwake), via the Screen Wake Lock
// API. The browser drops the lock whenever the page is hidden (another tab or app, the screen locked); it is
// taken again when the page is shown. A refused request (battery saver, a browser that wants a tap first) is
// tried once more on the next tap or key press. Without the API (older browsers, a plain-http page on the
// local network) nothing happens. Never throws, never logs.
import { useEffect } from 'react'

// pointerup, not pointerdown: on a touch screen only the lifted finger counts as a user activation
const RETRY_EVENTS = ['pointerup', 'keydown'] as const
const LISTEN: AddEventListenerOptions = { capture: true, passive: true }

/** Holds a screen wake lock while the page is visible, until the returned function is called. */
export function keepScreenAwake(): () => void {
  const found = typeof navigator === 'undefined' ? undefined : (navigator as Partial<Navigator>).wakeLock
  if (!found || typeof found.request !== 'function') return () => {}
  const api: WakeLock = found

  let stopped = false
  let lock: WakeLockSentinel | null = null
  let requesting = false
  // the page was shown while a request was in flight: look again once it settles
  let recheck = false
  let retryArmed = false

  const visible = () => document.visibilityState === 'visible'

  async function acquire(isRetry = false): Promise<void> {
    if (stopped || !visible() || (lock && !lock.released)) return
    if (requesting) {
      recheck = true
      return
    }
    requesting = true
    try {
      const s = await api.request('screen')
      if (stopped || !visible()) drop(s)
      else if (!s.released) {
        lock = s
        s.addEventListener(
          'release',
          () => {
            if (lock === s) lock = null
          },
          { once: true },
        )
        disarm()
      }
    } catch {
      // refused: once more on the next tap / key; a retry that fails too waits until the page is shown again
      if (!isRetry) arm()
    } finally {
      requesting = false
      if (recheck) {
        recheck = false
        void acquire()
      }
    }
  }

  const onShown = () => void acquire()
  const onInteraction = () => {
    disarm()
    void acquire(true)
  }
  function arm() {
    if (retryArmed || stopped) return
    retryArmed = true
    for (const type of RETRY_EVENTS) window.addEventListener(type, onInteraction, LISTEN)
  }
  function disarm() {
    if (!retryArmed) return
    retryArmed = false
    for (const type of RETRY_EVENTS) window.removeEventListener(type, onInteraction, LISTEN)
  }

  document.addEventListener('visibilitychange', onShown)
  window.addEventListener('pageshow', onShown)
  void acquire()

  return () => {
    if (stopped) return
    stopped = true
    document.removeEventListener('visibilitychange', onShown)
    window.removeEventListener('pageshow', onShown)
    disarm()
    if (lock) drop(lock)
    lock = null
  }
}

function drop(s: WakeLockSentinel) {
  try {
    s.release().catch(() => {})
  } catch {
    // already gone
  }
}

/** Keeps the screen on while `enabled` and the page is visible. Mount once (App). */
export function useKeepScreenAwake(enabled: boolean): void {
  useEffect(() => (enabled ? keepScreenAwake() : undefined), [enabled])
}

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * How long after the last load a return to the tab refreshes the data (AC-02): the admin page has no timer
 * and no polling — an open tab that nobody touches sends no request, so the cloud server may fall asleep.
 */
export const REFRESH_AFTER_MS = 60_000

export interface AdminData<T> {
  /** the last answer for the current `key` (kept while a refresh is under way or failed); null before the first */
  data: T | null
  /** the error of the last load, cleared by the next successful one */
  error: Error | null
  /** a load is in flight (or the first one has not started yet) */
  loading: boolean
  /** when the data was last loaded (ms since epoch), null before the first answer */
  loadedAt: number | null
  /** «Оновити»: loads now, whatever the time since the last load */
  refresh(): void
}

interface State<T> {
  key: string
  data: T | null
  error: Error | null
  loading: boolean
  loadedAt: number | null
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Loads a screen's data: when the screen opens (mount) or `key` changes (a new search or filter), when the
 * tab becomes visible again at least REFRESH_AFTER_MS after the last load started, and on `refresh()`.
 * Nothing else — no interval, no timeout. A newer load supersedes an older one (its answer is dropped and
 * its request aborted through the signal given to `load`).
 */
export function useAdminData<T>(load: (signal: AbortSignal) => Promise<T>, key: string): AdminData<T> {
  const [state, setState] = useState<State<T>>({ key, data: null, error: null, loading: true, loadedAt: null })
  const loadRef = useRef(load)
  const runRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    loadRef.current = load
  })

  useEffect(() => {
    let alive = true
    let current: AbortController | null = null
    let startedAt = 0

    const run = () => {
      current?.abort()
      const ctl = new AbortController()
      current = ctl
      startedAt = Date.now()
      setState((s) => ({ ...(s.key === key ? s : { data: null, error: null, loadedAt: null }), key, loading: true }))
      loadRef.current(ctl.signal).then(
        (data) => {
          if (alive && current === ctl) setState({ key, data, error: null, loading: false, loadedAt: Date.now() })
        },
        (err: unknown) => {
          if (alive && current === ctl) setState((s) => ({ ...s, key, error: asError(err), loading: false }))
        },
      )
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - startedAt >= REFRESH_AFTER_MS) run()
    }

    runRef.current = run
    run()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      current?.abort()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [key])

  const refresh = useCallback(() => runRef.current(), [])
  const fresh = state.key === key
  return {
    data: fresh ? state.data : null,
    error: fresh ? state.error : null,
    loading: !fresh || state.loading,
    loadedAt: fresh ? state.loadedAt : null,
    refresh,
  }
}

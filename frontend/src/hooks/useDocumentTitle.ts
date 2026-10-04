import { useEffect } from 'react'

const APP = 'Chords Listener'

/** Sets document.title to "<title> — Chords Listener" (or just the app name). */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} — ${APP}` : APP
  }, [title])
}

import { MotionConfig } from 'framer-motion'
import { useCallback, useEffect, useState } from 'react'
import { AppHeader } from './components/layout/AppHeader'
import { DropOverlay } from './components/layout/DropOverlay'
import { HealthBanner } from './components/layout/HealthBanner'
import { HomePage } from './components/layout/HomePage'
import { NotFoundPage } from './components/layout/NotFoundPage'
import { ShortcutsModal } from './components/layout/ShortcutsModal'
import { TrackPage } from './components/layout/TrackPage'
import { JobPage } from './components/jobs/JobPage'
import { Toaster } from './components/ui/Toaster'
import { useHealthPolling } from './hooks/useHealth'
import { useGlobalHotkeys } from './hooks/useHotkeys'
import { syncServerJobs } from './hooks/useJobs'
import { useRoute, type Route } from './hooks/useRoute'
import { useDocumentTheme } from './hooks/useTheme'
import { startAuth } from './lib/auth'

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <HomePage />
    case 'job':
      return <JobPage key={route.id} id={route.id} />
    case 'track':
      return <TrackPage key={route.id} id={route.id} />
    case 'demo':
      return <TrackPage key="demo" id="demo" demo />
    default:
      return <NotFoundPage />
  }
}

export default function App() {
  const route = useRoute()
  const [helpOpen, setHelpOpen] = useState(false)
  const openHelp = useCallback(() => setHelpOpen(true), [])

  useDocumentTheme()
  useHealthPolling()
  useGlobalHotkeys({ onHelp: openHelp })

  useEffect(() => {
    void syncServerJobs()
  }, [])

  // optional Firebase sign-in (settings sync); loads lazily, the app never waits for it
  useEffect(() => startAuth(), [])

  // New page → start at the top.
  const routeKey = route.name === 'job' || route.name === 'track' ? `${route.name}:${route.id}` : route.name
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [routeKey])

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex min-h-full flex-col">
        <AppHeader route={route} onHelp={openHelp} />
        {route.name !== 'demo' && <HealthBanner />}
        <main className="flex flex-1 flex-col">
          <Page route={route} />
        </main>
      </div>
      <DropOverlay />
      <Toaster />
      <ShortcutsModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </MotionConfig>
  )
}

import { MotionConfig } from 'framer-motion'
import { useCallback, useEffect, useState } from 'react'
import { AuthDialogHost } from './components/account/AuthDialogHost'
import { CapturePage } from './components/capture/CapturePage'
import { ListenPage } from './components/capture/ListenPage'
import { ClipPage } from './components/clip/ClipPage'
import { AppHeader } from './components/layout/AppHeader'
import { DropOverlay } from './components/layout/DropOverlay'
import { HealthBanner } from './components/layout/HealthBanner'
import { HomePage } from './components/layout/HomePage'
import { NotFoundPage } from './components/layout/NotFoundPage'
import { ShortcutsModal } from './components/layout/ShortcutsModal'
import { TrackPage } from './components/layout/TrackPage'
import { TunerPage } from './components/tuner/TunerPage'
import { JobPage } from './components/jobs/JobPage'
import { Toaster } from './components/ui/Toaster'
import { useGuideAvailable } from './components/tour/hooks'
import { TourHost } from './components/tour/TourHost'
import { startCurrentTour } from './components/tour/tourStore'
import { useHealthPolling } from './hooks/useHealth'
import { useGlobalHotkeys } from './hooks/useHotkeys'
import { syncServerJobs } from './hooks/useJobs'
import { useRoute, type Route } from './hooks/useRoute'
import { useDocumentTheme } from './hooks/useTheme'
import { startAuth } from './lib/auth'
import { watchLibrary } from './lib/cloud/libraryWatch'
import { tourRouteKey } from './lib/tour/trigger'
import { useKeepScreenAwake } from './lib/wakeLock'
import { useApp } from './store'

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
    case 'listen':
      return <ListenPage key={route.source ?? 'listen'} initialSource={route.source} title={route.title} />
    case 'capture':
      return <CapturePage key={route.videoId} videoId={route.videoId} blocked={route.blocked} start={route.start} />
    case 'clip':
      return <ClipPage key={route.videoId} videoId={route.videoId} start={route.start} />
    case 'tuner':
      return <TunerPage />
    default:
      return <NotFoundPage />
  }
}

export default function App() {
  const route = useRoute()
  const [helpOpen, setHelpOpen] = useState(false)
  const openHelp = useCallback(() => setHelpOpen(true), [])
  // «Інструкція»: the current screen's tour (the entries hide on job / not-found and while a song loads)
  const guide = useGuideAvailable(route)
  const openGuide = useCallback(() => startCurrentTour(), [])
  // from the shortcuts dialog: close it, start once it has left the page
  const openGuideFromHelp = useCallback(() => {
    setHelpOpen(false)
    startCurrentTour({ afterModal: true })
  }, [])

  useDocumentTheme()
  useHealthPolling()
  useGlobalHotkeys({ onHelp: openHelp })

  // The phone screen stays on while the app is open (every page, a recording too) unless turned off in settings
  useKeepScreenAwake(useApp((s) => s.keepAwake))

  useEffect(() => {
    void syncServerJobs()
  }, [])

  // Firebase sign-in (settings sync; the cloud API on the hosted site): restores a saved session only where this
  // browser has signed in before (a guest loads no Firebase); lazy, the app never waits for it
  useEffect(() => startAuth(), [])

  // The live library (Firestore index of the signed-in user's tracks): follows while the cloud is the API
  useEffect(() => watchLibrary(), [])

  // New page → start at the top.
  const routeKey = tourRouteKey(route)
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [routeKey])

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex min-h-full flex-col">
        <AppHeader route={route} onHelp={openHelp} onGuide={guide ? openGuide : undefined} />
        {route.name !== 'demo' && <HealthBanner />}
        <main className="flex flex-1 flex-col">
          <Page route={route} />
        </main>
      </div>
      <DropOverlay />
      <AuthDialogHost />
      <Toaster />
      <TourHost />
      <ShortcutsModal open={helpOpen} onClose={() => setHelpOpen(false)} onGuide={guide ? openGuideFromHelp : undefined} />
    </MotionConfig>
  )
}

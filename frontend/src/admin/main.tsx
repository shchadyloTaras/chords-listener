import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { startAuth } from '../lib/auth'
import { AdminApp } from './AdminApp.tsx'
import { breakOutOfFrame } from './frameGuard'

// First thing: a framed admin page leaves the frame and renders nothing (S2-8).
if (breakOutOfFrame()) {
  // Firebase sign-in: restores a saved session where this browser has signed in before (shared with the main site).
  // The access check runs once the session is known (AdminApp), not here.
  startAuth()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AdminApp />
    </StrictMode>,
  )
}

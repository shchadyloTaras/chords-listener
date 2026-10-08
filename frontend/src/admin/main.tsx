import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { startAuth } from '../lib/auth'
import { AdminApp } from './AdminApp.tsx'

// Firebase sign-in: restores a saved session where this browser has signed in before (shared with the main site).
// The access check runs once the session is known (AdminApp), not here.
startAuth()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
)

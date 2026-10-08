import clsx from 'clsx'
import { MotionConfig } from 'framer-motion'
import { useEffect, useState } from 'react'
import { AuthDialogHost } from '../components/account/AuthDialogHost'
import { NotFoundPage } from '../components/layout/NotFoundPage'
import { Button } from '../components/ui/IconButton'
import { LogoMark, Wordmark } from '../components/ui/Logo'
import { Toaster } from '../components/ui/Toaster'
import { useT } from '../i18n'
import { getIdToken, openAuthDialog, useAuth } from '../lib/auth'
import { cloudPrefix } from '../lib/serverMode'
import { useDocumentTheme } from '../hooks/useTheme'
import { Overview } from './screens/Overview'
import { UserCard } from './screens/UserCard'
import { Users } from './screens/Users'
import { ADMIN_NAV, useAdminRoute, type AdminRoute } from './useAdminRoute'

/**
 * Whether the signed-in person is an admin: the server answers the admin API for admins only and with the
 * unknown-route 404 for everyone else (AC-31), so a 2xx is the one "yes". Any other answer, or none, is a "no":
 * the page never tells a failure from a refusal.
 */
async function probeAdminAccess(): Promise<boolean> {
  const prefix = cloudPrefix()
  const token = await getIdToken()
  if (!prefix || !token) return false
  const res = await fetch(`${prefix}/api/admin/overview`, { headers: { Authorization: `Bearer ${token}` } })
  return res.ok
}

type Access = 'checking' | 'admin' | 'denied'

function useAdminAccess(uid: string | null, probe: () => Promise<boolean>): Access {
  const [result, setResult] = useState<{ uid: string; admin: boolean } | null>(null)
  useEffect(() => {
    if (!uid) return
    let stale = false
    probe().then(
      (admin) => !stale && setResult({ uid, admin }),
      () => !stale && setResult({ uid, admin: false }),
    )
    return () => {
      stale = true
    }
  }, [uid, probe])
  if (!uid || result?.uid !== uid) return 'checking'
  return result.admin ? 'admin' : 'denied'
}

function Brand() {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark className="size-7" />
      <Wordmark className="text-lg" />
    </span>
  )
}

function SignInPrompt() {
  const t = useT()
  return (
    <div className="mx-auto max-w-md px-4 pt-24 text-center">
      <Brand />
      <Button variant="primary" className="mt-8" onClick={() => openAuthDialog('signIn', 'required')}>
        {t('account.signIn')}
      </Button>
    </div>
  )
}

function Screen({ route }: { route: AdminRoute }) {
  // The screens arrive with their own tasks; each is rendered here by route name.
  if (route.name === 'notFound') return <NotFoundPage />
  if (route.name === 'overview') return <Overview />
  if (route.name === 'users') return <Users />
  if (route.name === 'user') return <UserCard key={route.uid} uid={route.uid} />
  return <section aria-live="polite" className="px-4 py-6" data-screen={route.name} />
}

function Shell() {
  const route = useAdminRoute()
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-border bg-surface-1">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Brand />
          <nav aria-label="Адмінка" className="flex flex-wrap gap-1">
            {ADMIN_NAV.map((item) => {
              const current = item.match.includes(route.name)
              return (
                <a
                  key={item.path}
                  href={`#${item.path}`}
                  aria-current={current ? 'page' : undefined}
                  className={clsx(
                    'rounded-lg px-3 py-1.5 text-sm transition-colors duration-150',
                    current ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-3 hover:text-text',
                  )}
                >
                  {item.label}
                </a>
              )
            })}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1">
        <Screen route={route} />
      </main>
    </div>
  )
}

/**
 * The admin page (admin.html). A signed-out visitor sees a sign-in prompt and nothing else; a signed-in person who
 * is not an admin sees only «Сторінку не знайдено» (AC-31); only an admin gets the shell. `probe` is the access
 * check (replaceable in tests).
 */
export function AdminApp({ probe = probeAdminAccess }: { probe?: () => Promise<boolean> }) {
  useDocumentTheme()
  const ready = useAuth((s) => s.ready)
  const uid = useAuth((s) => s.user?.uid ?? null)
  const access = useAdminAccess(uid, probe)

  let body = null
  if (ready) {
    if (!uid) body = <SignInPrompt />
    else if (access === 'denied') body = <NotFoundPage />
    else if (access === 'admin') body = <Shell />
  }

  return (
    <MotionConfig reducedMotion="user">
      {body}
      <AuthDialogHost />
      <Toaster />
    </MotionConfig>
  )
}

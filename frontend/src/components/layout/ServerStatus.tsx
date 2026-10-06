import clsx from 'clsx'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronRight, Cloud, ExternalLink, Globe, LoaderCircle, RefreshCw, Server } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { t as tNow, useT } from '../../i18n'
import { useAuth, useAuthDialog } from '../../lib/auth'
import { useCanListenInTab } from '../../hooks/useMediaQuery'
import {
  cloudWaking,
  HOSTED,
  needCloudHealth,
  normalizeServerUrl,
  refreshCloudHealth,
  setLocalServerEnabled,
  useConnection,
  useServerPrefs,
} from '../../lib/serverMode'
import { useApp } from '../../store'
import { AccountButtons } from '../account/AccountCta'
import { useCloudInvite } from '../account/cloudInvite'
import { Button } from '../ui/IconButton'
import { ServerSetup } from './ServerStatusGuide'

type ModeKind = 'cloud' | 'server' | 'browser' | 'checking'

function useModeKind(): ModeKind {
  return useConnection((s) =>
    s.status === 'server' ? (s.backend === 'cloud' ? 'cloud' : 'server') : s.status === 'browser' ? 'browser' : 'checking',
  )
}

/** Toasts when the user's own server appears / goes away (after the first check). The cloud comes with signing in. */
function useConnectionToasts() {
  const status = useConnection((s) => s.status)
  const remote = useConnection((s) => s.remote)
  const backend = useConnection((s) => s.backend)
  const prev = useRef({ status, remote, backend })
  useEffect(() => {
    const before = prev.current
    prev.current = { status, remote, backend }
    if (before.status === 'checking' || (before.status === status && before.backend === backend)) return
    if (backend === 'cloud' || before.backend === 'cloud') return
    // the page served by the server keeps its own banner; toasts are for the hosted / remote setup
    if (!HOSTED && !remote && !before.remote) return
    const { toast } = useApp.getState()
    if (status === 'server') toast(tNow('web.toast.connected'), 'success')
    else if (status === 'browser' && before.status === 'server') toast(tNow('web.toast.disconnected'), 'info')
  }, [status, remote, backend])
}

function PanelHead({ icon, tone, title, children }: { icon: ReactNode; tone: 'ok' | 'calm'; title: string; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span
        className={clsx(
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg',
          tone === 'ok' ? 'bg-success/15 text-success' : 'bg-accent-soft text-accent',
        )}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 font-display text-base font-semibold tracking-tight">
          {title}
          {tone === 'ok' && <Check className="size-4 text-success" aria-hidden="true" />}
        </p>
        {children}
      </div>
    </div>
  )
}

/**
 * Health of the cloud (asked when the popover opens): waking up (Cloud Run starts on demand) or not answering;
 * nothing when fine.
 */
function CloudHealthLine() {
  const t = useT()
  const health = useConnection((s) => s.health)
  const failure = useConnection((s) => s.failure)
  const waking = useConnection(cloudWaking)
  const [checking, setChecking] = useState(false)
  // a failed re-check after a good one: still say so, with a way to ask again
  if (failure) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-text">
        <span>{t('web.cloud.down')}</span>
        <Button
          size="sm"
          variant="secondary"
          disabled={checking}
          icon={<RefreshCw className={clsx('size-3.5', checking && 'animate-spin')} aria-hidden="true" />}
          onClick={() => {
            setChecking(true)
            void refreshCloudHealth().finally(() => setChecking(false))
          }}
        >
          {t('web.cloud.check')}
        </Button>
      </div>
    )
  }
  if (health || !waking) return null
  return (
    <p className="mt-1 flex items-center gap-1.5 text-xs text-faint">
      <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
      {t('web.cloud.waking')}
    </p>
  )
}

/** "Advanced": the user's own server (./start.sh) — optional, never the main path. */
function AdvancedServer({ onConnected }: { onConnected(): void }) {
  const t = useT()
  const kind = useModeKind()
  const signedIn = useAuth((s) => !!s.user)
  const localServer = useServerPrefs((s) => s.localServer)
  const serverUrl = useApp((s) => s.serverUrl)
  const direct = normalizeServerUrl(serverUrl)
  const [open, setOpen] = useState(kind === 'server')

  return (
    <div className="mt-4 border-t border-border pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs font-semibold tracking-wide text-faint uppercase hover:text-muted"
      >
        <ChevronRight className={clsx('size-3.5 transition-transform duration-150', open && 'rotate-90')} aria-hidden="true" />
        {t('web.advanced.summary')}
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          {signedIn && kind === 'cloud' ? (
            <p className="text-sm text-muted">
              {t('web.advanced.cloudFirst')}{' '}
              {direct && (
                <a
                  href={direct}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 font-mono text-accent hover:underline"
                >
                  {direct.replace(/^https?:\/\//, '')}
                  <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              )}
            </p>
          ) : (
            <>
              <p className="text-sm text-muted">{t('web.advanced.what')}</p>
              <ServerSetup showSteps={kind !== 'server'} onConnected={onConnected} />
              {localServer && HOSTED && (
                <button
                  type="button"
                  onClick={() => setLocalServerEnabled(false)}
                  className="text-xs text-muted underline-offset-2 hover:text-text hover:underline"
                >
                  {t('web.advanced.disable')}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function PanelBody({ onConnected }: { onConnected(): void }) {
  const t = useT()
  const kind = useModeKind()
  const serverOrigin = useConnection((s) => s.serverOrigin)
  const email = useAuth((s) => s.user?.email ?? '')
  const invite = useCloudInvite()
  // YouTube without a server: listened to on the page where this browser hears its tab, else opened here with
  // the on-device ways to listen
  const tabCapable = useCanListenInTab()
  const serverUrl = useApp((s) => s.serverUrl)
  const url = (serverOrigin ?? normalizeServerUrl(serverUrl) ?? serverUrl).replace(/^https?:\/\//, '')

  if (kind === 'cloud') {
    return (
      <>
        <PanelHead icon={<Cloud className="size-4" aria-hidden="true" />} tone="ok" title={t('web.mode.cloud')}>
          <p className="mt-0.5 text-sm text-muted">{t('web.cloud.what')}</p>
          {email && <p className="mt-1 truncate text-xs text-faint">{t('web.cloud.account', { email })}</p>}
          <CloudHealthLine />
        </PanelHead>
        <p className="mt-3 text-xs text-faint">{t('web.cloud.limits')}</p>
        <AdvancedServer onConnected={onConnected} />
      </>
    )
  }

  if (kind === 'server') {
    return (
      <>
        <PanelHead icon={<Server className="size-4" aria-hidden="true" />} tone="ok" title={t('web.mode.server')}>
          <p className="mt-0.5 text-sm text-muted">{t('web.server.connected', { url })}</p>
        </PanelHead>
        <p className="mt-3 text-sm text-muted">{t('web.server.what')}</p>
        <p className="mt-3 text-xs text-faint">{t('web.browser.localNote')}</p>
        <AdvancedServer onConnected={onConnected} />
      </>
    )
  }

  return (
    <>
      <PanelHead
        icon={kind === 'checking' ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Globe className="size-4" aria-hidden="true" />}
        tone="calm"
        title={kind === 'checking' ? t('web.mode.checking') : t('web.mode.browser')}
      >
        <p className="mt-0.5 text-sm text-muted">{t('web.browser.what')}</p>
        <p className="mt-1 text-sm text-muted">{t(tabCapable ? 'web.browser.youtube' : 'cloud.input.hintYoutubeHere')}</p>
      </PanelHead>
      {invite && (
        <div className="mt-4 rounded-xl border border-accent/30 bg-accent-soft p-3">
          <p className="text-sm font-medium text-text">{t('web.browser.cta')}</p>
          <AccountButtons size="sm" className="mt-2.5" />
        </div>
      )}
      <AdvancedServer onConnected={onConnected} />
    </>
  )
}

/**
 * Header chip with the current mode («Хмара ✓» / «Браузерний режим» / «Локальний сервер ✓») and a popover:
 * what the mode means, signing up for the cloud, and (under "Advanced") the user's own server. Hidden when
 * the page is served by the server itself (nothing to choose there).
 */
export function ServerStatus({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const kind = useModeKind()
  const remote = useConnection((s) => s.remote)
  // the cloud did not answer its health check: still the cloud, but say so
  const troubled = useConnection((s) => s.backend === 'cloud' && !!s.failure)
  // the cloud is being asked and has not answered yet (Cloud Run starts on demand): it may take a while
  const waking = useConnection(cloudWaking)
  const [open, setOpen] = useState(false)
  const id = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useConnectionToasts()

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    const onNavigate = () => setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('hashchange', onNavigate)
    const raf = requestAnimationFrame(() => panelRef.current?.focus())
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('hashchange', onNavigate)
      cancelAnimationFrame(raf)
    }
  }, [open])

  // the account dialog takes over: close the popover underneath
  useEffect(
    () =>
      useAuthDialog.subscribe((s, prev) => {
        if (s.open && !prev.open) setOpen(false)
      }),
    [],
  )

  const visible = HOSTED || kind === 'browser' || kind === 'cloud' || (kind === 'server' && remote)
  if (!visible) return null

  const label =
    kind === 'cloud'
      ? t('web.mode.cloud')
      : kind === 'server'
        ? t('web.mode.server')
        : kind === 'browser'
          ? t('web.mode.browser')
          : t('web.mode.checking')
  const connected = (kind === 'cloud' || kind === 'server') && !troubled && !waking
  const icon = kind === 'cloud' || kind === 'server' ? (
    <span className="relative flex size-4 items-center justify-center" aria-hidden="true">
      {kind === 'cloud' ? <Cloud className="size-4" /> : <Server className="size-4" />}
      <span
        className={clsx(
          'absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-surface-2',
          troubled || waking ? 'bg-accent' : 'bg-success',
          waking && 'motion-safe:animate-pulse',
        )}
      />
    </span>
  ) : kind === 'browser' ? (
    <Globe className="size-4" aria-hidden="true" />
  ) : (
    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
  )

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-tour="header.mode"
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        aria-label={t('web.mode.aria', { mode: label })}
        title={waking ? t('web.cloud.waking') : label}
        onClick={() => {
          // the cloud's health is asked only now, when someone wants to see it
          if (!open) needCloudHealth()
          setOpen(!open)
        }}
        className={clsx(
          'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border text-xs font-medium transition-colors duration-150',
          'border-border bg-surface-2 text-muted hover:bg-surface-3 hover:text-text',
          open && 'bg-surface-3 text-text',
          // the words from md: at 640–767 px they leave no room for the header's «Інструкція» button
          compact ? 'w-8 justify-center' : 'w-8 justify-center md:w-auto md:px-2.5',
          connected && 'text-text',
        )}
      >
        {icon}
        {!compact && <span className="hidden whitespace-nowrap md:inline">{label}</span>}
        {!compact && connected && <Check className="hidden size-3.5 text-success md:block" aria-hidden="true" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            id={id}
            role="dialog"
            aria-label={t('web.mode.title')}
            tabIndex={-1}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className={clsx(
              'z-50 overflow-y-auto rounded-2xl border border-border-strong bg-surface-2 p-4 shadow-xl shadow-black/30 outline-none!',
              'fixed inset-x-4 top-16 max-h-[calc(100dvh-5rem)]',
              'sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-2 sm:w-[24rem] sm:origin-top-right',
            )}
          >
            <PanelBody onConnected={() => window.setTimeout(() => setOpen(false), 900)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

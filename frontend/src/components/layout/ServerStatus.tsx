import clsx from 'clsx'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Globe, LoaderCircle, Server } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { t as tNow, useT } from '../../i18n'
import { HOSTED, normalizeServerUrl, useConnection } from '../../lib/serverMode'
import { useApp } from '../../store'
import { ServerSetup } from './ServerStatusGuide'

/** Toasts when the local server appears / goes away (after the first check). */
function useConnectionToasts() {
  const status = useConnection((s) => s.status)
  const remote = useConnection((s) => s.remote)
  const prev = useRef({ status, remote })
  useEffect(() => {
    const before = prev.current
    prev.current = { status, remote }
    if (before.status === 'checking' || before.status === status) return
    // the page served by the server keeps its own banner; toasts are for the hosted / remote setup
    if (!HOSTED && !remote && !before.remote) return
    const { toast } = useApp.getState()
    if (status === 'server') toast(tNow('web.toast.connected'), 'success')
    else if (status === 'browser' && before.status === 'server') toast(tNow('web.toast.disconnected'), 'info')
  }, [status, remote])
}

function PanelBody({ onConnected }: { onConnected(): void }) {
  const t = useT()
  const status = useConnection((s) => s.status)
  const health = useConnection((s) => s.health)
  const serverOrigin = useConnection((s) => s.serverOrigin)
  const serverUrl = useApp((s) => s.serverUrl)
  const connected = status === 'server'
  const url = (serverOrigin ?? normalizeServerUrl(serverUrl) ?? serverUrl).replace(/^https?:\/\//, '')

  return (
    <>
      <div className="flex items-start gap-3">
        <span
          className={clsx(
            'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg',
            connected ? 'bg-success/15 text-success' : 'bg-accent-soft text-accent',
          )}
        >
          {connected ? <Server className="size-4" aria-hidden="true" /> : <Globe className="size-4" aria-hidden="true" />}
        </span>
        <div className="min-w-0">
          <p className="font-display text-base font-semibold tracking-tight">
            {connected ? t('web.mode.server') : t('web.mode.browser')}
          </p>
          <p className="mt-0.5 text-sm text-muted">
            {connected ? t('web.server.connected', { url }) : t('web.browser.what')}
          </p>
        </div>
      </div>

      <p className="mt-3 text-sm text-muted">
        {connected ? t('web.server.what') : t('web.browser.needServer')}
        {connected && health?.engine?.name && (
          <span className="mt-1 block text-xs text-faint">
            {t('web.server.engine', { engine: `${health.engine.name} ${health.engine.version}`.trim() })}
            {health.ytdlp ? ` · yt-dlp ${health.ytdlp}` : ''}
          </span>
        )}
      </p>

      {!connected && (
        <p className="mt-4 text-xs font-semibold tracking-wide text-faint uppercase">{t('web.guide.title')}</p>
      )}
      <div className="mt-2">
        <ServerSetup showSteps={!connected} onConnected={onConnected} />
      </div>
      {connected && <p className="mt-4 text-xs text-faint">{t('web.browser.localNote')}</p>}
    </>
  )
}

/**
 * Header chip with the current mode ("Local server ✓" / "Browser mode") and a popover with the
 * server address, a connection check and setup instructions. Hidden when the page is served by
 * the server itself (nothing to choose there).
 */
export function ServerStatus({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const status = useConnection((s) => s.status)
  const remote = useConnection((s) => s.remote)
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

  const visible = HOSTED || status === 'browser' || (status === 'server' && remote)
  if (!visible) return null

  const label = status === 'server' ? t('web.mode.server') : status === 'browser' ? t('web.mode.browser') : t('web.mode.checking')
  const icon =
    status === 'server' ? (
      <span className="relative flex size-4 items-center justify-center" aria-hidden="true">
        <Server className="size-4" />
        <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-success ring-2 ring-surface-2" />
      </span>
    ) : status === 'browser' ? (
      <Globe className="size-4" aria-hidden="true" />
    ) : (
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
    )

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        aria-label={t('web.mode.aria', { mode: label })}
        title={label}
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border text-xs font-medium transition-colors duration-150',
          'border-border bg-surface-2 text-muted hover:bg-surface-3 hover:text-text',
          open && 'bg-surface-3 text-text',
          compact ? 'w-8 justify-center' : 'w-8 justify-center sm:w-auto sm:px-2.5',
          status === 'server' && 'text-text',
        )}
      >
        {icon}
        {!compact && <span className="hidden whitespace-nowrap sm:inline">{label}</span>}
        {!compact && status === 'server' && <Check className="hidden size-3.5 text-success sm:block" aria-hidden="true" />}
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

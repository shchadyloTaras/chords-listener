import clsx from 'clsx'
import { AnimatePresence, motion } from 'framer-motion'
import { AudioLines, CircleAlert, CircleCheck, Cloud, FileAudio, FolderOpen, Gauge, Link2, LoaderCircle, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ClipboardEvent, type FormEvent, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { useApp } from '../../store'
import { toApiError, type ClientErrorCode } from '../../lib/api'
import { holdCloudBusy, onServerRequired, useConnection } from '../../lib/serverMode'
import { useJobs } from '../../hooks/useJobs'
import { paths } from '../../hooks/useRoute'
import { useCanListenInTab, useIsDesktopPointer, useMediaQuery } from '../../hooks/useMediaQuery'
import { CLIP_SECONDS } from '../clip/clipWindow'
import { errorText } from '../jobs/errorText'
import { AccountButtons } from '../account/AccountCta'
import { useCloudInvite } from '../account/cloudInvite'
import { Button, IconButton } from '../ui/IconButton'
import { VideoSiteIcon } from '../ui/Logo'
import { formatBytes } from '../ui/format'
import { useTourBlock } from '../tour/hooks'
import { startFiles } from './startFiles'
import { startLink, submitWhenConnected } from './startLink'
import { checkUrl, FILE_ACCEPT, findUrl } from './url'

/** How long a link may be on its way before the user is told why (a cold cloud takes a while) and may cancel. */
const SLOW_START_MS = 3000

type Hint =
  | { kind: 'idle' }
  | { kind: 'youtube' }
  | { kind: 'other' }
  | { kind: 'invalid' }
  | { kind: 'error'; code: ClientErrorCode }
  /** a link to another site and no server connected: only the cloud can fetch it (sign in) */
  | { kind: 'account' }
  /** a YouTube page that is not one video (a playlist, a channel): nothing to listen to, nothing sent */
  | { kind: 'notVideo' }

function UploadProgress() {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const uploads = useJobs((s) => s.uploads)
  const upload = uploads[uploads.length - 1]
  if (!upload) return null
  const pct = Math.round(upload.progress * 100)
  return (
    <div className="rounded-2xl border border-border-strong bg-surface px-4 py-3.5">
      <div className="flex items-center gap-3">
        <FileAudio className="size-5 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text">{upload.filename}</p>
          <p className="text-xs text-muted">
            {pct < 100 ? t('core.upload.uploading', { size: formatBytes(upload.size, lang) }) : t('core.upload.starting')}
          </p>
        </div>
        <span className="font-mono text-sm text-text tabular-nums">{pct}%</span>
        <Button size="sm" variant="ghost" onClick={() => upload.cancel()}>
          {t('core.cancel')}
        </Button>
      </div>
      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-3"
        role="progressbar"
        aria-label={t('core.upload.progress')}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** A link to another site was given without a server: the cloud fetches it once the user signs in. */
function AccountNotice({ onDismiss }: { onDismiss(): void }) {
  const t = useT()
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="relative mt-3 rounded-2xl border border-border-strong bg-surface p-4 sm:p-5">
      <IconButton label={t('web.input.dismiss')} size="sm" onClick={onDismiss} className="absolute top-2 right-2">
        <X className="size-4" />
      </IconButton>
      <div className="flex items-start gap-3 pr-8">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Cloud className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 id={titleId} className="font-display text-base font-semibold tracking-tight">
            {t('cloud.input.accountTitle')}
          </h2>
          <p className="mt-1 text-sm text-muted">{t('cloud.input.accountText')}</p>
          <AccountButtons size="sm" className="mt-3" />
        </div>
      </div>
    </section>
  )
}

/** One of the big "ways in" under the link field. */
function WayCard({
  icon,
  title,
  hint,
  href,
  onClick,
}: {
  icon: ReactNode
  title: string
  hint: string
  href?: string
  onClick?(): void
}) {
  const body = (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-3 text-accent transition-colors group-hover:bg-accent-soft">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block font-display text-[17px] leading-tight font-semibold tracking-tight text-text">{title}</span>
        <span className="mt-0.5 block text-sm leading-snug text-muted">{hint}</span>
      </span>
    </>
  )
  const cls =
    'group flex min-h-[4.5rem] items-center gap-3.5 rounded-2xl border border-border-strong bg-surface px-4 py-3 text-left transition-colors duration-150 hover:border-accent/50 hover:bg-surface-2 focus-visible:border-accent'
  return href ? (
    <a href={href} className={cls}>
      {body}
    </a>
  ) : (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  )
}

/**
 * The home page's ways in: paste a link (starts immediately, Enter to submit), pick or drop a file, or
 * let the site listen (microphone / a tab) with live chords.
 */
export function SmartInput({ className }: { className?: string }) {
  const t = useT()
  const hintId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [hint, setHint] = useState<Hint>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  // the link has been on its way for a while
  const [slow, setSlow] = useState(false)
  const starting = useRef<AbortController | null>(null)
  const uploading = useJobs((s) => s.uploads.length > 0)
  const autoFocus = useIsDesktopPointer()
  const wide = useMediaQuery('(min-width: 640px)')
  const connected = useConnection((s) => s.status === 'server')
  const localServer = useConnection((s) => s.status === 'server' && s.backend === 'local')
  const guest = useConnection((s) => s.status === 'browser')
  const onCloud = useConnection((s) => s.backend === 'cloud')
  const invite = useCloudInvite()
  const tabCapable = useCanListenInTab()
  // no tour starts by itself while a link or a file is on its way or the field has text
  useTourBlock(busy || uploading || value !== '')

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  // a link pasted elsewhere on the page that needs an account lands here, with the explanation
  useEffect(
    () =>
      onServerRequired((url) => {
        setValue(url)
        setHint({ kind: 'account' })
      }),
    [],
  )

  useEffect(() => {
    if (!busy) return
    const id = window.setTimeout(() => setSlow(true), SLOW_START_MS)
    return () => {
      window.clearTimeout(id)
      setSlow(false)
    }
  }, [busy])

  // the link is on its way to the cloud: the header chip may say it is waking up
  useEffect(() => {
    if (busy && onCloud) return holdCloudBusy()
  }, [busy, onCloud])

  const live = (text: string): Hint => {
    if (!text.trim()) return { kind: 'idle' }
    const c = checkUrl(text)
    if (!c.ok) return { kind: 'idle' }
    if (c.kind !== 'youtube') return { kind: 'other' }
    // a local server tries any YouTube link itself; elsewhere only a video can be listened to
    return c.videoId || localServer ? { kind: 'youtube' } : { kind: 'notVideo' }
  }

  const submit = async (text: string) => {
    const c = checkUrl(text)
    if (!c.ok || !c.url) {
      setHint({ kind: 'invalid' })
      inputRef.current?.focus()
      return
    }
    const ctrl = new AbortController()
    starting.current = ctrl
    setBusy(true)
    try {
      const started = await startLink(c.url, ctrl.signal)
      if (started.kind === 'account' || started.kind === 'notVideo') {
        setHint({ kind: started.kind })
        return
      }
      setValue('')
      setHint({ kind: 'idle' })
    } catch (e) {
      const { code } = toApiError(e)
      // cancelled by the user: the link stays in the field, ready to be sent again
      setHint(code === 'aborted' ? live(text) : { kind: 'error', code })
    } finally {
      if (starting.current === ctrl) starting.current = null
      setBusy(false)
    }
  }

  // signed in from the notice: once the cloud is connected, start the waiting link (editing, clearing or
  // dismissing it, another submit or leaving the page forgets it). Never a YouTube link: a guest's video opens
  // the capture page (no account needed), a signed-in user's opens the fragment picker.
  const submitRef = useRef(submit)
  useEffect(() => {
    submitRef.current = submit
  })
  const waiting = hint.kind === 'account' && checkUrl(value).kind === 'other' ? value : ''
  useEffect(() => {
    if (!waiting) return
    return submitWhenConnected(waiting, (url) => void submitRef.current(url))
  }, [waiting])

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!value.trim()) {
      inputRef.current?.focus()
      return
    }
    void submit(value)
  }

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const files = e.clipboardData.files
    if (files.length) {
      e.preventDefault()
      startFiles(files)
      return
    }
    const text = e.clipboardData.getData('text')
    const url = findUrl(text)
    // A clean paste into an empty field starts right away.
    if (url && !value.trim() && checkUrl(url).ok) {
      e.preventDefault()
      setValue(url)
      setHint(live(url))
      void submit(url)
    }
  }

  if (uploading) {
    return (
      <div className={className}>
        <UploadProgress />
      </div>
    )
  }

  const ok = (text: string) => (
    <span className="flex items-center gap-1.5 text-success">
      <CircleCheck className="size-3.5 shrink-0" aria-hidden="true" />
      {text}
    </span>
  )
  const bad = (text: string) => (
    <span className="flex items-center gap-1.5 text-danger">
      <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
      {text}
    </span>
  )
  const needsAccount = (text: string) => (
    <span className="flex items-center gap-1.5 text-text">
      <Cloud className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
      {text}
    </span>
  )

  const hintNode = (() => {
    // the cloud answers on demand: say why it takes long, and let the user give up
    if (busy && slow && onCloud)
      return (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-text">
          <span className="flex items-center gap-1.5">
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-accent" aria-hidden="true" />
            {t('web.cloud.waking')}
          </span>
          <button
            type="button"
            onClick={() => starting.current?.abort()}
            className="rounded font-medium text-text underline underline-offset-2 hover:text-accent"
          >
            {t('core.cancel')}
          </button>
        </span>
      )
    switch (hint.kind) {
      case 'youtube':
        // a local server downloads the video; signed in, the cloud takes a fragment; a guest listens on the capture page
        if (localServer) return ok(t('core.input.hintYoutube'))
        if (onCloud) return ok(t('cloud.input.hintYoutubeClip', { seconds: CLIP_SECONDS }))
        return ok(t(tabCapable ? 'cloud.input.hintYoutubeGuest' : 'cloud.input.hintYoutubeHere'))
      case 'other':
        return guest ? (
          needsAccount(t('web.input.needServer'))
        ) : (
          <span className="flex items-center gap-1.5 text-text">
            <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden="true" />
            {t('core.input.hintOther')}
          </span>
        )
      case 'notVideo':
        return (
          <span className="flex items-center gap-1.5 text-text">
            <CircleAlert className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
            {t('cloud.input.notVideo')}
          </span>
        )
      case 'invalid':
        return bad(t('core.input.hintInvalid'))
      case 'error':
        return bad(errorText(hint.code))
      case 'account':
        // signed in meanwhile: the waiting link is on its way (a cold cloud may take a while to answer)
        if (busy && connected)
          return (
            <span className="flex items-center gap-1.5 text-text">
              <LoaderCircle className="size-3.5 shrink-0 animate-spin text-accent" aria-hidden="true" />
              {t('web.input.sending')}
            </span>
          )
        return needsAccount(t('web.input.needServer'))
      default:
        return (
          <span className="text-muted">
            {guest ? t(tabCapable ? 'cloud.input.hintGuest' : 'cloud.input.hintGuestNoTab') : t('core.input.hintIdle')}
          </span>
        )
    }
  })()

  const isYoutube = hint.kind === 'youtube' || hint.kind === 'notVideo'

  return (
    <div className={className}>
      <h2 className="sr-only">{t('cloud.ways.label')}</h2>
      <form onSubmit={onSubmit} noValidate>
        <div
          data-tour="home.input"
          className={clsx(
            'group flex h-16 items-center gap-2 rounded-2xl border bg-surface pr-2 pl-4 transition-[border-color,box-shadow] duration-150',
            'focus-within:border-accent focus-within:shadow-[0_0_0_4px_var(--accent-soft)]',
            hint.kind === 'invalid' || hint.kind === 'error' ? 'border-danger/60' : 'border-border-strong',
          )}
        >
          <span className="flex size-6 shrink-0 items-center justify-center text-faint" aria-hidden="true">
            {isYoutube ? <VideoSiteIcon className="size-5 text-text" /> : <Link2 className="size-5" />}
          </span>
          <label htmlFor={`${hintId}-input`} className="sr-only">
            {t('core.input.label')}
          </label>
          <input
            id={`${hintId}-input`}
            ref={inputRef}
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            value={value}
            disabled={busy}
            placeholder={t(wide ? 'core.input.placeholder' : 'core.input.placeholderShort')}
            aria-describedby={hintId}
            aria-invalid={hint.kind === 'invalid' || hint.kind === 'error'}
            onChange={(e) => {
              setValue(e.target.value)
              setHint(live(e.target.value))
            }}
            onBlur={() => {
              if (value.trim() && !checkUrl(value).ok) setHint({ kind: 'invalid' })
            }}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && value) {
                e.preventDefault()
                setValue('')
                setHint({ kind: 'idle' })
              }
            }}
            className="h-full min-w-0 flex-1 bg-transparent text-base text-text outline-none! placeholder:text-faint sm:text-[17px]"
          />
          <AnimatePresence>
            {value && !busy && (
              <motion.button
                type="button"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1 }}
                aria-label={t('core.input.clear')}
                onClick={() => {
                  setValue('')
                  setHint({ kind: 'idle' })
                  inputRef.current?.focus()
                }}
                className="rounded-lg p-1.5 text-faint hover:bg-surface-3 hover:text-text"
              >
                <X className="size-4" />
              </motion.button>
            )}
          </AnimatePresence>
          <Button type="submit" variant="primary" disabled={busy} className="h-11 px-3.5 sm:px-5">
            {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
            <span className="hidden sm:inline">{t('core.input.submit')}</span>
            <span className="sm:hidden">{t('core.input.submitShort')}</span>
          </Button>
        </div>
        <p id={hintId} aria-live="polite" className="mt-2.5 min-h-5 px-1 text-sm">
          {hintNode}
        </p>
      </form>
      {hint.kind === 'account' && !connected && invite && <AccountNotice onDismiss={() => setHint({ kind: 'idle' })} />}

      <div className="mt-4 grid gap-3 md:grid-cols-3" data-tour="home.sources">
        <WayCard
          icon={<FolderOpen className="size-5" aria-hidden="true" />}
          title={t('cloud.ways.file.title')}
          hint={t('cloud.ways.file.hint')}
          onClick={() => fileRef.current?.click()}
        />
        <WayCard
          icon={<AudioLines className="size-5" aria-hidden="true" />}
          title={t('cloud.ways.listen.title')}
          hint={t('cloud.ways.listen.hint')}
          href={`#${paths.listen()}`}
        />
        <WayCard
          icon={<Gauge className="size-5" aria-hidden="true" />}
          title={t('cloud.ways.tuner.title')}
          hint={t('cloud.ways.tuner.hint')}
          href={`#${paths.tuner()}`}
        />
        <input
          ref={fileRef}
          type="file"
          accept={FILE_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) startFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}

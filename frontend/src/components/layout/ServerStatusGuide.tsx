import clsx from 'clsx'
import { Check, CircleAlert, CircleCheck, Copy, ExternalLink, LoaderCircle, PlugZap, Server, X } from 'lucide-react'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { normalizeServerUrl, probeServer, PROJECT_REPO, useConnection } from '../../lib/serverMode'
import { useApp } from '../../store'
import { Button, IconButton } from '../ui/IconButton'
import { copyText } from '../ui/copyText'

const DEFAULT_SERVER = 'http://localhost:8765'
export const CLONE_COMMAND = `git clone ${PROJECT_REPO}`
export const START_COMMANDS = 'cd chords-listener && ./start.sh'

/** One shell command with a copy button. */
export function CommandLine({ command }: { command: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-lg border border-border-strong bg-bg/60 py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap text-text [scrollbar-width:none]">
        {command}
      </code>
      <button
        type="button"
        onClick={async () => {
          if (await copyText(command)) {
            setCopied(true)
            useApp.getState().toast(t('web.guide.copied'), 'success')
            window.setTimeout(() => setCopied(false), 1600)
          }
        }}
        aria-label={copied ? t('web.guide.copied') : `${t('web.guide.copy')}: ${command}`}
        title={t('web.guide.copy')}
        className="shrink-0 rounded-md p-1.5 text-muted transition-colors hover:bg-surface-3 hover:text-text"
      >
        {copied ? <Check className="size-3.5 text-success" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      </button>
    </div>
  )
}

/** Live result of the last connection check. */
function ConnectionStatusLine() {
  const t = useT()
  const status = useConnection((s) => s.status)
  const failure = useConnection((s) => s.failure)
  const probing = useConnection((s) => s.probing)
  const serverUrl = useApp((s) => s.serverUrl)
  const url = normalizeServerUrl(serverUrl) ?? serverUrl

  let node: ReactNode = null
  if (probing) {
    node = (
      <span className="flex items-center gap-1.5 text-muted">
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
        {t('web.checking')}
      </span>
    )
  } else if (status === 'server') {
    node = (
      <span className="flex items-center gap-1.5 text-success">
        <CircleCheck className="size-3.5 shrink-0" aria-hidden="true" />
        {t('web.status.ok')}
      </span>
    )
  } else if (failure && status === 'browser') {
    const key = {
      unreachable: 'web.status.unreachable',
      permission: 'web.status.permission',
      blocked: 'web.status.blocked',
      'invalid-url': 'web.status.invalidUrl',
      'not-chords': 'web.status.notChords',
    }[failure]
    // "not running" is the normal state of the hosted page: calm colors; real misconfigurations stand out
    const calm = failure === 'permission' || failure === 'unreachable'
    node = (
      <span className={clsx('flex items-start gap-1.5', calm ? 'text-muted' : 'text-text')}>
        <CircleAlert className={clsx('mt-0.5 size-3.5 shrink-0', calm ? 'text-accent' : 'text-danger')} aria-hidden="true" />
        <span>{t(key, { url })}</span>
      </span>
    )
  }
  return (
    <p aria-live="polite" className="min-h-5 text-sm leading-snug">
      {node}
    </p>
  )
}

/** Server address field (persisted as `serverUrl`). */
function ServerAddressForm({ onSaved }: { onSaved(): void }) {
  const t = useT()
  const id = useId()
  const serverUrl = useApp((s) => s.serverUrl)
  const [draft, setDraft] = useState(serverUrl)
  const [invalid, setInvalid] = useState(false)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const origin = normalizeServerUrl(draft)
    if (!origin) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setDraft(origin)
    useApp.getState().setSetting('serverUrl', origin)
    onSaved()
  }

  const dirty = (normalizeServerUrl(draft) ?? draft.trim()) !== serverUrl
  return (
    <form onSubmit={submit} noValidate className="space-y-1.5">
      <label htmlFor={`${id}-url`} className="text-xs font-medium text-muted">
        {t('web.address.label')}
      </label>
      <div className="flex gap-2">
        <input
          id={`${id}-url`}
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={draft}
          placeholder={DEFAULT_SERVER}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-err` : undefined}
          onChange={(e) => {
            setDraft(e.target.value)
            setInvalid(false)
          }}
          className={clsx(
            'h-9 min-w-0 flex-1 rounded-lg border bg-bg/60 px-3 font-mono text-sm text-text outline-none! placeholder:text-faint',
            'focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]',
            invalid ? 'border-danger/70' : 'border-border-strong',
          )}
        />
        <Button type="submit" size="sm" disabled={!dirty} className="h-9">
          {t('web.address.save')}
        </Button>
      </div>
      {invalid ? (
        <p id={`${id}-err`} className="text-xs text-danger">
          {t('web.address.invalid')}
        </p>
      ) : (
        serverUrl !== DEFAULT_SERVER && (
          <button
            type="button"
            className="text-xs text-muted underline-offset-2 hover:text-text hover:underline"
            onClick={() => {
              setDraft(DEFAULT_SERVER)
              useApp.getState().setSetting('serverUrl', DEFAULT_SERVER)
              onSaved()
            }}
          >
            {t('web.address.default')}: {DEFAULT_SERVER}
          </button>
        )
      )}
    </form>
  )
}

/**
 * How to run and connect the local server: commands to copy, connection check, server address.
 * `onConnected` runs after a check made here succeeds.
 */
export function ServerSetup({ onConnected, showSteps = true }: { onConnected?(): void; showSteps?: boolean }) {
  const t = useT()
  const probing = useConnection((s) => s.probing)
  const connected = useConnection((s) => s.status === 'server')
  const serverUrl = useApp((s) => s.serverUrl)
  const direct = normalizeServerUrl(serverUrl)

  const check = async () => {
    if (await probeServer({ interactive: true })) onConnected?.()
  }

  return (
    <div className="space-y-4">
      {showSteps && (
        <ol className="space-y-3 text-sm text-muted">
          <li className="space-y-1.5">
            <p>
              <span className="font-mono text-faint">1.</span> {t('web.guide.step1')}
            </p>
            <CommandLine command={CLONE_COMMAND} />
          </li>
          <li className="space-y-1.5">
            <p>
              <span className="font-mono text-faint">2.</span> {t('web.guide.step2')}
            </p>
            <CommandLine command={START_COMMANDS} />
          </li>
          <li>
            <p>
              <span className="font-mono text-faint">3.</span> {t('web.guide.step3')}
            </p>
          </li>
        </ol>
      )}

      <div className="space-y-2">
        <Button
          variant={connected ? 'secondary' : 'primary'}
          size="sm"
          disabled={probing}
          icon={probing ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <PlugZap className="size-4" aria-hidden="true" />}
          onClick={() => void check()}
        >
          {probing ? t('web.checking') : t('web.check')}
        </Button>
        <ConnectionStatusLine />
      </div>

      <ServerAddressForm onSaved={() => void check()} />

      {direct && (
        <p className="text-xs text-muted">
          {t('web.guide.direct')}{' '}
          <a
            href={direct}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 font-mono text-accent hover:underline"
          >
            {direct.replace(/^https?:\/\//, '')}
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </p>
      )}
    </div>
  )
}

/** Inline explanation under the link field when a link was given in browser mode. */
export function ServerRequiredNotice({ onConnected, onDismiss }: { onConnected(): void; onDismiss(): void }) {
  const t = useT()
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      className="relative mt-3 rounded-2xl border border-border-strong bg-surface p-4 sm:p-5"
    >
      <IconButton label={t('web.input.dismiss')} size="sm" onClick={onDismiss} className="absolute top-2 right-2">
        <X className="size-4" />
      </IconButton>
      <div className="flex items-start gap-3 pr-8">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Server className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 id={titleId} className="font-display text-base font-semibold tracking-tight">
            {t('web.guide.title')}
          </h2>
          <p className="mt-1 text-sm text-muted">{t('web.browser.what')}</p>
        </div>
      </div>
      <div className="mt-4">
        <ServerSetup onConnected={onConnected} />
      </div>
    </section>
  )
}

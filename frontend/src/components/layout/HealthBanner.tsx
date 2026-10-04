import { Check, Copy, ServerOff, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useT } from '../../i18n'
import { useHealth } from '../../hooks/useHealth'
import { HOSTED } from '../../lib/serverMode'
import { paths } from '../../hooks/useRoute'
import { copyText } from '../ui/copyText'

/** Command shown when the backend is not reachable (run from the project root). */
export const START_COMMAND = 'cd backend && uv run uvicorn app.main:app --host 127.0.0.1 --port 8765'

function CopyCommand({ command }: { command: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex max-w-full min-w-0 items-center gap-1 rounded-lg border border-border-strong bg-surface py-1 pr-1 pl-3">
      <code className="min-w-0 overflow-x-auto font-mono text-xs whitespace-nowrap text-text">{command}</code>
      <button
        type="button"
        onClick={async () => {
          if (await copyText(command)) {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1600)
          }
        }}
        aria-label={copied ? t('core.copied') : t('core.health.copyCommand')}
        title={t('core.health.copyCommand')}
        className="shrink-0 rounded-md p-1.5 text-muted transition-colors hover:bg-surface-3 hover:text-text"
      >
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  )
}

/** Explains how to start the backend when /api/health fails, and flags missing tools. */
export function HealthBanner() {
  const t = useT()
  const status = useHealth((s) => s.status)
  const health = useHealth((s) => s.health)

  // The hosted build (GitHub Pages) works without a server: the header's mode chip explains it calmly.
  if (status === 'down' && !HOSTED) {
    return (
      <div role="alert" className="border-b border-danger/30 bg-danger/[0.07]">
        <div className="mx-auto flex max-w-7xl flex-col gap-2.5 px-4 py-3 sm:px-6 lg:flex-row lg:items-center lg:gap-4">
          <div className="flex items-center gap-2.5 text-sm">
            <ServerOff className="size-4 shrink-0 text-danger" aria-hidden="true" />
            <span>
              <strong className="font-semibold text-text">{t('core.health.down')}</strong>{' '}
              <span className="text-muted">{t('core.health.howTo')}</span>
            </span>
          </div>
          <CopyCommand command={START_COMMAND} />
          <a href={`#${paths.demo()}`} className="shrink-0 text-sm font-medium text-accent hover:underline">
            {t('core.health.demo')}
          </a>
        </div>
      </div>
    )
  }

  if (status === 'ok' && health && (!health.ffmpeg || !health.ytdlp)) {
    return (
      <div role="status" className="border-b border-accent/25 bg-accent-soft">
        <div className="mx-auto flex max-w-7xl items-center gap-2.5 px-4 py-2.5 text-sm sm:px-6">
          <TriangleAlert className="size-4 shrink-0 text-accent" aria-hidden="true" />
          <span className="text-text">
            {!health.ffmpeg ? t('core.health.noFfmpeg') : t('core.health.noYtdlp')}
          </span>
        </div>
      </div>
    )
  }

  return null
}

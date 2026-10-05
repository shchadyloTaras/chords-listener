import clsx from 'clsx'
import { Cloud, FolderOpen, Mic, X } from 'lucide-react'
import { useId, useRef } from 'react'
import { useT } from '../../i18n'
import { navigate, paths } from '../../hooks/useRoute'
import { startFiles } from '../input/startFiles'
import { FILE_ACCEPT } from '../input/url'
import { Button, IconButton } from '../ui/IconButton'
import { AccountButtons } from './AccountCta'

/**
 * A guest's YouTube link where this browser cannot listen to a tab (phones, Safari, Firefox): the cloud
 * downloads it with a free account (the link is sent once they sign in); the microphone and files work
 * here without one.
 */
export function YoutubeAccountCard({ onDismiss, className }: { onDismiss?(): void; className?: string }) {
  const t = useT()
  const titleId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <section aria-labelledby={titleId} className={clsx('relative rounded-2xl border border-border-strong bg-surface p-4 sm:p-5', className)}>
      {onDismiss && (
        <IconButton label={t('web.input.dismiss')} size="sm" onClick={onDismiss} className="absolute top-2 right-2">
          <X className="size-4" />
        </IconButton>
      )}
      <div className={clsx('flex items-start gap-3', onDismiss && 'pr-8')}>
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Cloud className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 id={titleId} className="font-display text-base font-semibold tracking-tight">
            {t('cloud.ytAccount.title')}
          </h2>
          <p className="mt-1 text-sm text-muted">{t('cloud.ytAccount.text')}</p>
          <AccountButtons size="sm" className="mt-3" />
          <p className="mt-4 text-xs text-faint">{t('cloud.ytAccount.device')}</p>
          <div className="mt-1 -ml-3 flex flex-wrap gap-x-1">
            <Button size="sm" variant="ghost" icon={<Mic className="size-4" aria-hidden="true" />} onClick={() => navigate(paths.listen('mic'))}>
              {t('cloud.capture.phone.mic')}
            </Button>
            <Button size="sm" variant="ghost" icon={<FolderOpen className="size-4" aria-hidden="true" />} onClick={() => fileRef.current?.click()}>
              {t('cloud.capture.phone.file')}
            </Button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept={FILE_ACCEPT}
            hidden
            onChange={(e) => {
              if (e.target.files?.length) startFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </div>
      </div>
    </section>
  )
}

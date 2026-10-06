import { useApp } from '../../store'
import { AccountButton } from '../account/AccountButton'
import type { Route } from '../../hooks/useRoute'
import { paths } from '../../hooks/useRoute'
import { JobPills } from '../jobs/JobPills'
import { LogoMark, Wordmark } from '../ui/Logo'
import { GuideButton, HelpButton, LangSwitch, ThemeMenu } from './HeaderSettings'
import { ServerStatus } from './ServerStatus'
import { HeaderMenu, SourceLink } from './TrackActions'
import { TrackTitleBar } from './TrackTitleBar'

/**
 * One slim sticky bar. Track pages swap the wordmark for back + title so the
 * chord view keeps as much height as possible.
 */
export function AppHeader({ route, onHelp, onGuide }: { route: Route; onHelp(): void; onGuide?: () => void }) {
  const isTrack = route.name === 'track' || route.name === 'demo'
  const demo = route.name === 'demo'
  const track = useApp((s) => (isTrack ? s.track : null))

  return (
    <header className="sticky top-0 z-40 h-14 border-b border-border/70 bg-bg/85 backdrop-blur-xl">
      <div className="mx-auto flex h-full max-w-7xl items-center gap-2 px-3 sm:px-6">
        {isTrack ? (
          <TrackTitleBar demo={demo} />
        ) : (
          <a href={`#${paths.home()}`} className="-ml-1 flex items-center gap-2.5 rounded-lg px-1 py-1" aria-label="Chords Listener">
            <LogoMark className="size-8" />
            <Wordmark className="text-[17px]" />
          </a>
        )}

        <div className="ml-auto flex min-w-0 items-center gap-1">
          <JobPills />
          <ServerStatus compact={isTrack} />
          {track && (
            <div className="hidden sm:block">
              <SourceLink track={track} />
            </div>
          )}
          {isTrack && track && !demo && (
            <div className="hidden sm:block">
              <HeaderMenu track={track} demo={demo} withSettings={false} onHelp={onHelp} onGuide={onGuide} />
            </div>
          )}
          <div className="hidden items-center gap-1 sm:flex" data-tour="header.settings">
            <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
            <LangSwitch />
            <ThemeMenu />
            <HelpButton onHelp={onHelp} />
            {onGuide && <GuideButton onGuide={onGuide} />}
          </div>
          <AccountButton />
          <div className="sm:hidden" data-tour="header.more">
            <HeaderMenu track={track} demo={demo} withSettings onHelp={onHelp} onGuide={onGuide} />
          </div>
        </div>
      </div>
    </header>
  )
}

import { Cloud, LogIn, LogOut } from 'lucide-react'
import { useT } from '../../i18n'
import { openAuthDialog, signOut, useAuth } from '../../lib/auth'
import { isLocalId } from '../../lib/local'
import { useConnection } from '../../lib/serverMode'
import { parseHash, navigate, paths } from '../../hooks/useRoute'
import { useApp } from '../../store'
import { Button, IconButton } from '../ui/IconButton'
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu'

/** Signing out leaves the account's library: a cloud track / job page has nothing left to show. */
function leaveAccountPage() {
  const route = parseHash(window.location.hash)
  if ((route.name === 'track' || route.name === 'job') && !isLocalId(route.id)) navigate(paths.home(), { replace: true })
}

/** Header entry point: "Sign in" while signed out, an account menu while signed in. */
export function AccountButton() {
  const t = useT()
  const user = useAuth((s) => s.user)
  const ready = useAuth((s) => s.ready)
  const cloud = useConnection((s) => s.backend === 'cloud')

  // keep the header from jumping while Firebase restores a saved session
  if (!ready) return <span className="size-9 shrink-0" aria-hidden="true" />

  if (!user) {
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('account.signIn')}
        data-tour="header.signin"
        icon={<LogIn className="size-4" aria-hidden="true" />}
        onClick={() => openAuthDialog('signIn')}
        className="max-sm:size-9 max-sm:rounded-xl max-sm:px-0"
      >
        <span className="max-sm:hidden">{t('account.signIn')}</span>
      </Button>
    )
  }

  const email = user.email ?? ''
  return (
    <Menu
      label={t('account.menu')}
      trigger={(props) => (
        <IconButton {...props} label={t('account.signedInAs', { email })}>
          <span className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent uppercase">
            {email.charAt(0) || '?'}
          </span>
        </IconButton>
      )}
    >
      <div className="max-w-64 px-2.5 pt-2 pb-1">
        <div className="truncate text-sm font-medium" title={email}>
          {email}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-faint">
          <Cloud className="size-3.5 shrink-0" aria-hidden="true" />
          {t(cloud ? 'account.synced' : 'account.syncedSettings')}
        </div>
      </div>
      <MenuSeparator />
      <MenuItem
        icon={<LogOut />}
        onSelect={() => {
          signOut().then(
            () => {
              leaveAccountPage()
              useApp.getState().toast(t('account.signedOut'), 'info')
            },
            () => useApp.getState().toast(t('account.error.generic'), 'error'),
          )
        }}
      >
        {t('account.signOut')}
      </MenuItem>
    </Menu>
  )
}

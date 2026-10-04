import { Cloud, LogIn, LogOut } from 'lucide-react'
import { useState } from 'react'
import { useT } from '../../i18n'
import { signOut, useAuth } from '../../lib/auth'
import { useApp } from '../../store'
import { Button, IconButton } from '../ui/IconButton'
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu'
import { AuthModal } from './AuthModal'

/** Header entry point: "Sign in" while signed out, an account menu while signed in. */
export function AccountButton() {
  const t = useT()
  const user = useAuth((s) => s.user)
  const ready = useAuth((s) => s.ready)
  const [open, setOpen] = useState(false)
  // a fresh dialog (sign-in mode, empty fields) on every open
  const [session, setSession] = useState(0)

  // keep the header from jumping while Firebase restores a saved session
  if (!ready) return <span className="size-9 shrink-0" aria-hidden="true" />

  if (!user) {
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('account.signIn')}
          icon={<LogIn className="size-4" aria-hidden="true" />}
          onClick={() => {
            setSession((n) => n + 1)
            setOpen(true)
          }}
          className="max-sm:size-9 max-sm:rounded-xl max-sm:px-0"
        >
          <span className="max-sm:hidden">{t('account.signIn')}</span>
        </Button>
        <AuthModal key={session} open={open} onClose={() => setOpen(false)} />
      </>
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
          {t('account.synced')}
        </div>
      </div>
      <MenuSeparator />
      <MenuItem
        icon={<LogOut />}
        onSelect={() => {
          signOut().then(
            () => useApp.getState().toast(t('account.signedOut'), 'info'),
            () => useApp.getState().toast(t('account.error.generic'), 'error'),
          )
        }}
      >
        {t('account.signOut')}
      </MenuItem>
    </Menu>
  )
}

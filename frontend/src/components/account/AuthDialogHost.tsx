import { closeAuthDialog, useAuthDialog } from '../../lib/auth'
import { AuthModal } from './AuthModal'

/**
 * The app's one account dialog, opened from anywhere with `openAuthDialog()` (header button, home CTA,
 * "needs an account" notices) or by lib/api when the cloud asks for a new sign-in. Mount once in App.
 */
export function AuthDialogHost() {
  const open = useAuthDialog((s) => s.open)
  const mode = useAuthDialog((s) => s.mode)
  const reason = useAuthDialog((s) => s.reason)
  const session = useAuthDialog((s) => s.session)
  // a fresh form (mode, empty fields) on every open
  return <AuthModal key={session} open={open} initialMode={mode} reason={reason} onClose={(signedIn) => closeAuthDialog(signedIn)} />
}

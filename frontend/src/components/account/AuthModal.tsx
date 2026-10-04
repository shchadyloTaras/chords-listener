import { Eye, EyeOff, Loader2, MailCheck } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react'
import { useT } from '../../i18n'
import { sendPasswordReset, signIn, signUp, type AuthDialogMode, type AuthDialogReason } from '../../lib/auth'
import { authErrorKey } from '../../lib/authErrors'
import { cloudPrefix, useConnection } from '../../lib/serverMode'
import { useApp } from '../../store'
import { Button, IconButton } from '../ui/IconButton'
import { Modal } from '../ui/Modal'

type Mode = 'signIn' | 'signUp' | 'reset'

/** Firebase's minimum for email/password accounts. */
const MIN_PASSWORD = 6

/** Errors about the email field; every other error is shown against the password. */
const EMAIL_ERRORS = new Set(['account.error.invalidEmail', 'account.error.emailInUse'])

// 16px text on phones: iOS Safari zooms the page into smaller inputs on focus
const inputClass =
  'h-11 w-full rounded-xl border border-border-strong bg-surface-2 px-3.5 text-base text-text placeholder:text-faint sm:text-[15px] ' +
  'transition-colors duration-150 focus:border-accent focus:outline-none read-only:opacity-60 ' +
  'aria-invalid:border-danger/70'

/** Catches what Firebase would reject anyway, without a network round trip. */
function validate(mode: Mode, email: string, password: string): string | null {
  if (!/^[^\s@]+@[^\s@]+$/.test(email.trim())) return 'account.error.invalidEmail'
  if (mode === 'reset') return null
  if (!password) return 'account.error.missingPassword'
  if (mode === 'signUp' && password.length < MIN_PASSWORD) return 'account.error.weakPassword'
  return null
}

/** Focus once React has committed the current update (the target may only just have rendered). */
function focusSoon(ref: RefObject<HTMLElement | null>) {
  window.setTimeout(() => ref.current?.focus())
}

interface AuthModalProps {
  open: boolean
  /** `signedIn` = the dialog has just signed someone in */
  onClose(signedIn?: boolean): void
  initialMode?: AuthDialogMode
  /** the app asked for it: the session ended / the action needs an account */
  reason?: AuthDialogReason
}

/** Email/password sign in, sign up and password reset in one dialog. */
export function AuthModal({ open, onClose, initialMode = 'signIn', reason = null }: AuthModalProps) {
  const t = useT()
  const id = useId()
  const [mode, setMode] = useState<Mode>(initialMode)
  // on the page served by a local server the account only syncs settings (the cloud is not used there)
  const settingsOnly = useConnection((s) => !cloudPrefix() || (s.status === 'server' && s.backend === 'local' && !s.remote))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  /** i18n key, so the message follows a language switch */
  const [error, setError] = useState<string | null>(null)
  const [resetSentTo, setResetSentTo] = useState<string | null>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)

  // after Modal has focused its panel, move focus to the first field
  useEffect(() => {
    if (!open) return
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => emailRef.current?.focus())
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [open, mode])

  const switchMode = (next: Mode) => {
    setMode(next)
    setError(null)
    setResetSentTo(null)
  }

  const fail = (key: string) => {
    setError(key)
    focusSoon(EMAIL_ERRORS.has(key) || mode === 'reset' ? emailRef : passwordRef)
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const invalid = validate(mode, email, password)
    if (invalid) return fail(invalid)
    setBusy(true)
    setError(null)
    try {
      if (mode === 'reset') {
        await sendPasswordReset(email)
        setResetSentTo(email.trim())
        focusSoon(backRef)
      } else {
        const cred = mode === 'signIn' ? await signIn(email, password) : await signUp(email, password)
        const key = mode === 'signIn' ? 'account.welcome' : 'account.welcomeNew'
        useApp.getState().toast(t(key, { email: cred.user.email ?? '' }))
        onClose(true)
      }
    } catch (err) {
      fail(authErrorKey(err))
    } finally {
      setBusy(false)
    }
  }

  const intro =
    mode === 'signIn' && reason ? `account.intro.${reason}` : mode === 'signIn' && settingsOnly ? 'account.intro.local' : `account.intro.${mode}`

  const errorId = `${id}-error`
  const emailError = !!error && (EMAIL_ERRORS.has(error) || mode === 'reset')
  const passwordError = !!error && !emailError
  const describe = (...ids: (string | false)[]) => ids.filter(Boolean).join(' ') || undefined

  return (
    <Modal open={open} onClose={() => onClose()} title={t(`account.title.${mode}`)} width="max-w-sm">
      {resetSentTo ? (
        <div className="flex flex-col items-start gap-4 pb-1">
          <div className="flex gap-3">
            <MailCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
            <p className="text-sm text-muted" role="status">
              {t('account.resetSent', { email: resetSentTo })}
            </p>
          </div>
          <Button ref={backRef} variant="secondary" onClick={() => switchMode('signIn')}>
            {t('account.backToSignIn')}
          </Button>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate aria-busy={busy} className="flex flex-col gap-4 pb-1">
          <p className="text-sm text-muted">{t(intro)}</p>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-email`} className="text-sm font-medium">
              {t('account.email')}
            </label>
            <input
              ref={emailRef}
              id={`${id}-email`}
              type="email"
              inputMode="email"
              autoComplete={mode === 'signUp' ? 'email' : 'username'}
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint={mode === 'reset' ? 'send' : 'next'}
              spellCheck={false}
              required
              value={email}
              readOnly={busy}
              aria-invalid={emailError || undefined}
              aria-describedby={describe(emailError && errorId)}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                // "next" on a phone keyboard: go to the password instead of submitting a half-filled form
                if (e.key === 'Enter' && mode !== 'reset' && !password) {
                  e.preventDefault()
                  passwordRef.current?.focus()
                }
              }}
              className={inputClass}
            />
          </div>

          {mode !== 'reset' && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <label htmlFor={`${id}-password`} className="text-sm font-medium">
                  {t('account.password')}
                </label>
                {mode === 'signIn' && (
                  <button
                    type="button"
                    onClick={() => switchMode('reset')}
                    className="text-xs text-muted underline-offset-2 hover:text-text hover:underline"
                  >
                    {t('account.forgot')}
                  </button>
                )}
              </div>
              <div className="relative">
                <input
                  ref={passwordRef}
                  id={`${id}-password`}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'}
                  enterKeyHint="go"
                  minLength={MIN_PASSWORD}
                  required
                  value={password}
                  readOnly={busy}
                  aria-invalid={passwordError || undefined}
                  aria-describedby={describe(mode === 'signUp' && `${id}-password-hint`, passwordError && errorId)}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`${inputClass} pr-11`}
                />
                <IconButton
                  label={t(showPassword ? 'account.hidePassword' : 'account.showPassword')}
                  size="sm"
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute top-1.5 right-1.5"
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </IconButton>
              </div>
              {mode === 'signUp' && (
                <p id={`${id}-password-hint`} className="text-xs text-faint">
                  {t('account.passwordHint')}
                </p>
              )}
            </div>
          )}

          {error && (
            <p id={errorId} role="alert" className="text-sm text-danger">
              {t(error)}
            </p>
          )}

          <Button
            type="submit"
            variant="primary"
            disabled={busy}
            icon={busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : undefined}
            className="w-full"
          >
            {t(`account.submit.${mode}`)}
          </Button>

          <p className="text-center text-sm text-muted">
            {mode === 'signIn' ? (
              <>
                {t('account.noAccount')}{' '}
                <button type="button" onClick={() => switchMode('signUp')} className="font-medium text-accent hover:underline">
                  {t('account.toSignUp')}
                </button>
              </>
            ) : mode === 'signUp' ? (
              <>
                {t('account.haveAccount')}{' '}
                <button type="button" onClick={() => switchMode('signIn')} className="font-medium text-accent hover:underline">
                  {t('account.toSignIn')}
                </button>
              </>
            ) : (
              <button type="button" onClick={() => switchMode('signIn')} className="font-medium text-accent hover:underline">
                {t('account.backToSignIn')}
              </button>
            )}
          </p>
        </form>
      )}
    </Modal>
  )
}

import { useId, useState, type FormEvent } from 'react'
import { Button } from '../../components/ui/IconButton'
import { Modal } from '../../components/ui/Modal'
import { useT } from '../../i18n'
import * as adminApi from '../../lib/adminApi'
import { adminErrorMessage } from '../../lib/adminApi'
import type { AdminAccountState } from '../../types'

// The deletion dialog (US-11, AC-20 / AC-21 / AC-34 / AC-35). The admin confirms by typing the user's email: letters
// may differ in case and the ends may carry spaces (the server compares the same way, AC-21), nothing else may. A wrong
// email never leaves the browser. Everything the server refuses (own account, a deletion already scheduled, the cap of
// 10 per hour, a login older than 15 minutes, a mismatch) is explained in the dialog, which stays open with the email
// typed so the same click can be repeated; for an old login `adminApi` has already asked for the password and retried
// once, so a second click starts that again.

/** The calls the dialog makes (replaceable in tests). */
export type DeletionApi = Pick<typeof adminApi, 'scheduleDeletion'>

const sameEmail = (typed: string, email: string) => typed.trim().toLowerCase() === email.toLowerCase()

interface DeletionDialogProps {
  uid: string
  /** the user's email, which has to be typed */
  email: string
  api?: DeletionApi
  onScheduled(account: AdminAccountState): void
  onClose(): void
}

export function DeletionDialog({ uid, email, api = adminApi, onScheduled, onClose }: DeletionDialogProps) {
  const t = useT()
  const [typed, setTyped] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [failure, setFailure] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const id = useId()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setFailure(null)
    if (!sameEmail(typed, email)) {
      setFieldError(
        typed.trim() === ''
          ? 'Введіть саме email цього користувача'
          : `${t('admin.error.confirm_email_mismatch')}: введіть саме email цього користувача`,
      )
      return
    }
    setFieldError(null)
    setBusy(true)
    try {
      onScheduled(await api.scheduleDeletion(uid, typed.trim()))
    } catch (err) {
      setFailure(err)
      setBusy(false)
    }
  }

  return (
    <Modal open title="Запланувати видалення акаунта" onClose={onClose}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Акаунт і всі його пісні, аудіо, правки, квоти й ліміти буде остаточно видалено через 7 днів. Хмарне обмеження діє одразу; до кінця цього
          строку видалення можна скасувати. Дію буде записано в журнал. Може знадобитися повторно ввести пароль.
        </p>
        <div>
          <label htmlFor={`${id}-email`} className="mb-1 block text-sm font-medium text-text">
            Email користувача
          </label>
          <input
            id={`${id}-email`}
            type="text"
            inputMode="email"
            autoComplete="off"
            value={typed}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${id}-hint ${id}-error` : `${id}-hint`}
            onChange={(e) => {
              setTyped(e.target.value)
              setFieldError(null)
              setFailure(null)
            }}
            className="h-10 w-full rounded-xl border border-border-strong bg-surface-3 px-3 text-sm text-text aria-[invalid=true]:border-danger"
          />
          <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
            Для підтвердження введіть саме email цього користувача: <span className="break-words [unicode-bidi:isolate]">{email}</span>
          </p>
          {fieldError && (
            <p id={`${id}-error`} className="mt-1 text-xs text-danger">
              {fieldError}
            </p>
          )}
        </div>
        {failure !== null && (
          <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {adminErrorMessage(failure)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            Скасувати
          </Button>
          <Button type="submit" variant="danger" disabled={busy}>
            Підтвердити видалення
          </Button>
        </div>
      </form>
    </Modal>
  )
}

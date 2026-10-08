import { useId, useState, type FormEvent } from 'react'
import { Button } from '../../components/ui/IconButton'
import { Modal } from '../../components/ui/Modal'
import * as adminApi from '../../lib/adminApi'
import { adminErrorMessage } from '../../lib/adminApi'
import type { AdminAccountState } from '../../types'
import { DeletionDialog } from './DeletionDialog'

// The state actions of the user card (US-09 / US-11): put, change and lift the cloud restriction; schedule the
// deletion; cancel it. While a deletion is scheduled the only state action is «Скасувати видалення» (AC-23b); the
// server refuses the others as well (`deletion_pending`). Every refusal is explained in words (AC-17 own account,
// AC-23b, AC-35 the cap of deletions), and the dialog stays open so nothing typed is lost.

const REASON_MAX = 500
const REASON_LABEL = 'Причина обмеження'
const REASON_HINT = `Від 1 до ${REASON_MAX} символів. Причину бачать лише адміністратори; користувачу вона не показується.`

/** The calls the actions make (replaceable in tests). */
export type RestrictionApi = Pick<typeof adminApi, 'restrictUser' | 'unrestrictUser' | 'cancelDeletion'>

function RestrictionDialog({
  uid,
  current,
  api,
  onSaved,
  onClose,
}: {
  uid: string
  /** the reason now in force, to start from when it is changed */
  current: string | null
  api: RestrictionApi
  onSaved(account: AdminAccountState): void
  onClose(): void
}) {
  const [reason, setReason] = useState(current ?? '')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [failure, setFailure] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const id = useId()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setFailure(null)
    const value = reason.trim()
    if (value === '') {
      setFieldError(`Вкажіть причину обмеження (від 1 до ${REASON_MAX} символів)`)
      return
    }
    if (value.length > REASON_MAX) {
      setFieldError(`Причина задовга: допустимо не більше ${REASON_MAX} символів`)
      return
    }
    setFieldError(null)
    setBusy(true)
    try {
      onSaved(await api.restrictUser(uid, value))
    } catch (err) {
      setFailure(err)
      setBusy(false)
    }
  }

  return (
    <Modal open title={current === null ? 'Накласти хмарне обмеження' : 'Змінити причину обмеження'} onClose={onClose}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Нові хмарні аналізи й транскрипції вокалу цього користувача відхилятимуться не пізніше ніж за хвилину. Задачі, які вже виконуються, завершаться, а
          пісні й дані лишаться. Дію буде записано в журнал.
        </p>
        <div>
          <label htmlFor={`${id}-reason`} className="mb-1 block text-sm font-medium text-text">
            {REASON_LABEL}
          </label>
          <textarea
            id={`${id}-reason`}
            rows={3}
            value={reason}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${id}-hint ${id}-error` : `${id}-hint`}
            onChange={(e) => {
              setReason(e.target.value)
              setFieldError(null)
              setFailure(null)
            }}
            className="w-full rounded-xl border border-border-strong bg-surface-3 px-3 py-2 text-sm text-text aria-[invalid=true]:border-danger"
          />
          <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
            {REASON_HINT}
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
          <Button type="submit" variant="primary" disabled={busy}>
            {current === null ? 'Накласти обмеження' : 'Зберегти причину'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

type Dialog = 'restrict' | 'delete' | null

interface RestrictionActionsProps {
  uid: string
  /** the user's email: the deletion is confirmed by typing it */
  email: string
  account: AdminAccountState
  api?: RestrictionApi
  /** the state the server returned after an action */
  onChanged(account: AdminAccountState): void
}

export function RestrictionActions({ uid, email, account, api = adminApi, onChanged }: RestrictionActionsProps) {
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)

  const changed = (next: AdminAccountState) => {
    setDialog(null)
    onChanged(next)
  }

  async function direct(call: () => Promise<AdminAccountState>) {
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      onChanged(await call())
    } catch (err) {
      setFailure(err)
    } finally {
      setBusy(false)
    }
  }

  const scheduled = account.status === 'deletion_scheduled'
  const restricted = account.status === 'restricted'

  return (
    <>
      <div className="mt-2 flex flex-wrap gap-2">
        {scheduled ? (
          <Button size="sm" disabled={busy} onClick={() => direct(() => api.cancelDeletion(uid))}>
            Скасувати видалення
          </Button>
        ) : (
          <>
            <Button size="sm" onClick={() => setDialog('restrict')}>
              {restricted ? 'Змінити причину' : 'Обмежити хмару'}
            </Button>
            {restricted && (
              <Button size="sm" disabled={busy} onClick={() => direct(() => api.unrestrictUser(uid))}>
                Зняти обмеження
              </Button>
            )}
            <Button size="sm" variant="danger" onClick={() => setDialog('delete')}>
              Запланувати видалення
            </Button>
          </>
        )}
      </div>
      {failure !== null && (
        <p className="mt-2 text-sm text-danger" role="alert">
          {adminErrorMessage(failure)}
        </p>
      )}
      {dialog === 'restrict' && (
        <RestrictionDialog uid={uid} current={account.restriction?.reason ?? null} api={api} onSaved={changed} onClose={() => setDialog(null)} />
      )}
      {dialog === 'delete' && <DeletionDialog uid={uid} email={email} onScheduled={changed} onClose={() => setDialog(null)} />}
    </>
  )
}

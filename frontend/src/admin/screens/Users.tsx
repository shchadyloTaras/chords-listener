import { useState, type FormEvent } from 'react'
import { Button } from '../../components/ui/IconButton'
import { adminErrorMessage, searchUsers } from '../../lib/adminApi'
import { useAdminData } from '../useAdminData'
import { adminPaths } from '../useAdminRoute'

/** The shortest search the server accepts (AC-04); a shorter string is never sent. */
export const MIN_QUERY_LENGTH = 3

function Results({ q }: { q: string }) {
  const { data, error, loading, refresh } = useAdminData((signal) => searchUsers(q, signal), q)

  if (error) {
    return (
      <div className="mt-4 text-sm" role="alert">
        <p className="text-danger">{adminErrorMessage(error)}</p>
        <Button size="sm" className="mt-2" onClick={refresh}>
          Спробувати ще раз
        </Button>
      </div>
    )
  }
  if (!data) return <p className="mt-4 text-sm text-muted">{loading ? 'Пошук…' : ''}</p>
  if (data.items.length === 0) return <p className="mt-4 text-sm text-muted">Нікого не знайдено</p>
  return (
    <div className="mt-4">
      <ul className="divide-y divide-border rounded-xl border border-border bg-surface-1">
        {data.items.map((u) => (
          <li key={u.uid} className="flex items-center gap-2 px-4 py-2.5 text-sm">
            {/* user text: rendered as a text node, isolated so a bidi override cannot leak into its neighbours */}
            <a href={`#${adminPaths.user(u.uid)}`} className="min-w-0 break-all text-accent hover:underline [unicode-bidi:isolate]">
              {u.email}
            </a>
            {u.service && <span className="shrink-0 rounded-md bg-surface-3 px-1.5 py-0.5 text-xs text-muted">службовий</span>}
          </li>
        ))}
      </ul>
      {data.truncated && <p className="mt-2 text-sm text-muted">Знайдено понад 50 збігів. Уточніть запит, щоб побачити решту.</p>}
    </div>
  )
}

/** «Користувачі»: search by part of an email (≥ 3 characters, anywhere in the address, any case) → the card. */
export function Users() {
  const [draft, setDraft] = useState('')
  const [tooShort, setTooShort] = useState(false)
  // `n` makes the same query searchable again (a fresh request, a fresh journal record)
  const [submitted, setSubmitted] = useState<{ q: string; n: number } | null>(null)

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const q = draft.trim()
    if (q.length < MIN_QUERY_LENGTH) {
      setTooShort(true)
      setSubmitted(null)
      return
    }
    setTooShort(false)
    setSubmitted((s) => ({ q, n: (s?.n ?? 0) + 1 }))
  }

  return (
    <section className="px-4 py-6">
      <h1 className="text-lg font-semibold text-text">Користувачі</h1>
      <form onSubmit={onSubmit} className="mt-4 flex max-w-xl gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Пошук за email"
          placeholder="Частина email, щонайменше 3 символи"
          autoComplete="off"
          spellCheck={false}
          className="h-10 min-w-0 flex-1 rounded-xl border border-border-strong bg-surface-2 px-3 text-sm text-text placeholder:text-muted"
        />
        <Button type="submit" variant="primary">
          Шукати
        </Button>
      </form>
      {tooShort && (
        <p className="mt-2 text-sm text-muted" role="status">
          Введіть щонайменше {MIN_QUERY_LENGTH} символи для пошуку
        </p>
      )}
      {submitted && <Results key={`${submitted.q}#${submitted.n}`} q={submitted.q} />}
    </section>
  )
}

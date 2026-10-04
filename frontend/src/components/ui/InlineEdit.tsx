import clsx from 'clsx'
import { Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface InlineEditProps {
  value: string
  placeholder: string
  /** accessible label for the edit affordance, e.g. "Rename" */
  label: string
  onSave(next: string): Promise<void> | void
  className?: string
  inputClassName?: string
  maxLength?: number
  disabled?: boolean
}

/** Text that turns into an input on click. Enter / blur saves, Esc cancels. */
export function InlineEdit({
  value,
  placeholder,
  label,
  onSave,
  className,
  inputClassName,
  maxLength = 200,
  disabled,
}: InlineEditProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commit = async () => {
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    const next = draft.trim()
    if (!next || next === value) {
      setEditing(false)
      setDraft(value)
      return
    }
    setSaving(true)
    try {
      await onSave(next)
      setEditing(false)
    } catch {
      inputRef.current?.focus()
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        maxLength={maxLength}
        disabled={saving}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            cancelled.current = true
            setDraft(value)
            setEditing(false)
          }
        }}
        className={clsx(
          'w-full min-w-0 rounded-md border border-accent/60 bg-surface-2 px-1.5 outline-none!',
          inputClassName,
        )}
      />
    )
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        setDraft(value)
        setEditing(true)
      }}
      title={label}
      aria-label={`${label}: ${value || placeholder}`}
      className={clsx(
        'group/edit -mx-1.5 flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-left',
        'transition-colors hover:bg-surface-3 disabled:pointer-events-none',
        className,
      )}
    >
      <span className={clsx('truncate', !value && 'text-faint')}>{value || placeholder}</span>
      {!disabled && (
        <Pencil
          aria-hidden="true"
          className="size-3.5 shrink-0 text-faint opacity-0 transition-opacity group-hover/edit:opacity-100 group-focus-visible/edit:opacity-100"
        />
      )}
    </button>
  )
}

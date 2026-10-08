import type { ReactNode } from 'react'

export const fieldClass =
  'rounded-lg border border-border-strong bg-surface-2 px-2.5 py-1.5 text-sm text-text focus-visible:outline-2 focus-visible:outline-accent'

/** A labelled control of a filter bar. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      {children}
    </label>
  )
}

/** The «Від» / «До» day inputs of a period (UTC days, "YYYY-MM-DD"). */
export function PeriodInputs({ from, to, onChange }: { from: string; to: string; onChange(next: { from: string; to: string }): void }) {
  return (
    <>
      <Field label="Від (UTC)">
        <input type="date" aria-label="Від" className={fieldClass} value={from} onChange={(e) => onChange({ from: e.target.value, to })} />
      </Field>
      <Field label="До (UTC)">
        <input type="date" aria-label="До" className={fieldClass} value={to} onChange={(e) => onChange({ from, to: e.target.value })} />
      </Field>
    </>
  )
}

/** Why a period is not used: shown instead of the data, never alongside a request. */
export function PeriodRule({ text }: { text: string }) {
  return (
    <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      {text}
    </p>
  )
}

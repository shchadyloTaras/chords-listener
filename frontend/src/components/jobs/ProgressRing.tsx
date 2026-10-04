import clsx from 'clsx'

/** Tiny circular progress indicator (indeterminate spin when progress is null). */
export function ProgressRing({ progress, className }: { progress: number | null; className?: string }) {
  const r = 7
  const c = 2 * Math.PI * r
  const p = progress === null ? 0.25 : Math.max(0.02, Math.min(1, progress))
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" className={clsx('size-4 shrink-0 -rotate-90', progress === null && 'animate-spin', className)}>
      <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${c * p} ${c}`}
        className="transition-[stroke-dasharray] duration-300"
      />
    </svg>
  )
}

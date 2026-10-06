// Small, consistent controls for the chord workspace.

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import clsx from 'clsx'

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: 'sm' | 'md' }
>(function IconButton({ label, active, size = 'md', className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-lg transition-colors duration-150 disabled:pointer-events-none disabled:opacity-35',
        size === 'sm' ? 'size-7' : 'size-9',
        active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-3 hover:text-text',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})

export const ToggleChip = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { pressed: boolean; icon?: ReactNode }
>(function ToggleChip({ pressed, icon, className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={pressed}
      className={clsx(
        'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors duration-150',
        pressed
          ? 'bg-accent-soft text-accent'
          : 'text-muted hover:bg-surface-3 hover:text-text',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
})

export interface SegmentOption<T extends string | number> {
  value: T
  label: ReactNode
  title?: string
  /** shown faded (still selectable), e.g. a value that does not fit the screen right now */
  dim?: boolean
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  className,
  size = 'md',
  tour,
}: {
  value: T
  options: SegmentOption<T>[]
  onChange(v: T): void
  label: string
  className?: string
  size?: 'sm' | 'md'
  /** a guided-tour anchor (data-tour) */
  tour?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} data-tour={tour} className={clsx('inline-flex shrink-0 rounded-lg bg-surface-2 p-0.5', className)}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={clsx(
              'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors duration-150',
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
              on ? 'bg-surface-3 text-text shadow-[0_1px_0_rgb(255_255_255/0.04)_inset]' : 'text-muted hover:text-text',
              o.dim && 'opacity-45',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Thin vertical divider between toolbar groups. */
export function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
}

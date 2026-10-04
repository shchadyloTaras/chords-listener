import clsx from 'clsx'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

type Size = 'sm' | 'md' | 'lg'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  /** shown in the native tooltip after the label, e.g. a shortcut */
  hint?: string
  size?: Size
  active?: boolean
  children: ReactNode
}

const sizes: Record<Size, string> = {
  sm: 'size-8 rounded-lg',
  md: 'size-9 rounded-xl',
  lg: 'size-11 rounded-xl',
}

/** Square icon-only button with an accessible label and tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, hint, size = 'md', active, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={hint ? `${label} (${hint})` : label}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center text-muted transition-colors duration-150',
        'hover:bg-surface-3 hover:text-text disabled:pointer-events-none disabled:opacity-40',
        active && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent',
        sizes[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  icon?: ReactNode
}

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-110 active:brightness-95',
  secondary: 'border border-border-strong bg-surface-2 text-text hover:bg-surface-3',
  ghost: 'text-muted hover:bg-surface-3 hover:text-text',
  danger: 'border border-danger/40 text-danger hover:bg-danger/10',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center gap-2 font-medium whitespace-nowrap transition duration-150',
        'disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'h-8 rounded-lg px-3 text-sm' : 'h-10 rounded-xl px-4 text-sm',
        variants[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
})

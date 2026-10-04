import clsx from 'clsx'
import type { ReactNode } from 'react'

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={clsx(
        'inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border-strong border-b-2',
        'bg-surface-2 px-1.5 font-mono text-xs font-medium text-text',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

import clsx from 'clsx'
import { AnimatePresence, motion } from 'framer-motion'
import { Check } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'

interface MenuCtx {
  close(): void
}
const Ctx = createContext<MenuCtx>({ close: () => undefined })

interface MenuProps {
  /** renders the trigger; spread `props` onto a button */
  trigger: (props: {
    onClick(): void
    'aria-haspopup': 'menu'
    'aria-expanded': boolean
    'aria-controls': string
  }) => ReactNode
  children: ReactNode
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
  className?: string
  /** accessible name of the menu */
  label: string
}

/** Lightweight dropdown menu: outside click / Esc close, arrow-key navigation, focus restore. */
export function Menu({ trigger, children, side = 'bottom', align = 'end', className, label }: MenuProps) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    wrapRef.current?.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(id)}"]`)?.focus()
  }, [id])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    // the header persists across routes: a page change must not leave a menu hanging open
    const onNavigate = () => setOpen(false)
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('hashchange', onNavigate)
    const raf = requestAnimationFrame(() => {
      const items = listRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])')
      const checked = listRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')
      ;(checked ?? items?.[0])?.focus()
    })
    return () => {
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('hashchange', onNavigate)
      cancelAnimationFrame(raf)
    }
  }, [open])

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? [])
    const idx = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const dir = e.key === 'ArrowDown' ? 1 : -1
      items[(idx + dir + items.length) % items.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      setOpen(false)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === ' ') {
      // keep global player shortcuts from firing while the menu has focus
      if (e.key !== ' ') e.preventDefault()
      e.stopPropagation()
    }
  }

  return (
    <div ref={wrapRef} className={clsx('relative', className)}>
      {trigger({
        onClick: () => setOpen((o) => !o),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': id,
      })}
      <AnimatePresence>
        {open && (
          <motion.div
            ref={listRef}
            id={id}
            role="menu"
            aria-label={label}
            onKeyDown={onKeyDown}
            initial={{ opacity: 0, y: side === 'top' ? 6 : -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: side === 'top' ? 4 : -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className={clsx(
              'absolute z-50 min-w-48 rounded-xl border border-border-strong bg-surface-2 p-1 shadow-xl shadow-black/30',
              side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
              align === 'end' ? 'right-0' : 'left-0',
              side === 'top' ? 'origin-bottom' : 'origin-top',
            )}
          >
            <Ctx.Provider value={{ close }}>{children}</Ctx.Provider>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

interface MenuItemProps {
  onSelect(): void
  icon?: ReactNode
  children: ReactNode
  /** renders as a radio-like option with a check mark */
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  /** right-aligned hint (e.g. a shortcut) */
  hint?: ReactNode
  /** keep the menu open after selecting */
  keepOpen?: boolean
}

export function MenuItem({ onSelect, icon, children, checked, danger, disabled, hint, keepOpen }: MenuItemProps) {
  const { close } = useContext(Ctx)
  const isRadio = checked !== undefined
  return (
    <button
      type="button"
      role={isRadio ? 'menuitemradio' : 'menuitem'}
      aria-checked={isRadio ? checked : undefined}
      disabled={disabled}
      tabIndex={-1}
      onClick={() => {
        onSelect()
        if (!keepOpen) close()
      }}
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none! transition-colors duration-100',
        'focus-visible:bg-surface-3 hover:bg-surface-3 disabled:opacity-40',
        danger ? 'text-danger' : checked ? 'text-accent' : 'text-text',
      )}
    >
      {icon && <span className="flex size-4 items-center justify-center text-muted [&>svg]:size-4">{icon}</span>}
      <span className="flex-1">{children}</span>
      {hint && <span className="text-xs text-faint">{hint}</span>}
      {isRadio && <Check className={clsx('size-4', checked ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />}
    </button>
  )
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-border" />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-2 pb-1 text-xs text-faint">{children}</div>
}

import clsx from 'clsx'
import { motion } from 'framer-motion'

const BARS = 12

/**
 * Twelve bars in circle-of-fifths colors that "listen" while a job runs.
 * Motion is skipped for prefers-reduced-motion (MotionConfig reducedMotion="user").
 */
export function ListeningBars({ active, className }: { active: boolean; className?: string }) {
  return (
    <div aria-hidden="true" className={clsx('flex h-16 items-end gap-1.5', className)}>
      {Array.from({ length: BARS }, (_, i) => {
        const base = 0.25 + ((i * 7) % 5) * 0.08
        return (
          <motion.span
            key={i}
            className="w-2.5 origin-bottom rounded-full"
            style={{ height: '100%', backgroundColor: `var(--chord-${i})` }}
            initial={{ scaleY: base }}
            animate={
              active
                ? { scaleY: [base, 0.9 - ((i * 5) % 4) * 0.12, base + 0.15, 0.55, base] }
                : { scaleY: 0.12 }
            }
            transition={
              active
                ? { duration: 1.6 + (i % 4) * 0.25, repeat: Infinity, ease: 'easeInOut', delay: i * 0.07 }
                : { duration: 0.3 }
            }
          />
        )
      })}
    </div>
  )
}

import { memo } from 'react'
import clsx from 'clsx'
import { splitLabel } from '../../lib/music/chord'

/**
 * Chord symbol in lead-sheet typography: root at full size, accidental raised, quality and
 * slash bass smaller. The text content stays the plain label (copy-paste friendly).
 */
export const ChordName = memo(function ChordName({
  label,
  className,
  none = '—',
}: {
  label: string
  className?: string
  /** what to show for "N" */
  none?: string
}) {
  if (label === 'N') return <span className={clsx('cw-chord', className)}>{none}</span>
  const { root, suffix, bass } = splitLabel(label)
  const letter = root.charAt(0)
  const acc = root.slice(1)
  return (
    <span className={clsx('cw-chord', className)}>
      {letter}
      {acc && <span className="cw-acc">{acc}</span>}
      {suffix && <span className="cw-suffix">{suffix}</span>}
      {bass && <span className="cw-bass">/{bass}</span>}
    </span>
  )
})

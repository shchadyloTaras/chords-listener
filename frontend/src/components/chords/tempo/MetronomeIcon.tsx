// Metronome glyph in the lucide style (lucide has no metronome icon).

export function MetronomeIcon({ className, size }: { className?: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size ?? 24}
      height={size ?? 24}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M9.2 3h5.6a1 1 0 0 1 .97.76L19.7 19.76A1 1 0 0 1 18.73 21H5.27a1 1 0 0 1-.97-1.24L8.23 3.76A1 1 0 0 1 9.2 3Z" />
      <path d="M7 16h10" />
      <path d="m12 16 5-9.5" />
    </svg>
  )
}

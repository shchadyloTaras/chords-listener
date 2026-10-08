// Song parts (intro, verse, chorus, …; lib/music/sections) in the chord views: their names, the
// menu that renames a part (every occurrence; kept per track on this device) and the header row a
// part gets in the chord sheet.

import { memo } from 'react'
import { ChevronDown } from 'lucide-react'
import { useT } from '../../i18n'
import { SECTION_KINDS, type SectionKind, type SongSection } from '../../lib/music/sections'
import { useApp } from '../../store'
import { partName, partTime, setPartKind } from './partNames'

/** The part's name as a menu: picking another name renames every occurrence of the part. */
export function PartNameSelect({ trackId, partKey, group, kind, renamed }: { trackId: string; partKey: string; group: string; kind: SectionKind; renamed: boolean }) {
  const t = useT()
  const name = partName(t, kind, group)
  return (
    <span className="relative -ml-1 inline-flex items-center rounded-md hover:bg-surface-2">
      <select
        value={kind}
        onChange={(e) => setPartKind(trackId, partKey, e.target.value === '' ? null : (e.target.value as SectionKind))}
        aria-label={t('chords.section.renameOf', { name })}
        title={t('chords.section.renameHint')}
        className="cursor-pointer appearance-none bg-transparent py-0.5 pr-5 pl-1 text-sm font-semibold text-text"
      >
        {SECTION_KINDS.map((k) => (
          <option key={k} value={k}>
            {partName(t, k, group)}
          </option>
        ))}
        {renamed && <option value="">{t('chords.section.auto')}</option>}
      </select>
      <ChevronDown size={13} aria-hidden className="pointer-events-none absolute right-1 text-muted" />
    </span>
  )
}

/** The header row over a part's first line in the sheet: its name (a menu) and when it starts. */
export const SectionHeader = memo(function SectionHeader({ trackId, partKey, renamed, section }: { trackId: string; partKey: string; renamed: boolean; section: SongSection }) {
  const t = useT()
  const name = partName(t, section.kind, section.group, section.n, section.of)
  return (
    <div className="mt-2 flex items-baseline gap-2 first:mt-0">
      <PartNameSelect trackId={trackId} partKey={partKey} group={section.group} kind={section.kind} renamed={renamed} />
      {section.of > 1 && <span className="font-mono text-xs text-faint tabular-nums">{section.n}/{section.of}</span>}
      <button
        type="button"
        onClick={() => useApp.getState().seek(section.start)}
        title={t('chords.section.go', { name, time: partTime(section.start) })}
        className="font-mono text-xs text-muted tabular-nums hover:text-text"
      >
        {partTime(section.start)}
      </button>
    </div>
  )
})


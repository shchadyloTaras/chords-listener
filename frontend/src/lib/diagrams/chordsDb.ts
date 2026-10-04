// Guitar / ukulele voicings from @tombatossals/chords-db, loaded lazily (separate chunks).

import type { ChordQuality } from '../../types'
import { formatChord, parseChord, simplifyQuality, type ParsedChord } from '../music/chord'
import { FLAT_NAMES, SHARP_NAMES } from '../music/notes'

export type FretInstrument = 'guitar' | 'ukulele'

export interface Voicing {
  /** per string, low → high; -1 muted, 0 open, n = fret relative to baseFret */
  frets: number[]
  fingers: number[]
  baseFret: number
  /** relative fret numbers that are barred */
  barres: number[]
  capo?: boolean
  midi?: number[]
}

interface DbChord {
  key: string
  suffix: string
  positions: Voicing[]
}

export interface ChordDb {
  main: { strings: number; fretsOnChord: number; name: string }
  tunings: Record<string, string[]>
  chords: Record<string, DbChord[]>
}

/** chords-db object keys per pitch class (guitar and ukulele name sharps differently). */
const DB_KEYS: Record<FretInstrument, string[]> = {
  guitar: ['C', 'Csharp', 'D', 'Eb', 'E', 'F', 'Fsharp', 'G', 'Ab', 'A', 'Bb', 'B'],
  ukulele: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'],
}

const DB_SUFFIX: Record<ChordQuality, string> = {
  maj: 'major',
  min: 'minor',
  '7': '7',
  maj7: 'maj7',
  min7: 'm7',
  dim: 'dim',
  aug: 'aug',
  sus2: 'sus2',
  sus4: 'sus4',
  dim7: 'dim7',
  hdim7: 'm7b5',
  '6': '6',
  min6: 'm6',
  '9': '9',
  add9: 'add9',
}

const cache = new Map<FretInstrument, ChordDb>()
const pending = new Map<FretInstrument, Promise<ChordDb>>()

export function getLoadedDb(instrument: FretInstrument): ChordDb | null {
  return cache.get(instrument) ?? null
}

/** Loads (once) the voicing database for an instrument. */
export function loadChordDb(instrument: FretInstrument): Promise<ChordDb> {
  const hit = cache.get(instrument)
  if (hit) return Promise.resolve(hit)
  let p = pending.get(instrument)
  if (!p) {
    const load =
      instrument === 'guitar'
        ? import('@tombatossals/chords-db/lib/guitar.json')
        : import('@tombatossals/chords-db/lib/ukulele.json')
    p = load
      .then((m) => {
        const db = ((m as { default?: unknown }).default ?? m) as ChordDb
        cache.set(instrument, db)
        return db
      })
      .finally(() => pending.delete(instrument))
    pending.set(instrument, p)
  }
  return p
}

export interface VoicingLookup {
  voicings: Voicing[]
  strings: number
  /** true when the exact chord (incl. slash bass) was found */
  exact: boolean
  /** chord actually shown when not exact (e.g. "G" for "G/A"), else the requested label */
  shown: string
}

function findSuffix(list: DbChord[] | undefined, suffix: string): DbChord | undefined {
  return list?.find((c) => c.suffix === suffix)
}

/**
 * Voicings for a chord. Falls back (exact = false) from a missing slash chord to its base
 * chord, and from a missing quality to the root triad of the same family, then to the major triad.
 */
export function lookupVoicings(db: ChordDb, instrument: FretInstrument, chord: ParsedChord): VoicingLookup {
  const strings = db.main.strings
  const list = db.chords[DB_KEYS[instrument][chord.rootPc]]
  const result = (found: DbChord | undefined, exact: boolean, shown: string): VoicingLookup | null =>
    found && found.positions.length ? { voicings: found.positions, strings, exact, shown } : null

  if (chord.bassPc != null && (chord.quality === 'maj' || chord.quality === 'min')) {
    const pre = chord.quality === 'min' ? 'm' : ''
    for (const name of [SHARP_NAMES[chord.bassPc], FLAT_NAMES[chord.bassPc]]) {
      const r = result(findSuffix(list, `${pre}/${name}`), true, formatChord(chord))
      if (r) return r
    }
  }
  const base = formatChord({ rootPc: chord.rootPc, root: chord.root, quality: chord.quality })
  const direct = result(findSuffix(list, DB_SUFFIX[chord.quality]), chord.bassPc == null, base)
  if (direct) return direct
  const triad = simplifyQuality(chord.quality)
  const tri = result(
    findSuffix(list, DB_SUFFIX[triad]),
    false,
    formatChord({ rootPc: chord.rootPc, root: chord.root, quality: triad }),
  )
  if (tri) return tri
  return (
    result(findSuffix(list, 'major'), false, formatChord({ rootPc: chord.rootPc, root: chord.root, quality: 'maj' })) ?? {
      voicings: [],
      strings,
      exact: false,
      shown: base,
    }
  )
}

/** Convenience: lookup by label; null for "N" / unknown labels. */
export function lookupLabel(db: ChordDb, instrument: FretInstrument, label: string): VoicingLookup | null {
  const p = parseChord(label)
  return p ? lookupVoicings(db, instrument, p) : null
}

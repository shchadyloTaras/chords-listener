// The wind fingering chart's proportions (chart units), shared by the chart and the diagram's placeholder.

import { MAX_ARPEGGIO, type WindSpec } from '../../../lib/wind'

/** Gap between two fingering columns, the band over them for the register marks and under them for the note names. */
export const GAP = 2.4
export const TOP_BAND = 3.4
export const NAME_BAND = 7.4
export const PAD = 0.8

/** Height / width of a chart of `spec` (always drawn MAX_ARPEGGIO columns wide). */
export function windAspect(spec: WindSpec): number {
  const w = MAX_ARPEGGIO * spec.width + (MAX_ARPEGGIO - 1) * GAP + 2 * PAD
  return (spec.height + TOP_BAND + NAME_BAND + 2 * PAD) / w
}

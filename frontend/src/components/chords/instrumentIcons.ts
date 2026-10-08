// An icon per instrument for the phone's instrument menu. Lucide has the guitar and the piano; the bass,
// ukulele, harmonium, handpan, sopilka and flute are drawn here on its 24 grid in its style (2 px round
// strokes), so they sit next to lucide icons and take the same props.

import { createLucideIcon, Guitar, Piano, type LucideIcon } from 'lucide-react'
import type { Instrument } from '../../store'

/** like lucide's guitar: the neck to the top right */
const TO_TOP_RIGHT = 'rotate(45 12 12)'
/** the other way, so the ukulele does not read as a small guitar */
const TO_TOP_LEFT = 'rotate(-30 12 12)'

/** Electric bass: a body with two horns, a long neck, the pegs on one side, a pickup. */
export const BassGuitar = createLucideIcon('bass-guitar', [
  [
    'path',
    {
      d: 'M10.8 14C9.8 13.6 8.6 11.6 7.8 11.8 7 12 6.8 13.8 7.2 15 5.6 16.4 5.4 19.8 7.6 21.4c2 1.4 6.8 1.4 8.8 0 2.2-1.6 2-5.4.4-7.1.6-1.5.4-4-.6-3.8-1 .3-2 2.7-3 3.5',
      transform: TO_TOP_RIGHT,
      key: 'body',
    },
  ],
  ['path', { d: 'M12 15.5V-2', transform: TO_TOP_RIGHT, key: 'neck' }],
  ['path', { d: 'M12 -1.5h1.8', transform: TO_TOP_RIGHT, key: 'peg1' }],
  ['path', { d: 'M12 1h1.8', transform: TO_TOP_RIGHT, key: 'peg2' }],
  ['path', { d: 'M10.4 18h3.2', transform: TO_TOP_RIGHT, key: 'pickup' }],
])

/** Ukulele: a small figure-of-eight body with a sound hole, a short neck, a small head. */
export const Ukulele = createLucideIcon('ukulele', [
  [
    'path',
    {
      d: 'M12 22.8c-4.2 0-6.1-2.8-5.2-5.6.6-1.6 2-2.1 1.8-3.6-.3-2.4 1-4.8 3.4-4.8s3.7 2.4 3.4 4.8c-.2 1.5 1.2 2 1.8 3.6.9 2.8-1 5.6-5.2 5.6z',
      transform: TO_TOP_LEFT,
      key: 'body',
    },
  ],
  ['circle', { cx: '12', cy: '16.4', r: '1.3', transform: TO_TOP_LEFT, key: 'hole' }],
  ['path', { d: 'M12 8.8V4.6', transform: TO_TOP_LEFT, key: 'neck' }],
  ['rect', { x: '10.5', y: '1.2', width: '3', height: '3.4', rx: '1', transform: TO_TOP_LEFT, key: 'head' }],
])

/** Indian hand harmonium from the front: the folded bellows behind, the keys, the stops below. */
export const Harmonium = createLucideIcon('harmonium', [
  ['path', { d: 'M5 3.5h14', key: 'fold1' }],
  ['path', { d: 'M4 6.5h16', key: 'fold2' }],
  ['rect', { x: '2', y: '9.5', width: '20', height: '11.5', rx: '2', key: 'box' }],
  ['path', { d: 'M2 14h20', key: 'keys' }],
  ['path', { d: 'M6.5 9.5V14', key: 'key1' }],
  ['path', { d: 'M11 9.5V14', key: 'key2' }],
  ['path', { d: 'M15.5 9.5V14', key: 'key3' }],
  ['circle', { cx: '7', cy: '17.6', r: '.6', key: 'stop1' }],
  ['circle', { cx: '12', cy: '17.6', r: '.6', key: 'stop2' }],
  ['circle', { cx: '17', cy: '17.6', r: '.6', key: 'stop3' }],
])

/** Handpan from the side: two shells meeting at the rim, the ding on top, two tone fields. */
export const Handpan = createLucideIcon('handpan', [
  ['path', { d: 'M2 14c2-6.5 18-6.5 20 0', key: 'top' }],
  ['path', { d: 'M2 14c2.5 5.5 17.5 5.5 20 0', key: 'bottom' }],
  ['path', { d: 'M1.5 14h21', key: 'rim' }],
  ['path', { d: 'M9 9.4c.5-3 5.5-3 6 0', key: 'ding' }],
  ['path', { d: 'M5.4 12q1.1-1 2.2 0', key: 'field1' }],
  ['path', { d: 'M16.4 12q1.1-1 2.2 0', key: 'field2' }],
])

/** Sopilka, held down and away like a recorder: the beak and the window on top, a row of finger holes. */
export const Sopilka = createLucideIcon('sopilka', [
  ['path', { d: 'M10.4 7.5 10.8 2h2.4l.4 5.5', transform: 'rotate(-35 12 12)', key: 'beak' }],
  ['rect', { x: '10', y: '7.5', width: '4', height: '15', rx: '2', transform: 'rotate(-35 12 12)', key: 'body' }],
  ['path', { d: 'M11 5h2', transform: 'rotate(-35 12 12)', key: 'window' }],
  ['circle', { cx: '12', cy: '12', r: '.4', transform: 'rotate(-35 12 12)', key: 'hole1' }],
  ['circle', { cx: '12', cy: '15', r: '.4', transform: 'rotate(-35 12 12)', key: 'hole2' }],
  ['circle', { cx: '12', cy: '18', r: '.4', transform: 'rotate(-35 12 12)', key: 'hole3' }],
])

/** Concert flute, held to the right: a long tube, the embouchure hole near the left end, the key rings along it. */
export const Flute = createLucideIcon('flute', [
  ['rect', { x: '1', y: '10', width: '22', height: '4', rx: '2', transform: 'rotate(-30 12 12)', key: 'tube' }],
  ['circle', { cx: '4.6', cy: '12', r: '.4', transform: 'rotate(-30 12 12)', key: 'embouchure' }],
  ['path', { d: 'M10.5 10v4', transform: 'rotate(-30 12 12)', key: 'key1' }],
  ['path', { d: 'M14.5 10v4', transform: 'rotate(-30 12 12)', key: 'key2' }],
  ['path', { d: 'M18.5 10v4', transform: 'rotate(-30 12 12)', key: 'key3' }],
])

export const INSTRUMENT_ICON: Record<Instrument, LucideIcon> = {
  guitar: Guitar,
  bass: BassGuitar,
  ukulele: Ukulele,
  piano: Piano,
  harmonium: Harmonium,
  handpan: Handpan,
  sopilka: Sopilka,
  flute: Flute,
}

// The repo's first i18n completeness test: every tour.* key has a non-empty uk and en entry, every step has
// its title and every text variant, nothing is left over, and the Ukrainian speaks informally («ти»).
import { describe, expect, it } from 'vitest'
import { textKeys, titleKey, TOUR_IDS, TOURS } from '../lib/tour/tours'
import { tour } from './tour'

const stepKeys = TOUR_IDS.flatMap((id) => TOURS[id].steps.flatMap((s) => [titleKey(id, s), ...textKeys(id, s)]))
const L = 'а-яіїєґʼ'
const FORMAL = new RegExp(`(^|[^${L}])(ви|вас|вам|ваш[${L}]*|[${L}]+(іть|айте|уйте|ийте))(?=$|[^${L}])`, 'iu')

describe('tour texts', () => {
  it('every tour.* key has a non-empty uk and en entry', () => {
    const keys = new Set([...Object.keys(tour.uk), ...Object.keys(tour.en)])
    for (const key of keys) {
      expect(key.startsWith('tour.'), key).toBe(true)
      expect(tour.uk[key]?.trim(), `uk ${key}`).toBeTruthy()
      expect(tour.en[key]?.trim(), `en ${key}`).toBeTruthy()
    }
  })

  it('every step has its title and every text variant', () => {
    for (const key of stepKeys) {
      expect(tour.uk[key], `uk ${key}`).toBeTruthy()
      expect(tour.en[key], `en ${key}`).toBeTruthy()
    }
  })

  it('has no step keys that no step uses', () => {
    const used = new Set(stepKeys)
    const stepish = Object.keys(tour.uk).filter((k) => TOUR_IDS.some((id) => k.startsWith(`tour.${id}.`)))
    expect(stepish.filter((k) => !used.has(k))).toEqual([])
  })

  it('speaks to the reader informally in Ukrainian («ти», not «ви»)', () => {
    for (const [key, text] of Object.entries(tour.uk)) expect(FORMAL.test(text), `${key}: ${text}`).toBe(false)
  })
})

// tuner.* strings: every key has a non-empty uk and en entry, and the Ukrainian speaks informally («ти»).
import { describe, expect, it } from 'vitest'
import { tuner } from './tuner'

const L = 'а-яіїєґʼ'
const FORMAL = new RegExp(`(^|[^${L}])(ви|вас|вам|ваш[${L}]*|[${L}]+(іть|айте|уйте|ийте))(?=$|[^${L}])`, 'iu')

describe('tuner texts', () => {
  it('every tuner.* key has a non-empty uk and en entry', () => {
    const keys = new Set([...Object.keys(tuner.uk), ...Object.keys(tuner.en)])
    for (const key of keys) {
      expect(key.startsWith('tuner.'), key).toBe(true)
      expect(tuner.uk[key]?.trim(), `uk ${key}`).toBeTruthy()
      expect(tuner.en[key]?.trim(), `en ${key}`).toBeTruthy()
    }
  })

  it('speaks to the reader informally in Ukrainian («ти», not «ви»)', () => {
    for (const [key, text] of Object.entries(tuner.uk)) expect(FORMAL.test(text), `${key}: ${text}`).toBe(false)
  })
})

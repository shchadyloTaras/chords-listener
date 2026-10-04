// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveBlob, scoreFileName } from './download'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('score downloads', () => {
  it('names the file «<title> — ноти.<ext>» with unsafe characters removed', () => {
    expect(scoreFileName('Пісня: "Ой" / mix', 'ноти', 'pdf')).toBe('Пісня Ой mix — ноти.pdf')
    expect(scoreFileName('', 'score', 'mid')).toBe('Chords Listener — score.mid')
  })

  it('saves through a Blob URL on an <a download>', () => {
    URL.createObjectURL = vi.fn(() => 'blob:test/1')
    URL.revokeObjectURL = vi.fn()
    const clicks: { href: string; download: string }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download })
    })
    const result = saveBlob(new Blob(['%PDF'], { type: 'application/pdf' }), 'Тест — ноти.pdf')
    expect(result).toBe('downloaded')
    expect(clicks).toEqual([{ href: 'blob:test/1', download: 'Тест — ноти.pdf' }])
  })
})

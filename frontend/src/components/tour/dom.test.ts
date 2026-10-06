// @vitest-environment jsdom
// The DOM probes: an anchor is its first *visible* match (a copy hidden for the other breakpoint is skipped),
// and what on the page holds an automatic start back.
import { afterEach, describe, expect, it } from 'vitest'
import { anchorElement, domBlockers, typingNow } from './dom'

const made: HTMLElement[] = []
function add(html: string, visible = true): HTMLElement {
  const box = document.createElement('div')
  box.innerHTML = html
  const el = box.firstElementChild as HTMLElement
  el.getClientRects = () => (visible ? [{}] : []) as unknown as DOMRectList
  document.body.append(el)
  made.push(el)
  return el
}

afterEach(() => {
  made.splice(0).forEach((el) => el.remove())
})

describe('anchors', () => {
  it('skips a hidden copy and takes the first visible match', () => {
    add('<div data-tour="song.views">phone copy</div>', false)
    const shown = add('<div data-tour="song.views">desktop copy</div>')
    expect(anchorElement('song.views')).toBe(shown)
  })

  it('is absent when no copy is rendered', () => {
    add('<div data-tour="song.follow"></div>', false)
    expect(anchorElement('song.follow')).toBeNull()
    expect(anchorElement('song.copy')).toBeNull()
  })
})

describe('typing', () => {
  it('an empty focused field is not typing; a field with text is; a button never is', () => {
    const input = add('<input type="url" />') as HTMLInputElement
    input.focus()
    expect(typingNow()).toBe(false)
    input.value = 'https://youtu.be/x'
    expect(typingNow()).toBe(true)
    const area = add('<textarea></textarea>') as HTMLTextAreaElement
    area.focus()
    expect(typingNow()).toBe(false)
    area.value = 'Am F'
    expect(typingNow()).toBe(true)
    add('<button>b</button>').focus()
    expect(typingNow()).toBe(false)
  })
})

describe('blockers', () => {
  it('sees open dialogs, menus and expanded controls', () => {
    expect(domBlockers()).toEqual({ modal: false, menu: false, expanded: false, typing: false, hidden: false })
    add('<div aria-modal="true"></div>')
    add('<div role="menu"></div>')
    add('<button aria-expanded="true"></button>')
    expect(domBlockers()).toMatchObject({ modal: true, menu: true, expanded: true })
  })
})

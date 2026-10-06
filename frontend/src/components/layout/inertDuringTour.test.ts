// @vitest-environment jsdom
// While a tour (any aria-modal dialog) is open, pasting on the home page and dropping a file start nothing,
// the drop overlay does not appear, and a dropped file is still swallowed so the browser does not open it.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { translate } from '../../i18n'
import { useApp } from '../../store'
import { DropOverlay } from './DropOverlay'
import { useGlobalPaste } from './useGlobalPaste'

const { startFiles } = vi.hoisted(() => ({ startFiles: vi.fn() }))
vi.mock('../input/startFiles', () => ({ startFiles }))
vi.mock('../input/startLink', () => ({ startLink: vi.fn(() => new Promise(() => {})) }))

function PasteProbe() {
  useGlobalPaste()
  return null
}

let root: Root
let host: HTMLDivElement
let modal: HTMLDivElement | null = null
const file = new File(['x'], 'song.mp3', { type: 'audio/mpeg' })

function fire(type: 'dragenter' | 'dragover' | 'drop'): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files: [file], dropEffect: 'none' } })
  act(() => {
    window.dispatchEvent(e)
  })
  return e
}

function paste(): void {
  const e = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'clipboardData', { value: { files: [file], getData: () => '' } })
  act(() => {
    document.body.dispatchEvent(e)
  })
}

function openModal(): void {
  modal = document.createElement('div')
  modal.setAttribute('aria-modal', 'true')
  document.body.append(modal)
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useApp.setState({ lang: 'uk' })
  startFiles.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render([createElement(DropOverlay, { key: 'd' }), createElement(PasteProbe, { key: 'p' })]))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  modal?.remove()
  modal = null
})

it('a dropped or pasted file starts a song normally', () => {
  fire('drop')
  paste()
  expect(startFiles).toHaveBeenCalledTimes(2)
})

it('a dropped file does nothing during a tour, and the browser does not open it', () => {
  openModal()
  const over = fire('dragover')
  const drop = fire('drop')
  expect(startFiles).not.toHaveBeenCalled()
  expect(over.defaultPrevented).toBe(true)
  expect(drop.defaultPrevented).toBe(true)
})

it('dragging a file over a tour shows no drop overlay', () => {
  openModal()
  fire('dragenter')
  expect(document.body.textContent).not.toContain(translate('uk', 'core.drop.title'))
})

it('pasting during a tour does nothing', () => {
  openModal()
  paste()
  expect(startFiles).not.toHaveBeenCalled()
})

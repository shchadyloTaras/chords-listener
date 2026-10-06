// @vitest-environment jsdom
// «Розширено: власний сервер» in the mode popover: in the cloud it is shown only to someone who has connected
// their own server (it explains why that server is unused); everyone else in the cloud has nothing to do there.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAuth } from '../../lib/auth'
import { useConnection, useServerPrefs, type ConnectionState } from '../../lib/serverMode'
import { useApp } from '../../store'
import { ServerStatus } from './ServerStatus'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // a desktop: a fine pointer, wider than 640 px
  window.matchMedia = ((query: string) => ({
    matches: query === '(hover: hover) and (pointer: fine)',
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  useApp.setState({ lang: 'uk' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAuth.setState({ user: null })
  useServerPrefs.setState({ localServer: false })
})

// the cloud has answered its health check: opening the popover asks nothing
const CLOUD = { status: 'server', backend: 'cloud', health: {} as ConnectionState['health'], failure: null } as const

function openPopover() {
  act(() => root.render(createElement(ServerStatus)))
  act(() => document.querySelector<HTMLElement>('[data-tour="header.mode"]')!.click())
}

const advanced = () => [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Розширено'))

it('hides the own server section in the cloud from someone who never connected one', () => {
  useAuth.setState({ user: { uid: 'u1', email: 'a@b.c' } })
  useServerPrefs.setState({ localServer: false })
  useConnection.setState(CLOUD)
  openPopover()
  expect(document.body.textContent).toContain('Хмара')
  expect(advanced()).toBe(false)
})

it('keeps it in the cloud for someone who has connected their own server', () => {
  useAuth.setState({ user: { uid: 'u1', email: 'a@b.c' } })
  useServerPrefs.setState({ localServer: true })
  useConnection.setState(CLOUD)
  openPopover()
  expect(advanced()).toBe(true)
})

it('keeps it in the browser mode, where the own server is the way to connect one', () => {
  useServerPrefs.setState({ localServer: false })
  useConnection.setState({ status: 'browser', backend: null })
  openPopover()
  expect(advanced()).toBe(true)
})

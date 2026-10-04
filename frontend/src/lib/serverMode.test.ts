import { afterEach, describe, expect, it } from 'vitest'
import {
  addressHint,
  addressSpaceOf,
  gatedSpace,
  HOSTED,
  normalizeServerUrl,
  resolveServerUrl,
  useConnection,
} from './serverMode'

describe('normalizeServerUrl', () => {
  it.each([
    ['http://localhost:8765', 'http://localhost:8765'],
    ['localhost:8765', 'http://localhost:8765'],
    ['  http://127.0.0.1:8765/api/  ', 'http://127.0.0.1:8765'],
    ['HTTP://LOCALHOST:8766/', 'http://localhost:8766'],
    ['https://studio.example:443', 'https://studio.example'],
    ['192.168.1.20:8765', 'http://192.168.1.20:8765'],
    ['[::1]:8765', 'http://[::1]:8765'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeServerUrl(raw)).toBe(expected)
  })

  it.each(['', '   ', 'ftp://localhost', 'javascript:alert(1)', 'http://user:pw@localhost:8765', 'http://'])(
    'rejects %j',
    (raw) => {
      expect(normalizeServerUrl(raw)).toBeNull()
    },
  )
})

describe('address spaces (Local Network Access)', () => {
  it('classifies hosts', () => {
    expect(addressSpaceOf('localhost')).toBe('loopback')
    expect(addressSpaceOf('app.localhost')).toBe('loopback')
    expect(addressSpaceOf('127.0.0.1')).toBe('loopback')
    expect(addressSpaceOf('[::1]')).toBe('loopback')
    expect(addressSpaceOf('192.168.0.12')).toBe('local')
    expect(addressSpaceOf('10.1.2.3')).toBe('local')
    expect(addressSpaceOf('172.20.0.1')).toBe('local')
    expect(addressSpaceOf('172.32.0.1')).toBe('public')
    expect(addressSpaceOf('studio.local')).toBe('local')
    expect(addressSpaceOf('shchadylotaras.github.io')).toBe('public')
  })

  it('gates only requests from a public page to loopback / local servers', () => {
    expect(gatedSpace('http://localhost:8765', 'public')).toBe('loopback')
    expect(gatedSpace('http://192.168.1.5:8765', 'public')).toBe('local')
    expect(gatedSpace('http://studio-mac.lan:8765', 'public')).toBe('local')
    expect(gatedSpace('https://api.example.com', 'public')).toBeNull()
    expect(gatedSpace('http://localhost:8765', 'loopback')).toBeNull()
  })

  it('adds a targetAddressSpace hint only where mixed content would block', () => {
    // localhost and private IP literals are known to the browser: no hint needed
    expect(addressHint('http://localhost:8765/api/health', 'public', true)).toBeNull()
    expect(addressHint('http://192.168.1.5:8765/api/health', 'public', true)).toBeNull()
    expect(addressHint('http://studio-mac.lan:8765/api/health', 'public', true)).toBe('local')
    expect(addressHint('http://studio-mac.lan:8765/api/health', 'public', false)).toBeNull()
    expect(addressHint('https://studio-mac.lan/api/health', 'public', true)).toBeNull()
  })
})

describe('resolveServerUrl', () => {
  afterEach(() => useConnection.setState({ remote: false, serverOrigin: null }))

  it('keeps same-origin paths', () => {
    useConnection.setState({ remote: false, serverOrigin: 'http://localhost:8765' })
    expect(resolveServerUrl('/api/tracks/abc/audio')).toBe('/api/tracks/abc/audio')
  })

  it('resolves server paths against a remote server', () => {
    useConnection.setState({ remote: true, serverOrigin: 'http://localhost:8765' })
    expect(resolveServerUrl('/api/tracks/abc/audio')).toBe('http://localhost:8765/api/tracks/abc/audio')
    expect(resolveServerUrl('https://i.ytimg.com/vi/x/hq.jpg')).toBe('https://i.ytimg.com/vi/x/hq.jpg')
    expect(resolveServerUrl('//cdn.example/x.jpg')).toBe('//cdn.example/x.jpg')
    expect(resolveServerUrl('')).toBe('')
  })
})

it('local builds are not the hosted build', () => {
  expect(HOSTED).toBe(false)
})

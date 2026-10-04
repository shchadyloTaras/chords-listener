import { afterEach, describe, expect, it } from 'vitest'
import {
  addressHint,
  addressSpaceOf,
  candidateList,
  gatedSpace,
  HOSTED,
  normalizeCloudUrl,
  normalizeServerUrl,
  resolveServerUrl,
  useConnection,
  type CandidateInput,
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

describe('API base selection (docs/CLOUD.md order)', () => {
  const CLOUD = 'https://chords-api-abc123-ew.a.run.app'
  const hosted: CandidateInput = {
    hosted: true,
    here: 'https://shchadylotaras.github.io',
    signedIn: false,
    cloudUrl: CLOUD,
    localServer: false,
    serverUrl: 'http://localhost:8765',
  }
  const bases = (i: CandidateInput) => candidateList(i).list.map((c) => `${c.backend}:${c.base}`)

  it('hosted guest without an own server: browser mode', () => {
    expect(bases(hosted)).toEqual([])
  })

  it('hosted + signed in: the cloud', () => {
    const { list } = candidateList({ ...hosted, signedIn: true })
    expect(list).toEqual([{ base: `${CLOUD}/api`, origin: CLOUD, remote: true, backend: 'cloud' }])
  })

  it('the cloud comes before the user’s own server, which is opt-in', () => {
    expect(bases({ ...hosted, localServer: true })).toEqual(['local:http://localhost:8765/api'])
    expect(bases({ ...hosted, localServer: true, signedIn: true })).toEqual([`cloud:${CLOUD}/api`, 'local:http://localhost:8765/api'])
  })

  it('the page served by a local server always asks it first', () => {
    const local: CandidateInput = { ...hosted, hosted: false, here: 'http://localhost:8765', localServer: true, signedIn: true }
    expect(bases(local)).toEqual(['local:/api', `cloud:${CLOUD}/api`])
    // the Vite dev server: same origin (proxy), the cloud, then the configured server
    expect(bases({ ...local, here: 'http://localhost:5173' })).toEqual(['local:/api', `cloud:${CLOUD}/api`, 'local:http://localhost:8765/api'])
  })

  it('no cloud configured: signing in changes nothing', () => {
    expect(bases({ ...hosted, signedIn: true, cloudUrl: '' })).toEqual([])
  })

  it('flags an unusable own-server address', () => {
    expect(candidateList({ ...hosted, localServer: true, serverUrl: 'ftp://x' })).toEqual({ list: [], invalidServerUrl: true })
  })

  it('normalizes the cloud URL', () => {
    expect(normalizeCloudUrl(`${CLOUD}/`)).toBe(CLOUD)
    expect(normalizeCloudUrl(`${CLOUD}/api/`)).toBe(CLOUD)
    expect(normalizeCloudUrl(' https://example.com/chords/ ')).toBe('https://example.com/chords')
    expect(normalizeCloudUrl('')).toBeNull()
    expect(normalizeCloudUrl(undefined)).toBeNull()
    expect(normalizeCloudUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeCloudUrl('not a url')).toBeNull()
  })
})

describe('signed media URLs from the cloud', () => {
  afterEach(() => useConnection.setState({ remote: false, serverOrigin: null, backend: null }))

  it('resolves them against the cloud, keeping the signature', () => {
    useConnection.setState({ remote: true, backend: 'cloud', serverOrigin: 'https://chords-api-abc123-ew.a.run.app' })
    const signed = '/api/tracks/0123456789ab/audio?u=uid42&exp=1790000000&sig=ab12cd'
    expect(resolveServerUrl(signed)).toBe(`https://chords-api-abc123-ew.a.run.app${signed}`)
    expect(resolveServerUrl('/api/tracks/0123456789ab/stems/vocals?u=uid42&exp=1&sig=x')).toBe(
      'https://chords-api-abc123-ew.a.run.app/api/tracks/0123456789ab/stems/vocals?u=uid42&exp=1&sig=x',
    )
  })
})


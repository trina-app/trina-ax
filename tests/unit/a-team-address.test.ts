// GET /api/me team.address: the team's address for its own members (Settings › 앱 "팀 주소", the install pictures).
// The relay address when the server is on a relay, else the public address it knows; a server not on a relay at all
// gives the address it is reached at, with its port (QA TC-089); a server on a relay never gives the address the
// request came in at (over the office network that is the office's own address).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { ConnectionStatus } from '@mycel/shared/api'
import { reachedAddress, teamAddressOf } from '../../server/src/system/connection'
import type { RelayStatusProvider } from '../../server/src/services'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(30_000)

const relayAt = (address: string | null): RelayStatusProvider => ({
  status: () => ({ mode: 'relay', address, state: 'connected', detail: null, connectedSince: null, direct: { enabled: false, port: 8443, fingerprintSha256: null } }) as ConnectionStatus,
  recover: async () => { throw new Error('not in tests') },
}) as unknown as RelayStatusProvider

describe('team address for members', () => {
  let h: Harness
  let owner: Client
  let member: Client
  beforeAll(async () => {
    h = await harness('team-address')
    owner = await withOwner(h)
    member = (await addMember(h, owner, { username: 'mina' })).client
  })
  afterAll(() => h.close())

  test('none known (the office network only): no address at all', async () => {
    const me = await member.call('GET', '/api/me')
    expect(me.team.address).toBeUndefined()
    expect('address' in me.team).toBe(false)
  })

  test('the public address the server knows, as https, for every signed-in person', async () => {
    h.ctx.config.publicOrigins = ['http://localhost:19110', 'https://192.168.0.10:8443', 'https://team.example.com']
    try {
      expect((await member.call('GET', '/api/me')).team.address).toBe('https://team.example.com')
      expect((await owner.call('GET', '/api/me')).team.address).toBe('https://team.example.com')
      h.ctx.config.tunnel = { host: 'ax.example.org', allowFrom: [], countries: [] }
      expect((await member.call('GET', '/api/me')).team.address).toBe('https://ax.example.org')
    } finally {
      h.ctx.config.publicOrigins = []
      h.ctx.config.tunnel = null
    }
  })

  test('the relay address wins, whatever host the request came in at', async () => {
    const before = h.ctx.services.relay
    h.ctx.services.relay = relayAt('https://acme.trina.app')
    h.ctx.config.publicOrigins = ['https://team.example.com']
    try {
      expect((await member.call('GET', '/api/me')).team.address).toBe('https://acme.trina.app')
      // a desk on the office network: the page is at the office's own address, the answer still names the team's
      const office = h.client({ base: 'https://192.168.0.10:8443' })
      await office.login('mina', 'river stone lamp 7')
      expect((await office.call('GET', '/api/me')).team.address).toBe('https://acme.trina.app')
    } finally {
      h.ctx.services.relay = before
      h.ctx.config.publicOrigins = []
    }
  })

  test('no relay: the office network address it is reached at, with its port (QA TC-089)', async () => {
    const lan = h.client({ base: 'https://192.168.1.2:19300', via: 'direct' })
    const signedIn = await lan.call('POST', '/api/auth/login', { username: 'mina', password: 'river stone lamp 7' })
    expect(signedIn.me.team.address).toBe('https://192.168.1.2:19300')
    expect((await lan.call('GET', '/api/me')).team.address).toBe('https://192.168.1.2:19300')
    // plain http (no certificate): given as it is, the web says the apps need https
    const plain = h.client({ base: 'http://192.168.1.2:19300', via: 'direct' })
    await plain.login('mina', 'river stone lamp 7')
    expect((await plain.call('GET', '/api/me')).team.address).toBe('http://192.168.1.2:19300')
    // a tailnet name with its port
    const tail = h.client({ base: 'https://acme-mac.tail1234.ts.net:8489', via: 'direct' })
    await tail.login('mina', 'river stone lamp 7')
    expect((await tail.call('GET', '/api/me')).team.address).toBe('https://acme-mac.tail1234.ts.net:8489')
  })

  test('behind a TLS proxy: the configured origin for the host it came in at; forwarded headers are never read', async () => {
    h.ctx.config.publicOrigins = ['http://localhost:19480', 'https://acme-mac.tail1234.ts.net:8489']
    try {
      // tailscale serve: https outside, plain http to the server with the browser's Host
      const proxied = h.client({ base: 'http://acme-mac.tail1234.ts.net:8489', via: 'direct' })
      await proxied.login('mina', 'river stone lamp 7')
      expect((await proxied.call('GET', '/api/me')).team.address).toBe('https://acme-mac.tail1234.ts.net:8489')
      // a proxy that rewrites Host to the server's own: X-Forwarded-* says nothing, the configured origin is given
      const local = h.client({ base: 'http://127.0.0.1:19480', via: 'direct' })
      await local.login('mina', 'river stone lamp 7')
      const fwd = { 'x-forwarded-host': 'evil.example:444', 'x-forwarded-proto': 'https', forwarded: 'host=evil.example;proto=https' }
      expect((await local.call('GET', '/api/me', undefined, fwd)).team.address).toBe('https://acme-mac.tail1234.ts.net:8489')
      h.ctx.config.publicOrigins = []
      expect((await local.call('GET', '/api/me', undefined, fwd)).team.address).toBeUndefined()
    } finally {
      h.ctx.config.publicOrigins = []
    }
  })

  test('on a relay whose address is not known yet: never the office network address', async () => {
    const before = h.ctx.services.relay
    const url = h.ctx.config.relay.url
    h.ctx.services.relay = relayAt(null)
    h.ctx.config.relay.url = 'wss://relay.example.com/connect'
    try {
      const lan = h.client({ base: 'https://192.168.1.2:19300', via: 'direct' })
      await lan.login('mina', 'river stone lamp 7')
      expect((await lan.call('GET', '/api/me')).team.address).toBeUndefined()
    } finally {
      h.ctx.services.relay = before
      h.ctx.config.relay.url = url
    }
  })

  test('signed out: no answer at all', async () => {
    expect((await h.client().try('GET', '/api/me')).status).toBe(401)
  })
})

describe('teamAddressOf', () => {
  const config = { tunnel: null, publicOrigins: [] as string[] }
  test('relay address as an origin; junk or credentials fall back to the public address', () => {
    expect(teamAddressOf({ config, services: { relay: relayAt('https://acme.trina.app/') } } as never)).toBe('https://acme.trina.app')
    expect(teamAddressOf({ config, services: { relay: relayAt('http://demo.localhost:19161') } } as never)).toBe('http://demo.localhost:19161')
    expect(teamAddressOf({ config, services: { relay: relayAt(null) } } as never)).toBeNull()
    expect(teamAddressOf({ config, services: { relay: null } } as never)).toBeNull()
    const pub = { tunnel: null, publicOrigins: ['https://team.example.com'] }
    expect(teamAddressOf({ config: pub, services: { relay: relayAt('not an address') } } as never)).toBe('https://team.example.com')
    expect(teamAddressOf({ config: pub, services: { relay: relayAt('https://u:p@acme.trina.app') } } as never)).toBe('https://team.example.com')
    expect(teamAddressOf({ config: pub, services: { relay: relayAt('ftp://acme.trina.app') } } as never)).toBe('https://team.example.com')
    const broken = { status: () => { throw new Error('down') } }
    expect(teamAddressOf({ config: pub, services: { relay: broken } } as never)).toBe('https://team.example.com')
  })
})

describe('reachedAddress', () => {
  const none = { publicOrigins: [] as string[] }
  test('the request origin with its port, http too; never loopback', () => {
    expect(reachedAddress(none, { url: 'https://192.168.1.2:19300/api/me', via: 'direct' })).toBe('https://192.168.1.2:19300')
    expect(reachedAddress(none, { url: 'http://192.168.1.2:19300/api/me', via: 'direct' })).toBe('http://192.168.1.2:19300')
    expect(reachedAddress(none, { url: 'https://acme-mac.tail1234.ts.net:8489/api/me', via: 'direct' })).toBe('https://acme-mac.tail1234.ts.net:8489')
    for (const u of ['http://localhost:19300/api/me', 'http://127.0.0.1:19300/', 'http://[::1]:19300/', 'http://team.localhost/'])
      expect(reachedAddress(none, { url: u, via: 'direct' })).toBeNull()
    expect(reachedAddress(none, null)).toBeNull()
    expect(reachedAddress(none, { url: 'not a url', via: 'direct' })).toBeNull()
  })
  test('only a request that came straight to a listener', () => {
    expect(reachedAddress(none, { url: 'https://192.168.1.2:19300/', via: 'relay' })).toBeNull()
    expect(reachedAddress(none, { url: 'https://192.168.1.2:19300/', via: 'test' })).toBeNull()
    expect(reachedAddress(none, { url: 'https://office.example.com/', via: 'direct', tunnel: true })).toBeNull()
  })
  test('a configured origin for the same host wins (TLS proxy in front); else the first that is not this machine', () => {
    const cfg = { publicOrigins: ['http://localhost:19300', 'https://u:p@192.168.1.9:8443', 'https://192.168.1.2:8443', 'https://acme-mac.tail1234.ts.net:8489'] }
    expect(reachedAddress(cfg, { url: 'http://acme-mac.tail1234.ts.net:8489/', via: 'direct' })).toBe('https://acme-mac.tail1234.ts.net:8489')
    expect(reachedAddress(cfg, { url: 'http://192.168.1.3:19300/', via: 'direct' })).toBe('http://192.168.1.3:19300')
    expect(reachedAddress(cfg, { url: 'http://localhost:19300/', via: 'direct' })).toBe('https://192.168.1.2:8443')
    expect(reachedAddress(cfg, undefined)).toBe('https://192.168.1.2:8443')
    expect(reachedAddress({ publicOrigins: ['http://localhost:1', 'ftp://x.example'] }, { url: 'http://localhost:1/', via: 'direct' })).toBeNull()
  })
  test('teamAddressOf: relay and public address first; a configured relay without an address gives none', () => {
    const at = { url: 'https://192.168.1.2:19300/api/me', via: 'direct' }
    const cfg = (relayUrl: string | null, publicOrigins: string[] = []) => ({ tunnel: null, publicOrigins, relay: { url: relayUrl, teamName: null } })
    expect(teamAddressOf({ config: cfg(null), services: { relay: null } } as never, at)).toBe('https://192.168.1.2:19300')
    expect(teamAddressOf({ config: cfg(null, ['https://team.example.com']), services: { relay: null } } as never, at)).toBe('https://team.example.com')
    expect(teamAddressOf({ config: cfg('wss://relay.example.com/connect'), services: { relay: relayAt('https://acme.trina.app') } } as never, at)).toBe('https://acme.trina.app')
    expect(teamAddressOf({ config: cfg('wss://relay.example.com/connect'), services: { relay: relayAt(null) } } as never, at)).toBeNull()
    expect(teamAddressOf({ config: cfg('wss://relay.example.com/connect'), services: { relay: null } } as never, at)).toBeNull()
  })
})

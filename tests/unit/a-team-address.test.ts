// GET /api/me team.address: the team's address for its own members (Settings › 앱 "팀 주소", the install pictures).
// The relay address when the server is on a relay, else the public address it knows, else none; never the address the
// request came in at (over the office network that is the office's own address).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { ConnectionStatus } from '@mycel/shared/api'
import { teamAddressOf } from '../../server/src/system/connection'
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

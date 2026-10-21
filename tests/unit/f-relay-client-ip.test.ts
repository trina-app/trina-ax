// Security review (multi-team-relay, round 1): the relay took the client IP from CF-Connecting-IP no matter who sent
// it. Anyone who reached the relay's origin directly (not through Cloudflare) could put any address there, and the
// team server used it as the real client IP: audit attribution, access logs and the per-IP sign-in / token limits
// (server/src/auth/rate-limit.ts), plus the relay's own per-IP registration limit. The header is now honoured only
// when the TCP peer is a trusted proxy (Cloudflare's published ranges by default, --trusted-proxies /
// RELAY_TRUSTED_PROXIES); any other peer gets its socket address.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type http from 'node:http'
import { CLOUDFLARE_RANGES, ipInRanges, parseTrustedProxies } from '../../relay/src/proxies.ts'
import { loadRelayConfig } from '../../relay/src/config.ts'
import type { RelayClient } from '../../server/src/relay-client/client.ts'
import { client, registerTeam, startRelay, teamUrl, until, type InProcessRelay } from '../lib/f-relay'

const fakeReq = (peer: string, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress: peer } }) as unknown as http.IncomingMessage
const clientIpOf = (R: InProcessRelay, req: http.IncomingMessage) => (R.relay as unknown as { clientIp(r: http.IncomingMessage): string | null }).clientIp(req)

describe('trusted proxy ranges', () => {
  test('CIDR matching for IPv4, IPv6 and IPv4-mapped IPv6', () => {
    const r = parseTrustedProxies('10.0.0.0/8, 2001:db8::/32, 192.0.2.7')
    expect(ipInRanges('10.1.2.3', r)).toBe(true)
    expect(ipInRanges('::ffff:10.1.2.3', r)).toBe(true)
    expect(ipInRanges('11.0.0.1', r)).toBe(false)
    expect(ipInRanges('2001:db8:1::5', r)).toBe(true)
    expect(ipInRanges('2001:db9::5', r)).toBe(false)
    expect(ipInRanges('192.0.2.7', r)).toBe(true)
    expect(ipInRanges('192.0.2.8', r)).toBe(false)
    expect(ipInRanges(undefined, r)).toBe(false)
    expect(ipInRanges('not an ip', r)).toBe(false)
    const cf = parseTrustedProxies('cloudflare')
    expect(cf).toEqual(parseTrustedProxies(CLOUDFLARE_RANGES.join(',')))
    expect(ipInRanges('104.16.1.1', cf)).toBe(true)
    expect(ipInRanges('2606:4700::1', cf)).toBe(true)
    expect(ipInRanges('127.0.0.1', cf)).toBe(false)
    expect(parseTrustedProxies('none')).toEqual([])
    expect(() => parseTrustedProxies('10.0.0.0/33')).toThrow()
    expect(() => parseTrustedProxies('example.com')).toThrow()
  })

  test('production trusts only Cloudflare for the client IP header; flags and env override', () => {
    const prod = loadRelayConfig(['--domain', 'example.test'], {})
    expect(prod.clientIpHeader).toBe('cf-connecting-ip')
    expect(prod.trustedProxies).toEqual(parseTrustedProxies('cloudflare'))
    expect(ipInRanges('127.0.0.1', prod.trustedProxies)).toBe(false)
    expect(loadRelayConfig(['--domain', 'example.test', '--trusted-proxies', '127.0.0.1,cloudflare'], {}).trustedProxies.length).toBe(CLOUDFLARE_RANGES.length + 1)
    expect(loadRelayConfig(['--domain', 'example.test'], { RELAY_TRUSTED_PROXIES: 'none' }).trustedProxies).toEqual([])
    expect(() => loadRelayConfig(['--domain', 'example.test', '--trusted-proxies', 'garbage'], {})).toThrow()
  })
})

describe('client IP from a header only through a trusted proxy', () => {
  const PORT = 19181
  let R: InProcessRelay
  let c: RelayClient
  const seen: (string | null)[] = []

  beforeAll(async () => {
    // production header, default trust (Cloudflare only): the test's own loopback connections are not Cloudflare
    R = await startRelay(PORT, { RELAY_CLIENT_IP_HEADER: 'cf-connecting-ip', RELAY_REGISTER_PER_IP: '2' })
    const team = await registerTeam(R.base, 'ipteam')
    c = client({ url: R.ws, teamId: team.teamId, kp: team.kp, fetch: async (_req, info) => { seen.push(info.ip); return Response.json({ ip: info.ip }) } })
    await until(() => c.state.state === 'connected', 5000, 'ipteam connected')
  })
  afterAll(async () => {
    c?.stop()
    await R?.stop()
  })

  test('a direct (non-Cloudflare) peer that sends CF-Connecting-IP gets its socket IP in the OPEN metadata', async () => {
    const res = await fetch(teamUrl(PORT, 'ipteam', '/x'), { headers: { 'cf-connecting-ip': '10.0.0.5', 'x-forwarded-for': '203.0.113.9' } })
    expect(((await res.json()) as { ip: string }).ip).toBe('127.0.0.1')
    expect(seen.at(-1)).toBe('127.0.0.1')
  })

  test('a Cloudflare peer still passes the visitor address on (IPv4 and IPv6 edges)', () => {
    expect(clientIpOf(R, fakeReq('172.70.1.2', { 'cf-connecting-ip': '198.51.100.23' }))).toBe('198.51.100.23')
    expect(clientIpOf(R, fakeReq('::ffff:162.158.3.4', { 'cf-connecting-ip': '2001:db8::9' }))).toBe('2001:db8::9')
    expect(clientIpOf(R, fakeReq('2a06:98c1::1', { 'cf-connecting-ip': '198.51.100.24' }))).toBe('198.51.100.24')
    // a trusted proxy that sends no header or a malformed one: the socket peer / unknown, never the junk
    expect(clientIpOf(R, fakeReq('172.70.1.2'))).toBe('172.70.1.2')
    expect(clientIpOf(R, fakeReq('172.70.1.2', { 'cf-connecting-ip': '1.2.3.4; evil' }))).toBeNull()
    // not Cloudflare: the header is ignored
    expect(clientIpOf(R, fakeReq('198.51.100.50', { 'cf-connecting-ip': '10.0.0.5' }))).toBe('198.51.100.50')
    expect(clientIpOf(R, fakeReq('::ffff:198.51.100.51', { 'cf-connecting-ip': '10.0.0.5' }))).toBe('198.51.100.51')
  })

  test('the per-IP registration limit can not be dodged by rotating CF-Connecting-IP from a direct peer', () => {
    const peer = '198.51.100.77'
    let allowed = 0
    for (let i = 0; i < 10; i++) if (R.relay.allowRegistration(fakeReq(peer, { 'cf-connecting-ip': `192.0.2.${i}` }))) allowed++
    expect(allowed).toBe(2)
    // through Cloudflare the limit is per visitor, as before
    expect(R.relay.allowRegistration(fakeReq('104.16.0.9', { 'cf-connecting-ip': '192.0.2.200' }))).toBe(true)
    expect(R.relay.allowRegistration(fakeReq('104.16.0.9', { 'cf-connecting-ip': '192.0.2.201' }))).toBe(true)
  })
})

describe('an operator-trusted local proxy (cloudflared on the same host)', () => {
  test('--trusted-proxies 127.0.0.1 makes the header count again for loopback peers', async () => {
    const PORT = 19182
    const R = await startRelay(PORT, { RELAY_CLIENT_IP_HEADER: 'cf-connecting-ip', RELAY_TRUSTED_PROXIES: '127.0.0.1/32,::1' })
    const team = await registerTeam(R.base, 'tunnelteam')
    const c = client({ url: R.ws, teamId: team.teamId, kp: team.kp, fetch: async (_req, info) => Response.json({ ip: info.ip }) })
    try {
      await until(() => c.state.state === 'connected', 5000, 'tunnelteam connected')
      const res = await fetch(teamUrl(PORT, 'tunnelteam', '/x'), { headers: { 'cf-connecting-ip': '198.51.100.23' } })
      expect(((await res.json()) as { ip: string }).ip).toBe('198.51.100.23')
    } finally {
      c.stop()
      await R.stop()
    }
  })
})
